import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';

const user={kind:'user',sessionId:'gate-ui'};

const model={provider:'local-test',model:'worker',reasoningEffort:'high'};

function fixture(t) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-worker-gate-'));
  const f={dir,file:join(dir,'loom.sqlite')};
  f.db=new LoomStore(f.file);
  f.db.syncWorkspaces([{workspaceId:'workspace',path:dir,title:'关卡上下文'}]);
  f.reopen=()=>{f.db.close(); f.db=new LoomStore(f.file);};
  t.after(()=>{f.db.close(); rmSync(dir,{recursive:true});});
  return f;
}

function approve(db,work) {
  return db.command({type:'work.approveModel',workId:work.id,expectedVersion:work.version,modelRevision:work.modelRevision},user);
}

function finish(db,run) {
  db.finishRun(run.id,{reason:'completed',summary:'完成',eventCursor:1});
}

function accept(db,run) {
  return db.command({type:'work.accept',workId:run.workId,runId:run.id,expectedVersion:db.getWork(run.workId).version},user);
}

function snapshot(prompt,label) {
  const line=prompt.split('\n').find(line=>line.startsWith(label));
  assert.ok(line,`prompt缺少${label}`);
  return JSON.parse(line.slice(label.length));
}

test('worker收到已核实的依赖及用户放行快照，重试和重开保持本次Run上下文',t=>{
  const f=fixture(t), db=f.db;
  db.command({type:'settings.update',permissionPreset:'danger-full-access'},user);
  db.command({type:'workspace.setKnowledge',workspaceId:'workspace',knowledge:'项目共享知识'},user);
  const workflow=db.command({type:'workflow.create',workspaceId:'workspace',title:'A到B',description:'读取A后创建B',stages:[{id:'a',title:'A'},{id:'b',title:'B',dependsOn:['a']}]},user);
  db.command({type:'workflow.setKnowledge',workflowId:workflow.id,knowledge:'流程共享知识'},user);
  const a=approve(db,db.command({type:'work.create',workspaceId:'workspace',workflowId:workflow.id,title:'A',model},user));
  let b=db.command({type:'work.create',workspaceId:'workspace',workflowId:workflow.id,title:'依赖A且需人工关卡',
    description:'读取A.txt并创建B.txt',scope:'当前工作区的B.txt',model,dependsOn:[a.id],manualGate:true,
    checks:[{kind:'command',command:'node',args:['--version']}]},user);
  b=db.command({type:'work.approveChecks',workId:b.id,expectedVersion:b.version,checksRevision:b.checksRevision},user);
  b=approve(db,b);
  assert.throws(()=>db.reserveRun(b.id),{code:'NOT_READY'});
  const arun=db.reserveRun(a.id);
  finish(db,arun);
  accept(db,arun);
  assert.throws(()=>db.reserveRun(b.id),{code:'NOT_READY'});
  assert.deepEqual(db.readyWork(),[]);
  assert.throws(()=>db.command({type:'work.releaseGate',workId:b.id,expectedVersion:b.version},{kind:'agent'}),{code:'FORBIDDEN'});
  b=db.command({type:'work.releaseGate',workId:b.id,expectedVersion:b.version},user);
  const releasedGate=structuredClone(b.gate);
  // 返回值的修改不应进入持久化的派发快照。
  b.gate.release.actor.sessionId='caller-only';
  f.reopen();
  const run=f.db.reserveRun(b.id);
  assert.match(run.prompt,/Loom调度器已核实/);
  assert.deepEqual(snapshot(run.prompt,'依赖快照：'),[{id:a.id,status:'accepted'}]);
  assert.deepEqual(snapshot(run.prompt,'人工关卡快照：'),releasedGate);
  assert.match(run.prompt,/已释放的人工关卡.*无需再次询问/);
  assert.match(run.prompt,/新的需求.*澄清/);
  assert.match(run.prompt,/本次运行.*持久快照/);
  for(const text of ['任务：依赖A且需人工关卡','要求：读取A.txt并创建B.txt','范围：当前工作区的B.txt',
    `工作区：${f.dir}`,'工作区共享知识：项目共享知识','流程：读取A后创建B','流程共享知识：流程共享知识',
    `检查定义：${JSON.stringify(b.checks)}`]) assert.ok(run.prompt.includes(text),text);
  assert.equal(run.workId,b.id);
  assert.equal(run.workspaceId,'workspace');
  assert.equal(run.workflowId,workflow.id);
  assert.deepEqual(run.model,model);
  assert.equal(run.modelRevision,b.modelRevision);
  assert.deepEqual(run.modelConsent,b.modelConsent);
  assert.equal(run.workVersion,f.db.getWork(b.id).version);
  assert.equal(run.permissionPreset,'danger-full-access');
  assert.deepEqual(run.checks,b.checks);
  assert.equal(run.checksRevision,b.checksRevision);
  assert.deepEqual(run.checksConsent,b.checksConsent);

  f.db.command({type:'work.rework',workId:a.id,feedback:'依赖后续修订'},user);
  f.db.command({type:'settings.update',permissionPreset:'read-only'},user);
  f.db.command({type:'workspace.setKnowledge',workspaceId:'workspace',knowledge:'后续知识'},user);
  f.db.command({type:'work.releaseGate',workId:b.id,expectedVersion:f.db.getWork(b.id).version},
    {kind:'user',sessionId:'later-ui'});
  f.reopen();
  assert.deepEqual(f.db.getRun(run.id),run);
  assert.deepEqual(f.db.reserveRun(b.id),run);
  assert.equal(f.db.query({kind:'run',workId:b.id}).total,1);
  finish(f.db,run);
  f.db.command({type:'work.rework',workId:b.id,feedback:'补充B的新要求'},user);
  assert.throws(()=>f.db.reserveRun(b.id),{code:'NOT_READY'});
  const anew=f.db.reserveRun(a.id);
  finish(f.db,anew);
  accept(f.db,anew);
  const next=f.db.reserveRun(b.id);
  assert.notEqual(next.requestId,run.requestId);
  assert.equal(next.sessionId,run.sessionId);
  assert.equal(next.permissionPreset,'danger-full-access');
  assert.match(next.prompt,/当前反馈：补充B的新要求/);
  assert.match(next.prompt,/工作区共享知识：后续知识/);
  assert.deepEqual(snapshot(next.prompt,'人工关卡快照：'),f.db.getWork(b.id).gate);
  assert.deepEqual(f.db.getRun(run.id).prompt,run.prompt);
});
