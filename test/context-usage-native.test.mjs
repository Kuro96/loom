import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import fs,{mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import {installed,native} from './context-native-helper.mjs';
import {startupHost,testModel,deadline} from './host-native-helper.mjs';
import {createLoomContext} from '../src/context/index.mjs';
import {BusState} from '../src/context/state.mjs';

function reply(res,{text='OK',usage}={}) {
  const chunk=(choices,extra={})=>`data: ${JSON.stringify({id:'usage-probe',created:1730000000,object:'chat.completion.chunk',model:testModel.model,choices,...extra})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta:{content:text},finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:'stop'}])+(usage?chunk([],{usage}):'')+'data: [DONE]\n\n');
}

async function send(agent,text) {
  agent.followup(native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));
  await deadline(agent.whenIdle(),text.slice(0,20));
}

test('native tools, custom pi-ai cache tokens and in-turn review survive reopening with request capture off',{skip:!installed,timeout:30000},async()=>{
  const review=JSON.stringify({summary:'Use project B.',constraints:[],unresolved:[],references:[]});
  let mainCalls=0;
  const host=await startupHost((body,_req,res)=>{
    const auxiliary=!body.tools;
    const tool=!auxiliary && ++mainCalls===1;
    const delta=tool?{tool_calls:[{index:0,id:'usage-tool',type:'function',function:{name:'loom_query',arguments:'{"request":"{\\"kind\\":\\"work\\"}"}'}}]}:{content:auxiliary?review:'OK'};
    const usage=auxiliary?{prompt_tokens:22,completion_tokens:4,total_tokens:26}:{prompt_tokens:20,completion_tokens:2,total_tokens:22,prompt_tokens_details:{cached_tokens:7}};
    const chunk=(choices,extra={})=>`data: ${JSON.stringify({id:'usage-probe',created:1730000000,object:'chat.completion.chunk',model:testModel.model,choices,...extra})}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}])+chunk([],{usage})+'data: [DONE]\n\n');
  });
  const directory=join(host.directory,'loom'),context={reviewEverySteps:3,debug:false};
  const open=()=>createLoomContext(host.ctx,{directory,workspaceId:host.workspace.id,getSettings:()=>({roleModels:{bus:testModel},context}),query:()=>({items:[]})});
  let manager;
  try {
    manager=await open();const first=await manager.ensureBus();
    await send(host.ctx.agents.get(first.sessionId),'Original user input. '.repeat(50));
    await send(host.ctx.agents.get(first.sessionId),'Continue');
    assert.equal(host.received.length,4);
    const before=manager.getUsage({}).items;
    assert.deepEqual(before.map(r=>[r.segment,r.turn,r.status,r.main.calls,r.main.input,r.main.hit,r.main.miss,r.main.output,r.main.peak,r.review.calls,r.review.input,r.combined.input]),[
      [1,2,'completed',1,20,7,13,2,20,1,22,42],[1,1,'completed',2,40,14,26,4,20,0,null,40],
    ]);
    assert.deepEqual(manager.getUsage({key:before[0].key}).calls.map(c=>[c.purpose,c.step,c.usage.inputTokens,c.usageSource]),[
      ['compaction',1,22,'adapter-reported'],['conversation',1,13,'adapter-reported'],
    ]);
    assert.equal(existsSync(join(directory,'debug')),false);
    context.segmentMaxEvents=1;context.checkpointMaxBytes=128;
    const segment2=await manager.ensureBus();
    assert.equal(segment2.segment,2);assert.equal(host.received.length,5);
    context.segmentMaxEvents=100000;
    await send(host.ctx.agents.get(segment2.sessionId),'New segment');
    await manager.dispose();manager=await open();
    const {items:after,error}=manager.getUsage({});
    assert.equal(error,null);
    assert.deepEqual(after.slice(1),before);
    assert.deepEqual([after[0].segment,after[0].turn,after[0].main.input,after[0].review.calls],[2,1,20,0]);
    assert.notEqual(after[0].key,after[2].key);
  } finally {if(manager)await manager.dispose();await host.close();}
});

