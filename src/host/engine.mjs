import { isUserCleanupCommand } from '../core/schema.mjs';
import { NativeHarness, NativeRunFailure, sameModel } from './native.mjs';
import { foldRunEvents } from './events.mjs';
import { runChecks } from './checks.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isAcceptanceFailure } from '../context/acceptance.mjs';
import { redact } from '../context/budget.mjs';

const MAX_DELIVERIES=3;

/** Persist intent before sending and reconcile native execution before acceptance. */
export class LoomEngine {
  constructor(ctx,store,context,options={}) {
    this.ctx=ctx; this.store=store; this.context=context;
    this.abort=new AbortController();
    this.native=new NativeHarness(ctx,this.abort.signal,options.bindWorker??null);
    this.intervalMs=options.intervalMs ?? 2000;
    this.active=null; this.timer=null; this.error=null; this.lastTick=null;
    this.sentControls=new Set();
    this.controlActive=null;
    this.verifications=new Map();
  }

  status() { return {ready:true,running:this.active!==null,faulted:this.error!==null,error:this.error,lastTick:this.lastTick,intervalMs:this.intervalMs}; }

  start() {
    this.ctx.on('agent/pre-step',async(payload,next)=>{
      const work=this.store.getWorkForSession(payload.agent.id);
      if(work===null || ['accepted','cancelled','failed'].includes(work.status)) return next();
      if(['pause_requested','paused','cancel_requested','waiting'].includes(work.status)) return {kind:'reject'};
      const consent=work.modelConsent;
      const approved=work.model!==null && consent!==null && consent.actor.kind==='user' &&
        consent.modelRevision===work.modelRevision && sameModel(consent.model,work.model) && sameModel(payload.modelSelection,work.model);
      if(!approved) {
        if(['dispatching','running'].includes(work.status)) {
          await this.command({type:'work.pause',workId:work.id,expectedVersion:work.version},{kind:'agent',sessionId:payload.agent.id});
        }
        return {kind:'reject'};
      }
      return next();
    },{prepend:true});
    this.timer=setInterval(()=>{
      if(this.active!==null || this.error!==null || this.abort.signal.aborted) return;
      this.tick().catch(error=>{
        this.error={message:error.message,stack:error.stack,time:new Date().toISOString()};
        this.ctx.logger.error(error);
      });
    },this.intervalMs);
    this.timer.unref();
  }

  async command(input,actor) {
    if(input.type==='work.retryAcceptance') return this.retryAcceptance(input,actor);
    if(isUserCleanupCommand(input.type)) return this.store.command(input,actor);
    if(input.type==='work.addReport') {
      return this.store.command(input,actor,{coordinatorSessionId:this.context.getBus()?.sessionId});
    }
    const previous=this.store.replayCommand(input,actor);
    if(previous!==undefined) return previous;
    this.store.syncWorkspaces(this.native.workspaces());
    if(input.type==='work.create' && input.sessionId) await this.native.validateAssociation(input.workspaceId,input.sessionId);
    if(['work.confirm','use.confirm'].includes(input.type)) {
      if(actor.kind!=='user') throw Object.assign(new Error('工作确认须由用户提交'),{code:'FORBIDDEN'});
      const isUse=input.type==='use.confirm';
      const target=isUse?this.store.getUse(input.useId):this.store.getWork(input.workId);
      if(target!==null && (!isUse || target.status==='proposed')) {
        if(input.expectedVersion!==target.version) throw Object.assign(new Error('记录版本已变化，请刷新后重试'),{code:'CONFLICT'});
        const execution=isUse?target.execution:target;
        await this.native.validateModel(execution.model);
        this.validatePermission(execution.permissionPreset);
      }
    }
    if(input.model) await this.native.validateModel(input.model);
    if(input.type==='settings.update') {
      if(actor.kind!=='user') throw Object.assign(new Error('设置须由用户修改'),{code:'FORBIDDEN'});
      if(input.permissionPreset!==undefined) this.validatePermission(input.permissionPreset);
      if(input.roleModels) for(const model of Object.values(input.roleModels)) if(model!==null) await this.native.validateModel(model);
    }
    let request=input;
    if(['work.create','workflow.start','use.create'].includes(input.type) && input.model===undefined) {
      const settings=this.store.getSettings();
      const model=settings.roleModels.worker ?? (await this.native.modelCatalog()).default;
      request={...input,model};
    }
    const result=this.store.command(request,actor,{identityInput:input});
    if(['work.pause','work.cancel'].includes(input.type)) {
      for(const task of this.verifications.values()) if(task.workId===input.workId) task.controller.abort();
    }
    return result;
  }

