import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppServerClient, AppServerMessage, JsonRpcId } from '../src/codex-app-server.js';
import { ProjectRegistry, projectFolder } from '../src/project-registry.js';
import { loadLocalConfig, type LocalConfig } from '../src/local-config.js';
import { JobManager } from '../src/jobs.js';
import { StateStore } from '../src/store.js';
import { AutoDev } from '../src/product.js';
import { createMcpServer } from '../src/mcp.js';
import { snapshotSource } from '../src/snapshot.js';

function fixture(t:{after:(fn:()=>void)=>void}){
  const base=path.resolve('.local-tests');mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(path.join(base,'create-project-'));
  const root=path.join(dir,'作品');const runtimeDir=path.join(dir,'runtime');mkdirSync(root);mkdirSync(runtimeDir);
  const prior=path.join(dir,'existing');mkdirSync(prior);writeFileSync(path.join(prior,'keep.txt'),'existing content');
  const config:LocalConfig={schemaVersion:1,host:'127.0.0.1',port:8790,model:'fixture-model',reasoningEffort:'high',projects:[{id:'existing',name:'Existing',path:realpathSync(prior)}],projectCreationRoot:realpathSync(root),runtimeDir,configPath:path.join(runtimeDir,'config.json')};
  writeFileSync(config.configPath,JSON.stringify(config));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(base+path.sep));rmSync(dir,{recursive:true,force:true});});
  return {dir,root,runtimeDir,prior,config,reload:()=>loadLocalConfig(config.configPath)};
}
class Executor implements AppServerClient {
  requests:Array<{method:string;params:any}>=[];listeners:Array<(m:AppServerMessage)=>void>=[];
  async start(){}addMessageListener(fn:(m:AppServerMessage)=>void){this.listeners.push(fn);return()=>{};}addExitListener(){return()=>{};}
  respond(_id:JsonRpcId,_value:unknown){}respondError(_id:JsonRpcId,_code:number,_message:string){}
  async request<T>(method:string,params?:any):Promise<T>{
    this.requests.push({method,params});
    if(method==='thread/start')return {thread:{id:'fixture-thread'},model:params.model,reasoningEffort:params.config.model_reasoning_effort,approvalPolicy:'on-request',sandbox:'workspace-write'} as T;
    if(method==='turn/start')return {turn:{id:'fixture-turn',status:'inProgress',items:[]}} as T;
    return {} as T;
  }
}

test('MCP create -> projects -> existing submit dispatches an empty non-Git workspace and seals its output',async t=>{
  const f=fixture(t);const executor=new Executor();
  const jobs=new JobManager(executor,{store:new StateStore(path.join(f.runtimeDir,'jobs.json')),model:f.config.model,reasoningEffort:f.config.reasoningEffort,workspaceValidator:async workspace=>product.validateWorkspace(workspace)});
  const product=new AutoDev(f.config,jobs);const server=createMcpServer(product,'fixture');const client=new Client({name:'fixture',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(b),client.connect(a)]);
  try{
    const createTool=(await client.listTools()).tools.find(tool=>tool.name==='autodev_create_project');assert.ok(createTool);assert.equal(createTool.annotations?.destructiveHint,false);
    const input={request_key:'create-snake',name:'SnakeGame'};
    const created=await client.callTool({name:'autodev_create_project',arguments:input});assert.notEqual(created.isError,true);
    const project=created.structuredContent as any;assert.equal(project.project_id,'snakegame');assert.equal(project.workspace,path.join(f.root,'SnakeGame'));
    assert.deepEqual(readdirSync(project.workspace),[]);
    assert.deepEqual((await client.callTool({name:'autodev_create_project',arguments:input})).structuredContent,created.structuredContent);
    const listed=(await client.callTool({name:'autodev_projects',arguments:{}})).structuredContent as any;assert.equal(listed.projects.length,2);assert.ok(listed.projects.some((p:any)=>p.id===project.project_id));
    const submitted=await client.callTool({name:'autodev_submit',arguments:{request_key:'submit-snake',project_id:project.project_id,requirements:'Write a minimal fixture text file.',acceptance:['Fixture file exists.']}});
    assert.notEqual(submitted.isError,true,JSON.stringify(submitted));
    assert.equal(executor.requests.find(r=>r.method==='thread/start')!.params.cwd,project.workspace);
    assert.equal(executor.requests.filter(r=>r.method==='turn/start').length,1);
    writeFileSync(path.join(project.workspace,'hello.txt'),'hello');
    executor.listeners.forEach(fn=>fn({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[]}}}));
    const manifest=product.seal((submitted.structuredContent as any).job_id);assert.ok(manifest.id);
    assert.equal(existsSync(path.join(project.workspace,'.git')),false);
    assert.equal(readFileSync(path.join(f.prior,'keep.txt'),'utf8'),'existing content');
  }finally{await client.close();await server.close();}
});