test('usage startup and queries leave mixed wire journals and native transcripts unopened',{skip:!installed,timeout:30000},async t=>{
  const host=await startupHost((_body,_req,res)=>reply(res,{usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}}));
  const directory=join(host.directory,'loom');
  const open=()=>createLoomContext(host.ctx,{directory,workspaceId:host.workspace.id,getSettings:()=>({roleModels:{bus:testModel},context:{debug:false}})});
  let manager, watches=[];
  const restore=()=>{for(const watch of watches) watch.mock.restore();watches=[];syncBuiltinESMExports();};
  try {
    manager=await open();const bus=await manager.ensureBus(),agent=host.ctx.agents.get(bus.sessionId);
    await send(agent,'Archived transcript body');
    await manager.dispose();manager=null;
    await rm(join(directory,'usage.sqlite'));
    const log=join(directory,'debug','wire-1.jsonl');
    await mkdir(join(directory,'debug'));
    const {busId}=new BusState(directory,host.workspace.id).value;
    const oldCall={type:'llm-call-end',busId,sessionId:bus.sessionId,segment:1,turn:1,step:1,callId:randomUUID(),
      ...testModel,purpose:'conversation',usageSource:'adapter-reported',usage:{inputTokens:20,outputTokens:2,totalTokens:22}};
    await writeFile(log,[{type:'wire-request',payload:'Archived request body'},oldCall].map(row=>JSON.stringify(row)).join('\n')+'\n');
    const reads=[];
    for(const key of ['open','readFile']) {
      const original=fs[key];
      watches.push(t.mock.method(fs,key,(path,...args)=>{
        if(typeof path==='string' && resolve(path)===log) reads.push(key);
        return original(path,...args);
      }));
    }
    const persistence=host.ctx.get('sessionPersistence'), nativeOpen=persistence.open;
    watches.push(t.mock.method(persistence,'open',function(id,...args){if(id===bus.sessionId) reads.push('native transcript');return nativeOpen.call(this,id,...args);}));
    syncBuiltinESMExports();
    manager=await open();
    const first=manager.getUsage({});
    assert.deepEqual(reads,[]);
    assert.deepEqual(first.items,[]);
    assert.equal(first.error.code,'LOOM_USAGE_LEGACY');
    restore();
    await manager.ensureBus();
    await send(host.ctx.agents.get(bus.sessionId),'New measured turn');
    await manager.dispose();manager=await open();
    const {items:[turn],error}=manager.getUsage({});
    assert.deepEqual([turn.turn,turn.main.calls,turn.main.input,error.code],[2,1,20,'LOOM_USAGE_LEGACY']);
    assert.equal(manager.getUsage({key:turn.key}).calls[0].usageSource,'adapter-reported');
  } finally {restore();if(manager)await manager.dispose();await host.close();}
});

async function launchLoom(host,directory,intervalMs=60000) {
  await host.root.plugin(bootstrap,{directory}).await();
  await deadline(host.root.plugin(loom,{directory,intervalMs}).await(),'load Loom');
  const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
  const route=host.ctx.connection.createSharedFetchHandler('/api');
  return {peer,async rpc(endpoint,payload={}) {
    const method=`loom/${endpoint}`,rpcId=randomUUID();
    const response=await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId,method,payload})}),peer);
    const envelope=await response.json();assert.equal(envelope.rpcId,rpcId);return envelope.result;
  }};
}

async function assertScheduled(rpc) {
  await deadline((async()=>{
    for(let attempt=0;attempt<150;attempt++) {
      const {ok,value}=await rpc('status');
      assert.equal(ok,true);
      assert.equal(value.engine.ready,true);
      assert.equal(value.engine.faulted,false);
      if(value.engine.lastTick) return;
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    assert.fail('Loom dispatcher did not record a scheduled tick');
  })(),'a real dispatcher tick');
}

test('a damaged old segment index leaves Loom RPC, scheduled ticks and stored usage available',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_body,_req,res)=>reply(res,{usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}}));
  let manager,peer;
  try {
    const directory=join(host.directory,'loom'),context=join(directory,'context'),control=join(directory,'control');
    await mkdir(control,{recursive:true});
    const {workspace}=await host.ctx.workspaceController.create({path:control});
    const config={debug:false};
    manager=await createLoomContext(host.ctx,{directory:context,workspaceId:workspace.workspaceId,getSettings:()=>({roleModels:{bus:testModel},context:config})});
    const first=await manager.ensureBus();
    await send(host.ctx.agents.get(first.sessionId),'Turn before segment change');
    const before=manager.getUsage({}).items;
    config.segmentMaxEvents=1;
    const current=await manager.ensureBus();
    assert.equal(current.segment,2);
    await manager.dispose();manager=null;
    const corruptIndex=join(context,'segments','1.json'),broken='{truncated';
    await writeFile(corruptIndex,broken);
    const {busId}=new BusState(context,workspace.workspaceId).value;
    await mkdir(join(context,'debug'));
    await writeFile(join(context,'debug','wire-0.jsonl'),JSON.stringify({type:'llm-call-end',busId,
      sessionId:first.sessionId,segment:1,turn:1,step:1,callId:randomUUID(),...testModel,purpose:'conversation',
      usageSource:'adapter-reported',usage:{inputTokens:20,outputTokens:2,totalTokens:22}})+'\n');
    const started=await launchLoom(host,directory,20);peer=started.peer;
    await assertScheduled(started.rpc);
    const {ok,value}=await started.rpc('usage');
    assert.equal(ok,true);
    assert.deepEqual(value.items,before);
    assert.equal(await readFile(corruptIndex,'utf8'),broken);
  } finally {if(manager)await manager.dispose();if(peer)await peer.dispose();await host.close();}
});

