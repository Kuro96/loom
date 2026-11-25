import { applyQuestionUpdates, foldRunEvents, questionEventCallId, questionUpdates } from './events.mjs';
import { applyPermissionPreset } from '../permissions.mjs';
import { isProjectCoordinatorSessionId } from '../context/project-coordinator.mjs';

const retryableIO=new Set(['ETIMEDOUT','EAGAIN','EBUSY','ECONNRESET','ECONNREFUSED','EPIPE']);
const retryableSession=new Set(['session/not-found','session/writer-held','session/agent-busy','session/workspace-attach-failed']);
const unreadableSession=new Set(['session/not-found','SESSION_QUERY_PERSISTENCE_FAILED','SESSION_QUERY_CORRUPT_SESSION']);

export class NativeRunFailure extends Error {
  constructor(operation,code,cause) {
    super(`${operation} [${code}]：${cause.message}`,{cause});
    this.operation=operation;this.code=code;
  }
}

async function nativeIO(operation,call,signal,readSession=false) {
  try { return await call(); }
  catch(error) {
    signal.throwIfAborted();
    const code=error?.code==='gateway/internal'?error.cause?.code:error?.code;
    if(!retryableIO.has(code) && !retryableSession.has(code) && !(readSession && unreadableSession.has(code))) throw error;
    throw new NativeRunFailure(operation,code,error);
  }
}

export function sameModel(left,right) {
  return left !== undefined && right !== undefined && left.provider===right.provider && left.model===right.model && left.reasoningEffort===right.reasoningEffort;
}

/** Adapter to the installed Harness controllers. */
export class NativeHarness {
  constructor(ctx,signal,bindWorker=null) { this.ctx=ctx; this.signal=signal; this.bindWorker=bindWorker; }

  workspaces() {
    return this.ctx.workspaceRegistry.list().map(w=>({workspaceId:w.id,path:w.path,title:w.title}));
  }

  async modelCatalog() { return this.ctx.sessionController.modelCatalog(); }

  async validateModel(selection) {
    if(selection===null || selection===undefined) throw new Error('尚未选择执行模型');
    const catalog=await this.modelCatalog();
    const provider=catalog.groups.find(group=>group.id===selection.provider);
    const model=provider?.models.find(item=>item.id===selection.model);
    if(model===undefined) throw new Error(`模型当前不可用：${selection.provider}/${selection.model}`);
    if(selection.reasoningEffort!==undefined && !model.reasoning?.efforts.some(e=>e.id===selection.reasoningEffort)) throw new Error('所选模型不支持该推理强度');
    await this.ctx.llm.resolveCallConfig(selection);
    return selection;
  }

  state(sessionId) { return nativeIO('读取会话状态',()=>this.ctx.sessionController.state({sessionId},this.signal),this.signal,true); }
  liveCursor(sessionId) {
    const agent=this.ctx.agents.get(sessionId);
    return agent===undefined ? -1 : agent.session.seq-1;
  }

  activity(sessionId) {
    return nativeIO('读取会话活动',()=>this.ctx.waterfall('workspace/session-activity',{sessionId},()=>Promise.resolve([])),this.signal);
  }

  async eventsSince(sessionId,cursor) {
    const state=await this.state(sessionId);
    return {state,records:await this.eventRecords(sessionId,cursor,state.cursor)};
  }

  async eventRecords(sessionId,cursor,throughSeq,include=()=>true) {
    const records=[];
    let beforeSeq;
    while(true) {
      const page=await nativeIO('读取会话事件',()=>this.ctx.sessionController.events({address:{kind:'session',sessionId},throughSeq,maxMessages:200,...(beforeSeq===undefined?{}:{beforeSeq})},this.signal),this.signal,true);
      const fresh=page.records.filter(record=>record.event.seq>cursor && include(record.event));
      records.unshift(...fresh);
      if(!page.hasMore || page.records.length===0 || page.records[0].event.seq<=cursor) break;
      const next=page.records[0].event.seq;
      if(beforeSeq!==undefined && next>=beforeSeq) throw new Error('原生会话分页游标未前移');
      beforeSeq=next;
    }
    return records;
  }

