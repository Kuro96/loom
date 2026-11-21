import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {LoomStore} from '../src/core/store.mjs';
import {LoomEngine} from '../src/host/engine.mjs';

const user={kind:'user'},agent={kind:'agent',sessionId:'bus'},model={provider:'local',model:'worker'};
const definition={title:'Batch',stages:[{id:'a',title:'First'},{id:'b',title:'Second'}]};
function fixture(t) {
  const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'loom-delete-')),file=join(dir,'test.sqlite');
  const f={dir,s:new LoomStore(file),reopen(){this.s.close();return this.s=new LoomStore(file);}};
  t.after(()=>{f.s.close();rmSync(dir,{recursive:true,force:true});});
  f.s.syncWorkspaces([{workspaceId:'p',title:'Project',path:dir}]);return f;
}
function propose(s) {return s.command({type:'use.create',workspaceId:'p',definition,model},agent).use;}
function request(type,target) {
  return {type,[type.startsWith('use.')?'useId':'workId']:target.id,expectedVersion:target.version};
}

test('cancelling retains the proposal snapshot across reopen and closes confirmation',t=>{
  const f=fixture(t),before=propose(f.s),cancel={...request('use.cancel',before),idempotencyKey:'cancel'};
  assert.throws(()=>f.s.command({...cancel,expectedVersion:0},user),{code:'CONFLICT'});
  const after=f.s.command(cancel,user),s=f.reopen();
  assert.deepEqual(s.getUse(before.id),after);
  assert.deepEqual(after,{...before,status:'cancelled',version:before.version+1,updatedAt:after.updatedAt});
  assert.deepEqual(s.command(cancel,user),after);
  assert.deepEqual(s.query({kind:'event',useId:after.id}).items.map(e=>[e.type,e.actor]),[['use.create',agent],['use.cancel',user]]);
  assert.throws(()=>s.command(request('use.confirm',before),user),{code:'CONFLICT'});
  for(const type of ['use.confirm','use.update','use.cancel'])
    assert.throws(()=>s.command(request(type,after),user),{code:'INVALID_STATE'});
  assert.equal(s.query({kind:'work',useId:after.id}).total,0);
});

test('user identity is checked before replay, lookup or host preflight',async t=>{
  const {s}=fixture(t),engine=new LoomEngine({},s,{});
  for(const type of ['use.cancel','use.delete','work.delete']) {
    const idempotencyKey='occupied-'+type,input={...request(type,{id:'missing',version:1}),actor:user,idempotencyKey};
    s.command({type:'intent.create',text:'reserved key',idempotencyKey},user);
    assert.throws(()=>s.replayCommand(input,agent),{code:'FORBIDDEN'});
    assert.throws(()=>s.command(input,agent),{code:'FORBIDDEN'});
    await assert.rejects(engine.command(input,agent),{code:'FORBIDDEN'});
  }
});

test('delete removes just the selected unmaterialized proposal and replays its receipt',t=>{
  const f=fixture(t),s=f.s,wf=s.command({type:'workflow.create',workspaceId:'p',...definition},agent);
  const start={type:'workflow.start',workflowId:wf.id,expectedVersion:wf.version,model};
  const first=s.command(start,agent).use,second=s.command(start,agent).use,kept=s.command(start,agent).use;
  const cancelled=s.command(request('use.cancel',second),user);
  for(const use of [first,cancelled]) {
    const del={...request('use.delete',use),idempotencyKey:use.id};
    assert.throws(()=>s.command({...del,expectedVersion:use.version-1},user),{code:'CONFLICT'});
    assert.deepEqual(s.command(del,user),{id:use.id,deleted:true});
    assert.deepEqual(s.command(del,user),{id:use.id,deleted:true});
    assert.throws(()=>s.command(request('use.delete',use),user),{code:'NOT_FOUND'});
    const events=s.query({kind:'event',workspaceId:'p',workflowId:wf.id,useId:use.id}).items;
    assert.deepEqual(events.filter(e=>e.type==='use.delete').map(e=>[e.actor,e.detail.version]),[[user,use.version]]);
  }
  const reopened=f.reopen();assert.deepEqual(reopened.getWorkflow(wf.id),wf);
  assert.deepEqual(reopened.query({kind:'use'}).items,[kept]);
  assert.equal(reopened.query({kind:'work'}).total,0);
  const {use,works}=reopened.command(request('use.confirm',kept),user);
  for(const type of ['use.cancel','use.delete'])
    assert.throws(()=>reopened.command(request(type,use),user),{code:'INVALID_STATE'});
  assert.deepEqual(reopened.query({kind:'work',useId:use.id}).items,works);
});

