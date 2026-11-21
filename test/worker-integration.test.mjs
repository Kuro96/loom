import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { installed, native } from './context-native-helper.mjs';
import { startupHost, testModel as model } from './host-native-helper.mjs';
import { LoomStore } from '../src/core/store.mjs';
import { NativeHarness } from '../src/host/native.mjs';
import { createWorkerBinder, successfulReport } from '../src/host/worker.mjs';

const actor={kind:'user'};

test('真实工具写入文件后将报告与原生成功回执保存到SQLite',{skip:!installed,timeout:20000},async()=>{
  let request=0;
  const report={kind:'result',summary:'文件已生成',outputs:{artifact:{path:'result.txt'}}};
  const host=await startupHost((_wire,_req,res)=>{
    if(request>=2){res.writeHead(418);res.end('unexpected model request');return;}
    const next=request++===0?{id:'write-file',name:'write_result',arguments:{}}:{id:'result-report',name:'loom_report',arguments:{report}};
    const chunk=choices=>`data: ${JSON.stringify({id:'local-worker',object:'chat.completion.chunk',choices})}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(chunk([{index:0,delta:{tool_calls:[{index:0,id:next.id,type:'function',function:{name:next.name,arguments:JSON.stringify(next.arguments)}}]},finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:'tool_calls'}])+'data: [DONE]\n\n');
  });
  const store=new LoomStore(join(host.directory,'worker.sqlite')),binder=createWorkerBinder(store);
  try {
    store.syncWorkspaces(host.ctx.workspaceRegistry.list().map(w=>({workspaceId:w.id,path:w.path,title:w.title})));
    let work=store.command({type:'work.create',workspaceId:host.workspace.id,title:'生成文件',model,outputs:[{name:'artifact',description:'结果文件',required:true}]},actor);
    work=store.command({type:'work.confirm',workId:work.id,expectedVersion:work.version},actor);
    const run=store.reserveRun(work.id),path=join(host.directory,'result.txt');
    host.ctx.tools.register(native('dsh-tools').defineTool({name:'write_result',description:'Write the result file',parameters:{},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=>{writeFileSync(path,'native-work-result');return path;}}));
    const harness=new NativeHarness(host.ctx,AbortSignal.timeout(5000),binder.bindAgent);
    const prepared=await harness.prepare(work,run);store.updateRun(run.id,{cursor:prepared.cursor});
    assert.equal((await harness.prompt(run.sessionId,run.requestId,run.prompt)).accepted,true);
    store.markRunAccepted(run.id,prepared.cursor);
    const {agent}=await host.ctx.sessionController.resolveAgent(run.sessionId);await agent.whenIdle();
    assert.equal(readFileSync(path,'utf8'),'native-work-result');
    const saved=store.getRun(run.id),accepted=successfulReport(saved,agent.session.snapshotEvents());
    assert.deepEqual(accepted.report,report);
    assert.equal(accepted.source.requestId,run.requestId);
    assert.equal(host.received.length,2);
  }finally{await binder.dispose();store.close();await host.close();}
});
