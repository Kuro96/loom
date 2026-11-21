import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LoomStore } from '../src/core/store.mjs';
import { LoomEngine } from '../src/host/engine.mjs';
import { runChecks } from '../src/host/checks.mjs';
import { nativeOnly, subprocessHost, command, activeCheck, pidFrom } from './checks-native-helper.mjs';

const actor={kind:'user'}, model={provider:'test',model:'worker'};

const review={passed:true,summary:'checked',source:'checks',evidence:['artifact']};

function fixture(t, evaluator=async()=>review) {
  const directory=mkdtempSync(join(process.env.TMPDIR,'loom-engine-'));
  let store=new LoomStore(join(directory,'loom.sqlite'));
  const spaces=['a','b'].map(id=>({id,path:directory,title:id,sessionIds:[]}));
  const hooks=new Map(), sessions=new Map();
  const ctx={workspaceRegistry:{list:()=>spaces,get:id=>spaces.find(w=>w.id===id)},
    on:(name,fn)=>hooks.set(name,fn),logger:{error:error=>{throw error;}}};
  const engine=new LoomEngine(ctx,store,{evaluateWork:evaluator},{intervalMs:10});
  store.syncWorkspaces(engine.native.workspaces());
  engine.native.eventsSince=async(sessionId,cursor)=>{
    const records=sessions.get(sessionId).records.filter(record=>record.event.seq>cursor);
    return {state:{cursor:records.at(-1)?.event.seq??cursor,running:false,pendingInput:[],queue:null},records};
  };
  engine.native.activity=async()=>[];
  engine.native.state=async sessionId=>({cursor:sessions.get(sessionId).session.seq-1,running:false,pendingInput:[],queue:null});
  t.after(async()=>{await engine.dispose();store.close();rmSync(directory,{recursive:true,force:true});});
  function reserve(workspaceId='a',checks=[]) {
    let work=store.command({type:'work.create',workspaceId,title:'engine test',model,checks},actor);
    if(checks.some(check=>check.kind==='command')) work=store.command({type:'work.approveChecks',workId:work.id,expectedVersion:work.version,checksRevision:work.checksRevision},actor);
    work=store.command({type:'work.approveModel',workId:work.id,expectedVersion:work.version,modelRevision:work.modelRevision},actor);
    const run=store.reserveRun(work.id),session=Session.create(SessionId(run.sessionId)),records=[];
    const append=(type,data,options)=>records.push({type:'event',event:session.append(type,data,options)});
    append('turn/start',{turn:0});
    append('turn/end',{turn:0,reason:{kind:'completed'}});
    store.markRunAccepted(run.id,records.at(-1).event.seq);
    sessions.set(run.sessionId,{session,records,append});
    return store.getRun(run.id);
  }
  function complete(run) {
    const {append}=sessions.get(run.sessionId);
    append('turn/start',{turn:1});
    append('user/message',createUserMessage({source:{kind:'user',rpcId:run.requestId},content:[{type:'text',text:run.prompt}]}),{surfaceOp:'append'});
    append('turn/end',{turn:1,reason:{kind:'completed'}});
  }
  return {directory,get store(){return store;},engine,hooks,sessions,reserve,complete,
    reopen(){store.close();store=new LoomStore(join(directory,'loom.sqlite'));engine.store=store;}};
}

test('an agent cannot request a retry of pre-acceptance',async t=>{
  const f=fixture(t,()=>assert.fail('unauthorized model call'));
  const run=f.reserve();
  await assert.rejects(f.engine.command({type:'work.retryAcceptance',workId:run.workId,runId:run.id,expectedVersion:f.store.getWork(run.workId).version},{kind:'agent',sessionId:run.sessionId}),{code:'FORBIDDEN'});
});

function boundary(fn) {
  const reached=Promise.withResolvers(),release=Promise.withResolvers();
  return {reached:reached.promise,release:release.resolve,call:async(...args)=>{reached.resolve();await release.promise;return fn(...args);}};
}

