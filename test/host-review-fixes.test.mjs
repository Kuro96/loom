import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installed, native } from './context-native-helper.mjs';
import { deadline, startupHost, testModel as model, wireText } from './host-native-helper.mjs';
import { command } from './checks-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import { LoomStore } from '../src/core/store.mjs';

const acceptance=wire=>wire.messages.some(m=>wireText(m).includes('Independently pre-evaluate'));

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

async function fixture(respond,prepare) {
  const host=await startupHost(respond);
  if(prepare) await prepare(host);
  const directory=join(host.directory,'loom');
  await host.root.plugin(bootstrap,{directory}).await();
  const plugin=await host.root.plugin(loom,{directory,intervalMs:20}).await();
  const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
  const route=host.ctx.connection.createSharedFetchHandler('/api');
  const rpc=async(endpoint,payload={})=>{
    const res=await route.fetch(new Request(`http://localhost/api/loom/${endpoint}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:`loom/${endpoint}`,payload})}),peer);
    const {result}=await res.json();if(!result.ok) throw Object.assign(new Error(result.error.message),result.error);return result.value;
  };
  const getWork=async id=>(await rpc('query',{kind:'work',workId:id})).items[0];
  const runs=id=>rpc('query',{kind:'run',workId:id});
  const create=async(workspaceId,title,extra={},autoAccept=true)=>{
    const work=await rpc('command',{type:'work.create',workspaceId,title,model,permissionPreset:'danger-full-access',outputs:[{name:'artifact',required:true}],...extra});
    return rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version,autoAccept});
  };
  const settled=async id=>{
    for(let i=0;i<500;i++) {
      const work=await getWork(id),status=await rpc('status');
      if(['review','failed','accepted','paused','cancelled'].includes(work.status) || status.engine.faulted) return {work,status};
      await delay(20);
    }
    assert.fail('work did not settle');
  };
  return {...host,loomDirectory:directory,plugin,rpc,getWork,runs,create,settled,async close(){await peer.dispose();await host.close();}};
}

async function nativeJobFixture({question=false}={}) {
  let started=false, jobs;
  const host=await fixture((wire,_req,res)=>{
    if(acceptance(wire)) return stream(res,{content:verdict()});
    if(started) {
      if(!question) return report(res,'native-job-worker-report');
      const args={questions:[{id:'batch',question:'Which batch is approved for review?'}]};
      return stream(res,{tool_calls:[{index:0,id:'pending-native-question',type:'function',function:{name:'ask_user_question',arguments:JSON.stringify(args)}}]},'tool_calls');
    }
    started=true;
    const args={description:'Wait for the test release file',command:"while (-not (Test-Path -LiteralPath 'release-job')) { Start-Sleep -Milliseconds 30 }; Write-Output 'released'",run_in_background:true};
    stream(res,{tool_calls:[{index:0,id:'owned-pwsh',type:'function',function:{name:'pwsh',arguments:JSON.stringify(args)}}]},'tool_calls');
  },async host=>{
    const plugins=['dsh-shell-env','dsh-working-directory','dsh-jobs-local','dsh-tool-jobs','dsh-tool-pwsh'];
    if(question) plugins.push('dsh-api-remotes','dsh-user-questions','dsh-tool-ask-user');
    for(const name of plugins) {
      const mod=native(name);await deadline(host.root.plugin(mod.default??mod).await(),`load ${name}`);
    }
    await host.root.plugin({name:'job-test-reader',inject:['jobs'],apply(ctx){jobs=ctx.jobs;}}).await();
  });
  return {...host,jobs,release:()=>writeFile(join(host.workspace.path,'release-job'),'release')};
}

async function observedRun(host,workId,ready) {
  for(let i=0;i<250;i++) {
    const [run]=(await host.runs(workId)).items;
    if(run && ready(run)) return run;
    await delay(20);
  }
  assert.fail('expected Run observation did not arrive');
}

async function idleWithJob(host,workId) {
  for(let i=0;i<250;i++) {
    const [run]=(await host.runs(workId)).items;
    if(run?.observation?.completion && run.status==='running') {
      const state=await host.ctx.sessionController.state({sessionId:run.sessionId},AbortSignal.timeout(5000));
      const activity=await host.ctx.waterfall('workspace/session-activity',{sessionId:run.sessionId},async()=>[]);
      if(!state.running && activity.some(a=>a.kind==='job')) return run;
    }
    await delay(20);
  }
  const [run]=(await host.runs(workId)).items;
  const events=host.ctx.agents.get(run.sessionId).session.snapshotEvents().filter(({type})=>type.startsWith('job/') || type==='tool/result');
  assert.fail(`Loom did not observe the idle session's active job: ${JSON.stringify({status:run.status,diagnostic:run.diagnostic,events})}`);
}

test('an idle Loom-owned native turn records one terminal job receipt on its original Run',{skip:!installed,timeout:30000},async()=>{
  const host=await nativeJobFixture();
  try {
    const work=await host.create(host.workspace.id,'原生后台作业',{},false);
    const run=await idleWithJob(host,work.id);
    assert.equal((await host.getWork(work.id)).status,'running');
    assert.equal((await host.getWork(work.id)).result,null);
    const agent=host.ctx.agents.get(run.sessionId);
    const log=()=>agent.session.snapshotEvents();
    const registered=log().find(e=>e.type==='job/registered');
    const call=log().find(e=>e.type==='tool/call' && e.data.callId==='owned-pwsh');
    assert.deepEqual(registered.data.toolCall,{callId:'owned-pwsh',rootCallId:'owned-pwsh'});
    assert.equal(registered.data.owner,run.sessionId);
    assert.equal(call.data.turn,run.observation.ownedTurn);
    assert.ok(call.seq<registered.seq && registered.seq<run.observation.completion.endSeq);

    await host.release();
    assert.equal((await host.jobs.wait(registered.data.jobId,5000,run.sessionId)).status,'completed');
    assert.equal((await host.settled(work.id)).work.status,'review');
    const settled=log().find(e=>e.type==='job/settled');
    const expected=[{owner:run.sessionId,jobId:registered.data.jobId,registrationSeq:registered.seq,settlementSeq:settled.seq,status:settled.data.status,
      turn:call.data.turn,step:call.data.step,callId:call.data.callId,callSeq:call.seq}];
    const {items,total}=await host.runs(work.id);
    assert.equal(total,1);
    assert.equal(items[0].id,run.id);
    assert.deepEqual(items[0].observation.jobReceipts,expected);
    await host.plugin.dispose();
    const reopened=new LoomStore(join(host.loomDirectory,'loom.sqlite'));
    try{assert.deepEqual(reopened.getRun(run.id).observation.jobReceipts,expected);}
    finally{reopened.close();}
  }finally{await host.release();await host.close();}
});

test('an idle snapshot beyond the first event cut catches up to the native job settlement',{skip:!installed,timeout:30000},async()=>{
  const host=await nativeJobFixture(),controller=host.ctx.sessionController;
  const {events}=controller;
  try {
    const work=await host.create(host.workspace.id,'后台作业在观察中结算',{},false);
    const run=await idleWithJob(host,work.id);
    const agent=host.ctx.agents.get(run.sessionId);
    const registered=agent.session.snapshotEvents().find(e=>e.type==='job/registered');
    const cuts=[];
    let settlement;
    controller.events=async(request,signal)=>{
      const page=await events.call(controller,request,signal);
      if(request.address.sessionId!==run.sessionId) return page;
      cuts.push({cursor:request.throughSeq,maxMessages:request.maxMessages});
      if(cuts.length===1) {
        await host.release();
        const nativeJob=await host.jobs.wait(registered.data.jobId,5000,run.sessionId);
        assert.equal(nativeJob.status,'completed');
        settlement=agent.session.snapshotEvents().find(e=>e.type==='job/settled');
        assert.ok(page.cursor<settlement.seq);
      }
      return page;
    };
    assert.equal((await host.settled(work.id)).work.status,'review');
    const [after]=(await host.runs(work.id)).items;
    assert.equal(after.id,run.id);
    assert.deepEqual(after.observation.jobReceipts.map(({jobId,settlementSeq})=>({jobId,settlementSeq})),[{jobId:registered.data.jobId,settlementSeq:settlement.seq}]);
    assert.ok(cuts.slice(1).some(({cursor})=>cursor>=settlement.seq));
    assert.ok(cuts.every(({maxMessages})=>maxMessages===200));
  }finally{controller.events=events;await host.release();await host.close();}
});

test('a registered job without live activity or a terminal receipt blocks pre-acceptance',{skip:!installed,timeout:30000},async()=>{
  const host=await nativeJobFixture();
  let restoreActivity;
  try {
    const work=await host.create(host.workspace.id,'后台作业结果待核对');
    const run=await idleWithJob(host,work.id);
    const agent=host.ctx.agents.get(run.sessionId);
    const registration=agent.session.snapshotEvents().find(event=>event.type==='job/registered');
    assert.equal(run.observation.pendingJobs[0].jobId,registration.data.jobId);
    assert.equal(agent.session.snapshotEvents().some(event=>event.type==='job/settled'),false);

    // Preserve the durable registration and emulate the absence of the in-process Job registry after restart.
    restoreActivity=host.ctx.on('workspace/session-activity',({sessionId},next)=>sessionId===run.sessionId?Promise.resolve([]):next(),{prepend:true});
    const after=await host.settled(work.id);
    assert.equal(after.status.engine.faulted,false);
    assert.equal(after.work.status,'failed');
    assert.equal(after.work.result.acceptance,null);
    const {items,total}=await host.runs(work.id);
    assert.equal(total,1);
    const [saved]=items;
    assert.equal(saved.id,run.id);
    assert.equal(saved.reason,'native-job-outcome-unknown');
    assert.match(saved.diagnostic,/结果待核对/);
    assert.deepEqual(saved.observation.jobReceipts,[]);
    assert.deepEqual(saved.review.evidence,run.observation.pendingJobs);
    assert.equal(host.received.filter(acceptance).length,0);
    await host.plugin.dispose();
    const reopened=new LoomStore(join(host.loomDirectory,'loom.sqlite'));
    try {assert.deepEqual(reopened.getRun(run.id).review,saved.review);}
    finally {reopened.close();}
  } finally {if(restoreActivity) restoreActivity();await host.release();await host.close();}
});

test('native job settlement leaves an unanswered native question on the running work',{skip:!installed,timeout:30000},async()=>{
  const host=await nativeJobFixture({question:true});
  try {
    const work=await host.create(host.workspace.id,'作业结算时等待原生问题',{},false);
    const run=await observedRun(host,work.id,r=>r.pendingInput?.includes('question'));
    const agent=host.ctx.agents.get(run.sessionId);
    const registered=agent.session.snapshotEvents().find(e=>e.type==='job/registered');
    await host.release();
    assert.equal((await host.jobs.wait(registered.data.jobId,5000,run.sessionId)).status,'completed');
    const after=await observedRun(host,work.id,r=>r.observation.jobReceipts?.length===1);
    assert.equal(after.id,run.id);
    assert.equal(after.status,'running');
    assert.deepEqual(after.pendingInput,['question']);
    assert.equal(after.observation.completion,null);
    assert.equal((await host.getWork(work.id)).result,null);
    assert.deepEqual((await host.ctx.sessionController.state({sessionId:run.sessionId},AbortSignal.timeout(5000))).pendingInput,['question']);
  }finally{await host.release();await host.close();}
});

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
    if(wire.messages.some(message=>wireText(message).includes('需要停止的工作'))) {
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
