import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installed } from './context-native-helper.mjs';
import { deadline, startupHost, testModel as model } from './host-native-helper.mjs';
import { command } from './checks-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

const acceptance=wire=>wire.messages.some(m=>typeof m.content==='string' && m.content.includes('Independently pre-evaluate'));

function stream(res,delta,reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'acceptance-regression',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}

function report(res,id,outputs={artifact:{batch:'B'}}) {
  stream(res,{tool_calls:[{index:0,id,type:'function',function:{name:'loom_report',arguments:JSON.stringify({report:{kind:'result',summary:'报告已生成',outputs}})}}]},'tool_calls');
}

const verdict=()=>JSON.stringify({passed:true,summary:'已核对本次结果',evidence:['artifact.batch=B']});
function unavailable(res) {
  res.writeHead(503,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:'temporary acceptance outage',type:'server_error'}}));
}

async function fixture(respond) {
  const host=await startupHost(respond);
  const directory=join(host.directory,'loom');
  await host.root.plugin(bootstrap,{directory}).await();
  await host.root.plugin(loom,{directory,intervalMs:20}).await();
  const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
  const route=host.ctx.connection.createSharedFetchHandler('/api');
  const rpc=async(endpoint,payload={})=>{
    const res=await route.fetch(new Request(`http://localhost/api/loom/${endpoint}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:`loom/${endpoint}`,payload})}),peer);
    const {result}=await res.json();if(!result.ok) throw Object.assign(new Error(result.error.message),result.error);return result.value;
  };
  const getWork=async id=>(await rpc('query',{kind:'work',workId:id})).items[0];
  const runs=id=>rpc('query',{kind:'run',workId:id});
  const create=async(workspaceId,title,extra={})=>{
    const work=await rpc('command',{type:'work.create',workspaceId,title,model,permissionPreset:'danger-full-access',outputs:[{name:'artifact',required:true}],...extra});
    return rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version,autoAccept:true});
  };
  const settled=async id=>{
    for(let i=0;i<500;i++) {
      const work=await getWork(id),status=await rpc('status');
      if(['review','failed','accepted','paused','cancelled'].includes(work.status) || status.engine.faulted) return {work,status};
      await delay(20);
    }
    assert.fail('work did not settle');
  };
  return {...host,rpc,getWork,runs,create,settled,async close(){await peer.dispose();await host.close();}};
}

test('HTTP 503 retries only pre-acceptance of the same result and leaves normal auto-acceptance live',{skip:!installed,timeout:30000},async()=>{
  let reviews=0,executions=0;
  const host=await fixture((wire,_req,res)=>{
    if(!acceptance(wire)) return report(res,`result-${++executions}`);
    if(++reviews===1) return unavailable(res);
    stream(res,{content:verdict()});
  });
  try {
    const first=await host.create(host.workspace.id,'预验收暂时故障',{checks:[{kind:'command',command,args:['-e',"require('fs').appendFileSync('acceptance-check.txt','once\\n')"]}]});
    const {work,status}=await host.settled(first.id);
    assert.equal(work.status,'review');
    assert.equal(status.engine.faulted,false);
    const [run]=(await host.runs(first.id)).items;
    assert.equal(run.status,'completed');
    assert.equal(run.observation.completion.reason,'completed');
    assert.equal(run.verificationPassed,false);
    assert.match(run.diagnostic,/SERVER/);
    assert.equal(run.review.evidence.code,'SERVER');
    assert.match(run.review.evidence.failure.message,/503|temporary acceptance outage/);
    assert.deepEqual(work.result.review,run.review);
    assert.deepEqual(run.outputs,{artifact:{batch:'B'}});
    assert.equal(work.result.acceptance,null);
    await mkdir(join(host.directory,'other'));
    const other=await host.ctx.workspaceController.create({path:join(host.directory,'other')});
    const second=await host.create(other.workspace.workspaceId,'另一项目');
    assert.equal((await host.settled(second.id)).work.status,'accepted');
    const before=await host.getWork(first.id);
    const request={type:'work.retryAcceptance',workId:first.id,runId:run.id,expectedVersion:before.version,idempotencyKey:randomUUID()};
    await host.rpc('command',request);
    const updated=await host.getWork(first.id);
    assert.equal(updated.status,'review');
    assert.equal(updated.result.acceptance,null);
    assert.equal(updated.result.version,before.result.version);
    assert.equal(updated.result.runId,run.id);
    assert.equal(updated.result.review.passed,true);
    assert.deepEqual(updated.result.checks,before.result.checks);
    assert.deepEqual(updated.result.outputs,before.result.outputs);
    const history=(await host.runs(first.id)).items;
    assert.equal(history.length,1);
    assert.equal(history[0].initialReview.evidence.code,'SERVER');
    assert.equal(history[0].verificationPassed,true);
    assert.equal(await readFile(join(host.directory,'acceptance-check.txt'),'utf8'),'once\n');
    await host.rpc('command',request);
    assert.equal(reviews,3);assert.equal(executions,2);
  }finally{await host.close();}
});

test('the timer dispatches another project after a lost prompt receipt and reconciles the original request',{skip:!installed,timeout:30000},async()=>{
  const host=await fixture((wire,_req,res)=>acceptance(wire)?stream(res,{content:verdict()}):report(res,'worker-result'));
  const controller=host.ctx.sessionController;
  const {prompt,state}=controller;
  let target,failed=false,unavailable=true;
  const attempts=[];
  const disconnected=()=>Object.assign(new Error('temporary native I/O timeout'),{code:'ETIMEDOUT'});
  controller.prompt=async(request,signal)=>{
    target??=request.sessionId;
    if(request.sessionId!==target) return prompt.call(controller,request,signal);
    attempts.push(request.requestId);
    await prompt.call(controller,request,signal);
    failed=true;
    throw disconnected();
  };
  controller.state=async(request,signal)=>{
    if(request.sessionId===target && failed && unavailable) throw disconnected();
    return state.call(controller,request,signal);
  };
  try {
    const first=await host.create(host.workspace.id,'回执中断');
    for(let i=0;i<250 && !failed;i++) await delay(20);
    assert.equal(failed,true);
    await mkdir(join(host.directory,'other'));
    const other=await host.ctx.workspaceController.create({path:join(host.directory,'other')});
    const second=await host.create(other.workspace.workspaceId,'故障之后确认的项目');
    assert.equal((await host.settled(second.id)).work.status,'accepted');
    const [before]=(await host.runs(first.id)).items;
    assert.equal(before.status,'dispatching');
    assert.match(before.diagnostic,/ETIMEDOUT/);
    unavailable=false;
    assert.equal((await host.settled(first.id)).work.status,'accepted');
    const [after]=(await host.runs(first.id)).items;
    assert.deepEqual(attempts,[before.requestId]);
    assert.equal(after.id,before.id);
    assert.equal(after.requestId,before.requestId);
    assert.equal(after.nativeFault,null);
    assert.deepEqual(after.pendingInput,[]);
    assert.equal((await host.rpc('status')).engine.faulted,false);
  } finally {controller.prompt=prompt;controller.state=state;await host.close();}
});

test('unconfirmed native stop preserves the project lock while another project dispatches',{skip:!installed,timeout:30000},async()=>{
  const release=Promise.withResolvers(), entered=Promise.withResolvers();
  const host=await fixture(async(wire,_req,res)=>{
    if(acceptance(wire)) return stream(res,{content:verdict()});
    if(wire.messages.some(message=>typeof message.content==='string' && message.content.includes('需要停止的工作'))) {
      entered.resolve();await release.promise;
    }
    report(res,'stop-result');
  });
  const controller=host.ctx.sessionController,{state}=controller;
  let target,stopFault=false,unavailable=false;
  controller.state=async(request,signal)=>{
    if(request.sessionId===target && unavailable) { stopFault=true;throw Object.assign(new Error('stop readback timed out'),{code:'ETIMEDOUT'}); }
    return state.call(controller,request,signal);
  };
  try {
    const first=await host.create(host.workspace.id,'需要停止的工作');
    await deadline(entered.promise,'worker start');
    const active=await host.getWork(first.id);
    target=active.sessionId;unavailable=true;
    await host.rpc('command',{type:'work.pause',workId:active.id,expectedVersion:active.version});
    for(let i=0;i<250 && !stopFault;i++) await delay(20);
    assert.equal(stopFault,true);
    const same=await host.create(host.workspace.id,'同项目后续工作');
    await mkdir(join(host.directory,'other'));
    const other=await host.ctx.workspaceController.create({path:join(host.directory,'other')});
    const next=await host.create(other.workspace.workspaceId,'其他项目的工作');
    assert.equal((await host.settled(next.id)).work.status,'accepted');
    assert.equal((await host.getWork(active.id)).status,'pause_requested');
    assert.equal((await host.getWork(same.id)).status,'queued');
    assert.equal((await host.runs(first.id)).items[0].nativeFault.code,'ETIMEDOUT');
    release.resolve();unavailable=false;
    assert.equal((await host.settled(first.id)).work.status,'paused');
  } finally {release.resolve();controller.state=state;await host.close();}
});

test('an unexpected native controller error activates global protection',{skip:!installed,timeout:30000},async()=>{
  const host=await fixture(()=>assert.fail('native I/O must fail before model execution'));
  const controller=host.ctx.sessionController,{state}=controller;
  controller.state=async()=>{throw new TypeError('invalid controller invariant');};
  try {
    const work=await host.create(host.workspace.id,'调度保护');
    const {status}=await host.settled(work.id);
    assert.equal(status.engine.faulted,true);
    assert.match(status.engine.error.message,/invalid controller invariant/);
    assert.equal((await host.runs(work.id)).items[0].nativeFault,undefined);
  } finally {controller.state=state;await host.close();}
});

async function holdRetry() {
  let reviews=0;
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const host=await fixture(async(wire,_req,res)=>{
    if(!acceptance(wire)) return report(res,'result');
    if(++reviews===1) return unavailable(res);
    entered.resolve();await release.promise;
    stream(res,{content:verdict()});
  });
  const retry=async()=>{
    const item=await host.create(host.workspace.id,'待复核结果');
    const {work}=await host.settled(item.id);
    assert.equal(work.result.review.source,'acceptance-error');
    const request={type:'work.retryAcceptance',workId:work.id,runId:work.result.runId,expectedVersion:work.version};
    const pending=host.rpc('command',request).then(value=>({value}),error=>({error}));
    await deadline(entered.promise,'预验收模型收到重试');
    return {work,request,pending};
  };
  return {host,retry,release:release.resolve,get reviews(){return reviews;}};
}

test('a missing required output blocks the retry before a model call',{skip:!installed,timeout:30000},async()=>{
  let reviews=0;
  const host=await fixture((wire,_req,res)=>{
    if(!acceptance(wire)) return report(res,'result',{});
    reviews++;unavailable(res);
  });
  try {
    const item=await host.create(host.workspace.id,'缺少必需交付');
    const {work}=await host.settled(item.id);
    assert.equal(work.result.review.source,'acceptance-error');
    const request={type:'work.retryAcceptance',workId:work.id,runId:work.result.runId,expectedVersion:work.version};
    await assert.rejects(host.rpc('command',request),{code:'MISSING_OUTPUT'});
    assert.equal(reviews,1);
    assert.equal((await host.runs(work.id)).total,1);
  }finally{await host.close();}
});

test('overlapping retry commands use one model call',{skip:!installed,timeout:30000},async()=>{
  const f=await holdRetry();
  try {
    const {request,pending}=await f.retry();
    await assert.rejects(f.host.rpc('command',request),{code:'CONFLICT'});
    f.release();
    assert.equal((await pending).value.result.review.passed,true);
    assert.equal(f.reviews,2);
  }finally{f.release();await f.host.close();}
});

test('a late retry opinion cannot change a result already accepted by the user',{skip:!installed,timeout:30000},async()=>{
  const f=await holdRetry();
  try {
    const {work,request,pending}=await f.retry();
    await f.host.rpc('command',{...request,type:'work.accept'});
    f.release();
    assert.equal((await pending).error.code,'CONFLICT');
    const saved=await f.host.getWork(work.id);
    assert.equal(saved.status,'accepted');
    assert.equal(saved.result.review.source,'acceptance-error');
    assert.equal((await f.host.runs(work.id)).items[0].review.source,'acceptance-error');
  }finally{f.release();await f.host.close();}
});
