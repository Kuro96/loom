import {createRequire} from 'node:module';
import {guardAgent} from '../context/binding.mjs';
const require=createRequire(import.meta.url);
const string={type:'string',required:true};
const object=properties=>({type:'object',additionalProperties:false,properties});
const reference={operationId:string,remoteRef:string};
const document={...object({english:string,chinese:string}),description:'The worker’s Markdown report: concise English first, then a faithful Chinese translation.'};
const deliverables={type:'array',items:object({title:string,path:string}),description:'Files delivered directly to the user in this run, with project-relative paths.'};
const reportSchema={oneOf:[
  object({kind:{type:'string',const:'result',required:true},summary:string,document,deliverables,outputs:{type:'object',additionalProperties:true,required:true}}),
  object({kind:{type:'string',const:'wait',required:true},summary:string,document,wait:{...object({...reference,condition:string,nextCheckAt:string}),required:true}}),
  object({kind:{type:'string',const:'uncertain',required:true},summary:string,document,uncertainty:{...object({...reference,reason:string}),required:true}}),
],required:true};

export function successfulReport(run,events) {
  return run.reports.findLast(candidate=>events.some(event=>event.type==='tool/result' &&
    event.data.turn===candidate.source.turn && event.data.message.toolCallId===candidate.source.callId &&
    event.data.message.isError===false)) ?? null;
}

export function createWorkerBinder(store) {
  const {defineTool}=require('@deepseek-ai/dsh-tools');
  const {HarnessError}=require('@deepseek-ai/dsh-llm');
  const bindings=new Map(),owner={};
  async function bindAgent(agent) {
    if(store.getWorkForSession(agent.id)===null) return;
    const gate=guardAgent(agent);
    if(bindings.has(agent)){await bindings.get(agent).await();gate.active=true;return;}
    gate.active=false;
    if(gate.plugin!==null && gate.owner!==owner) await gate.plugin.dispose();
    gate.owner=owner;
    const plugin=agent.ctx.plugin({name:'loom-worker-binding',inject:['tools','systemPrompt'],apply(scoped){
      scoped.effect(()=>()=>{bindings.delete(agent);if(gate.owner===owner){gate.active=false;gate.owner=null;gate.plugin=null;}});
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
      scoped.tools.register(defineTool({name:'loom_report',description:'Finish this execution with a result, external wait, or uncertain receipt. Include your bilingual document even for results with no files or named outputs. Use an applicable reporting skill if available. Keep handoff values in outputs and list only files actually delivered to the user in deliverables.',
        parameters:{report:reportSchema},executionMode:()=>({kind:'exclusive'}),
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
          store.reportRun(run.id,args.report,{sessionId:agent.id,requestId:run.requestId,turn:events[start].data.turn,callId:exec.callId});
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
