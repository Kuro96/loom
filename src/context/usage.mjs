import { DatabaseSync } from 'node:sqlite';
import { contextError } from './budget.mjs';

export const USAGE_LIMIT=20;
const RETAIN=200;
const TOKEN_FIELDS=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'];
const token=value=>Number.isSafeInteger(value) && value>=0;
export function numericUsage(value) {
  const fields=TOKEN_FIELDS.filter(key=>token(value?.[key]));
  if(fields.length) return Object.fromEntries(fields.map(key=>[key,value[key]]));
}

// DSH 0.2.2-rc.3 adapters verified at the installed stream boundary.
const layout=(provider,isPiAi)=>provider==='deepseek-official' ? 'deepseek' : provider==='openai-codex' || isPiAi(provider) ? 'pi-ai' : 'unknown';
export function normalizeUsage(source,raw) {
  const input=raw?.inputTokens, output=raw?.outputTokens ?? null, total=raw?.totalTokens;
  const hit=raw?.cacheReadTokens, write=raw?.cacheWriteTokens;
  const splitLayout=source!=='unknown';
  const result={source,input:null,hit:null,miss:null,write:write ?? (splitLayout && raw ? 0 : null),output};
  if(input===undefined) return result;
  if(splitLayout) {
    const miss=input+(write ?? 0), all=miss+(hit ?? 0);
    if(token(all) && (total===undefined || output===null || (token(all+output) && total===all+output))) {
      return {...result,input:all,hit:hit ?? 0,miss};
    }
    return result;
  }
  if(total!==undefined && output!==null && total>=output) {
    const all=total-output;
    if((input===all || (hit!==undefined && write!==undefined && input+hit+write===all)) && (hit ?? 0)+(write ?? 0)<=all) {
      return {...result,input:all,...(hit!==undefined && write!==undefined ? {hit,miss:all-hit} : {})};
    }
  }
  return result;
}

const identityKey=({sessionId,turn})=>JSON.stringify([sessionId,turn]);
const turnStatus=reason=>reason==='completed'?'completed':reason==='aborted' || reason==='interrupted'?'stopped':'failed';
const STORAGE_ERRORS=new Set([3,5,6,7,8,10,11,13,14,23,26]);
const storageError=(error,initializing)=>error.code==='ERR_SQLITE_ERROR' &&
  (STORAGE_ERRORS.has(error.errcode & 255) || (initializing && error.errcode===1));

function summarize(calls) {
  const values={calls:calls.length,reported:0,inputCount:0,outputCount:0,input:null,hit:null,miss:null,unknownSplit:null,output:null,write:null,peak:null,models:[]};
  const models=new Map();
  const add=(key,value)=>{if(value!==null) values[key]=(values[key] ?? 0)+value;};
  for(const call of calls) {
    const modelKey=JSON.stringify([call.provider,call.model]);
    if(!models.has(modelKey)) models.set(modelKey,{provider:call.provider,model:call.model,calls:0});
    models.get(modelKey).calls++;
    values.reported+=call.reported;
    if(call.input!==null) {
      add('input',call.input);
      values.inputCount++;
      values.peak=Math.max(values.peak ?? 0,call.input);
      if(call.hit===null) add('unknownSplit',call.input);
      else {add('hit',call.hit);add('miss',call.miss);}
    }
    if(call.output!==null) {add('output',call.output);values.outputCount++;}
    add('write',call.write);
  }
  values.models=[...models.values()];
  return values;
}

