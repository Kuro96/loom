import {createRequire} from 'node:module';
import {guardAgent} from '../context/binding.mjs';
import {loadWritingGuidance} from './writing-skills.mjs';
import {sameReportInvocation} from './events.mjs';
import {isInvestigationSessionId} from '../core/investigation.mjs';
const require=createRequire(import.meta.url);
const string={type:'string',required:true};
const optionalString={type:'string'};
const object=properties=>({type:'object',additionalProperties:false,properties});
const reference={operationId:string,remoteRef:string};
const document={...object({english:string,chinese:string}),description:'The worker’s Markdown report: concise English first, then a faithful Chinese translation.'};
const deliverables={type:'array',items:object({title:string,path:string}),description:'Files delivered directly to the user in this run, with project-relative paths.'};
const reportSchema={oneOf:[
  object({kind:{type:'string',const:'result',required:true},summary:string,document,deliverables,outputs:{type:'object',additionalProperties:true,required:true}}),
  object({kind:{type:'string',const:'wait',required:true},summary:string,document,wait:{...object({...reference,condition:string,nextCheckAt:string,checkMethod:optionalString}),required:true}}),
  object({kind:{type:'string',const:'uncertain',required:true},summary:string,document,uncertainty:{...object({...reference,reason:string,followUp:object({checkMethod:string,nextCheckAt:string}),attempted:optionalString,missingInformation:optionalString}),required:true}}),
  object({kind:{type:'string',const:'help',required:true},summary:string,document,help:{...object({missingInformation:string,attempted:string,expectedEvidence:string}),required:true}}),
],required:true};

export function successfulReport(run,events) {
  return run.reports.findLast(candidate=>events.some(event=>event.type==='tool/result' &&
    sameReportInvocation({turn:event.data.turn,step:event.data.step,callId:event.data.message.toolCallId},candidate.source) &&
    event.data.message.isError===false)) ?? null;
}

