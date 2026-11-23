import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';

const user={kind:'user'},agent={kind:'agent',sessionId:'bus'},model={provider:'local',model:'worker'};

function fixture(t) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-reuse-')),file=join(dir,'loom.sqlite');
  const f={store:new LoomStore(file),file};
  f.reopen=()=>{f.store.close();f.store=new LoomStore(file);return f.store;};
  t.after(()=>{f.store.close();rmSync(dir,{recursive:true,force:true});});
  f.store.syncWorkspaces([{workspaceId:'a',title:'Project',path:dir},{workspaceId:'b',title:'Other',path:dir+'/other'}]);
  f.store.command({type:'settings.update',roleModels:{worker:model},permissionPreset:'test-preset'},user);
  return f;
}

const definition={title:'Reusable',description:'Instructions',knowledge:'Knowledge',parameters:[{name:'batch',required:true}],stages:[
  {id:'upload',title:'Upload',scope:'Selected batch',inputs:{batch:{kind:'parameter',path:['batch']}},outputs:[{name:'dataset',required:true}]},
  {id:'train',title:'Train',manualGate:true,checks:[{kind:'command',command:'node',args:['--version']}],inputs:{dataset:{kind:'output',stageId:'upload',output:'dataset',path:[]}}}
]};

function propose(s,extra={}) {return s.command({type:'use.create',workspaceId:'a',definition,parameters:{batch:'A'},...extra},agent).use;}

function confirm(s,use) {return s.command({type:'use.confirm',useId:use.id,expectedVersion:use.version},user);}

function create(s,extra={}) {return s.command({type:'work.create',workspaceId:'a',title:'Work',...extra},agent);}

function approve(s,w,autoAccept=false) {return s.command({type:'work.confirm',workId:w.id,expectedVersion:w.version,autoAccept},user);}

test('definition use is proposed then confirmed atomically; repetitions isolate snapshots',t=>{
  const f=fixture(t);let s=f.store;
  const wf=s.command({type:'workflow.create',workspaceId:'a',...definition},agent);
  assert.equal(wf.status,'available');assert.equal(wf.version,1);assert.equal(wf.stageWorkIds,undefined);
  const request={type:'workflow.start',workflowId:wf.id,expectedVersion:1,parameters:{batch:'A'},autoAccept:true,idempotencyKey:'first'};
  const first=s.command(request,agent);assert.equal(first.use.status,'proposed');assert.deepEqual(first.works,[]);
  assert.equal(s.query({kind:'work'}).total,0);assert.deepEqual(s.command(request,agent),first);
  assert.throws(()=>s.command({type:'use.confirm',useId:first.use.id,expectedVersion:1},agent),{code:'FORBIDDEN'});
  const accepted=confirm(s,first.use);assert.equal(accepted.works.length,2);
  const [upload,train]=accepted.works;
  assert.deepEqual(upload.inputs.batch,{kind:'value',value:'A'});assert.equal(upload.permissionPreset,'test-preset');
  assert.equal(upload.authorization.autoAccept,true);assert.equal(upload.modelConsent.actor.kind,'user');
  assert.equal(train.checksConsent.actor.kind,'user');assert.equal(train.gate.released,false);
  assert.deepEqual(train.dependsOn,[upload.id]);assert.equal(train.inputs.dataset.workId,upload.id);
  assert.deepEqual(confirm(s,first.use),accepted);
  const edited=s.command({type:'workflow.update',workflowId:wf.id,expectedVersion:1,definition:{...definition,title:'Changed'}},agent);
  assert.equal(edited.version,2);assert.equal(s.getUse(first.use.id).definitionSnapshot.title,'Reusable');
  const second=s.command({type:'workflow.start',workflowId:wf.id,expectedVersion:2,parameters:{batch:'B'}},agent);
  const next=confirm(s,second.use);assert.notEqual(next.works[0].id,upload.id);assert.equal(next.works[0].inputs.batch.value,'B');
  assert.equal(next.works[0].authorization.autoAccept,false);assert.equal(s.getWorkflow(wf.id).version,2);
  s=f.reopen();assert.equal(s.getUse(first.use.id).progress.total,2);
  assert.equal(s.query({kind:'work',useId:first.use.id}).total,2);
  assert.equal(s.query({kind:'use',workflowId:wf.id}).total,2);
});

