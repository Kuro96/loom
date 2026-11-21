/** Fold an incremental native event page into one delivery's observation. */
export function foldRunEvents(run,records) {
  const previous=run.observation ?? {lastTurn:null,ownedTurn:null,admitted:false,summary:'',completion:null};
  const result={...previous,cursor:run.cursor,reportReceipts:[...(previous.reportReceipts??[])]};
  for(const {event} of records) {
    if(event.seq<=run.cursor) continue;
    result.cursor=Math.max(result.cursor,event.seq);
    if(event.type==='turn/start') result.lastTurn=event.data.turn;
    if(event.type==='user/message' && event.data.source.rpcId===run.requestId) {
      result.admitted=true;
      result.ownedTurn=result.lastTurn;
    }
    if(event.type==='assistant/message' && result.admitted && event.data.turn===result.ownedTurn) {
      result.summary=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').slice(-16000);
    }
    if(event.type==='tool/result' && result.admitted && event.data.turn===result.ownedTurn) {
      const {turn,message}=event.data;
      const candidate=(run.reports??[]).find(({source})=>source.sessionId===run.sessionId && source.requestId===run.requestId && source.turn===turn && source.callId===message.toolCallId);
      if(candidate && !result.reportReceipts.some(receipt=>receipt.turn===turn && receipt.callId===message.toolCallId)) {
        result.reportReceipts.push({turn,callId:message.toolCallId,isError:message.isError,seq:event.seq});
      }
    }
    if(event.type==='turn/end' && result.admitted && event.data.turn===result.ownedTurn) {
      result.completion={reason:event.data.reason.kind,turn:event.data.turn,endSeq:event.seq,summary:result.summary};
    }
  }
  return result;
}
