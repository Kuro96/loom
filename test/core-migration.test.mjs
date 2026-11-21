import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { LoomStore } from '../src/core/store.mjs';

const originalGrant={autoAccept:true,expectedVersion:6,idempotencyKey:'legacy-grant',type:'workflow.authorize',workflowId:'wf'};

const user={kind:'user'},model={provider:'test',model:'worker'};

function legacy(t,damage=null) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-migration-')),file=join(dir,'loom.sqlite'),sql=new DatabaseSync(file);
  for(const table of ['workspaces','workflows','works','runs','controls','events']) sql.exec(`CREATE TABLE ${table}(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,workspaceId TEXT,workflowId TEXT,workId TEXT,status TEXT,body TEXT NOT NULL)`);
  sql.exec('CREATE TABLE commands(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);CREATE TABLE settings(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
  sql.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({version:1,permissionPreset:'current-default',roleModels:{worker:model}}));
  const put=(table,v)=>sql.prepare(`INSERT INTO ${table}(id,workspaceId,workflowId,workId,status,body) VALUES(?,?,?,?,?,?)`).run(v.id,v.workspaceId??null,v.workflowId??null,v.workId??null,v.status??null,JSON.stringify(v));
  const auth={actor:user,autoAccept:true,at:'2026-01-01T00:00:00Z',workflowVersion:1};
  const wf={id:'wf',workspaceId:'a',title:'Stages',description:'Original description',knowledge:'Scoped knowledge',stages:[{id:'step',title:'Step',instructions:'Original',dependsOn:[],checks:[],manualGate:false}],stageWorkIds:['w'],status:'completed',version:7,authorization:auth,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z'};
  const line={...wf,id:'line',title:'Historical knowledge',stages:[],stageWorkIds:[],status:'active',authorization:null};
  const work={id:'w',workspaceId:'a',workflowId:'wf',stageId:'step',title:'Step',description:'Original',scope:'Scope',status:'accepted',version:8,model,modelRevision:1,modelConsent:{actor:user,modelRevision:1,model},checks:[],checksRevision:1,checksConsent:null,gate:null,dependsOn:[],sessionId:'session-w',result:{runId:'r',version:7,summary:'Done',acceptance:{actor:user}},createdAt:wf.createdAt,updatedAt:wf.updatedAt};
  const extra={...work,id:'extra',stageId:null,sessionId:'session-extra',result:null,status:'queued'};
  const scoped={...work,id:'scoped',workflowId:'line',stageId:null,sessionId:null,result:null,status:'awaiting_model'};
  const run={id:'r',workId:'w',workspaceId:'a',workflowId:'wf',sessionId:work.sessionId,requestId:'request-r',status:'completed',prompt:'Exact historical prompt',permissionPreset:null,checks:[],checksRevision:1,cursor:12};
  const event={id:'event',workId:'w',workflowId:'wf',workspaceId:'a',type:'work.accept',actor:user};
  if(damage==='dependency') work.dependsOn=['missing-work'];
  if(damage==='stage') wf.stageWorkIds=['missing-stage-work'];
  if(damage==='run') work.result.runId='missing-run';
  put('workspaces',{id:'a',workspaceId:'a',path:dir,title:'Project',active:true,knowledge:'Project knowledge',version:1});
  for(const v of [wf,line]) put('workflows',v);
  for(const v of [work,extra,scoped]) put('works',v);
  put('runs',run);put('events',event);
  sql.prepare('INSERT INTO commands VALUES(?,?,?)').run('old','original-fingerprint',JSON.stringify({workflow:wf,works:[work]}));
  const grantHash=createHash('sha256').update(JSON.stringify({actor:user,input:originalGrant})).digest('hex');
  sql.prepare('INSERT INTO commands VALUES(?,?,?)').run(originalGrant.idempotencyKey,grantHash,JSON.stringify(wf));
  sql.close();t.after(()=>rmSync(dir,{recursive:true,force:true}));return {file,wf,line,work,extra,scoped,run,event};
}

