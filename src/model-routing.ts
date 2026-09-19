import { z } from 'zod';
import { AppServerError, type AppServerClient } from './codex-app-server.js';

export const effortSchema = z.enum(['none','minimal','low','medium','high','xhigh','max','ultra']);
export const routingRequestSchema = z.object({
  profile:z.enum(['auto','fast','balanced','deep']).optional(),
  model:z.string().min(1).max(128).optional(), effort:effortSchema.optional(),
  complexity:z.enum(['simple','moderate','complex']).optional(),
  risk:z.enum(['low','medium','high']).optional(),
  phase:z.enum(['planning','implementation','debugging','review']).optional(),
  preference:z.enum(['speed','balanced','quality']).optional(),
  requiredModalities:z.array(z.enum(['text','image'])).max(2).optional(),
  minimumQuality:z.number().int().min(1).max(3).optional(),
  allowFallback:z.boolean().optional(),
  rationale:z.string().min(1).max(4000).optional(),
  verification:z.string().min(1).max(4000).optional(),
}).strict();
export type RoutingRequest = z.infer<typeof routingRequestSchema>;
const profileSchema=z.object({models:z.array(z.string().min(1)).max(20),efforts:z.array(effortSchema).max(8),minimumQuality:z.number().int().min(1).max(3)}).strict();
export const routingPolicySchema=z.object({
  version:z.string().min(1).max(80),cacheTtlMs:z.number().int().min(1000).max(3600000),
  quality:z.record(z.string(),z.number().int().min(1).max(3)),
  profiles:z.object({fast:profileSchema,balanced:profileSchema,deep:profileSchema}).strict(),
}).strict();
export type RoutingPolicy=z.infer<typeof routingPolicySchema>;
// Keep the old config shape readable, but task/model tier tables no longer decide dispatch.
// The ordinary ChatGPT planner chooses from the live official catalog.
export const DEFAULT_ROUTING_POLICY:RoutingPolicy={
  version:'chatgpt-planner-2',cacheTtlMs:300000,
  quality:{},
  profiles:{
    fast:{models:[],efforts:[],minimumQuality:1},
    balanced:{models:[],efforts:[],minimumQuality:1},
    deep:{models:[],efforts:[],minimumQuality:1},
  },
};

const modelSchema=z.object({id:z.string().min(1),model:z.string().min(1),hidden:z.boolean().optional(),
  displayName:z.string().optional(),description:z.string().optional(),isDefault:z.boolean().optional(),
  supportedReasoningEfforts:z.array(z.object({reasoningEffort:effortSchema,description:z.string().optional()})).min(1),
  defaultReasoningEffort:effortSchema,inputModalities:z.array(z.enum(['text','image'])).optional(),
});
export type AvailableModel=z.infer<typeof modelSchema>;
export type CatalogSnapshot={models:AvailableModel[];fetchedAt:string;expiresAt:string;valid:boolean};
export type RoutingErrorKind='quota'|'authentication'|'transport'|'invalid_request'|'unknown';
export function classifyRoutingError(error:unknown):RoutingErrorKind {
  const value=error as {code?:unknown;data?:{codexErrorInfo?:unknown};codexErrorInfo?:unknown};
  const info=value?.data?.codexErrorInfo??value?.codexErrorInfo;
  const httpStatus=typeof info==='object'&&info!==null?Object.values(info).find(v=>typeof v==='object'&&v!==null&&'httpStatusCode' in v)?.httpStatusCode:undefined;
  if(httpStatus===401||httpStatus===403)return 'authentication';
  if(httpStatus===429||value?.code===429)return 'quota';
  if(['usageLimitExceeded','rateLimitExceeded','sessionBudgetExceeded'].includes(String(info)))return 'quota';
  if(info==='unauthorized'||value?.code===401||value?.code===403)return 'authentication';
  if(value?.code===-32002||typeof info==='object'&&info!==null&&['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected'].some(k=>k in info))return 'transport';
  if(value?.code===-32602||info==='badRequest')return 'invalid_request';
  return 'unknown';
}

/** Read-only discovery. Refresh happens at dispatch or explicit startup, never status. */
export class ModelCatalog {
  private cached:CatalogSnapshot|null=null;
  private pending:Promise<CatalogSnapshot>|null=null;
  private generation=0;
  constructor(private readonly client:AppServerClient,private readonly ttlMs=300000,private readonly now=Date.now,private readonly requireChatgptAccount=false) {
    client.addExitListener(()=>this.invalidate());
    client.addMessageListener(message=>{if(message.method==='account/updated')this.invalidate();});
  }
  invalidate(){this.generation++;if(this.cached)this.cached.valid=false;}
  snapshot():CatalogSnapshot|null{return this.cached?structuredClone({...this.cached,valid:this.cached.valid&&this.now()<Date.parse(this.cached.expiresAt)}):null;}
  async get():Promise<CatalogSnapshot>{
    const current=this.snapshot();if(current?.valid)return current;
    if(this.pending)return structuredClone(await this.pending);
    const generation=this.generation;
    const operation=this.discover(generation);this.pending=operation;
    try{return structuredClone(await operation);}finally{if(this.pending===operation)this.pending=null;}
  }
  private async discover(generation:number):Promise<CatalogSnapshot>{
    if(this.requireChatgptAccount){const account=await this.client.request<{account:{type:string}|null}>('account/read',{refreshToken:false});if(account.account?.type!=='chatgpt')throw new AppServerError('Official ChatGPT subscription authentication required.',401);}
    const models:AvailableModel[]=[];const cursors=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<100;page++){
      const result=z.object({data:z.array(modelSchema),nextCursor:z.string().min(1).nullable()}).parse(await this.client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})}));
      models.push(...result.data.filter(m=>!m.hidden));
      cursor=result.nextCursor;
      if(!cursor){
        if(generation!==this.generation)throw new Error('Model catalog invalidated during discovery; dispatch blocked.');
        if(!models.length||new Set(models.map(m=>m.model)).size!==models.length||new Set(models.map(m=>m.id)).size!==models.length)throw new Error('Empty or ambiguous model catalog.');
        const now=this.now();this.cached={models,fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+this.ttlMs).toISOString(),valid:true};return this.cached;
      }
      if(cursors.has(cursor))throw new Error('Repeated model catalog cursor.');cursors.add(cursor);
    }
    throw new Error('Model catalog exceeded pagination bound.');
  }
}

