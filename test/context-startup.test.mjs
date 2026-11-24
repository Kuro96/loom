import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { installed } from './context-native-helper.mjs';
import * as loom from '../src/index.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import { LoomStore } from '../src/core/store.mjs';
import { createLoomContext } from '../src/context/index.mjs';
import { BusState } from '../src/context/state.mjs';
import { testModel as model, deadline, startupHost } from './host-native-helper.mjs';

async function seed(host) {
  const directory=join(host.directory,'loom');
  await mkdir(join(directory,'control'),{recursive:true});
  const {workspace}=await host.ctx.workspaceController.create({path:join(directory,'control')});
  const store=new LoomStore(join(directory,'loom.sqlite'));
  store.command({type:'settings.update',roleModels:{bus:model}},{kind:'user'});
  store.close();
  const manager=await createLoomContext(host.ctx,{directory:join(directory,'context'),workspaceId:workspace.workspaceId,getSettings:()=>({roleModels:{bus:model}}),query:async()=>({items:[]}),command:async()=>{throw Error('unexpected');},modelCatalog:()=>host.ctx.sessionController.modelCatalog()});
  const bus=await manager.ensureBus();await manager.dispose();
  return {directory,bus};
}

test('production startup groups existing Loom sessions by ID without opening them or grouping ordinary sessions with the same cwd',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost();
  try {
    const directory=join(host.directory,'loom'),control=join(directory,'control');
    await mkdir(control,{recursive:true});
    const workspace=await host.ctx.workspaceRegistry.create(control,'control');
    const state=new BusState(join(directory,'context'),workspace.id);
    state.commitSegment('missing-loom-history');
    state.commitSegment('damaged-loom-history');
    for(const sessionId of ['older-loom','active-loom','ordinary-control']) {
      const handle=await host.ctx.agents.create({sessionId,meta:{cwd:control},agentOptions:model});
      await handle.dispose();
      assert.ok(await host.ctx.sessionPersistence.stat(sessionId));
      if(sessionId!=='ordinary-control') state.commitSegment(sessionId);
    }
    await fs.writeFile(join(directory,'context','segments','2.json'),'{truncated');
    assert.deepEqual(workspace.sessionIds,[]);
    await host.root.plugin(bootstrap,{directory}).await();
    let applying;
    await host.root.plugin({name:'loom-membership-driver',inject:loom.inject,apply(ctx){applying=loom.apply(ctx,{directory});}}).await();
    await applying;
    assert.deepEqual([...workspace.sessionIds].sort(),['active-loom','older-loom']);
    assert.deepEqual(JSON.parse(readFileSync(state.file,'utf8')).current,state.value.current);
    assert.equal(host.ctx.agents.get('active-loom'),undefined);
    assert.equal(host.received.length,0);
  } finally {await host.close();}
});

for(const failure of ['corrupt log','missing cwd']) {
  test(`a historical ${failure} does not block registration of the current coordinator`,{skip:!installed,timeout:30000},async()=>{
    const host=await startupHost(undefined,{},'zstd');
    try {
      const directory=join(host.directory,'loom'),control=join(directory,'control'),former=join(host.directory,'former-control');
      await mkdir(control,{recursive:true});
      await mkdir(former);
      const workspace=await host.ctx.workspaceRegistry.create(control,'control');
      const state=new BusState(join(directory,'context'),workspace.id);
      for(const sessionId of ['old-bus','current-bus']) {
        const cwd=sessionId==='old-bus' && failure==='missing cwd' ? former : control;
        const handle=await host.ctx.agents.create({sessionId,meta:{cwd},agentOptions:model});
        const {header}=handle.agent.session;
        await handle.dispose();
        const artifact=host.ctx.sessionPersistence.locate(header).path;
        if(sessionId==='old-bus' && failure==='corrupt log') await fs.writeFile(artifact,'broken zstd');
        state.commitSegment(sessionId);
      }
      await fs.rmdir(former);
      await host.root.plugin(bootstrap,{directory}).await();
      let applying;
      await host.root.plugin({name:'loom-membership-driver',inject:loom.inject,apply(ctx){applying=loom.apply(ctx,{directory});}}).await();
      await applying;
      assert.deepEqual(workspace.sessionIds,['current-bus']);
      assert.equal(host.ctx.agents.get('current-bus'),undefined);
      assert.equal(host.received.length,0);
    } finally {await host.close();}
  });
}

function assertWire(wire) {
  assert.ok(wire.messages[0].content.includes('You are Loom'));
  assert.ok(wire.messages[0].content.includes('A workflow stores reusable work instructions.'));
  assert.ok(wire.tools.find(tool=>tool.function.name==='loom_command').function.description.includes('use.create'));
  assert.deepEqual(wire.tools.map(t=>t.function.name),['loom_command','loom_focus','loom_query']);
}

