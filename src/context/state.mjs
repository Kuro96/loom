import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contextError, jsonBytes } from './budget.mjs';
export const FOCUS_MAX_BYTES = 8000;

export function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary,file);
}
export class BusState {
  constructor(directory, workspaceId) {
    this.directory = resolve(directory);
    mkdirSync(join(this.directory,'segments'),{recursive:true});
    this.file = join(this.directory,'bus.json');
    this.value = existsSync(this.file) ? JSON.parse(readFileSync(this.file,'utf8')) : {
      schema:1,busId:`loom-${randomUUID()}`,workspaceId,current:null,focus:{},checkpoint:null,pending:false,
    };
    if (this.value.schema !== 1) throw contextError('LOOM_STATE_VERSION','Unsupported Loom context schema');
    if (this.value.workspaceId !== workspaceId) throw contextError('LOOM_WORKSPACE_MISMATCH','Context directory belongs to another workspace');
    delete this.value.focus.displayOrder; // Order saved by older query tools has no reply provenance.
    this.save();
  }
  save() { atomicJson(this.file,this.value); }
  setFocus(focus) {
    const next = {...this.value.focus};
    for (const key of ['workspaceId','workflowId','workId','useId','constraints','references','latestIntent']) if (Object.hasOwn(focus,key)) next[key] = focus[key];
    if (jsonBytes(next) > FOCUS_MAX_BYTES) throw contextError('LOOM_FOCUS_BUDGET',`Focus must fit within ${FOCUS_MAX_BYTES} bytes`);
    this.value.focus = next; this.save();
    return structuredClone(next);
  }
  recordDisplay(display) { this.value.display = display; this.save(); }
  setCheckpoint(checkpoint) { this.value.checkpoint = checkpoint; this.save(); }
  setPending(messages, error = null) {
    atomicJson(join(this.directory,'pending.json'),{messages,error,sessionId:this.value.current?.sessionId,recordedAt:new Date().toISOString()});
    this.value.pending = true; this.save();
  }
  pending() { return this.value.pending ? JSON.parse(readFileSync(join(this.directory,'pending.json'),'utf8')) : null; }
  clearPending() {
    this.value.pending = false; this.save();
    const file = join(this.directory,'pending.json'); if (existsSync(file)) unlinkSync(file);
  }
  commitSegment(sessionId) {
    const previous = this.value.current;
    if (previous) atomicJson(join(this.directory,'segments',`${previous.segment}.json`),previous);
    this.value.current = {sessionId,busId:this.value.busId,segment:(previous?.segment ?? 0)+1,
      ...(previous ? {previousSessionId:previous.sessionId} : {})};
    this.save(); return structuredClone(this.value.current);
  }
  readSegment(index) { return JSON.parse(readFileSync(join(this.directory,'segments',`${index}.json`),'utf8')); }
  history({cursor,limit=20}={}) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>50) throw contextError('LOOM_HISTORY_LIMIT','History limit must be 1..50');
    const total = Math.max(0,(this.value.current?.segment ?? 1)-1);
    let index = cursor === undefined ? total : Number(cursor);
    if (!Number.isSafeInteger(index) || index<0 || index>total) throw contextError('LOOM_HISTORY_CURSOR','Invalid segment cursor');
    const items = [];
    while (index>0 && items.length<limit) { items.push(this.readSegment(index)); index--; }
    return {items,total,nextCursor:index>0?String(index):null};
  }
}
