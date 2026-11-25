import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { installed, native } from './context-native-helper.mjs';
import { deadline, startupHost, testModel, wireText } from './host-native-helper.mjs';
import { LoomStore } from '../src/core/store.mjs';
import { BusState } from '../src/context/state.mjs';
import { contextConfig } from '../src/context/budget.mjs';

function reply(res,delta,reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'project-fixture',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}
function call(res,id,name,request) {
  return reply(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify({request:JSON.stringify(request)})}}]},'tool_calls');
}
function waitingWork(store,workspaceId,title) {
  const user={kind:'user'};
  const created=store.command({type:'work.create',workspaceId,title,model:testModel},user);
  store.command({type:'work.confirm',workId:created.id,expectedVersion:created.version},user);
  const run=store.reserveRun(created.id);
  store.reportRun(run.id,{kind:'wait',summary:'Pending ledger',wait:{operationId:created.id,remoteRef:'ledger-receipt',condition:'ready',nextCheckAt:new Date(Date.now()+1000).toISOString()}},{sessionId:run.sessionId,requestId:run.requestId,turn:1,callId:'reported'});
  store.settleReport(run.id,{callId:'reported',eventCursor:0,coordinate:true});
  return store.getWork(created.id);
}

function coordinatorOptions(store,bus) {
  return {
    instanceId:bus.value.busId, role:()=>testModel, query:request=>store.query(request), getWork:id=>store.getWork(id),
    searchProjectSessions:()=>assert.fail('Unexpected search'),
    executeDecision:(request,actor,scope)=>{
      const {id,workspaceId,version}=store.getWork(request.workId);
      assert.deepEqual(scope,{workId:id,workspaceId,expectedVersion:version});
      return store.command(request,actor,{coordinatorSessionId:actor.sessionId});
    },
    config:contextConfig,signal:AbortSignal.timeout(20000),
  };
}

test('native project coordination keeps each project’s work results on its own wire', {skip:!installed,timeout:30000}, async()=>{
  const controlEntered=Promise.withResolvers(), releaseControl=Promise.withResolvers();
  const captured=new Map();
  const host=await startupHost(async(wire,_req,res)=>{
    const marker=wire.messages.map(wireText).join('\n');
    if(marker.includes('CONTROL_ONLY_FIXTURE')) {
      controlEntered.resolve();await releaseControl.promise;
      return reply(res,{content:'Control complete.'});
    }
    const trigger=wire.messages.map(wireText).findLast(text=>text.startsWith('[Loom external-wait reminder]'));
    const scope=JSON.parse(trigger.split('\n')[1]);
    const wires=captured.get(scope.workId) ?? [];
    wires.push(wire);captured.set(scope.workId,wires);
    if(wire.messages.at(-1).role!=='tool') return call(res,'project-list','loom_query',{kind:'work'});
    if(wire.messages.at(-1).tool_call_id==='project-list') return call(res,'project-decision','loom_command',{
      type:'work.resolveWait',workId:scope.workId,expectedVersion:scope.expectedVersion,operationId:scope.operationId,
      action:'continue',sources:['Project work list'],information:'Project ledger is ready.',
    });
    return reply(res,{content:'Project coordination complete.'});
  });
  let coordinator;
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  try {
    const {createProjectCoordinator,isProjectCoordinatorSessionId,projectCoordinatorSessionId}=await import('../src/context/project-coordinator.mjs');
    const control=host.workspace;
    const {sessionId:controlId}=await host.ctx.sessionController.create({workspaceId:control.id});
    const controlAgent=host.ctx.agents.get(controlId);
    const bus=new BusState(join(host.directory,'bus'),control.id);
    bus.commitSegment(controlId);
    await host.ctx.sessionController.prompt({sessionId:controlId,requestId:'control-fixture',mode:'queue',content:[{type:'text',text:'CONTROL_ONLY_FIXTURE'}]},AbortSignal.timeout(5000));
    await deadline(controlEntered.promise,'control request in flight');
    const projects=[];
    for(const title of ['ALPHA_PRIVATE_FIXTURE','BETA_PRIVATE_FIXTURE']) {
      const path=join(host.directory,title.toLowerCase());
      await mkdir(path);
      projects.push({title,workspace:await host.ctx.workspaceRegistry.create(path,title)});
    }
    store.syncWorkspaces(host.ctx.workspaceRegistry.list().map(w=>({workspaceId:w.id,path:w.path,title:w.title})));
    for(const project of projects) project.work=waitingWork(store,project.workspace.id,project.title);
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,bus));
    const dispatch=({workspace,work})=>coordinator.dispatch(workspace.id,()=>store.claimExternalWait(work.id,work.version,work.wait.nextCheckAt));
    await deadline(Promise.all(projects.map(dispatch)),'both project turns finished');
    assert.notEqual(controlAgent.status,'idle');
    assert.deepEqual(new BusState(join(host.directory,'bus'),control.id).value,bus.value);
    assert.equal(captured.size,2);
    for(const [{workspace,work,title},other] of [projects,[...projects].reverse()]) {
      const id=projectCoordinatorSessionId(bus.value.busId,workspace.id);
      assert.ok(isProjectCoordinatorSessionId(id));
      assert.ok(workspace.sessionIds.includes(id));
      assert.equal(control.sessionIds.includes(id),false);
      const wires=captured.get(work.id);
      assert.equal(wires.length,3);
      for(const wire of wires) {
        assert.deepEqual(wire.tools.map(item=>item.function.name).sort(),['loom_command','loom_query']);
        assert.equal(JSON.stringify(wire).includes(other.title),false);
        assert.equal(JSON.stringify(wire).includes('CONTROL_ONLY_FIXTURE'),false);
      }
      assert.ok(JSON.stringify(wires[1]).includes(title));
      assert.equal(store.getWork(work.id).wait.handoff.actor.sessionId,id);
      assert.equal(store.getWork(work.id).status,'queued');
    }
  } finally {
    releaseControl.resolve();
    try {if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});

