import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sensitivePath, type SourceSnapshot } from './snapshot.js';

export const REVIEW_SCOPE_HEADER='AutoDev-Review-Scope: ';
const relativePath=z.string().min(1).max(512).refine(value=>!value.includes('\\')&&!value.includes(':')&&!/[\x00-\x1f*?\[\]]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!sensitivePath.test(value),'Use an exact non-sensitive repository-relative path.');
const asset=z.object({path:relativePath,reason:z.string().trim().min(12).max(1000)}).strict();
export const reviewScopeSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('full')}).strict(),
  z.object({mode:z.literal('changes'),base_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),excluded_binary_assets:z.array(asset).max(200),required_binary_paths:z.array(relativePath).max(200)}).strict(),
]);
export type ReviewScope=z.infer<typeof reviewScopeSchema>;
export const scopeEvidenceSchema=z.object({declaration:reviewScopeSchema,excluded:z.array(asset.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()}))}).strict();
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
    if(current?.reason!=='binary_requires_separate_review'||!current.sha256||current.bytes===undefined)throw new Error(`Binary exclusion lacks current hashed binary evidence: ${item.path}`);
    let raw:Buffer;
    try{
      const tree=git(workspace,['ls-tree','-z',base,'--',item.path]).toString('utf8');
      const entry=/^100(?:644|755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
      if(!entry||entry[2]!==item.path)throw new Error();
      raw=git(workspace,['cat-file','blob',entry[1]!]);
    }catch{throw new Error(`Binary exclusion is not a regular tracked file at base_commit: ${item.path}`);}
    const sha256=createHash('sha256').update(raw).digest('hex');
    if(!raw.includes(0)||sha256!==current.sha256||raw.length!==current.bytes)throw new Error(`Binary exclusion changed from base_commit: ${item.path}`);
    return {...item,sha256,bytes:raw.length};
  });
  return {declaration,excluded};
}

/** Changed, added, deleted, relevant, non-UTF8 and redacted files retain the separate-review gate. */
export function assertReviewableOmissions(before:SourceSnapshot,after:SourceSnapshot,scope?:ScopeEvidence):void {
  if(scope?.declaration.mode==='changes'&&scope.declaration.required_binary_paths.length)
    throw new Error('Required binary dependencies need separate review evidence and cannot be excluded from this change review.');
  const exclusions=new Map((scope?.declaration.mode==='changes'?scope.excluded:[]).map(item=>[item.path,item]));
  for(const item of exclusions.values()){
    for(const source of [before,after]){
      const captured=source.omitted.find(entry=>entry.path===item.path);
      if(captured?.reason!=='binary_requires_separate_review'||captured.sha256!==item.sha256||captured.bytes!==item.bytes)
        throw new Error(`Excluded binary changed, disappeared or lacks immutable evidence: ${item.path}`);
    }
  }
  for(const item of [...before.omitted,...after.omitted]){
    if(item.reason==='sensitive_or_private_path')continue;
    if(item.reason==='binary_requires_separate_review'&&exclusions.has(item.path))continue;
    throw new Error(`Affected or unscoped source requires separate review: ${item.path} (${item.reason}). Unrelated unchanged binaries may only be excluded by an explicit pinned change scope.`);
  }
}
