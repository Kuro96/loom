import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LoomStore } from '../src/core/store.mjs';

const root=new URL('../.agents/verification/tmp/',import.meta.url);

mkdirSync(root,{recursive:true});

const moduleURL=new URL('../src/core/store.mjs',import.meta.url).href;

const actor={kind:'user'}, model={provider:'local-test',model:'worker'};

function temporary(t) {
  const dir=mkdtempSync(new URL('durable-',root)), file=join(dir,'loom.sqlite');
  t.after(()=>rmSync(dir,{recursive:true}));
  return {dir,file};
}

function child(code,args) {
  const process_=spawn(process.execPath,['--input-type=module','-e',code,...args],{stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    process_.stdout.on('data',chunk=>stdout+=chunk);
    process_.stderr.on('data',chunk=>stderr+=chunk);
    process_.once('error',reject);
    process_.once('close',code=>resolve({code,stdout,stderr}));
  });
}

function prepare(file,dir) {
  const db=new LoomStore(file);
  db.syncWorkspaces([{workspaceId:'a',path:dir,title:'恢复验证'}]);
  let work=db.command({type:'work.create',workspaceId:'a',title:'持久派发',model},actor);
  work=db.command({type:'work.approveModel',workId:work.id,expectedVersion:work.version,modelRevision:work.modelRevision},actor);
  db.close(); return work;
}

test('预留提交后进程直接退出，WAL恢复保留run、请求身份及控制outbox',async t=>{
  const {dir,file}=temporary(t), work=prepare(file,dir);
  const code=`import { LoomStore } from ${JSON.stringify(moduleURL)};
    const db=new LoomStore(process.argv[1]);
    const run=db.reserveRun(process.argv[2]);
    db.markRunAccepted(run.id,41);
    db.command({type:'work.pause',workId:run.workId},{kind:'user'});
    process.stdout.write(JSON.stringify(run),()=>process.exit(23));`;
  const result=await child(code,[file,work.id]);
  assert.equal(result.code,23,result.stderr); assert.equal(result.stderr,'');
  const original=JSON.parse(result.stdout), db=new LoomStore(file);
  try {
    const [run]=db.recoverableRuns();
    assert.equal(run.id,original.id); assert.equal(run.requestId,original.requestId);
    assert.equal(run.cursor,41); assert.equal(run.status,'pause_requested');
    assert.equal(db.pendingControls()[0].runId,run.id);
    assert.equal(db.getWork(work.id).sessionId,original.sessionId);
  } finally {db.close();}
  const sql=new DatabaseSync(file);
  try {assert.equal(sql.prepare('PRAGMA integrity_check').get().integrity_check,'ok');} finally {sql.close();}
});

test('unchanged workspace sync preserves SQLite data_version and project history', t=>{
  const {dir,file}=temporary(t),store=new LoomStore(file), observer=new DatabaseSync(file);
  try {
    const dataVersion=()=>observer.prepare('PRAGMA data_version').get().data_version;
    const entry={workspaceId:'a',path:dir,title:'原项目'};
    const item=()=>store.query({kind:'workspace',workspaceId:'a'}).items[0];
    store.syncWorkspaces([entry]);
    const known=store.command({type:'workspace.setKnowledge',workspaceId:'a',knowledge:'团队知识'},actor);
    const before=dataVersion();
    for(let n=0;n<5;n++) store.syncWorkspaces([entry]);
    assert.equal(dataVersion(),before);assert.deepEqual(item(),known);
    const renamed={...entry,title:'改名后的项目',path:join(dir,'moved')};
    store.syncWorkspaces([renamed]);
    assert.notEqual(dataVersion(),before);assert.equal(item().title,renamed.title);assert.equal(item().path,renamed.path);
    assert.equal(item().knowledge,known.knowledge);assert.equal(item().id,known.id);
    store.syncWorkspaces([]);assert.equal(item().active,false);
    const absent=dataVersion();store.syncWorkspaces([]);assert.equal(dataVersion(),absent);
    store.syncWorkspaces([renamed]);assert.equal(item().active,true);assert.equal(item().knowledge,known.knowledge);
  } finally { observer.close();store.close(); }
});

test('两个独立进程重放使用提案及确认，保持一份使用和一组工作',async t=>{
  const {dir,file}=temporary(t),db=new LoomStore(file);
  db.syncWorkspaces([{workspaceId:'a',path:dir,title:'并发确认'}]);
  const workflow=db.command({type:'workflow.create',workspaceId:'a',title:'Two steps',stages:[{id:'one',title:'One'},{id:'two',title:'Two',dependsOn:['one']}]},actor);
  db.close();
  const code=`import {LoomStore} from ${JSON.stringify(moduleURL)};
    const store=new LoomStore(process.argv[1]);console.log(JSON.stringify(store.command(JSON.parse(process.argv[2]),{kind:'user'})));store.close();`;
  const request={type:'workflow.start',workflowId:workflow.id,expectedVersion:workflow.version,model,idempotencyKey:'concurrent-proposal'};
  const proposed=await Promise.all([child(code,[file,JSON.stringify(request)]),child(code,[file,JSON.stringify(request)])]);
  for(const r of proposed) assert.equal(r.code,0,r.stderr);
  const [a,b]=proposed.map(r=>JSON.parse(r.stdout));assert.deepEqual(a,b);
  const confirmation={type:'use.confirm',useId:a.use.id,expectedVersion:a.use.version};
  const confirmations=await Promise.all([child(code,[file,JSON.stringify(confirmation)]),child(code,[file,JSON.stringify(confirmation)])]);
  for(const r of confirmations) assert.equal(r.code,0,r.stderr);
  assert.deepEqual(JSON.parse(confirmations[0].stdout),JSON.parse(confirmations[1].stdout));
  const final=new LoomStore(file);
  try {assert.equal(final.query({kind:'use'}).total,1);assert.equal(final.query({kind:'work'}).total,2);assert.equal(final.getWorkflow(workflow.id).version,workflow.version);}
  finally {final.close();}
});