test('registry and request identity survive a fresh config load; names reuse existing projects without duplicates',t=>{
  const f=fixture(t);const registry=new ProjectRegistry(f.config);const input={request_key:'one',name:'番茄鐘網站'};
  const first=registry.create(input);assert.match(first.project_id,/^project-/);
  const config=f.reload();const restarted=new ProjectRegistry(config);
  assert.deepEqual(restarted.create(input),first);assert.equal(config.projects.length,2);
  assert.equal(restarted.create({request_key:'two',name:input.name}).status,'existing');
  assert.equal(readdirSync(f.root).length,1);assert.equal(config.projects.length,2);
  assert.throws(()=>restarted.create({request_key:'one',name:'Different'}),/REQUEST_KEY_CONFLICT/);
  assert.equal(readdirSync(f.root).length,1);
  const reserved=registry.create({request_key:'reserved',name:'CON.txt'});assert.equal(path.basename(reserved.workspace),'_CON.txt');
  assert.deepEqual(new ProjectRegistry(f.reload()).create({request_key:'reserved',name:'CON.txt'}),reserved);
  registry.create({request_key:'normalized-first',name:'A?B'});
  assert.throws(()=>registry.create({request_key:'normalized-second',name:'A*B'}),/PROJECT_CONFLICT/);
});

test('Windows names normalize predictably and paths, traversal and absolute input are refused',t=>{
  const f=fixture(t);const registry=new ProjectRegistry(f.config);
  for(const name of ['../escape','..\\escape','D:\\outside','/absolute','\\\\server\\share','x/child','x:ads','x..y','．／escape','',String.fromCharCode(0)])assert.throws(()=>registry.create({request_key:'bad',name}),/INVALID_PROJECT_NAME/);
  assert.equal(projectFolder('  CON.txt  ').folder,'_CON.txt');
  assert.equal(projectFolder('A?B*. ').folder,'A_B_');
  assert.equal(projectFolder('你好 網站').folder,'你好 網站');
  assert.deepEqual(readdirSync(f.root),[]);
  registry.create({request_key:'case',name:'SnakeGame'});
  assert.equal(registry.create({request_key:'case-two',name:'snakegame'}).status,'existing');
  assert.equal(readdirSync(f.root).length,1);
});

test('unregistered folders and junctions cannot be adopted; replaced registered paths cannot dispatch',t=>{
  const f=fixture(t);const registry=new ProjectRegistry(f.config);
  const conflict=path.join(f.root,'Existing');mkdirSync(conflict);writeFileSync(path.join(conflict,'keep.txt'),'keep');
  assert.throws(()=>registry.create({request_key:'conflict',name:'Existing'}),/PROJECT_CONFLICT/);
  assert.equal(readFileSync(path.join(conflict,'keep.txt'),'utf8'),'keep');
  symlinkSync(f.prior,path.join(f.root,'Linked'),'junction');
  assert.throws(()=>registry.create({request_key:'link',name:'Linked'}),/PROJECT_CONFLICT/);
  const created=registry.create({request_key:'replace',name:'Replace'});
  renameSync(created.workspace,`${created.workspace}-old`);symlinkSync(f.prior,created.workspace,'junction');
  assert.throws(()=>registry.validate(created.workspace),/PROJECT_PATH_CHANGED/);
  assert.throws(()=>registry.create({request_key:'replace',name:'Replace'}),/PROJECT_PATH_CHANGED/);
  const linkedConfig={...f.config,projectCreationRoot:path.join(f.dir,'linked-root')};symlinkSync(f.root,linkedConfig.projectCreationRoot,'junction');
  assert.throws(()=>new ProjectRegistry(linkedConfig),/PROJECT_PATH_CHANGED/);
});

