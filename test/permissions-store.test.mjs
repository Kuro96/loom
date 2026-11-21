import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';

const user={kind:'user'}, agent={kind:'agent',sessionId:'worker'};

function fixture(t) {
  const directory=mkdtempSync(join(process.env.TMPDIR,'loom-permissions-'));
  const f={file:join(directory,'loom.sqlite')};
  f.store=new LoomStore(f.file);
  f.reopen=()=>{f.store.close();f.store=new LoomStore(f.file);};
  t.after(()=>{f.store.close();rmSync(directory,{recursive:true,force:true});});
  f.store.syncWorkspaces([{workspaceId:'a',title:'Permissions',path:directory}]);
  return f;
}

test('permission settings default to native inheritance and freeze each Work at creation',t=>{
  const f=fixture(t),s=f.store;
  assert.equal(s.getSettings().permissionPreset,null);
  const selected=s.command({type:'settings.update',permissionPreset:'danger-full-access',expectedVersion:0},user);
  assert.equal(selected.permissionPreset,'danger-full-access');
  const work=s.command({type:'work.create',workspaceId:'a',title:'permission snapshot',model:{provider:'test',model:'worker'}},agent);
  assert.throws(()=>s.reserveRun(work.id),{code:'NOT_READY'});
  assert.throws(()=>s.command({type:'work.approveModel',workId:work.id,expectedVersion:work.version,modelRevision:work.modelRevision},agent),{code:'FORBIDDEN'});
  s.command({type:'work.approveModel',workId:work.id,expectedVersion:work.version,modelRevision:work.modelRevision},user);
  const run=s.reserveRun(work.id);
  assert.equal(run.permissionPreset,'danger-full-access');
  s.command({type:'settings.update',permissionPreset:null,expectedVersion:selected.version},user);
  assert.equal(s.reserveRun(work.id).permissionPreset,'danger-full-access');
  assert.throws(()=>s.updateRun(run.id,{permissionPreset:null}),{code:'INVALID_INPUT'});
  s.finishRun(run.id,{reason:'completed',summary:'done',eventCursor:-1});
  f.reopen();
  assert.equal(f.store.getSettings().permissionPreset,null);
  assert.equal(f.store.getRun(run.id).permissionPreset,'danger-full-access');
  assert.equal(f.store.query({kind:'run',workId:work.id}).items[0].permissionPreset,'danger-full-access');
  f.store.command({type:'work.rework',workId:work.id,feedback:'next attempt'},user);
  assert.equal(f.store.reserveRun(work.id).permissionPreset,'danger-full-access');
  const fresh=f.store.command({type:'work.create',workspaceId:'a',title:'new permission snapshot',model:{provider:'test',model:'worker'}},agent);
  assert.equal(fresh.permissionPreset,null);
});
