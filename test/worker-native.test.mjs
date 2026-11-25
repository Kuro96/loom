import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installed, native, nativeHost } from './context-native-helper.mjs';
import {engineHost} from './engine-reuse-helper.mjs';

const selection={provider:'loom-worker-test',model:'scripted'};

const resultReport={kind:'result',summary:'输出已生成',outputs:{artifact:{path:'out.txt',revision:1}}};

const call=(id,report=resultReport,extra={})=>({id,name:'loom_report',arguments:{report,...extra}});

async function workerHost(t) {
  const {createWorkerBinder}=await import('../src/host/worker.mjs');
  const host=await nativeHost();
  const state={run:{id:'run-one',workId:'work-one',sessionId:'worker-one',requestId:'request-one',status:'running',reports:[]},reports:[],results:[],batches:[]};
  const store={
    getWorkForSession:id=>id==='worker-one'?{id:'work-one'}:null,
    getActiveRunForSession:id=>id==='worker-one'?state.run:null,
    reportRun:(id,report,source)=>{assert.equal(id,state.run.id);const value={report,source};state.run.reports.push(value);state.reports.push(value);return value;},
  };
  const binder=createWorkerBinder(store);
  t.after(async()=>{await binder.dispose();await host.close();});
  const {LlmAdapter,createUserMessage}=native('dsh-llm');
  class Adapter extends LlmAdapter {
    async *stream(){
      const batch=state.batches.shift();assert.ok(batch,'unexpected model request');
      for(const [index,item] of batch.entries())yield {type:'tool-call-delta',index,id:item.id,name:item.name,argumentsDelta:JSON.stringify(item.arguments)};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }
  }
  host.ctx.llm.registerAdapter([selection.provider],new Adapter());
  host.ctx.on('agent/created',({agent})=>binder.bindAgent(agent));
  host.ctx.on('tools/result',(exec,result)=>state.results.push({callId:exec.callId,result}));
  const handle=await host.ctx.agents.create({sessionId:'worker-one',meta:{cwd:host.directory},agentOptions:selection});
  const agent=handle.agent;
  return {...host,state,store,binder,agent,async drive(batches,requestId=state.run.requestId){
    state.batches.push(...batches);
    agent.followup(createUserMessage({source:{kind:'user-rpc',rpcId:requestId},content:[{type:'text',text:'提交工作结果'}]}));
    await agent.whenIdle();
  },invoke(args){return host.ctx.tools.execute({agent,calls:[{type:'tool-call',id:'direct-report',name:'loom_report',arguments:JSON.stringify(args)}],signal:AbortSignal.timeout(5000)});}};
}

test('原生worker按当前请求提交具名结果并正常结束，工具仅在所属会话可见', {skip:!installed}, async t=>{
  const host=await workerHost(t);
  const other=await host.ctx.agents.create({sessionId:'ordinary',meta:{cwd:host.directory},agentOptions:selection});
  await host.binder.bindAgent(host.agent);
  const composition=await host.ctx.systemPrompt.assemble({scope:host.agent,agent:host.agent});
  assert.equal(composition.tools.filter(tool=>tool.name==='loom_report').length,1);
  assert.equal(host.ctx.tools.get('loom_report',other.agent),undefined);
  await host.drive([[call('report-one')]]);
  assert.equal(host.state.reports.length,1);
  assert.deepEqual(host.state.reports[0].report,resultReport);
  const events=host.agent.session.snapshotEvents();
  const reportCall=events.find(event=>event.type==='tool/call' && event.data.callId==='report-one');
  assert.deepEqual(host.state.reports[0].source,{sessionId:'worker-one',requestId:'request-one',turn:1,step:reportCall.data.step,callId:'report-one'});
  assert.equal(events.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
  assert.equal(host.agent.status,'idle');
});

test('成功报告阻止同批次后续工具副作用，新执行仍可使用原生工具', {skip:!installed}, async t=>{
  const host=await workerHost(t),path=join(host.directory,'after-report.txt');
  const {defineTool}=native('dsh-tools');
  host.ctx.tools.register(defineTool({name:'write_after_report',description:'Write the local result file',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=>{writeFileSync(path,'written');return 'written';}}));
  const write=id=>({id,name:'write_after_report',arguments:{}});
  await host.drive([[call('terminal-one'),write('tail-one')]]);
  assert.equal(existsSync(path),false);
  assert.equal(host.state.results.find(item=>item.callId==='tail-one').result.isError,true);
  host.state.run={...host.state.run,id:'run-two',requestId:'request-two',reports:[]};
  await host.drive([[write('before-two'),call('terminal-two')]]);
  assert.equal(existsSync(path),true);
  assert.equal(host.state.reports.length,2);
});

test('the worker submits a bilingual report with no declared outputs and publishes it after the native receipt',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun();
  const document={english:'The index contains three entries.',chinese:'索引包含三项。'};
  const deliverables=[{title:'Index',path:'index.md'}];
  writeFileSync(join(f.directory,'index.md'),'one\ntwo\nthree\n');
  const report={kind:'result',summary:'索引已就绪',outputs:{},document,deliverables};
  await f.drive(run,[[call('bilingual',report)]]);
  await f.engine.observe(f.store.getRun(run.id));
  const work=f.store.getWork(run.workId);
  assert.deepEqual(work.result.deliverables,deliverables);
  const [meta]=work.documents;
  assert.deepEqual(f.store.getDocument(work.id,meta.id),{...meta,...document});
  assert.match(run.prompt,/document/);assert.match(run.prompt,/deliverables/);assert.match(run.prompt,/技能/);
});

