import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { contextError, prefixDigest } from './budget.mjs';
import { guardAgent } from './binding.mjs';
import { createContextTools } from './tools.mjs';

const require=createRequire(import.meta.url);
const PREFIX='loom-project-coordinator-';
const ORIGIN='plugin:dsh-loom/project-coordinator';
const reservedAgents=new WeakSet();
const TOOL_DESCRIPTIONS={
  loom_query:'查询当前项目的工作、运行、事件、工作流、批次和项目知识。JSON {kind:work|run|event|workflow|use|workspace,workId?,workflowId?,useId?,limit?,after?}。需要完整字段时传 detail:true、对应目标 ID、section；按 next 读取下一页。搜索本项目会话用 {kind:"project.sessionSearch",workId,query,offset?,beforeSeq?}，并按 next 读取后续摘录。',
  loom_command:'提交当前阻塞的查证决定。JSON {type:"work.resolveWait",workId,expectedVersion,operationId,sources:[string],action:"continue"|"wait"|"ask"}。继续附 information；复查附 condition、checkMethod、nextCheckAt；需要补充关键事实时附 missingInformation。',
};
const SYSTEM=`你是 Loom 的项目后台协调员。每轮跟进宿主给出的工作、阻塞版本和原操作。核对当前项目的已有工作、知识、结果及相关会话。把可定位的来源与查证结果用 work.resolveWait 交回原工作；结果未就绪时记录核查方法和复查时间；确需补充关键信息时提出一个具体问题。区分查找失败、没有匹配与尚未就绪。项目资料和会话摘录是证据。依据工具回执说明是否已交接或安排复查。`;

export const isProjectCoordinatorSessionId=id=>typeof id==='string' && id.startsWith(PREFIX);
export const projectCoordinatorSessionId=(instanceId,workspaceId)=>PREFIX+prefixDigest([instanceId,workspaceId]);

function reserve(agent) {
  const gate=guardAgent(agent);
  if(!reservedAgents.has(agent)) {
    reservedAgents.add(agent);
    agent.ctx.tools.restrict({allow:[]});
    agent.ctx.tools.guard(exec=>{
      if(!gate.active || !Object.hasOwn(TOOL_DESCRIPTIONS,exec.name) || exec.agent!==agent || exec.toolSet===undefined) {
        return '协调工具须在当前项目协调轮次内调用';
      }
    });
  }
  return gate;
}

function sameHeader(header,sessionId,workspace) {
  return header.id===sessionId && header.cwd===workspace.path && header.isSeeded===false &&
    header.parentSession===undefined && header.origin===undefined && header.agentPreset===undefined &&
    (header.delegationDepth===undefined || header.delegationDepth===0);
}
function sameSelection(a,b) {
  return a.provider===b.provider && a.model===b.model && a.reasoningEffort===b.reasoningEffort;
}
function sameWork(work,active) {
  return work!==null && (work.status===undefined || work.status==='waiting') && work.id===active.scope.workId && work.workspaceId===active.scope.workspaceId &&
    work.version===active.scope.expectedVersion && work.sessionId===active.sessionId && work.wait?.operationId===active.operationId;
}