test('stageInputs edit one proposal and reach the confirmed work and run',t=>{
  const f=fixture(t);let s=f.store;
  const wf=s.command({type:'workflow.create',workspaceId:'a',title:'Review',stages:[
    {id:'inspect',title:'Inspect',inputs:{sample:{kind:'value',value:'template'}}},
    {id:'archive',title:'Archive'}
  ]},agent);
  const start={type:'workflow.start',workflowId:wf.id,expectedVersion:wf.version};
  const use=s.command({...start,stageInputs:[{stageId:'inspect',name:'sample',value:'first batch'}]},agent).use;
  assert.equal(use.definitionSnapshot.stages[0].inputs.sample.value,'first batch');
  const edited=s.command({type:'use.update',useId:use.id,expectedVersion:use.version,stageInputs:[
    {stageId:'inspect',name:'sample',value:null},{stageId:'archive',name:'sample',value:{batch:[0,false]}}
  ]},user);
  assert.equal(edited.workflowId,wf.id);assert.equal(edited.workflowVersion,wf.version);
  assert.throws(()=>confirm(s,use),{code:'CONFLICT'});
  s=f.reopen();const [inspect,archive]=confirm(s,edited).works;
  assert.deepEqual(inspect.inputs,{sample:{kind:'value',value:null}});
  assert.equal(archive.workflowId,wf.id);assert.deepEqual(archive.inputs,{sample:{kind:'value',value:{batch:[0,false]}}});
  const run=s.reserveRun(archive.id);assert.deepEqual(run.inputs,{sample:{batch:[0,false]}});assert.match(run.prompt,/"batch":\[0,false\]/);
  assert.deepEqual(s.getWorkflow(wf.id),wf);
  const next=s.command(start,agent).use;assert.deepEqual(next.definitionSnapshot.stages,wf.stages);
});

test('invalid stageInputs roll back the proposal, event and idempotency key together',t=>{
  const {store:s}=fixture(t),use=propose(s);
  const command={type:'use.update',useId:use.id,expectedVersion:use.version,parameters:{batch:'B'},idempotencyKey:'edit'};
  const item={stageId:'upload',name:'note',value:'keep'},before=s.query({kind:'event',useId:use.id});
  for(const [reason,bad] of [
    ['duplicate',item],['unknown stage',{...item,stageId:'missing'}],['invalid name',{...item,name:'bad name'}],
    ['reserved name',{...item,name:'__proto__'}],['parameter reference',{...item,name:'batch'}],
    ['output reference',{...item,stageId:'train',name:'dataset'}],['missing value',{stageId:'train',name:'note'}],
    ['non-JSON value',{...item,stageId:'train',value:Infinity}],['unknown property',{...item,stageId:'train',path:[]}]
  ]) {
    assert.throws(()=>s.command({...command,stageInputs:[item,bad]},user),{code:'INVALID_INPUT'},reason);
  }
  assert.deepEqual(s.getUse(use.id),use);assert.deepEqual(s.query({kind:'event',useId:use.id}),before);
  const edited=s.command({...command,stageInputs:[item]},user),{works,use:confirmed}=confirm(s,edited);
  assert.deepEqual(works[0].inputs,{batch:{kind:'value',value:'B'},note:{kind:'value',value:'keep'}});
  assert.equal(works[1].inputs.dataset.workId,works[0].id);
  assert.throws(()=>s.command({...command,idempotencyKey:'later',expectedVersion:confirmed.version,stageInputs:[item]},user),{code:'INVALID_STATE'});
});

