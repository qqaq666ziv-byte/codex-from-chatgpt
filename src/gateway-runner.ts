import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.js';
import { loadLocalConfig, readLocalToken } from './local-config.js';
import { acquireRuntimeLock } from './runtime-lock.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const binary=path.join(root,'.tools','cloudflared-2026.8.2.exe');
const digest='c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5';
const download='https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-windows-amd64.exe';
type RecordFile={pid:number;instance:string;created:string;controlPort:number;publicPort:number;issuer:string;entry:string};
function identity(pid:number):{created:string;command:string;executable:string}|null {
  try {
    const script="$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:AUTODEV_INSPECT_PID); if($null -ne $p){ $json=@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine;executable=$p.ExecutablePath}|ConvertTo-Json -Compress; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))) }";
    const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,AUTODEV_INSPECT_PID:String(pid)}}).trim();
    return result?JSON.parse(Buffer.from(result,'base64').toString('utf8')):null;
  }catch{return null;}
}
function requireOwned(record:RecordFile) {
  if(!Number.isSafeInteger(record.pid)||!/^[a-f0-9-]{36}$/.test(record.instance)||record.entry!==fileURLToPath(import.meta.url))throw new Error('Invalid gateway process record.');
  const p=identity(record.pid);
  if(!p||p.created!==record.created||p.executable.toLowerCase()!==process.execPath.toLowerCase()||!p.command.includes(record.entry)||!p.command.includes(record.instance))throw new Error('Gateway owner no longer matches; no process was stopped.');
}
async function installBinary() {
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This pinned installer supports Windows x64.');
  if(existsSync(binary)){if(createHash('sha256').update(readFileSync(binary)).digest('hex')!==digest)throw new Error('Existing cloudflared hash mismatch; file preserved.');return;}
  const response=await fetch(download,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Official dependency download failed.');
  const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('Official dependency checksum mismatch; binary not installed.');
  mkdirSync(path.dirname(binary),{recursive:true});const temporary=`${binary}.${randomUUID()}.tmp`;writeFileSync(temporary,bytes,{flag:'wx'});renameSync(temporary,binary);
}
async function main() {
  const action=process.argv[2]??'help';
  if(action==='help'){console.log('AutoDev no-API-Key development connection: setup | run | status | approve <request_id> <verification_code> | deny <request_id> <verification_code> | stop. Run starts a public HTTPS development ingress protected by local OAuth approval. Restart changes URL and revokes its grants.');return;}
  if(action==='setup'){await installBinary();console.log('Verified cloudflared 2026.8.2 installed inside this checkout. No tunnel was started.');return;}
  const config=loadLocalConfig(path.join(root,'.runtime/config.json'));
  const recordPath=path.join(config.runtimeDir,'gateway.json');
  const adminToken=readLocalToken(config.runtimeDir,'admin');
  if(action!=='run') {
    if(!['status','stop','approve','deny'].includes(action))throw new Error('Unknown connection action.');
    const record=JSON.parse(readFileSync(recordPath,'utf8')) as RecordFile;requireOwned(record);
    const origin=`http://127.0.0.1:${record.controlPort}`;const headers={Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'};
    const response=await fetch(`${origin}/status`,{headers,signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Gateway did not authenticate the local administration request.');
    const status=await response.json() as {process_id:number;instance_id:string};
    if(status.process_id!==record.pid||status.instance_id!==record.instance)throw new Error('Gateway HTTP identity mismatch; no action sent.');
    if(action==='status'){console.log(JSON.stringify(status,null,2));return;}
    const result=await fetch(`${origin}/${action==='stop'?'shutdown':'approve'}`,{method:'POST',headers,body:action==='stop'?'{}':JSON.stringify({request_id:process.argv[3],verification_code:process.argv[4],approve:action==='approve'}),signal:AbortSignal.timeout(5000)});
    if(!result.ok)throw new Error('Gateway rejected the local action.');
    if(action==='stop'){
      const deadline=Date.now()+15000;while(Date.now()<deadline){const p=identity(record.pid);if(!p||p.created!==record.created){console.log('Owned gateway stopped. Codex tasks remain in the core service.');return;}await new Promise(r=>setTimeout(r,200));}
      throw new Error('Gateway shutdown requested but process exit not confirmed.');
    }
    console.log(await result.text());return;
  }
  await installBinary();
  const health=await fetch(`http://${config.host}:${config.port}/readyz`,{signal:AbortSignal.timeout(5000)});if(!health.ok)throw new Error('Start and diagnose the AutoDev core before connecting.');
  const leaseDir=path.join(config.runtimeDir,'gateway-lease');mkdirSync(leaseDir,{recursive:true});const release=await acquireRuntimeLock(leaseDir);
  let tunnel:ChildProcess|undefined;let gateway:Awaited<ReturnType<typeof createGateway>>|undefined;let closing=false;
  const close=async()=>{
    if(closing)return;closing=true;
    try {
      // Stop the exact child started by this runner, never a listener discovered by port.
      if(tunnel&&tunnel.exitCode===null&&tunnel.signalCode===null){const ended=new Promise<void>(r=>tunnel!.once('exit',()=>r()));tunnel.kill();await ended;}
      await gateway?.close();
    }finally{release();}
  };
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());process.once('exit',()=>release());
  try {
    const instance=process.argv.find(a=>a.startsWith('--autodev-gateway-instance='))?.split('=')[1];
    if(!instance||!/^[a-f0-9-]{36}$/.test(instance))throw new Error('Use the connection PowerShell launcher for an owned instance.');
    const publicPort=8792;const controlPort=8793;
    // Reserve both ports before launching the public forwarder. No existing listener is reused.
    const {createServer}=await import('node:net');const reservations=[];
    try{for(const port of[publicPort,controlPort]){const server=createServer();await new Promise<void>((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});reservations.push(server);}}
    finally{for(const server of reservations)await new Promise<void>(r=>server.close(()=>r()));}
    const tunnelConfig=path.join(config.runtimeDir,`quick-tunnel-${instance}.yml`);
    writeFileSync(tunnelConfig,'no-autoupdate: true\n',{flag:'wx',mode:0o600});
    const tunnelEnv:NodeJS.ProcessEnv={};
    for(const name of['SystemRoot','WINDIR','PATH','TEMP','TMP','COMSPEC'])if(process.env[name])tunnelEnv[name]=process.env[name];
    // Explicit empty local config and a small environment prevent accidental use
    // of a user's saved Cloudflare profile, access token or debug-log settings.
    tunnel=spawn(binary,['tunnel','--config',tunnelConfig,'--url',`http://127.0.0.1:${publicPort}`,'--no-autoupdate','--protocol','http2','--http-host-header',`127.0.0.1:${publicPort}`],{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:root,env:tunnelEnv});
    const issuer=await new Promise<string>((resolve,reject)=>{
      let text='';const timer=setTimeout(()=>reject(new Error('No HTTPS development URL was established.')),45000);
      const consume=(b:Buffer)=>{text=(text+b.toString('utf8')).slice(-16384);const match=text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);if(match){clearTimeout(timer);resolve(match[0]);}};
      tunnel!.stdout!.on('data',consume);tunnel!.stderr!.on('data',consume);
      tunnel!.once('error',()=>{clearTimeout(timer);reject(new Error('Unable to launch the owned tunnel child.'));});
      tunnel!.once('exit',()=>{clearTimeout(timer);reject(new Error('Tunnel child exited before connection.'));});
    });
    tunnel.once('exit',()=>{if(!closing){console.error('Development tunnel ended; closing its OAuth gateway.');void close();}});
    gateway=await createGateway({issuer,publicPort,controlPort,upstream:`http://${config.host}:${config.port}/mcp`,clientToken:readLocalToken(config.runtimeDir,'client'),adminToken,instance,onShutdown:()=>void close()});
    if(closing||tunnel.exitCode!==null||tunnel.signalCode!==null)throw new Error('Tunnel ended during gateway startup.');
    const current=identity(process.pid);if(!current)throw new Error('Cannot record owned gateway process identity.');
    const record:RecordFile={pid:process.pid,instance,created:current.created,controlPort,publicPort,issuer,entry:fileURLToPath(import.meta.url)};
    const temporary=`${recordPath}.${randomUUID()}.tmp`;writeFileSync(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});renameSync(temporary,recordPath);
    console.log(`AutoDev development MCP: ${issuer}/mcp\nAuthentication: OAuth; dynamic client registration. No OpenAI API Key.\nUse connect-chatgpt.ps1 status to review and approve the one-time local OAuth link. Keep this process running; restart changes the URL.`);
  }catch(error){await close();throw error;}
}
void main().catch(()=>{console.error('AutoDev connection failed. Check the action, core readiness, free ports, owned process and dependency hash. No credentials were printed.');process.exitCode=1;});
