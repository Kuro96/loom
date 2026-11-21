import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { contextError, redact, safeUrl, prefixDigest } from './budget.mjs';
import { numericUsage } from './usage.mjs';

const paths = /\/(?:chat\/completions|messages|responses|completions)\/?$/;
export const HTTP_PROVIDERS = ['deepseek-official','deepseek-account','moonshotai-cn'];

export class DebugJournal {
  constructor(directory,getConfig) { this.directory=directory; this.getConfig=getConfig; }
  write(record) {
    const config=this.getConfig(); if (!config.debug) return false;
    const line=JSON.stringify(record)+'\n', bytes=Buffer.byteLength(line);
    if (bytes>config.debugMaxBytes) return false;
    try {
      mkdirSync(this.directory,{recursive:true});
      const file=join(this.directory,'wire-0.jsonl');
      if (existsSync(file) && statSync(file).size+bytes>config.debugMaxBytes) {
        for(let n=config.debugFiles-1;n>=0;n--) {
          const from=join(this.directory,`wire-${n}.jsonl`);
          if (existsSync(from)) {
            if(n===config.debugFiles-1) unlinkSync(from);
            else renameSync(from,join(this.directory,`wire-${n+1}.jsonl`));
          }
        }
      }
      appendFileSync(file,line,{mode:0o600});
      return true;
    } catch(error) {
      if (!error.syscall) throw error;
      this.errorCode=error.code;
      return false;
    }
  }
}
// Inspect string bodies only: Request and stream bodies belong to the transport.
function captureRequest(trace,input,init,journal,config) {
  const raw=init?.body;
  if(typeof raw!=='string' || (init.method ?? input?.method)?.toUpperCase()!=='POST') return;
  const url=new URL(input instanceof Request?input.url:input);
  if(!paths.test(url.pathname)) return;
  const headers=new Headers(init.headers ?? (input instanceof Request?input.headers:undefined));
  if((headers.get('content-encoding') ?? 'identity')!=='identity') return;
  const contentType=headers.get('content-type');
  if(contentType && !/^(?:application\/json|application\/[\w.+-]+\+json)(?:\s*;|$)/i.test(contentType)) return;
  const attemptId=randomUUID(),wireBytes=Buffer.byteLength(raw),secrets=[];
  const record={type:'wire-request',...trace.meta,callId:trace.callId,attemptId,wireBytes};
  let captured=false;
  if(wireBytes<=config.debugMaxBytes) {
    const body=JSON.parse(raw);
    if(!body || typeof body!=='object' || Array.isArray(body)) return;
    for(const [key,value] of headers) if(/authorization|cookie|key|token|credential|secret/i.test(key)) {
      secrets.push(value,value.replace(/^Bearer\s+/i,''));
      if(/cookie/i.test(key)) for(const part of value.split(';')) secrets.push(part.slice(part.indexOf('=')+1).trim());
    }
    const cleaned=redact(body,secrets),payload=JSON.stringify(cleaned);
    const publicHeaders=Object.fromEntries([...headers].filter(([key])=>['content-type','accept','anthropic-version','openai-beta'].includes(key)).map(([key,value])=>[key,redact(value,secrets)]));
    const stable={system:cleaned.system ?? (Array.isArray(cleaned.messages)?cleaned.messages.filter(m=>m?.role==='system'||m?.role==='developer'):[]),tools:cleaned.tools ?? []};
    captured=journal.write({...record,wireCaptured:true,url:safeUrl(url),headers:publicHeaders,payload,redactedBytes:Buffer.byteLength(payload),prefixHash:prefixDigest(stable)});
  }
  if(!captured) journal.write({...record,wireCaptured:false});
  trace.wireCaptured ||= captured;
  trace.attempts++;
  if(captured) return {attemptId,secrets};
}
export class WireObserver {
  constructor({directory,getConfig,getAdditionalProviders=()=>[],owns,identity,beginCall}) {
    this.getConfig=getConfig; this.getAdditionalProviders=getAdditionalProviders; this.owns=owns; this.identity=identity; this.beginCall=beginCall; this.als=new AsyncLocalStorage();
    this.journal=new DebugJournal(directory,getConfig); this.active=new Set(); this.calls=0; this.callsWithUsage=0; this.usageTotals={}; this.latest=null; this.installed=false;
  }
  install() {
    if(this.installed) throw contextError('LOOM_WIRE_INSTALLED','Wire observer already installed');
    this.original=globalThis.fetch;
    const self=this;
    this.wrapper=async function(input,init) {
      const trace=self.als.getStore();
      if(!trace || !self.owns(trace.sessionId)) return self.original(input,init);
      const config=self.getConfig();
      if(!config.debug) return self.original(input,init);
      let attempt;
      try { attempt=captureRequest(trace,input,init,self.journal,config); }
      catch(error) {
        if(!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
      }
      if(!attempt) return self.original(input,init);
      const {attemptId,secrets}=attempt;
      try {
        const response=await self.original(input,init);
        self.journal.write({type:'wire-response',callId:trace.callId,attemptId,status:response.status,requestId:redact(response.headers.get('x-request-id') ?? response.headers.get('request-id'),secrets)});
        return response;
      } catch(error) {
        self.journal.write({type:'wire-error',callId:trace.callId,attemptId,error:{name:error.name,code:error.code ?? 'TRANSPORT_ERROR'}});
        throw error;
      }
    };
    globalThis.fetch=this.wrapper; this.installed=true;
  }
  observe(options,next) {
    if(!this.owns(options.sessionId)) return next();
    const trace={sessionId:options.sessionId,callId:randomUUID(),attempts:0,wireCaptured:false,
      meta:{...this.identity(options.sessionId,options),sessionId:options.sessionId,provider:options.provider,model:options.model,purpose:options.purpose ?? 'conversation',startedAt:Date.now()}};
    return this.stream(trace,next,options.signal);
  }
  httpProviders(config) {return config.httpProviders ?? [...new Set([...HTTP_PROVIDERS,...this.getAdditionalProviders()])];}
  async *stream(trace,next,signal) {
    const config=this.getConfig();
    const providers=config.debug ? this.httpProviders(config) : null;
    const scope=Array.isArray(providers) && providers.includes(trace.meta.provider) ? trace : undefined;
    const run=fn=>this.als.run(scope,fn);
    const finishCall=this.beginCall?.({...trace.meta,callId:trace.callId});
    this.calls++;
    const done=Promise.withResolvers(); this.active.add(done.promise);
    let iterator,completed=false,usage,finish,failure;
    try {
      iterator=run(()=>next()[Symbol.asyncIterator]());
      while(true) {
        const part=await run(()=>iterator.next());
        if(part.done) { completed=true; break; }
        if(part.value.type==='usage') usage=numericUsage(part.value.usage);
        if(part.value.type==='finish') {
          const reason=part.value.reason;
          finish=reason && typeof reason==='object' ? {kind:reason.kind,...(reason.failure?{failure:{code:reason.failure.code}}:{})} : reason;
        }
        yield part.value;
      }
    } catch(error) { failure={name:error.name,code:error.code ?? error.failure?.code ?? 'LLM_ERROR'}; throw error; }
    finally {
      try {
        try {if(iterator && !completed && iterator.return) await run(()=>iterator.return());}
        catch(error) {failure={name:error.name,code:error.code ?? error.failure?.code ?? 'LLM_ERROR'};throw error;}
        finally {
          if(usage) {
            this.callsWithUsage++;
            for(const [key,value] of Object.entries(usage)) this.usageTotals[key]=(this.usageTotals[key] ?? 0)+value;
          }
          this.latest={...trace.meta,callId:trace.callId,endedAt:Date.now(),attempts:trace.attempts,wireCaptured:trace.wireCaptured,
            ...(usage ? {usage,usageSource:'adapter-reported'} : {}),finish,failure};
          finishCall?.({...this.latest,aborted:signal?.aborted===true});
          this.journal.write({type:'llm-call-end',...this.latest});
        }
      } finally { this.active.delete(done.promise); done.resolve(); }
    }
  }
  status() {
    return structuredClone({calls:this.calls,callsWithUsage:this.callsWithUsage,usageTotals:this.usageTotals,active:this.active.size,latest:this.latest,
      journalError:this.journal.errorCode,capability:'http-json-fetch',httpProviders:this.httpProviders(this.getConfig())});
  }
  async dispose() {
    await Promise.all([...this.active]);
    if(this.installed && globalThis.fetch===this.wrapper) globalThis.fetch=this.original;
    this.installed=false; this.als.disable();
  }
}