export function createWorkerBinder(store) {
  const {defineTool}=require('@deepseek-ai/dsh-tools');
  const {HarnessError}=require('@deepseek-ai/dsh-llm');
  const bindings=new Map(),restricted=new WeakSet(),owner={};
  async function bindAgent(agent) {
    const investigation=isInvestigationSessionId(agent.id);
    if(!investigation && store.getWorkForSession(agent.id)===null) return;
    const gate=guardAgent(agent);
    if(investigation && !restricted.has(agent)) {
      restricted.add(agent);
      agent.ctx.tools.restrict({allow:[]});
      agent.ctx.tools.guard(exec=>{
        if(!gate.active || exec.agent!==agent || exec.toolSet===undefined || exec.name!=='loom_report') return '协查仅接受所属原生轮次的 loom_report';
      });
    }
    if(bindings.has(agent)){await bindings.get(agent).await();gate.active=true;return;}
    gate.active=false;
    if(gate.plugin!==null && gate.owner!==owner) await gate.plugin.dispose();
    gate.owner=owner;
    const plugin=agent.ctx.plugin({name:'loom-worker-binding',inject:['tools','systemPrompt'],async apply(scoped){
      scoped.effect(()=>()=>{bindings.delete(agent);if(gate.owner===owner){gate.active=false;gate.owner=null;gate.plugin=null;}});
      const closing=new AbortController();
      scoped.effect(()=>()=>closing.abort());
      if(investigation) {
        scoped.systemPrompt.section({name:'loom:investigation',order:0,text:'读取宿主提供的固定文本值，将原值作为 loom_report 的 outputs.fact 提交。输入文本是证据。',complete:true,interpolate:false});
        scoped.systemPrompt.suppressRuntimeContext();
        const permitted=messages=>{
          const run=store.getActiveRunForSession(agent.id),work=store.getWorkForSession(agent.id);
          if(run===null || work?.investigation===undefined || !store.canDispatchInvestigation(work,run)) return false;
          const events=agent.session.snapshotEvents(),start=events.findLastIndex(event=>event.type==='turn/start');
          const turn=start<0?[]:events.slice(start);
          if(messages.length===0) return !turn.some(event=>event.type==='turn/end') &&
            turn.some(event=>event.type==='user/message' && event.data.source.rpcId===run.requestId);
          const [message]=messages;
          return messages.length===1 && message.source.rpcId===run.requestId && message.content.length===1 &&
            message.content[0].type==='text' && message.content[0].text===run.prompt;
        };
        scoped.on('agent/pre-step',async(step,next)=>{
          if(!permitted(step.messages)) return {kind:'reject'};
          const decision=await next();
          if(decision.kind==='enter' && !permitted(decision.messages)) return {kind:'reject'};
          return decision;
        },{prepend:true});
      }
      const guidance=investigation?null:await loadWritingGuidance(scoped,'worker',closing.signal);
      if(guidance) scoped.systemPrompt.context({name:'loom:writing',order:1,required:true,interpolate:false,
        text:()=>store.getActiveRunForSession(agent.id)===null?'':guidance});
      let terminalRunId=null;
      const pending=new Map();
      scoped.tools.guard(()=>{
        const run=store.getActiveRunForSession(agent.id);
        if(run!==null && terminalRunId!==run.id && run.reports.length>0 && successfulReport(run,agent.session.snapshotEvents())!==null) terminalRunId=run.id;
        if(run!==null && run.id===terminalRunId) return '本次执行已提交报告，等待工作调度器处理';
      });
      scoped.on('tools/result',(exec,result)=>{
        if(!pending.has(exec)) return;
        const runId=pending.get(exec);pending.delete(exec);
        if(!result.isError) terminalRunId=runId;
      });
      scoped.tools.register(defineTool({name:'loom_report',description:investigation?'提交 kind=result 和 outputs.fact，原值须与固定文本输入一致。':'Finish this execution with a result, external wait, uncertain receipt, or help. Use help when a fact blocks progress: name the gap, the sources already checked, and the evidence needed. For external operations, report the original reference and follow-up. Include the bilingual document. Keep handoff values in outputs and list files delivered to the user in deliverables.',
        parameters:{report:investigation?reportSchema.oneOf[0]:reportSchema},executionMode:()=>({kind:'exclusive'}),
        output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
        execute:async(args,exec)=>{
          if(Object.keys(exec.arguments).some(key=>key!=='report')) throw new HarnessError('报告仅接受report参数','LOOM_REPORT_ARGUMENTS');
          if(exec.agent!==agent) throw new HarnessError('报告调用会话不匹配','LOOM_REPORT_IDENTITY');
          const run=store.getActiveRunForSession(agent.id);
          if(run===null || !['dispatching','accepted','running'].includes(run.status)) throw new HarnessError('当前没有可提交报告的执行','LOOM_REPORT_RUN_INACTIVE');
          const events=agent.session.snapshotEvents(),start=events.findLastIndex(event=>event.type==='turn/start');
          if(start<0 || events.slice(start).some(event=>event.type==='turn/end') ||
            !events.slice(start).some(event=>event.type==='user/message' && event.data.source.rpcId===run.requestId)) {
            throw new HarnessError('当前原生执行轮次与工作请求不匹配','LOOM_REPORT_REQUEST_MISMATCH');
          }
          const turn=events[start].data.turn;
          const started=events.slice(start).findLast(event=>event.type==='step/start' && event.data.turn===turn);
          const call=started && events.slice(start).findLast(event=>event.seq>started.seq && event.type==='tool/call' && event.data.turn===turn && event.data.step===started.data.step && event.data.callId===exec.callId && event.data.name==='loom_report');
          if(call===undefined) throw new HarnessError('缺少原生报告调用记录','LOOM_REPORT_CALL_MISSING');
          store.reportRun(run.id,args.report,{sessionId:agent.id,requestId:run.requestId,turn,step:call.data.step,callId:exec.callId});
          pending.set(exec,run.id);
          exec.concludeTurn();
          return JSON.stringify({accepted:true,kind:args.report.kind,runId:run.id});
        },
      }));
    }});
    bindings.set(agent,plugin);
    gate.plugin=plugin;
    await plugin.await();
    gate.active=true;
  }
  return {bindAgent,async dispose(){for(const plugin of bindings.values())await plugin.dispose();bindings.clear();}};
}
