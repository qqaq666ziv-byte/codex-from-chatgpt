import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { acquireRuntimeLock } from '../src/runtime-lock.js';

function fixture(port:number) {
  mkdirSync('.local-tests',{recursive:true});
  const dir=mkdtempSync(path.resolve('.local-tests/startup-failure-'));
  writeFileSync(path.join(dir,'config.json'),JSON.stringify({schemaVersion:1,host:'127.0.0.1',port,model:'gpt-6-astra',reasoningEffort:'xhigh',projects:[]}));
  writeFileSync(path.join(dir,'client-token'),'a'.repeat(64));
  writeFileSync(path.join(dir,'admin-token'),'b'.repeat(64));
  return dir;
}
async function rejectedLaunch(dir:string) {
  const child=spawn(process.execPath,['--import','tsx','src/index.ts'],{windowsHide:true,env:{...process.env,AUTODEV_CONFIG:path.join(dir,'config.json')},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise<number|null>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Failed launch retained a live helper.'));},15000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.equal(code,1);assert.match(output,/startup failed/);
  assert.ok(!output.includes('a'.repeat(64))&&!output.includes('b'.repeat(64)));
  const release=await acquireRuntimeLock(dir);release();
}
test('corrupt product state exits without retaining runtime writer ownership',async()=>{
  const dir=fixture(39876);writeFileSync(path.join(dir,'product-state.json'),'{invalid');
  await rejectedLaunch(dir);
});
test('occupied port exits without terminating its listener or retaining writer ownership',async()=>{
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const address=server.address();assert.ok(address&&typeof address==='object');
    await rejectedLaunch(fixture(address.port));assert.ok(server.listening);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