test('pause while preparing prevents a later native prompt',async t=>{
  const f=fixture(t),run=f.reserve();
  const gate=boundary(async()=>({cursor:run.cursor,delivered:false}));
  f.engine.native.prepare=gate.call;
  const before=f.sessions.get(run.sessionId).records.length;
  f.engine.native.prompt=async(sessionId,requestId,text)=>{
    f.sessions.get(sessionId).append('user/message',createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text}]}),{surfaceOp:'append'});
    return {accepted:true};
  };
  const dispatching=f.engine.dispatch(run);
  await gate.reached;
  await f.engine.command({type:'work.pause',workId:run.workId},actor);
  gate.release();await dispatching;
  assert.equal(f.sessions.get(run.sessionId).records.length,before);
});

test('steer remains pending after a rejected receipt and acknowledges admission',async t=>{
  const f=fixture(t),run=f.reserve();
  f.store.command({type:'work.steer',workId:run.workId,expectedVersion:f.store.getWork(run.workId).version,text:'follow up'},actor);
  const [control]=f.store.pendingControls();
  f.engine.native.prompt=async()=>({accepted:false});
  await f.engine.control();
  assert.equal(f.store.pendingControls()[0].id,control.id);
  f.engine.native.prompt=async(sessionId,requestId,text,mode)=>{
    assert.equal(mode,'steer');
    f.sessions.get(sessionId).append('user/message',createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text}]}),{surfaceOp:'append'});
    return {accepted:true};
  };
  await f.engine.control();
  assert.equal(f.store.pendingControls().length,0);
  assert.equal(f.store.query({kind:'control'}).items[0].status,'acknowledged');
  assert.equal(f.store.getRun(run.id).status,'accepted');
});

test('pause aborts a real approved process and leaves scheduling recoverable',nativeOnly,async t=>{
  const f=fixture(t),marker=join(f.directory,'pid');
  f.engine.ctx.subprocess=await subprocessHost(t);
  const run=f.reserve('a',[{kind:'command',command,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},5000)`]}]);
  f.complete(run);
  const observing=f.engine.observe(run);
  for(let i=0;i<500 && !existsSync(marker);i++) await delay(10);
  assert.equal(existsSync(marker),true);
  const pid=Number(readFileSync(marker,'utf8'));
  await f.engine.command({type:'work.pause',workId:run.workId},actor);
  await observing;
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  f.engine.native.stop=async()=>({stopped:true,detail:[]});
  await f.engine.control();await f.engine.tick();
  assert.equal(f.store.getWork(run.workId).status,'paused');
  assert.equal(f.engine.status().faulted,false);
});

test('unconfirmed native cleanup retains the run lock until a fresh cleanup succeeds',nativeOnly,async t=>{
  const f=fixture(t),subprocess=await subprocessHost(t),run=f.reserve();
  const marker=join(f.directory,'cleanup-pid');
  const task=f.engine.runTask(run,signal=>runChecks(f.directory,[activeCheck(marker)],{subprocess,signal,commandConsent:true,cleanupTimeoutMs:0}));
  const rejected=assert.rejects(task,{code:'CHECK_STOP_UNCONFIRMED'});
  const pid=await pidFrom(marker);
  await f.engine.command({type:'work.pause',workId:run.workId},actor);
  await rejected;
  assert.equal(f.engine.verifications.has(run.id),true);
  assert.equal(f.store.getWork(run.workId).status,'pause_requested');
  assert.equal(f.store.readyWork().length,0);
  f.engine.native.stop=async()=>({stopped:true,detail:[]});
  await f.engine.control();
  assert.equal(f.engine.verifications.has(run.id),false);
  assert.equal(f.store.getWork(run.workId).status,'paused');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('completion waits until an active native job clears',async t=>{
  let evaluations=0;
  const f=fixture(t,async()=>{evaluations++;return review;}),run=f.reserve();f.complete(run);
  let busy=true;
  f.engine.native.activity=async()=>busy?[{kind:'job',id:'active-job'}]:[];
  await f.engine.observe(run);
  assert.equal(f.store.getRun(run.id).status,'running');
  assert.equal(evaluations,0);
  assert.equal(f.store.readyWork().length,0);
  busy=false;await f.engine.observe(f.store.getRun(run.id));
  assert.equal(f.store.getRun(run.id).status,'completed');
  assert.equal(evaluations,1);
});
