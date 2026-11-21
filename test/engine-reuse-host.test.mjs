import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { installed, native } from './context-native-helper.mjs';
import { startupHost } from './host-native-helper.mjs';
import { LoomStore } from '../src/core/store.mjs';
import { LoomEngine } from '../src/host/engine.mjs';
import { createWorkerBinder } from '../src/host/worker.mjs';

const actor={kind:'user'};

const definition={title:'执行一次',stages:[{id:'one',title:'生成结果'}]};

async function hostFixture(t,respond,context={}) {
  const host=await startupHost(respond),store=new LoomStore(join(host.directory,'engine.sqlite'));
  const binder=createWorkerBinder(store),engine=new LoomEngine(host.ctx,store,context,{bindWorker:binder.bindAgent});
  store.syncWorkspaces(engine.native.workspaces());
  t.after(async()=>{await engine.dispose();await binder.dispose();store.close();await host.close();});
  return {...host,store,engine};
}

test('一次确认到原生投递、文件产出和成功回执验收完整贯通',{skip:!installed,timeout:20000},async t=>{
  const report={kind:'result',summary:'文件已生成',outputs:{artifact:'result.txt'}};
  const f=await hostFixture(t,(_wire,_req,res)=>{
    const calls=[{id:'write-result',name:'write_result',arguments:{}},{id:'report-result',name:'loom_report',arguments:{report}}];
    const chunk=choices=>`data: ${JSON.stringify({id:'local-engine',object:'chat.completion.chunk',choices})}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(chunk([{index:0,delta:{tool_calls:calls.map((call,index)=>({index,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))},finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:'tool_calls'}])+'data: [DONE]\n\n');
  },{async evaluateWork(_work,run,checks){
    assert.deepEqual(run.outputs,report.outputs);
    return {passed:checks.every(check=>check.passed),summary:'本地文件已核实',source:'file-check',evidence:checks};
  }});
  const path=join(f.directory,'result.txt');
  f.ctx.tools.register(native('dsh-tools').defineTool({name:'write_result',description:'Write the result file',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=>{writeFileSync(path,'native-engine-result');return path;}}));
  const proposal=await f.engine.command({type:'use.create',workspaceId:f.workspace.id,permissionPreset:'danger-full-access',autoAccept:true,
    definition:{title:'本地结果',stages:[{id:'produce',title:'生成文件',outputs:[{name:'artifact',required:true}],checks:[{kind:'file',path:'result.txt',contains:'native-engine-result'}]}]}},actor);
  const {works}=await f.engine.command({type:'use.confirm',useId:proposal.use.id,expectedVersion:proposal.use.version},actor);
  const run=f.store.reserveRun(works[0].id);
  await f.engine.dispatch(run);
  const {agent}=await f.ctx.sessionController.resolveAgent(run.sessionId);await agent.whenIdle();
  await f.engine.observe(f.store.getRun(run.id));
  assert.equal(f.store.getWork(run.workId).status,'accepted');
  assert.equal(f.store.getRun(run.id).reportCallId,'report-result');
  assert.equal(f.ctx.permissionPresets.current(agent.session),'danger-full-access');
  assert.equal(readFileSync(path,'utf8'),'native-engine-result');
  assert.equal(f.received.length,1);
});