export class TurnUsage {
  constructor(path,{legacyGap=false,isPiAi=()=>false}={}) {
    this.isPiAi=isPiAi;
    this.write(()=>{
      const db=new DatabaseSync(path);
      try {
        db.exec(`PRAGMA foreign_keys=ON;
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS turns (
            busId TEXT NOT NULL, key TEXT NOT NULL, sessionId TEXT NOT NULL, segment INTEGER NOT NULL,
            turn INTEGER NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT, reason TEXT,
            legacy INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(busId,key)
          );
          CREATE INDEX IF NOT EXISTS recent_turns ON turns(busId,endedAt DESC,segment DESC,turn DESC);
          CREATE TABLE IF NOT EXISTS calls (
            callId TEXT PRIMARY KEY, busId TEXT NOT NULL, key TEXT NOT NULL, step INTEGER NOT NULL,
            provider TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, startedAt INTEGER,
            endedAt INTEGER, status TEXT, usage TEXT, usageSource TEXT, layout TEXT,
            input INTEGER, hit INTEGER, miss INTEGER, output INTEGER, cacheWrite INTEGER,
            FOREIGN KEY(busId,key) REFERENCES turns(busId,key) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS turn_calls ON calls(busId,key,step,startedAt);
          CREATE TABLE IF NOT EXISTS usage_meta (id INTEGER PRIMARY KEY CHECK (id=1), legacyGap INTEGER NOT NULL);`);
        const {changes}=db.prepare('INSERT OR IGNORE INTO usage_meta (id,legacyGap) VALUES (1,?)').run(Number(legacyGap));
        // Upgrade derived counts in place; keep the original adapter snapshot for call details.
        if(changes) db.exec(`UPDATE calls SET usageSource=CASE status WHEN 'completed' THEN 'adapter-unverified-zero' ELSE 'adapter-error-zero' END,
          input=NULL,hit=NULL,miss=NULL,output=NULL,cacheWrite=NULL
          WHERE layout='pi-ai' AND usageSource IN ('adapter-reported','legacy-adapter-reported') AND substr(usage,1,1)='{'
            AND (SELECT COUNT(*)=SUM(type='integer' AND value=0) FROM json_each(CASE WHEN json_valid(usage) THEN usage END));`);
        db.exec('COMMIT');
        if(db.prepare('SELECT legacyGap FROM usage_meta WHERE id=1').get().legacyGap) {
          this.coverageError=contextError('LOOM_USAGE_LEGACY','历史用量覆盖不全；逐轮采集从启用后开始。');
        }
      } catch(error) {db.close();throw error;}
      this.db=db;
    },true);
  }
  write(operation,initializing=false) {
    try {operation();}
    catch(error) {
      if(!storageError(error,initializing)) throw error;
      this.error=contextError('LOOM_USAGE_STORAGE',initializing?'总控用量存储无法初始化。':'总控用量记录写入失败，部分轮次可能缺失。');
      this.error.cause=error;
    }
  }

  start(identity,startedAt) {
    const {busId,sessionId,segment,turn}=identity;
    this.write(()=>this.db?.prepare(`INSERT OR IGNORE INTO turns (busId,key,sessionId,segment,turn,startedAt)
      VALUES (?,?,?,?,?,?)`).run(busId,identityKey(identity),sessionId,segment,turn,startedAt));
  }
  end(identity,endedAt,reason) {
    const {busId}=identity;
    this.write(()=>{
      if(!this.db) return;
      this.db.prepare(`UPDATE turns SET endedAt=?,status=?,reason=? WHERE busId=? AND key=? AND endedAt IS NULL`)
        .run(endedAt,turnStatus(reason),reason,busId,identityKey(identity));
      this.prune(busId);
    });
  }
  reconcile(identity,endedTurns) {
    this.write(()=>{
      if(!this.db) return;
      const open=this.db.prepare('SELECT turn FROM turns WHERE busId=? AND sessionId=? AND endedAt IS NULL').all(identity.busId,identity.sessionId);
      if(!open.length) return;
      const ends=new Map(endedTurns.map(end=>[end.turn,end]));
      for(const {turn} of open) {
        const end=ends.get(turn);
        if(end) this.end({...identity,turn},end.endedAt,end.reason);
      }
    });
  }