test('a corrupt numeric ledger is isolated to usage diagnostics',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_body,_req,res)=>reply(res));
  let peer;
  try {
    const directory=join(host.directory,'loom'),context=join(directory,'context'),file=join(context,'usage.sqlite');
    await mkdir(context,{recursive:true});
    await writeFile(file,'not a SQLite database');
    const started=await launchLoom(host,directory,20);peer=started.peer;
    await assertScheduled(started.rpc);
    assert.equal((await started.rpc('usage')).error.code,'LOOM_USAGE_STORAGE');
    const {ok,value}=await started.rpc('ensureBus');
    assert.equal(ok,true);
    await send(host.ctx.agents.get(value.sessionId),'Conversation despite corrupt ledger');
    assert.equal(host.received.length,1);
    assert.equal(await readFile(file,'utf8'),'not a SQLite database');
  } finally {if(peer)await peer.dispose();await host.close();}
});

test('an incompatible numeric ledger schema does not prevent Loom startup',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost();
  let peer;
  try {
    const directory=join(host.directory,'loom'),context=join(directory,'context'),file=join(context,'usage.sqlite');
    await mkdir(context,{recursive:true});
    const damaged=new DatabaseSync(file);
    try {damaged.exec("CREATE TABLE turns (obsolete TEXT); INSERT INTO turns VALUES ('preserve')");} finally {damaged.close();}
    const started=await launchLoom(host,directory,20);peer=started.peer;
    await assertScheduled(started.rpc);
    assert.equal((await started.rpc('usage')).error.code,'LOOM_USAGE_STORAGE');
    const saved=new DatabaseSync(file,{readOnly:true});
    try {assert.equal(saved.prepare('SELECT obsolete FROM turns').get().obsolete,'preserve');} finally {saved.close();}
  } finally {if(peer)await peer.dispose();await host.close();}
});

test('a successful custom pi-ai completion without a provider usage frame remains unreported',{skip:!installed,timeout:30000},async()=>{
  let calls=0;
  const host=await startupHost((_body,_req,res)=>reply(res,++calls===1?{usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}}:{}));
  let peer;
  try {
    const started=await launchLoom(host,join(host.directory,'loom'));peer=started.peer;
    const {rpc}=started;
    const {value:{sessionId}}=await rpc('ensureBus');
    const agent=host.ctx.agents.get(sessionId);
    await send(agent,'Completion with usage');
    await send(agent,'Completion without usage');
    assert.equal(calls,2);
    const {value:{items}}=await rpc('usage');
    assert.deepEqual(items.map(({status,main})=>[status,main.calls,main.reported,main.inputCount,main.outputCount,main.input,main.output,main.peak]),[
      ['completed',1,0,0,0,null,null,null],['completed',1,1,1,1,20,2,20],
    ]);
    const {value:{calls:[call]}}=await rpc('usage',{key:items[0].key});
    assert.deepEqual([call.status,call.usageSource,call.input,call.output,call.write],['completed','adapter-unverified-zero',null,null,null]);
    assert.deepEqual(call.usage,{inputTokens:0,outputTokens:0,totalTokens:0});
  } finally {if(peer)await peer.dispose();await host.close();}
});

test('registered owner RPC returns failed turns with their missing usage, and validates the read limit',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((_body,_req,res)=>{
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture request rejected',type:'invalid_request_error'}}));
  });
  let peer;
  try {
    const directory=join(host.directory,'loom');
    const started=await launchLoom(host,directory);peer=started.peer;
    const {rpc}=started;
    assert.deepEqual(await rpc('usage'),{ok:true,value:{items:[],error:null}});
    assert.equal((await rpc('usage',{limit:21})).error.code,'INVALID');
    const {value:{sessionId}}=await rpc('ensureBus');
    const agent=host.ctx.agents.get(sessionId);
    agent.followup(native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Usage failure probe'}]}));
    await deadline(agent.whenIdle(),'failed turn');
    const {value:{items:[turn]}}=await rpc('usage');
    assert.deepEqual([turn.status,turn.main.calls,turn.main.reported,turn.main.input],['failed',1,0,null]);
    const {value:{calls:[call]}}=await rpc('usage',{key:turn.key});
    assert.deepEqual([call.status,call.input,call.usageSource],['failed',null,'adapter-error-zero']);
    assert.deepEqual(call.usage,{inputTokens:0,outputTokens:0,totalTokens:0});
  } finally {if(peer)await peer.dispose();await host.close();}
});
