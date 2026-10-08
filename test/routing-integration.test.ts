import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppServerError,type AppServerClient,type AppServerMessage,type JsonRpcId } from '../src/codex-app-server.js';
import { JobManager } from '../src/jobs.js';
import { StateStore } from '../src/store.js';
import { AutoDev, RoutingSelectionRequiredError } from '../src/product.js';
import { JournalError } from '../src/journal.js';
import { ModelCatalog,ModelRouter,type RoutingDecision } from '../src/model-routing.js';
import type { LocalConfig } from '../src/local-config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { shutdownResources } from '../src/index.js';

const makeModel=(name:string)=>({id:name,model:name,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort})),inputModalities:['text']});
class Executor implements AppServerClient {
  requests:Array<{method:string;params:any}>=[];listeners:Array<(m:AppServerMessage)=>void>=[];
  models=['gpt-5.4-mini','gpt-5.6-terra','gpt-6-astra'].map(makeModel);turns=0;threads=0;
  turnError:unknown=null;threadError:unknown=null;catalogGate:Promise<void>|null=null;readThread:any=null;resumeOverride:Record<string,unknown>|null=null;
  ignoreResumeOverrides=false;settingsError:unknown=null;confirmSettings=true;activeSettings:any=null;readbackDrift=false;notificationThread:string|null=null;
  addMessageListener(fn:(m:AppServerMessage)=>void){this.listeners.push(fn);return()=>{};}addExitListener(_fn:(e:Error)=>void){return()=>{};}
  async start(){} respond(_id:JsonRpcId,_r:unknown){}respondError(_id:JsonRpcId,_c:number,_m:string){}
  async request<T>(method:string,params?:any):Promise<T>{
    this.requests.push({method,params});
    if(method==='thread/start'&&this.threadError)throw this.threadError;
    if(method==='model/list'){if(this.catalogGate)await this.catalogGate;return {data:this.models,nextCursor:null} as T;}
    if(method==='thread/read')return {thread:this.readThread} as T;
    if(method==='thread/settings/update'){
      if(this.settingsError)throw this.settingsError;this.activeSettings={model:params.model,reasoningEffort:params.effort};
      if(this.confirmSettings)this.emit({method:'thread/settings/updated',params:{threadId:this.notificationThread??params.threadId,threadSettings:{model:params.model,effort:params.effort}}});
      return {} as T;
    }
    if(method==='thread/start')this.activeSettings={model:params.model,reasoningEffort:params.config?.model_reasoning_effort};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:method==='thread/start'?`thread-${++this.threads}`:params.threadId,turns:method==='thread/resume'?this.readThread?.turns??[]:[]},...(this.ignoreResumeOverrides&&method==='thread/resume'?this.activeSettings:{model:params.model,reasoningEffort:params.config?.model_reasoning_effort}),...(method==='thread/resume'&&this.readbackDrift&&this.count('thread/settings/update')?{model:'unexpected-model'}:{}),approvalPolicy:'on-request',sandbox:'workspace-write',...this.resumeOverride} as T;
    if(method==='turn/start'){if(this.turnError)throw this.turnError;return {turn:{id:`turn-${++this.turns}`,status:'inProgress',items:[]}} as T;}
    return {} as T;
  }
  emit(message:AppServerMessage){this.listeners.forEach(fn=>fn(message));}
  finish(thread:string,turn:string,error?:unknown){this.readThread={id:thread,turns:[{id:turn,status:error?'failed':'completed',items:[]}]};this.emit({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:error?'failed':'completed',error:error??null,items:[{id:`test-${turn}`,type:'commandExecution',command:'npm test',status:'completed',exitCode:0,aggregatedOutput:'fixture evidence'},{id:`msg-${turn}`,type:'agentMessage',phase:'final_answer',text:'done'}]}}});}
  count(method:string){return this.requests.filter(r=>r.method===method).length;}
}
function fixture(t:{after:(fn:()=>void)=>void},routing=true){
  const root=path.resolve('.local-tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(path.join(root,'routing-'));const workspace=path.join(dir,'repo');const runtimeDir=path.join(dir,'runtime');mkdirSync(workspace);mkdirSync(runtimeDir);
  execFileSync('git',['-c','core.hooksPath=.disabled','init','--quiet'],{cwd:workspace,windowsHide:true});writeFileSync(path.join(workspace,'value.ts'),'export const value=1;\n');
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(root+path.sep));rmSync(dir,{recursive:true,force:true});});
  const config:LocalConfig={schemaVersion:1,host:'127.0.0.1',port:8799,model:'gpt-5.6-terra',reasoningEffort:'high',projects:[{id:'fixture',name:'Fixture',path:realpathSync(workspace)}],runtimeDir,configPath:path.join(runtimeDir,'config.json')};
  const server=new Executor();const store=new StateStore(path.join(runtimeDir,'jobs.json'));const options={store,model:config.model,reasoningEffort:config.reasoningEffort,settingsConfirmationTimeoutMs:40,workspaceValidator:async(candidate:string)=>realpathSync(candidate)};
  const jobs=new JobManager(server,options);const catalog=new ModelCatalog(server);const router=new ModelRouter(catalog,undefined,{model:config.model,effort:config.reasoningEffort});const product=new AutoDev(config,jobs,routing?router:undefined);
  return {config,server,store,options,jobs,catalog,router,product};
}
const task=(request_key:string)=>({request_key,project_id:'fixture',requirements:'Independent fixture task.',acceptance:['Run fixture test.'],routing:{model:'gpt-5.6-terra',effort:'high' as const}});
const followup=(job_id:string,request_key:string)=>({job_id,request_key,requirements:'Independent fixture follow-up.',acceptance:['Run fixture test.'],routing:{model:'gpt-5.6-terra',effort:'high' as const}});

