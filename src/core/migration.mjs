import { definitionSchema, requireValue } from './schema.mjs';

export const activeRunSQL = "('dispatching','accepted','running','pause_requested','cancel_requested')";
export const investigationConsentSQL = body => `json_extract(${body},'$.modelConsent.actor.kind')='host'
  AND json_extract(${body},'$.modelConsent.actor.source')='readonly-investigation'`;
export const runLaneSQL = body => `CASE json_extract(${body},'$.lane') WHEN 'investigation' THEN 'investigation' ELSE 'write' END`;

// Called inside the store's schema transaction.
export function migrate(db,permissionPreset) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  requireValue(version<=2,`数据库版本${version}高于当前支持版本`,'MIGRATION_VERSION');
  if(version===0) migrateLegacyWorkflows(db,permissionPreset);
  if(version<2) db.exec(`UPDATE runs SET body=json_set(body,'$.lane','investigation') WHERE ${investigationConsentSQL('body')};
    CREATE UNIQUE INDEX runs_workspace_lane_active_v2 ON runs(workspaceId,${runLaneSQL('body')}) WHERE status IN ${activeRunSQL};
    CREATE UNIQUE INDEX runs_work_active_v2 ON runs(workId) WHERE status IN ${activeRunSQL};
    DROP INDEX IF EXISTS runs_workspace_active_v1;
    PRAGMA user_version=2;`);
}

function migrateLegacyWorkflows(db,permissionPreset) {
  const load=table=>db.prepare(`SELECT body FROM ${table} ORDER BY seq`).all().map(r=>JSON.parse(r.body));
  const workflows=load('workflows'),works=load('works'),runs=load('runs');
  const workIndex=new Map(works.map(w=>[w.id,w])),workflowIndex=new Map(workflows.map(w=>[w.id,w])),runIndex=new Map(runs.map(r=>[r.id,r]));
  const workspaceIds=new Set(load('workspaces').map(w=>w.id));
  function reference(ok,owner,target) {requireValue(ok,`迁移引用错误：${owner} -> ${target}`,'MIGRATION_REFERENCE');}
  for(const wf of workflows) reference(workspaceIds.has(wf.workspaceId),`Workflow ${wf.id}`,`Workspace ${wf.workspaceId}`);
  for(const w of works) {
    reference(workspaceIds.has(w.workspaceId),`Work ${w.id}`,`Workspace ${w.workspaceId}`);
    if(w.workflowId!==null) reference(workflowIndex.get(w.workflowId)?.workspaceId===w.workspaceId,`Work ${w.id}`,`Workflow ${w.workflowId}`);
    for(const id of w.dependsOn) reference(workIndex.get(id)?.workspaceId===w.workspaceId,`Work ${w.id}`,`dependency ${id}`);
    if(w.result) reference(runIndex.get(w.result.runId)?.workId===w.id,`Work ${w.id}`,`result Run ${w.result.runId}`);
  }
  for(const run of runs) reference(workIndex.get(run.workId)?.workspaceId===run.workspaceId,`Run ${run.id}`,`Work ${run.workId}`);
  for(const control of load('controls')) {
    reference(workIndex.get(control.workId)?.workspaceId===control.workspaceId,`Control ${control.id}`,`Work ${control.workId}`);
    reference(runIndex.get(control.runId)?.workId===control.workId,`Control ${control.id}`,`Run ${control.runId}`);
  }
  const update=(table,value)=>db.prepare(`UPDATE ${table} SET status=?,body=? WHERE id=?`).run(value.status??null,JSON.stringify(value),value.id);
  const useForWorkflow=new Map();
  for(const wf of workflows) {
    if(['available','legacy'].includes(wf.status)) continue;
    const legacySource=structuredClone(wf),stageWorkIds={};
    reference(Array.isArray(wf.stages),`Workflow ${wf.id}`,'stages');
    for(const [index,id] of (wf.stageWorkIds??[]).entries()) {
      const work=workIndex.get(id);
      reference(work && work.workflowId===wf.id && work.workspaceId===wf.workspaceId,`Workflow ${wf.id}`,`stage Work ${id}`);
      reference(wf.stages[index] && (!work.stageId || work.stageId===wf.stages[index].id),`Workflow ${wf.id}`,`stage mapping ${id}`);
      stageWorkIds[wf.stages[index].id]=id;
    }
    let definition={title:wf.title,description:wf.description,knowledge:wf.knowledge,parameters:[],stages:wf.stages};
    if(wf.stages.length) {
      try {definition=definitionSchema(definition);}
      catch(error) {if(!error.code) throw error;throw Object.assign(new Error(`迁移Workflow ${wf.id}定义错误：${error.message}`,{cause:error}),{code:'MIGRATION_REFERENCE'});}
    }
    const associated=works.filter(w=>w.workflowId===wf.id),id=`legacy:${wf.id}`;
    const use={id,workspaceId:wf.workspaceId,workflowId:wf.id,workflowVersion:wf.version,version:1,status:'confirmed',
      definitionSnapshot:definition,parameters:{},execution:{model:associated[0]?.model??null,permissionPreset,autoAccept:wf.authorization?.autoAccept??false},
      confirmation:null,workIds:associated.map(w=>w.id),stageWorkIds,legacy:true,legacySource,
      createdAt:wf.createdAt,updatedAt:wf.updatedAt};
    db.prepare('INSERT INTO uses(id,workspaceId,workflowId,status,body) VALUES(?,?,?,?,?)').run(id,wf.workspaceId,wf.id,'confirmed',JSON.stringify(use));
    useForWorkflow.set(wf.id,use);
    Object.assign(wf,definition,{status:wf.stages.length?'available':'legacy',legacySource});
    delete wf.stageWorkIds;delete wf.authorization;delete wf.completedAt;update('workflows',wf);
  }
  for(const work of works) {
    const use=useForWorkflow.get(work.workflowId),history=runs.filter(r=>r.workId===work.id),last=history.at(-1);
    work.useId??=use?.id??null;work.inputs??={};work.outputs??=[];work.wait??=null;work.inputChanges??=[];
    if(!Object.hasOwn(work,'permissionPreset')) work.permissionPreset=last && Object.hasOwn(last,'permissionPreset')?last.permissionPreset:permissionPreset;
    if(!Object.hasOwn(work,'authorization')) work.authorization=use?.legacySource.authorization??null;
    if(use) work.definitionSnapshot={description:use.definitionSnapshot.description,knowledge:use.definitionSnapshot.knowledge};
    update('works',work);
  }
  for(const run of runs) {
    const work=workIndex.get(run.workId);run.reports??=[];run.inputs??={};run.consumedResults??=[];run.useId??=work.useId;run.operationId??=work.id;
    if(work.result?.runId===run.id) {
      run.resultVersion=work.result.version;
      if(Object.hasOwn(work.result,'outputs')) run.outputs=work.result.outputs;
    }
    update('runs',run);
  }
}
