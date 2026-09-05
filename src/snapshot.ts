import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { redactSensitiveText } from './evidence.js';

export type SourceSnapshot={head:string|null;files:Record<string,{sha256:string;content:string}>;omitted:Array<{path:string;reason:string}>};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function git(cwd:string,args:string[]):string { return execFileSync('git',['--no-optional-locks',...args],{cwd,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}); }
export function snapshotSource(workspace:string):SourceSnapshot {
  const root=realpathSync(workspace); const top=realpathSync(git(root,['rev-parse','--show-toplevel']).trim());
  if (top.toLowerCase()!==root.toLowerCase()) throw new Error('Register the Git repository root, not a subfolder.');
  let head:string|null=null; try {head=git(root,['rev-parse','--verify','HEAD']).trim();} catch { /* empty fixture */ }
  const names=[...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort();
  const files:SourceSnapshot['files']={}; const omitted:SourceSnapshot['omitted']=[]; let bytes=0;
  for(const name of names) {
    if (/(^|\/)(\.env(?:\..*)?|\.git|\.runtime|\.local-tests|\.ai-bridge|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|auth\.json|credentials?(?:\..*)?|.*\.pem|.*\.key|client-token|admin-token)(\/|$)/i.test(name)) { omitted.push({path:name,reason:'sensitive_or_private_path'}); continue; }
    const file=path.resolve(root,name); const relative=path.relative(root,file);
    if(relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)) throw new Error('Invalid tracked path.');
    let stat; try {stat=lstatSync(file);} catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') continue; throw e; }
    if(!stat.isFile()||stat.isSymbolicLink()) {omitted.push({path:name,reason:'non_regular_file'});continue;}
    const canonical=realpathSync(file); if(canonical!==file && (process.platform!=='win32'||canonical.toLowerCase()!==file.toLowerCase())) throw new Error('Source path resolves through a link; evidence capture refused.');
    bytes+=stat.size; if(stat.size>2*1024*1024||bytes>32*1024*1024) throw new Error('Source evidence exceeds 2 MiB/file or 32 MiB/project limit; narrow the registered repository.');
    const raw=readFileSync(file);
    if(raw.includes(0)) {omitted.push({path:name,reason:'binary_requires_separate_review'});continue;}
    const text=raw.toString('utf8'); if(!Buffer.from(text).equals(raw)) {omitted.push({path:name,reason:'non_utf8_requires_separate_review'});continue;}
    const content=redactSensitiveText(text);
    if(content!==text) omitted.push({path:name,reason:'known_token_patterns_redacted'});
    files[name]={sha256:sha(raw),content};
  }
  return {head,files,omitted};
}
export function sourceDiff(before:SourceSnapshot,after:SourceSnapshot):string {
  return [...new Set([...Object.keys(before.files),...Object.keys(after.files)])].sort().filter(name=>before.files[name]?.sha256!==after.files[name]?.sha256).map(name=>createTwoFilesPatch(before.files[name]?`a/${name}`:'/dev/null',after.files[name]?`b/${name}`:'/dev/null',before.files[name]?.content??'',after.files[name]?.content??'')).join('\n');
}
