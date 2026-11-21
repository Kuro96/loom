import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';
import { BusState } from '../src/context/state.mjs';
import { querySummary } from '../src/context/tools.mjs';

const actor={kind:'agent',sessionId:'bus-query'};

const definition={title:'上传并训练',parameters:[{name:'batch',required:true}],stages:[
  {id:'upload',title:'上传',inputs:{batch:{kind:'parameter',path:['batch']}},outputs:[{name:'dataset',required:true}]},
  {id:'train',title:'训练',inputs:{dataset:{kind:'output',stageId:'upload',output:'dataset',path:['id']}},outputs:[{name:'modelFile'}]},
]};

function fixture(t,config={queryLimit:20,queryMaxBytes:10000}) {
  const directory=mkdtempSync(join(process.env.TMPDIR,'loom-context-query-'));
  const store=new LoomStore(join(directory,'loom.sqlite'));
  const state=new BusState(join(directory,'context'),'project');
  store.syncWorkspaces([{workspaceId:'project',title:'项目',path:directory}]);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,state,config,query:request=>store.query(request)};
}

async function fullDetail(request,f) {
  let text='',pages=0,next=request;
  do {
    const page=await querySummary(next,f);
    assert.equal(page.detail,true);
    assert.equal(page.encoding,'json');
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=f.config.queryMaxBytes);
    assert.equal(page.offset,Array.from(text).length);
    assert.equal(page.count,Array.from(page.text).length);
    text+=page.text;pages++;
    assert.ok(pages<10000,'详情游标须前进');
    if(page.next) {
      assert.equal(page.next.offset,page.offset+page.count);
      assert.equal(page.next.revision,page.revision);
    }
    next=page.next;
  } while(next);
  return {value:JSON.parse(text),pages};
}

test('详情按section和字符游标完整读取步骤、知识及任意具名输入',async t=>{
  const f=fixture(t,{queryLimit:5,queryMaxBytes:1200});
  const initial=readFileSync(f.state.file,'utf8');
  f.store.command({type:'workflow.create',workspaceId:'project',...definition},actor);
  const workflow=f.store.command({type:'workflow.create',workspaceId:'project',title:'完整定义',knowledge:'中文😀\\\"\n'.repeat(700),
    stages:Array.from({length:31},(_,i)=>({id:`stage${i}`,title:`步骤${i}`,instructions:'核对本次输入😀'.repeat(40),inputs:{customBatch:{kind:'value',value:{customKey:`batch-${i}`,details:['a','b']}}}}))},actor);
  const request={kind:'workflow',workflowId:workflow.id,detail:true,limit:5000};
  const stages=await fullDetail({...request,section:'stages'},f);
  assert.deepEqual(stages.value,workflow.stages);assert.ok(stages.pages>1);
  assert.equal((await fullDetail({...request,section:'knowledge'},f)).value,workflow.knowledge);
  assert.deepEqual((await fullDetail({...request,section:['stages','2','inputs','customBatch']},f)).value,workflow.stages[2].inputs.customBatch);
  assert.deepEqual((await fullDetail(request,f)).value,workflow);
  await querySummary({kind:'workflow'},f);
  assert.equal(readFileSync(f.state.file,'utf8'),initial);
});
