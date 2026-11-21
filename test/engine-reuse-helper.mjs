import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {installed,native,nativeHost,require as nativeRequire} from './context-native-helper.mjs';
import {LoomStore} from '../src/core/store.mjs';
import {LoomEngine} from '../src/host/engine.mjs';
export {installed,native};
export const model={provider:'loom-engine-local',model:'scripted'};
export const actor={kind:'user'};
export const call=(id,report)=>({id,name:'loom_report',arguments:{report}});

export async function engineHost(t) {
  const host=await nativeHost(),database=join(host.directory,'loom.sqlite');
  let store=new LoomStore(database),engine,binder;
  const batches=[],evaluations=[],handles=new Map(),errors=[];
  const {LlmAdapter,createUserMessage}=native('dsh-llm');
  const {paginate,pageRecords}=nativeRequire(join(dirname(nativeRequire.resolve('@deepseek-ai/dsh-api-session-controller')),'types/history.js'));
  class Adapter extends LlmAdapter {
    async *stream() {
      const batch=batches.shift();assert.ok(batch,'unexpected model request');
      if(typeof batch==='string') {yield {type:'text-delta',index:0,text:batch};yield {type:'finish',reason:{kind:'stop'}};return;}
      for(const [index,item] of batch.entries()) yield {type:'tool-call-delta',index,id:item.id,name:item.name,argumentsDelta:JSON.stringify(item.arguments)};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }
  }
  host.ctx.llm.registerAdapter([model.provider],new Adapter());
  const controller={
    async state({sessionId}) {
      const agent=handles.get(sessionId).agent;
      return {cursor:agent.session.seq-1,running:agent.status!=='idle',pendingInput:[],queue:[...agent.inbox.nextTurn]};
    },
    async events({address,throughSeq,beforeSeq,maxMessages}) {
      const page=paginate(handles.get(address.sessionId).agent.session.snapshotEvents(),beforeSeq,maxMessages,throughSeq);
      return {records:pageRecords(page.events),hasMore:page.hasMore};
    },
  };
  const ctx={workspaceRegistry:host.ctx.workspaceRegistry,sessionController:controller,
    waterfall:host.ctx.waterfall.bind(host.ctx),on:host.ctx.on.bind(host.ctx),logger:{error:error=>errors.push(error)}};
  const evaluator={async evaluateWork(work,run,checks) {
    evaluations.push({work,run,checks});
    return {passed:checks.every(check=>check.passed),summary:'本地文件检查完成',source:'local-check',evidence:checks.length?checks:['原生报告']};
  }};
  async function openEngine() {
    const {createWorkerBinder}=await import('../src/host/worker.mjs');
    binder=createWorkerBinder(store);engine=new LoomEngine(ctx,store,evaluator,{bindWorker:binder.bindAgent});
  }
  await openEngine();store.syncWorkspaces(engine.native.workspaces());
  host.ctx.on('agent/created',({agent})=>binder.bindAgent(agent));
  t.after(async()=>{await engine.dispose();await binder.dispose();store.close();await host.close();assert.deepEqual(errors,[]);});
  return {...host,ctx,evaluations,handles,get store(){return store;},get engine(){return engine;},
    async restart() {await engine.dispose();await binder.dispose();store.close();store=new LoomStore(database);await openEngine();for(const {agent} of handles.values())await binder.bindAgent(agent);},
    async reloadSession(sessionId) {
      await handles.get(sessionId).dispose();handles.delete(sessionId);
      const handle=await host.ctx.agents.resume({resumeSessionId:sessionId,agentOptions:model});
      handles.set(sessionId,handle);return handle.agent;
    },
    async createRun(input={}) {
      let work=store.command({type:'work.create',workspaceId:host.workspace.id,title:'生成结果',model,...input},actor);
      work=store.command({type:'work.confirm',workId:work.id,expectedVersion:work.version,autoAccept:true},actor);
      const run=store.reserveRun(work.id);await this.attach(run);return run;
    },
    async attach(run) {
      if(!handles.has(run.sessionId)) handles.set(run.sessionId,await host.ctx.agents.create({sessionId:run.sessionId,meta:{cwd:host.directory},agentOptions:model}));
      store.markRunAccepted(run.id,run.cursor);return handles.get(run.sessionId).agent;
    },
    async drive(run,steps) {
      const agent=handles.get(run.sessionId).agent;batches.push(...steps);
      agent.followup(createUserMessage({source:{kind:'user-rpc',rpcId:run.requestId},content:[{type:'text',text:run.prompt}]}));
      await agent.whenIdle();return agent;
    },
    readArtifact(path) {return readFileSync(join(host.directory,path),'utf8');},
  };
}