  async retryAcceptance(input,actor) {
    this.abort.signal.throwIfAborted();
    const {work,run,previous}=this.store.prepareAcceptanceRetry(input,actor);
    if(previous!==undefined) return previous;
    if(this.verifications.has(run.id)) throw Object.assign(new Error('正在重新预验收，请等待本次意见'),{code:'CONFLICT'});
    const result=await this.runTask(run,async signal=>{
      signal.throwIfAborted();
      const review=await this.evaluateAcceptance(work,run,run.checkResults,signal);
      signal.throwIfAborted();
      return this.store.finishAcceptanceRetry(input,actor,run.resultVersion,review);
    });
    if(result===undefined) throw Object.assign(new Error('重新预验收已停止'),{code:'CONFLICT'});
    return result;
  }

  async evaluateAcceptance(work,run,checks,signal) {
    try {return await this.context.evaluateWork(work,run,checks,signal);}
    catch(error) {
      signal.throwIfAborted();
      if(!isAcceptanceFailure(error)) throw error;
      return {passed:false,summary:redact(`预验收未完成 [${error.code}]：${error.message}`),source:'acceptance-error',evidence:{
        workId:work.id,runId:run.id,code:error.code,...(error.failure===undefined?{}:{failure:redact(error.failure)}),
        ...(error.details===undefined?{}:{details:redact(error.details)}),
      }};
    }
  }

  validatePermission(preset) {
    if(preset!==null && !this.ctx.permissionPresets.catalog().defaultOptions.some(option=>option.value===preset)) {
      throw Object.assign(new Error('执行权限须选择原生目录中的预设'),{code:'INVALID_INPUT'});
    }
  }

  tick() {
    if(this.active!==null) return this.active;
    this.error=null;
    this.active=this.cycle().catch(error=>{
      this.error={message:error.message,stack:error.stack,time:new Date().toISOString()};
      throw error;
    }).finally(()=>{this.active=null;});
    return this.active;
  }

  async cycle() {
    this.abort.signal.throwIfAborted();
    this.store.syncWorkspaces(this.native.workspaces());
    await this.control();
    this.store.wakeWaiting();
    for(const run of this.store.recoverableRuns()) {
      this.abort.signal.throwIfAborted();
      if(this.verifications.has(run.id) || (run.nativeFault?.scope==='run' && Date.now()<run.nativeFault.retryAt)) continue;
      this.schedule(run);
    }
    for(const work of this.store.readyWork(20)) {
      const run=this.store.reserveRun(work.id);
      this.schedule(run);
    }
    this.lastTick=new Date().toISOString();
    return this.status();
  }

  schedule(run) {
    const task=run.status==='dispatching'?this.dispatch(run):this.observe(run);
    task.catch(error=>{
      this.error={message:error.message,stack:error.stack,time:new Date().toISOString()};
      this.ctx.logger.error(error);
    });
  }

  recordNativeFault(run,scope,error) {
    const previous=run.nativeFault;
    const attempts=previous?.scope===scope?previous.attempts+1:1;
    const retryAt=Date.now()+Math.min(4000,100*2**Math.min(attempts-1,6));
    const stopping=run.status==='pause_requested' || run.status==='cancel_requested';
    const prefix=stopping?'停止尚待核对':run.status==='dispatching'?'投递尚待核对':'执行状态尚待核对';
    const advice=stopping?'请检查原生工作对话的队列和后台活动。':'请检查原生工作对话；需要结束时可暂停或取消。';
    const diagnostic=redact(`${prefix}：${error.message}。${advice}`);
    this.store.updateRun(run.id,{nativeFault:{scope,operation:error.operation,code:error.code,attempts,retryAt},diagnostic});
    return diagnostic;
  }

