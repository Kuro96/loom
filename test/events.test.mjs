import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { foldRunEvents } from '../src/host/events.mjs';

test('report receipts retain exact owned turn and call identity across incremental pages',()=>{
  const session=Session.create(SessionId('report-pages'));
  const records=[];
  const append=(type,data,options)=>records.push({event:session.append(type,data,options)});
  const report=(callId,turn=2)=>({report:{kind:'result',summary:callId,outputs:{}},source:{sessionId:session.id,requestId:'request',turn,step:1,callId}});
  let run={sessionId:session.id,requestId:'request',cursor:-1,reports:[report('denied'),report('valid'),report('foreign',1)]};
  append('turn/start',{turn:2});
  append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[]}),{surfaceOp:'append'});
  for(const [callId,turn,isError] of [['denied',2,true],['foreign',1,false],['valid',1,false],['unreported',2,false],['valid',2,false]]) {
    append('tool/result',{turn,step:1,message:createToolResultMessage({callId,content:[],isError})},{surfaceOp:'append'});
  }
  const first=foldRunEvents(run,records);
  assert.deepEqual(first.reportReceipts.map(({callId,turn,isError})=>({callId,turn,isError})),[
    {callId:'denied',turn:2,isError:true},{callId:'valid',turn:2,isError:false},
  ]);
  run=JSON.parse(JSON.stringify({...run,cursor:first.cursor,observation:first}));
  records.length=0;append('turn/end',{turn:2,reason:{kind:'completed'}});
  const completed=foldRunEvents(run,records);
  assert.deepEqual(completed.reportReceipts,first.reportReceipts);
  assert.equal(completed.completion.turn,2);
  assert.equal(first.completion,null);
});

function jobEvents(id) {
  const session=Session.create(SessionId(id)),records=[];
  const run={sessionId:session.id,requestId:'owned-input',cursor:-1};
  const append=(type,data,options)=>{const event=session.append(type,data,options);records.push({event});return event.seq;};
  const start=(turn,rpcId=run.requestId)=>{
    append('turn/start',{turn});
    append('user/message',createUserMessage({source:{kind:'user',rpcId},content:[]}),{surfaceOp:'append'});
  };
  const call=(turn,step)=>append('tool/call',{turn,step,callId:'shared',name:'pwsh',arguments:'{}'});
  const result=(turn,step)=>append('tool/result',{turn,step,message:createToolResultMessage({callId:'shared',content:[],isError:false})},{surfaceOp:'append'});
  const end=turn=>append('turn/end',{turn,reason:{kind:'completed'}});
  const job=(type,jobId,overrides={})=>{
    const {toolCall,...data}={toolCall:{callId:'shared',rootCallId:'shared'},...overrides};
    return append(`job/${type}`,{jobId,owner:session.id,kind:'pwsh',label:'test job',startedAt:1,
      ...(toolCall===undefined?{}:{toolCall}),...(type==='settled'?{finishedAt:2,status:'failed',cause:'producer',producerReported:true}:{}),...data});
  };
  return {run,records,start,call,result,end,job};
}

test('job receipt keeps the original registration and first settlement across replay',()=>{
  const {run,records,start,call,result,end,job}=jobEvents('job-replay');
  start(1);
  const callSeq=call(1,2);
  records.push(records.at(-1));
  const before=foldRunEvents(run,records);
  const advance=observation=>JSON.parse(JSON.stringify({...run,cursor:observation.cursor,observation}));
  const registrationSeq=job('registered','deferred');
  job('registered','deferred');
  result(1,2);end(1);
  const waiting=foldRunEvents(advance(before),records);
  assert.deepEqual(waiting.jobReceipts,[]);
  const settlementSeq=job('settled','deferred');
  job('settled','deferred',{status:'killed'});
  const settled=foldRunEvents(advance(waiting),records);
  const expected=[{owner:run.sessionId,jobId:'deferred',registrationSeq,settlementSeq,status:'failed',turn:1,step:2,callId:'shared',callSeq}];
  assert.deepEqual(settled.jobReceipts,expected);
  assert.deepEqual(foldRunEvents(advance(settled),records).jobReceipts,expected);
});

test('job receipt requires a live direct call in the admitted turn and the original owner',()=>{
  const {run,records,start,call,result,end,job}=jobEvents('job-ownership');
  start(1,'earlier-input');call(1,0);job('registered','earlier-turn');result(1,0);end(1);
  start(2);call(2,0);result(2,0);
  job('registered','closed-step');
  const callSeq=call(2,1);
  job('registered','foreign',{owner:'elsewhere'});
  job('registered','no-provenance',{toolCall:undefined});
  job('registered','child',{toolCall:{callId:'shared',rootCallId:'parent'}});
  const registrationSeq=job('registered','owned');
  result(2,1);end(2);
  start(3,'later-input');call(3,1);job('registered','later-turn');result(3,1);end(3);
  for(const id of ['earlier-turn','closed-step','foreign','no-provenance','child','later-turn','orphan']) job('settled',id);
  job('settled','owned',{owner:'elsewhere'});
  job('settled','owned',{status:'running'});
  const settlementSeq=job('settled','owned');
  const observation=foldRunEvents(run,records);
  assert.deepEqual(observation.jobReceipts,[{owner:run.sessionId,jobId:'owned',registrationSeq,settlementSeq,status:'failed',turn:2,step:1,callId:'shared',callSeq}]);
});