test('legacy migration preserves identities, all associations, prompts, evidence and scoped knowledge',t=>{
  const f=legacy(t);let s=new LoomStore(f.file);
  try {
    assert.equal(s.getWorkflow('wf').status,'available');assert.equal(s.getWorkflow('wf').version,7);
    assert.equal(s.getWorkflow('wf').stageWorkIds,undefined);assert.deepEqual(s.getWorkflow('wf').legacySource,f.wf);
    assert.equal(s.query({kind:'workflow'}).total,1);assert.equal(s.query({kind:'workflow',legacy:true}).total,1);assert.equal(s.query({kind:'workflow',legacy:'all'}).total,2);
    const use=s.getUse(s.getWork('w').useId);assert.deepEqual(use.workIds,['w','extra']);assert.deepEqual(use.stageWorkIds,{step:'w'});
    assert.equal(use.legacy,true);assert.equal(use.workflowVersion,7);assert.equal(use.definitionSnapshot.knowledge,'Scoped knowledge');
    for(const key of Object.keys(f.work)) assert.deepEqual(s.getWork('w')[key],f.work[key],key);
    assert.deepEqual(s.getWork('w').documents,[]);
    assert.deepEqual(s.query({kind:'work',workId:'w'}).items[0].documents,[]);
    assert.equal(s.getWork('w').permissionPreset,null);assert.equal(s.getWork('extra').permissionPreset,'current-default');
    assert.deepEqual(s.getWork('w').authorization,f.wf.authorization);assert.equal(s.getWork('extra').useId,use.id);
    assert.equal(s.getUse(s.getWork('scoped').useId).definitionSnapshot.knowledge,'Scoped knowledge');
    assert.equal(s.query({kind:'workspace'}).items[0].knowledge,'Project knowledge');
    for(const key of Object.keys(f.run)) assert.deepEqual(s.getRun('r')[key],f.run[key],key);
    assert.equal(s.getRun('r').resultVersion,7);assert.equal(s.getRun('r').outputs,undefined);assert.deepEqual(s.getRun('r').reports,[]);
    assert.deepEqual(s.command(originalGrant,user),f.wf);
    assert.throws(()=>s.command({...originalGrant,idempotencyKey:'new-grant'},user),{code:'MIGRATION_REQUIRED'});
    assert.deepEqual(s.query({kind:'event'}).items,[f.event]);
    assert.throws(()=>s.command({type:'workflow.update',workflowId:'line',expectedVersion:7,definition:{title:'Converted',stages:[{id:'s',title:'s'}]}},user),{code:'INVALID_STATE'});
    const before=s.query({kind:'use'});s.close();s=new LoomStore(f.file);assert.deepEqual(s.query({kind:'use'}),before);
    const sql=new DatabaseSync(f.file);try {
      assert.equal(sql.prepare('PRAGMA user_version').get().user_version,1);assert.equal(sql.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.deepEqual(JSON.parse(sql.prepare('SELECT result FROM commands WHERE key=?').get('old').result),{workflow:f.wf,works:[f.work]});
      assert.equal(sql.prepare('SELECT fingerprint FROM commands WHERE key=?').get('old').fingerprint,'original-fingerprint');
    } finally {sql.close();}
    const work=s.command({type:'work.rework',workId:'w',feedback:'Retry'},user),next=s.reserveRun(work.id);
    assert.equal(next.sessionId,'session-w');assert.ok(next.prompt.includes('Scoped knowledge'));assert.deepEqual(next.reports,[]);
  } finally {s.close();}
});

test('a broken dependency rolls back the entire legacy database migration',t=>{
  const damage='dependency';
  const f=legacy(t,damage),before=new DatabaseSync(f.file),rows=before.prepare('SELECT body FROM workflows ORDER BY seq').all();before.close();
  let opened;
  try {assert.throws(()=>{opened=new LoomStore(f.file);},e=>e.code==='MIGRATION_REFERENCE' && /missing-/.test(e.message));}
  finally {if(opened) opened.close();}
  const sql=new DatabaseSync(f.file);try {
    assert.equal(sql.prepare('PRAGMA user_version').get().user_version,0);assert.deepEqual(sql.prepare('SELECT body FROM workflows ORDER BY seq').all(),rows);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='uses'").get().n,0);
  } finally {sql.close();}
});
