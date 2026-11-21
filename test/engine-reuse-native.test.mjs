import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installed, native, engineHost, call } from './engine-reuse-helper.mjs';

const outputs=[{name:'artifact',required:true}];

test('原生不确定回执保存远端引用并暂停本地跟踪',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun();
  const report={kind:'uncertain',summary:'需核对原操作',uncertainty:{operationId:run.workId,remoteRef:'local-operation:unknown',reason:'远端回执缺失'}};
  await f.drive(run,[[call('uncertain-one',report)]]);
  await f.engine.observe(f.store.getRun(run.id));
  assert.equal(f.store.getRun(run.id).status,'uncertain');
  assert.equal(f.store.getWork(run.workId).status,'paused');
  assert.deepEqual(f.store.getWork(run.workId).wait,report.uncertainty);
  assert.equal(f.evaluations.length,0);
  assert.equal(f.store.recoverableRuns().length,0);
});

test('原生策略拒绝报告后正常结束保存回执诊断并等待人工处理',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun();
  const agent=f.handles.get(run.sessionId).agent;
  agent.ctx.on('tools/post-execute',async(exec,_result,next)=>exec.callId==='denied-result'
    ? {kind:'block',feedback:[{type:'text',text:'报告须修正'}]} : next());
  await f.drive(run,[[call('denied-result',{kind:'result',summary:'尚未核实的结果',outputs:{}})],'本轮结束']);
  assert.equal(agent.session.snapshotEvents().findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
  await f.engine.observe(f.store.getRun(run.id));
  const finished=f.store.getRun(run.id);
  assert.equal(f.store.getWork(run.workId).status,'review');
  assert.match(finished.diagnostic,/denied-result.*失败/);
  assert.equal(finished.review.source,'native-report');
  assert.equal(finished.review.passed,false);
  assert.equal(finished.verificationPassed,false);
  assert.equal(f.evaluations.length,0);
});

test('原生历史跨页读取保留请求归属和报告回执',{skip:!installed,timeout:20000},async t=>{
  const f=await engineHost(t),path=join(f.directory,'pages.txt');
  const {defineTool}=native('dsh-tools');let writes=0;
  await f.root.plugin({name:'engine-pages-tool',inject:['tools'],apply(ctx){ctx.tools.register(defineTool({name:'write_page',description:'Update local page count',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=>{writeFileSync(path,String(++writes));return path;}}));}}).await();
  const run=await f.createRun({outputs,checks:[{kind:'file',path:'pages.txt',contains:'205'}]});
  const steps=Array.from({length:205},(_,index)=>[{id:`write-${index}`,name:'write_page',arguments:{}}]);
  steps.push([call('paged-report',{kind:'result',summary:'分页结果',outputs:{artifact:path}})]);
  await f.drive(run,steps);
  let pages=0;const events=f.ctx.sessionController.events;
  f.ctx.sessionController.events=async args=>{pages++;return events(args);};
  await f.engine.observe(f.store.getRun(run.id));
  assert.ok(pages>1);
  assert.equal(f.store.getRun(run.id).reportCallId,'paged-report');
  assert.equal(f.store.getWork(run.workId).status,'accepted');
  assert.equal(f.readArtifact('pages.txt'),'205');
});

test('等待后重开SQLite及原生持久会话沿用操作身份提交新结果',{skip:!installed,timeout:20000},async t=>{
  const f=await engineHost(t),first=await f.createRun({outputs});
  const wait={operationId:first.workId,remoteRef:'operation:resume',condition:'ready',nextCheckAt:new Date(Date.now()+60000).toISOString()};
  await f.drive(first,[[call('wait-before-reload',{kind:'wait',summary:'远端处理中',wait})]]);
  await f.engine.observe(f.store.getRun(first.id));
  assert.equal(f.store.getWork(first.workId).status,'waiting');
  await f.restart();const agent=await f.reloadSession(first.sessionId);
  assert.ok(agent.session.snapshotEvents().some(event=>event.type==='tool/result' && event.data.message.toolCallId==='wait-before-reload'));
  f.store.wakeWaiting(wait.nextCheckAt);
  const next=f.store.reserveRun(first.workId);await f.attach(next);
  assert.equal(next.sessionId,first.sessionId);assert.notEqual(next.requestId,first.requestId);
  assert.equal(next.operationId,wait.operationId);assert.deepEqual(next.wait,wait);
  assert.match(next.prompt,/恢复操作须先核原操作状态/);
  await f.drive(next,[[call('result-after-reload',{kind:'result',summary:'原操作已完成',outputs:{artifact:'restored-output'}})]]);
  await f.engine.observe(f.store.getRun(next.id));
  assert.equal(f.store.getWork(first.workId).status,'accepted');
  assert.equal(f.store.getRun(next.id).reportCallId,'result-after-reload');
  assert.ok(f.store.getRun(next.id).reports[0].source.turn>f.store.getRun(first.id).reports[0].source.turn);
});