test('reserved native sessions deny ordinary input and inherited native tools before ownership is established', {skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_wire,_req,res)=>reply(res,{content:'Unscheduled call.'}));
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  let coordinator,candidate;
  try {
    const {createProjectCoordinator,projectCoordinatorSessionId}=await import('../src/context/project-coordinator.mjs');
    await host.root.plugin(native('dsh-tool-session-control')).await();
    const bus=new BusState(join(host.directory,'bus'),host.workspace.id);
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,bus));
    host.ctx.on('agent/created',({agent})=>coordinator.bindAgent(agent));
    const sessionId=projectCoordinatorSessionId('another-instance',host.workspace.id);
    candidate=await host.ctx.agents.create({sessionId,meta:{cwd:host.workspace.path},agentOptions:testModel});
    const {sessionId:ordinary}=await host.ctx.sessionController.create({workspaceId:host.workspace.id});
    assert.ok(host.ctx.tools.definitions(host.ctx.agents.get(ordinary)).some(tool=>tool.name==='session_send_message'));
    const blocked=await host.ctx.tools.execute({agent:candidate.agent,calls:[{type:'tool-call',id:'native-fixture',name:'session_send_message',
      arguments:JSON.stringify({session_id:ordinary,message:'UNAUTHORIZED_NATIVE_RELAY'})}],signal:AbortSignal.timeout(5000)});
    assert.equal(blocked.results[0].result.isError,true,JSON.stringify(blocked.results[0]));
    await host.ctx.sessionController.prompt({sessionId,requestId:'unowned-ordinary',mode:'queue',content:[{type:'text',text:'UNAUTHORIZED_ORDINARY_INPUT'}]},AbortSignal.timeout(5000));
    await deadline(candidate.agent.whenIdle(),'reject ordinary native prompt');
    assert.equal(host.received.length,0);
  } finally {
    try {if(candidate) await candidate.dispose();if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});

test('the project’s next coordination prompt carries the previous user answer', {skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_wire,_req,res)=>reply(res,{content:'Consult the version map.'}));
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  let coordinator;
  try {
    const {createProjectCoordinator}=await import('../src/context/project-coordinator.mjs');
    const {workspace}=host,actor={kind:'agent',sessionId:'previous-coordinator'};
    store.syncWorkspaces([{workspaceId:workspace.id,path:workspace.path,title:workspace.title}]);
    const first=waitingWork(store,workspace.id,'Read the manifest');
    const claimed=store.claimExternalWait(first.id,first.version,first.wait.nextCheckAt);
    const asked=store.command({type:'work.resolveWait',workId:first.id,operationId:first.id,expectedVersion:claimed.version,action:'ask',sources:['Release index'],missingInformation:'Which vocabulary?'},actor,{coordinatorSessionId:actor.sessionId});
    store.command({type:'work.resume',workId:first.id,expectedVersion:asked.version,information:'Vocabulary: partner V3'},{kind:'user'});
    const run=store.reserveRun(first.id);
    store.reportRun(run.id,{kind:'help',summary:'Need status map',help:{missingInformation:'Which status applies?',attempted:'Checked release index',expectedEvidence:'Version map'}},
      {sessionId:run.sessionId,requestId:run.requestId,turn:1,step:1,callId:'help'});
    store.settleReport(run.id,{callId:'help',eventCursor:5,coordinate:true});
    const waiting=store.getWork(first.id),bus=new BusState(join(host.directory,'bus'),workspace.id);
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,bus));
    await deadline(coordinator.dispatch(workspace.id,()=>store.claimExternalWait(waiting.id,waiting.version,waiting.wait.nextCheckAt)),'project reads earlier answer');
    assert.equal(host.received.length,1);
    const trigger=host.received[0].messages.map(wireText).find(text=>text.startsWith('[Loom help reminder]'));
    assert.match(trigger,/Vocabulary: partner V3/);
  } finally {
    try {if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});