test('a blocked native report leaves the review diagnostic and publishes neither its document nor its files',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun(),agent=f.handles.get(run.sessionId).agent;
  agent.ctx.on('tools/post-execute',async(exec,_result,next)=>exec.callId==='blocked'
    ? {kind:'block',feedback:[{type:'text',text:'Check the file first.'}]} : next());
  const report={kind:'result',summary:'draft',outputs:{},document:{english:'Draft.',chinese:'草稿。'},deliverables:[{title:'Draft',path:'draft.md'}]};
  await f.drive(run,[[call('blocked',report)],'Needs review.']);await f.engine.observe(f.store.getRun(run.id));
  const work=f.store.getWork(run.workId);
  assert.equal(f.store.getRun(run.id).reports.length,1);assert.equal(work.result.review.passed,false);
  assert.match(work.result.review.summary,/blocked/);assert.deepEqual(work.documents,[]);assert.deepEqual(work.result.deliverables,[]);
});

test('a successful tool in an earlier step cannot validate a later rejected report with the same call id',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun(),agent=f.handles.get(run.sessionId).agent;
  const {defineTool}=native('dsh-tools');
  agent.ctx.tools.register(defineTool({name:'read_version',description:'Read the version',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=> 'V2'}));
  agent.ctx.on('tools/post-execute',(exec,_result,next)=>exec.callId==='call-0' && f.store.getRun(run.id).reports.length
    ? {kind:'block',feedback:[{type:'text',text:'Check the source first.'}]} : next());
  const report={kind:'help',summary:'Version needed',help:{missingInformation:'Which version applies?',attempted:'Read existing version',expectedEvidence:'Release manifest'}};
  await f.drive(run,[[{id:'call-0',name:'read_version',arguments:{}}],[call('call-0',report)],'Check the release manifest.']);
  const results=agent.session.snapshotEvents().filter(event=>event.type==='tool/result' && event.data.message.toolCallId==='call-0');
  assert.deepEqual(results.map(event=>event.data.message.isError),[false,true]);
  assert.notEqual(results[0].data.step,results[1].data.step);
  await f.engine.observe(f.store.getRun(run.id));
  const work=f.store.getWork(run.workId);
  assert.equal(work.wait,null);
  assert.equal(work.status,'review');
  assert.match(work.result.review.summary,/原生工具失败/);
});

test('a new text-only completion with no handoff or bilingual document stays in review',{skip:!installed},async t=>{
  const f=await engineHost(t),run=await f.createRun();
  await f.drive(run,['Three entries matched.']);await f.engine.observe(f.store.getRun(run.id));
  const work=f.store.getWork(run.workId);
  assert.equal(work.status,'review');assert.equal(work.result.review.passed,false);
  assert.match(work.result.review.summary,/双语报告/);assert.equal(work.result.summary,'Three entries matched.');
  assert.deepEqual(work.documents,[]);assert.deepEqual(work.result.deliverables,[]);
});
