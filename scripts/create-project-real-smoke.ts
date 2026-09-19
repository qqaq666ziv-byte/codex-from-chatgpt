/** Explicit opt-in: one tiny subscription turn, isolated registry/jobs, no Git/scaffold/review. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodexAppServer } from '../src/codex-app-server.js';
import { JobManager } from '../src/jobs.js';
import { StateStore } from '../src/store.js';
import { AutoDev } from '../src/product.js';
import { loadLocalConfig } from '../src/local-config.js';
import { ModelCatalog, ModelRouter } from '../src/model-routing.js';
import { createMcpServer } from '../src/mcp.js';

if(process.env.AUTODEV_RUN_CREATE_PROJECT_SMOKE!=='one-subscription-turn')throw new Error('Explicit one-turn opt-in required.');
const base=path.resolve('.local-tests');mkdirSync(base,{recursive:true});const runtimeDir=mkdtempSync(path.join(base,'create-project-live-'));
const configured=loadLocalConfig();
const config={...configured,projects:[],runtimeDir,configPath:path.join(runtimeDir,'config.json'),projectCreationRoot:'D:\\QQ\\02_網頁與程式開發'};
writeFileSync(config.configPath,JSON.stringify(config));
const executor=new CodexAppServer({spawnOptions:{windowsHide:true},rpcTimeoutMs:60000});
const jobs=new JobManager(executor,{store:new StateStore(path.join(runtimeDir,'jobs.json')),model:config.model,reasoningEffort:config.reasoningEffort,workspaceValidator:async workspace=>product.validateWorkspace(workspace)});
const router=new ModelRouter(new ModelCatalog(executor),config.routingPolicy,{model:config.model,effort:config.reasoningEffort});
const product=new AutoDev(config,jobs,router);const server=createMcpServer(product,'create-project-live');
const client=new Client({name:'AutoDev-create-project-local-verification',version:'1'});
const report:Record<string,unknown>={verification:'real local Codex via MCP; not ChatGPT OAuth/E2E',inferenceTurnsAllowed:1,runtimeDir};
let current:{job_id:string;turn_id:string}|undefined;
const tool=async(name:string,args:Record<string,unknown>={})=>{
  const result=await client.callTool({name,arguments:args});
  if(result.isError)throw new Error(`${name} failed; inspect isolated state without replay.`);
  return result.structuredContent as any;
};
try{
  await executor.start();
  const account=await executor.request<{account:{type:string}|null}>('account/read',{refreshToken:false});assert.equal(account.account?.type,'chatgpt');
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(b),client.connect(a)]);
  const input={request_key:'create-live-v1',name:`AutoDev-create-project-check-${randomUUID().slice(0,8)}`};
  const created=await tool('autodev_create_project',input);report.project=created;
  assert.equal(path.dirname(created.workspace),config.projectCreationRoot);assert.deepEqual(readdirSync(created.workspace),[]);
  assert.deepEqual(await tool('autodev_create_project',input),created);
  assert.ok((await tool('autodev_projects')).projects.some((p:any)=>p.id===created.project_id));
  const submitted=await tool('autodev_submit',{request_key:'submit-live-v1',project_id:created.project_id,requirements:'This is a minimal workspace dispatch check. Create only proof.txt containing exactly AUTODEV_CREATE_PROJECT_OK followed by a newline. Do not create anything else, initialize Git, install, use network, read other folders or ask for additional work. Report completion.',acceptance:['proof.txt contains AUTODEV_CREATE_PROJECT_OK and no framework or Git was initialized.'],routing:{complexity:'simple',risk:'low',preference:'speed'}});
  assert.ok(submitted.job_id&&submitted.turn_id);current=submitted;
  const deadline=Date.now()+180000;let status:any;
  while(Date.now()<deadline){
    status=await tool('autodev_status',{job_id:submitted.job_id});
    if(['completed','failed','interrupted'].includes(status.execution_status))break;
    if(!['starting','running'].includes(status.execution_status))throw new Error(`Local turn needs attention: ${status.execution_status}`);
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  assert.equal(status.execution_status,'completed');current=undefined;
  assert.equal(readFileSync(path.join(created.workspace,'proof.txt'),'utf8').trim(),'AUTODEV_CREATE_PROJECT_OK');
  assert.deepEqual(readdirSync(created.workspace),['proof.txt']);assert.equal(existsSync(path.join(created.workspace,'.git')),false);
  const manifest=await tool('autodev_evidence',{job_id:submitted.job_id});
  const restarted=new AutoDev(loadLocalConfig(config.configPath),new JobManager(executor,{store:new StateStore(path.join(runtimeDir,'jobs.json'))}));
  assert.deepEqual(restarted.createProject(input),created);assert.ok(restarted.projects().projects.some(p=>p.id===created.project_id));
  report.result='passed';report.job_id=submitted.job_id;report.execution=status.execution_status;report.review=status.review_status;report.manifest_id=manifest.id;report.registryReloaded=true;
}catch(error){report.result='failed';report.error=error instanceof Error?error.message:'Verification failed';process.exitCode=1;}
finally{
  if(current)try{await tool('autodev_cancel',{request_key:'cancel-live-v1',job_id:current.job_id,turn_id:current.turn_id});}catch{/* preserve isolated job identity; no replay */}
  await client.close();await server.close();await executor.stop();
  writeFileSync(path.join(runtimeDir,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