test('reopening the persisted coordinator keeps its history and discards a queued replay', {skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_wire,_req,res)=>reply(res,{content:'Project history survived.'}));
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  let coordinator;
  try {
    const {createProjectCoordinator,projectCoordinatorSessionId}=await import('../src/context/project-coordinator.mjs');
    const {workspace}=host;
    store.syncWorkspaces([{workspaceId:workspace.id,path:workspace.path,title:workspace.title}]);
    const busDirectory=join(host.directory,'bus');
    const bus=new BusState(busDirectory,workspace.id);
    const id=projectCoordinatorSessionId(bus.value.busId,workspace.id);
    const first=waitingWork(store,workspace.id,'First work');
    const claim=work=>store.claimExternalWait(work.id,work.version,work.wait.nextCheckAt);
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,bus));
    await deadline(coordinator.dispatch(workspace.id,()=>claim(first)),'initial project turn');
    const before=host.ctx.agents.get(id);
    assert.equal(before.session.header.cwd,workspace.path);
    const replay=before.session.snapshotEvents().find(e=>e.type==='agent/inbox/spliced' && e.data.inserted.length===1);
    assert.equal(host.received.length,1);
    await coordinator.dispose();
    assert.equal(host.ctx.agents.get(id),undefined);
    await workspace.detachSession(id);
    assert.equal(workspace.sessionIds.includes(id),false);

    // The origin may survive a restart before membership is committed. An old inbox trigger is still stale.
    const writer=await host.ctx.sessionPersistence.open(id,'write');
    try {
      const {events}=await writer.read(0);
      await writer.append([{...replay,seq:events.at(-1).seq+1,time:Date.now()}]);
    } finally {await writer.close();}
    const savedBus=new BusState(busDirectory,workspace.id);
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,savedBus));
    const second=waitingWork(store,workspace.id,'Second work');
    await deadline(coordinator.dispatch(workspace.id,()=>claim(second)),'reopened project turn');
    assert.equal(host.received.length,2);
    const wire=host.received[1].messages.map(wireText);
    const targeted=wire.filter(text=>text.startsWith('[Loom external-wait reminder]')).map(text=>JSON.parse(text.split('\n')[1]).workId);
    assert.deepEqual(targeted,[first.id,second.id]);
    assert.ok(wire.includes('Project history survived.'));
    const reopened=host.ctx.agents.get(id);
    assert.notEqual(reopened,before);
    assert.ok(reopened.session.snapshotEvents().some(e=>e.type==='agent/inbox/spliced' && e.data.outcome==='canceled' && e.data.removedCount===1));
    assert.deepEqual(workspace.sessionIds,[id]);
    await host.ctx.workspaceRegistry.archiveSession(id,{stopActivity:false});
    await assert.rejects(coordinator.dispatch(workspace.id,()=>assert.fail('Archived agent cannot claim')),
      {code:'LOOM_PROJECT_COORDINATOR_IDENTITY'});
    assert.equal(host.received.length,2);
  } finally {
    try {if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});

