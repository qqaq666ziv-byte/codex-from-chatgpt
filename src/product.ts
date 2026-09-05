import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JobManager } from './jobs.js';
import type { JsonRpcId } from './codex-app-server.js';
import { EvidenceStore, redactSensitiveText } from './evidence.js';
import { IdempotencyJournal } from './journal.js';
import type { LocalConfig } from './local-config.js';
import { snapshotSource, sourceDiff, type SourceSnapshot } from './snapshot.js';
import { redactValue } from './redaction.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const sourceSchema=z.object({head:z.string().nullable(),files:z.record(z.string(),z.object({sha256:z.string(),content:z.string()})),omitted:z.array(z.object({path:z.string(),reason:z.string()}))});
const reviewSchema=z.object({status:z.enum(['pending_chatgpt_review','pass','changes_requested']),summary:z.string().optional(),manifestId:z.string().optional(),reviewerSession:z.string().optional(),recordedAt:z.string().optional()});
const roundSchema=z.object({requirements:z.string(),acceptance:z.array(z.string()),before:sourceSchema,turnId:z.string().nullable(),manifestId:z.string().nullable(),afterHash:z.string().nullable(),executionHash:z.string().nullable().default(null),review:reviewSchema});
const stateSchema=z.object({version:z.literal(1),records:z.array(z.object({jobId:z.string().uuid(),projectId:z.string(),rounds:z.array(roundSchema).min(1)}))});
type ProductState=z.infer<typeof stateSchema>;
type Round=z.infer<typeof roundSchema>;
export type TaskInput={request_key:string;project_id:string;requirements:string;acceptance:string[]};
const active=new Set(['starting','running','awaiting_approval','interrupting','recovery_required']);
const safe=<T>(value:T):T=>JSON.parse(JSON.stringify(redactValue(value))) as T;
const fingerprint=(source:SourceSnapshot)=>hash(JSON.stringify({head:source.head,files:Object.entries(source.files).map(([name,f])=>[name,f.sha256]),omitted:source.omitted}));