test('deleting one member removes its local execution history and updates only its batch membership',t=>{
  const f=fixture(t),s=f.s,wf=s.command({type:'workflow.create',workspaceId:'p',...definition},agent);
  const {use:proposal}=s.command({type:'workflow.start',workflowId:wf.id,expectedVersion:wf.version,model},agent);
  const confirm=request('use.confirm',proposal),{use,works:[selected,other]}=s.command(confirm,user);
  const run=s.reserveRun(selected.id),doc={english:'Done',chinese:'完成'},path='result.txt';
  writeFileSync(join(f.dir,path),'original');
  s.command({...request('work.steer',s.getWork(selected.id)),text:'Check'},user);
  const [control]=s.pendingControls();s.ackSteer(control.id,{accepted:true});
  s.reportRun(run.id,{kind:'result',summary:'Done',outputs:{},document:doc,deliverables:[{title:'Output',path}]},
    {sessionId:run.sessionId,requestId:run.requestId,turn:1,callId:'done'});
  s.finishRun(run.id,{reason:'completed',summary:'Done',eventCursor:2,reportCallId:'done'});
  const work=s.getWork(selected.id),[report]=work.documents,del={...request('work.delete',work),idempotencyKey:'remove-work'};
  assert.throws(()=>s.command({...del,expectedVersion:selected.version},user),{code:'CONFLICT'});
  assert.deepEqual(s.command(del,user),{id:work.id,deleted:true});
  const reopened=f.reopen();assert.deepEqual(reopened.command(del,user),{id:work.id,deleted:true});
  assert.equal(reopened.getWork(work.id),null);assert.equal(reopened.getWorkForSession(run.sessionId),null);
  assert.equal(reopened.getRun(run.id),null);assert.equal(reopened.getDocument(work.id,report.id),null);
  assert.equal(reopened.query({kind:'control',workId:work.id}).total,0);
  assert.equal(readFileSync(join(f.dir,path),'utf8'),'original');
  assert.deepEqual(reopened.getWorkflow(wf.id),wf);assert.deepEqual(reopened.getWork(other.id),other);
  const batch=reopened.getUse(use.id);
  assert.deepEqual(batch.workIds,[other.id]);assert.deepEqual(batch.stageWorkIds,{b:other.id});
  assert.equal(batch.progress.total,1);assert.equal(batch.version,use.version+1);
  assert.deepEqual(batch.definitionSnapshot,use.definitionSnapshot);assert.deepEqual(batch.confirmation,use.confirmation);
  assert.deepEqual(reopened.command(confirm,user),{use:batch,works:[other]});
  const events=reopened.query({kind:'event',workspaceId:'p',workflowId:wf.id,useId:use.id,workId:work.id}).items;
  assert.deepEqual(events.filter(e=>e.type==='work.delete').map(e=>[e.actor,e.detail.version]),[[user,work.version]]);
  reopened.command(request('work.delete',other),user);
  const empty=reopened.getUse(use.id);assert.equal(empty.status,'confirmed');assert.deepEqual(empty.workIds,[]);
  assert.throws(()=>reopened.command(request('use.delete',empty),user),{code:'INVALID_STATE'});
});