test('a full definition replacement applies stageInputs to the new inline definition',t=>{
  const {store:s}=fixture(t),wf=s.command({type:'workflow.create',workspaceId:'a',...definition},agent);
  const {use}=s.command({type:'workflow.start',workflowId:wf.id,expectedVersion:wf.version,parameters:{batch:'A'}},agent);
  const updated=s.command({type:'use.update',useId:use.id,expectedVersion:use.version,parameters:{},
    definition:{title:'Ad hoc',stages:[{id:'extra',title:'Extra'}]},stageInputs:[{stageId:'extra',name:'note',value:'one time'}]},user);
  assert.equal(updated.workflowId,null);assert.equal(updated.workflowVersion,null);
  assert.equal(updated.sourceWorkflowId,wf.id);assert.equal(updated.sourceWorkflowVersion,wf.version);
  const [work]=confirm(s,updated).works;assert.equal(work.stageId,'extra');assert.equal(work.inputs.note.value,'one time');
  assert.deepEqual(s.getWorkflow(wf.id),wf);
});

test('use.create checks merged stage input count and definition size before persisting',t=>{
  const {store:s}=fixture(t);
  const inputs=Object.fromEntries(Array.from({length:100},(_,i)=>['n'+i,{kind:'value',value:i}]));
  const template={title:'Inline',description:'x'.repeat(140*1024),stages:[{id:'s',title:'Review',inputs}]};
  const request={type:'use.create',workspaceId:'a',definition:template,idempotencyKey:'inline'};
  const make=(name,value)=>s.command({...request,stageInputs:[{stageId:'s',name,value}]},agent).use;
  assert.throws(()=>make('more',null),{code:'INVALID_INPUT'});
  assert.throws(()=>make('n0','x'.repeat(140*1024)),{code:'INVALID_INPUT'});
  assert.equal(s.query({kind:'use'}).total,0);
  assert.equal(make('n0','changed').definitionSnapshot.stages[0].inputs.n0.value,'changed');
});

const review={passed:true,summary:'Checked',source:'test',evidence:['artifact']};

function source(run,callId='report') {return {sessionId:run.sessionId,requestId:run.requestId,turn:0,callId};}

function result(s,w,outputs={},extra={}) {
  const run=s.reserveRun(w.id);
  s.reportRun(run.id,{kind:'result',summary:'Delivered',outputs},source(run));
  return s.finishRun(run.id,{reason:'completed',summary:'native text',eventCursor:2,reportCallId:'report',review,...extra});
}

test('a verified internal handoff releases its successor while its final result remains for review',t=>{
  const {store:s}=fixture(t);
  const settings=s.command({type:'settings.update',permissionPreset:'workspace-write'},user);
  const launch={sessionId:agent.sessionId,settingsVersion:settings.version,model,permissionPreset:'workspace-write'};
  const {works:[prepare,deliver]}=s.command({type:'use.create',workspaceId:'a',definition:{title:'Batch',stages:[
    {id:'prepare',title:'Prepare',outputs:[{name:'artifact',required:true}]},
    {id:'deliver',title:'Deliver',inputs:{artifact:{kind:'output',stageId:'prepare',output:'artifact',path:[]}}},
  ]}},agent,{busLaunch:launch});
  const first=result(s,prepare,{});
  assert.equal(first.verificationPassed,false);
  assert.equal(s.getWork(prepare.id).status,'review');
  assert.throws(()=>s.reserveRun(deliver.id),{code:'NOT_READY'});
  s.command({type:'work.rework',workId:prepare.id,feedback:'补齐交接材料'},user);
  result(s,prepare,{artifact:'batch-A'});
  assert.equal(s.getWork(prepare.id).result.acceptance.actor.source,'bus-auto-start');
  const final=result(s,deliver);
  assert.deepEqual(final.inputs,{artifact:'batch-A'});
  assert.equal(s.getWork(deliver.id).status,'review');
});