  prune(busId) {
    this.db.prepare(`DELETE FROM turns WHERE busId=? AND key IN (
      SELECT key FROM turns WHERE busId=? AND endedAt IS NOT NULL ORDER BY endedAt DESC,segment DESC,turn DESC LIMIT -1 OFFSET ?
    )`).run(busId,busId,RETAIN);
  }
  begin(meta) {
    const {busId,step,callId,provider,model,purpose,startedAt}=meta;
    const key=identityKey(meta);
    this.write(()=>this.db?.prepare(`INSERT OR IGNORE INTO calls (callId,busId,key,step,provider,model,purpose,startedAt)
      SELECT ?,busId,key,?,?,?,?,? FROM turns WHERE busId=? AND key=? AND endedAt IS NULL`)
      .run(callId,step,provider,model,purpose,startedAt,busId,key));
    const sourceLayout=layout(provider,this.isPiAi);
    return receipt=>this.finish({busId,key,callId,sourceLayout},receipt);
  }
  finish({busId,key,callId,sourceLayout},{endedAt,usage,usageSource,finish,failure,aborted=false}) {
    const status=aborted || finish?.kind==='aborted' ? 'stopped' : failure || finish?.kind==='error' ? 'failed' : finish ? 'completed' : 'stopped';
    const raw=numericUsage(usage);
    // pi-ai emits its initialized all-zero snapshot even when a successful response omits usage.
    const unverifiedZero=sourceLayout==='pi-ai' && raw && Object.values(raw).every(value=>value===0);
    const value=normalizeUsage(sourceLayout,unverifiedZero ? undefined : raw);
    const source=unverifiedZero ? (status==='completed' ? 'adapter-unverified-zero' : 'adapter-error-zero') : raw ? usageSource : null;
    this.write(()=>this.db?.prepare(`UPDATE calls SET endedAt=?,status=?,usage=?,usageSource=?,layout=?,input=?,hit=?,miss=?,output=?,cacheWrite=?
      WHERE busId=? AND key=? AND callId=? AND endedAt IS NULL`)
      .run(endedAt,status,raw?JSON.stringify(raw):null,source,value.source,value.input,value.hit,value.miss,value.output,value.write,busId,key,callId));
  }
  query(busId,{key,limit=USAGE_LIMIT}={}) {
    if(key!==undefined && (typeof key!=='string' || key.length>512 || !key.length)) throw contextError('INVALID','请选择一个总控轮次。');
    if(!Number.isSafeInteger(limit) || limit<1 || limit>USAGE_LIMIT) throw contextError('INVALID',`轮次查询数量为 1 至 ${USAGE_LIMIT}。`);
    if(!this.db) throw this.error;
    const issue=this.error ?? this.coverageError;
    const queryError=issue ? {code:issue.code,message:issue.message} : null;
    if(key!==undefined) {
      const turn=this.db.prepare('SELECT * FROM turns WHERE busId=? AND key=? AND endedAt IS NOT NULL').get(busId,key);
      if(!turn) throw contextError('NOT_FOUND','此轮用量记录已超出保留范围。');
      const calls=this.db.prepare(`SELECT callId,step,provider,model,purpose,startedAt,endedAt,status,usage,usageSource,layout,input,hit,miss,output,cacheWrite AS write
        FROM calls WHERE busId=? AND key=? ORDER BY step,COALESCE(startedAt,endedAt),rowid`).all(busId,key);
      return {key,calls:calls.map(row=>({...row,status:row.status ?? 'stopped',usage:JSON.parse(row.usage)})),error:queryError};
    }
    const turns=this.db.prepare('SELECT * FROM turns WHERE busId=? AND endedAt IS NOT NULL ORDER BY endedAt DESC,segment DESC,turn DESC LIMIT ?').all(busId,limit);
    const numbers=this.db.prepare(`SELECT provider,model,purpose,COALESCE(usageSource IN ('adapter-reported','legacy-adapter-reported'),0) AS reported,input,hit,miss,output,cacheWrite AS write
      FROM calls WHERE busId=? AND key=? ORDER BY step,COALESCE(startedAt,endedAt),rowid`);
    return {items:turns.map(turn=>{
      const calls=numbers.all(busId,turn.key), main=summarize(calls.filter(call=>call.purpose==='conversation'));
      return {...turn,legacy:Boolean(turn.legacy),main,review:summarize(calls.filter(call=>call.purpose==='compaction')),combined:summarize(calls)};
    }),error:queryError};
  }
  close() {this.db?.close();}
}