export class AutoDev {
  private state:ProductState={version:1,records:[]};
  private readonly file:string;
  readonly evidenceStore:EvidenceStore;
  readonly journal:IdempotencyJournal;
  private receipts=new Map<string,number>();
  private mutation:Promise<void>=Promise.resolve();
  private execute<T>(key:string,payload:unknown,operation:()=>Promise<T>):Promise<T> {
    return this.journal.execute(key,payload,async()=>{
      const previous=this.mutation;let release!:()=>void;
      this.mutation=new Promise<void>(resolve=>{release=resolve;});await previous;
      try{return await operation();}finally{release();}
    });
  }
  constructor(readonly config:LocalConfig,readonly jobs:JobManager) {
    this.file=path.join(config.runtimeDir,'product-state.json');
    this.evidenceStore=new EvidenceStore(path.join(config.runtimeDir,'evidence'));
    this.journal=new IdempotencyJournal(path.join(config.runtimeDir,'requests.json'));
    try {
      const envelope=JSON.parse(readFileSync(this.file,'utf8')) as {checksum:string;state:unknown};
      if(envelope.checksum!==hash(JSON.stringify(envelope.state))) throw new Error('Product state checksum mismatch.');
      this.state=stateSchema.parse(envelope.state);
      if(new Set(this.state.records.map(r=>r.jobId)).size!==this.state.records.length) throw new Error('Duplicate product job IDs.');
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  }
  private save() {
    stateSchema.parse(this.state);
    const temp=`${this.file}.${randomUUID()}.tmp`;
    const fd=openSync(temp,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify({checksum:hash(JSON.stringify(this.state)),state:this.state}));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,this.file);
  }
  projects(){return {projects:this.config.projects.map(({id,name})=>({id,name})),requested_model:this.config.model,requested_effort:this.config.reasoningEffort};}
  private project(id:string) {
    const project=this.config.projects.find(p=>p.id===id);
    if(!project) throw new Error('Unknown project_id. Register a project with the local CLI.');
    if(realpathSync(project.path)!==project.path) throw new Error('Project canonical path changed; local re-registration required.');
    return project;
  }
  private record(jobId:string) {const r=this.state.records.find(r=>r.jobId===jobId);if(!r)throw new Error('Unknown AutoDev job.');this.project(r.projectId);return r;}
  private current(jobId:string):Round {return this.record(jobId).rounds.at(-1)!;}
  private validateInput(requirements:string,acceptance:string[]) {
    if(!requirements.trim()||requirements.length>100000||!acceptance.length||acceptance.length>50||acceptance.some(a=>!a.trim()||a.length>4000))throw new Error('Provide bounded requirements and at least one explicit acceptance condition.');
  }
  private async assertExecutorIdle() {
    await this.jobs.initialize();
    if(this.jobs.list().some(job=>active.has(job.status)))throw new Error('Executor is busy or requires recovery; no task round was changed.');
  }
  private newRound(requirements:string,acceptance:string[],workspace:string):Round {
    return {requirements,acceptance,before:snapshotSource(workspace),turnId:null,manifestId:null,afterHash:null,executionHash:null,review:{status:'pending_chatgpt_review'}};
  }
  private prompt(round:Round):string {
    return `${round.requirements}\n\nAcceptance conditions:\n${round.acceptance.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nAutoDev execution boundary: work only in the registered repository. Do not read .env, authentication files, private runtime, user-home secrets or other repositories. Do not push, merge, deploy, create credentials, incur new costs or change persistent system settings. Ask for genuine user decisions via request_user_input. Run the applicable tests and report actual exit codes. Execution completion leaves ChatGPT review pending.`;
  }
  async submit(input:TaskInput) {
    this.validateInput(input.requirements,input.acceptance); const project=this.project(input.project_id);
    return this.execute(input.request_key,{operation:'submit',...input},async()=>{
      await this.assertExecutorIdle();
      const jobId=randomUUID(); const round=this.newRound(input.requirements,input.acceptance,project.path);
      this.state.records.push({jobId,projectId:project.id,rounds:[round]});this.save();
      const result=await this.jobs.start(project.path,this.prompt(round),jobId);
      round.turnId=result.turn_id??null;this.save();
      return {...result,review_status:round.review.status};
    });
  }
  async continue(input:{request_key:string;job_id:string;requirements:string;acceptance:string[]}) {
    this.validateInput(input.requirements,input.acceptance); const record=this.record(input.job_id);
    return this.execute(input.request_key,{operation:'continue',...input},async()=>{
      await this.assertExecutorIdle();
      const status=this.jobs.get(input.job_id);if(active.has(status.status))throw new Error('Previous execution is active or uncertain.');
      this.seal(input.job_id);
      const round=this.newRound(input.requirements,input.acceptance,this.project(record.projectId).path);
      record.rounds.push(round);this.save();
      const result=await this.jobs.continue(input.job_id,this.prompt(round));
      round.turnId=result.turn_id??null;this.save();return {...result,review_status:round.review.status};
    });
  }
  status(jobId?:string,sinceRevision?:number):Record<string,unknown> {
    if(!jobId)return {tasks:this.state.records.map(r=>this.status(r.jobId))};
    const record=this.record(jobId);const round=this.current(jobId);
    let execution;try{execution=this.jobs.get(jobId,{since_revision:sinceRevision});}catch{return {job_id:jobId,execution_status:'dispatch_uncertain',review_status:'pending_chatgpt_review',next_action:'Inspect local admin status; never resubmit with a fresh key until reconciled.'};}
    let evidenceError:string|undefined;
    if(!active.has(execution.status)) {try{this.seal(jobId);}catch{evidenceError='Evidence capture failed; local inspection required. Review cannot pass.';}}
    let reviewStatus:string=round.review.status;
    if(evidenceError)reviewStatus='evidence_incomplete';
    if(reviewStatus==='pass'&&fingerprint(snapshotSource(this.project(record.projectId).path))!==round.afterHash)reviewStatus='stale_review';
    return safe({...execution,project_id:record.projectId,execution_status:execution.status,review_status:reviewStatus,round:record.rounds.length,manifest_id:round.manifestId,evidence_error:evidenceError});
  }
  seal(jobId:string) {
    const record=this.record(jobId);const round=this.current(jobId);const execution=this.jobs.evidence(jobId);
    if(active.has(execution.status)||!execution.thread_id||!execution.turn_id)throw new Error('Evidence can only seal a known terminal turn.');
    if(round.turnId&&execution.turn_id!==round.turnId)throw new Error('Execution and requirement turn identities differ.');
    if(!round.turnId) {throw new Error('Dispatch response was not durably confirmed; manual reconciliation required.');}
    if(round.manifestId){
      if(round.executionHash!==hash(JSON.stringify(execution)))throw new Error('Execution evidence changed after sealing; the old manifest is stale.');
      return this.evidenceStore.manifest(round.manifestId);
    }
    const after=snapshotSource(this.project(record.projectId).path);
    const artifacts={
      'requirements.json':JSON.stringify(safe({original_requirements:record.rounds[0]!.requirements,original_acceptance:record.rounds[0]!.acceptance,current_requirements:round.requirements,current_acceptance:round.acceptance,round:record.rounds.length}),null,2),
      'changes.patch':sourceDiff(round.before,after),
      'execution.json':JSON.stringify(safe(execution),null,2),
      'source-identity.json':JSON.stringify({before:{head:round.before.head,files:Object.fromEntries(Object.entries(round.before.files).map(([k,v])=>[k,v.sha256])),omitted:round.before.omitted},after:{head:after.head,files:Object.fromEntries(Object.entries(after.files).map(([k,v])=>[k,v.sha256])),omitted:after.omitted}},null,2),
    };
    const manifest=this.evidenceStore.publish({jobId,threadId:execution.thread_id,turnId:execution.turn_id,revision:execution.revision},artifacts,{project_id:record.projectId,review_status:'pending_chatgpt_review',snapshot_policy:'tracked and unignored UTF-8 regular files; exclusions and hashes recorded',source_omissions:after.omitted,after_hash:fingerprint(after)});
    round.manifestId=manifest.id;round.afterHash=fingerprint(after);round.executionHash=hash(JSON.stringify(execution));this.save();return manifest;
  }
  readArtifact(session:string,manifestId:string,artifact:string,cursor?:string,limit?:number) {
    const manifest=this.evidenceStore.manifest(manifestId);this.record(manifest.identity.jobId);
    const page=this.evidenceStore.read(manifestId,artifact,cursor,limit);
    const key=`${session}:${manifestId}:${artifact}`;const readTo=this.receipts.get(key)??0;
    if(page.offset>readTo)throw new Error('Read this artifact sequentially from the first page.');
    this.receipts.set(key,Math.max(readTo,page.offset+Buffer.byteLength(page.content)));
    return page;
  }
  forgetSession(session:string) {for(const key of this.receipts.keys())if(key.startsWith(`${session}:`))this.receipts.delete(key);}
  async review(session:string,input:{request_key:string;job_id:string;manifest_id:string;verdict:'pass'|'changes_requested';summary:string}) {
    return this.execute(input.request_key,{operation:'review',...input},async()=>{
      const round=this.current(input.job_id);const manifest=this.seal(input.job_id);
      if(round.manifestId!==input.manifest_id||manifest.id!==input.manifest_id)throw new Error('Stale evidence revision.');
      if(!input.summary.trim()||input.summary.length>24000)throw new Error('Provide a bounded, substantive review summary.');
      for(const artifact of manifest.artifacts)if((this.receipts.get(`${session}:${manifest.id}:${artifact.name}`)??-1)<artifact.byteLength)throw new Error('Read all artifact pages in this MCP session before recording review.');
      const after=snapshotSource(this.project(this.record(input.job_id).projectId).path);
      if(fingerprint(after)!==round.afterHash)throw new Error('Workspace changed after evidence capture; continue with a fresh reviewed revision.');
      if(input.verdict==='pass') {
        const execution=this.jobs.evidence(input.job_id);
        if(execution.status!=='completed')throw new Error('Only completed execution may pass review.');
        if([...round.before.omitted,...after.omitted].some(o=>o.reason!=='sensitive_or_private_path'))throw new Error('Some source evidence requires separate review; cannot claim complete pass.');
        const tests=execution.validation.filter(item=>item.kind==='test');
        const latest=new Map(tests.map(item=>[item.command,item]));
        if(!latest.size||[...latest.values()].some(item=>item.exit_code!==0||item.status!=='passed'))throw new Error('No complete passing test command evidence for this turn.');
      }
      round.review={status:input.verdict,summary:redactSensitiveText(input.summary),manifestId:manifest.id,reviewerSession:session,recordedAt:new Date().toISOString()};this.save();
      return {job_id:input.job_id,review_status:round.review.status,manifest_id:manifest.id,recorded_by:'authenticated MCP client',identity_limit:'The bridge records the authenticated client session; it does not cryptographically attest which model reviewed.'};
    });
  }
  private pending(jobId:string,turnId:string,requestId:JsonRpcId) {
    this.record(jobId);const job=this.jobs.get(jobId);
    if(job.turn_id!==turnId)throw new Error('Stale or mismatched turn_id.');
    const pending=job.pending_approvals?.find(p=>p.request_id===requestId);
    if(!pending)throw new Error('Unknown or already answered request.');return pending;
  }
  cancel(input:{request_key:string;job_id:string;turn_id:string}) {
    this.record(input.job_id);
    return this.execute(input.request_key,{operation:'cancel',...input},async()=>{
      const job=this.jobs.get(input.job_id);if(job.turn_id!==input.turn_id)throw new Error('Stale turn_id.');
      return safe(await this.jobs.interrupt(input.job_id));
    });
  }
  answer(input:{request_key:string;job_id:string;turn_id:string;request_id:JsonRpcId;answers:Record<string,{answers:string[]}>}) {
    return this.execute(input.request_key,{operation:'answer',...input},async()=>{
      if(this.pending(input.job_id,input.turn_id,input.request_id).kind!=='user_input')throw new Error('Not a product question.');
      return safe(await this.jobs.respondUserInput(input.job_id,input.request_id,input.answers));
    });
  }
  approval(input:{request_key:string;job_id:string;turn_id:string;request_id:JsonRpcId;decision:'accept'|'decline'|'cancel'}) {
    return this.execute(input.request_key,{operation:'local-admin-approval',...input},async()=>{
      const pending=this.pending(input.job_id,input.turn_id,input.request_id);
      if(pending.kind==='user_input'||pending.kind==='permissions')throw new Error('Use answer for questions. Additional permission profiles require explicit official review; cancel and revise the task.');
      return safe(await this.jobs.respondApproval(input.job_id,input.request_id,input.decision));
    });
  }
  adminStatus() {return {tasks:this.status().tasks,requests:this.journal.list(),active_job_id:this.jobs.list().find(j=>active.has(j.status))?.job_id??null};}
}