test('result versions bind named inputs and immutable definition knowledge across reopen',t=>{
  const f=fixture(t);let s=f.store;
  const wf=s.command({type:'workflow.create',workspaceId:'a',...definition},user);
  const proposal=s.command({type:'workflow.start',workflowId:wf.id,expectedVersion:1,parameters:{batch:'A'},autoAccept:true},agent).use;
  const [upload,train]=confirm(s,proposal).works;
  s.command({type:'workflow.update',workflowId:wf.id,expectedVersion:1,definition:{...definition,knowledge:'Other knowledge'}},user);
  assert.throws(()=>s.reserveRun(train.id),{code:'NOT_READY'});
  const first=result(s,upload,{dataset:{id:'ds-A',items:[1,2]}});
  assert.equal(first.summary,'Delivered');assert.equal(s.getWork(upload.id).status,'accepted');
  assert.equal(first.resultVersion,s.getWork(upload.id).result.version);
  assert.deepEqual(first.outputs,s.getWork(upload.id).result.outputs);
  s.command({type:'work.releaseGate',workId:train.id,expectedVersion:train.version},user);
  s=f.reopen();const next=s.reserveRun(train.id);
  assert.deepEqual(next.inputs,{dataset:{id:'ds-A',items:[1,2]}});
  assert.deepEqual(next.consumedResults,[{inputName:'dataset',workId:upload.id,runId:first.id,resultVersion:first.resultVersion,output:'dataset',path:[],value:{id:'ds-A',items:[1,2]}}]);
  assert.ok(next.prompt.includes('ds-A'));assert.ok(next.prompt.includes(train.id));
  assert.ok(next.prompt.includes('Knowledge'));assert.ok(!next.prompt.includes('Other knowledge'));
  assert.deepEqual(s.getRun(first.id).outputs,{dataset:{id:'ds-A',items:[1,2]}});
});

test('required outputs block acceptance; missing optional result paths block only consumers',t=>{
  const {store:s}=fixture(t);
  const upstream=approve(s,create(s,{outputs:[{name:'required',required:true},{name:'optional'}]}),true);
  let run=result(s,upstream,{});let current=s.getWork(upstream.id);
  assert.equal(run.verificationPassed,false);assert.equal(current.status,'review');
  assert.throws(()=>s.command({type:'work.accept',workId:upstream.id,runId:run.id,expectedVersion:current.version},user),{code:'MISSING_OUTPUT'});
  s.command({type:'work.rework',workId:upstream.id,feedback:'Supply required value'},user);
  run=result(s,upstream,{required:null});assert.equal(s.getWork(upstream.id).status,'accepted');
  const blocked=approve(s,create(s,{inputs:{x:{kind:'result',workId:upstream.id,output:'optional',path:[]}}}));
  assert.deepEqual(blocked.dependsOn,[upstream.id]);
  const independent=approve(s,create(s));
  assert.equal(s.readyWork()[0].id,independent.id);assert.throws(()=>s.reserveRun(blocked.id),{code:'NOT_READY'});
  assert.throws(()=>create(s,{workspaceId:'b',inputs:{x:{kind:'result',workId:upstream.id,output:'required',path:[]}}}),{code:'WORKSPACE_MISMATCH'});
});

test('specific Work authorization governs active runs and one use cannot authorize another',t=>{
  const {store:s}=fixture(t);
  const a=confirm(s,propose(s,{autoAccept:true})),b=confirm(s,propose(s));
  const run=s.reserveRun(a.works[0].id);
  s.command({type:'use.authorize',useId:a.use.id,expectedVersion:a.use.version,autoAccept:false},user);
  s.reportRun(run.id,{kind:'result',summary:'ok',outputs:{dataset:'ds'}},source(run));
  s.finishRun(run.id,{reason:'completed',summary:'ok',eventCursor:1,reportCallId:'report',review});
  assert.equal(s.getWork(a.works[0].id).status,'review');assert.equal(s.getWork(b.works[0].id).authorization.autoAccept,false);
  assert.deepEqual(s.getUse(a.use.id).confirmation,a.use.confirmation);
  const plain=approve(s,create(s),true);result(s,plain);assert.equal(s.getWork(plain.id).result.acceptance.mode,'work');
  assert.throws(()=>s.command({type:'work.authorize',workId:plain.id,expectedVersion:s.getWork(plain.id).version,autoAccept:true},agent),{code:'FORBIDDEN'});
});

