import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';

const root = new URL('../.agents/verification/tmp/', import.meta.url);

mkdirSync(root, {recursive:true});

const user = {kind:'user',sessionId:'ui'};

const agent = {kind:'agent',sessionId:'bus'};

const model = {provider:'local-test',model:'worker',reasoningEffort:'high'};

function fixture(t) {
  const dir = mkdtempSync(new URL('core-',root));
  const f = {dir,file:join(dir,'loom.sqlite')};
  f.db = new LoomStore(f.file);
  f.db.syncWorkspaces([{workspaceId:'a',path:dir,title:'甲'},{workspaceId:'b',path:dir,title:'乙'}]);
  f.reopen = () => {f.db.close(); f.db=new LoomStore(f.file); return f.db;};
  t.after(() => {f.db.close(); rmSync(dir,{recursive:true});});
  return f;
}

function create(db, extra={}) {
  return db.command({type:'work.create',workspaceId:'a',title:'任务',description:'写入结果',...extra},user);
}

function rejects(fn, code) { assert.throws(fn, e => e.code===code); }

test('未知工作区须保存为待澄清意图；输入错误保持数据库原状', t => {
  const f=fixture(t), db=f.db;
  rejects(()=>create(db,{workspaceId:'missing'}),'WORKSPACE_REQUIRED');
  rejects(()=>create(db,{workspaceId:undefined}),'WORKSPACE_REQUIRED');
  rejects(()=>create(db,{title:''}),'INVALID_INPUT');
  rejects(()=>db.command({type:'made.up'},user),'UNKNOWN_COMMAND');
  rejects(()=>create(db,{checks:[{kind:'shell',command:'bad'}]}),'INVALID_INPUT');
  const intent=db.command({type:'intent.create',text:'归属待定的工作'},agent);
  assert.equal(intent.status,'pending');
  assert.equal(intent.workspaceId,null);
  f.reopen();
  assert.equal(f.db.query({kind:'intent'}).items[0].text,'归属待定的工作');
  assert.equal(f.db.query({kind:'work'}).total,0);
});

test('模型提案逐版本取得用户同意；修改模型清除同意', t => {
  const {db}=fixture(t);
  const first=create(db,{model,modelConsent:{kind:'user'}});
  assert.deepEqual(first.model,model);
  assert.equal(first.status,'awaiting_model');
  assert.equal(first.modelConsent,null);
  assert.equal(first.modelRevision,1);
  const approve={type:'work.approveModel',workId:first.id,modelRevision:1,expectedVersion:first.version};
  rejects(()=>db.command(approve,agent),'FORBIDDEN');
  rejects(()=>db.command({...approve,expectedVersion:0},user),'CONFLICT');
  rejects(()=>db.command({...approve,modelRevision:2},user),'CONFLICT');
  rejects(()=>db.command({...approve,expectedVersion:undefined},user),'CONFLICT');
  const approved=db.command(approve,user);
  assert.equal(approved.status,'queued');
  assert.equal(approved.modelConsent.modelRevision,1);
  assert.equal(approved.modelConsent.actor.kind,'user');
  const changed=db.command({type:'work.setModel',workId:first.id,model:{...model,model:'other'},expectedVersion:approved.version},agent);
  assert.equal(changed.modelRevision,2);
  assert.equal(changed.modelConsent,null);
  assert.equal(changed.status,'awaiting_model');
  rejects(()=>db.command({...approve,expectedVersion:changed.version},user),'CONFLICT');
});

test('命令检查授权绑定精确命令和修订；agent提案须用户批准', t => {
  const {db}=fixture(t);
  let work=create(db,{checks:[{kind:'command',command:'node',args:['--version']}]});
  assert.equal(work.checksConsent,null);
  assert.equal(work.checksRevision,1);
  const input={type:'work.approveChecks',workId:work.id,checksRevision:work.checksRevision,expectedVersion:work.version};
  rejects(()=>db.command(input,agent),'FORBIDDEN');
  rejects(()=>db.command({...input,checksRevision:0},user),'CONFLICT');
  work=db.command(input,user);
  assert.deepEqual(work.checksConsent.checks,work.checks);
  assert.equal(work.checksConsent.actor.kind,'user');
  assert.equal(work.checksConsent.checksRevision,work.checksRevision);
  assert.match(work.checksConsent.checksHash,/^[a-f0-9]{64}$/);
  work=db.command({type:'work.setChecks',workId:work.id,checks:[{kind:'command',command:'node',args:['evil.mjs']}]},agent);
  assert.equal(work.checksConsent,null);
  assert.equal(work.checksRevision,2);
  rejects(()=>db.command({...input,expectedVersion:work.version},user),'CONFLICT');
  const file=create(db,{checks:[{kind:'file',path:'result.txt',contains:'done'}]});
  assert.equal(file.checksConsent,null);
  rejects(()=>create(db,{checks:[{kind:'command',command:'node',args:'--version'}]}),'INVALID_INPUT');
});

