import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as usage from '../src/context/usage.mjs';

const model={provider:'loom-test-provider',model:'flash',purpose:'conversation'};
const openUsage=(file,options={})=>new usage.TurnUsage(file,{...options,isPiAi:provider=>provider===model.provider});
const id=(segment,turn)=>({busId:'bus',segment,sessionId:`session-${segment}`,turn});
const time=Date.parse('2024-01-01T00:00:00Z');
const start=(ledger,identity,offset=0)=>ledger.start(identity,time+offset);
const end=(ledger,identity,offset=10,reason='completed')=>ledger.end(identity,time+offset,reason);
const call=(ledger,identity,callId,raw,meta={})=>{
  const finish=ledger.begin({...identity,step:1,callId,startedAt:time+1,...model,...meta});
  return ()=>finish({endedAt:time+2,usage:raw,usageSource:raw?'adapter-reported':undefined,finish:{kind:'stop'}});
};

test('finished turns persist usage by segment and call identity, including a late receipt',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'loom-usage-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'usage.sqlite');
  const a=id(1,1), b=id(2,1);
  let ledger=openUsage(path);
  start(ledger,a);
  const late=call(ledger,a,'late',{inputTokens:11,cacheReadTokens:7,cacheWriteTokens:3,outputTokens:2,totalTokens:23},{privateText:'excluded'});
  end(ledger,a);
  start(ledger,b,20);
  call(ledger,b,'second',{inputTokens:8,outputTokens:1,totalTokens:9})();
  end(ledger,b,30,'aborted');
  late(); late();
  ledger.close();
  ledger=openUsage(path);
  try {
    const {items}=ledger.query('bus',{});
    assert.deepEqual(items.map(r=>[r.segment,r.turn,r.status,r.main.calls,r.main.input,r.main.hit,r.main.miss,r.main.output,r.main.peak]),[
      [2,1,'stopped',1,8,0,8,1,8],[1,1,'completed',1,21,7,14,2,21],
    ]);
    const {calls}=ledger.query('bus',{key:items[1].key});
    assert.equal(calls[0].usage.cacheWriteTokens,3);
    assert.equal(calls[0].usageSource,'adapter-reported');
    assert.equal(calls[0].privateText,undefined);
  } finally {ledger.close();}
});

test('unknown, conflicting and missing snapshots remain distinguishable from explicit zero',()=>{
  const ledger=openUsage(':memory:'),identity=id(1,1);
  try {
    start(ledger,identity);
    call(ledger,identity,'unknown',{inputTokens:50,outputTokens:2,totalTokens:52},{provider:'other',model:'unknown'})();
    call(ledger,identity,'conflict',{inputTokens:11,outputTokens:2,cacheReadTokens:4,totalTokens:3},{provider:'openai-codex',model:'codex'})();
    call(ledger,identity,'zero',{inputTokens:0,outputTokens:0,totalTokens:0},{provider:'deepseek-official',model:'deepseek'})();
    call(ledger,identity,'missing',undefined)();
    end(ledger,identity,10,'error');
    const [turn]=ledger.query('bus').items;
    assert.equal(turn.status,'failed');
    assert.deepEqual(turn.main,{calls:4,reported:3,inputCount:2,outputCount:3,input:50,hit:0,miss:0,unknownSplit:50,output:4,write:0,peak:50,
      models:[{provider:'other',model:'unknown',calls:1},{provider:'openai-codex',model:'codex',calls:1},{provider:'deepseek-official',model:'deepseek',calls:1},{provider:'loom-test-provider',model:'flash',calls:1}]});
  } finally {ledger.close();}
});

test('an upgraded ledger reclassifies archived pi-ai zero snapshots while retaining measured usage',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'loom-usage-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'usage.sqlite'), zero={inputTokens:0,outputTokens:0,totalTokens:0};
  const ledger=openUsage(path), first=id(1,1), second=id(1,2);
  start(ledger,first);
  call(ledger,first,'provider-zero',zero,{provider:'deepseek-official',model:'deepseek'})();
  call(ledger,first,'measured',{inputTokens:10,outputTokens:1})();
  end(ledger,first);
  start(ledger,second,20);call(ledger,second,'ambiguous',zero)();end(ledger,second,30);
  ledger.close();
  const previous=new DatabaseSync(path);
  try {
    previous.exec(`DROP TABLE IF EXISTS usage_meta;
      UPDATE calls SET usageSource='legacy-adapter-reported',input=0,output=0,hit=0,miss=0,cacheWrite=0 WHERE callId='ambiguous';
      UPDATE turns SET legacy=1 WHERE turn=2;`);
  } finally {previous.close();}
  const updated=openUsage(path,{legacyGap:true});
  try {
    const {items:[ambiguous,measured],error}=updated.query('bus');
    assert.deepEqual([ambiguous.legacy,ambiguous.main.reported,ambiguous.main.input,ambiguous.main.output],[true,0,null,null]);
    assert.deepEqual([measured.main.reported,measured.main.input,measured.main.output,error.code],[2,10,1,'LOOM_USAGE_LEGACY']);
    const [record]=updated.query('bus',{key:ambiguous.key}).calls;
    assert.deepEqual([record.usageSource,record.usage],['adapter-unverified-zero',zero]);
  } finally {updated.close();}
});

test('retention evicts the earliest finished turn and preserves open calls across native recovery',()=>{
  const ledger=openUsage(':memory:');
  try {
    const open=id(1,1);start(ledger,open);
    call(ledger,open,'missing-after-crash',undefined);
    for(let turn=2;turn<=202;turn++) {const row=id(1,turn);start(ledger,row,turn*2);end(ledger,row,turn*2+1);}
    const {items}=ledger.query('bus');
    assert.equal(items.length,20);
    assert.equal(items[0].turn,202);
    const key=turn=>JSON.stringify(['session-1',turn]);
    assert.throws(()=>ledger.query('bus',{key:key(2)}),{code:'NOT_FOUND'});
    assert.deepEqual(ledger.query('bus',{key:key(3)}).calls,[]);
    ledger.reconcile(open,[{turn:1,reason:'interrupted',endedAt:time+1000}]);
    assert.deepEqual(ledger.query('bus').items.slice(0,1).map(row=>[row.turn,row.status,row.main.calls,row.main.reported]),[[1,'stopped',1,0]]);
  } finally {ledger.close();}
});

test('a write lock surfaces partial-coverage diagnostics and then accepts later calls',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'loom-usage-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'usage.sqlite'), ledger=openUsage(path), lock=new DatabaseSync(path);
  try {
    const first=id(1,1);start(ledger,first);
    const finish=call(ledger,first,'blocked',{inputTokens:5,outputTokens:1});
    lock.exec('BEGIN IMMEDIATE');
    finish();
    lock.exec('COMMIT');
    end(ledger,first);
    const second=id(1,2);start(ledger,second,20);call(ledger,second,'restored',{inputTokens:6,outputTokens:2})();end(ledger,second,30);
    const result=ledger.query('bus',{});
    assert.equal(result.error.code,'LOOM_USAGE_STORAGE');
    assert.deepEqual(result.items.map(turn=>[turn.main.calls,turn.main.reported,turn.main.input]),[[1,1,6],[1,0,null]]);
  } finally {lock.close();ledger.close();}
});
