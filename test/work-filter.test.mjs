import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';

const user={kind:'user'}, model={provider:'local-test',model:'worker'};

const categories=['pending','completed','interaction'];

function fixture(t) {
  const directory=mkdtempSync(join(process.env.TMPDIR,'loom-work-filter-'));
  const store=new LoomStore(join(directory,'loom.sqlite'));
  store.syncWorkspaces(['a','b'].map(workspaceId=>({workspaceId,path:directory,title:workspaceId})));
  t.after(()=>{store.close();rmSync(directory,{recursive:true});});
  return store;
}

function create(store,title,extra={}) {
  return store.command({type:'work.create',workspaceId:'a',title,model,...extra},user);
}

function approve(store,work) {
  return store.command({type:'work.approveModel',workId:work.id,modelRevision:work.modelRevision,expectedVersion:work.version},user);
}

function assertCategory(store,workId,expected) {
  for(const category of categories) {
    const page=store.query({kind:'work',workId,categories:[category]});
    assert.deepEqual(page.items.map(work=>work.id),category===expected?[workId]:[],`${store.getWork(workId).status}: ${category}`);
    assert.equal(page.total,category===expected?1:0);
    assert.equal(page.nextCursor,null);
  }
}

test('queued manual gates move between interaction and pending when released',t=>{
  const store=fixture(t);
  const prerequisite=create(store,'prerequisite');
  const waiting=approve(store,create(store,'dependency wait',{dependsOn:[prerequisite.id],checks:[{kind:'file',path:'result.txt'}]}));
  assertCategory(store,waiting.id,'pending');
  const gated=approve(store,create(store,'manual gate',{manualGate:true}));
  assertCategory(store,gated.id,'interaction');
  store.command({type:'work.releaseGate',workId:gated.id,expectedVersion:gated.version},user);
  assertCategory(store,gated.id,'pending');
  store.reserveRun(gated.id);
  assertCategory(store,gated.id,'pending');
  const cancelled=approve(store,create(store,'cancelled gate',{manualGate:true}));
  store.command({type:'work.cancel',workId:cancelled.id},user);
  assertCategory(store,cancelled.id,'completed');
  t.diagnostic('gate=queued/interaction -> released/pending -> dispatching/pending; dependency+file=pending; cancelled gate=completed');
});