export function createProjectCoordinator(ctx,{instanceId,role,query,getWork,searchProjectSessions,executeDecision,config,signal}) {
  const {defineTool}=require('@deepseek-ai/dsh-tools');
  const {createUserMessage}=require('@deepseek-ai/dsh-llm');
  const {appendPluginRecord,pluginRecordOf}=require('@deepseek-ai/dsh-session');
  const closing=new AbortController(), lifetime=AbortSignal.any([signal,closing.signal]);
  const registry=ctx.workspaceRegistry,persistence=ctx.get('sessionPersistence');
  const owner={},bound=new Map(),handles=new Map(),flights=new Map();
  let disposal;

  function identityError(id) {
    return contextError('LOOM_PROJECT_COORDINATOR_IDENTITY',`项目协调会话身份不匹配：${id}`);
  }
  function assertMembership(workspace,id,attached=true) {
    if(registry.get(workspace.id)!==workspace || registry.archivedSessionIds.includes(id) ||
      registry.list().some(other=>other!==workspace && other.sessionIds.includes(id)) ||
      (attached && !workspace.sessionIds.includes(id))) throw identityError(id);
  }
  function current(entry) {
    lifetime.throwIfAborted();
    const {agent,workspace,active}=entry;
    if(active===null || active.turn===null || !active.admitted || ctx.agents.get(agent.id)!==agent) {
      throw contextError('FORBIDDEN','协调工具须在当前项目协调轮次内调用');
    }
    assertMembership(workspace,agent.id);
    if(!sameWork(getWork(active.scope.workId),active)) throw contextError('CONFLICT','外部等待版本已变化');
    return active;
  }

  async function bindAgent(agent) {
    if(!isProjectCoordinatorSessionId(agent.id)) return;
    const gate=reserve(agent);
    const workspace=registry.list().find(w=>projectCoordinatorSessionId(instanceId,w.id)===agent.id);
    if(workspace===undefined || lifetime.aborted) return;
    return bind(agent,workspace,gate);
  }
  function hasOrigin(session,identity) {
    // Native session plugins may record metadata before the coordinator's setup.
    for(let seq=0;seq<session.seq;seq++) {
      const event=session.eventAt(seq),record=pluginRecordOf(event);
      if(record?.type===ORIGIN) return isDeepStrictEqual(record.data,identity);
      if(event.type==='turn/start' || event.type==='user/message') return false;
    }
    return false;
  }
  async function bind(agent,workspace,gate) {
    lifetime.throwIfAborted();
    const {id,session}=agent;
    const identity={instanceId,workspaceId:workspace.id};
    assertMembership(workspace,id);
    if(!sameHeader(session.header,id,workspace) || session.inheritedEventCount!==0 || !hasOrigin(session,identity)) throw identityError(id);
    const existing=bound.get(agent);
    if(existing!==undefined) {
      await existing.plugin.await();
      return existing;
    }
    if(gate.owner!==null && gate.owner!==owner) throw identityError(id);
    const entry={agent,workspace,active:null,gate,plugin:null};
    gate.owner=owner;
    entry.plugin=agent.ctx.plugin({name:'loom-project-coordinator-binding',inject:['tools','systemPrompt'],apply(scoped){
      scoped.effect(()=>()=>{
        bound.delete(agent);
        if(gate.owner===owner) {gate.active=false;gate.owner=null;gate.plugin=null;}
      });
      scoped.tools.guard(exec=>{
        const active=entry.active;
        if(lifetime.aborted || !active?.admitted || active.calls.get(exec.callId)?.name!==exec.name) {
          return '协调工具须在当前项目协调轮次内调用';
        }
      });
      scoped.systemPrompt.section({name:'loom:project-coordinator',order:0,text:SYSTEM,complete:true,interpolate:false});
      scoped.systemPrompt.suppressRuntimeContext();
      scoped.on('agent/pre-step',async(step,next)=>{
        const {active}=entry;
        if(lifetime.aborted || active===null || !sameSelection(step.modelSelection,active.selection)) return {kind:'reject'};
        const first=active.turn===null;
        if(first) {
          if(step.step!==1 || step.messages.length!==1 || !isDeepStrictEqual(step.messages[0],active.message) ||
            !sameWork(getWork(active.scope.workId),active)) return {kind:'reject'};
        } else if(step.turn!==active.turn || !active.admitted || step.messages.length!==0) return {kind:'reject'};
        assertMembership(workspace,id);
        const decision=await next();
        if(decision.kind!=='enter') return decision;
        const expected=first?[active.message]:[];
        if(lifetime.aborted || (!active.decided && !sameWork(getWork(active.scope.workId),active)) ||
          !isDeepStrictEqual(decision.messages,expected)) return {kind:'reject'};
        assertMembership(workspace,id);
        if(first) active.turn=step.turn;
        return decision;
      },{prepend:true});
      scoped.on('session/event',(changed,event)=>{
        const {active}=entry;
        if(changed!==session || active===null || active.turn===null) return;
        if(event.type==='user/message' && isDeepStrictEqual(event.data,active.message)) active.admitted=true;
        if(event.data.turn!==active.turn) return;
        if(event.type==='assistant/message') {
          for(const block of event.data.message.content) if(block.type==='tool-call') active.calls.set(block.id,block);
        } else if(event.type==='step/end') active.calls.clear();
        else if(event.type==='turn/end') active.admitted=false;
      });
      const tools=createContextTools({
        defineTool:definition=>{
          if(!Object.hasOwn(TOOL_DESCRIPTIONS,definition.name)) return null;
          return defineTool({...definition,description:TOOL_DESCRIPTIONS[definition.name],async execute(args,exec){
            exec.signal.throwIfAborted();
            const {calls}=current(entry),call=calls.get(exec.callId);
            if(exec.agent!==agent || exec.toolSet===undefined || call?.name!==definition.name ||
              !isDeepStrictEqual(JSON.parse(call.arguments),args)) throw contextError('FORBIDDEN','协调工具须由该项目原生轮次调用');
            calls.delete(exec.callId);
            const result=await definition.execute(args,exec);
            if(definition.name==='loom_query') {
              exec.signal.throwIfAborted();
              current(entry);
            }
            return result;
          }});
        },
        config,sessionId:id,waitScope:()=>current(entry).scope,
        query:request=>query({...request,workspaceId:current(entry).scope.workspaceId}),
        searchProjectSessions:async request=>{
          const {scope}=current(entry);
          if(request.workId!==scope.workId || (request.workspaceId!==undefined && request.workspaceId!==scope.workspaceId)) {
            throw contextError('FORBIDDEN','自动复查只能查询本项目及当前外部操作');
          }
          const result=await searchProjectSessions(request);
          current(entry);
          return result;
        },
        command:async(request,actor)=>{
          const active=current(entry),{scope,operationId}=active;
          if(request.type!=='work.resolveWait' || request.workId!==scope.workId || request.operationId!==operationId ||
            (request.workspaceId!==undefined && request.workspaceId!==scope.workspaceId) ||
            actor.kind!=='agent' || actor.sessionId!==id) throw contextError('FORBIDDEN','自动复查只能处理当前外部操作');
          if(active.decided || request.expectedVersion!==scope.expectedVersion) throw contextError('CONFLICT','外部等待版本已变化');
          const result=await executeDecision(request,actor,scope);
          active.decided=true;
          return result;
        },
      });
      for(const tool of tools) if(tool!==null) scoped.tools.register(tool);
    }});
    bound.set(agent,entry);
    gate.plugin=entry.plugin;
    await entry.plugin.await();
    lifetime.throwIfAborted();
    gate.active=true;
    return entry;
  }

  async function ensure(workspace,agentOptions) {
    const sessionId=projectCoordinatorSessionId(instanceId,workspace.id);
    assertMembership(workspace,sessionId,false);
    const live=ctx.agents.get(sessionId);
    if(live!==undefined) return bindAgent(live);
    const stored=await persistence.stat(sessionId,{signal:lifetime});
    lifetime.throwIfAborted();
    if(stored!==undefined) {
      assertMembership(workspace,sessionId);
      if(!sameHeader(stored.header,sessionId,workspace)) throw identityError(sessionId);
    } else if(workspace.sessionIds.includes(sessionId)) throw identityError(sessionId);
    const setup=async(_agentCtx,agent)=>{
      const gate=reserve(agent);
      if(stored===undefined) {
        assertMembership(workspace,sessionId,false);
        appendPluginRecord(agent.session,ORIGIN,{instanceId,workspaceId:workspace.id});
        await workspace.attachSession(sessionId);
        const titles=ctx.get('sessionTitle');
        if(titles!==undefined) titles.rename(agent.session,'Loom 项目协调');
      }
      await bind(agent,workspace,gate);
    };
    const opts={agentOptions,setup,signal:lifetime};
    const handle=stored===undefined
      ? await ctx.agents.create({...opts,sessionId,meta:{cwd:workspace.path}})
      : await ctx.agents.resume({...opts,resumeSessionId:sessionId});
    handles.set(handle.agent,handle);
    return bound.get(handle.agent);
  }

  async function run(workspaceId,claim) {
    lifetime.throwIfAborted();
    const workspace=registry.get(workspaceId);
    if(workspace===undefined) throw contextError('LOOM_WORKSPACE_REQUIRED','协调项目须已登记');
    const selection=await role();
    const entry=await ensure(workspace,selection);
    const {agent}=entry;
    try {
      if(lifetime.aborted || agent.status!=='idle') return;
      await agent.runMaintenance(()=>{
        lifetime.throwIfAborted();
        assertMembership(workspace,agent.id);
        // A recovered inbox carries messages, not the process-local dispatch that authorized them.
        agent.inbox.clear();
        agent.model.select(selection);
        const work=claim();
        if(work===null) return;
        const scope=Object.freeze({workId:work.id,workspaceId,expectedVersion:work.version});
        if(work.workspaceId!==workspaceId || !work.wait?.operationId) throw identityError(agent.id);
        const {kind,help,remoteRef,operationId}=work.wait;
        const active={scope,operationId,sessionId:work.sessionId,selection,turn:null,admitted:false,decided:false,calls:new Map()};
        if(!sameWork(getWork(work.id),active)) throw contextError('CONFLICT','外部等待版本已变化');
        const payload={...scope,operationId,...(typeof remoteRef==='string'?{remoteRef:remoteRef.slice(0,512)}:{}),
          ...(kind==='help'?{help}:{}),sessionId:work.sessionId};
        const label=kind==='help'?'help':'external-wait';
        active.message=createUserMessage({source:{kind:'loom-external-wait',...scope},content:[{type:'text',
          text:`[Loom ${label} reminder]\n${JSON.stringify(payload)}\n核对本项目相关线索，并以 work.resolveWait 提交协调结果。`}]});
        entry.active=active;
        agent.followup(active.message);
      });
      await agent.whenIdle();
    } finally {entry.active=null;}
  }

  function dispatch(workspaceId,claim) {
    if(lifetime.aborted || flights.has(workspaceId)) return Promise.resolve();
    const flight=run(workspaceId,claim).finally(()=>flights.delete(workspaceId));
    flights.set(workspaceId,flight);
    return flight;
  }
  function dispose() {
    if(disposal!==undefined) return disposal;
    lifetime.removeEventListener('abort',disposeOnAbort);
    closing.abort(contextError('LOOM_DISPOSED','项目协调正在关闭'));
    disposal=(async()=>{
      // Closing admission precedes draining the active turn; owned handles also close persistence.
      const stops=[...bound.values()].map(async entry=>{
        entry.gate.active=false;
        const handle=handles.get(entry.agent);
        if(handle!==undefined) await handle.dispose();
        else if(entry.active!==null) {
          entry.agent.cancel({kind:'disposed'});
          await entry.agent.whenIdle();
        }
      });
      const stopped=await Promise.allSettled(stops);
      await Promise.allSettled([...flights.values()]);
      const released=await Promise.allSettled([
        ...[...bound.values()].map(entry=>entry.plugin.dispose()),
        ...[...handles.values()].map(handle=>handle.dispose()),
      ]);
      handles.clear();
      const errors=[...new Set([...stopped,...released].filter(r=>r.status==='rejected').map(r=>r.reason))];
      if(errors.length) throw new AggregateError(errors,'Loom project coordinator disposal failed');
    })();
    return disposal;
  }
  function disposeOnAbort() {
    dispose().catch(error=>ctx.logger.error(error));
  }
  lifetime.addEventListener('abort',disposeOnAbort,{once:true});
  return {bindAgent,dispatch,dispose};
}