test('ordinary request asks planner to choose without dispatch or journal poisoning, then accepts the same key',async t=>{
  const f=fixture(t);const {routing:ignored,...input}=task('choose');void ignored;
  await assert.rejects(f.product.submit(input),e=>e instanceof RoutingSelectionRequiredError);
  assert.equal(f.server.count('thread/start'),0);assert.equal(f.product.journal.list().length,0);assert.equal((f.product.status().tasks as unknown[]).length,0);
  const chosen=await f.product.submit({...input,routing:{model:'gpt-5.4-mini',effort:'low',rationale:'Small bounded fixture',verification:'Run the existing fixture test once.'}});
  assert.ok('turn_id' in chosen&&chosen.turn_id);assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.effort,'low');
});

test('bounded status waits for terminal events without claiming review or dispatching another turn',async t=>{
  const f=fixture(t);const started=await f.product.submit(task('wait'));assert.ok('thread_id' in started&&started.thread_id&&started.turn_id);
  const timer=setTimeout(()=>f.server.finish(started.thread_id!,started.turn_id!),40);t.after(()=>clearTimeout(timer));
  const status=await f.product.waitStatus(started.job_id,undefined,1500);
  assert.equal(status.execution_status,'completed');assert.equal(status.review_status,'pending_chatgpt_review');assert.match(String(status.next_action),/Read every artifact/);assert.equal(f.server.count('turn/start'),1);
  const resumed=new AutoDev(f.config,new JobManager(new Executor(),f.options),f.router);
  assert.equal(resumed.status(started.job_id).review_status,'pending_chatgpt_review');
  await assert.rejects(f.product.waitStatus(started.job_id,undefined,25001),/wait_ms/);
});

test('model discovery refreshes expired catalog with official descriptions and never runs inference',async t=>{
  const f=fixture(t);f.server.models=[{...makeModel('new-catalog-model'),description:'A newly available model',displayName:'New model'} as any];
  await f.product.discoverProjects();f.catalog.invalidate();const result=await f.product.discoverProjects();
  assert.equal(result.routing?.catalog?.models[0]?.description,'A newly available model');assert.equal(result.routing?.catalog?.valid,true);assert.equal(f.server.count('model/list'),2);assert.equal(f.server.count('turn/start'),0);
});

