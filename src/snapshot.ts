import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { redactSensitiveText } from './evidence.js';

export type GitFileMode='100644'|'100755';
/** `mode` is observed on disk; `git_mode` is the mode recorded in the index. */
export type SourceSnapshot={head:string|null;files:Record<string,{sha256:string;content:string}>;omitted:Array<{path:string;reason:string;sha256?:string;bytes?:number;mode?:GitFileMode;git_mode?:GitFileMode}>};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fileMode=(mode:number):GitFileMode=>(mode&0o111)?'100755':'100644';
function git(cwd:string,args:string[]):string { return execFileSync('git',['--no-optional-locks',...args],{cwd,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}); }
export const sensitivePath=/(^|\/)(\.env(?:\..*)?|\.git|\.runtime|\.local-tests|\.ai-bridge|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|auth\.json|credentials?(?:\..*)?|.*\.pem|.*\.key|client-token|admin-token)(\/|$)/i;
export function snapshotSource(workspace:string,allowUnversioned=false):SourceSnapshot {
  const root=realpathSync(workspace);
  const files:SourceSnapshot['files']={}; const omitted:SourceSnapshot['omitted']=[]; let bytes=0;
  let head:string|null=null;let names:string[];const gitModes=new Map<string,GitFileMode>();
  if(allowUnversioned&&!existsSync(path.join(root,'.git'))){
    names=[];let entries=0;
    const walk=(directory:string,depth:number)=>{
      if(depth>64)throw new Error('Source evidence exceeds directory depth limit.');
      for(const entry of readdirSync(directory,{withFileTypes:true})){
        if(++entries>10000)throw new Error('Source evidence exceeds 10000 entries; narrow the workspace.');
        const file=path.join(directory,entry.name);const name=path.relative(root,file).split(path.sep).join('/');
        if(sensitivePath.test(name)){omitted.push({path:name,reason:'sensitive_or_private_path'});continue;}
        if(/(^|\/)(node_modules|dist|build|coverage|\.next|\.venv|venv)(\/|$)/i.test(name)){omitted.push({path:name,reason:'generated_or_dependency_path'});continue;}
        const info=lstatSync(file);
        if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile()){omitted.push({path:name,reason:'non_regular_file'});continue;}
        if(realpathSync(file).toLowerCase()!==file.toLowerCase())throw new Error('Source path resolves through a link; evidence capture refused.');
        if(info.isDirectory())walk(file,depth+1);else names.push(name);
      }
    };
    walk(root,0);names.sort();omitted.sort((a,b)=>a.path.localeCompare(b.path));
  }else{
    const top=realpathSync(git(root,['rev-parse','--show-toplevel']).trim());
    if (top.toLowerCase()!==root.toLowerCase()) throw new Error('Register the Git repository root, not a subfolder.');
    try {head=git(root,['rev-parse','--verify','HEAD']).trim();} catch { /* empty repository */ }
    for(const entry of git(root,['ls-files','--stage','-z']).split('\0')){
      const tab=entry.indexOf('\t');if(tab<0)continue;
      const [mode,,stage]=entry.slice(0,tab).split(' ');const name=entry.slice(tab+1);
      if(name&&stage==='0'&&(mode==='100644'||mode==='100755'))gitModes.set(name,mode);
    }
    names=[...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort();
  }
  for(const name of names) {
    if (sensitivePath.test(name)) { omitted.push({path:name,reason:'sensitive_or_private_path'}); continue; }
    const file=path.resolve(root,name); const relative=path.relative(root,file);
    if(relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)) throw new Error('Invalid tracked path.');
    let stat; try {stat=lstatSync(file);} catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') continue; throw e; }
    if(!stat.isFile()||stat.isSymbolicLink()) {omitted.push({path:name,reason:'non_regular_file'});continue;}
    const canonical=realpathSync(file); if(canonical!==file && (process.platform!=='win32'||canonical.toLowerCase()!==file.toLowerCase())) throw new Error('Source path resolves through a link; evidence capture refused.');
    bytes+=stat.size; if(stat.size>2*1024*1024||bytes>32*1024*1024) throw new Error('Source evidence exceeds 2 MiB/file or 32 MiB/project limit; narrow the registered repository.');
    const raw=readFileSync(file);
    const mode=fileMode(stat.mode);const git_mode=gitModes.get(name);
    if(raw.includes(0)) {omitted.push({path:name,reason:'binary_requires_separate_review',sha256:sha(raw),bytes:raw.length,mode,...(git_mode?{git_mode}:{})});continue;}
    const text=raw.toString('utf8'); if(!Buffer.from(text).equals(raw)) {omitted.push({path:name,reason:'non_utf8_requires_separate_review',sha256:sha(raw),bytes:raw.length,mode,...(git_mode?{git_mode}:{})});continue;}
    const content=redactSensitiveText(text);
    if(content!==text) omitted.push({path:name,reason:'known_token_patterns_redacted'});
    files[name]={sha256:sha(raw),content};
  }
  return {head,files,omitted};
}
export function sourceDiff(before:SourceSnapshot,after:SourceSnapshot):string {
  return [...new Set([...Object.keys(before.files),...Object.keys(after.files)])].sort().filter(name=>before.files[name]?.sha256!==after.files[name]?.sha256).map(name=>createTwoFilesPatch(before.files[name]?`a/${name}`:'/dev/null',after.files[name]?`b/${name}`:'/dev/null',before.files[name]?.content??'',after.files[name]?.content??'')).join('\n');
}
