export function sameReportInvocation(receipt,source) {
  return Number.isSafeInteger(source.step) && receipt.step===source.step && receipt.turn===source.turn && receipt.callId===source.callId;
}

const terminalJobStatuses=new Set(['completed','failed','killed']);

function foldJobEvent(run,result,event) {
  const {type,data,seq}=event;
  const ownedTurn=result.ownedTurn;
  const inOwnedTurn=result.admitted && Number.isSafeInteger(ownedTurn) && result.lastTurn===ownedTurn && result.completion===null;
  if(type==='turn/start' || (type==='turn/end' && data.turn===ownedTurn)) result.openJobCalls=[];
  if(type==='tool/call' && inOwnedTurn && data.turn===ownedTurn && Number.isSafeInteger(data.step)) {
    result.openJobCalls.push({turn:data.turn,step:data.step,callId:data.callId,callSeq:seq});
  }
  if(type==='tool/result' && inOwnedTurn && data.turn===ownedTurn) {
    result.openJobCalls=result.openJobCalls.filter(call=>!sameReportInvocation(call,{turn:data.turn,step:data.step,callId:data.message.toolCallId}));
  }
  if(type!=='job/registered' && type!=='job/settled') return;
  const {owner,jobId,toolCall}=data;
  if(owner!==run.sessionId || typeof jobId!=='string' || !jobId || typeof toolCall?.callId!=='string' || toolCall.callId!==toolCall.rootCallId) return;
  const registered=result.pendingJobs.find(job=>job.jobId===jobId);
  if(type==='job/registered') {
    if(!inOwnedTurn || registered || result.jobReceipts.some(job=>job.jobId===jobId)) return;
    // Native job provenance names the direct call, while its open invocation supplies the step.
    const calls=result.openJobCalls.filter(call=>call.callId===toolCall.callId);
    if(calls.length===1) result.pendingJobs.push({owner,jobId,registrationSeq:seq,...calls[0]});
  } else if(registered?.callId===toolCall.callId && seq>registered.registrationSeq && terminalJobStatuses.has(data.status)) {
    result.jobReceipts.push({...registered,settlementSeq:seq,status:data.status});
    result.pendingJobs=result.pendingJobs.filter(job=>job.jobId!==jobId);
  }
}

// The native view carries only callId. Direct calls, PTC subcalls and tool results
// can share that key; check their locators before attributing a row to a Run.
export function questionEventCallId({type,data}) {
  switch(type) {
    case 'tool/call': return data.callId;
    case 'tool/ptc-dispatch': return data.subCallId;
    case 'tool/result': return data.message.toolCallId;
    case 'user/message': return data.source.kind==='user-question-reply'?data.source.callId:undefined;
  }
}

export function questionUpdates(observation,view) {
  const states=new Map(view.settled.map(({callId})=>[callId,'settled']));
  for(const {callId,state} of view.active) states.set(callId,state);
  return observation.questionCalls.flatMap(call=>{
    const status=states.get(call.callId);
    const previous=observation.questionReceipts?.find(receipt=>receipt.callSeq===call.callSeq);
    return status===undefined || previous?.status===status?[]:[{...call,status}];
  });
}

export function applyQuestionUpdates(observation,updates,records,asOfSeq) {
  const byId=new Map(),replyTurns=new Map();
  let turn=null;
  for(const {event} of records) {
    if(event.type==='turn/start') {turn=event.data.turn;continue;}
    if(event.type==='turn/end') {turn=null;continue;}
    if(event.type==='user/message') replyTurns.set(event.seq,turn);
    const id=questionEventCallId(event);
    if(!byId.has(id)) byId.set(id,[]);
    byId.get(id).push(event);
  }
  const receipts=new Map((observation.questionReceipts??[]).map(receipt=>[receipt.callSeq,receipt])),ambiguous=new Set();
  for(const call of updates) {
    const events=byId.get(call.callId)??[];
    const origins=events.filter(event=>event.type==='tool/call' || event.type==='tool/ptc-dispatch');
    const results=events.filter(event=>event.type==='tool/result');
    if(origins.length>1 || results.length>1 || results.some(({seq,data})=>seq<=call.callSeq || data.turn!==call.turn || data.step!==call.step)) {
      // Appending events cannot resolve a reused key. Keep any earlier receipt at its original cut.
      ambiguous.add(call.callId);
      continue;
    }
    if(origins[0]?.seq!==call.callSeq || origins[0].type!=='tool/call') continue;
    const receipt={...call,asOfSeq};
    if(call.status==='settled') {
      const [result]=results;
      if(result===undefined) continue;
      const reply=events.find(event=>event.type==='user/message' && event.seq>result.seq && event.data.source.outcome==='answered');
      if(reply) {
        const turn=replyTurns.get(reply.seq);
        if(turn===null) continue;
        receipt.reply={kind:'user-question-reply',seq:reply.seq,turn,messageId:reply.data.id,outcome:reply.data.source.outcome};
      } else receipt.resultSeq=result.seq;
    }
    receipts.set(call.callSeq,receipt);
  }
  return {...observation,
    ...(ambiguous.size?{questionCalls:observation.questionCalls.filter(call=>!ambiguous.has(call.callId))}:{}),
    ...(receipts.size?{questionReceipts:[...receipts.values()].sort((a,b)=>a.callSeq-b.callSeq)}:{})};
}

/** Fold chronological native events into one delivery's observation. */
export function foldRunEvents(run,records) {
  const previous=run.observation ?? {lastTurn:null,ownedTurn:null,admitted:false,summary:'',completion:null};
  const result={...previous,cursor:run.cursor,reportReceipts:[...(previous.reportReceipts??[])],
    openJobCalls:[...(previous.openJobCalls??[])],pendingJobs:[...(previous.pendingJobs??[])],jobReceipts:[...(previous.jobReceipts??[])],
    questionCalls:[...(previous.questionCalls??[])]};
  for(const {event} of records) {
    if(event.seq<=result.cursor) continue;
    result.cursor=event.seq;
    if(event.type==='turn/start') result.lastTurn=event.data.turn;
    if(event.type==='user/message' && event.data.source.rpcId===run.requestId) {
      result.admitted=true;
      result.ownedTurn=result.lastTurn;
    }
    foldJobEvent(run,result,event);
    if(event.type==='tool/call' && event.data.name==='ask_user_question' && result.admitted && result.completion===null &&
      event.data.turn===result.ownedTurn && result.ownedTurn===result.lastTurn && Number.isSafeInteger(event.data.step)) {
      const {turn,step,callId}=event.data;
      result.questionCalls.push({sessionId:run.sessionId,requestId:run.requestId,turn,step,callId,callSeq:event.seq});
    }
    if(event.type==='assistant/message' && result.admitted && event.data.turn===result.ownedTurn) {
      result.summary=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').slice(-16000);
    }
    if(event.type==='tool/result' && result.admitted && event.data.turn===result.ownedTurn) {
      const {turn,step,message}=event.data;
      const receipt={turn,step,callId:message.toolCallId,isError:message.isError,seq:event.seq};
      const candidate=(run.reports??[]).find(({source})=>source.sessionId===run.sessionId && source.requestId===run.requestId && sameReportInvocation(receipt,source));
      if(candidate && !result.reportReceipts.some(previous=>sameReportInvocation(previous,candidate.source))) {
        result.reportReceipts.push(receipt);
      }
    }
    if(event.type==='turn/end' && result.admitted && event.data.turn===result.ownedTurn) {
      result.completion={reason:event.data.reason.kind,turn:event.data.turn,endSeq:event.seq,summary:result.summary};
    }
  }
  return result;
}