  dispatch(run) { return this.runTask(run,signal=>this.dispatchRun(run.id,signal),true); }

  async dispatchRun(runId,signal) {
    let current=this.currentRun(runId,signal);
    if(current===null) return;
    const prepared=await this.native.prepare(current.work,current.run);
    current=this.currentRun(runId,signal);
    if(current===null) return;
    const {run}=current;
    if(!prepared.delivered) {
      const attempts=run.deliveryAttempts??0;
      if(attempts>=MAX_DELIVERIES) throw new NativeRunFailure('核对原投递','RECEIPT_UNCONFIRMED',new Error('已用完自动投递次数，仍待确认原请求'));
      this.store.updateRun(run.id,{cursor:prepared.cursor,deliveryAttempts:attempts+1});
      const receipt=await this.native.prompt(run.sessionId,run.requestId,run.prompt);
      if(this.currentRun(runId,signal)===null) return;
      if(receipt.accepted===false) throw new NativeRunFailure('投递执行','RECEIPT_UNCONFIRMED',new Error('原生会话未确认投递'));
      if(receipt.accepted!==true) throw new Error('原生投递回执格式无效');
    }
    this.store.markRunAccepted(run.id,prepared.cursor);
  }

  currentRun(runId,signal) {
    if(signal.aborted) return null;
    const run=this.store.getRun(runId);
    if(run===null) return null;
    const work=this.store.getWork(run.workId);
    if(!['dispatching','accepted','running'].includes(run.status) || !['dispatching','running'].includes(work.status)) return null;
    return {run,work};
  }

  runTask(run,operation,dispatching=false) {
    const existing=this.verifications.get(run.id);
    if(existing!==undefined) return existing.task;
    const controller=new AbortController(),signal=AbortSignal.any([this.abort.signal,controller.signal]);
    const entry={workId:run.workId,dispatching,controller,task:null};
    this.verifications.set(run.id,entry);
    entry.task=Promise.resolve().then(()=>operation(signal)).catch(error=>{
      if(error instanceof NativeRunFailure) {
        const current=this.currentRun(run.id,signal);
        if(current!==null) this.recordNativeFault(current.run,'run',error);
        return;
      }
      if(error.code==='CHECK_STOP_UNCONFIRMED') entry.cleanup=error.retryCleanup;
      if(error.name==='AbortError' && signal.aborted) return;
      throw error;
    }).finally(()=>{if(entry.cleanup===undefined) this.verifications.delete(run.id);});
    return entry.task;
  }

  observe(run) { return this.runTask(run,signal=>this.observeRun(run.id,signal)); }

  saveObservation(run,observation,diagnostic,pendingInput) {
    const patch={cursor:observation.cursor,observation,diagnostic,pendingInput,...(run.nativeFault?.scope==='run'?{nativeFault:null}:{})};
    if(Object.entries(patch).some(([key,value])=>!isDeepStrictEqual(run[key]??null,value))) this.store.updateRun(run.id,patch);
  }

