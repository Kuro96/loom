import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {LoomStore} from '../src/core/store.mjs';
import {LoomEngine} from '../src/host/engine.mjs';
import {createContextTools} from '../src/context/tools.mjs';

const user={kind:'user'},model={provider:'local',model:'worker'};
const document={english:'## Result\nTwo rows matched.',chinese:'## 结果\n有两行匹配。'};
const deliverables=[{title:'Matched rows',path:'./deliveries/matched rows.csv'}];
const report={kind:'result',summary:'匹配完成',outputs:{count:2},document,deliverables};
const finish={reason:'completed',summary:'native completion',eventCursor:8,reportCallId:'selected'};
function fixture(t) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-documents-')),file=join(dir,'test.sqlite');
  const f={store:new LoomStore(file),reopen(){this.store.close();return this.store=new LoomStore(file);}};
  t.after(()=>{f.store.close();rmSync(dir,{recursive:true,force:true});});
  f.store.syncWorkspaces([{workspaceId:'p',title:'Project',path:dir}]);
  const work=f.store.command({type:'work.create',workspaceId:'p',title:'Match rows',model,outputs:[{name:'count'}]},user);
  f.store.command({type:'work.confirm',workId:work.id,expectedVersion:work.version},user);
  f.run=f.store.reserveRun(work.id);return f;
}
function submit(store,run,value,callId='selected') {
  return store.reportRun(run.id,value,{sessionId:run.sessionId,requestId:run.requestId,turn:1,callId});
}

test('only the selected result publishes its file list and reopenable bilingual document',t=>{
  const f=fixture(t),{run}=f;let s=f.store;
  submit(s,run,{...report,document:{...document,english:'Discarded draft'},deliverables:[]},'discarded');
  submit(s,run,report);
  assert.deepEqual(s.getWork(run.workId).documents,[]);
  s.finishRun(run.id,finish);s=f.reopen();s.finishRun(run.id,finish);
  const work=s.query({kind:'work',workId:run.workId}).items[0];
  assert.equal(work.documents.length,1);
  const [meta]=work.documents;
  assert.deepEqual(Object.keys(meta).sort(),['createdAt','id','role','runId','title']);
  assert.equal(meta.role,'worker');assert.equal(meta.runId,run.id);assert.ok(meta.title);
  assert.ok(Number.isFinite(Date.parse(meta.createdAt)));
  assert.deepEqual(s.getDocument(work.id,meta.id),{...meta,...document});
  assert.equal(s.getDocument('another-work',meta.id),null);
  assert.deepEqual(work.result.deliverables,deliverables);
  assert.deepEqual(work.result.outputs,{count:2});assert.equal(work.result.summary,report.summary);
  s.command({type:'work.rework',workId:work.id,expectedVersion:work.version,feedback:'Recheck'},user);
  const next=s.reserveRun(work.id);
  s.finishRun(next.id,{reason:'completed',summary:'Summary only',eventCursor:2});
  const revised=s.getWork(work.id);
  assert.deepEqual(revised.documents,[meta]);assert.deepEqual(revised.result.deliverables,[]);
  assert.equal(revised.result.summary,'Summary only');assert.equal(revised.result.runId,next.id);
  assert.deepEqual(s.getDocument(work.id,meta.id),{...meta,...document});
});

test('malformed bilingual text and unsafe file references cannot become candidates',t=>{
  const {store:s,run}=fixture(t);
  const invalid=[{document:{english:'English only'}},{document:{...document,chinese:'  '}},{document:{...document,role:'worker'}},
    {document:null},{deliverables:null},{deliverables:[{title:'File'}]},{deliverables:[{title:'',path:'a.txt'}]},
    {deliverables:[{...deliverables[0],sessionId:'other'}]},
    ...['../other.txt','sub\\..\\other.txt','C:\\private.txt','\\\\host\\share','/outside','a.md:stream','a\u0000b'].map(path=>({deliverables:[{title:'Outside',path}]}))];
  for(const extra of invalid) assert.throws(()=>submit(s,run,{...report,...extra}),{code:'INVALID_INPUT'},JSON.stringify(extra));
  assert.deepEqual(s.getRun(run.id).reports,[]);
});

