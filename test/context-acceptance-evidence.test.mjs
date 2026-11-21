import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed } from './context-native-helper.mjs';
import { startupHost, testModel as model } from './host-native-helper.mjs';
import { createLoomContext } from '../src/context/index.mjs';
import { LoomStore } from '../src/core/store.mjs';
import { DEFAULT_CONTEXT, prefixDigest } from '../src/context/budget.mjs';

function reply(res) {
  const chunk=choices=>`data: ${JSON.stringify({id:'evidence',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta:{content:JSON.stringify({passed:false,summary:'候选需要核对',evidence:['inputs and outputs']})},finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:'stop'}])+'data: [DONE]\n\n');
}

const actor={kind:'user'};

async function fixture() {
  const host=await startupHost((_wire,_req,res)=>reply(res));
  const store=new LoomStore(join(host.directory,'evidence.sqlite'));
  store.syncWorkspaces([{workspaceId:host.workspace.id,path:host.directory,title:'本次输入'}]);
  store.command({type:'settings.update',roleModels:{bus:model,acceptance:model},context:{}},actor);
  const manager=await createLoomContext(host.ctx,{directory:join(host.directory,'context'),workspaceId:host.workspace.id,getSettings:()=>store.getSettings(),query:q=>store.query(q),command:(q,a)=>store.command(q,a),modelCatalog:async()=>({default:model})});
  const definition={title:'按输入生成产物',description:'artifact.batch 必须等于本次 batch；核对采用说明',knowledge:'验收须保留源结果版本',parameters:[{name:'batch',required:true}],stages:[
    {id:'source',title:'获取源结果',inputs:{batch:{kind:'parameter',path:['batch']}},outputs:[{name:'dataset',description:'本次源数据',required:true}]},
    {id:'report',title:'产物',instructions:'生成本次批次报告，输出 artifact.batch 等于输入 batch',scope:'仅处理本次批次',inputs:{batch:{kind:'parameter',path:['batch']},dataset:{kind:'output',stageId:'source',output:'dataset',path:[]}},outputs:[{name:'artifact',description:'批次和产物路径',required:true}]},
  ]};
  function reserve(batch='EXPECTED_BATCH_B') {
    const {use}=store.command({type:'use.create',workspaceId:host.workspace.id,definition,parameters:{batch},model,autoAccept:true},actor);
    const {works}=store.command({type:'use.confirm',useId:use.id,expectedVersion:use.version},actor);
    const source=store.reserveRun(works[0].id);
    store.reportRun(source.id,{kind:'result',summary:'源结果',outputs:{dataset:{batch,path:'source.json'}}},{sessionId:source.sessionId,requestId:source.requestId,turn:1,callId:'source'});
    store.finishRun(source.id,{reason:'completed',summary:'源结果',eventCursor:5,checks:[],review:{passed:true,summary:'源结果已核对',source:'checks',evidence:['dataset']},reportCallId:'source'});
    const run=store.reserveRun(works[1].id);
    const work=store.getWork(works[1].id);
    return {work,run};
  }
  function candidate(run,outputs,callId) {
    store.reportRun(run.id,{kind:'result',summary:'报告已生成',outputs},{sessionId:run.sessionId,requestId:run.requestId,turn:1,callId});
    return {...store.getRun(run.id),summary:'报告已生成',outputs,observation:{admitted:true,ownedTurn:1,completion:{reason:'completed',turn:1,endSeq:10,summary:'报告已生成'}}};
  }
  return {...host,store,manager,reserve,candidate,definition,async close(){await manager.dispose();store.close();await host.close();}};
}

test('acceptance separates the current work requirements from shared workflow context',{skip:!installed,timeout:30000},async()=>{
  const host=await fixture();
  try {
    host.definition.description='上传、等待处理，然后下载并核对文件内容';
    host.definition.stages[1].instructions='查询处理状态，核对原操作标识与文件元数据';
    const {work,run}=host.reserve();
    const outputs={artifact:{batch:run.inputs.batch,status:'completed'}};
    await host.manager.evaluateWork(work,host.candidate(run,outputs,'scope'),[],AbortSignal.timeout(5000));
    assert.equal(host.received.length,1);
    const evidence=JSON.parse(host.received[0].messages.find(message=>message.role==='user').content);
    assert.equal(evidence.work.description,host.definition.stages[1].instructions);
    assert.deepEqual(evidence.work.workflowContext,work.definitionSnapshot);
    assert.equal(Object.hasOwn(evidence.work,'definitionSnapshot'),false);
    assert.deepEqual(evidence.work.outputs,work.outputs);
    assert.deepEqual(evidence.run.outputs,outputs);
  }finally{await host.close();}
});

test('native acceptance request contains actual inputs, consumed result versions and candidate outputs with adopted criteria',{skip:!installed,timeout:30000},async()=>{
  const host=await fixture();
  try {
    const {work,run}=host.reserve();
    const wrong={artifact:{batch:'ACTUAL_BATCH_A',path:'report.json'}};
    const right={artifact:{batch:'EXPECTED_BATCH_B',path:'report.json'}};
    const badReview=await host.manager.evaluateWork(work,host.candidate(run,wrong,'wrong'),[],AbortSignal.timeout(5000));
    const goodReview=await host.manager.evaluateWork(work,host.candidate(run,right,'right'),[],AbortSignal.timeout(5000));
    assert.equal(host.received.length,2);
    const [bad,good]=host.received.map(wire=>JSON.parse(wire.messages.find(m=>m.role==='user').content));
    assert.notDeepEqual(bad,good,'different batches require different acceptance evidence');
    assert.deepEqual(bad.run.inputs,run.inputs);
    assert.ok(run.consumedResults.length>0);
    assert.deepEqual(bad.run.consumedResults,run.consumedResults);
    assert.deepEqual(bad.run.outputs,wrong);assert.deepEqual(good.run.outputs,right);
    assert.deepEqual(bad.work.outputs,work.outputs);
    assert.deepEqual(bad.work.workflowContext,work.definitionSnapshot);
    assert.equal(bad.work.scope,work.scope);assert.equal(bad.work.description,work.description);
    assert.deepEqual(bad.run.checks,run.checks);assert.equal(bad.run.checksRevision,run.checksRevision);
    assert.equal(bad.run.workVersion,run.workVersion);
    assert.equal(badReview.evidence.inputHash,prefixDigest(bad));
    assert.equal(goodReview.evidence.inputHash,prefixDigest(good));
    assert.notEqual(badReview.evidence.inputHash,goodReview.evidence.inputHash);
    assert.ok(host.received.every(wire=>(wire.max_tokens??wire.max_completion_tokens)===DEFAULT_CONTEXT.reviewMaxTokens));
  }finally{await host.close();}
});
