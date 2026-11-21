import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoomStore } from '../src/core/store.mjs';
import { createContextTools } from '../src/context/tools.mjs';
import { runChecks } from '../src/host/checks.mjs';

const user={kind:'user'},agent={kind:'agent',sessionId:'review-bus'},model={provider:'local',model:'worker'};

function fixture(t) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-core-fixes-')),file=join(dir,'loom.sqlite');
  const f={dir,file,store:new LoomStore(file)};
  f.reopen=()=>{f.store.close();f.store=new LoomStore(file);return f.store;};
  f.command=(request,actor=agent)=>f.store.command(request,actor);
  f.create=extra=>f.command({type:'work.create',workspaceId:'p',title:'Work',model,...extra});
  f.change=(type,w,extra={},actor=user)=>f.command({type,workId:w.id,expectedVersion:f.store.getWork(w.id).version,...extra},actor);
  f.confirm=(w,autoAccept=false)=>f.change('work.confirm',w,{autoAccept});
  f.bus=createContextTools({defineTool:x=>x,query:r=>f.store.query(r),command:f.command,state:{},
    config:()=>({queryMaxBytes:100000,queryLimit:20}),sessionId:agent.sessionId}).find(tool=>tool.name==='loom_command');
  f.store.syncWorkspaces([{workspaceId:'p',path:dir,title:'Project'}]);
  t.after(()=>{
    const db=new DatabaseSync(file,{readOnly:true});
    try {assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}
    finally {db.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
  });
  return f;
}

const source=run=>({sessionId:run.sessionId,requestId:run.requestId,turn:0,callId:'report'});

function finish(f,w,outputs={}) {
  const s=f.store,run=s.reserveRun(w.id);
  s.reportRun(run.id,{kind:'result',summary:'Delivered',outputs},source(run));
  const done=s.finishRun(run.id,{reason:'completed',summary:'Delivered',eventCursor:2,reportCallId:'report'});
  f.change('work.accept',w,{runId:run.id});
  return done;
}

function wait(f,w) {
  const s=f.store,run=s.reserveRun(w.id),nextCheckAt=new Date(Date.now()+60000).toISOString();
  s.reportRun(run.id,{kind:'wait',summary:'Await the remote operation',wait:{operationId:w.id,
    remoteRef:'platform/job-v1',condition:'Operation completed',nextCheckAt}},source(run));
  return s.settleReport(run.id,{callId:'report',eventCursor:2});
}

const reference=w=>({data:{kind:'result',workId:w.id,output:'data',path:[]}});

test('CORE-01: a woken consumer retains its rework impact and user confirmation boundary',async t=>{
  const f=fixture(t);let s=f.store;
  const a=f.confirm(f.create({outputs:[{name:'data',required:true}]}));finish(f,a,{data:'v1'});
  const b=f.confirm(f.create({inputs:reference(a)})),waiting=wait(f,b);
  const initial=s.previewRework(a.id);
  assert.deepEqual(initial.affected.map(w=>w.workId),[b.id]);
  f.confirm(f.create({title:'Not yet consumed',inputs:reference(a)}));
  const independent=f.confirm(f.create({title:'Independent work'})),active=s.reserveRun(independent.id);
  s.wakeWaiting(waiting.wait.nextCheckAt);
  assert.deepEqual(s.readyWork(),[]);
  assert.equal(s.getRun(active.id).status,'dispatching');
  const request={type:'work.rework',workId:a.id,expectedVersion:s.getWork(a.id).version,feedback:'Replace upstream'};
  await assert.rejects(f.bus.execute({request:JSON.stringify(request)}),{code:'FORBIDDEN'});
  const preview=s.previewRework(a.id);
  assert.deepEqual(preview.affected.map(w=>w.workId),[b.id]);
  assert.deepEqual(preview.affected[0].consumedResults,waiting.consumedResults);
  assert.equal(preview.affected[0].status,'queued');
  assert.throws(()=>f.command({...request,impactToken:initial.impactToken,rerunWorkIds:[]},user),{code:'CONFLICT'});
  assert.throws(()=>f.command(request,user),{code:'CONFLICT'});
  f.command({...request,impactToken:preview.impactToken,rerunWorkIds:[]},user);
  s=f.reopen();
  assert.equal(s.getWork(a.id).status,'queued');
  assert.deepEqual(s.getWork(b.id).wait,waiting.wait);
  assert.deepEqual(s.getWork(b.id).inputChanges[0].consumedResults,waiting.consumedResults);
  assert.deepEqual(s.previewRework(a.id).affected.map(w=>w.workId),[b.id]);
});

test('clearing checks revokes previously authorized automatic acceptance',async t=>{
  const f=fixture(t),original=[{kind:'file',path:'required.txt',contains:'approved-result'}];
  const w=f.confirm(f.create({checks:original}),true),first=f.store.reserveRun(w.id);
  f.store.finishRun(first.id,{reason:'completed',summary:'missing artifact',eventCursor:1,checks:await runChecks(f.dir,first.checks)});
  await f.bus.execute({request:JSON.stringify({type:'work.setChecks',workId:w.id,expectedVersion:f.store.getWork(w.id).version,checks:[]})});
  const changed=f.store.getWork(w.id);
  assert.equal(changed.checksConsent,null);
  assert.equal(changed.authorization,null);
});

test('a waiting operation resumes with its original result version after upstream rework',t=>{
  const f=fixture(t);let s=f.store;
  const a=f.confirm(f.create({outputs:[{name:'data',required:true}]})),first=finish(f,a,{data:'v1'});
  const b=f.confirm(f.create({inputs:reference(a),manualGate:true}));
  assert.deepEqual(s.readyWork(),[]);assert.throws(()=>s.reserveRun(b.id),{code:'NOT_READY'});
  f.change('work.releaseGate',b);
  const waiting=wait(f,b),preview=s.previewRework(a.id),released=s.getWork(b.id).gate;
  f.change('work.rework',a,{feedback:'Replace upstream',impactToken:preview.impactToken,rerunWorkIds:[]});
  assert.deepEqual(s.getWork(b.id).wait,waiting.wait);
  assert.throws(()=>s.reserveRun(b.id),{code:'NOT_READY'});
  assert.deepEqual(s.readyWork().map(w=>w.id),[a.id]);
  finish(f,a,{data:'v2'});
  s=f.reopen();s.wakeWaiting(waiting.wait.nextCheckAt);
  assert.deepEqual(s.readyWork().map(w=>w.id),[b.id]);
  const resumed=s.reserveRun(b.id);
  assert.deepEqual(resumed.inputs,waiting.inputs);
  assert.equal(resumed.consumedResults[0].runId,first.id);
  assert.equal(resumed.consumedResults[0].resultVersion,first.resultVersion);
  assert.deepEqual(resumed.consumedResults,waiting.consumedResults);
  assert.deepEqual(resumed.wait,waiting.wait);
  assert.equal(resumed.operationId,waiting.operationId);assert.equal(resumed.sessionId,waiting.sessionId);
  assert.notEqual(resumed.requestId,waiting.requestId);
  assert.deepEqual(s.getWork(b.id).gate,released);
  assert.equal(s.getWork(b.id).inputChanges.length,1);
  assert.ok(resumed.prompt.includes(`本次输入：${JSON.stringify(resumed.inputs)}`));
  assert.ok(resumed.prompt.includes(`消费结果版本：${JSON.stringify(resumed.consumedResults)}`));
  assert.equal(resumed.prompt.includes('恢复操作须先核原操作状态'),true);
  assert.deepEqual(s.getRun(waiting.id),waiting);
});