function waitReport(work,extra={}) {return {kind:'wait',summary:'Training',wait:{operationId:work.id,remoteRef:'platform/job-1',condition:'Job finished',nextCheckAt:new Date(Date.now()+60000).toISOString(),...extra}};}

test('external wait settles only on Host acknowledgement then wakes same operation after reopen',t=>{
  const f=fixture(t);let s=f.store;
  const w=approve(s,create(s)),next=approve(s,create(s)),run=s.reserveRun(w.id),report=waitReport(w);
  s.reportRun(run.id,report,source(run));
  assert.equal(s.recoverableRuns().length,1);assert.throws(()=>s.reserveRun(next.id),{code:'WORKSPACE_BUSY'});
  const settled=s.settleReport(run.id,{callId:'report',eventCursor:5});
  assert.equal(settled.status,'waiting');assert.equal(s.getWork(w.id).status,'waiting');assert.deepEqual(s.getWork(w.id).wait,report.wait);
  assert.equal(s.recoverableRuns().length,0);assert.equal(s.readyWork()[0].id,next.id);
  assert.deepEqual(s.settleReport(run.id,{callId:'report',eventCursor:5}),settled);
  s=f.reopen();assert.deepEqual(s.wakeWaiting(new Date(Date.now()).toISOString()),[]);
  const awakened=s.wakeWaiting(report.wait.nextCheckAt);assert.equal(awakened[0].id,w.id);assert.deepEqual(s.wakeWaiting(report.wait.nextCheckAt),[]);
  const resumed=s.reserveRun(w.id);assert.equal(resumed.sessionId,run.sessionId);assert.equal(resumed.operationId,w.id);
  assert.notEqual(resumed.requestId,run.requestId);assert.deepEqual(resumed.wait,report.wait);assert.ok(resumed.prompt.includes('platform/job-1'));assert.ok(resumed.prompt.includes('先核'));
});

test('resumed coordination preserves its schedule and ignores stale wait decisions across reopen',t=>{
  const f=fixture(t);let s=f.store;
  const w=approve(s,create(s)),run=s.reserveRun(w.id),report=waitReport(w),at=report.wait.nextCheckAt;
  s.reportRun(run.id,report,source(run));s.settleReport(run.id,{callId:'report',eventCursor:5,coordinate:true});
  const waiting=s.nextExternalWait(at),claim=s.claimExternalWait(w.id,waiting.version,at);
  const resolution={type:'work.resolveWait',workId:w.id,expectedVersion:claim.version,operationId:w.id,action:'continue',sources:['Project ledger'],information:'Check Bin-B9'};
  s=f.reopen();assert.equal(s.nextExternalWait(at),null);
  const stopped=s.command({type:'work.pause',workId:w.id,expectedVersion:claim.version},user);
  assert.equal(stopped.status,'paused');
  assert.throws(()=>s.command(resolution,agent,{coordinatorSessionId:agent.sessionId}),{code:'CONFLICT'});
  assert.throws(()=>s.command(resolution,agent,{coordinatorSessionId:'other-bus'}),{code:'FORBIDDEN'});
  const resumed=s.command({type:'work.resume',workId:w.id,expectedVersion:stopped.version},user);
  assert.equal(resumed.status,'waiting');assert.equal(resumed.wait.nextCheckAt,at);
  assert.equal(s.readyWork().length,0);
  const retry=s.claimExternalWait(w.id,resumed.version,at);
  const queued=s.command({...resolution,expectedVersion:retry.version},agent,{coordinatorSessionId:agent.sessionId});
  assert.equal(queued.status,'queued');assert.equal(queued.wait.handoff.information,'Check Bin-B9');
  assert.equal(s.reserveRun(w.id).sessionId,run.sessionId);
});