test('幂等命令与审计同事务保存，重开返回原结果且拒绝键复用', t => {
  const f=fixture(t), input={type:'work.create',workspaceId:'a',title:'唯一任务',idempotencyKey:'once'};
  const first=f.db.command(input,user);
  assert.deepEqual(f.db.command({...input},user),first);
  f.reopen();
  assert.deepEqual(f.db.command({idempotencyKey:'once',title:'唯一任务',workspaceId:'a',type:'work.create'},user),first);
  assert.equal(f.db.query({kind:'work'}).total,1);
  rejects(()=>f.db.command({...input,title:'第二条'},user),'CONFLICT');
  rejects(()=>f.db.command(input,agent),'CONFLICT');
  const events=f.db.query({kind:'event'}).items;
  assert.equal(events.length,1);
  assert.equal(events[0].type,'work.create');
  assert.equal(events[0].actor.kind,'user');
  assert.equal(events[0].workId,first.id);
});

function start(db,workflow,extra={}) {
  const {use}=db.command({type:'workflow.start',workflowId:workflow.id,expectedVersion:workflow.version,model,...extra},user);
  return db.command({type:'use.confirm',useId:use.id,expectedVersion:use.version},user);
}

function authorize(db,work,autoAccept=true) {
  return db.command({type:'work.authorize',workId:work.id,expectedVersion:work.version,autoAccept},user);
}

function approve(db,work) {
  return db.command({type:'work.approveModel',workId:work.id,modelRevision:work.modelRevision,expectedVersion:work.version},user);
}

test('调度按工作区串行并以事务预留稳定投递身份；重开恢复原run', t => {
  const f=fixture(t), db=f.db;
  const first=approve(db,create(db,{model}));
  const next=approve(db,create(db,{model}));
  const other=approve(db,create(db,{workspaceId:'b',model,sessionId:'session-existing'}));
  create(db,{workspaceId:'b',model});
  assert.deepEqual(db.readyWork().map(w=>w.id),[first.id,other.id]);
  const run=db.reserveRun(first.id);
  assert.equal(run.status,'dispatching'); assert.equal(run.cursor,-1);
  assert.match(run.sessionId,/^session-[a-f0-9-]{36}$/);
  assert.ok(run.requestId); assert.deepEqual(run.model,model);
  assert.equal(db.getWork(first.id).sessionId,run.sessionId);
  assert.deepEqual(db.reserveRun(first.id),run);
  rejects(()=>db.reserveRun(next.id),'WORKSPACE_BUSY');
  assert.deepEqual(db.readyWork().map(w=>w.id),[other.id]);
  assert.equal(db.reserveRun(other.id).sessionId,'session-existing');
  f.reopen();
  assert.deepEqual(f.db.getRun(run.id),run);
  assert.deepEqual(f.db.recoverableRuns().map(r=>r.workId),[first.id,other.id]);
  assert.deepEqual(f.db.readyWork(),[]);
  rejects(()=>f.db.command({type:'work.setModel',workId:first.id,model},user),'INVALID_STATE');
});

const verified={passed:true,summary:'产物通过检查',source:'host',evidence:['实际读取产物']};

function complete(db,run,extra={}) {
  return db.finishRun(run.id,{reason:'completed',summary:'完成候选',eventCursor:12,checks:[],review:verified,...extra});
}

test('自动验收须具体工作用户授权和完整通过的验证；命令检查还须精确授权', t => {
  const {db}=fixture(t);
  const plain=approve(db,create(db,{model}));
  const grant={type:'work.authorize',workId:plain.id,autoAccept:true,expectedVersion:plain.version};
  rejects(()=>db.command(grant,agent),'FORBIDDEN');
  const granted=db.command(grant,user);
  assert.equal(granted.authorization.actor.kind,'user');assert.equal(granted.authorization.autoAccept,true);
  complete(db,db.reserveRun(plain.id));
  assert.equal(db.getWork(plain.id).status,'accepted');
  assert.equal(db.getWork(plain.id).result.acceptance.mode,'work');
  const bad=approve(db,create(db,{model,checks:[{kind:'file',path:'missing.txt'}]}));
  authorize(db,bad);
  complete(db,db.reserveRun(bad.id),{checks:[{kind:'file',path:'missing.txt',passed:false}]});
  assert.equal(db.getWork(bad.id).status,'review');
  const omitted=approve(db,create(db,{model,checks:[{kind:'file',path:'out.txt'}]}));
  authorize(db,omitted);
  complete(db,db.reserveRun(omitted.id));
  assert.equal(db.getWork(omitted.id).status,'review');
  const unapproved=approve(db,create(db,{model,checks:[{kind:'command',command:'node',args:['--version']}]}));
  authorize(db,unapproved);
  complete(db,db.reserveRun(unapproved.id),{checks:[{kind:'command',command:'node',args:['--version'],passed:true}]});
  assert.equal(db.getWork(unapproved.id).status,'review');
  const noReview=approve(db,create(db,{model}));
  authorize(db,noReview);
  complete(db,db.reserveRun(noReview.id),{review:null});
  assert.equal(db.getWork(noReview.id).status,'review');
});