test('failed registration rolls back only its own empty folder; nonempty and pre-existing content survive',t=>{
  for(const addContent of [false,true]){
    const f=fixture(t);const registry=new ProjectRegistry(f.config);
    const actualSave=(registry as any).save.bind(registry);let calls=0;
    (registry as any).save=(next:unknown)=>{
      if(++calls===2){
        if(addContent)writeFileSync(path.join(f.root,'Rollback','keep.txt'),'concurrent content');
        // Force the real atomic rename to fail: the destination is now a directory.
        renameSync(path.join(f.runtimeDir,'project-registry.json'),path.join(f.runtimeDir,'saved-intent.json'));
        mkdirSync(path.join(f.runtimeDir,'project-registry.json'));
      }
      return actualSave(next);
    };
    assert.throws(()=>registry.create({request_key:'rollback',name:'Rollback'}),/REGISTRY_WRITE_FAILED/);
    assert.equal(existsSync(path.join(f.root,'Rollback')),addContent);
    assert.equal(f.config.projects.length,1);assert.equal(readFileSync(path.join(f.prior,'keep.txt'),'utf8'),'existing content');
    rmdirSync(path.join(f.runtimeDir,'project-registry.json'));renameSync(path.join(f.runtimeDir,'saved-intent.json'),path.join(f.runtimeDir,'project-registry.json'));
    const recovered=new ProjectRegistry(f.reload());
    if(addContent){assert.equal(readFileSync(path.join(f.root,'Rollback','keep.txt'),'utf8'),'concurrent content');assert.throws(()=>recovered.create({request_key:'rollback',name:'Rollback'}),/PROJECT_CREATION_UNCERTAIN/);assert.throws(()=>recovered.create({request_key:'new-key',name:'Rollback'}),/PROJECT_CREATION_UNCERTAIN/);}
    else assert.equal(recovered.create({request_key:'rollback',name:'Rollback'}).status,'created');
  }
});

test('unversioned source evidence excludes secrets, dependencies and junction contents without Git initialization',t=>{
  const f=fixture(t);const project=new ProjectRegistry(f.config).create({request_key:'snapshot',name:'Snapshot'});
  writeFileSync(path.join(project.workspace,'source.js'),'export const value = 1;');
  writeFileSync(path.join(project.workspace,'.env'),'SECRET_SENTINEL');mkdirSync(path.join(project.workspace,'node_modules'));writeFileSync(path.join(project.workspace,'node_modules','module.js'),'DEPENDENCY_SENTINEL');
  symlinkSync(f.prior,path.join(project.workspace,'outside'),'junction');
  const snapshot=snapshotSource(project.workspace,true);assert.equal(snapshot.head,null);assert.deepEqual(Object.keys(snapshot.files),['source.js']);
  assert.equal(JSON.stringify(snapshot).includes('SENTINEL'),false);assert.equal(JSON.stringify(snapshot).includes('existing content'),false);
  assert.equal(existsSync(path.join(project.workspace,'.git')),false);
});

test('disabled creation and corrupt persisted registry fail closed',t=>{
  const f=fixture(t);assert.throws(()=>new ProjectRegistry({...f.config,projectCreationRoot:undefined}).create({request_key:'disabled',name:'No'}),/PROJECT_CREATION_DISABLED/);
  new ProjectRegistry(f.config).create({request_key:'valid',name:'Valid'});
  const file=path.join(f.runtimeDir,'project-registry.json');const envelope=JSON.parse(readFileSync(file,'utf8'));envelope.state.projects[0].path=f.prior;writeFileSync(file,JSON.stringify(envelope));
  assert.throws(()=>new ProjectRegistry(f.reload()),/REGISTRY_INVALID/);assert.equal(readFileSync(path.join(f.prior,'keep.txt'),'utf8'),'existing content');
});
