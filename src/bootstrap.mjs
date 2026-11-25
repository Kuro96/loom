import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {guardAgent} from './context/binding.mjs';
import {isProjectCoordinatorSessionId} from './context/project-coordinator.mjs';
import {isInvestigationSessionId} from './core/investigation.mjs';
export const name='loom-bootstrap';
export const inject=[];
export function loomDirectory(config={}) {
  return resolve(config.directory ?? join(process.env.DSH_HOME ?? join(homedir(),'.dsh'),'loom'));
}
export function apply(ctx,config={}) {
  const entry=ctx.fiber.entry;
  const main=entry?.parent.data.find(row=>row.id==='loom');
  let configured=main ? main.config?.directory : config.directory;
  if(configured && typeof configured==='object' && '__jsExpr' in configured) configured=entry.evaluate(configured.__jsExpr);
  const directory=loomDirectory({directory:configured}),controlPath=join(directory,'control');
  let ready=Promise.withResolvers(),owner=null;
  const watch=()=>ready.promise.catch(error=>ctx.logger.error(error));
  watch();
  let database=null;
  const workerSession=agent=>{
    if(database===null){
      const path=join(directory,'loom.sqlite');
      if(!existsSync(path)) return false;
      database=new DatabaseSync(path,{readOnly:true});
    }
    return database.prepare("SELECT 1 FROM works WHERE json_extract(body,'$.sessionId')=? LIMIT 1").get(agent.id)!==undefined;
  };
  ctx.effect(()=>()=>{if(database!==null)database.close();},'loom: worker identity lookup');
  const matches=agent=>isProjectCoordinatorSessionId(agent.id) || isInvestigationSessionId(agent.id) ||
    (agent.session.header.cwd!==undefined && resolve(agent.session.header.cwd)===controlPath) || workerSession(agent);
  ctx.on('agent/created',async({agent})=>{
    if(!matches(agent)) return;
    const binding=guardAgent(agent);
    if(binding.active) return;
    await (await ready.promise).bindAgent(agent);
    if(!binding.active) throw Object.assign(new Error('Loom binding is closed'),{code:'LOOM_BINDING_CLOSED'});
  },{prepend:true});
  ctx.provide('loomBootstrap',{
    directory,
    claim(candidate){if(owner!==null){ready=Promise.withResolvers();watch();}owner=candidate;},
    complete(candidate,context){if(owner===candidate)ready.resolve(context);},
    fail(candidate,error){if(owner===candidate)ready.reject(error);},
    protect(agent){if(matches(agent))guardAgent(agent).active=false;},
  });
}
