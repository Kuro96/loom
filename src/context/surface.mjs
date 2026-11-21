import { createRequire } from 'node:module';
import { contextError } from './budget.mjs';
const require=createRequire(import.meta.url);

export function selectRegion(session,{incomingMessages=[]}={}) {
  const {toolPairingBalancedAfter}=require('@deepseek-ai/dsh-compaction');
  const units=[],latest=new Map(),userIds=new Set(); let unit=[];
  for(const seq of session.surface.nodes) {
    const event=session.eventAt(seq),message=event.type==='user/message'?event.data:event.data.message;
    unit.push({seq,message});
    if(message.role==='user') {
      latest.set(message.source.kind,unit);
      if(message.source.kind==='user') userIds.add(message.id);
    }
    if(message.role==='assistant') latest.set('assistant',unit);
    if(toolPairingBalancedAfter(session,seq)) {units.push(unit);unit=[];}
  }
  const keep=new Set([units.at(-1),...['runtime-context','skill-catalog','time-context'].map(kind=>latest.get(kind))]);
  if(!incomingMessages.some(message=>message.source.kind==='user' && !userIds.has(message.id))) keep.add(latest.get('user'));
  const assistant=latest.get('assistant');
  if(assistant?.some(entry=>entry.message.role==='tool')) keep.add(assistant);
  let entries=[];
  for(const group of units) {
    if(keep.has(group) || group.some(entry=>entry.message.role==='system')) {
      if(entries.some(entry=>entry.message.source.kind!=='loom-context')) break;
      entries=[];
    } else entries.push(...group);
  }
  if(!entries.length) return null;
  const seqs=entries.map(entry=>entry.seq);
  return {startSeq:seqs[0],endSeq:seqs.at(-1),seqs,messages:entries.map(entry=>entry.message)};
}
export function replaceRegion(session,region,message) {
  const {toolPairingBalancedBefore,toolPairingBalancedAfter}=require('@deepseek-ai/dsh-compaction');
  const nodes=session.surface.nodes;
  const start=nodes.indexOf(region.startSeq);
  const actual=nodes.slice(start,start+region.seqs.length);
  if(start<0 || JSON.stringify(actual)!==JSON.stringify(region.seqs)) throw contextError('LOOM_SURFACE_CHANGED','Surface changed during context review');
  if(!toolPairingBalancedBefore(session,region.startSeq)||!toolPairingBalancedAfter(session,region.endSeq)) throw contextError('LOOM_TOOL_PAIRING','Replacement crosses a tool interaction');
  session.append('user/message',message,{surfaceOp:{op:'replace',startSeq:region.startSeq,endSeq:region.endSeq},sourceEventSeqs:region.seqs});
}
