export const isUserCleanupCommand=type=>['work.delete','use.cancel','use.delete'].includes(type);

export function requireValue(ok,message,code='INVALID_INPUT') {
  if(!ok) throw Object.assign(new Error(message),{code});
}
export function text(value,name) {
  requireValue(typeof value==='string' && value.trim().length>0,`${name}须为非空文字`);return value;
}
const unsafe=new Set(['__proto__','prototype','constructor']);
export function field(value) {
  requireValue(typeof value==='string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && !unsafe.has(value),'字段名格式错误');return value;
}
export function jsonValue(value,depth=0) {
  requireValue(depth<=32,'JSON嵌套超过32层');
  if(value===null || typeof value==='string' || typeof value==='boolean') return;
  if(typeof value==='number') {requireValue(Number.isFinite(value),'JSON数值须有限');return;}
  requireValue(value && typeof value==='object' && (Array.isArray(value) || Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null),'须为JSON值');
  if(Array.isArray(value)) {
    for(let i=0;i<value.length;i++) {requireValue(Object.hasOwn(value,i),'JSON数组须连续');jsonValue(value[i],depth+1);}
  } else for(const [key,v] of Object.entries(value)) {requireValue(!unsafe.has(key),'JSON字段名不安全');jsonValue(v,depth+1);}
}
export function bounded(value) {jsonValue(value);requireValue(Buffer.byteLength(JSON.stringify(value))<=256*1024,'定义或报告超过256KiB');}
function object(value,name) {requireValue(value && typeof value==='object' && !Array.isArray(value),`${name}须为对象`);}
function pathSchema(path,nonempty=false) {
  requireValue(Array.isArray(path) && path.length<9 && (!nonempty || path.length>0),'字段路径须为最多8段的数组');
  for(const part of path) requireValue(typeof part==='string' && part.length>0 && !unsafe.has(part),'字段路径格式错误');
  return [...path];
}
export function readPath(value,path) {
  for(const key of path) {
    if(value===null || typeof value!=='object' || !Object.hasOwn(value,key)) return {found:false};
    value=value[key];
  }
  return {found:true,value};
}
export function declarations(items=[]) {
  requireValue(Array.isArray(items) && items.length<=100,'参数或输出须为最多100项的数组');
  const result=items.map(item=>{
    object(item,'字段');field(item.name);
    requireValue(item.description===undefined || typeof item.description==='string','字段说明须为文字');
    requireValue(item.required===undefined || typeof item.required==='boolean','required须为布尔值');
    return {name:item.name,description:item.description??'',required:item.required??false,...(Object.hasOwn(item,'default')?{default:item.default}:{})};
  });
  requireValue(new Set(result.map(item=>item.name)).size===result.length,'字段名须唯一');return result;
}
function checkInputCount(inputs) {requireValue(Object.keys(inputs).length<=100,'输入最多100项');}
export function inputsSchema(inputs={},kind='stage') {
  object(inputs,'输入');checkInputCount(inputs);
  return Object.fromEntries(Object.entries(inputs).map(([name,ref])=>{
    field(name);object(ref,'输入引用');
    if(ref.kind==='value') {requireValue(Object.hasOwn(ref,'value'),'输入缺少value');jsonValue(ref.value);return [name,{kind:'value',value:ref.value}];}
    if(kind==='stage' && ref.kind==='parameter') return [name,{kind:'parameter',path:pathSchema(ref.path,true)}];
    requireValue(ref.kind===(kind==='stage'?'output':'result'),'输入来源格式错误');
    const id=kind==='stage'?'stageId':'workId';
    return [name,{kind:ref.kind,[id]:text(ref[id],id),output:field(ref.output),path:pathSchema(ref.path??[])}];
  }));
}
export function checksSchema(checks=[]) {
  requireValue(Array.isArray(checks),'检查须为数组');
  return checks.map(c=>{
    object(c,'检查');
    if(c.kind==='file') {
      text(c.path,'文件路径');requireValue(c.contains===undefined || typeof c.contains==='string','文件检查内容须为文字');
      return {kind:'file',path:c.path,...(c.contains===undefined?{}:{contains:c.contains})};
    }
    requireValue(c.kind==='command','检查类型须为file或command');text(c.command,'检查命令');
    requireValue(c.args===undefined || (Array.isArray(c.args)&&c.args.every(a=>typeof a==='string')),'命令参数须为文字数组');
    requireValue(c.expectedExit===undefined || c.expectedExit===0,'命令预期退出码须为0');
    return {kind:'command',command:c.command,args:c.args??[],expectedExit:0};
  });
}
function applyStageInputs(index,stageInputs) {
  requireValue(Array.isArray(stageInputs),'stageInputs须为数组');bounded(stageInputs);
  const seen=new Set();
  for(const item of stageInputs) {
    object(item,'步骤输入覆盖');
    requireValue(Object.keys(item).every(k=>['stageId','name','value'].includes(k)),'步骤输入覆盖仅支持stageId、name、value');
    const stage=index.get(item.stageId),name=field(item.name);
    requireValue(stage,'步骤输入覆盖的步骤不存在');
    requireValue(Object.hasOwn(item,'value'),'步骤输入覆盖缺少value');
    const key=JSON.stringify([stage.id,name]);
    requireValue(!seen.has(key),`步骤 ${stage.id} 的 ${name} 重复覆盖`);seen.add(key);
    requireValue(!Object.hasOwn(stage.inputs,name) || stage.inputs[name].kind==='value',`步骤 ${stage.id} 的 ${name} 已绑定其他来源`);
    stage.inputs[name]={kind:'value',value:item.value};
    checkInputCount(stage.inputs);
  }
}
export function definitionSchema(definition,stageInputs) {
  bounded(definition);object(definition,'工作流定义');text(definition.title,'工作流标题');
  const {stages}=definition;
  requireValue(Array.isArray(stages) && stages.length>0 && stages.length<=1000,'工作流须含1至1000步骤');
  const parameters=declarations(definition.parameters);
  for(const key of ['description','knowledge']) requireValue(definition[key]===undefined || typeof definition[key]==='string',`${key}须为文字`);
  const result=stages.map(s=>{
    object(s,'步骤');
    for(const key of ['instructions','scope']) requireValue(s[key]===undefined || typeof s[key]==='string',`${key}须为文字`);
    requireValue(s.manualGate===undefined || typeof s.manualGate==='boolean','人工关卡须为布尔值');
    requireValue(s.dependsOn===undefined || (Array.isArray(s.dependsOn) && new Set(s.dependsOn).size===s.dependsOn.length),'步骤依赖须为唯一ID数组');
    return {id:text(s.id,'步骤ID'),title:text(s.title,'步骤标题'),instructions:s.instructions??'',scope:s.scope??'工作区内的当前任务',dependsOn:[...(s.dependsOn??[])],manualGate:s.manualGate??false,checks:checksSchema(s.checks),inputs:inputsSchema(s.inputs),outputs:declarations(s.outputs)};
  });
  const index=new Map(result.map(s=>[s.id,s]));requireValue(index.size===result.length,'步骤ID须唯一');
  if(stageInputs!==undefined) applyStageInputs(index,stageInputs);
  for(const stage of result) {
    for(const ref of Object.values(stage.inputs)) {
      if(ref.kind==='parameter') requireValue(parameters.some(p=>p.name===ref.path[0]),'参数不存在');
      if(ref.kind==='output') {
        requireValue(index.has(ref.stageId),'输出来源步骤不存在','INVALID_DEPENDENCY');
        requireValue(index.get(ref.stageId).outputs.some(o=>o.name===ref.output),'输出声明不存在','INVALID_DEPENDENCY');
        if(!stage.dependsOn.includes(ref.stageId)) stage.dependsOn.push(ref.stageId);
      }
    }
    for(const id of stage.dependsOn) requireValue(index.has(id),'步骤依赖不存在','INVALID_DEPENDENCY');
  }
  const visited=new Set(),visiting=new Set();
  function visit(id) {
    requireValue(!visiting.has(id),'步骤依赖存在环','DEPENDENCY_CYCLE');if(visited.has(id)) return;
    visiting.add(id);for(const dep of index.get(id).dependsOn) visit(dep);visiting.delete(id);visited.add(id);
  }
  for(const stage of result) visit(stage.id);
  const normalized={title:definition.title,description:definition.description??'',knowledge:definition.knowledge??'',parameters,stages:result};
  bounded(normalized);return normalized;
}
export function zonedTime(value) {
  requireValue(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),'时间须为带时区有效时间');
  const local=new Date(value.slice(0,19)+'Z');
  requireValue(Number.isFinite(local.getTime()) && local.toISOString().slice(0,19)===value.slice(0,19),'时间包含无效日期或时刻');
  return Date.parse(value);
}
export function documentSchema(document) {
  object(document,'报告正文');
  requireValue(Object.keys(document).every(k=>k==='english' || k==='chinese'),'报告正文仅支持english和chinese');
  text(document.english,'英文正文');text(document.chinese,'中文正文');
}
function checkDeliverables(items) {
  requireValue(Array.isArray(items) && items.length<=100,'交付文件须为最多100项的数组');
  for(const item of items) {
    object(item,'交付文件');requireValue(Object.keys(item).every(k=>k==='title' || k==='path'),'交付文件仅支持title和path');
    text(item.title,'文件标题');const path=text(item.path,'文件路径');
    const parts=path.split(/[\\/]/);
    const portable=p=>p.length>0 && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p);
    requireValue(!/[:<>"|?*\x00-\x1f]/.test(path) && parts.at(-1)!=='.' && parts.every(p=>p==='.' || portable(p)),
      '交付文件须使用项目内的相对文件路径');
  }
}
export function reportSchema(report,work) {
  bounded(report);object(report,'报告');
  const forbidden=new Set(['actor','authorization','autoAccept','modelConsent','checksConsent','permissionPreset','workId','runId','sessionId','requestId','workspaceId','workflowId','useId','source','callId','turn','expectedVersion']);
  function visit(value) {
    if(value===null || typeof value!=='object') return;
    for(const [key,nested] of Object.entries(value)) {requireValue(!forbidden.has(key),`报告含身份或授权字段：${key}`);visit(nested);}
  }
  visit(report);
  requireValue(['result','wait','uncertain'].includes(report.kind),'报告类型错误');
  requireValue(typeof report.summary==='string','报告摘要须为文字');
  const payload=report.kind==='result'?'outputs':report.kind==='wait'?'wait':'uncertainty';
  const allowed=['kind','summary','document',payload];
  if(report.kind==='result') allowed.push('deliverables');
  requireValue(Object.keys(report).every(k=>allowed.includes(k)),'报告格式错误');object(report[payload],'报告内容');
  if(report.document!==undefined) documentSchema(report.document);
  if(report.kind==='result') {
    if(report.deliverables!==undefined) checkDeliverables(report.deliverables);
    for(const name of Object.keys(report.outputs)) requireValue(work.outputs.some(o=>o.name===name),'报告含未声明输出');
  } else {
    const value=report[payload],allowed=report.kind==='wait'?['operationId','remoteRef','condition','nextCheckAt']:['operationId','remoteRef','reason'];
    requireValue(Object.keys(value).every(k=>allowed.includes(k)),'外部操作格式错误');
    requireValue(value.operationId===work.id,'operationId须对应当前工作');text(value.remoteRef,'远端引用');
    if(report.kind==='wait') {
      text(value.condition,'等待条件');const due=zonedTime(value.nextCheckAt),current=Date.now();
      requireValue(due>current && due-current<=30*24*60*60*1000,'恢复时间须在未来30天内');
    } else text(value.reason,'结果不明原因');
  }
  return report;
}
export function parameterValues(definition,values={}) {
  bounded(values);object(values,'参数');
  for(const key of Object.keys(values)) requireValue(definition.parameters.some(p=>p.name===key),'未知参数');
  const result={};
  for(const p of definition.parameters) {
    if(Object.hasOwn(values,p.name)) result[p.name]=values[p.name];
    else if(Object.hasOwn(p,'default')) result[p.name]=p.default;
    else requireValue(!p.required,`缺少参数：${p.name}`);
  }
  for(const stage of definition.stages) for(const ref of Object.values(stage.inputs)) {
    if(ref.kind==='parameter') requireValue(readPath(result,ref.path).found,`参数路径不存在：${ref.path.join('.')}`);
  }
  return result;
}
