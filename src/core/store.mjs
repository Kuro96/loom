import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { migrate } from './migration.mjs';
import { isUserCleanupCommand, definitionSchema, parameterValues, readPath, checksSchema, declarations, inputsSchema, bounded, reportSchema, documentSchema, zonedTime } from './schema.mjs';

const tables = {work:'works',workflow:'workflows',run:'runs',event:'events',intent:'intents',workspace:'workspaces',control:'controls',use:'uses'};
const activeRunSQL = "('dispatching','accepted','running','pause_requested','cancel_requested')";
const readySQL = `w.status='queued'
  AND json_extract(w.body,'$.modelConsent.modelRevision')=json_extract(w.body,'$.modelRevision')
  AND json_extract(w.body,'$.modelConsent.actor.kind')='user'
  AND COALESCE(json_extract(w.body,'$.gate.required'),0)<=COALESCE(json_extract(w.body,'$.gate.released'),0)
  AND EXISTS(SELECT 1 FROM workspaces s WHERE s.id=w.workspaceId AND json_extract(s.body,'$.active')=1)
  AND NOT EXISTS(SELECT 1 FROM json_each(w.body,'$.dependsOn') d
    LEFT JOIN works prerequisite ON prerequisite.id=d.value WHERE prerequisite.status IS NULL OR prerequisite.status!='accepted')`;
const nativeDecisionSQL=`(SELECT CASE
    WHEN json_type(r.body,'$.pendingInput') IS NULL THEN
      CASE WHEN json_extract(r.body,'$.diagnostic') LIKE '等待原生交互：approval%' THEN 'native_approval'
           WHEN json_extract(r.body,'$.diagnostic') LIKE '等待原生交互：%' THEN 'native_other' END
    WHEN EXISTS(SELECT 1 FROM json_each(r.body,'$.pendingInput') WHERE value='approval') THEN 'native_approval'
    WHEN EXISTS(SELECT 1 FROM json_each(r.body,'$.pendingInput') WHERE value='question') THEN 'native_question'
    WHEN json_array_length(r.body,'$.pendingInput')>0 THEN 'native_other' END
  FROM runs r WHERE r.workId=works.id AND r.status IN ('dispatching','accepted','running') ORDER BY r.seq DESC LIMIT 1)`;
const workDecisionSQL=`CASE
  WHEN status='awaiting_model' THEN 'execution'
  WHEN status IN ('queued','paused') AND (
    json_extract(body,'$.modelConsent.actor.kind') IS NOT 'user'
    OR json_extract(body,'$.modelConsent.modelRevision') IS NOT json_extract(body,'$.modelRevision')
    OR (EXISTS(SELECT 1 FROM json_each(works.body,'$.checks') c WHERE json_extract(c.value,'$.kind')='command')
      AND (json_extract(body,'$.checksConsent.actor.kind') IS NOT 'user'
        OR json_extract(body,'$.checksConsent.checksRevision') IS NOT json_extract(body,'$.checksRevision')))) THEN 'execution'
  WHEN status='queued' AND COALESCE(json_extract(body,'$.gate.required'),0)>COALESCE(json_extract(body,'$.gate.released'),0)
    AND NOT EXISTS(SELECT 1 FROM json_each(works.body,'$.dependsOn') d
      LEFT JOIN works dependency ON dependency.id=d.value WHERE dependency.status IS NOT 'accepted') THEN 'gate'
  WHEN status IN ('dispatching','running') THEN ${nativeDecisionSQL}
  WHEN status='review' THEN 'result'
  WHEN status='failed' THEN 'failed'
  WHEN status='paused' THEN 'resume'
  END`;
const workCategorySQL=`CASE WHEN status IN ('accepted','cancelled') THEN 'completed'
  WHEN (${workDecisionSQL}) IS NOT NULL THEN 'interaction' ELSE 'pending' END`;
const now = () => new Date().toISOString();
function recordBody(kind,row) {
  const value=JSON.parse(row.body);
  if(kind==='work') value.documents??=[];
  return value;
}
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function hasReviewEvidence(review) {
  return review?.passed===true && review.evidence!==null && Object.keys(review.evidence).length>0;
}
function checksPassed(run,results) {
  if(results.length!==run.checks.length) return false;
  if(run.checks.some(c=>c.kind==='command')) {
    const consent=run.checksConsent;
    if(!consent || consent.actor.kind!=='user' || consent.checksRevision!==run.checksRevision ||
      consent.checksHash!==createHash('sha256').update(JSON.stringify(run.checks)).digest('hex')) return false;
  }
  return run.checks.every((check,i)=>{
    const result=results[i], definition={...(result.check??result)};
    if(definition.kind==='command') {definition.args??=[]; definition.expectedExit??=0;}
    return result.passed===true && result.status!=='blocked' && Object.keys(check).every(key=>
      definition[key]!==undefined && fingerprint(definition[key])===fingerprint(check[key]));
  });
}
function fail(code, message, details={}) { throw Object.assign(new Error(message), {code,details}); }
function requireValue(ok, message, code='INVALID_INPUT') { if (!ok) fail(code,message); }
function text(value, name) { requireValue(typeof value==='string' && value.trim().length>0,`${name}须为非空文字`); return value; }
function modelSchema(model) {
  requireValue(model && typeof model==='object','模型格式错误');
  text(model.provider,'模型provider'); text(model.model,'模型名称');
  if(model.reasoningEffort!==undefined) text(model.reasoningEffort,'推理强度');
  return {provider:model.provider,model:model.model,...(model.reasoningEffort===undefined?{}:{reasoningEffort:model.reasoningEffort})};
}

