import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadLocalConfig, readLocalToken } from '../src/local-config.js';
import path from 'node:path';
import { request } from 'node:http';

const config=loadLocalConfig();
const origin=`http://${config.host}:${config.port}`;
const clientToken=readLocalToken(config.runtimeDir,'client');
assert.equal((await fetch(`${origin}/mcp`,{method:'POST'})).status,401);
assert.equal((await fetch(`${origin}/admin/status`,{headers:{Authorization:`Bearer ${clientToken}`}})).status,401);
assert.equal((await fetch(`${origin}/healthz`,{headers:{Origin:'https://untrusted.example'}})).status,403);
const hostStatus=await new Promise<number|undefined>((resolve,reject)=>{
  const req=request(`${origin}/healthz`,{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
});
assert.equal(hostStatus,403);
const client=new Client({name:'AutoDev readonly stdio verification',version:'0.4.0'});
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/src/stdio-proxy.js')],cwd:process.cwd(),stderr:'pipe'}));
  const listed=await client.listTools();
  assert.equal(listed.tools.length,9);assert.ok(!listed.tools.some(t=>t.name.includes('approval')));
  for(const name of['autodev_projects','autodev_status']){
    const result=await client.callTool({name,arguments:{}});assert.ok(!result.isError);assert.ok(result.structuredContent);
  }
  console.log('PASS: HTTP authentication, host/origin rejection, separate admin, nine stdio tools and real read-only calls. No mutation or ChatGPT review performed.');
}finally{await client.close();}
