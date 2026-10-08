import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sensitivePath, type GitFileMode, type SourceSnapshot } from './snapshot.js';

export const REVIEW_SCOPE_HEADER='AutoDev-Review-Scope: ';
const relativePath=z.string().min(1).max(512).refine(value=>!value.includes('\\')&&!value.includes(':')&&!/[\x00-\x1f*?\[\]]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!sensitivePath.test(value),'Use an exact non-sensitive repository-relative path.');
const asset=z.object({path:relativePath,reason:z.string().trim().min(12).max(1000)}).strict();
export const reviewScopeSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('full')}).strict(),
  z.object({mode:z.literal('changes'),base_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),excluded_binary_assets:z.array(asset).max(200),required_binary_paths:z.array(relativePath).max(200)}).strict(),
]);
export type ReviewScope=z.infer<typeof reviewScopeSchema>;
export const scopeEvidenceSchema=z.object({declaration:reviewScopeSchema,excluded:z.array(asset.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative(),git_mode:z.enum(['100644','100755']).optional(),working_mode:z.enum(['100644','100755']).optional(),git_blob_oid:z.string().regex(/^[a-f0-9]{40,64}$/).optional()}))}).strict();
export type ScopeEvidence=z.infer<typeof scopeEvidenceSchema>;

/** Explicit leading control records only; never infer review scope from prose or repository content. */
export function parseReviewScope(requirements:string):ReviewScope|undefined {
  let scope:ReviewScope|undefined;
  for(const line of requirements.split('\n')) {
    if(line.startsWith('AutoDev-Routing: '))continue;
    if(!line.startsWith(REVIEW_SCOPE_HEADER))break;
    if(scope)throw new Error('Duplicate AutoDev-Review-Scope header. No dispatch.');
    if(line.length>32000)throw new Error('AutoDev-Review-Scope header is too large. No dispatch.');
    try{scope=reviewScopeSchema.parse(JSON.parse(line.slice(REVIEW_SCOPE_HEADER.length)));}
    catch{throw new Error('Invalid AutoDev-Review-Scope: supply mode and, for changes, a pinned base_commit, exact excluded_binary_assets with reasons, and required_binary_paths. No dispatch.');}
  }
  return scope;
}

function git(workspace:string,args:string[]):Buffer {
  return execFileSync('git',['--no-optional-locks',...args],{cwd:workspace,windowsHide:true,maxBuffer:3*1024*1024,stdio:['ignore','pipe','pipe']});
}

/** Pin exclusions at dispatch; a later review cannot add exceptions to a sealed manifest. */
export function captureReviewScope(workspace:string,declaration:ReviewScope|undefined,before:SourceSnapshot):ScopeEvidence|undefined {
  if(!declaration)return undefined; // Legacy evidence remains strict; missing hashes are never inferred.
  if(declaration.mode==='full')return {declaration,excluded:[]};
  const base=declaration.base_commit;
  try {
    if(git(workspace,['rev-parse','--verify',`${base}^{commit}`]).toString('utf8').trim()!==base)throw new Error();
    git(workspace,['merge-base','--is-ancestor',base,'HEAD']);
  }catch{throw new Error('Review scope base_commit must identify an existing full commit SHA in the current HEAD ancestry.');}
  const paths=new Set<string>();
  const excluded=declaration.excluded_binary_assets.map(item=>{
    if(paths.has(item.path)||declaration.required_binary_paths.includes(item.path))throw new Error('A binary exclusion is duplicated or is a required dependency.');
    paths.add(item.path);
    const current=before.omitted.find(entry=>entry.path===item.path);
    if(current?.reason!=='binary_requires_separate_review'||!current.sha256||current.bytes===undefined||!current.mode||!current.git_mode||!current.git_oid)throw new Error(`Binary exclusion lacks current hashed binary, Git mode, or stage-0 blob evidence: ${item.path}`);
    let raw:Buffer;let staged:Buffer;
    let gitMode:GitFileMode;
    let gitBlobOid:string;
    try{
      const tree=git(workspace,['ls-tree','-z',base,'--',item.path]).toString('utf8');
      const entry=/^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
      if(!entry||entry[3]!==item.path)throw new Error();
      gitMode=entry[1] as GitFileMode;
      gitBlobOid=entry[2]!;
      raw=git(workspace,['cat-file','blob',gitBlobOid]);
      staged=git(workspace,['cat-file','blob',current.git_oid]);
    }catch{throw new Error(`Binary exclusion is not a regular tracked file at base_commit: ${item.path}`);}
    const sha256=createHash('sha256').update(raw).digest('hex');
    const stagedSha256=createHash('sha256').update(staged).digest('hex');
    if(!raw.includes(0)||!staged.includes(0)||sha256!==current.sha256||raw.length!==current.bytes||stagedSha256!==sha256||staged.length!==raw.length||current.git_oid!==gitBlobOid||gitMode!==current.git_mode||(process.platform!=='win32'&&gitMode!==current.mode))throw new Error(`Binary exclusion content, stage-0 blob, or mode changed from base_commit: ${item.path}`);
    return {...item,sha256,bytes:raw.length,git_mode:gitMode,working_mode:current.mode,git_blob_oid:gitBlobOid};
  });
  return {declaration,excluded};
}

/** A first follow-up scope may be bound only to binary evidence unchanged since the task began. */
export function assertScopeMatchesInitialSnapshot(scope:ScopeEvidence,initial:SourceSnapshot):void {
  for(const item of scope.excluded){
    const captured=initial.omitted.find(entry=>entry.path===item.path);
    if(captured?.reason!=='binary_requires_separate_review'||!captured.sha256||captured.bytes===undefined||!captured.mode||!captured.git_mode||!captured.git_oid||captured.sha256!==item.sha256||captured.bytes!==item.bytes||captured.mode!==item.working_mode||captured.git_mode!==item.git_mode||captured.git_oid!==item.git_blob_oid)
      throw new Error(`Binary exclusion changed since the initial baseline or lacks immutable evidence: ${item.path}`);
  }
}

/** Changed, added, deleted, relevant, non-UTF8 and redacted files retain the separate-review gate. */
export function assertReviewableOmissions(before:SourceSnapshot,after:SourceSnapshot,scope?:ScopeEvidence):void {
  if(scope?.declaration.mode==='changes'&&scope.declaration.required_binary_paths.length)
    throw new Error('Required binary dependencies need separate review evidence and cannot be excluded from this change review.');
  const exclusions=new Map((scope?.declaration.mode==='changes'?scope.excluded:[]).map(item=>[item.path,item]));
  for(const item of exclusions.values()){
    for(const source of [before,after]){
      const captured=source.omitted.find(entry=>entry.path===item.path);
      if(captured?.reason!=='binary_requires_separate_review'||captured.sha256!==item.sha256||captured.bytes!==item.bytes||!item.git_mode||!item.working_mode||!item.git_blob_oid||captured.mode!==item.working_mode||captured.git_mode!==item.git_mode||captured.git_oid!==item.git_blob_oid)
        throw new Error(`Excluded binary content or mode changed, disappeared or lacks immutable evidence: ${item.path}`);
    }
  }
  for(const item of [...before.omitted,...after.omitted]){
    if(item.reason==='sensitive_or_private_path')continue;
    if(item.reason==='binary_requires_separate_review'&&exclusions.has(item.path))continue;
    throw new Error(`Affected or unscoped source requires separate review: ${item.path} (${item.reason}). Unrelated unchanged binaries may only be excluded by an explicit pinned change scope.`);
  }
}
