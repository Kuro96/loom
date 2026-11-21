import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { foldRunEvents } from '../src/host/events.mjs';

test('report receipts retain exact owned turn and call identity across incremental pages',()=>{
  const session=Session.create(SessionId('report-pages'));
  const records=[];
  const append=(type,data,options)=>records.push({event:session.append(type,data,options)});
  const report=(callId,turn=2)=>({report:{kind:'result',summary:callId,outputs:{}},source:{sessionId:session.id,requestId:'request',turn,callId}});
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
