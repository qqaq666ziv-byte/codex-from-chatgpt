import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerError, type AppServerClient, type AppServerMessage, type JsonRpcId } from '../src/codex-app-server.js';
import { ModelCatalog, ModelRouter, DEFAULT_ROUTING_POLICY, selectRouting, classifyRoutingError, type AvailableModel, type CatalogSnapshot } from '../src/model-routing.js';

const model=(name:string,efforts=['low','medium','high','xhigh']):AvailableModel=>({id:name,model:name,defaultReasoningEffort:'medium',supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort:reasoningEffort as 'medium'})),inputModalities:['text']});
const snapshot=(models:AvailableModel[]):CatalogSnapshot=>({models,valid:true,fetchedAt:new Date(0).toISOString(),expiresAt:new Date(9999999).toISOString()});
const defaults={model:'gpt-5.6-terra',effort:'xhigh'};
class CatalogClient implements AppServerClient {
  requests:Array<{method:string;params:unknown}>=[];
  listeners:Array<(m:AppServerMessage)=>void>=[];exits:Array<(e:Error)=>void>=[];
  pages:Array<unknown>=[{data:[model(defaults.model)],nextCursor:null}];
  error:unknown=null;gate:Promise<void>|null=null;
  addMessageListener(fn:(m:AppServerMessage)=>void){this.listeners.push(fn);return()=>{};}
  addExitListener(fn:(e:Error)=>void){this.exits.push(fn);return()=>{};}
  async start(){} respond(_id:JsonRpcId,_r:unknown){} respondError(_id:JsonRpcId,_code:number,_m:string){}
  async request<T>(method:string,params?:unknown):Promise<T>{const index=this.requests.filter(r=>r.method==='model/list').length;this.requests.push({method,params});if(this.gate)await this.gate;if(this.error)throw this.error;return this.pages[index%this.pages.length] as T;}
}
test('catalog follows pagination, coalesces dispatch refresh, and status does no RPC',async()=>{
  const client=new CatalogClient();client.pages=[{data:[model('gpt-5.4-mini')],nextCursor:'page-2'},{data:[model('gpt-6-astra')],nextCursor:null}];
  let now=1000;const catalog=new ModelCatalog(client,2000,()=>now);
  const results=await Promise.all([catalog.get(),catalog.get()]);assert.deepEqual(results[0],results[1]);assert.equal(results[0]!.models.length,2);assert.equal(client.requests.length,2);
  assert.equal((client.requests[1]!.params as {cursor:string}).cursor,'page-2');
  catalog.snapshot();await catalog.get();assert.equal(client.requests.length,2);
  now=3001;assert.equal(catalog.snapshot()!.valid,false);assert.equal(client.requests.length,2);
  await catalog.get();assert.equal(client.requests.length,4);
  client.listeners.forEach(fn=>fn({method:'account/updated'}));assert.equal(catalog.snapshot()!.valid,false);
  await catalog.get();client.exits.forEach(fn=>fn(new Error('closed')));assert.equal(catalog.snapshot()!.valid,false);
});
test('catalog rejects repeated cursors and never publishes partial or stale refresh',async()=>{
  const client=new CatalogClient();let now=1000;const catalog=new ModelCatalog(client,1000,()=>now);await catalog.get();
  now=3000;client.pages=[{data:[model('other')],nextCursor:'same'}];await assert.rejects(catalog.get(),/Repeated/);
  assert.equal(catalog.snapshot()!.valid,false);assert.equal(catalog.snapshot()!.models[0]!.model,defaults.model);
  const decision=await new ModelRouter(catalog,undefined,defaults).select({risk:'high'});assert.equal(decision.status,'blocked');assert.equal(decision.selected_model,null);
});
test('account invalidation during an in-flight fetch does not publish stale capabilities',async()=>{
  const client=new CatalogClient();let release!:()=>void;client.gate=new Promise(r=>release=r);const catalog=new ModelCatalog(client);
  const pending=catalog.get();catalog.invalidate();release();await assert.rejects(pending,/invalidated/);assert.equal(catalog.snapshot(),null);
});
test('subscription gate rejects API account without querying model catalog',async()=>{
  const client=new CatalogClient();client.pages=[{account:{type:'apiKey'}}];
  const router=new ModelRouter(new ModelCatalog(client,1000,Date.now,true),undefined,defaults);
  const decision=await router.select();assert.equal(decision.status,'blocked');assert.equal(decision.error_kind,'authentication');assert.deepEqual(client.requests.map(r=>r.method),['account/read']);
});
test('planner chooses model and effort from live capabilities without static tiers or defaults',()=>{
  const models=snapshot([model('future-model',['low','high']),model(defaults.model),model('gpt-6-astra',['high','xhigh'])]);
  const choose=(r:Parameters<typeof selectRouting>[0])=>selectRouting(r,DEFAULT_ROUTING_POLICY,models,defaults);
  for(const r of [undefined,{}, {risk:'high' as const}, {profile:'fast' as const}, {model:'future-model'}])assert.equal(choose(r).status,'blocked');
  const picked=choose({model:'future-model',effort:'low',rationale:'Task is a bounded literal update.',risk:'high'});
  assert.equal(picked.selected_model,'future-model');assert.equal(picked.selected_effort,'low');assert.equal(picked.minimum_quality,0);
  assert.match(picked.reasons.join(' '),/bounded literal/);
  assert.equal(choose({model:'future-model',effort:'ultra'}).status,'blocked');
  assert.equal(choose({model:'missing',effort:'low'}).status,'blocked');
  assert.equal(choose({model:'future-model',effort:'high',requiredModalities:['image']}).status,'blocked');
  assert.equal(choose({model:'gpt-6-astra',effort:'xhigh'}).selected_model,'gpt-6-astra');
});
test('no fallback or obsolete quality mapping can silently replace a planner choice',()=>{
  const catalog=snapshot([model('new-model',['low'])]);
  const policy=structuredClone(DEFAULT_ROUTING_POLICY);policy.quality['new-model']=3;policy.profiles.deep.models=['new-model'];
  assert.equal(selectRouting({model:'missing',effort:'low',allowFallback:true},policy,catalog,defaults).status,'blocked');
  assert.equal(selectRouting({risk:'high'},policy,catalog,defaults).status,'blocked');
  assert.equal(selectRouting({model:'new-model',effort:'low'},policy,catalog,defaults).selected_model,'new-model');
  catalog.valid=false;
  assert.equal(selectRouting({model:'new-model',effort:'low'},policy,catalog,defaults).status,'blocked');
});
test('RPC classification does not assume a rate window or infer model unavailability from messages',()=>{
  for(const info of ['usageLimitExceeded','rateLimitExceeded','sessionBudgetExceeded'])assert.equal(classifyRoutingError(new AppServerError('no guessed reset',-1,{codexErrorInfo:info})),'quota');
  assert.equal(classifyRoutingError(new AppServerError('auth',-1,{codexErrorInfo:'unauthorized'})),'authentication');
  assert.equal(classifyRoutingError(new AppServerError('timeout',-32002)),'transport');
  assert.equal(classifyRoutingError(new AppServerError('bad',-32602)),'invalid_request');
  assert.equal(classifyRoutingError(new Error('model unavailable OAuth error')),'unknown');
  for(const variant of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']){
    for(const [code,kind] of [[401,'authentication'],[403,'authentication'],[429,'quota'],[503,variant==='responseTooManyFailedAttempts'?'unknown':'transport']] as const){
      assert.equal(classifyRoutingError({codexErrorInfo:{[variant]:{httpStatusCode:code}}}),kind);
    }
  }
  assert.equal(classifyRoutingError(new AppServerError('RPC rate limit',429)),'quota');
});