  async observeRun(runId,signal) {
    let current=this.currentRun(runId,signal);
    if(current===null) return;
    let {run}=current;
    const observed=await this.native.eventsSince(run.sessionId,run.cursor);
    current=this.currentRun(runId,signal);
    if(current===null) return;
    run=current.run;
    const observation=foldRunEvents(run,observed.records);
    const diagnostic=observed.state.pendingInput.length?`等待原生交互：${observed.state.pendingInput.join('、')}`:null;
    if(observation.completion===null) {
      this.saveObservation(run,observation,diagnostic,observed.state.pendingInput);
      return;
    }
    const activity=await this.native.activity(run.sessionId);
    if(this.currentRun(runId,signal)===null) return;
    const state=await this.native.state(run.sessionId);
    current=this.currentRun(runId,signal);
    if(current===null) return;
    const pending=state.pendingInput.length?`等待原生交互：${state.pendingInput.join('、')}`:null;
    const queued=state.queue!==null && state.queue.length>0;
    if(observed.state.running || state.running || queued || state.pendingInput.length || activity.length) {
      this.saveObservation(current.run,observation,pending??`会话仍有活动：${JSON.stringify({running:state.running,queue:state.queue,activity})}`,state.pendingInput);
      return;
    }
    this.saveObservation(current.run,observation,pending,state.pendingInput);
    const completion=observation.completion;
    if(completion.reason!=='completed') {
      this.store.finishRun(run.id,{reason:completion.reason,summary:completion.summary,eventCursor:completion.endSeq,checks:[],review:{passed:false,summary:`原生执行结束：${completion.reason}`,source:'native-turn',evidence:[]}});
      return;
    }
    const candidate=current.run.reports.findLast(({source})=>source.sessionId===run.sessionId && source.requestId===run.requestId && source.turn===completion.turn &&
      observation.reportReceipts.some(receipt=>receipt.callId===source.callId && receipt.turn===source.turn && receipt.isError===false && receipt.seq<completion.endSeq));
    if(candidate===undefined && (current.run.reports.length || current.work.outputs.length)) {
      const evidence=current.run.reports.map(({source})=>({source,receipt:observation.reportReceipts.find(receipt=>receipt.turn===source.turn && receipt.callId===source.callId)??null}));
      const message=evidence.length?'工作报告回执未确认：'+evidence.map(({source,receipt})=>`${source.callId}@${source.turn} ${receipt?.isError===true?'原生工具失败':'缺少所属轮次成功回执'}`).join('；'):'工作声明了输出，但缺少成功报告';
      this.saveObservation(this.store.getRun(runId),observation,message,state.pendingInput);
      this.store.finishRun(run.id,{reason:completion.reason,summary:completion.summary,eventCursor:completion.endSeq,checks:[],review:{passed:false,summary:message,source:'native-report',evidence}});
      return;
    }
    if(candidate && ['wait','uncertain'].includes(candidate.report.kind)) {
      this.store.settleReport(run.id,{callId:candidate.source.callId,eventCursor:completion.endSeq});
      return;
    }
    const summary=candidate?.report.kind==='result'?candidate.report.summary:completion.summary;
    const reportCallId=candidate?.report.kind==='result'?candidate.source.callId:undefined;
    const {work}=current;
    const workspace=this.ctx.workspaceRegistry.get(work.workspaceId);
    if(workspace===undefined) throw new Error('验收时工作区已不存在');
    const checks=await runChecks(workspace.path,run.checks,{commandConsent:run.checksConsent!==null && run.checksConsent!==undefined,signal,subprocess:this.ctx.subprocess});
    if(this.currentRun(runId,signal)===null) return;
    let review;
    if(checks.some(check=>!check.passed)) review={passed:false,summary:'客观验收条件尚未全部通过',source:'checks',evidence:checks};
    else {
      review=await this.evaluateAcceptance(this.store.getWork(run.workId),{...this.store.getRun(runId),summary,...(reportCallId===undefined?{}:{outputs:candidate.report.outputs})},checks,signal);
      if(this.currentRun(runId,signal)===null) return;
      if(review.source==='acceptance-error') this.store.updateRun(runId,{diagnostic:review.summary});
    }
    if(this.currentRun(runId,signal)===null) return;
    // Legacy named handoffs retain their acceptance contract; text alone is not a new worker document.
    if(review.passed && run.reportFormat==='bilingual-v1' && !candidate?.report.document && !Object.keys(candidate?.report.outputs??{}).length) {
      review={passed:false,source:'native-report',summary:'本次执行缺少实施者的双语报告，请核对摘要或要求补充。',evidence:{preAcceptance:review}};
    }
    this.store.finishRun(run.id,{reason:completion.reason,summary,eventCursor:completion.endSeq,checks,review,...(reportCallId===undefined?{}:{reportCallId})});
  }

  control() {
    if(this.controlActive!==null) return this.controlActive;
    this.controlActive=this.drainControls().finally(()=>{this.controlActive=null;});
    return this.controlActive;
  }