export const routingDecisionSchema=z.object({
  policy_version:z.string(),requested:routingRequestSchema,profile:z.string(),minimum_quality:z.number(),
  status:z.enum(['selected','blocked']),selected_model:z.string().nullable(),selected_effort:effortSchema.nullable(),
  reasons:z.array(z.string()),fallback_reason:z.string().nullable(),catalog_fetched_at:z.string().nullable(),
  error_kind:z.enum(['quota','authentication','transport','invalid_request','unknown']).optional(),
});
export type RoutingDecision=z.infer<typeof routingDecisionSchema>;
export const routingEvidenceSchema=z.object({
  decision:routingDecisionSchema,job_id:z.string(),thread_id:z.string().nullable(),turn_id:z.string().nullable(),
  thread_confirmation:z.object({source:z.enum(['thread/start','thread/resume']),model:z.string().nullable(),effort:z.string().nullable()}),
  turn_confirmation:z.object({model:z.null(),effort:z.null(),status:z.literal('unconfirmed'),reason:z.string()}),
  dispatch_error_kind:z.enum(['quota','authentication','transport','invalid_request','unknown']).optional(),
});
export type RoutingEvidence=z.infer<typeof routingEvidenceSchema>;
export function selectRouting(request:RoutingRequest|undefined,policy:RoutingPolicy,catalog:CatalogSnapshot,defaults:{model:string;effort:string}):RoutingDecision {
  const r=routingRequestSchema.parse(request??{});
  void policy;void defaults;
  const reasons:string[]=[];
  const decision:RoutingDecision={policy_version:'chatgpt-planner-2',requested:r,profile:'planner',minimum_quality:0,status:'blocked',selected_model:null,selected_effort:null,reasons,fallback_reason:null,catalog_fetched_at:catalog.fetchedAt};
  if(!catalog.valid){reasons.push('Catalog is unavailable or expired.');return decision;}
  if(!r.model||!r.effort){reasons.push('Planner must select both model and effort from the current catalog using the actual task. No fixed default or tier mapping is applied.');return decision;}
  const matches=catalog.models.filter(m=>m.model===r.model||m.id===r.model);
  const model=matches.length===1?matches[0]:undefined;
  if(!model||model.hidden||!model.supportedReasoningEfforts.some(e=>e.reasoningEffort===r.effort)||!(r.requiredModalities??[]).every(m=>model.inputModalities?.includes(m))){
    reasons.push('Selected model, effort or modality is unavailable or ambiguous. No fallback or execution.');return decision;
  }
  decision.status='selected';decision.selected_model=model.model;decision.selected_effort=r.effort;
  reasons.push('Planner choice validated against the live official catalog. Capability suitability is planner judgment, not an invented numeric score.');
  if(r.rationale)reasons.push(r.rationale);
  return decision;
}

export class ModelRouter {
  readonly policy:RoutingPolicy;
  constructor(readonly catalog:ModelCatalog,policy:RoutingPolicy|undefined,private readonly defaults:{model:string;effort:string}){this.policy=routingPolicySchema.parse(policy??DEFAULT_ROUTING_POLICY);}
  async select(request?:RoutingRequest):Promise<RoutingDecision>{
    routingRequestSchema.parse(request??{});
    try{return selectRouting(request,this.policy,await this.catalog.get(),this.defaults);}
    catch(error){return {policy_version:'chatgpt-planner-2',requested:request??{},profile:'planner',minimum_quality:0,status:'blocked',selected_model:null,selected_effort:null,reasons:['Catalog discovery failed; no execution dispatched.'],fallback_reason:null,catalog_fetched_at:null,error_kind:classifyRoutingError(error)};}
  }
  snapshot(){return {policy_version:'chatgpt-planner-2',selection_authority:'ordinary ChatGPT planner; server validates availability',catalog:this.catalog.snapshot()};}
}

export function makeRoutingEvidence(decision:RoutingDecision,jobId:string,threadId:string|null,source:'thread/start'|'thread/resume',response:Record<string,unknown>):RoutingEvidence {
  return {decision:structuredClone(decision),job_id:jobId,thread_id:threadId,turn_id:null,
    thread_confirmation:{source,model:typeof response.model==='string'?response.model:null,effort:typeof response.reasoningEffort==='string'?response.reasoningEffort:null},
    turn_confirmation:{model:null,effort:null,status:'unconfirmed',reason:'Codex App Server 0.153.4 Turn responses do not confirm model or effort. Thread configuration is recorded separately.'}};
}
