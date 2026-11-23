import { contextError, jsonBytes, prefixDigest } from './budget.mjs';
export function summarizeValue(value,depth=0) {
  if(typeof value==='string') return value.length<=240?value:{text:value.slice(0,240),truncated:true,bytes:jsonBytes(value),sha256:prefixDigest(value)};
  if(value && typeof value==='object') {
    if(depth>7) return {truncated:true,kind:Array.isArray(value)?'array':'object',total:Object.keys(value).length};
    if(Array.isArray(value)) {
      const items=value.slice(0,20).map(item=>summarizeValue(item,depth+1));
      return value.length>20?{items,total:value.length,truncated:true}:items;
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,summarizeValue(item,depth+1)]));
  }
  return value;
}
const TARGET_KEYS={work:'workId',workflow:'workflowId',use:'useId',workspace:'workspaceId',run:'runId',intent:'intentId',event:'eventId',control:'controlId',rework:'workId'};
function queryLimit(value,maximum) {
  if(!Number.isSafeInteger(value)||value<1) throw contextError('LOOM_QUERY_LIMIT','Query limit must be a positive integer');
  return Math.min(value,maximum);
}
function assertQueryBudget(value,config) {
  if(jsonBytes(value)>config.queryMaxBytes) throw contextError('LOOM_QUERY_BUDGET','Query metadata exceeds queryMaxBytes');
  return value;
}
async function queryDetail(request,{query,config}) {
  const key=TARGET_KEYS[request.kind],id=request[key];
  if(!key || typeof id!=='string' || id.length===0) throw contextError('LOOM_QUERY_TARGET','Detail requires the exact target ID');
  const section=request.section===undefined?[]:typeof request.section==='string'?[request.section]:request.section;
  if(!Array.isArray(section) || section.length>40 || section.some(key=>typeof key!=='string' || ['__proto__','prototype','constructor'].includes(key))) throw contextError('LOOM_QUERY_SECTION','Section must be an own-property path');
  const offset=request.offset??0,limit=queryLimit(request.limit??config.queryMaxBytes,config.queryMaxBytes);
  if(!Number.isSafeInteger(offset) || offset<0) throw contextError('LOOM_QUERY_OFFSET','Detail offset must be a nonnegative integer');
  const targetRequest={kind:request.kind,[key]:id};
  for(const name of ['workspaceId','workflowId','workId','useId','legacy']) if(Object.hasOwn(request,name)) targetRequest[name]=request[name];
  let target;
  if(request.kind==='rework') target=await query(targetRequest);
  else {
    let after;
    do {
      const page=await query({...targetRequest,limit:50,...(after?{after}:{})});
      target=page.items.find(item=>item.id===id);
      after=page.nextCursor;
    } while(!target && after);
  }
  if(!target) throw contextError('NOT_FOUND','Detail target does not exist');
  let selected=target;
  for(const name of section) {
    if(selected===null || typeof selected!=='object' || !Object.hasOwn(selected,name)) throw contextError('LOOM_QUERY_SECTION','Detail section does not exist');
    selected=selected[name];
  }
  const revision=prefixDigest(target);
  if(request.revision!==undefined && request.revision!==revision) throw contextError('CONFLICT','Detail changed; restart from offset 0');
  const characters=Array.from(JSON.stringify(selected)),total=characters.length;
  if(offset>total) throw contextError('LOOM_QUERY_OFFSET','Detail offset exceeds the section length');
  function page(count) {
    const nextOffset=offset+count;
    const next=nextOffset<total?{...targetRequest,detail:true,section,offset:nextOffset,limit,revision}:null;
    return {kind:request.kind,id,version:target.version,detail:true,section,revision,encoding:'json',unit:'codePoints',offset,count,total,text:characters.slice(offset,nextOffset).join(''),truncated:next!==null,next};
  }
  let count=Math.min(limit,total-offset);
  while(count>0 && jsonBytes(page(count))>config.queryMaxBytes) count=Math.floor(count/2);
  if(count===0 && offset<total) throw contextError('LOOM_QUERY_BUDGET','Detail cursor and one character exceed queryMaxBytes');
  return assertQueryBudget(page(count),config);
}
function detailRequest(kind,item) {
  return {kind,[TARGET_KEYS[kind]]:kind==='rework'?item.workId:item.id,detail:true,...(kind==='workflow'?{legacy:'all'}:{})};
}
function compactItem(item,kind) {
  const summary=Object.fromEntries(['id','workspaceId','workflowId','useId','workId','version','status','sessionId','segment'].filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]]));
  return {...summary,truncated:true,detailRequest:detailRequest(kind,item)};
}
export async function querySummary(request,dependencies) {
  const {query,state,config}=dependencies;
  if(request.kind==='bus.display') return resolveDisplayed(request,dependencies);
  if(request.kind==='project.sessionSearch') {
    if(!dependencies.searchProjectSessions) throw contextError('LOOM_SESSION_SEARCH_UNAVAILABLE','原生会话搜索不可用');
    return assertQueryBudget(await dependencies.searchProjectSessions(request),config);
  }
  if(request.detail===true) return queryDetail(request,dependencies);
  if(request.kind==='rework') {
    const result=await query(request);
    let summary={...summarizeValue(result),summaryOnly:true,detailRequest:detailRequest('rework',result)};
    if(jsonBytes(summary)>config.queryMaxBytes) summary={workId:result.workId,version:result.version,impactToken:result.impactToken,affected:{total:result.affected.length,truncated:true},summaryOnly:true,truncated:true,detailRequest:detailRequest('rework',result)};
    return assertQueryBudget(summary,config);
  }
  const history=request.kind==='bus.history';
  let limit=queryLimit(request.limit??config.queryLimit,Math.min(config.queryLimit,50));
  while(true) {
    const result=history?state.history({cursor:request.after,limit}):await query({...request,limit});
    let page={...result,items:result.items.map(item=>summarizeValue(item)),summaryOnly:true};
    if(jsonBytes(page)>config.queryMaxBytes && limit===1 && !history) page={...page,items:result.items.map(item=>compactItem(item,request.kind)),truncated:true};
    if(jsonBytes(page)<=config.queryMaxBytes) return page;
    if(limit===1) throw contextError('LOOM_QUERY_BUDGET','A query summary exceeds queryMaxBytes');
    limit=Math.max(1,Math.floor(limit/2));
  }
}
const DISPLAY_KINDS=new Set(['work','workflow','use','workspace']);

