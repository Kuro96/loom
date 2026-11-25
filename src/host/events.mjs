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

/** Fold chronological native events into one delivery's observation. */
export function foldRunEvents(run,records) {
  const previous=run.observation ?? {lastTurn:null,ownedTurn:null,admitted:false,summary:'',completion:null};
  const result={...previous,cursor:run.cursor,reportReceipts:[...(previous.reportReceipts??[])],
    openJobCalls:[...(previous.openJobCalls??[])],pendingJobs:[...(previous.pendingJobs??[])],jobReceipts:[...(previous.jobReceipts??[])]};
  for(const {event} of records) {
    if(event.seq<=result.cursor) continue;
    result.cursor=event.seq;
    if(event.type==='turn/start') result.lastTurn=event.data.turn;
    if(event.type==='user/message' && event.data.source.rpcId===run.requestId) {
      result.admitted=true;
      result.ownedTurn=result.lastTurn;
    }
    foldJobEvent(run,result,event);
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