test('阶段依赖验收及人工关卡共同控制派发，关卡仅用户可释放', t => {
  const {db}=fixture(t);
  const wf=db.command({type:'workflow.create',workspaceId:'a',title:'阶段流程',stages:[
    {id:'one',title:'准备'},{id:'two',title:'执行',dependsOn:['one'],manualGate:true}
  ]},user);
  const {works}=start(db,wf);
  const [first,second]=works.map(w=>approve(db,w));
  assert.deepEqual(db.readyWork().map(w=>w.id),[first.id]);
  rejects(()=>db.reserveRun(second.id),'NOT_READY');
  const run=db.reserveRun(first.id); complete(db,run);
  assert.deepEqual(db.readyWork(),[]);
  const candidate=db.getWork(first.id);
  db.command({type:'work.accept',workId:first.id,runId:run.id,expectedVersion:candidate.version},user);
  assert.deepEqual(db.readyWork(),[]);
  rejects(()=>db.command({type:'work.releaseGate',workId:second.id,expectedVersion:second.version},agent),'FORBIDDEN');
  const released=db.command({type:'work.releaseGate',workId:second.id,expectedVersion:second.version},user);
  assert.equal(released.gate.release.actor.kind,'user');
  assert.deepEqual(db.readyWork().map(w=>w.id),[second.id]);
});

test('暂停取消通过持久outbox与实际停止回执收口；后台活动保留锁', t => {
  const f=fixture(t), db=f.db;
  const work=approve(db,create(db,{model})), run=db.reserveRun(work.id);
  db.updateRun(run.id,{status:'running'});
  const paused=db.command({type:'work.pause',workId:work.id},user);
  assert.equal(paused.status,'pause_requested');
  assert.equal(db.getRun(run.id).status,'pause_requested');
  const [control]=db.pendingControls();
  assert.equal(control.kind,'pause'); assert.equal(control.sessionId,run.sessionId);
  db.ackControl(control.id,{stopped:false,detail:'后台Job仍运行'});
  assert.equal(db.getWork(work.id).status,'pause_requested');
  rejects(()=>db.command({type:'work.resume',workId:work.id},user),'INVALID_STATE');
  f.reopen();
  assert.equal(f.db.pendingControls()[0].id,control.id);
  assert.equal(f.db.recoverableRuns()[0].id,run.id);
  f.db.ackControl(control.id,{stopped:true});
  assert.equal(f.db.getWork(work.id).status,'paused');
  assert.equal(f.db.pendingControls().length,0);
  assert.equal(f.db.recoverableRuns().length,0);
  f.db.command({type:'work.resume',workId:work.id},user);
  const resumed=f.db.reserveRun(work.id);
  assert.equal(resumed.sessionId,run.sessionId); assert.notEqual(resumed.requestId,run.requestId);
  f.db.command({type:'work.cancel',workId:work.id},agent);
  const [cancel]=f.db.pendingControls();
  f.db.ackControl(cancel.id,{stopped:false});
  assert.equal(f.db.getWork(work.id).status,'cancel_requested');
  f.db.ackControl(cancel.id,{stopped:true});
  assert.equal(f.db.getWork(work.id).status,'cancelled');
  assert.equal(f.db.getRun(resumed.id).status,'cancelled');
  assert.equal(f.db.pendingControls().length,0);
});

test('返工保留session和模型同意，清除旧验收且新run使用新投递ID', t => {
  const {db}=fixture(t), work=approve(db,create(db,{model})), first=db.reserveRun(work.id);
  complete(db,first);
  let current=db.getWork(work.id);
  current=db.command({type:'work.accept',workId:work.id,runId:first.id,expectedVersion:current.version},user);
  const rework=db.command({type:'work.rework',workId:work.id,feedback:'补充失败分支',expectedVersion:current.version},user);
  assert.equal(rework.status,'queued'); assert.equal(rework.result,null);
  assert.equal(rework.sessionId,first.sessionId); assert.deepEqual(rework.modelConsent,work.modelConsent);
  const second=db.reserveRun(work.id);
  assert.notEqual(second.id,first.id); assert.notEqual(second.requestId,first.requestId);
  assert.equal(second.sessionId,first.sessionId); assert.match(second.prompt,/补充失败分支/);
  assert.equal(db.getRun(first.id).status,'completed');
  complete(db,second,{reason:'failed',summary:'执行异常',review:null});
  assert.equal(db.getWork(work.id).status,'failed');
  rejects(()=>db.command({type:'work.accept',workId:work.id,runId:first.id,expectedVersion:db.getWork(work.id).version},user),'INVALID_STATE');
  assert.equal(db.command({type:'work.rework',workId:work.id,feedback:'修复异常'},agent).status,'queued');
});