test('an in-flight project turn rejects direct calls and drains on disposal', {skip:!installed,timeout:30000},async()=>{
  const entered=Promise.withResolvers(), providerClosed=Promise.withResolvers();
  const host=await startupHost((_wire,_req,res)=>{
    res.once('close',providerClosed.resolve);
    entered.resolve();
  });
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  let coordinator;
  try {
    const {createProjectCoordinator,projectCoordinatorSessionId}=await import('../src/context/project-coordinator.mjs');
    const {workspace}=host;
    store.syncWorkspaces([{workspaceId:workspace.id,path:workspace.path,title:workspace.title}]);
    const bus=new BusState(join(host.directory,'bus'),workspace.id);
    const id=projectCoordinatorSessionId(bus.value.busId,workspace.id);
    const next=waitingWork(store,workspace.id,'Running until disposal');
    coordinator=createProjectCoordinator(host.ctx,coordinatorOptions(store,bus));
    const dispatched=coordinator.dispatch(workspace.id,()=>store.claimExternalWait(next.id,next.version,next.wait.nextCheckAt));
    await deadline(entered.promise,'coordination request entered provider');
    await coordinator.dispatch(workspace.id,()=>assert.fail('Existing project turn owns the dispatch'));
    const agent=host.ctx.agents.get(id),signal=AbortSignal.timeout(5000);
    const toolSet=await host.ctx.tools.resolve({agent,modelSelection:testModel,signal});
    try {
      const request={type:'work.resolveWait',workId:next.id,expectedVersion:store.getWork(next.id).version,operationId:next.id,
        action:'continue',sources:['Forged direct call'],information:'Forged handoff'};
      const forged=await host.ctx.tools.execute({agent,toolSet,signal,calls:[{type:'tool-call',id:'forged-call',name:'loom_command',
        arguments:JSON.stringify({request:JSON.stringify(request)})}]});
      assert.equal(forged.results[0].result.isError,true);
      assert.equal(store.getWork(next.id).status,'waiting');
    } finally {toolSet.dispose();}
    await deadline(coordinator.dispose(),'dispose aborts active coordinator');
    await deadline(dispatched,'dispatch drains');
    await deadline(providerClosed.promise,'provider HTTP request aborted');
    assert.equal(host.ctx.agents.get(id),undefined);
    assert.equal(store.getWork(next.id).status,'waiting');
  } finally {
    try {if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});

test('a cancelled work revokes the active turn’s query and decision scope', {skip:!installed,timeout:30000},async()=>{
  const entered=Promise.withResolvers(), release=Promise.withResolvers();
  const host=await startupHost(async(wire,_req,res)=>{
    const trigger=wire.messages.map(wireText).find(text=>text.startsWith('[Loom external-wait reminder]'));
    const {workId,expectedVersion,operationId}=JSON.parse(trigger.split('\n')[1]);
    entered.resolve();await release.promise;
    const requests=[['loom_query',{kind:'work'}],['loom_command',{type:'work.resolveWait',workId,expectedVersion,operationId,
      action:'continue',information:'Stale handoff',sources:['Stale source']}]];
    reply(res,{tool_calls:requests.map(([name,request],index)=>({index,id:`cancelled-${index}`,type:'function',
      function:{name,arguments:JSON.stringify({request:JSON.stringify(request)})}}))},'tool_calls');
  });
  const store=new LoomStore(join(host.directory,'loom.sqlite'));
  let coordinator;
  try {
    const {createProjectCoordinator,projectCoordinatorSessionId}=await import('../src/context/project-coordinator.mjs');
    const {workspace}=host;
    store.syncWorkspaces([{workspaceId:workspace.id,path:workspace.path,title:workspace.title}]);
    const bus=new BusState(join(host.directory,'bus'),workspace.id);
    const id=projectCoordinatorSessionId(bus.value.busId,workspace.id);
    const work=waitingWork(store,workspace.id,'Revoked coordination');
    const invoked=[];
    const opts=coordinatorOptions(store,bus);
    coordinator=createProjectCoordinator(host.ctx,{...opts,query:request=>{invoked.push('query');return opts.query(request);},
      executeDecision:(...args)=>{invoked.push('decision');return opts.executeDecision(...args);}});
    const dispatched=coordinator.dispatch(workspace.id,()=>store.claimExternalWait(work.id,work.version,work.wait.nextCheckAt));
    await deadline(entered.promise,'coordination request entered provider');
    const active=store.getWork(work.id);
    store.command({type:'work.cancel',workId:active.id,expectedVersion:active.version},{kind:'user'});
    release.resolve();
    await deadline(dispatched,'revoked turn settled');
    const results=host.ctx.agents.get(id).session.snapshotEvents().filter(e=>e.type==='tool/result');
    assert.deepEqual(results.map(e=>[e.data.message.toolCallId,e.data.message.isError]),[['cancelled-0',true],['cancelled-1',true]]);
    assert.deepEqual(invoked,[]);
    assert.equal(host.received.length,1);
    assert.equal(store.getWork(work.id).status,'cancelled');
  } finally {
    release.resolve();
    try {if(coordinator) await coordinator.dispose();}
    finally {store.close();await host.close();}
  }
});
