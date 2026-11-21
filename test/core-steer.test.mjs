import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoomStore } from '../src/core/store.mjs';

const actor={kind:'user',sessionId:'ui'};

function fixture(t, status='running') {
  const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'loom-steer-'));
  const f={file:join(dir,'loom.sqlite')};
  f.db=new LoomStore(f.file);
  t.after(()=>{f.db.close(); rmSync(dir,{recursive:true});});
  f.reopen=()=>{f.db.close(); f.db=new LoomStore(f.file);};
  f.db.syncWorkspaces([{workspaceId:'a',path:dir,title:'干预验证'}]);
  let work=f.db.command({type:'work.create',workspaceId:'a',title:'任务',model:{provider:'test',model:'worker'}},actor);
  work=f.db.command({type:'work.approveModel',workId:work.id,modelRevision:work.modelRevision,expectedVersion:work.version},actor);
  const run=f.db.reserveRun(work.id);
  if(status==='accepted') f.db.markRunAccepted(run.id,1);
  if(status==='running') f.db.updateRun(run.id,{running:true,cursor:2});
  f.work=f.db.getWork(work.id); f.run=f.db.getRun(run.id);
  f.input={type:'work.steer',workId:work.id,text:'  保留已有结果，优先补齐测试。\n',expectedVersion:f.work.version,idempotencyKey:'steer-once'};
  return f;
}

test('运行中干预持久保存独立投递身份；重开与命令重放复用原control',t=>{
  const f=fixture(t), result=f.db.command(f.input,actor);
  assert.equal(result.status,f.work.status);
  assert.equal(result.version,f.work.version+1);
  assert.deepEqual(f.db.getRun(f.run.id),f.run);
  const [control]=f.db.pendingControls();
  assert.equal(control.kind,'steer');
  assert.equal(control.status,'pending');
  assert.equal(control.text,f.input.text);
  assert.equal(control.runId,f.run.id);
  assert.equal(control.sessionId,f.run.sessionId);
  assert.equal(control.workId,f.work.id);
  assert.equal(control.workspaceId,f.work.workspaceId);
  assert.equal(control.workflowId,f.work.workflowId);
  assert.equal(control.attempts,0);
  assert.deepEqual(control.actor,actor);
  assert.ok(control.requestId);
  assert.notEqual(control.requestId,f.run.requestId);
  assert.deepEqual(f.db.command(f.input,actor),result);
  f.reopen();
  assert.deepEqual(f.db.pendingControls(),[control]);
  assert.deepEqual(f.db.command(f.input,actor),result);
  assert.deepEqual(f.db.getWork(f.work.id),result);
  assert.deepEqual(f.db.getRun(f.run.id),f.run);
  assert.equal(f.db.query({kind:'control'}).total,1);
  const events=f.db.query({kind:'event',workId:f.work.id}).items.filter(e=>e.type==='work.steer');
  assert.equal(events.length,1);
  assert.equal(events[0].detail.version,result.version);
});