test('external wait decisions retain their original evidence after another check and reopen',t=>{
  const f=fixture(t);let s=f.store;
  const work=approve(s,create(s)),run=s.reserveRun(work.id),report=waitReport(work),due=report.wait.nextCheckAt;
  s.reportRun(run.id,report,source(run));s.settleReport(run.id,{callId:'report',eventCursor:5,coordinate:true});
  let claimed=s.claimExternalWait(work.id,s.getWork(work.id).version,due);
  const command={type:'work.resolveWait',workId:work.id,operationId:work.id};
  const nextCheckAt=new Date(Date.now()+120000).toISOString();
  s.command({...command,expectedVersion:claimed.version,action:'wait',condition:'Receipt arrives',checkMethod:'Read ledger',nextCheckAt,sources:['Project ledger']},agent,{coordinatorSessionId:agent.sessionId});
  claimed=s.claimExternalWait(work.id,s.getWork(work.id).version,nextCheckAt);
  s.command({...command,expectedVersion:claimed.version,action:'ask',missingInformation:'Which ledger?',sources:['Original receipt']},agent,{coordinatorSessionId:agent.sessionId});
  s=f.reopen();
  const decisions=s.query({kind:'event',workId:work.id}).items.filter(event=>event.type==='work.resolveWait').map(({detail:{version,...decision}})=>decision);
  assert.deepEqual(decisions,[{operationId:work.id,action:'wait',condition:'Receipt arrives',checkMethod:'Read ledger',nextCheckAt,sources:['Project ledger']},
    {operationId:work.id,action:'ask',missingInformation:'Which ledger?',sources:['Original receipt']}]);
});

test('rework previews transitive consumers, requires fresh user impact confirmation and preserves history',t=>{
  const f=fixture(t);let s=f.store;
  const a=approve(s,create(s,{outputs:[{name:'data',required:true}]}),true),ar=result(s,a,{data:'v1'});
  const b=approve(s,create(s,{inputs:{data:{kind:'result',workId:a.id,output:'data',path:[]}},outputs:[{name:'data'}]}),true),br=result(s,b,{data:'b1'});
  const c=approve(s,create(s,{inputs:{data:{kind:'result',workId:b.id,output:'data',path:[]}}}),true),cr=result(s,c);
  const p=s.previewRework(a.id);assert.deepEqual(p.affected.map(x=>x.workId),[b.id,c.id]);assert.deepEqual(s.query({kind:'rework',workId:a.id}),p);
  const command={type:'work.rework',workId:a.id,expectedVersion:p.version,feedback:'Replace data',impactToken:p.impactToken,rerunWorkIds:[b.id]};
  assert.throws(()=>s.command(command,agent),{code:'FORBIDDEN'});
  s.command({type:'work.authorize',workId:c.id,expectedVersion:s.getWork(c.id).version,autoAccept:false},user);
  assert.throws(()=>s.command(command,user),{code:'CONFLICT'});
  const preview=s.previewRework(a.id);s.command({...command,impactToken:preview.impactToken},user);
  assert.equal(s.getWork(b.id).status,'queued');assert.equal(s.getWork(b.id).sessionId,br.sessionId);
  assert.equal(s.getWork(c.id).status,'accepted');assert.ok(s.getWork(c.id).inputChanges.length>0);
  assert.deepEqual(s.getRun(ar.id).outputs,{data:'v1'});assert.equal(s.getRun(cr.id).consumedResults[0].runId,br.id);
  assert.throws(()=>s.reserveRun(b.id),{code:'NOT_READY'});
  const ar2=result(s,a,{data:'v2'});s=f.reopen();const br2=s.reserveRun(b.id);
  assert.equal(br2.inputs.data,'v2');assert.equal(br2.consumedResults[0].resultVersion,ar2.resultVersion);assert.equal(br2.sessionId,br.sessionId);
  const active=s.previewRework(a.id);
  assert.throws(()=>s.command({type:'work.rework',workId:a.id,feedback:'again',impactToken:active.impactToken,rerunWorkIds:[]},user),{code:'ACTIVE_CONSUMER'});
});