  async questionProjection(sessionId,throughSeq) {
    const projection=await nativeIO('读取原生提问投影',()=>this.ctx.sessionController.projections({sessionId},this.signal),this.signal,true);
    if(projection?.kind!=='sequenced' || projection.values.userQuestions===undefined || projection.asOfSeq<throughSeq) return null;
    return {asOfSeq:projection.asOfSeq,view:projection.values.userQuestions};
  }

  async observeQuestions(sessionId,observation,{asOfSeq,view}) {
    const updates=questionUpdates(observation,view);
    if(updates.length===0) return observation;
    const callIds=new Set(updates.map(({callId})=>callId));
    // A projection row may have originated before this Run's initial cursor.
    const answering=updates.some(({status})=>status==='settled');
    const history=await this.eventRecords(sessionId,-1,asOfSeq,event=>callIds.has(questionEventCallId(event)) ||
      (answering && (event.type==='turn/start' || event.type==='turn/end')));
    return applyQuestionUpdates(observation,updates,history,asOfSeq);
  }

  async validateAssociation(workspaceId,sessionId) {
    if(isProjectCoordinatorSessionId(sessionId)) throw Object.assign(new Error('协调会话不能关联为执行会话'),{code:'INVALID_INPUT'});
    const workspace=this.ctx.workspaceRegistry.get(workspaceId);
    if(workspace===undefined) throw new Error('指定工作区已不存在');
    if(!workspace.getSessionHeaders().some(header=>header.id===sessionId && header.origin!=='subagent')) throw new Error('执行会话必须属于所选工作区');
    const state=await this.state(sessionId);
    const activity=await this.activity(sessionId);
    if(state.running || activity.length || (state.queue!==null && state.queue.length)) throw new Error('会话仍有活动任务或排队输入，请完成后再关联');
  }

  async prepare(work,run) {
    const workspace=this.ctx.workspaceRegistry.get(work.workspaceId);
    if(workspace===undefined) throw new NativeRunFailure('准备执行','workspace/not-found',new Error('工作所属项目已不存在'));
    const resolve=()=>nativeIO('解析执行会话',async()=>{
      const value=await this.ctx.sessionController.resolveAgent(run.sessionId);
      if('error' in value && value.error.code!=='session/not-found') throw value.error;
      return value;
    },this.signal);
    let resolved=await resolve();
    if('error' in resolved) {
      if(run.deliveryAttempts || run.acceptedAt || run.cursor>=0) throw new NativeRunFailure('核对原投递','session/not-found',resolved.error);
      const created=await nativeIO('创建执行会话',()=>this.ctx.sessionController.create({workspaceId:work.workspaceId,sessionId:run.sessionId}),this.signal);
      if(created.sessionId!==run.sessionId) throw new Error('原生会话身份冲突，请对账后重新派发');
      resolved=await resolve();
      if('error' in resolved) throw new NativeRunFailure('解析新建会话','session/not-found',resolved.error);
      await nativeIO('命名执行会话',()=>this.ctx.sessionController.rename({sessionId:run.sessionId,title:`Loom · ${work.title}`}),this.signal);
    }
    await nativeIO('关联执行会话',()=>workspace.attachSession(run.sessionId),this.signal);
    const {agent}=resolved;
    if(this.bindWorker!==null) await this.bindWorker(agent);
    const observed=await this.eventsSince(run.sessionId,run.cursor);
    const observation=foldRunEvents(run,observed.records);
    const queued=observed.state.queue!==null && observed.state.queue.some(item=>item.rpcId===run.requestId);
    const delivered=observation.admitted || queued;
    if(delivered) {
      if(!sameModel(agent.model.current(),run.model)) throw new Error('执行会话模型已偏离获批模型，请重新确认');
      return {cursor:run.cursor,delivered:true};
    }
    if(observed.state.running || (observed.state.queue!==null && observed.state.queue.length)) throw new NativeRunFailure('准备执行','session/agent-busy',new Error('目标会话正在处理其他输入'));
    await this.validateModel(run.model);
    const latest=await this.state(run.sessionId);
    if(latest.running || (latest.queue!==null && latest.queue.length)) throw new NativeRunFailure('准备执行','session/agent-busy',new Error('模型选择期间会话已变为忙碌'));
    agent.model.select(run.model);
    if(!sameModel(agent.model.current(),run.model)) throw new Error('执行模型设置读回不一致');
    if(!run.acceptedAt) applyPermissionPreset(this.ctx,agent.session,run.permissionPreset ?? null);
    return {cursor:run.deliveryAttempts?run.cursor:latest.cursor,delivered:false};
  }