async function displayRecord(query,kind,id) {
  const page=await query({kind,[TARGET_KEYS[kind]]:id,...(kind==='workflow'?{legacy:'all'}:{})});
  return page.items.find(item=>item.id===id);
}

async function prepareDisplay(request,query) {
  if(!Array.isArray(request.display) || request.display.length<1 || request.display.length>12 || Object.keys(request).length!==1) {
    throw contextError('LOOM_DISPLAY_INVALID','编号清单需要 1–12 项，按回复顺序提交 kind 和 id');
  }
  const labels=new Set(), identities=new Set(), items=[];
  for(const ref of request.display) {
    if(!ref || !DISPLAY_KINDS.has(ref.kind) || typeof ref.id!=='string' || !ref.id || identities.has(ref.id)) {
      throw contextError('LOOM_DISPLAY_INVALID','编号清单需要唯一且明确的对象');
    }
    const record=await displayRecord(query,ref.kind,ref.id);
    if(!record) throw contextError('NOT_FOUND','清单对象已不存在');
    const title=ref.kind==='use'?record.definitionSnapshot.title:record.title;
    const label=title.replace(/\s+/gu,' ').trim().slice(0,120).replace(/[\\`*_{}\[\]<>#!|~&]/g,'\\$&');
    if(labels.has(label)) throw contextError('LOOM_DISPLAY_INVALID','清单标题重复，请先用项目和名称澄清所指对象');
    labels.add(label);identities.add(ref.id);
    items.push({kind:ref.kind,id:ref.id,workspaceId:record.workspaceId,version:record.version,label});
  }
  return {items,text:'本次清单（编号可引用）\n\n'+items.map(({label},i)=>`${i+1}. ${label}`).join('\n')};
}

async function resolveDisplayed(request,{query,state,config}) {
  const {display}=state.value;
  const item=Number.isSafeInteger(request.position) && request.position>0 ? display?.items[request.position-1] : undefined;
  if(!item || (request.replyId!==undefined && request.replyId!==display.replyId)) {
    throw contextError('LOOM_REFERENCE_UNCLEAR','请用户确认所指清单、项目或对象名称');
  }
  const current=await displayRecord(query,item.kind,item.id);
  if(!current || current.workspaceId!==item.workspaceId) throw contextError('LOOM_REFERENCE_UNCLEAR','编号对应的对象已变化，请与用户核对');
  const source={replyId:display.replyId,sessionId:display.sessionId,shownAt:display.shownAt,position:request.position,workspaceId:item.workspaceId,shownVersion:item.version};
  const result={source,items:[summarizeValue(current)]};
  if(jsonBytes(result)>config.queryMaxBytes) result.items=[compactItem(current,item.kind)];
  return assertQueryBudget(result,config);
}

export function commandSummary(result,config) {
  const target=result.use??result;
  const waiting=target.status==='proposed' || target.status==='awaiting_model';
  const notice=waiting?{waitingFor:'user_confirmation',nextAction:'在工作台「工作 → 待处理」打开本次提案，核对项目、输入、输出、完成条件、模型及操作范围后确认。'}:{};
  let summary={...summarizeValue(result),...notice};
  if(jsonBytes(summary)>config.queryMaxBytes) {
    const kind=target.definitionSnapshot && target.workIds?'use':target.stages?'workflow':Object.hasOwn(target,'modelRevision')?'work':target.status==='pending'||target.status==='resolved'?'intent':'workspace';
    const compact=compactItem(target,kind);
    summary={...(result.use?{use:compact,works:result.works.length?{total:result.works.length,truncated:true}:[]}:compact),summaryOnly:true,truncated:true,...notice};
  }
  return assertQueryBudget(summary,config);
}

const REPORT_GUIDANCE='跟进时，用 loom_query 查询本项目 kind:work、categories:["interaction"] 及用户所指的工作。按 workId 查询 run，按 reportCallId 核对本次已选报告、等待原因和预验收证据；用有界详情读完整内容。处理需要用户决定的工作时（区别于只读进度查询），总控必须用 work.addReport:{workId,runId,expectedVersion,title,document:{english,chinese},idempotencyKey?} 追加独立的决定说明；需要归纳时可追加综合报告。查看 work.documents 避免重复。结合证据写清选项及影响，优先使用可用且适用的报告技能，先用简短英文陈述，再忠实译为中文。实施者原文与总控说明分开保留，预验收结论仅作证据。';

const PROPOSAL_GUIDANCE='项目、目标和关键输入明确时，先核对既有工作和可用工作流；有适用工作流用 workflow.start，否则用 use.create。同一轮只发布一批新工作。要求先审阅时传 reviewRequired:true。发布后按回执说明已排队或待确认。仅在用户要求复用模板时保存工作流。重复请求展示既有记录，追加要求沿用目标和版本。进度查询、讨论及聊天草稿使用只读路径。缺少会改变结果的关键事实时，复用或保存 intent.create，再询问所缺信息；找到目标后用 intent.resolve 关联。';

export const BUS_TOOL_GUIDANCE = `面向用户统一使用“项目、工作、工作流”。项目对应原生Workspace；工作完成一组具体输入的目标；工作流保存可复用步骤说明。use是内部提案和工作归组记录。
${PROPOSAL_GUIDANCE}普通回执说明项目、工作和下一步；影响决定时再列出相关检查或权限。工作台与总控读取同一份持久记录。
保存工作流需至少一步。已验收工作可用完整定义、sourceWorkIds和sourceVersions保存。换输入复用创建新工作；同目标返工保留原工作和会话。工作流编辑仅影响后续使用；已创建工作保持采用的定义和输入。
使用有界详情核对完整说明及输入输出；截断摘要仅供索引，next包含下一页请求。下游输入绑定实际结果与版本，缺少结果保持等待。外部等待保存远端引用、条件和恢复时间；恢复先核原操作。取消本地跟踪后仍保留远端引用。
返工前查询rework影响；已有消费者时展示影响和重跑范围，等待用户确认。确认、授权、模型及检查同意、人工关卡和最终验收经用户API提交；工具入口固定agent身份。${REPORT_GUIDANCE}`;

const QUERY_DESCRIPTION='查询项目、工作、工作流及内部记录。JSON {kind:work|workflow|use|workspace|intent|run|event|control|rework|bus.history|bus.display,workspaceId?,workflowId?,workId?,useId?,legacy?:false|true|"all",status?,categories?,after?,limit?}。列表以nextCursor作为after；rework需要workId。详情加detail:true、精确目标ID（workId/workflowId/useId/workspaceId/runId/intentId/eventId/controlId）、section?:顶层字段名或字段路径数组、offset?:0、limit?。详情text为所选值JSON的Unicode字符片段；按next请求全部页，拼接text后JSON.parse。revision变化须从0重读。全部输出受queryMaxBytes限制。用户说“第二项”等序号时，以 {kind:"bus.display",position:2,replyId?} 核对已发布清单和对象当前版本，再用明确 ID、当前版本提交操作。其他清单或来源不明时先澄清。';
const COMMAND_DESCRIPTION=`提交工作提案与普通业务修改，JSON {type,idempotencyKey?,expectedVersion?,...fields}。${PROPOSAL_GUIDANCE}
use.create:{workspaceId,definition,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?,reviewRequired?}执行一次；workflow.start:{workflowId,expectedVersion,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?,reviewRequired?}使用已有工作流。两者返回{use,works}；proposed 表示等待确认，confirmed 表示已生成工作并进入调度。use.update:{useId,expectedVersion,definition?,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?}编辑待确认提案；stageInputs 为 [{stageId,name,value}]。
workflow.create:{workspaceId,title,description?,knowledge?,parameters?,stages,sourceWorkIds?,sourceVersions?}保存至少一步的工作流定义，执行提案经 workflow.start 另建。完成后保存需同项目已验收 sourceWorkIds 及精确 sourceVersions。workflow.update:{workflowId,expectedVersion,definition}只影响后续使用。definition:{title,description?,knowledge?,parameters?:[{name,description?,required?,default?}],stages:[{id,title,instructions?,scope?,dependsOn?,manualGate?,checks?,inputs?,outputs?}]}；步骤 inputs 为具名{kind:value,value}|{kind:parameter,path}|{kind:output,stageId,output,path?}，outputs 为 [{name,description?,required?}]。
work.create:{workspaceId,title,description?,scope?,model?,permissionPreset?,sessionId?,dependsOn?,manualGate?,checks?,inputs?,outputs?,reviewRequired?}创建独立工作；queued 表示进入调度，awaiting_model 表示等待确认。输入采用 value 或 {kind:result,workId,output,path?}。work.steer:{workId,text,expectedVersion}用于正在调度或运行的工作；work.rework:{workId,feedback,expectedVersion}先查 rework，有消费者时等待用户确认影响和重跑范围。work.pause/work.cancel/work.resume:{workId,expectedVersion?}；待补外部信息由用户在工作台提交。work.setModel:{workId,model}；work.setChecks:{workId,checks}。
intent.create:{text} 保存待澄清请求；intent.resolve:{intentId,workspaceId,workId?|useId?} 关联同项目的一个目标。workspace.setKnowledge/workflow.setKnowledge:{对应ID,knowledge,expectedVersion?}。提案确认、模型及命令检查同意、授权、关卡与验收由用户 API 提交。`;

const AUTHORITY_FIELDS=new Set(['actor','authorization','modelConsent','checksConsent','confirmation']);
function toolRequest(args,name) {
  if(Object.keys(args).some(key=>key!=='request')) throw contextError('LOOM_TOOL_ARGUMENTS','Tool arguments accept only request');
  const request=JSON.parse(args.request);
  if(!request || typeof request!=='object' || Array.isArray(request)) throw contextError('LOOM_TOOL_ARGUMENTS','Request must be a JSON object');
  function visit(value,depth=0) {
    if(depth>40) throw contextError('LOOM_TOOL_ARGUMENTS','Request nesting exceeds 40 levels');
    if(value===null || typeof value!=='object') return;
    for(const [key,item] of Object.entries(value)) {
      const authority=AUTHORITY_FIELDS.has(key) || (depth>0 && ['autoAccept','permissionPreset','sessionId','requestId','callId','turn'].includes(key));
      if((name==='loom_command' && authority) || ['__proto__','prototype','constructor'].includes(key)) throw contextError('LOOM_TOOL_AUTHORITY',`Identity and consent come from the command boundary: ${key}`);
      visit(item,depth+1);
    }
  }
  visit(request);
  return request;
}
function scopedWaitQuery(request,scope) {
  if(scope===null) return request;
  if(request.kind==='project.sessionSearch' && request.workId===scope.workId) return request;
  if(['work','run','event','workflow','use','workspace'].includes(request.kind) &&
    (request.workspaceId===undefined || request.workspaceId===scope.workspaceId)) return {...request,workspaceId:scope.workspaceId};
  throw contextError('FORBIDDEN','自动复查只能查询本项目及当前外部操作');
}

export function createContextTools({defineTool,query,command,state,config,sessionId,stageDisplay,searchProjectSessions,waitScope=()=>null}) {
  return [
    ['loom_query',QUERY_DESCRIPTION+' 外部等待时可查询 {kind:"project.sessionSearch",workId,query,offset?,beforeSeq?}，搜索本项目会话并返回有来源的摘录；next 非空时可原样查询下一页。',request=>querySummary(scopedWaitQuery(request,waitScope()),{query,state,config:config(),searchProjectSessions})],
    ['loom_command',COMMAND_DESCRIPTION+REPORT_GUIDANCE+' work.resolveWait:{workId,expectedVersion,operationId,sources:[string],action:"continue"|"wait"|"ask",idempotencyKey?}。继续时附 information（交接给原工作会话）；复查时附 condition、checkMethod、nextCheckAt；只有关键线索缺失时用 ask 并附具体 missingInformation。',async request=>commandSummary(await command(request,{kind:'agent',sessionId}),config())],
    ['loom_focus','保存项目、工作、工作流焦点。JSON {workspaceId?,workflowId?,workId?,useId?,constraints?,references?,latestIntent?}。向用户发布可按序号指代的清单时，单独调用 {display:[{kind,id},...]}，按实际展示顺序传入项目(workspace)、工作(work)、工作流(workflow)或批次(use)。把返回的 text 原样作为最终回复；同一轮正式回复匹配后，编号才可引用。',async request=>{
      if(waitScope()!==null) throw contextError('FORBIDDEN','自动复查不更新用户会话焦点');
      if(!Object.hasOwn(request,'display')) return assertQueryBudget(summarizeValue(state.setFocus(request)),config());
      if(stageDisplay===undefined) throw contextError('LOOM_DISPLAY_INVALID','编号清单需要总控对话');
      const draft=await prepareDisplay(request,query);
      const response=assertQueryBudget({text:draft.text},config());
      stageDisplay(draft);
      return response;
    }],
  ].map(([name,description,execute])=>defineTool({name,description,parameters:{request:{type:'string',required:true,description:'JSON request'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async args=>JSON.stringify(await execute(toolRequest(args,name)))}));
}