test('real product routing reaches RPCs, preserves thread and distinct turn evidence, and caches status',async t=>{
  const f=fixture(t);const first=await f.product.submit({...task('first'),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);
  assert.equal(f.server.requests.find(r=>r.method==='thread/start')!.params.model,'gpt-5.4-mini');assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.effort,'medium');
  const initial=f.jobs.evidence(first.job_id!);assert.equal(initial.routing!.turn_confirmation.model,null);assert.equal(initial.routing!.thread_confirmation.model,'gpt-5.4-mini');
  f.server.finish(first.thread_id,first.turn_id);const sealed=f.product.seal(first.job_id!);const old=f.product.evidenceStore.read(sealed.id,'execution.json').content;
  const second=await f.product.continue({...followup(first.job_id!,'second'),routing:{model:'gpt-6-astra',effort:'xhigh'}});assert.ok('thread_id' in second&&second.thread_id&&second.turn_id);
  assert.equal(second.thread_id,first.thread_id);assert.notEqual(second.turn_id,first.turn_id);assert.equal(f.server.requests.find(r=>r.method==='thread/resume')!.params.model,'gpt-6-astra');
  assert.equal(f.server.requests.filter(r=>r.method==='turn/start')[1]!.params.effort,'xhigh');
  const status=f.product.status(second.job_id!) as any;assert.equal(status.routing.decision.selected_model,'gpt-6-astra');assert.equal(status.routing.turn_id,second.turn_id);
  assert.equal(f.product.evidenceStore.read(sealed.id,'execution.json').content,old);f.product.projects();f.product.status();assert.equal(f.server.count('model/list'),1);
});
test('blocked decisions persist, replay without dispatch and leave prior sealed round unchanged',async t=>{
  const f=fixture(t);f.server.models=[makeModel('gpt-5.6-terra')];
  const request={...task('blocked'),routing:{model:'gpt-6-astra',effort:'xhigh' as const}};const blocked=await f.product.submit(request);assert.equal(blocked.status,'blocked');assert.equal(f.server.count('thread/start'),0);
  assert.deepEqual(await f.product.submit(request),blocked);
  const first=await f.product.submit(task('ordinary'));assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);f.server.finish(first.thread_id,first.turn_id);
  const manifest=f.product.seal(first.job_id!);const prior=f.jobs.evidence(first.job_id!);
  await f.product.continue({...followup(first.job_id!,'blocked-followup'),routing:{model:'gpt-6-astra',effort:'xhigh'}});
  const status=f.product.status(first.job_id!) as any;assert.equal(status.round,1);assert.equal(status.routing_status,'blocked');assert.equal(status.manifest_id,manifest.id);assert.deepEqual(f.jobs.evidence(first.job_id!),prior);
  const reloaded=new AutoDev(f.config,new JobManager(new Executor(),f.options),f.router);
  assert.equal(reloaded.status(blocked.job_id!).execution_status,'blocked');assert.equal((reloaded.status(first.job_id!) as any).routing_attempt.decision.status,'blocked');
});
test('routed continuation scope rejection leaves durable round and routing history unchanged',async t=>{
  const f=fixture(t);const started=await f.product.submit({...task('scope-routed-first'),requirements:'AutoDev-Review-Scope: {"mode":"full"}\nIndependent fixture task.',routing:{model:'gpt-5.6-terra',effort:'high'}});assert.ok('thread_id' in started&&started.thread_id&&started.turn_id);
  f.server.finish(started.thread_id,started.turn_id);const manifest=f.product.seal(started.job_id!);
  for(const artifact of manifest.artifacts){let cursor:string|undefined;do{const page=f.product.readArtifact('scope-routed-reviewer',manifest.id,artifact.name,cursor);cursor=page.nextCursor??undefined;}while(cursor);}
  await f.product.review('scope-routed-reviewer',{request_key:'scope-routed-review',job_id:started.job_id!,manifest_id:manifest.id,verdict:'changes_requested',summary:'Retain the pinned review baseline.'});
  const before=readFileSync(path.join(f.config.runtimeDir,'product-state.json'),'utf8');
  const requirements=`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:'a'.repeat(40),excluded_binary_assets:[],required_binary_paths:[]})}\nRepair the reviewed issue.`;
  await assert.rejects(f.product.continue({request_key:'scope-routed-rejected',job_id:started.job_id!,requirements,acceptance:['The issue is fixed.'],routing:{model:'gpt-5.6-terra',effort:'high'}}),error=>error instanceof JournalError&&error.code==='FAILED');
  assert.equal(f.server.count('turn/start'),1);
  assert.equal(readFileSync(path.join(f.config.runtimeDir,'product-state.json'),'utf8'),before);
  const status=f.product.status(started.job_id!) as any;assert.equal(status.round,1);assert.equal(status.routing_attempt.request_key,'scope-routed-first');
  assert.equal(f.product.journal.list().find(record=>record.key==='scope-routed-rejected')!.status,'failed');
});
test('enabling routing preserves exact legacy execution bytes and manifest across restart',async t=>{
  const f=fixture(t,false);const {routing:ignored,...legacy}=task('legacy');void ignored;const started=await f.product.submit(legacy);assert.ok('thread_id' in started&&started.thread_id&&started.turn_id);f.server.finish(started.thread_id,started.turn_id);
  const before=JSON.stringify(f.jobs.evidence(started.job_id!));const manifest=f.product.seal(started.job_id!);
  const restartedJobs=new JobManager(new Executor(),f.options);const restarted=new AutoDev(f.config,restartedJobs,f.router);
  assert.equal(JSON.stringify(restartedJobs.evidence(started.job_id!)),before);assert.equal(restarted.seal(started.job_id!).id,manifest.id);assert.equal('routing' in restartedJobs.evidence(started.job_id!),false);
});
test('RPC timeout/auth/quota never retries or changes model/key; unknown outcome fences the executor',async t=>{
  for(const [index,error] of [new AppServerError('timeout',-32002),new AppServerError('quota',-1,{codexErrorInfo:'usageLimitExceeded'}),new AppServerError('auth',-1,{codexErrorInfo:'unauthorized'}),new Error('transport lost')].entries()){
    const f=fixture(t);f.server.turnError=error;const input={...task(`error-${index}`),routing:{model:'gpt-5.4-mini',effort:'medium' as const}};
    await assert.rejects(f.product.submit(input));await assert.rejects(f.product.submit(input));assert.equal(f.server.count('turn/start'),1);assert.equal(f.server.count('thread/start'),1);
    const saved=f.store.load()[0]!;assert.ok(saved.routing);assert.equal(saved.routing.turn_id,null);assert.equal(f.product.journal.list()[0]!.status,'uncertain');
    if(index===0||index===3){assert.equal(saved.status,'recovery_required');f.server.turnError=null;await assert.rejects(f.jobs.start(f.config.projects[0]!.path,'never replay'));assert.equal(f.server.count('turn/start'),1);}
  }
});
test('failed turn and error notifications classify real wire quota/auth without fallback',async t=>{
  const f=fixture(t);const first=await f.product.submit({...task('quota'),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);
  f.server.finish(first.thread_id,first.turn_id,{message:'subscription exhausted',codexErrorInfo:'usageLimitExceeded'});assert.equal(f.jobs.evidence(first.job_id!).routing!.dispatch_error_kind,'quota');assert.equal(f.server.count('turn/start'),1);
  const second=await f.product.submit({...task('auth'),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in second&&second.thread_id&&second.turn_id);
  f.server.emit({method:'error',params:{threadId:second.thread_id,turnId:second.turn_id,error:{message:'unauthorized',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}}}}});
  assert.equal(f.jobs.evidence(second.job_id!).routing!.dispatch_error_kind,'authentication');assert.equal(f.jobs.get(second.job_id!).status,'recovery_required');assert.equal(f.server.count('turn/start'),2);
});
test('recovery resumes saved per-turn selection even when global defaults change',async t=>{
  const f=fixture(t);const started=await f.product.submit({...task('saved'),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in started&&started.thread_id&&started.turn_id);
  const executor=new Executor();executor.readThread={id:started.thread_id,turns:[{id:started.turn_id,status:'inProgress',items:[]}]};
  const recovered=new JobManager(executor,{...f.options,model:'gpt-6-astra',reasoningEffort:'ultra'});await recovered.initialize();
  assert.equal(executor.requests.find(r=>r.method==='thread/resume')!.params.model,'gpt-5.4-mini');assert.equal(executor.requests.find(r=>r.method==='thread/resume')!.params.config.model_reasoning_effort,'medium');assert.equal(executor.count('turn/start'),0);assert.equal(recovered.get(started.job_id!).turn_id,started.turn_id);
});
test('shutdown atomically fences dispatch, refuses pending mutation/active work and ignores historical uncertain review',async t=>{
  const f=fixture(t);let release!:()=>void;f.server.catalogGate=new Promise(r=>release=r);
  const pending=f.product.submit(task('pending'));assert.equal(f.product.beginShutdown(),false);release();const started=await pending;assert.ok('thread_id' in started&&started.thread_id&&started.turn_id);
  assert.equal(f.product.beginShutdown(),false);f.server.finish(started.thread_id,started.turn_id);
  await assert.rejects(f.product.journal.execute('historical-review-uncertain',{operation:'review'},()=>{throw new Error('lost response');}));
  assert.equal(f.product.beginShutdown(),true);await assert.rejects(f.product.submit(task('too-late')),/shutting down/);assert.equal(f.server.count('turn/start'),1);
});
test('MCP schema accepts planner routing and transmits the selected settings to executor',async t=>{
  const f=fixture(t);const server=createMcpServer(f.product,'routing-client');const client=new Client({name:'routing-fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  try {
    const result=await client.callTool({name:'autodev_submit',arguments:{...task('mcp-routing'),routing:{model:'gpt-6-astra',effort:'xhigh'}}});assert.notEqual(result.isError,true);
    assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.model,'gpt-6-astra');assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.effort,'xhigh');
  }finally{await client.close();await server.close();}
});
test('frozen MCP schema recovers missing routing with explicit header and preserves idempotency',async t=>{
  const f=fixture(t);const server=createMcpServer(f.product,'frozen-client');const client=new Client({name:'frozen-schema',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  try {
    const {routing:ignored,...input}=task('frozen-routing');void ignored;
    const missing=await client.callTool({name:'autodev_submit',arguments:input});
    assert.equal(missing.isError,true);assert.match(JSON.stringify(missing),/ROUTING_SELECTION_REQUIRED/);assert.equal(f.server.count('turn/start'),0);assert.equal(f.product.journal.list().length,0);
    const requirements='AutoDev-Routing: {"model":"gpt-6-astra","effort":"xhigh","verification":"Run fixture test"}\n'+input.requirements;
    const argumentsWithHeader={...input,requirements};
    const result=await client.callTool({name:'autodev_submit',arguments:argumentsWithHeader});assert.notEqual(result.isError,true);
    assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.model,'gpt-6-astra');assert.equal(f.server.requests.find(r=>r.method==='turn/start')!.params.effort,'xhigh');
    assert.match(JSON.stringify(f.server.requests.find(r=>r.method==='turn/start')!.params),/AutoDev-Routing/);
    const replay=await client.callTool({name:'autodev_submit',arguments:argumentsWithHeader});assert.notEqual(replay.isError,true);assert.equal(f.server.count('turn/start'),1);
  }finally{await client.close();await server.close();}
});

test('failed executor shutdown preserves HTTP administration and writer lease, then retries successfully',async()=>{
  const calls:string[]=[];let fail=true;
  const actions={closeMcp:async()=>{calls.push('mcp');},stopExecutor:async()=>{calls.push('executor');if(fail)throw new Error('sensitive backend details must not escape');},closeHttp:async()=>{calls.push('http');},release:()=>{calls.push('release');},report:()=>{calls.push('fixed diagnostic');}};
  assert.equal(await shutdownResources(actions),false);assert.deepEqual(calls,['mcp','executor','fixed diagnostic']);
  fail=false;assert.equal(await shutdownResources(actions),true);assert.deepEqual(calls.slice(3),['mcp','executor','http','release']);
});
test('routing selection is durable even when thread/start never confirms an identity',async t=>{
  const f=fixture(t);f.server.threadError=new AppServerError('response lost',-32002);
  await assert.rejects(f.product.submit({...task('thread-unknown'),routing:{model:'gpt-5.4-mini',effort:'medium'}}));
  const saved=f.store.load()[0]!;assert.equal(saved.thread_id,null);assert.equal(saved.turn_id,null);assert.equal(saved.status,'recovery_required');
  assert.equal(saved.routing!.decision.selected_model,'gpt-5.4-mini');assert.equal(saved.routing!.thread_confirmation.model,null);assert.equal(saved.routing!.dispatch_error_kind,'transport');
  assert.equal(f.server.count('thread/start'),1);assert.equal(f.server.count('turn/start'),0);
});
test('loaded-thread rejoin uses settings update publication and readback before the new routed turn',async t=>{
  const f=fixture(t);const first=await f.product.submit({...task('loaded'),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);f.server.finish(first.thread_id,first.turn_id);f.server.ignoreResumeOverrides=true;
  const manifest=f.product.seal(first.job_id!);const bytes=f.product.evidenceStore.read(manifest.id,'execution.json').content;
  const second=await f.product.continue({...followup(first.job_id!,'loaded-deep'),routing:{model:'gpt-6-astra',effort:'xhigh'}});assert.ok('turn_id' in second);assert.notEqual(second.turn_id,first.turn_id);
  assert.equal(f.server.count('thread/settings/update'),1);assert.equal(f.server.count('thread/resume'),2);
  assert.deepEqual(f.server.requests.find(r=>r.method==='thread/settings/update')!.params,{threadId:first.thread_id,model:'gpt-6-astra',effort:'xhigh'});
  assert.equal(f.jobs.evidence(first.job_id!).routing!.thread_confirmation.model,'gpt-6-astra');assert.equal(f.product.evidenceStore.read(manifest.id,'execution.json').content,bytes);
});
test('unsupported settings, absent publication and mismatched readback block without a second turn',async t=>{
  for(const mode of ['unsupported','no-publication','drift']){
    const f=fixture(t);const first=await f.product.submit({...task(`first-${mode}`),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);f.server.finish(first.thread_id,first.turn_id);f.server.ignoreResumeOverrides=true;
    if(mode==='unsupported')f.server.settingsError=new AppServerError('unsupported',-32601);if(mode==='no-publication')f.server.confirmSettings=false;if(mode==='drift')f.server.readbackDrift=true;
    await assert.rejects(f.product.continue({...followup(first.job_id!,`second-${mode}`),routing:{model:'gpt-6-astra',effort:'xhigh'}}));
    assert.equal(f.server.count('turn/start'),1);assert.equal(f.server.count('thread/settings/update'),1);assert.equal((f.product.status(first.job_id!) as any).routing_status,'blocked');assert.equal(f.product.journal.list().at(-1)!.status,'uncertain');
  }
});
test('routing settings never target an active or unknown latest turn and ignore another thread publication',async t=>{
  for(const mode of ['active','foreign-turn','foreign-notification']){
    const f=fixture(t);const first=await f.product.submit({...task(`boundary-${mode}`),routing:{model:'gpt-5.4-mini',effort:'medium'}});assert.ok('thread_id' in first&&first.thread_id&&first.turn_id);f.server.finish(first.thread_id,first.turn_id);f.server.ignoreResumeOverrides=true;
    if(mode==='active')f.server.readThread.turns[0].status='inProgress';
    if(mode==='foreign-turn')f.server.readThread.turns.push({id:'another-turn',status:'completed',items:[]});
    if(mode==='foreign-notification')f.server.notificationThread='another-thread';
    await assert.rejects(f.product.continue({...followup(first.job_id!,`guard-${mode}`),routing:{model:'gpt-6-astra',effort:'xhigh'}}));
    assert.equal(f.server.count('turn/start'),1);assert.equal(f.server.count('thread/settings/update'),mode==='foreign-notification'?1:0);
  }
});