test('production apply first await gates native restore and queued prompt',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost();
  const originalMkdir=fs.mkdir,release=Promise.withResolvers();
  try {
    const {directory,bus}=await seed(host);
    await host.root.plugin(bootstrap,{directory}).await();
    const entered=Promise.withResolvers();let held=false;
    fs.mkdir=async(...args)=>{
      const value=await originalMkdir(...args);
      if(!held && resolve(args[0])===resolve(directory)){held=true;entered.resolve();await release.promise;}
      return value;
    };syncBuiltinESMExports();
    let applyPromise;
    await host.root.plugin({name:'production-apply-driver',inject:loom.inject,apply(c){applyPromise=loom.apply(c,{directory,intervalMs:60000});}}).await();
    await deadline(entered.promise,'first mkdir await');
    const restore=host.ctx.sessionController.resolveAgent(bus.sessionId);
    await deadline((async()=>{while(!host.ctx.agents.get(bus.sessionId))await new Promise(r=>setTimeout(r,1));})(),'native registry publication');
    const prompt=host.ctx.sessionController.prompt({sessionId:bus.sessionId,requestId:'first-await-input',mode:'queue',content:[{type:'text',text:'startup queued input'}]},AbortSignal.timeout(5000));
    assert.equal(host.received.length,0);
    const ordinary=await deadline(host.ctx.sessionController.create({workspaceId:host.workspace.id}),'ordinary creation during first await');
    assert.ok(ordinary.sessionId);
    release.resolve();fs.mkdir=originalMkdir;syncBuiltinESMExports();await applyPromise;
    assert.equal((await prompt).accepted,true);
    const result=await restore;assert.ok('agent' in result,result.error?.message);
    await result.agent.whenIdle();assert.equal(host.received.length,1);assertWire(host.received[0]);
  } finally {release.resolve();fs.mkdir=originalMkdir;syncBuiltinESMExports();await host.close();}
});

test('a completed native numbered reply survives internal reads and resolves the second work at its current version',{skip:!installed,timeout:30000},async()=>{
  const actor={kind:'user'},text='本次清单（编号可引用）\n\n1. Alpha\n2. Beta';
  const names=['loom_focus','loom_query','loom_query'];
  let writes=0,requests=0,items,found,prepared;
  const host=await startupHost((_wire,_req,res)=>{
    const n=requests++;
    if(n===1) { writes++; prepared=JSON.parse(readFileSync(join(directory,'bus.json'),'utf8')).display; }
    if(n===4) found=JSON.parse(_wire.messages.findLast(m=>m.role==='tool').content);
    const tool=n===0?0:n===2?1:n===3?2:null;
    const args=[{display:[{kind:'work',id:items[0].id},{kind:'work',id:items[1].id}]},{kind:'work',workId:items[0].id,detail:true},{kind:'bus.display',position:2}];
    const delta=tool===null?{content:n===1?text:'已核对。'}:{tool_calls:[{index:0,id:`display-${tool}`,type:'function',function:{name:names[tool],arguments:JSON.stringify({request:JSON.stringify(args[tool])})}}]};
    const chunk=choices=>`data: ${JSON.stringify({id:'display-test',object:'chat.completion.chunk',choices})}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:tool===null?'stop':'tool_calls'}])+'data: [DONE]\n\n');
  });
  const directory=join(host.directory,'display'),store=new LoomStore(join(host.directory,'display.sqlite'));
  let manager;
  try {
    store.syncWorkspaces([{workspaceId:host.workspace.id,path:host.directory,title:'测试项目'}]);
    items=['Alpha','Beta'].map(title=>store.command({type:'work.create',workspaceId:host.workspace.id,title,model},actor));
    const open=()=>createLoomContext(host.ctx,{directory,workspaceId:host.workspace.id,getSettings:()=>store.getSettings(),query:request=>store.query(request),command:(request,identity)=>store.command(request,identity),modelCatalog:()=>host.ctx.sessionController.modelCatalog()});
    const send=async(bus,requestId)=>{
      const resolved=await host.ctx.sessionController.resolveAgent(bus.sessionId);
      assert.ok('agent' in resolved);
      await host.ctx.sessionController.prompt({sessionId:bus.sessionId,requestId,mode:'queue',content:[{type:'text',text:requestId}]},AbortSignal.timeout(5000));
      await deadline(resolved.agent.whenIdle(),requestId);
    };
    manager=await open();const bus=await manager.ensureBus();
    await send(bus,'列出两项工作');
    assert.equal(writes,1);assert.equal(prepared,undefined);
    const display=new BusState(directory,host.workspace.id).value.display;
    assert.ok(display,'a completed reply must publish the staged list');
    assert.deepEqual(display.items.map(row=>row.id),items.map(row=>row.id));
    assert.equal(display.sessionId,bus.sessionId);
    assert.equal(typeof display.replyId,'string');
    await manager.dispose();manager=await open();
    const updated=store.command({type:'work.cancel',workId:items[1].id,expectedVersion:items[1].version},actor);
    const same=await manager.ensureBus();assert.equal(same.sessionId,bus.sessionId);
    await send(same,'第二项');
    assert.equal(found.items[0].id,updated.id);
    assert.equal(found.items[0].version,updated.version);
    assert.equal(found.items[0].status,'cancelled');
    assert.deepEqual(new BusState(directory,host.workspace.id).value.display,display);
  } finally { if(manager) await manager.dispose();store.close();await host.close(); }
});
