import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from './local-config.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const key=(value:string)=>value.toLowerCase();
const identitySchema=z.object({dev:z.string(),ino:z.string(),birth:z.string()}).strict();
type Identity=z.infer<typeof identitySchema>;
const projectSchema=z.object({id:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),name:z.string(),path:z.string(),identity:identitySchema}).strict();
const requestSchema=z.object({key:z.string(),name:z.string(),folder:z.string(),projectId:z.string(),status:z.enum(['pending','created','existing'])}).strict();
const stateSchema=z.object({version:z.literal(1),root:z.string(),rootIdentity:identitySchema,projects:z.array(projectSchema),requests:z.array(requestSchema)}).strict();
type State=z.infer<typeof stateSchema>;
export type CreateProjectInput={request_key:string;name:string};
export class ProjectError extends Error {
  constructor(readonly code:string){super(`${code}: ${messages[code]??'Project operation refused; inspect local registry before retrying.'}`);}
}
const messages:Record<string,string>={
  PROJECT_CREATION_DISABLED:'A local administrator must configure the allowed project creation root.',
  INVALID_PROJECT_NAME:'Use a project name, not a path. Separators, traversal and drive syntax are forbidden.',
  PROJECT_CONFLICT:'The folder already exists and is not this registered project. Nothing was adopted or overwritten.',
  REQUEST_KEY_CONFLICT:'Reuse this request key only with the same project name.',
  PROJECT_PATH_CHANGED:'The directory identity or canonical path changed; local inspection is required.',
  PROJECT_CREATION_UNCERTAIN:'A previous creation did not commit. Existing content was preserved; local reconciliation is required.',
  REGISTRY_WRITE_FAILED:'Registration failed. Only this operation\'s empty directory may have been rolled back. Reuse the same request key.',
  REGISTRY_INVALID:'The persistent project registry failed validation; it was not replaced.',
};
function identity(directory:string):Identity {
  const info=lstatSync(directory,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())throw new ProjectError('PROJECT_PATH_CHANGED');
  return {dev:String(info.dev),ino:String(info.ino),birth:String(info.birthtimeNs)};
}
function equalIdentity(a:Identity,b:Identity){return a.dev===b.dev&&a.ino===b.ino&&a.birth===b.birth;}
/** Reject links at every ancestor, including Windows junctions. Never resolve a supplied name as a path. */
export function assertPlainDirectory(directory:string):Identity {
  const absolute=path.resolve(directory);
  let current=absolute;
  for(;;){identity(current);const parent=path.dirname(current);if(parent===current)break;current=parent;}
  if(key(realpathSync(absolute))!==key(absolute))throw new ProjectError('PROJECT_PATH_CHANGED');
  return identity(absolute);
}
export function projectFolder(name:string):{name:string;folder:string} {
  if(typeof name!=='string'||!name.trim()||name.length>100||Buffer.from(name,'utf8').toString('utf8')!==name)throw new ProjectError('INVALID_PROJECT_NAME');
  const display=name.normalize('NFKC').trim();
  if(/[\\/:\x00-\x1f\x7f]/.test(display)||display.includes('..')||/^[.]/.test(display))throw new ProjectError('INVALID_PROJECT_NAME');
  let folder=display.replace(/[<>"|?*]/g,'_').replace(/\s+/g,' ').replace(/[. ]+$/g,'');
  if(!folder)throw new ProjectError('INVALID_PROJECT_NAME');
  if(/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(folder))folder=`_${folder}`;
  return {name:display,folder};
}

/** The core's existing runtime writer lease owns this synchronous, atomic registry. */
export class ProjectRegistry {
  private state:State|undefined;
  private readonly file:string;
  constructor(private readonly config:LocalConfig){
    this.file=path.join(config.runtimeDir,'project-registry.json');
    if(!config.projectCreationRoot)return;
    const root=config.projectCreationRoot;
    if(!path.isAbsolute(root)||root===path.parse(root).root||root.startsWith('\\\\'))throw new ProjectError('REGISTRY_INVALID');
    const rootIdentity=assertPlainDirectory(root);
    this.state={version:1,root:path.resolve(root),rootIdentity,projects:[],requests:[]};
    try {
      if(lstatSync(this.file).isSymbolicLink())throw new ProjectError('REGISTRY_INVALID');
      const envelope=JSON.parse(readFileSync(this.file,'utf8')) as {state:unknown;checksum:string};
      if(digest(JSON.stringify(envelope.state))!==envelope.checksum)throw new ProjectError('REGISTRY_INVALID');
      const loaded=stateSchema.parse(envelope.state);
      if(key(loaded.root)!==key(this.state.root)||!equalIdentity(loaded.rootIdentity,rootIdentity))throw new ProjectError('PROJECT_PATH_CHANGED');
      if(new Set(loaded.projects.map(p=>p.id)).size!==loaded.projects.length||new Set(loaded.projects.map(p=>key(p.path))).size!==loaded.projects.length||new Set(loaded.requests.map(r=>r.key)).size!==loaded.requests.length)throw new ProjectError('REGISTRY_INVALID');
      for(const p of loaded.projects)if(key(path.dirname(p.path))!==key(loaded.root)||projectFolder(p.name).folder.toLowerCase()!==path.basename(p.path).toLowerCase())throw new ProjectError('REGISTRY_INVALID');
      for(const r of loaded.requests)if(projectFolder(r.name).folder!==r.folder||r.status!=='pending'&&!config.projects.some(p=>p.id===r.projectId)&&!loaded.projects.some(p=>p.id===r.projectId))throw new ProjectError('REGISTRY_INVALID');
      this.state=loaded;
    } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const p of this.state.projects){
      const prior=config.projects.find(existing=>existing.id===p.id||key(existing.path)===key(p.path));
      if(prior&&(prior.id!==p.id||key(prior.path)!==key(p.path)))throw new ProjectError('REGISTRY_INVALID');
      if(!prior)config.projects.push({id:p.id,name:p.name,path:p.path});
    }
  }
  private save(next:State){
    const temp=`${this.file}.${randomUUID()}.tmp`;
    try {
      const fd=openSync(temp,'wx',0o600);
      try{writeFileSync(fd,JSON.stringify({state:next,checksum:digest(JSON.stringify(next))}));fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,this.file);this.state=next;
    } catch {try{unlinkSync(temp);}catch{/* only this temporary file */}throw new ProjectError('REGISTRY_WRITE_FAILED');}
  }
  private checkRoot(){
    if(!this.state)throw new ProjectError('PROJECT_CREATION_DISABLED');
    if(!equalIdentity(assertPlainDirectory(this.state.root),this.state.rootIdentity))throw new ProjectError('PROJECT_PATH_CHANGED');
    return this.state;
  }
  managed(workspace:string){return this.state?.projects.some(p=>key(p.path)===key(workspace))??false;}
  validate(workspace:string){
    const p=this.state?.projects.find(p=>key(p.path)===key(workspace));
    if(p){this.checkRoot();if(!equalIdentity(assertPlainDirectory(workspace),p.identity))throw new ProjectError('PROJECT_PATH_CHANGED');}
  }
  create(input:CreateProjectInput){
    if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.request_key))throw new ProjectError('REQUEST_KEY_CONFLICT');
    let state=this.checkRoot();const normalized=projectFolder(input.name);
    const target=path.join(state.root,normalized.folder);
    if(target.length>240||key(path.dirname(target))!==key(state.root))throw new ProjectError('INVALID_PROJECT_NAME');
    let request=state.requests.find(r=>r.key===input.request_key);
    if(request&&request.name!==normalized.name)throw new ProjectError('REQUEST_KEY_CONFLICT');
    if(state.requests.some(r=>r.key!==input.request_key&&r.status==='pending'&&key(r.folder)===key(normalized.folder)))throw new ProjectError('PROJECT_CREATION_UNCERTAIN');
    const registered=this.config.projects.find(p=>key(p.path)===key(target));
    const result=(p:{id:string;name:string;path:string},status:'created'|'existing')=>({project_id:p.id,name:p.name,workspace:p.path,status,next_action:'autodev_submit',instruction:'Immediately submit the original authorized development requirements with this project_id and a separate stable submit request_key. No manual workspace setup is needed.'});
    if(registered){
      assertPlainDirectory(target);this.validate(target);
      if(key(registered.name.normalize('NFKC').trim())!==key(normalized.name))throw new ProjectError('PROJECT_CONFLICT');
      if(request?.status==='pending')throw new ProjectError('PROJECT_CREATION_UNCERTAIN');
      if(!request){request={key:input.request_key,...normalized,projectId:registered.id,status:'existing'};this.save({...state,requests:[...state.requests,request]});}
      return result(registered,request.status as 'created'|'existing');
    }
    if(request&&request.status!=='pending')throw new ProjectError('PROJECT_PATH_CHANGED');
    try{lstatSync(target);throw new ProjectError(request?'PROJECT_CREATION_UNCERTAIN':'PROJECT_CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!request){
      let id=normalized.folder.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^[-_]+|[-_]+$/g,'').slice(0,40)||'project';
      if(id==='project'||this.config.projects.some(p=>p.id===id)||state.requests.some(r=>r.projectId===id))id=`${id}-${digest(key(target)).slice(0,12)}`;
      if(this.config.projects.some(p=>p.id===id)||state.requests.some(r=>r.projectId===id))throw new ProjectError('PROJECT_CONFLICT');
      request={key:input.request_key,...normalized,projectId:id,status:'pending'};
      this.save({...state,requests:[...state.requests,request]});state=this.state!;
    }
    let created:Identity|undefined;
    try {
      this.checkRoot();mkdirSync(target);created=assertPlainDirectory(target);
      const project={id:request.projectId,name:normalized.name,path:realpathSync(target),identity:created};
      this.checkRoot();
      if(!equalIdentity(assertPlainDirectory(target),created))throw new ProjectError('PROJECT_PATH_CHANGED');
      this.save({...state,projects:[...state.projects,project],requests:state.requests.map(r=>r.key===input.request_key?{...r,status:'created'}:r)});
      this.config.projects.push({id:project.id,name:project.name,path:project.path});
      return result(project,'created');
    } catch(error){
      // Never recurse. A replacement, link, nonempty directory, or pre-existing folder is preserved.
      if(created)try{this.checkRoot();if(equalIdentity(assertPlainDirectory(target),created))rmdirSync(target);}catch{/* preserve uncertain/nonempty content */}
      if(error instanceof ProjectError)throw error;
      throw new ProjectError('PROJECT_CREATION_UNCERTAIN');
    }
  }
}
