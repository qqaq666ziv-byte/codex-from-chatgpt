import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadLocalConfig, readLocalToken } from '../src/local-config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const config=loadLocalConfig();
const client=new Client({name:'AutoDev local acceptance (not ChatGPT reviewer)',version:'0.4.0'});
await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${readLocalToken(config.runtimeDir,'client')}`}}}));
async function call(name:string,args:Record<string,unknown>={}) {
  const response=await client.callTool({name,arguments:args});
  if(response.isError)throw new Error(JSON.stringify(response.content));
  return response.structuredContent as Record<string,any>;
}
try {
  console.log(JSON.stringify(await call('autodev_projects')));
  if(process.argv.includes('--probe'))process.exitCode=0;
  else {
    const followup=process.argv.includes('--continue');
    const prior=followup?JSON.parse(readFileSync('.local-tests/live-mcp-result.json','utf8')):null;
    const input=followup?{request_key:'acceptance-mean-v1',job_id:prior.jobId,requirements:'Add mean(values) exported from mean.js that reuses sum(values) in sum.js and returns the arithmetic mean; empty input must throw RangeError. Add meaningful node:test cases including rejected invalid input, and run node --test. Work only in this isolated repository.',acceptance:['mean([2,4,6]) returns 4.','mean([]) throws RangeError.','Non-finite or non-number input is rejected.','All tests including original sum tests pass.']}:{request_key:'acceptance-sum-v1',project_id:'acceptance',requirements:'Implement sum(values) in sum.js for an array of finite numbers; empty array returns 0. Reject non-array, NaN, infinity and non-number entries with TypeError. Add meaningful node:test tests and run node --test. Only this isolated repository; no installation, network or commits.',acceptance:['sum([1,2,3]) returns 6 and sum([]) returns 0.','Invalid arrays and elements throw TypeError.','Real node --test exits 0.']};
    const tool=followup?'autodev_continue':'autodev_submit';
    const started=await call(tool,input);const duplicate=await call(tool,input);assert.equal(duplicate.job_id,started.job_id);assert.equal(duplicate.turn_id,started.turn_id);
    console.log(JSON.stringify({started,duplicate_replayed:true}));
    let status;const deadline=Date.now()+15*60_000;let last='';
    do {status=await call('autodev_status',{job_id:started.job_id});if(status.status!==last){console.log(JSON.stringify({execution:status.status,review:status.review_status,pending:status.pending_approvals}));last=status.status;}if(!['starting','running','awaiting_approval','interrupting'].includes(status.status))break;await new Promise(resolve=>setTimeout(resolve,1500));}while(Date.now()<deadline);
    assert.equal(status.status,'completed',JSON.stringify(status));assert.equal(status.review_status,'pending_chatgpt_review');
    const manifest=await call('autodev_evidence',{job_id:started.job_id});const artifacts:Record<string,string>={};
    for(const artifact of manifest.artifacts){let cursor:string|undefined;let content='';do{const page=await call('autodev_artifact',{manifest_id:manifest.id,artifact:artifact.name,...(cursor?{cursor}:{}),limit:4096});content+=page.content;cursor=page.nextCursor??undefined;}while(cursor);artifacts[artifact.name]=content;}
    const execution=JSON.parse(artifacts['execution.json']!);
    const project=config.projects.find(p=>p.id==='acceptance')!;
    const tests=execFileSync(process.execPath,['--test'],{cwd:project.path,encoding:'utf8',windowsHide:true});
    const result={jobId:started.job_id,threadId:started.thread_id,turnId:started.turn_id,manifestId:manifest.id,duplicate_replayed:true,effective:execution.effective_config,execution_status:status.status,review_status:status.review_status,independent_tests:tests,followup,source_files:Object.keys(JSON.parse(artifacts['source-identity.json']!).after.files)};
    writeFileSync(path.resolve(`.local-tests/live-mcp-${followup?'continue-':''}result.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}finally{await client.close();}