export class LoomStore {
  #db;
  constructor(file) {
    this.#db=new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    let initialized=false;
    try {this.#transaction(()=>{
    this.#db.exec(`CREATE TABLE IF NOT EXISTS commands(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_documents(id TEXT PRIMARY KEY,workId TEXT NOT NULL REFERENCES works(id),body TEXT NOT NULL);`);
    for(const table of Object.values(tables)) {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS ${table}(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspaceId TEXT, workflowId TEXT, workId TEXT, status TEXT, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ${table}_workspace ON ${table}(workspaceId,seq);
        CREATE INDEX IF NOT EXISTS ${table}_workflow ON ${table}(workflowId,seq);
        CREATE INDEX IF NOT EXISTS ${table}_work ON ${table}(workId,seq);
        CREATE INDEX IF NOT EXISTS ${table}_status ON ${table}(status,seq);`);
    }
    migrate(this.#db,this.#settings().permissionPreset);
    this.#db.exec(`CREATE INDEX IF NOT EXISTS works_use ON works(json_extract(body,'$.useId'),seq);
      CREATE INDEX IF NOT EXISTS runs_session ON runs(json_extract(body,'$.sessionId'),seq);
      CREATE INDEX IF NOT EXISTS works_session ON works(json_extract(body,'$.sessionId'),seq);
      CREATE UNIQUE INDEX IF NOT EXISTS works_session_active ON works(json_extract(body,'$.sessionId'))
        WHERE status NOT IN ('accepted','cancelled','failed') AND json_extract(body,'$.sessionId') IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS runs_workspace_active_v1 ON runs(workspaceId) WHERE status IN ${activeRunSQL};`);
    });initialized=true;} finally {if(!initialized) this.#db.close();}
  }
  close() { this.#db.close(); }
  #resolvedInputs(work) {
    if(work.wait!==null) {
      const row=this.#db.prepare('SELECT body FROM runs WHERE workId=? ORDER BY seq DESC LIMIT 1').get(work.id);
      const run=JSON.parse(row.body);
      return {inputs:run.inputs,consumedResults:run.consumedResults};
    }
    const inputs={},consumedResults=[];
    for(const [name,ref] of Object.entries(work.inputs)) {
      if(ref.kind==='value') {inputs[name]=ref.value;continue;}
      const upstream=this.#required('work',ref.workId);
      if(upstream.status!=='accepted' || upstream.result===null || !Object.hasOwn(upstream.result.outputs??{},ref.output)) return null;
      const resolved=readPath(upstream.result.outputs[ref.output],ref.path);
      if(!resolved.found) return null;
      inputs[name]=resolved.value;
      consumedResults.push({inputName:name,workId:upstream.id,runId:upstream.result.runId,resultVersion:upstream.result.version,output:ref.output,path:ref.path,value:resolved.value});
    }
    return {inputs,consumedResults};
  }
  readyWork(limit=20) {
    requireValue(Number.isInteger(limit) && limit>0 && limit<=200,'调度条数须为1至200');
    return this.#transaction(()=>{
      const ready=[],workspaces=new Set();
      const rows=this.#db.prepare(`SELECT w.body FROM works w WHERE ${readySQL}
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.workspaceId=w.workspaceId AND r.status IN ${activeRunSQL}) ORDER BY w.seq`);
      for(const row of rows.iterate()) {
        const work=recordBody('work',row);
        if(workspaces.has(work.workspaceId) || this.#resolvedInputs(work)===null) continue;
        ready.push(work);workspaces.add(work.workspaceId);if(ready.length===limit) break;
      }
      return ready;
    },'DEFERRED');
  }
  reserveRun(workId) {
    return this.#transaction(()=>{
      const work=this.#required('work',workId);
      const existing=this.#db.prepare(`SELECT body FROM runs WHERE workId=? AND status IN ${activeRunSQL}`).get(workId);
      if(existing) return JSON.parse(existing.body);
      requireValue(!this.#db.prepare(`SELECT id FROM runs WHERE workspaceId=? AND status IN ${activeRunSQL}`).get(work.workspaceId),'工作区已有执行中的任务','WORKSPACE_BUSY');
      requireValue(this.#db.prepare(`SELECT id FROM works w WHERE w.id=? AND ${readySQL}`).get(workId),'任务尚未满足派发条件','NOT_READY');
      const workspace=this.#workspace(work.workspaceId);
      const workflow=work.definitionSnapshot;
      const resolved=this.#resolvedInputs(work);requireValue(resolved!==null,'工作输入尚未就绪','NOT_READY');
      work.sessionId??=`session-${randomUUID()}`;
      work.status='dispatching'; this.#saveWork(work);
      const run={id:randomUUID(),workId,workspaceId:work.workspaceId,workflowId:work.workflowId,
        sessionId:work.sessionId,requestId:randomUUID(),model:work.model,modelRevision:work.modelRevision,
        modelConsent:work.modelConsent,workVersion:work.version,permissionPreset:work.permissionPreset,
        checks:work.checks,checksRevision:work.checksRevision,checksConsent:work.checksConsent,
        prompt:`任务：${work.title}\n要求：${work.description}\n范围：${work.scope}\n工作区：${workspace.path}\n工作区共享知识：${workspace.knowledge}\n流程：${workflow?.description??'未分类'}\n流程共享知识：${workflow?.knowledge??''}\n当前反馈：${work.feedback??''}\n检查定义：${JSON.stringify(work.checks)}`+
          '\nLoom调度器已核实本次运行的依赖与人工关卡满足派发条件（预留时持久快照）：'+
          `\n依赖快照：${JSON.stringify(work.dependsOn.map(id=>{const dependency=this.#required('work',id); return {id:dependency.id,status:dependency.status};}))}`+
          `\n人工关卡快照：${JSON.stringify(work.gate)}`+
          '\n执行说明：快照仅适用于本次运行。对快照中已满足的依赖及已释放的人工关卡，无需再次询问是否允许执行本次任务；按上述任务范围继续。新的需求歧义、范围变更或新增授权事项仍须向用户澄清或确认。',
        ...resolved,useId:work.useId,operationId:work.id,wait:work.wait,reportFormat:'bilingual-v1',reports:[],outputs:{},resultVersion:null,
        status:'dispatching',cursor:-1,createdAt:now()};
      run.prompt+=`\n本次输入：${JSON.stringify(resolved.inputs)}\n消费结果版本：${JSON.stringify(resolved.consumedResults)}\n稳定操作标识operationId：${work.id}\n输出声明：${JSON.stringify(work.outputs)}`;
      run.prompt+='\n使用loom_report提交具名结果（kind=result）、外部等待（kind=wait）或回执不确定（kind=uncertain）。报告为候选，检查和验收由Host完成。';
      run.prompt+='\n请在同一次 loom_report 中提交你实际撰写的 document:{english,chinese} Markdown 正文，summary 保留简短摘要。优先使用可用且适用的报告技能。先用简短英文写明结论、证据、未决事项或所需决定，术语一致；再忠实翻译为自然中文，保留数字、条件和不确定性。';
      run.prompt+='\n完成工作即使没有文件或声明输出也须提交双语正文。outputs 保存声明的交接值，无声明时为 {}。deliverables:[{title,path}] 仅列本次实际直接交给用户的文件，path 使用项目内相对路径；无交付文件时省略或填 []。';
      if(work.wait) run.prompt+=`\n恢复操作须先核原操作状态，继续同一operationId；已有远端引用与等待条件：${JSON.stringify(work.wait)}`;
      this.#put('run',run); this.#event('run.reserved',run,{kind:'host'},{runId:run.id,requestId:run.requestId});
      return run;
    });
  }
  markRunAccepted(runId,cursor) {
    requireValue(Number.isSafeInteger(cursor) && cursor>=-1,'事件游标须为大于等于-1的安全整数');
    return this.#transaction(()=>{
      const run=this.#required('run',runId);
      run.cursor=Math.max(run.cursor,cursor);
      if(!run.acceptedAt) {
        run.acceptedAt=now();
        this.#event('run.accepted',run,{kind:'host'},{runId,cursor});
      }
      if(run.status==='dispatching') run.status='accepted';
      if(run.nativeFault?.scope==='run') { run.nativeFault=null;run.diagnostic=null; }
      return this.#put('run',run);
    });
  }
  updateRun(runId,patch) {
    requireValue(patch && typeof patch==='object' && !Array.isArray(patch),'运行更新须为对象');
    for(const key of Object.keys(patch)) requireValue(['cursor','status','diagnostic','running','observation','nativeFault','deliveryAttempts','pendingInput'].includes(key),'运行更新包含不可修改字段');
    if(patch.pendingInput!==undefined) requireValue(Array.isArray(patch.pendingInput) && patch.pendingInput.every(kind=>['approval','question','other'].includes(kind)),'原生交互类型无效');
    if(patch.cursor!==undefined) requireValue(Number.isSafeInteger(patch.cursor) && patch.cursor>=-1,'事件游标须为大于等于-1的安全整数');
    if(patch.status!==undefined) requireValue(['dispatching','running'].includes(patch.status),'终态须通过完成或控制回执记录','INVALID_STATE');
    if(patch.running!==undefined) requireValue(typeof patch.running==='boolean','运行标记须为布尔值');
    return this.#transaction(()=>{
      const run=this.#required('run',runId), work=this.#required('work',run.workId);
      requireValue(['dispatching','accepted','running','pause_requested','cancel_requested'].includes(run.status),'运行已终结','INVALID_STATE');
      const stale=patch.cursor!==undefined && patch.cursor<run.cursor;
      if(patch.cursor!==undefined) run.cursor=Math.max(run.cursor,patch.cursor);
      if(patch.diagnostic!==undefined) run.diagnostic=patch.diagnostic;
      if(patch.nativeFault!==undefined) run.nativeFault=patch.nativeFault;
      if(patch.deliveryAttempts!==undefined) run.deliveryAttempts=patch.deliveryAttempts;
      if(!stale && patch.pendingInput!==undefined) run.pendingInput=patch.pendingInput;
      if(patch.observation!==undefined) {
        requireValue(patch.observation && typeof patch.observation==='object' && !Array.isArray(patch.observation),'原生观察须为对象');
        if(!stale) run.observation=patch.observation;
      }
      if(patch.running!==undefined) run.nativeRunning=patch.running;
      const observedRunning=!stale && patch.observation && patch.observation.admitted===true && Number.isSafeInteger(patch.observation.ownedTurn);
      const target=patch.running===true || observedRunning?'running':patch.status;
      if(target!==undefined && !['pause_requested','cancel_requested'].includes(run.status)) {
        requireValue(!['accepted','running'].includes(run.status) || target==='running','运行状态须保持单调','INVALID_STATE');
        run.status=target;
        if(work.status!==target) {work.status=target; this.#saveWork(work);}
      }
      this.#event('run.updated',run,{kind:'host'},{runId,patch});
      return this.#put('run',run);
    });
  }
  finishRun(runId,{reason,summary,eventCursor,checks=[],review=null,reportCallId}) {
    text(reason,'运行完成原因');
    requireValue(typeof summary==='string','运行摘要须为文字');
    requireValue(Number.isSafeInteger(eventCursor) && eventCursor>=-1,'事件游标须为大于等于-1的安全整数');
    requireValue(Array.isArray(checks),'检查结果须为数组');
    requireValue(checks.every(result=>result && typeof result==='object' && !Array.isArray(result) && typeof result.passed==='boolean'),'每项检查结果须含布尔passed字段');
    if(review!==null) {
      requireValue(typeof review.passed==='boolean' && typeof review.summary==='string','预验收格式错误');
      text(review.source,'预验收来源');
      requireValue(review.evidence!==undefined,'预验收须包含证据');
    }
    return this.#transaction(()=>{
      const run=this.#required('run',runId), work=this.#required('work',run.workId);
      const hash=fingerprint({reason,summary,eventCursor,checks,review,reportCallId});
      if(run.finishHash) {
        requireValue(run.finishHash===hash,'运行已保存不同完成结果','CONFLICT');
        return run;
      }
      requireValue(['dispatching','accepted','running'].includes(run.status),'当前运行须先完成停止对账','INVALID_STATE');
      let outputs={},deliverables=[];
      if(reportCallId!==undefined) {
        const candidate=run.reports.find(c=>c.source.callId===reportCallId);
        requireValue(candidate && candidate.report.kind==='result','须选择当前运行的结果报告','INVALID_INPUT');
        summary=candidate.report.summary;outputs=candidate.report.outputs;run.reportCallId=reportCallId;
        deliverables=candidate.report.deliverables??[];
        if(candidate.report.document) this.#appendDocument(work,run.id,'worker','执行报告',candidate.report.document);
      }
      run.outputs=outputs;run.resultVersion=work.version+1;
      run.status=reason==='completed'?'completed':'failed';
      run.reason=reason; run.summary=summary; run.cursor=Math.max(run.cursor,eventCursor);
      run.checkResults=checks; run.review=review; run.finishedAt=now(); run.finishHash=hash;
      work.status=reason==='completed'?'review':'failed';
      work.result={runId,reason,summary,checks,review,outputs,deliverables,version:run.resultVersion,acceptance:null};
      run.verificationPassed=reason==='completed' && hasReviewEvidence(review) && checksPassed(run,checks) && this.#outputsComplete(work,outputs);
      if(work.authorization?.actor.kind==='user' && work.authorization.autoAccept && run.verificationPassed) {
        work.status='accepted';
        work.result.acceptance={mode:'work',actor:work.authorization.actor,authorization:work.authorization,
          at:now(),runId,workVersion:work.version,resultVersion:work.result.version};
        this.#event('work.autoAccepted',work,{kind:'host'},{runId,authorization:work.authorization});
      }
      this.#saveWork(work); this.#put('run',run);
      this.#event('run.finished',run,{kind:'host'},{runId,reason,cursor:run.cursor});
      return run;
    });
  }
  #outputsComplete(work,outputs) { return work.outputs.every(o=>!o.required || Object.hasOwn(outputs,o.name)); }
  #acceptanceRetryTarget(input,resultVersion) {
    const work=this.#required('work',input.workId);
    this.#version(work,input,true);
    const result=work.result;
    requireValue(work.status==='review' && result?.reason==='completed' && result.acceptance===null,'工作须有当前待验收结果','INVALID_STATE');
    requireValue(result.runId===input.runId && (resultVersion===undefined || result.version===resultVersion),'须重新预验收当前执行结果','CONFLICT');
    const run=this.#required('run',input.runId);
    requireValue(run.status==='completed' && run.workId===work.id && run.resultVersion===result.version,'运行与结果版本不符','CONFLICT');
    requireValue(run.review?.source==='acceptance-error' && result.review?.source==='acceptance-error','当前预验收意见已更新','INVALID_STATE');
    requireValue(this.#outputsComplete(work,run.outputs),'须先补全必需输出','MISSING_OUTPUT');
    requireValue(checksPassed(run,run.checkResults),'须先处理未通过或缺失的客观检查','NOT_READY');
    const candidate=run.reports.find(report=>report.source.callId===run.reportCallId);
    requireValue(run.observation?.completion?.reason==='completed' && (run.reportFormat!=='bilingual-v1' || candidate?.report.document || Object.keys(run.outputs).length),'须先补齐本次执行的报告证据','NOT_READY');
    return {work,run};
  }
  prepareAcceptanceRetry(input,actor) {
    const identity=this.#commandIdentity(input,actor);
    requireValue(input.type==='work.retryAcceptance','重新预验收命令类型错误');
    return this.#transaction(()=>{
      const previous=this.#replayCommand(identity);
      return previous===undefined?this.#acceptanceRetryTarget(input):{previous};
    },'DEFERRED');
  }
  finishAcceptanceRetry(input,actor,resultVersion,review) {
    const identity=this.#commandIdentity(input,actor);
    requireValue(input.type==='work.retryAcceptance' && Number.isSafeInteger(resultVersion),'重新预验收回执缺少当前结果版本');
    requireValue(typeof review.passed==='boolean' && typeof review.summary==='string' && review.evidence!==undefined,'预验收格式错误');
    text(review.source,'预验收来源');
    return this.#transaction(()=>{
      const replay=this.#replayCommand(identity);
      if(replay!==undefined) return replay;
      const {work,run}=this.#acceptanceRetryTarget(input,resultVersion);
      const previous=run.review;
      run.initialReview??=previous;
      run.review=work.result.review=review;
      run.verificationPassed=hasReviewEvidence(review);
      this.#put('run',run);
      const saved=this.#saveWork(work);
      this.#event(input.type,saved,identity.actor,{runId:run.id,resultVersion,previous,review});
      if(identity.key!==undefined) this.#db.prepare('INSERT INTO commands VALUES(?,?,?)').run(identity.key,identity.hash,JSON.stringify(saved));
      return saved;
    });
  }
  getActiveRunForSession(sessionId) {
    text(sessionId,'会话ID');
    const row=this.#db.prepare(`SELECT body FROM runs WHERE json_extract(body,'$.sessionId')=? AND status IN ${activeRunSQL}`).get(sessionId);
    return row?JSON.parse(row.body):null;
  }
  reportRun(runId,report,source) {
    bounded(report);bounded(source);
    requireValue(source && Object.keys(source).every(k=>['sessionId','requestId','turn','callId'].includes(k)),'报告来源格式错误');
    text(source.sessionId,'会话ID');text(source.requestId,'请求ID');text(source.callId,'工具调用ID');
    requireValue(Number.isSafeInteger(source.turn) && source.turn>=0,'报告轮次须为非负整数');
    return this.#transaction(()=>{
      const run=this.#required('run',runId);
      requireValue(source.sessionId===run.sessionId && source.requestId===run.requestId,'报告执行身份不符','FORBIDDEN');
      const previous=run.reports.find(c=>c.source.callId===source.callId);
      if(previous) {requireValue(fingerprint({report,source})===fingerprint({report:previous.report,source:previous.source}),'工具调用已有不同报告','CONFLICT');return previous;}
      requireValue(['dispatching','accepted','running'].includes(run.status),'当前运行不接受报告','INVALID_STATE');
      requireValue(run.reports.length<20,'运行报告候选最多20项','INVALID_INPUT');
      reportSchema(report,this.#required('work',run.workId));
      const candidate={report,source};run.reports.push(candidate);this.#put('run',run);
      this.#event('run.reported',run,{kind:'host'},{runId,callId:source.callId,kind:report.kind});return candidate;
    });
  }
  settleReport(runId,{callId,eventCursor}) {
    text(callId,'报告调用ID');requireValue(Number.isSafeInteger(eventCursor) && eventCursor>=-1,'事件游标格式错误');
    return this.#transaction(()=>{
      const run=this.#required('run',runId),hash=fingerprint({callId,eventCursor});
      if(run.settleHash) {requireValue(run.settleHash===hash,'报告已有不同收口','CONFLICT');return run;}
      requireValue(['dispatching','accepted','running'].includes(run.status),'当前运行须先完成停止对账','INVALID_STATE');
      const candidate=run.reports.find(c=>c.source.callId===callId);
      requireValue(candidate && ['wait','uncertain'].includes(candidate.report.kind),'须选择等待或不确定报告');
      const report=candidate.report,work=this.#required('work',run.workId);
      if(report.document) this.#appendDocument(work,run.id,'worker','执行报告',report.document);
      run.status=report.kind==='wait'?'waiting':'uncertain';work.status=report.kind==='wait'?'waiting':'paused';
      work.wait=report.kind==='wait'?report.wait:report.uncertainty;run.wait=work.wait;
      run.summary=report.summary;run.reportCallId=callId;run.cursor=Math.max(run.cursor,eventCursor);run.finishedAt=now();run.settleHash=hash;
      this.#saveWork(work);this.#put('run',run);this.#event('run.reportSettled',run,{kind:'host'},{callId,eventCursor,status:run.status});return run;
    });
  }
  wakeWaiting(at=now(),limit=20) {
    const due=zonedTime(at);requireValue(Number.isInteger(limit) && limit>0 && limit<=200,'唤醒条数须为1至200');
    return this.#transaction(()=>{
      const result=[];
      for(const row of this.#db.prepare("SELECT body FROM works WHERE status='waiting' ORDER BY seq").iterate()) {
        const work=JSON.parse(row.body);
        if(zonedTime(work.wait.nextCheckAt)>due) continue;
        work.status='queued';this.#saveWork(work);this.#event('work.woken',work,{kind:'host'},{wait:work.wait,at});result.push(work);
        if(result.length===limit) break;
      }
      return result;
    });
  }
  #reworkPreview(workId) {
    const work=this.#required('work',workId),seen=new Set([workId]),affected=[];
    const candidates=this.#db.prepare('SELECT body FROM works WHERE workspaceId=? ORDER BY seq').all(work.workspaceId).map(row=>JSON.parse(row.body));
    const consumers=candidates.filter(w=>w.wait!==null || !['queued','awaiting_model'].includes(w.status)).map(w=>{
      const row=w.result?null:this.#db.prepare('SELECT body FROM runs WHERE workId=? ORDER BY seq DESC LIMIT 1').get(w.id);
      const run=w.result?this.#required('run',w.result.runId):(row?JSON.parse(row.body):null);
      return {workId:w.id,version:w.version,status:w.status,consumedResults:run?.consumedResults??[]};
    });
    let added=true;
    while(added) {
      added=false;
      for(const consumer of consumers) {
        if(seen.has(consumer.workId) || !consumer.consumedResults.some(c=>seen.has(c.workId))) continue;
        seen.add(consumer.workId);affected.push(consumer);added=true;
      }
    }
    const preview={workId,version:work.version,affected};return {...preview,impactToken:fingerprint(preview)};
  }
  previewRework(workId) { return this.#transaction(()=>this.#reworkPreview(workId),'DEFERRED'); }
  pendingControls() {
    return this.#db.prepare("SELECT body FROM controls WHERE status='pending' ORDER BY seq").all().map(r=>JSON.parse(r.body));
  }
  supersedeControl(controlId,detail=null) {
    return this.#transaction(()=>{
      const control=this.#required('control',controlId);
      if(control.status!=='pending') return control;
      control.status='superseded'; control.detail=detail; control.updatedAt=now();
      this.#event('control.superseded',control,{kind:'host'},{controlId,detail});
      return this.#put('control',control);
    });
  }
  ackSteer(controlId,{accepted,detail=null}) {
    requireValue(typeof accepted==='boolean','干预回执须明确实际接收状态');
    return this.#transaction(()=>{
      const control=this.#required('control',controlId);
      requireValue(control.kind==='steer','干预回执须对应steer控制','INVALID_STATE');
      if(control.status!=='pending') return control;
      control.attempts++; control.detail=detail; control.updatedAt=now();
      if(accepted) {control.status='acknowledged'; control.acknowledgedAt=now();}
      this.#event('control.ack',control,{kind:'host'},{controlId,accepted,detail});
      return this.#put('control',control);
    });
  }
  ackControl(controlId,{stopped,detail=null}) {
    requireValue(typeof stopped==='boolean','停止回执须明确实际停止状态');
    return this.#transaction(()=>{
      const control=this.#required('control',controlId);
      requireValue(['pause','cancel'].includes(control.kind),'停止回执须对应pause或cancel控制','INVALID_STATE');
      if(control.status!=='pending') return control;
      control.attempts++; control.detail=detail; control.updatedAt=now();
      if(stopped) {
        const run=this.#required('run',control.runId), work=this.#required('work',control.workId);
        const status=control.kind==='cancel'?'cancelled':'paused';
        run.status=status; run.stoppedAt=now();
        if(run.nativeFault) { run.nativeFault=null;run.diagnostic=null; }
        this.#put('run',run);
        work.status=status; this.#saveWork(work);
        control.status='acknowledged'; control.acknowledgedAt=now();
      }
      this.#event('control.ack',control,{kind:'host'},{controlId,stopped,detail});
      return this.#put('control',control);
    });
  }
  recoverableRuns() {
    return this.#db.prepare(`SELECT body FROM runs WHERE status IN ${activeRunSQL} ORDER BY seq`).all().map(r=>JSON.parse(r.body));
  }
  #transaction(fn,mode='IMMEDIATE') {
    this.#db.exec(`BEGIN ${mode}`);
    let committed=false;
    try { const value=fn(); this.#db.exec('COMMIT'); committed=true; return value; }
    finally { if(!committed) this.#db.exec('ROLLBACK'); }
  }
  #get(kind,id) {
    const row=this.#db.prepare(`SELECT body FROM ${tables[kind]} WHERE id=?`).get(id);
    return row ? recordBody(kind,row) : null;
  }
  #put(kind, value) {
    if(kind==='work' && value.sessionId!==null && !['accepted','cancelled','failed'].includes(value.status)) {
      const owned=this.#db.prepare(`SELECT id FROM works WHERE json_extract(body,'$.sessionId')=?
        AND status NOT IN ('accepted','cancelled','failed') AND id!=?`).get(value.sessionId,value.id);
      requireValue(!owned,'会话已由其他任务使用','SESSION_BUSY');
    }
    this.#db.prepare(`INSERT INTO ${tables[kind]}(id,workspaceId,workflowId,workId,status,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET workspaceId=excluded.workspaceId,workflowId=excluded.workflowId,
      workId=excluded.workId,status=excluded.status,body=excluded.body`).run(
      value.id,value.workspaceId??null,value.workflowId??null,value.workId??null,value.status??null,JSON.stringify(value));
    return value;
  }
  #workspace(id) {
    const workspace=typeof id==='string'?this.#get('workspace',id):null;
    requireValue(workspace && workspace.active,'须选择原生工作区','WORKSPACE_REQUIRED');
    return workspace;
  }
  syncWorkspaces(items) {
    requireValue(Array.isArray(items),'工作区列表须为数组');
    requireValue(items.every(item=>item && typeof item==='object'),'工作区记录格式错误');
    requireValue(new Set(items.map(item=>item.workspaceId)).size===items.length,'工作区ID须唯一');
    return this.#transaction(()=>{
      const existing=new Map(this.#db.prepare('SELECT id,body FROM workspaces').all().map(row=>[row.id,JSON.parse(row.body)]));
      for(const item of items) {
        const {workspaceId,path,title}=item;
        text(workspaceId,'工作区ID'); text(path,'工作区路径'); text(title,'工作区标题');
        const previous=existing.get(workspaceId);
        existing.delete(workspaceId);
        if(previous?.active===true && previous.path===path && previous.title===title) continue;
        this.#put('workspace',{...(previous??{id:workspaceId,workspaceId,knowledge:''}),path,title,active:true,version:previous?previous.version+1:1});
      }
      for(const previous of existing.values()) {
        if(previous.active) this.#put('workspace',{...previous,active:false,version:previous.version+1});
      }
    });
  }
  #appendDocument(work,runId,role,title,document) {
    const meta={id:randomUUID(),role,title,runId,createdAt:now()};
    this.#db.prepare('INSERT INTO work_documents(id,workId,body) VALUES(?,?,?)').run(meta.id,work.id,JSON.stringify({...meta,...document}));
    work.documents.push(meta);
  }
  getDocument(workId,documentId) {
    if(typeof workId!=='string' || typeof documentId!=='string') return null;
    const row=this.#db.prepare('SELECT body FROM work_documents WHERE id=? AND workId=?').get(documentId,workId);
    return row?JSON.parse(row.body):null;
  }
  getWork(id) { return this.#get('work',id); }
  getWorkForSession(sessionId) {
    text(sessionId,'会话ID');
    const row=this.#db.prepare(`SELECT body FROM works WHERE json_extract(body,'$.sessionId')=?
      ORDER BY status NOT IN ('accepted','cancelled','failed') DESC,seq DESC LIMIT 1`).get(sessionId);
    return row?recordBody('work',row):null;
  }
  getWorkflow(id) { return this.#get('workflow',id); }
  #useProgress(use) {
    const progress={total:0,completed:0,interaction:0,pending:0};
    for(const row of this.#db.prepare(`SELECT ${workCategorySQL} category,COUNT(*) count FROM works
      WHERE json_extract(body,'$.useId')=? GROUP BY category`).all(use.id)) {
      progress[row.category]=row.count;progress.total+=row.count;
    }
    return {...use,progress};
  }
  getUse(id) { const use=this.#get('use',id);return use?this.#useProgress(use):null; }
  getRun(id) { return this.#get('run',id); }
  #settings() {
    const row=this.#db.prepare('SELECT body FROM settings WHERE id=1').get();
    return row?{permissionPreset:null,...JSON.parse(row.body)}:{version:0,permissionPreset:null,roleModels:{bus:null,review:null,worker:null,acceptance:null},context:{debug:false}};
  }
  getSettings() {
    const settings=this.#settings();
    settings.roleModels.review??=settings.roleModels.bus;
    return settings;
  }
  query({kind,workspaceId,workflowId,workId,useId,legacy=false,status,categories,after,limit=50,includeDecision=false}) {
    if(kind==='rework') return this.previewRework(workId);
    requireValue(Object.hasOwn(tables,kind),'查询类型错误');
    requireValue(Number.isInteger(limit) && limit>=1 && limit<=200,'分页条数须为1至200');
    if(categories!==undefined) {
      requireValue(kind==='work' && Array.isArray(categories),'工作分类须用于work查询且为数组');
      const order=['pending','completed','interaction'];
      requireValue([...categories].every(category=>order.includes(category)),'工作分类错误');
      categories=order.filter(category=>categories.includes(category));
    }
    const filters={kind,workspaceId,workflowId,workId,useId,legacy,status,categories}, key=fingerprint(filters);
    const where=[], params=[];
    for(const [name,value] of Object.entries({workspaceId,workflowId,workId,status})) {
      if(value===undefined) continue;
      requireValue(value===null || typeof value==='string','查询条件须为文字或null');
      const column=(kind==='work' && name==='workId') || (kind==='workflow' && name==='workflowId')?'id':name;
      if(value===null) where.push(`${column} IS NULL`);
      else {where.push(`${column}=?`); params.push(value);}
    }
    if(kind==='workflow' && legacy!=='all') {
      requireValue(typeof legacy==='boolean','legacy须为布尔值或all');
      where.push(legacy?"status='legacy'":"status!='legacy'");
    }
    if(useId!==undefined) {
      text(useId,'使用ID');where.push(kind==='use'?'id=?':"json_extract(body,'$.useId')=?");params.push(useId);
    }
    if(categories!==undefined) {
      where.push(`(${workCategorySQL}) IN (${categories.map(()=>'?').join(',')})`);
      params.push(...categories);
    }
    let last=0, upper;
    if(after!==undefined && after!==null) {
      requireValue(typeof after==='string','分页游标格式错误','INVALID_CURSOR');
      const match=/^v1\.(\d+)\.(\d+)\.([a-f0-9]{64})$/.exec(after);
      requireValue(match && match[3]===key,'分页游标与查询条件不符','INVALID_CURSOR');
      last=Number(match[1]); upper=Number(match[2]);
      requireValue(Number.isSafeInteger(last) && Number.isSafeInteger(upper) && last<=upper,'分页游标范围错误','INVALID_CURSOR');
    }
    return this.#transaction(()=>{
      upper??=this.#db.prepare(`SELECT COALESCE(MAX(seq),0) upper FROM ${tables[kind]}`).get().upper;
      const predicate=[...where,'seq<=?'].join(' AND ');
      const {total}=this.#db.prepare(`SELECT COUNT(*) total FROM ${tables[kind]} WHERE ${predicate}`).get(...params,upper);
      const decisions=kind==='work' && includeDecision===true;
      const rows=this.#db.prepare(`SELECT seq,body${decisions?`,${workDecisionSQL} AS decision`:''} FROM ${tables[kind]} WHERE ${predicate} AND seq>? ORDER BY seq LIMIT ?`).all(...params,upper,last,limit+1);
      const page=rows.slice(0,limit);
      return {items:page.map(row=>{const value=recordBody(kind,row);return kind==='use'?this.#useProgress(value):value;}),total,
        ...(decisions?{decisions:page.map(row=>row.decision)}:{}),
        nextCursor:rows.length>limit?`v1.${page.at(-1).seq}.${upper}.${key}`:null};
    },'DEFERRED');
  }
  #commandIdentity(input,actor,coordinatorSessionId) {
    requireValue(actor && ['user','agent'].includes(actor.kind),'调用身份须为user或agent','FORBIDDEN');
    requireValue(input && typeof input==='object','命令格式错误');
    if(isUserCleanupCommand(input.type)) requireValue(actor.kind==='user','取消提案或删除记录须由用户提交','FORBIDDEN');
    if(input.type==='work.retryAcceptance') requireValue(actor.kind==='user','重新预验收须由用户提交','FORBIDDEN');
    if(input.type==='work.addReport') requireValue(actor.kind==='agent' && typeof coordinatorSessionId==='string' &&
      actor.sessionId===coordinatorSessionId,'仅当前总控会话可追加报告','FORBIDDEN');
    actor={kind:actor.kind,...(actor.sessionId===undefined?{}:{sessionId:text(actor.sessionId,'会话ID')})};
    if(input.idempotencyKey!==undefined) text(input.idempotencyKey,'幂等键');
    return {actor,key:input.idempotencyKey,hash:fingerprint({input,actor})};
  }
  #replayCommand({key,hash}) {
    if(key===undefined) return undefined;
    const previous=this.#db.prepare('SELECT fingerprint,result FROM commands WHERE key=?').get(key);
    if(!previous) return undefined;
    requireValue(previous.fingerprint===hash,'幂等键已用于其他命令或身份','CONFLICT');
    return JSON.parse(previous.result);
  }
  replayCommand(input,actor) {
    return this.#replayCommand(this.#commandIdentity(input,actor));
  }
  command(effectiveInput,actor,{identityInput=effectiveInput,coordinatorSessionId}={}) {
    const identity=this.#commandIdentity(identityInput,actor,coordinatorSessionId), input=effectiveInput;
    requireValue(input && typeof input==='object','命令格式错误');
    requireValue(input.type===identityInput.type,'命令类型与原始请求不符');
    actor=identity.actor;
    return this.#transaction(()=>{
      const previous=this.#replayCommand(identity);
      if(previous!==undefined) return previous;
      const value=this.#execute(input,actor),target=value.use??value.workflow??value;
      const deleted=input.type==='use.delete' || input.type==='work.delete';
      const result=deleted?{id:target.id,deleted:true}:value;
      if(deleted) this.#event(input.type,target,actor,{version:target.version});
      else if(input.type==='work.addReport') this.#event(input.type,target,actor,{version:target.version,runId:input.runId,documentId:target.documents.at(-1).id});
      else this.#event(input.type,target,actor,{version:target.version??null,
        ...(target.result?.acceptance?{acceptance:target.result.acceptance}:{}),
        ...(target.modelConsent?{modelConsent:target.modelConsent}:{}),
        ...(target.checksConsent?{checksConsent:target.checksConsent}:{}),
        ...(target.authorization?{authorization:target.authorization}:{})});
      if(identity.key!==undefined) this.#db.prepare('INSERT INTO commands VALUES(?,?,?)').run(identity.key,identity.hash,JSON.stringify(result));
      return result;
    });
  }
  #event(type,target,actor,detail={}) {
    return this.#put('event',{id:randomUUID(),type,workspaceId:target.workspaceId??null,
      workflowId:target.workflowId??(type.startsWith('workflow.')?target.id:null),
      workId:target.workId??(type.startsWith('work.')?target.id:null),
      useId:target.useId??(type.startsWith('use.') || type==='workflow.start'?target.id:null),
      actor,detail,createdAt:now()});
  }
  #required(kind,id) {
    text(id,`${kind} ID`);
    const value=this.#get(kind,id);
    requireValue(value,`${kind}记录不存在`,'NOT_FOUND');
    return value;
  }
  #version(value,input,required=false) {
    requireValue((!required && input.expectedVersion===undefined) || input.expectedVersion===value.version,'记录版本已变化，请刷新后重试','CONFLICT');
  }
  checkDeletion({kind,id}) {
    requireValue(kind==='work' || kind==='use','删除对象须为工作或本次提案');
    return this.#deletionBlock(kind,this.#required(kind,id));
  }
  #deletionBlock(kind,record) {
    const {id,workspaceId}=record, references=[];
    const state=message=>({code:'INVALID_STATE',message,references});
    if(kind==='use') {
      if(!['proposed','cancelled'].includes(record.status) || record.workIds.length || this.#db.prepare("SELECT 1 FROM works WHERE json_extract(body,'$.useId')=?").get(id))
        return state('本次提案已生成工作，请从工作详情逐项处理。');
    } else {
      if(['dispatching','running','pause_requested','cancel_requested'].includes(record.status) || this.#db.prepare(`SELECT 1 FROM runs WHERE workId=? AND status IN ${activeRunSQL}`).get(id))
        return state('请先停止执行并等待停止回执，再删除工作。');
      if(this.#db.prepare("SELECT 1 FROM controls WHERE workId=? AND status='pending'").get(id)) return state('请等待控制回执后再删除工作。');
      const works=this.#db.prepare(`WITH users(id) AS (
        SELECT w.id FROM works w WHERE w.workspaceId=$workspace AND w.id!=$id AND (
          EXISTS(SELECT 1 FROM json_each(w.body,'$.dependsOn') d WHERE d.value=$id) OR
          EXISTS(SELECT 1 FROM json_each(w.body,'$.inputs') i WHERE i.value->>'kind'='result' AND i.value->>'workId'=$id))
        UNION SELECT r.workId FROM runs r, json_each(r.body,'$.consumedResults') c
          WHERE r.workspaceId=$workspace AND r.workId!=$id AND c.value->>'workId'=$id)
        SELECT 'work' AS kind,users.id,json_extract(w.body,'$.title') AS title FROM users LEFT JOIN works w ON w.id=users.id ORDER BY w.seq`).all({workspace:workspaceId,id});
      const workflows=this.#db.prepare(`SELECT 'workflow' AS kind,id,json_extract(body,'$.title') AS title FROM workflows
        WHERE workspaceId=? AND EXISTS(SELECT 1 FROM json_each(body,'$.sourceWorkIds') WHERE value=?) ORDER BY seq`).all(workspaceId,id);
      references.push(...works,...workflows);
    }
    const target=kind==='work'?'workId':"json_extract(body,'$.useId')";
    references.push(...this.#db.prepare(`SELECT 'intent' AS kind,id,json_extract(body,'$.text') AS title FROM intents WHERE ${target}=? ORDER BY seq`).all(id));
    return references.length ? {code:'INVALID_DEPENDENCY',message:'以下记录仍引用此项，暂时无法删除。',references} : null;
  }
  #allowDeletion(kind,record) {
    const block=this.#deletionBlock(kind,record);
    if(block) fail(block.code,block.message,{references:block.references});
  }
  #saveWork(work) {
    work.version++; work.updatedAt=now();
    return this.#put('work',work);
  }
  #execution(input) {
    const settings=this.#settings(),model=input.model===undefined?settings.roleModels.worker:input.model;
    const permissionPreset=input.permissionPreset===undefined?settings.permissionPreset:input.permissionPreset;
    requireValue(input.autoAccept===undefined || typeof input.autoAccept==='boolean','自动验收须为布尔值');
    return {model:model===null?null:modelSchema(model),permissionPreset:permissionPreset===null?null:text(permissionPreset,'执行权限预设'),autoAccept:input.autoAccept??false};
  }
  #newWork(input) {
    bounded({inputs:input.inputs??{},outputs:input.outputs??[]});
    const execution=this.#execution(input),timestamp=now();
    return {id:randomUUID(),workspaceId:input.workspaceId,workflowId:input.workflowId??null,stageId:null,useId:null,
      title:input.title,description:input.description??'',scope:input.scope??'工作区内的当前任务',status:'awaiting_model',version:1,
      model:execution.model,modelRevision:execution.model?1:0,modelConsent:null,sessionId:input.sessionId??null,dependsOn:[...(input.dependsOn??[])],
      gate:input.manualGate?{required:true,released:false,release:null}:null,checks:checksSchema(input.checks),checksRevision:1,checksConsent:null,
      inputs:inputsSchema(input.inputs,'work'),outputs:declarations(input.outputs),documents:[],permissionPreset:execution.permissionPreset,
      authorization:null,wait:null,inputChanges:[],createdAt:timestamp,updatedAt:timestamp,result:null};
  }
  #confirmWork(work,actor,autoAccept) {
    requireValue(work.model,'须选择本次模型');
    work.modelConsent={modelRevision:work.modelRevision,model:work.model,actor,at:now()};
    work.checksConsent={checksRevision:work.checksRevision,checks:work.checks,checksHash:createHash('sha256').update(JSON.stringify(work.checks)).digest('hex'),actor,at:now()};
    work.authorization={autoAccept,actor,at:now(),workVersion:work.version,permissionPreset:work.permissionPreset};
    if(work.status!=='paused') work.status='queued';
  }
  #execute(input, actor) {
    const timestamp=now();
    if(input.type==='work.addReport') {
      bounded(input);
      requireValue(Object.keys(input).every(k=>['type','workId','runId','expectedVersion','idempotencyKey','title','document'].includes(k)),'补充报告格式错误');
      const work=this.#required('work',input.workId),run=this.#required('run',input.runId);
      requireValue(run.workId===work.id,'报告运行不属于该工作','NOT_FOUND');this.#version(work,input,true);
      text(input.title,'报告标题');documentSchema(input.document);
      this.#appendDocument(work,run.id,'coordinator',input.title,input.document);
      return this.#saveWork(work);
    }
    if(['workspace.setKnowledge','workflow.setKnowledge'].includes(input.type)) {
      const kind=input.type.startsWith('workspace.')?'workspace':'workflow';
      const target=this.#required(kind,input[`${kind}Id`]); this.#version(target,input);
      if(kind==='workflow') requireValue(target.status==='available','历史来源只读','INVALID_STATE');
      requireValue(typeof input.knowledge==='string','共享知识须为文字');
      target.knowledge=input.knowledge; target.version++; target.updatedAt=timestamp;
      return this.#put(kind,target);
    }
    if(input.type==='settings.update') {
      requireValue(actor.kind==='user','设置须由用户修改','FORBIDDEN');
      const settings=this.#settings(); this.#version(settings,input);
      if(input.permissionPreset!==undefined) {
        settings.permissionPreset=input.permissionPreset===null?null:text(input.permissionPreset,'执行权限预设');
      }
      if(input.roleModels!==undefined) {
        requireValue(input.roleModels && typeof input.roleModels==='object' && !Array.isArray(input.roleModels),'角色模型须为对象');
        for(const [role,value] of Object.entries(input.roleModels)) {
          requireValue(['bus','review','worker','acceptance'].includes(role),'角色名称错误');
          settings.roleModels[role]=value===null?null:modelSchema(value);
        }
      }
      if(input.context!==undefined) {
        requireValue(input.context && typeof input.context==='object' && !Array.isArray(input.context),'上下文设置须为对象');
        if(input.context.debug!==undefined) requireValue(typeof input.context.debug==='boolean','debug须为布尔值');
        settings.context={...settings.context,...input.context};
      }
      settings.version++;
      this.#db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(settings));
      return this.getSettings();
    }
    if(input.type==='intent.create') {
      return this.#put('intent',{id:randomUUID(),text:text(input.text,'意图'),workspaceId:null,status:'pending',version:1,createdAt:timestamp,actor});
    }
    if(input.type==='intent.assignProject') {
      requireValue(actor.kind==='user','项目归属须由用户指定','FORBIDDEN');
      const intent=this.#required('intent',input.intentId);this.#workspace(input.workspaceId);
      this.#version({...intent,version:intent.version??1},input,true);
      requireValue(intent.status==='pending','请求已关联工作','CONFLICT');
      intent.workspaceId=input.workspaceId;intent.version=input.expectedVersion+1;
      intent.projectSelection={actor,at:timestamp};
      return this.#put('intent',intent);
    }
    if(input.type==='intent.resolve') {
      const intent=this.#required('intent',input.intentId);this.#workspace(input.workspaceId);
      requireValue((input.workId!==undefined)!==(input.useId!==undefined),'须指定一个工作或使用目标');
      const kind=input.workId!==undefined?'work':'use',id=input[`${kind}Id`],target=this.#required(kind,id);
      requireValue(target.workspaceId===input.workspaceId,'意图目标须同项目','WORKSPACE_MISMATCH');
      if(intent.status==='resolved') {
        requireValue(intent.workspaceId===input.workspaceId && intent[`${kind}Id`]===id,'意图已关联其他目标','CONFLICT');return intent;
      }
      requireValue(intent.workspaceId===null || intent.workspaceId===input.workspaceId,'须沿用用户指定的项目','WORKSPACE_MISMATCH');
      intent.status='resolved';intent.workspaceId=input.workspaceId;intent[`${kind}Id`]=id;intent.resolvedAt=timestamp;
      intent.version=(intent.version??1)+1;
      return this.#put('intent',intent);
    }
    if(input.type==='workflow.create') {
      this.#workspace(input.workspaceId);
      const definition=definitionSchema(Object.fromEntries(['title','description','knowledge','parameters','stages'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])));
      if(input.sourceWorkIds!==undefined) {
        requireValue(Array.isArray(input.sourceWorkIds) && input.sourceWorkIds.length>0 && new Set(input.sourceWorkIds).size===input.sourceWorkIds.length,'来源工作须为唯一ID数组');
        for(const id of input.sourceWorkIds) {
          const work=this.#required('work',id);
          requireValue(work.workspaceId===input.workspaceId,'来源工作须同项目','WORKSPACE_MISMATCH');
          requireValue(work.status==='accepted','来源工作须已验收','INVALID_STATE');
          requireValue(input.sourceVersions?.[id]===work.version,'来源工作版本已变化','CONFLICT');
        }
      }
      return this.#put('workflow',{id:randomUUID(),workspaceId:input.workspaceId,...definition,status:'available',version:1,
        ...(input.sourceWorkIds?{sourceWorkIds:input.sourceWorkIds,sourceVersions:input.sourceVersions}:{}),createdAt:timestamp,updatedAt:timestamp});
    }
    if(input.type==='workflow.update') {
      const workflow=this.#required('workflow',input.workflowId);this.#version(workflow,input,true);
      requireValue(workflow.status==='available','历史来源只读','INVALID_STATE');
      Object.assign(workflow,definitionSchema(input.definition));workflow.version++;workflow.updatedAt=timestamp;
      return this.#put('workflow',workflow);
    }
    if(input.type==='workflow.authorize') fail('MIGRATION_REQUIRED','请使用work.authorize或use.authorize确认具体工作授权');
    if(['workflow.start','use.create'].includes(input.type)) {
      const workflow=input.type==='workflow.start'?this.#required('workflow',input.workflowId):null;
      if(workflow) {this.#version(workflow,input,true);requireValue(workflow.status==='available','历史来源不可直接使用','INVALID_STATE');}
      const workspaceId=workflow?workflow.workspaceId:input.workspaceId;this.#workspace(workspaceId);
      const definition=definitionSchema(workflow?{title:workflow.title,description:workflow.description,knowledge:workflow.knowledge,parameters:workflow.parameters,stages:workflow.stages}:input.definition,input.stageInputs);
      const use={id:randomUUID(),workspaceId,workflowId:workflow?.id??null,workflowVersion:workflow?.version??null,
        version:1,status:'proposed',definitionSnapshot:definition,parameters:parameterValues(definition,input.parameters),
        execution:this.#execution(input),confirmation:null,workIds:[],stageWorkIds:{},createdAt:timestamp,updatedAt:timestamp};
      this.#put('use',use);return {use:this.#useProgress(use),works:[]};
    }
    if(['use.cancel','use.delete'].includes(input.type)) {
      const use=this.#required('use',input.useId);this.#version(use,input,true);
      if(input.type==='use.delete') {
        this.#allowDeletion('use',use);
        this.#db.prepare('DELETE FROM uses WHERE id=?').run(use.id);return use;
      }
      requireValue(use.status==='proposed','仅待确认提案可取消','INVALID_STATE');
      use.status='cancelled';use.version++;use.updatedAt=timestamp;this.#put('use',use);
      return this.#useProgress(use);
    }
    if(input.type==='use.update') {
      const use=this.#required('use',input.useId);this.#version(use,input,true);
      requireValue(use.status==='proposed','仅待确认提案可修改','INVALID_STATE');
      if(input.definition!==undefined || input.stageInputs!==undefined) {
        use.definitionSnapshot=definitionSchema(input.definition===undefined?use.definitionSnapshot:input.definition,input.stageInputs);
        if(input.definition!==undefined && use.workflowId!==null) {use.sourceWorkflowId=use.workflowId;use.sourceWorkflowVersion=use.workflowVersion;use.workflowId=null;use.workflowVersion=null;}
      }
      use.parameters=parameterValues(use.definitionSnapshot,input.parameters??use.parameters);
      use.execution=this.#execution({...use.execution,...Object.fromEntries(['model','permissionPreset','autoAccept'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))});
      use.version++;use.updatedAt=timestamp;this.#put('use',use);return this.#useProgress(use);
    }
    if(input.type==='use.confirm') {
      requireValue(actor.kind==='user','使用须由用户确认','FORBIDDEN');
      const use=this.#required('use',input.useId);
      if(use.status==='confirmed') {
        requireValue(!use.legacy,'历史使用保持既有工作','INVALID_STATE');
        requireValue(input.expectedVersion===use.confirmation.proposalVersion,'提案版本已变化','CONFLICT');
        return {use:this.#useProgress(use),works:use.workIds.map(id=>this.#required('work',id))};
      }
      this.#version(use,input,true);
      requireValue(use.status==='proposed','仅待确认提案可确认','INVALID_STATE');this.#workspace(use.workspaceId);
      requireValue(use.execution.model,'须选择本次模型','INVALID_INPUT');
      const definition=use.definitionSnapshot,ids=new Map(definition.stages.map(stage=>[stage.id,randomUUID()]));
      const works=definition.stages.map(stage=>{
        const inputs=Object.fromEntries(Object.entries(stage.inputs).map(([name,ref])=>[name,ref.kind==='value'?ref:ref.kind==='parameter'?
          {kind:'value',value:readPath(use.parameters,ref.path).value}:{kind:'result',workId:ids.get(ref.stageId),output:ref.output,path:ref.path}]));
        const work=this.#newWork({workspaceId:use.workspaceId,workflowId:use.workflowId,title:stage.title,description:stage.instructions,
          scope:stage.scope,model:use.execution.model,permissionPreset:use.execution.permissionPreset,checks:stage.checks,inputs,outputs:stage.outputs,manualGate:stage.manualGate});
        work.id=ids.get(stage.id);work.useId=use.id;work.stageId=stage.id;
        work.definitionSnapshot={description:definition.description,knowledge:definition.knowledge};
        work.dependsOn=stage.dependsOn.map(id=>ids.get(id));
        this.#confirmWork(work,actor,use.execution.autoAccept);this.#put('work',work);
        this.#event('work.create',work,actor,{version:work.version});return work;
      });
      use.confirmation={actor,at:timestamp,proposalVersion:use.version};use.status='confirmed';use.version++;use.updatedAt=timestamp;
      use.workIds=works.map(w=>w.id);use.stageWorkIds=Object.fromEntries(ids);this.#put('use',use);
      return {use:this.#useProgress(use),works};
    }
    if(['work.confirm','work.authorize','use.authorize'].includes(input.type)) {
      requireValue(actor.kind==='user','工作授权须由用户确认','FORBIDDEN');
      const isUse=input.type==='use.authorize',target=this.#required(isUse?'use':'work',isUse?input.useId:input.workId);this.#version(target,input,true);
      const autoAccept=input.type==='work.confirm'?(input.autoAccept??false):input.autoAccept;
      requireValue(typeof autoAccept==='boolean','自动验收授权须为布尔值');
      if(isUse) requireValue(target.status==='confirmed','须先确认本次使用','INVALID_STATE');
      const works=isUse?target.workIds.map(id=>this.#required('work',id)):[target];
      for(const work of works) {
        if(input.type==='work.confirm') {
          requireValue(['awaiting_model','queued','paused'].includes(work.status),'当前工作状态不支持确认','INVALID_STATE');
          this.#confirmWork(work,actor,autoAccept);
        } else work.authorization={autoAccept,actor,at:timestamp,workVersion:work.version};
        this.#saveWork(work);
      }
      if(isUse) {target.execution.autoAccept=autoAccept;target.version++;target.updatedAt=timestamp;this.#put('use',target);return this.#useProgress(target);}
      return target;
    }
    if(input.type==='work.delete') {
      const work=this.#required('work',input.workId);this.#version(work,input,true);
      this.#allowDeletion('work',work);
      if(work.useId!==null) {
        const use=this.#required('use',work.useId);
        use.workIds=use.workIds.filter(id=>id!==work.id);
        use.stageWorkIds=Object.fromEntries(Object.entries(use.stageWorkIds).filter(([,id])=>id!==work.id));
        use.version++;use.updatedAt=timestamp;this.#put('use',use);
      }
      for(const table of ['work_documents','controls','runs']) this.#db.prepare(`DELETE FROM ${table} WHERE workId=?`).run(work.id);
      this.#db.prepare('DELETE FROM works WHERE id=?').run(work.id);return work;
    }
    if(input.type==='work.create') {
      this.#workspace(input.workspaceId);
      text(input.title,'任务标题');
      requireValue(input.description===undefined || typeof input.description==='string','任务描述须为文字');
      requireValue(input.scope===undefined || typeof input.scope==='string','任务范围须为文字');
      requireValue(input.manualGate===undefined || typeof input.manualGate==='boolean','人工关卡须为布尔值');
      if(input.model!=null) modelSchema(input.model);
      if(input.workflowId!=null) {
        const workflow=this.#required('workflow',input.workflowId);
        requireValue(workflow.workspaceId===input.workspaceId,'任务和流程须属于同一工作区','WORKSPACE_MISMATCH');
      }
      const dependencies=input.dependsOn??[];
      if(input.sessionId!=null) text(input.sessionId,'会话ID');
      requireValue(Array.isArray(dependencies) && new Set(dependencies).size===dependencies.length,'依赖须为唯一任务ID数组');
      for(const id of dependencies) {
        const dependency=this.#required('work',id);
        requireValue(dependency.workspaceId===input.workspaceId,'依赖任务须属于同一工作区','WORKSPACE_MISMATCH');
      }
      const work=this.#newWork(input);
      for(const ref of Object.values(work.inputs)) if(ref.kind==='result') {
        const upstream=this.#required('work',ref.workId);
        requireValue(upstream.workspaceId===work.workspaceId,'输入来源须同项目','WORKSPACE_MISMATCH');
        requireValue(upstream.outputs.some(o=>o.name===ref.output),'输入来源输出未声明','INVALID_DEPENDENCY');
        if(!work.dependsOn.includes(ref.workId)) work.dependsOn.push(ref.workId);
      }
      if(work.workflowId) {const workflow=this.#required('workflow',work.workflowId);work.definitionSnapshot={description:workflow.description,knowledge:workflow.knowledge};}
      return this.#put('work',work);
    }
    if(['work.setModel','work.approveModel'].includes(input.type)) {
      if(input.type==='work.approveModel') requireValue(actor.kind==='user','模型同意须由用户确认','FORBIDDEN');
      const work=this.#required('work',input.workId);
      this.#version(work,input,input.type==='work.approveModel');
      requireValue(['awaiting_model','queued','paused','failed','review'].includes(work.status),'当前任务状态不支持修改模型','INVALID_STATE');
      if(input.type==='work.approveModel') requireValue(['awaiting_model','queued','paused'].includes(work.status),'任务已有结果，须先发起返工或变更模型','INVALID_STATE');
      if(input.type==='work.setModel') {
        work.model=modelSchema(input.model); work.modelRevision++; work.modelConsent=null;
        if(work.status!=='paused') work.status='awaiting_model';
        work.result=null;
      } else {
        requireValue(work.model && input.modelRevision===work.modelRevision,'模型版本已变化','CONFLICT');
        work.modelConsent={modelRevision:work.modelRevision,model:work.model,actor,at:timestamp};
        if(work.status!=='paused') work.status='queued';
      }
      return this.#saveWork(work);
    }
    if(['work.setChecks','work.approveChecks'].includes(input.type)) {
      if(input.type==='work.approveChecks') requireValue(actor.kind==='user','命令检查须由用户授权','FORBIDDEN');
      const work=this.#required('work',input.workId);
      this.#version(work,input,input.type==='work.approveChecks');
      requireValue(['awaiting_model','queued','paused','failed','review'].includes(work.status),'当前任务状态不支持修改检查','INVALID_STATE');
      if(input.type==='work.setChecks') {
        work.checks=checksSchema(input.checks); work.checksRevision++; work.checksConsent=null;work.authorization=null;
        work.result=null;
        if(work.status==='review') work.status=work.modelConsent?'queued':'awaiting_model';
      } else {
        requireValue(input.checksRevision===work.checksRevision,'检查版本已变化','CONFLICT');
        work.checksConsent={checksRevision:work.checksRevision,checks:work.checks,
          checksHash:createHash('sha256').update(JSON.stringify(work.checks)).digest('hex'),actor,at:timestamp};
      }
      return this.#saveWork(work);
    }
    if(input.type==='work.rework') {
      const work=this.#required('work',input.workId); this.#version(work,input);
      requireValue(['review','accepted','failed','cancelled','paused'].includes(work.status),'当前任务状态不支持返工','INVALID_STATE');
      const preview=this.#reworkPreview(work.id),feedback=text(input.feedback,'返工反馈');
      const selected=input.rerunWorkIds??[];
      requireValue(Array.isArray(selected) && new Set(selected).size===selected.length && selected.every(id=>preview.affected.some(a=>a.workId===id)),'返工范围须来自当前影响预览');
      if(preview.affected.length) {
        requireValue(actor.kind==='user','已消费结果的返工须由用户确认','FORBIDDEN');
        requireValue(input.impactToken===preview.impactToken,'返工影响已变化，请刷新预览','CONFLICT');
        for(const affected of preview.affected) {
          requireValue(!this.#db.prepare(`SELECT id FROM runs WHERE workId=? AND status IN ${activeRunSQL}`).get(affected.workId),'须先停止活动消费者','ACTIVE_CONSUMER');
          const consumer=this.#required('work',affected.workId);
          if(selected.includes(consumer.id)) {
            consumer.feedback=feedback;consumer.result=null;consumer.inputChanges=[];consumer.wait=null;
            consumer.status=consumer.modelConsent?'queued':'awaiting_model';
          } else consumer.inputChanges.push({workId:work.id,resultVersion:work.result?.version??null,at:timestamp,consumedResults:affected.consumedResults});
          this.#saveWork(consumer);this.#event('work.reworkImpact',consumer,actor,{sourceWorkId:work.id,rerun:selected.includes(consumer.id)});
        }
      }
      work.feedback=feedback;work.result=null;work.inputChanges=[];work.wait=null;
      work.status=work.modelConsent?'queued':'awaiting_model';
      return this.#saveWork(work);
    }
    if(input.type==='work.resume') {
      const work=this.#required('work',input.workId); this.#version(work,input);
      requireValue(work.status==='paused','只有已暂停任务可继续','INVALID_STATE');
      work.status=work.modelConsent?'queued':'awaiting_model';
      return this.#saveWork(work);
    }
    if(input.type==='work.steer') {
      const work=this.#required('work',input.workId); this.#version(work,input,true);
      const message=text(input.text,'干预内容');
      requireValue(['dispatching','running'].includes(work.status),'当前任务状态不支持干预','INVALID_STATE');
      const row=this.#db.prepare("SELECT body FROM runs WHERE workId=? AND status IN ('dispatching','accepted','running')").get(work.id);
      requireValue(row,'干预须有活动运行','INVALID_STATE');
      const run=JSON.parse(row.body);
      this.#put('control',{id:randomUUID(),workId:work.id,workspaceId:work.workspaceId,workflowId:work.workflowId,
        runId:run.id,sessionId:run.sessionId,requestId:randomUUID(),kind:'steer',text:message,
        status:'pending',attempts:0,actor,createdAt:timestamp});
      return this.#saveWork(work);
    }
    if(['work.pause','work.cancel'].includes(input.type)) {
      const work=this.#required('work',input.workId); this.#version(work,input);
      const kind=input.type==='work.pause'?'pause':'cancel';
      const target=kind==='pause'?'paused':'cancelled', requested=`${kind}_requested`;
      if([target,requested].includes(work.status)) return work;
      requireValue(work.status!=='accepted' && work.status!=='cancelled' && !(kind==='pause'&&work.status==='cancel_requested'),'当前任务状态不支持此控制','INVALID_STATE');
      const row=this.#db.prepare(`SELECT body FROM runs WHERE workId=? AND status IN ${activeRunSQL}`).get(work.id);
      if(row) {
        const run=JSON.parse(row.body);
        work.status=requested; run.status=requested; this.#put('run',run);
        for(const row of this.#db.prepare("SELECT body FROM controls WHERE workId=? AND status='pending'").all(work.id)) {
          const previous=JSON.parse(row.body); previous.status='superseded'; previous.updatedAt=timestamp;
          this.#put('control',previous);
        }
        const control={id:randomUUID(),workId:work.id,workspaceId:work.workspaceId,workflowId:work.workflowId,
          runId:run.id,sessionId:run.sessionId,requestId:randomUUID(),kind,status:'pending',attempts:0,actor,createdAt:timestamp};
        this.#put('control',control);
      } else work.status=target;
      return this.#saveWork(work);
    }
    if(input.type==='work.releaseGate') {
      requireValue(actor.kind==='user','人工关卡须由用户释放','FORBIDDEN');
      const work=this.#required('work',input.workId); this.#version(work,input,true);
      requireValue(work.gate && work.gate.required,'任务没有人工关卡','INVALID_STATE');
      work.gate.released=true; work.gate.release={actor,at:timestamp,workVersion:work.version};
      return this.#saveWork(work);
    }
    if(input.type==='work.accept') {
      requireValue(actor.kind==='user','验收须由用户确认','FORBIDDEN');
      const work=this.#required('work',input.workId); this.#version(work,input,true);
      requireValue(work.status==='review','任务须有待验收结果','INVALID_STATE');
      requireValue(input.runId===work.result.runId,'须验收当前运行结果','CONFLICT');
      const run=this.#required('run',input.runId);
      requireValue(run.status==='completed','运行须正常完成','INVALID_STATE');
      requireValue(this.#outputsComplete(work,run.outputs),'须补全必需输出','MISSING_OUTPUT');
      work.status='accepted';
      work.result.acceptance={actor,at:timestamp,runId:run.id,workVersion:work.version,resultVersion:work.result.version};
      return this.#saveWork(work);
    }
    fail('UNKNOWN_COMMAND',`未知命令：${input.type}`);
  }
}