test('settled reports stay with their own run across wake, restart and a later uncertainty',t=>{
  const f=fixture(t),{run}=f;let s=f.store;
  const receipt={operationId:run.workId,remoteRef:'job-17'};
  const wait={...receipt,condition:'published',nextCheckAt:new Date(Date.now()+60000).toISOString()};
  const waiting={english:'Publication is pending.',chinese:'等待发布。'};
  submit(s,run,{kind:'wait',summary:'等待',wait,document:waiting});
  const selection={callId:'selected',eventCursor:5};
  s.settleReport(run.id,selection);s.settleReport(run.id,selection);
  s.wakeWaiting(wait.nextCheckAt);const next=s.reserveRun(run.workId);
  const uncertain={english:'Verify receipt 17.',chinese:'请核对回执 17。'};
  submit(s,next,{kind:'uncertain',summary:'核对回执',uncertainty:{...receipt,reason:'receipt missing'},document:uncertain});
  assert.deepEqual(s.getWork(run.workId).documents.map(m=>m.runId),[run.id]);
  s.settleReport(next.id,selection);s=f.reopen();
  const work=s.getWork(run.workId),[a,b]=work.documents;
  assert.deepEqual(work.documents.map(m=>[m.role,m.runId]),[['worker',run.id],['worker',next.id]]);
  assert.deepEqual(s.getDocument(work.id,a.id),{...a,...waiting});assert.deepEqual(s.getDocument(work.id,b.id),{...b,...uncertain});
  assert.equal(work.result,null);assert.equal(work.status,'paused');
});

test('only the current coordinator can append its own decision report, including on command replay',async t=>{
  const f=fixture(t),{run,store:s}=f;
  submit(s,run,report);s.finishRun(run.id,finish);
  const before=s.getWork(run.workId),worker=before.documents[0],bus={kind:'agent',sessionId:'bus-1'};
  const request={type:'work.addReport',workId:before.id,runId:run.id,title:'Decision required',
    document:{english:'Choose the export format.',chinese:'请选择导出格式。'},expectedVersion:before.version,idempotencyKey:'format-decision'};
  let current=bus.sessionId;
  const engine=new LoomEngine({workspaceRegistry:{list:()=>[{id:'p',path:'.',title:'Project'}]}},s,{getBus:()=>({sessionId:current})});
  const busTools=createContextTools({defineTool:x=>x,command:engine.command.bind(engine),query:s.query.bind(s),sessionId:bus.sessionId,
    state:{setDisplay(){}},config:()=>({queryLimit:10,queryMaxBytes:16000})});
  const command=busTools.find(tool=>tool.name==='loom_command'),query=busTools.find(tool=>tool.name==='loom_query');
  const queue=JSON.parse(await query.execute({request:JSON.stringify({kind:'work',categories:['interaction']})}));
  assert.equal(queue.items[0].result.runId,run.id);
  const append=()=>command.execute({request:JSON.stringify(request)});
  assert.throws(()=>s.command(request,bus),{code:'FORBIDDEN'});
  await assert.rejects(engine.command({...request,coordinatorSessionId:bus.sessionId},user),{code:'FORBIDDEN'});
  await assert.rejects(engine.command(request,{kind:'agent',sessionId:run.sessionId}),{code:'FORBIDDEN'});
  const other=s.command({type:'work.create',workspaceId:'p',title:'Other'},user);
  await assert.rejects(engine.command({...request,workId:other.id,expectedVersion:other.version},bus),{code:'NOT_FOUND'});
  await assert.rejects(engine.command({...request,expectedVersion:before.version-1},bus),{code:'CONFLICT'});
  for(const extra of [{role:'worker'},{deliverables},{document:{...document,english:' '}},{title:' '}]) {
    await assert.rejects(engine.command({...request,...extra},bus),{code:'INVALID_INPUT'});
  }
  assert.equal(await append(),await append());
  current='next-segment';await assert.rejects(append(),{code:'FORBIDDEN'});
  assert.throws(()=>s.replayCommand(request,bus),{code:'FORBIDDEN'});
  const reopened=f.reopen(),work=reopened.getWork(before.id),[original,addition]=work.documents;
  assert.equal(work.documents.length,2);assert.deepEqual(original,worker);
  assert.equal(addition.runId,run.id);assert.equal(addition.title,request.title);assert.equal(addition.role,'coordinator');
  assert.deepEqual(reopened.getDocument(work.id,original.id),{...original,...document});
  assert.deepEqual(reopened.getDocument(work.id,addition.id),{...addition,...request.document});
  assert.deepEqual(work,{...before,documents:[original,addition],version:before.version+1,updatedAt:work.updatedAt});
  const event=reopened.query({kind:'event',workId:work.id}).items.filter(e=>e.type==='work.addReport');
  assert.deepEqual(event.map(e=>e.actor),[bus]);
  assert.deepEqual(event[0].detail,{version:work.version,runId:run.id,documentId:addition.id});
  assert.match(command.description,/work\.addReport/);assert.match(command.description,/必须/);
});