  async drainControls() {
    for(const control of this.store.pendingControls()) {
      this.abort.signal.throwIfAborted();
      if(!this.store.pendingControls().some(pending=>pending.id===control.id)) continue;
      const run=this.store.getRun(control.runId);
      if(run.nativeFault?.scope===control.id && Date.now()<run.nativeFault.retryAt) continue;
      try { await this.applyControl(control); }
      catch(error) {
        if(!(error instanceof NativeRunFailure)) throw error;
        if(!this.store.pendingControls().some(pending=>pending.id===control.id)) continue;
        const diagnostic=this.recordNativeFault(this.store.getRun(control.runId),control.id,error);
        const detail={code:error.code,diagnostic};
        if(!isDeepStrictEqual(control.detail,detail)) {
          if(control.kind==='steer') this.store.ackSteer(control.id,{accepted:false,detail});
          else this.store.ackControl(control.id,{stopped:false,detail});
        }
      }
    }
  }

  async applyControl(control) {
    if(control.kind==='steer') {
      const current=this.currentRun(control.runId,this.abort.signal);
      if(current===null || current.run.observation?.completion) {
        this.store.supersedeControl(control.id,'目标运行已结束或正在停止');
        return;
      }
      const receipt=await this.native.prompt(control.sessionId,control.requestId,control.text,'steer');
      const active=this.currentRun(control.runId,this.abort.signal);
      if(active?.run.nativeFault?.scope===control.id) this.store.updateRun(control.runId,{nativeFault:null,diagnostic:null});
      this.store.ackSteer(control.id,{accepted:receipt.accepted,detail:receipt});
      return;
    }
    const task=this.verifications.get(control.runId);
    if(task!==undefined) task.controller.abort();
    // An in-flight prompt can be admitted after an earlier stop request.
    if(task?.dispatching && task.cleanup===undefined) return;
    if(task?.cleanup!==undefined) {
      try {
        await task.cleanup();
        this.verifications.delete(control.runId);
      } catch(error) {
        if(error.code!=='CHECK_STOP_UNCONFIRMED') throw error;
      }
    }
    let receipt;
    if(!this.sentControls.has(control.id)) {
      receipt=await this.native.stop(control.sessionId);
      if(receipt.missing) {
        const run=this.store.getRun(control.runId);
        if(run.deliveryAttempts || run.acceptedAt || run.cursor>=0) throw new NativeRunFailure('核对会话停止','session/not-found',new Error('原执行会话暂不可见'));
      }
      this.sentControls.add(control.id);
    } else {
      const state=await this.native.state(control.sessionId);
      const activity=await this.native.activity(control.sessionId);
      receipt={stopped:!state.running && !state.queue?.length && activity.length===0,detail:activity};
    }
    if(this.verifications.has(control.runId)) {
      receipt={stopped:false,detail:{activity:receipt.detail,verification:task?.cleanup===undefined?'stopping':'stop_unconfirmed'}};
      this.sentControls.delete(control.id);
    }
    if(receipt.stopped || control.attempts===0 || !isDeepStrictEqual(control.detail,receipt.detail)) {
      this.store.ackControl(control.id,{stopped:receipt.stopped,detail:receipt.detail});
    }
    if(receipt.stopped) this.sentControls.delete(control.id);
  }

  async dispose() {
    if(this.timer!==null) clearInterval(this.timer);
    this.abort.abort();
    const tasks=[...this.verifications.values()];
    for(const task of tasks) task.controller.abort();
    const results=await Promise.allSettled([...(this.active===null?[]:[this.active]),...(this.controlActive===null?[]:[this.controlActive]),...tasks.map(async task=>{
      try {await task.task;}
      catch(error) {
        if(error.code!=='CHECK_STOP_UNCONFIRMED') throw error;
        await task.cleanup();
        for(const [id,entry] of this.verifications) if(entry===task) this.verifications.delete(id);
      }
    })]);
    const failed=results.find(result=>result.status==='rejected' && result.reason.name!=='AbortError');
    if(failed) throw failed.reason;
  }
}
