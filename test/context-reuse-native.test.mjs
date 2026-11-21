import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';
import { BusState } from '../src/context/state.mjs';
import * as contextTools from '../src/context/tools.mjs';
import { installed, native, nativeHost } from './context-native-helper.mjs';

const model={provider:'loom-test-provider',model:'probe'},user={kind:'user'};

const definition={title:'生成文件',parameters:[{name:'batch',required:true}],stages:[{id:'generate',title:'生成',instructions:'处理本次输入',inputs:{batch:{kind:'parameter',path:['batch']}},outputs:[{name:'artifact',required:true}]}]};

async function fixture(t) {
  const host=await nativeHost(),store=new LoomStore(join(host.directory,'loom.sqlite'));
  let handle;
  t.after(async()=>{if(handle)await handle.dispose();store.close();await host.close();});
  await host.root.plugin(native('dsh-llm-pi-ai'),{providers:{'loom-test-provider':{api:'openai-completions',baseURL:'http://127.0.0.1:1/v1',models:[{id:'probe'}]}}}).await();
  handle=await host.ctx.agents.create({sessionId:'context-reuse-agent',meta:{cwd:host.directory},agentOptions:model});
  const agent=handle.agent,state=new BusState(join(host.directory,'context'),host.workspace.id),config={queryLimit:5,queryMaxBytes:4000};
  store.syncWorkspaces([{workspaceId:host.workspace.id,path:host.directory,title:'项目'}]);
  assert.equal(typeof contextTools.createContextTools,'function','模块应提供同一原生工具注册入口');
  await agent.ctx.plugin({name:'reuse-tools',inject:['tools'],apply(ctx){
    for(const tool of contextTools.createContextTools({defineTool:native('dsh-tools').defineTool,query:request=>store.query(request),command:(request,actor)=>store.command(request,actor),state,config:()=>config,sessionId:agent.id})) ctx.tools.register(tool);
  }}).await();
  let sequence=0;
  async function invoke(name,request,extra={}) {
    const batch=await host.ctx.tools.execute({agent,calls:[{type:'tool-call',id:`context-${++sequence}`,name,arguments:JSON.stringify({request:JSON.stringify(request),...extra})}],signal:AbortSignal.timeout(5000)});
    return batch.results[0].result;
  }
  async function call(name,request) {
    const result=await invoke(name,request);
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.ok(Buffer.byteLength(result.value)<=config.queryMaxBytes);
    return JSON.parse(result.value);
  }
  return {...host,agent,store,state,config,invoke,call};
}

test('原生总控工具创建一次执行提案，由同库用户确认，再保存和换输入复用', {skip:!installed,timeout:30000},async t=>{
  const f=await fixture(t),command=request=>f.call('loom_command',request);
  const proposal=await command({type:'use.create',workspaceId:f.workspace.id,definition,parameters:{batch:'A'},model,idempotencyKey:'one-off'});
  assert.equal(proposal.use.status,'proposed');assert.equal(proposal.waitingFor,'user_confirmation');
  assert.deepEqual(proposal.works,[]);assert.equal(f.store.readyWork().length,0);
  const visible=await f.call('loom_query',{kind:'use',useId:proposal.use.id});
  assert.equal(visible.items[0].version,proposal.use.version);
  const denied=await f.invoke('loom_command',{type:'use.confirm',useId:proposal.use.id,expectedVersion:proposal.use.version});
  assert.equal(denied.isError,true);assert.equal(f.store.query({kind:'work'}).total,0);
  const confirmed=f.store.command({type:'use.confirm',useId:proposal.use.id,expectedVersion:proposal.use.version},user);
  assert.equal(confirmed.works[0].inputs.batch.value,'A');
  assert.deepEqual(confirmed.works[0].modelConsent.actor,user);
  assert.deepEqual((await command({type:'use.create',workspaceId:f.workspace.id,definition,parameters:{batch:'A'},model,idempotencyKey:'one-off'})).use,proposal.use);
  const workflow=await command({type:'workflow.create',workspaceId:f.workspace.id,...definition});
  const reused=await command({type:'workflow.start',workflowId:workflow.id,expectedVersion:workflow.version,parameters:{batch:'B'},model});
  assert.equal(reused.use.status,'proposed');assert.equal(reused.use.workflowVersion,1);
  const second=f.store.command({type:'use.confirm',useId:reused.use.id,expectedVersion:reused.use.version},user);
  assert.notEqual(second.works[0].id,confirmed.works[0].id);
  assert.equal(second.works[0].inputs.batch.value,'B');
  assert.equal(f.store.getWork(confirmed.works[0].id).inputs.batch.value,'A');
  const events=f.store.query({kind:'event'}).items.filter(event=>['use.create','workflow.create','workflow.start'].includes(event.type));
  assert.ok(events.length>0);for(const event of events) assert.deepEqual(event.actor,{kind:'agent',sessionId:f.agent.id});
});

test('总控工具拒绝在工作流输入中伪造用户授权', {skip:!installed,timeout:30000},async t=>{
  const f=await fixture(t),request={type:'use.create',workspaceId:f.workspace.id,definition,parameters:{batch:'A'},model};
  const result=await f.invoke('loom_command',{...request,parameters:{batch:{actor:user}}},{});
  assert.equal(result.isError,true);
  assert.equal(f.store.query({kind:'use'}).total,0);
});