test('work deletion waits for the native stop receipt and leaves a rejected attempt retryable',t=>{
  const {s}=fixture(t),{works:[work]}=s.command(request('use.confirm',propose(s)),user);
  const run=s.reserveRun(work.id),blocked=()=>{
    const del={...request('work.delete',s.getWork(work.id)),idempotencyKey:'after-stop'};
    const before=s.query({kind:'event',workId:work.id});
    assert.throws(()=>s.command(del,user),{code:'INVALID_STATE'});
    assert.deepEqual(s.query({kind:'event',workId:work.id}),before);
    assert.equal(s.replayCommand(del,user),undefined);
  };
  blocked();s.markRunAccepted(run.id,0);blocked();s.updateRun(run.id,{running:true});blocked();
  s.command(request('work.pause',s.getWork(work.id)),user);blocked();
  s.command(request('work.cancel',s.getWork(work.id)),user);blocked();
  const [cancel]=s.pendingControls();s.ackControl(cancel.id,{stopped:false});blocked();
  s.ackControl(cancel.id,{stopped:true});
  assert.deepEqual(s.command({...request('work.delete',s.getWork(work.id)),idempotencyKey:'after-stop'},user),{id:work.id,deleted:true});
  assert.equal(s.getRun(run.id),null);assert.deepEqual(s.pendingControls(),[]);
});

test('an outstanding steer receipt must settle before its control can be deleted',t=>{
  const {s}=fixture(t),{works:[work]}=s.command(request('use.confirm',propose(s)),user),run=s.reserveRun(work.id);
  s.command({...request('work.steer',s.getWork(work.id)),text:'Check'},user);
  s.finishRun(run.id,{reason:'completed',summary:'Done',eventCursor:2});
  const del=request('work.delete',s.getWork(work.id));assert.throws(()=>s.command(del,user),{code:'INVALID_STATE'});
  const [control]=s.pendingControls();s.supersedeControl(control.id,'Run completed');
  assert.deepEqual(s.command(del,user),{id:work.id,deleted:true});
});

test('work dependencies and named result consumers survive a refused deletion',t=>{
  const {s}=fixture(t);
  const create=extra=>s.command({type:'work.create',workspaceId:'p',title:'Work',...extra},user);
  const root=create({outputs:[{name:'out'}]}),dependency=create({dependsOn:[root.id]}),
    consumer=create({inputs:{value:{kind:'result',workId:root.id,output:'out'}}});
  const del=request('work.delete',root),before=s.query({kind:'event'});
  const block=s.checkDeletion({kind:'work',id:root.id});
  assert.deepEqual(block.references.map(({kind,id,title})=>[kind,id,title]),[dependency,consumer].map(w=>['work',w.id,w.title]));
  assert.throws(()=>s.command(del,user),{code:'INVALID_DEPENDENCY',details:{references:block.references}});
  assert.deepEqual(s.query({kind:'event'}),before);
  s.command(request('work.delete',dependency),user);
  assert.throws(()=>s.command(del,user),{code:'INVALID_DEPENDENCY'});
  assert.deepEqual(s.getWork(consumer.id),consumer);assert.deepEqual(s.getWork(root.id),root);
  s.command(request('work.delete',consumer),user);assert.deepEqual(s.command(del,user),{id:root.id,deleted:true});
});

test('deleting a workflow source keeps its versioned provenance intact',t=>{
  const {s}=fixture(t),{works:[work]}=s.command(request('use.confirm',propose(s)),user),run=s.reserveRun(work.id);
  s.finishRun(run.id,{reason:'completed',summary:'Result',eventCursor:1});
  const accepted=s.command({...request('work.accept',s.getWork(work.id)),runId:run.id},user);
  const wf=s.command({type:'workflow.create',workspaceId:'p',...definition,sourceWorkIds:[work.id],sourceVersions:{[work.id]:accepted.version}},agent);
  assert.throws(()=>s.command(request('work.delete',accepted),user),{code:'INVALID_DEPENDENCY'});
  assert.deepEqual(s.getWorkflow(wf.id),wf);assert.deepEqual(s.getWork(work.id),accepted);
  assert.equal(s.getRun(run.id).id,run.id);
});

