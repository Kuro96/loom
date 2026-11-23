import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { LoomStore } from './core/store.mjs';
import { LoomEngine } from './host/engine.mjs';
import {createWorkerBinder} from './host/worker.mjs';
import {previewTarget} from './host/report-preview.mjs';
import {draftFromManual, generateManualDraft} from './host/manual-workflow.mjs';
import { createLoomContext } from './context/index.mjs';
import {loomDirectory} from './bootstrap.mjs';

export const name='loom';
export const inject=['loomBootstrap','connection','webServer','workspaceRegistry','workspaceController','sessionController','agents','llm','systemPrompt','tools','tokenMeter','subprocess','permissionPresets'];

/** Compose the persistent work service, native execution and one scoped bus. */
export async function apply(ctx,config={}) {
  const directory=loomDirectory(config);
  const controlPath=join(directory,'control');
  const bootstrap=ctx.loomBootstrap,owner={};
  if(directory!==bootstrap.directory) throw new Error('Loom directory differs from bootstrap; reload the bundle configuration');
  bootstrap.claim(owner);
  for(const agent of ctx.agents.list()) bootstrap.protect(agent);
  const bindingReady={resolve:context=>bootstrap.complete(owner,context),reject:error=>bootstrap.fail(owner,error)};
  ctx.effect(()=>()=>bindingReady.reject(new Error('Loom binding is closed')),'loom: bootstrap generation');
  try {
    return await initialize(ctx,config,bindingReady,directory,controlPath);
  } catch(error) {
    bindingReady.reject(error);
    throw error;
  }
}

async function initialize(ctx,config,bindingReady,directory,controlPath) {
  await mkdir(directory,{recursive:true});
  await mkdir(controlPath,{recursive:true});
  const {workspace}=await ctx.workspaceController.create({path:controlPath});
  const store=new LoomStore(join(directory,'loom.sqlite'));
  ctx.effect(()=>()=>store.close(),'loom: sqlite');
  store.syncWorkspaces(ctx.workspaceRegistry.list().map(w=>({workspaceId:w.id,path:w.path,title:w.title})));
  const worker=createWorkerBinder(store);
  ctx.effect(()=>()=>worker.dispose(),'loom: worker binding');
  let engine;
  const context=await createLoomContext(ctx,{
    directory:join(directory,'context'),workspaceId:workspace.workspaceId,
    getSettings:()=>store.getSettings(),query:request=>store.query(request),
    command:(request,actor)=>engine.command(request,{kind:'agent',...(actor?.sessionId?{sessionId:actor.sessionId}:{})}),
    modelCatalog:()=>ctx.sessionController.modelCatalog(),
    resolveBus:id=>ctx.sessionController.resolveAgent(id),
  });
  ctx.effect(()=>()=>context.dispose(),'loom: context');
  engine=new LoomEngine(ctx,store,context,{intervalMs:config.intervalMs ?? 2000,bindWorker:worker.bindAgent});
  bindingReady.resolve({async bindAgent(agent){await context.bindAgent(agent);await worker.bindAgent(agent);}});
  await context.bindCurrent();
  for(const agent of ctx.agents.list()) await worker.bindAgent(agent);
  engine.start();
  ctx.effect(()=>()=>engine.dispose(),'loom: dispatcher');

  const status=()=>({version:'0.1.1',directory,bus:context.getBus(),context:context.getStatus(),engine:engine.status()});
  const handlers={
    status:()=>status(),
    usage:payload=>context.getUsage(payload),
    snapshot:(payload)=>{
      const workspaces=engine.native.workspaces();
      store.syncWorkspaces(workspaces);
      return {works:store.query({kind:'work',...payload}),workflows:store.query({kind:'workflow',workspaceId:payload.workspaceId,limit:100}),uses:store.query({kind:'use',workspaceId:payload.workspaceId,limit:100}),workspaces,settings:store.getSettings(),bus:context.getBus(),engine:engine.status(),context:context.getStatus()};
    },
    query:payload=>store.query(payload),
    checkDeletion:payload=>store.checkDeletion(payload),
    preview:payload=>previewTarget(store,controlPath,ctx.workspaceRegistry,payload),
    manualDraft:(payload, signal)=>draftFromManual({
      workspace:typeof payload.workspaceId==='string' && payload.workspaceId!==workspace.workspaceId ? ctx.workspaceRegistry.get(payload.workspaceId) : null,
      store, request:payload,
      generate:async evidence=>generateManualDraft(ctx,store.getSettings().roleModels.bus ?? (await engine.native.modelCatalog()).default,evidence,AbortSignal.any([signal,AbortSignal.timeout(90000)])),
    }),
    command:payload=>engine.command(payload,{kind:'user'}),
    models:()=>engine.native.modelCatalog(),
    permissions:()=>ctx.permissionPresets.catalog(),
    ensureBus:()=>context.ensureBus(),
    nativeSessions:()=>engine.native.sessions(),
    tick:()=>engine.tick(),
  };
  for(const [endpoint,handler] of Object.entries(handlers)) ctx.connection.fetch.register({
    path:`/api/loom/${endpoint}`,methods:['POST'],requestBody:'buffered',
    fetch:async request=>{
      let envelope;
      try {envelope=await request.json();}
      catch(error) {if(error instanceof SyntaxError) return new Response('Invalid JSON',{status:400});throw error;}
      if(envelope===null || envelope.type!=='client-request' || typeof envelope.rpcId!=='string' || envelope.method!==`loom/${endpoint}`) return new Response('Invalid RPC envelope',{status:400});
      const respond=result=>Response.json({type:'server-response',rpcId:envelope.rpcId,result});
      const payload=envelope.payload;
      if(payload===null || typeof payload!=='object' || Array.isArray(payload)) return respond({ok:false,error:{code:'INVALID',message:'请求参数必须为对象',details:{}}});
      try {return respond({ok:true,value:await handler(payload,request.signal)});}
      catch(error) {
        ctx.logger.error(error);
        return respond({ok:false,error:{code:error.code ?? 'LOOM_ERROR',message:error.message,details:error.code==='INVALID_DEPENDENCY' && error.details?.references ? {references:error.details.references} : {}}});
      }
    },
  });
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/loom/health',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json(status())}),'loom: health');
}