  prompt(sessionId,requestId,text,mode='queue') {
    return nativeIO(mode==='steer'?'投递干预':'投递执行',()=>this.ctx.sessionController.prompt({sessionId,requestId,mode,content:[{type:'text',text}]},this.signal),this.signal);
  }

  async stop(sessionId) {
    const resolved=await nativeIO('解析待停止会话',async()=>{
      const value=await this.ctx.sessionController.resolveAgent(sessionId);
      if('error' in value && value.error.code!=='session/not-found') throw value.error;
      return value;
    },this.signal);
    if('error' in resolved) {
      return {stopped:true,detail:[],missing:true};
    }
    await nativeIO('停止会话',()=>this.ctx.parallel('workspace/session-stop',{sessionId}),this.signal);
    const state=await this.state(sessionId);
    const activity=await this.activity(sessionId);
    return {stopped:!state.running && !state.queue?.length && activity.length===0,detail:activity};
  }

  async projectSessions(workspace,signal) {
    const items=[],unavailable=[];
    const controller=this.ctx.sessionController;
    for(const {id:sessionId,origin} of workspace.getSessionHeaders()) {
      signal.throwIfAborted();
      if(origin==='subagent' || isProjectCoordinatorSessionId(sessionId)) continue;
      const address={sessionId};
      try {
        const state=await controller.state(address,signal);
        const projection=await controller.projections(address,signal);
        if(projection===null) unavailable.push({sessionId});
        else items.push({sessionId,workspaceId:workspace.id,title:projection.values.title ?? sessionId,running:state.running});
      } catch(error) {
        signal.throwIfAborted();
        const code=error.code==='gateway/internal'?error.cause?.code:error.code;
        if(!unreadableSession.has(code)) throw error;
        unavailable.push({sessionId});
      }
    }
    signal.throwIfAborted();
    return {items,unavailable};
  }

  async sessions(workspaceId,requestSignal=this.signal) {
    const signal=AbortSignal.any([this.signal,requestSignal]);
    if(workspaceId!==undefined) {
      if(typeof workspaceId!=='string' || !workspaceId) throw new Error('请选择所属项目');
      const workspace=this.ctx.workspaceRegistry.get(workspaceId);
      if(workspace===undefined) throw new Error('指定工作区已不存在');
      return this.projectSessions(workspace,signal);
    }
    let value;
    try {value=await this.ctx.sessionController.list({},signal);}
    catch(error) {
      signal.throwIfAborted();
      if(error.code!=='SESSION_QUERY_PERSISTENCE_FAILED') throw error;
      const items=[];
      for(const workspace of this.ctx.workspaceRegistry.list()) items.push(...(await this.projectSessions(workspace,signal)).items);
      return items;
    }
    const workspaceBySession=new Map();
    for(const workspace of this.ctx.workspaceRegistry.list()) for(const id of workspace.sessionIds) workspaceBySession.set(id,workspace.id);
    return value.items.filter(row=>row.origin!=='subagent' && !isProjectCoordinatorSessionId(row.sessionId)).map(row=>({sessionId:row.sessionId,title:row.projections?.values.title ?? row.sessionId,workspaceId:workspaceBySession.get(row.sessionId) ?? null,running:row.running}));
  }
}
