import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexAppServer } from './codex-app-server.js';
import { JobManager } from './jobs.js';
import { StateStore } from './store.js';
import { approvalSchema, answerSchema } from './mcp.js';
import { createMcpHttpHandler } from './mcp-http.js';
import { AutoDev } from './product.js';
import { loadLocalConfig, readLocalToken, authorized } from './local-config.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { ModelCatalog, ModelRouter, DEFAULT_ROUTING_POLICY } from './model-routing.js';

function json(response:ServerResponse,status:number,value:unknown) {if(response.headersSent)return;response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));}
async function body(request:IncomingMessage):Promise<unknown> {const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>2*1024*1024)throw new Error('Request too large.');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export async function shutdownResources(actions:{closeMcp:()=>Promise<void>;stopExecutor:()=>Promise<void>;closeHttp:()=>Promise<void>;release:()=>void;report:()=>void}):Promise<boolean>{
  try {await actions.closeMcp();await actions.stopExecutor();await actions.closeHttp();actions.release();return true;}
  catch {actions.report();return false;}
}
async function main() {
  const config=loadLocalConfig();const clientToken=readLocalToken(config.runtimeDir,'client');const adminToken=readLocalToken(config.runtimeDir,'admin');
  if(clientToken===adminToken)throw new Error('Client and admin credentials must be distinct.');
  const release=await acquireRuntimeLock(config.runtimeDir);
  try {
  const instance=process.argv.find(a=>a.startsWith('--autodev-instance='))?.split('=')[1]??'manual';
  const appServer=new CodexAppServer({spawnOptions:{windowsHide:true}});
  const catalog=new ModelCatalog(appServer,config.routingPolicy?.cacheTtlMs??DEFAULT_ROUTING_POLICY.cacheTtlMs,Date.now,true);
  const router=new ModelRouter(catalog,config.routingPolicy,{model:config.model,effort:config.reasoningEffort});
  const jobs=new JobManager(appServer,{store:new StateStore(path.join(config.runtimeDir,'jobs.json')),model:config.model,reasoningEffort:config.reasoningEffort,workspaceValidator:async workspace=>{
    return product.validateWorkspace(workspace);
  }});
  const product=new AutoDev(config,jobs,router);
  let ready=false;let bootFailure=false;let closing=false;let shutdownStarted=false;
  const hosts=[`127.0.0.1:${config.port}`,`localhost:${config.port}`];
  const mcpHttp=createMcpHttpHandler({product,hosts,adminToken});
  const server=createServer(async(req,res)=>{
    try {
      if(!hosts.includes(req.headers.host??'')||req.headers.origin){json(res,403,{error:'Host or Origin rejected.'});return;}
      const url=new URL(req.url??'/','http://127.0.0.1');
      if(url.pathname==='/healthz'){json(res,200,{ok:true,service:'AutoDev'});return;}
      if(url.pathname==='/readyz'){json(res,ready&&appServer.isReady()?200:503,{ready:ready&&appServer.isReady(),service:'AutoDev',boot_failed:bootFailure});return;}
      const admin=url.pathname.startsWith('/admin/');
      if(!authorized(typeof req.headers.authorization==='string'?req.headers.authorization:undefined,admin?adminToken:clientToken)){json(res,401,{error:'Authentication required.'});return;}
      if(admin){
        if(url.pathname==='/admin/status'&&req.method==='GET'){json(res,200,{process_id:process.pid,instance_id:instance,ready:ready&&appServer.isReady(),...product.adminStatus()});return;}
        if(url.pathname==='/admin/shutdown'&&req.method==='POST'){
          if(!product.beginShutdown()){json(res,409,{error:'Active execution, recovery or mutation in progress; shutdown rejected.',...product.shutdownState()});return;}
          closing=true;ready=false;json(res,200,{stopping:true,process_id:process.pid,instance_id:instance});setImmediate(()=>void shutdown());return;
        }
        if(url.pathname==='/admin/approval'&&req.method==='POST'){json(res,200,await product.approval(approvalSchema.parse(await body(req))));return;}
        if(url.pathname==='/admin/answer'&&req.method==='POST'){json(res,200,await product.answer(answerSchema.parse(await body(req))));return;}
        json(res,404,{error:'Unknown administration operation.'});return;
      }
      if(url.pathname!=='/mcp'){json(res,404,{error:'Not found.'});return;}
      if(closing||!ready||!appServer.isReady()){json(res,503,{error:'Executor unavailable; inspect local status and restart to reconcile.'});return;}
      await mcpHttp.handle(req,res);
    }catch{json(res,400,{error:'Operation rejected. Inspect the exact request and local admin status.'});}
  });
  server.requestTimeout=30_000;server.headersTimeout=10_000;
  async function shutdown(){
    if(shutdownStarted)return;shutdownStarted=true;closing=true;ready=false;
    const stopped=await shutdownResources({closeMcp:()=>mcpHttp.close(),stopExecutor:()=>appServer.stop(),closeHttp:async()=>{
      server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    },release,report:()=>console.error('[AutoDev] shutdown incomplete; executor or resource ownership was not released. Core remains unavailable; retry administration shutdown.')});
    if(!stopped)shutdownStarted=false;
  }
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  process.once('exit',()=>{try{release();}catch{/* ownership changed or already released */}});
  appServer.addMessageListener(message=>{if(message.method==='turn/completed')setImmediate(()=>{for(const job of jobs.list())if(job.job_id&&!['starting','running','awaiting_approval','interrupting','recovery_required'].includes(job.status))try{product.seal(job.job_id);}catch{/* status exposes incomplete evidence; never mark review passed */}});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  try {
    await appServer.start();
    const account=await appServer.request<{account:{type:string}|null}>('account/read',{refreshToken:false});
    if(account.account?.type!=='chatgpt')throw new Error('Official ChatGPT login required; no API billing fallback.');
    await catalog.get();
    await jobs.initialize();ready=true;console.error('[AutoDev] ready; ChatGPT authentication and live model catalog validated. Each task requires a planner selection.');
  }catch{bootFailure=true;console.error('[AutoDev] startup validation failed. Use doctor/login status and inspect non-secret configuration.');}
  } catch(error) {
    // Constructors or listen() can fail before normal shutdown is installed.
    // Release the owned helper so a failed launch exits and a later retry works.
    release();
    throw error;
  }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  void main().catch(()=>{console.error('[AutoDev] startup failed; runtime lock, configuration or state requires inspection.');process.exitCode=1;});
}