test('resolved intents keep a valid target when a user tries to delete it',t=>{
  const {s}=fixture(t),proposal=propose(s),work=s.command({type:'work.create',workspaceId:'p',title:'Independent'},user);
  for(const [type,target,key] of [['use.delete',proposal,'useId'],['work.delete',work,'workId']]) {
    const intent=s.command({type:'intent.create',text:'Keep this association'},agent);
    const linked=s.command({type:'intent.resolve',intentId:intent.id,workspaceId:'p',[key]:target.id},agent);
    assert.throws(()=>s.command(request(type,target),user),{code:'INVALID_DEPENDENCY'});
    assert.deepEqual(s.query({kind:'intent',[key]:target.id}).items,[linked]);
  }
  assert.deepEqual(s.getUse(proposal.id),proposal);assert.deepEqual(s.getWork(work.id),work);
});

test('host routes deletion locally and rejects a cancelled confirmation before model preflight',async t=>{
  const {s,dir}=fixture(t),engine=new LoomEngine({workspaceRegistry:{list:()=>[{id:'p',title:'Project',path:dir}]},
    sessionController:{modelCatalog:async()=>({groups:[]})}},s,{});
  const cancelled=await engine.command(request('use.cancel',propose(s)),user);
  await assert.rejects(engine.command(request('use.confirm',cancelled),user),{code:'INVALID_STATE'});
  assert.deepEqual(await engine.command(request('use.delete',cancelled),user),{id:cancelled.id,deleted:true});
  const work=s.command({type:'work.create',workspaceId:'p',sessionId:'kept-session',title:'Independent'},user);
  assert.deepEqual(await engine.command(request('work.delete',work),user),{id:work.id,deleted:true});
});

test('store-only cleanup preserves registry state and a late observer skips the removed run',async t=>{
  const {s}=fixture(t),engine=new LoomEngine({workspaceRegistry:{list:()=>[]}},s,{});
  const {works:[work]}=s.command(request('use.confirm',propose(s)),user),run=s.reserveRun(work.id);
  s.finishRun(run.id,{reason:'completed',summary:'Done',eventCursor:1});
  const before=s.query({kind:'workspace'}),proposal=propose(s);
  const cancelled=await engine.command(request('use.cancel',proposal),user);
  await engine.command(request('use.delete',cancelled),user);
  await engine.command(request('work.delete',s.getWork(work.id)),user);
  assert.deepEqual(s.query({kind:'workspace'}),before);
  await engine.observe(run);
});

test('historical input and result references protect a source independently of current scheduling edges',t=>{
  const f=fixture(t),{s}=f;
  const [inputSource,consumedSource]=['Input','Result'].map(title=>s.command({type:'work.create',workspaceId:'p',title},agent));
  const {works:[consumer]}=s.command(request('use.confirm',propose(s)),user),run=s.reserveRun(consumer.id);
  s.finishRun(run.id,{reason:'completed',summary:'Done',eventCursor:1});
  // Restored snapshots may carry a result reference separately from the current scheduling DAG.
  const db=new DatabaseSync(join(f.dir,'test.sqlite'));
  try {
    db.prepare("UPDATE works SET body=json_set(body,'$.inputs',json(?)) WHERE id=?").run(
      JSON.stringify({item:{kind:'result',workId:inputSource.id,output:'item',path:[]}}),consumer.id);
    db.prepare("UPDATE runs SET body=json_set(body,'$.consumedResults',json(?)) WHERE id=?").run(
      JSON.stringify([{workId:consumedSource.id,inputName:'item',resultVersion:1,output:'item',path:[],value:'original'}]),run.id);
  } finally {db.close();}
  const restored=f.reopen();
  for(const source of [inputSource,consumedSource])
    assert.throws(()=>restored.command(request('work.delete',source),user),{code:'INVALID_DEPENDENCY'});
  restored.command(request('work.delete',restored.getWork(consumer.id)),user);
  for(const source of [inputSource,consumedSource]) assert.deepEqual(restored.command(request('work.delete',source),user),{id:source.id,deleted:true});
});
