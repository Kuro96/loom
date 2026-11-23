import { useEffect, useMemo, useRef, useState } from 'react';
import { createCommandMemo, parseChecks, resolvedModel, sessionLabel } from './state.mjs';
import { DefinitionEditor, cleanDefinition, definitionFields } from './definition.jsx';
import { DefinitionSummary, ExecutionSummary, CheckSummary, permissionLabel } from './workflow-summary.jsx';
import { WorkInputs, SummaryText } from './work-result.jsx';
import { reviewLabel, splitRequirements } from './reader-fields.mjs';
import { UseInputFields, InputError, parameterDrafts, parameterValues, stageInputValues } from './use-inputs.jsx';
import { ErrorNotice, Field, InlinePage, Modal, ModelPicker, WorkspacePicker } from './components.jsx';

function useSubmit(action) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const submitting = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try { await action(event.nativeEvent?.submitter?.value); }
    catch (reason) { setError(reason); }
    finally { submitting.current = false; setBusy(false); }
  }
  return { busy, error, submit };
}

function FormError({ error }) {
  return error instanceof InputError ? <p className="loom-warning" role="alert">{error.message}</p> : <ErrorNotice error={error} />;
}

function ChecksEditor({ checks, onChange }) {
  function update(index, patch) { onChange(checks.map((check, i) => i === index ? { ...check, ...patch } : check)); }
  return <section className="loom-check-list" aria-label="客观检查"><h3>检查 <small>可选</small></h3>
    {checks.map((check, index) => <div className="loom-check-row" key={index}>
      <header><strong>{check.kind === 'file' ? '文件检查' : '命令检查'} {index + 1}</strong><button type="button" aria-label={`删除检查 ${index + 1}`} onClick={() => onChange(checks.filter((_, i) => i !== index))}>删除</button></header>
      {check.kind === 'file' ? <div className="loom-inline-fields">
        <Field label="文件路径"><input aria-label={`文件路径 ${index + 1}`} required value={check.path} placeholder="例如 report.md" onChange={event => update(index, { path: event.target.value })} /></Field>
        <Field label="包含文本（可选）"><textarea aria-label={`包含文本 ${index + 1}`} rows={2} value={check.contains ?? ''} onChange={event => {
          const { contains, ...rest } = check;
          onChange(checks.map((item, i) => i === index ? event.target.value ? { ...rest, contains: event.target.value } : rest : item));
        }} /></Field>
      </div> : <>
        <Field label="执行命令"><input aria-label={`执行命令 ${index + 1}`} required value={check.command} placeholder="例如 node" onChange={event => update(index, { command: event.target.value })} /></Field>
        <div className="loom-arguments"><span>参数</span>{check.args.map((arg, argIndex) => <div className="loom-inline-fields" key={argIndex}>
          <Field label={`参数 ${argIndex + 1}`}><textarea aria-label={`参数 ${argIndex + 1}`} rows={2} spellCheck={false} value={arg} onChange={event => update(index, { args: check.args.map((value, i) => i === argIndex ? event.target.value : value) })} /></Field>
          <button type="button" aria-label={`删除参数 ${argIndex + 1}`} onClick={() => update(index, { args: check.args.filter((_, i) => i !== argIndex) })}>删除</button>
        </div>)}<button type="button" onClick={() => update(index, { args: [...check.args, ''] })}>添加参数</button></div>
      </>}
    </div>)}
    <div className="loom-actions"><button type="button" onClick={() => onChange([...checks, { kind: 'file', path: '' }])}>添加文件检查</button><button type="button" onClick={() => onChange([...checks, { kind: 'command', command: '', args: [] }])}>添加命令检查</button></div>
  </section>;
}

export function CreateWork({ workspaceId, workspaces, catalog, defaultModel, defaultPermission = null, api, execute, onClose, onCreated }) {
  const [commandFor] = useState(createCommandMemo);
  const [workspace, setWorkspace] = useState(workspaceId);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [scope, setScope] = useState('');
  const [execution, setExecution] = useState({ model: defaultModel, permissionPreset: defaultPermission, autoAccept: false });
  const [checks, setChecks] = useState([]), [sessionId, setSessionId] = useState('');
  const [loadSessions, setLoadSessions] = useState(false), [sessionAttempt, setSessionAttempt] = useState(0);
  const [sessions, setSessions] = useState(null), [sessionError, setSessionError] = useState(null);
  useEffect(() => {
    if (!loadSessions) return;
    let active = true;
    setSessions(null); setSessionError(null); setSessionId('');
    api.rpc('nativeSessions', {}).then(value => { if (active) setSessions(value); }, reason => { if (active) setSessionError(reason); });
    return () => { active = false; };
  }, [api, loadSessions, sessionAttempt]);
  const form = useSubmit(async () => {
    if (!workspace) throw new Error('请选择所属项目');
    const work = await execute(commandFor({ type: 'work.create', workspaceId: workspace, title: title.trim(), description, scope,
      ...(execution.model ? { model: execution.model } : {}), permissionPreset: execution.permissionPreset, checks: parseChecks(JSON.stringify(checks)), ...(sessionId ? { sessionId } : {}) }));
    onCreated(work); onClose();
  });
  return <InlinePage title="新建工作" onBack={onClose} busy={form.busy}><form onSubmit={form.submit}>
    <ErrorNotice error={form.error} />
    <Field label="所属项目 *"><WorkspacePicker workspaces={workspaces} value={workspace} onChange={value => { setWorkspace(value); setSessionId(''); }} /></Field>
    <Field label="工作标题 *"><input aria-label="工作标题" required value={title} onChange={event => setTitle(event.target.value)} placeholder="明确要交付的结果" /></Field>
    <Field label="说明与完成条件"><textarea aria-label="工作说明" rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="目标、输入、产物和验收标准" /></Field>
    <ExecutionEditor api={api} catalog={catalog} value={execution} onChange={setExecution} showAcceptance={false} />
    <details onToggle={event => { if (event.currentTarget.open) setLoadSessions(true); }}><summary>范围、检查与关联会话</summary><Field label="操作范围"><input aria-label="工作操作范围" value={scope} onChange={event => setScope(event.target.value)} /></Field>
    <Field label="关联已有会话（可选）" hint={loadSessions && !sessions && !sessionError ? '正在读取已有会话…' : undefined}><select aria-label="关联已有会话" value={sessionId} disabled={!sessions} onChange={event => setSessionId(event.target.value)}><option value="">新建独立会话</option>
      {sessions?.filter(session => session.workspaceId === workspace).map((session, index) => <option key={session.sessionId} value={session.sessionId}>{sessionLabel(session, index)}{session.running ? ' · 执行中' : ''}</option>)}
    </select></Field>
    <ErrorNotice error={sessionError} message="已有会话列表暂不可用。仍可创建独立工作。" onRetry={() => setSessionAttempt(attempt => attempt + 1)} /><ChecksEditor checks={checks} onChange={setChecks} /></details>
    <footer><button className="loom-primary" disabled={form.busy || !workspace || !title.trim()}>{form.busy ? '创建中…' : '创建工作'}</button></footer>
  </form></InlinePage>;
}

export function CreateWorkflow({ workspaceId, workspaces, execute, onClose, onCreated, onProposed, api, catalog, defaultModel, defaultPermission = null, workflow = null, proposal = null, initialDefinition = null, sourceWorks = [], manualDraft = false }) {
  const [commandFor] = useState(createCommandMemo);
  const [startFor] = useState(createCommandMemo);
  const [workspace, setWorkspace] = useState(proposal?.workspaceId ?? workflow?.workspaceId ?? workspaceId);
  const [localDefinition, setLocalDefinition] = useState(() => definitionFields(proposal?.definitionSnapshot ?? workflow ?? initialDefinition ?? { title: '', stages: [] }));
  const definition = manualDraft ? manualDraft.definition : localDefinition;
  const setDefinition = manualDraft ? manualDraft.onChange : setLocalDefinition;
  const [parameters, setParameters] = useState(() => parameterDrafts(definition, proposal?.parameters));
  const [execution, setExecution] = useState(proposal?.execution ?? { model: defaultModel, permissionPreset: defaultPermission, autoAccept: false });
  const form = useSubmit(async submittedMode => {
    const mode = manualDraft ? 'save' : submittedMode;
    if (!workspace) throw new Error('请选择所属项目');
    const parsed = cleanDefinition(definition);
    const clean = manualDraft ? manualDraft.finalize(parsed) : parsed;
    if (proposal) {
      const result = await execute(commandFor({ type: 'use.update', useId: proposal.id, expectedVersion: proposal.version, definition: clean, parameters: parameterValues(clean, parameters), ...execution }));
      onProposed(await api.readUse(result.id)); return;
    }
    if (workflow) {
      const flow = await execute(commandFor({ type: 'workflow.update', workflowId: workflow.id, expectedVersion: workflow.version, definition: clean }));
      onCreated(flow); onClose(); return;
    }
    const fields = ['once', 'save-run'].includes(mode) ? { parameters: parameterValues(clean, parameters), ...execution } : null;
    if (mode === 'once') {
      const result = await execute(startFor({ type: 'use.create', workspaceId: workspace, definition: clean, ...fields }));
      onProposed(await api.readUse(result.use.id)); return;
    }
    const flow = await execute(commandFor({ type: 'workflow.create', workspaceId: workspace, ...clean,
      ...(sourceWorks.length ? { sourceWorkIds: sourceWorks.map(work => work.id), sourceVersions: Object.fromEntries(sourceWorks.map(work => [work.id, work.version])) } : {}) }));
    if (mode === 'save-run') {
      const result = await execute(startFor({ type: 'workflow.start', workflowId: flow.id, expectedVersion: flow.version, ...fields }));
      onProposed(await api.readUse(result.use.id));
    } else { onCreated(flow); onClose(true); }
  });
  const disabled = form.busy || !workspace || !definition.title.trim() || !definition.stages.length;

  return <InlinePage title={manualDraft ? '从手册创建 · 编辑模板' : proposal ? '修改本次说明' : workflow ? '编辑工作流模板' : sourceWorks.length ? '保存为工作流' : '新建工作流'} onBack={() => onClose()} busy={form.busy}><form onSubmit={form.submit}>
    <FormError error={form.error} />
    <Field label="所属项目 *"><WorkspacePicker workspaces={workspaces} value={workspace} onChange={setWorkspace} disabled={Boolean(manualDraft || proposal || workflow || sourceWorks.length)} /></Field>
    {workflow && <p className="loom-hint">当前版本 {workflow.version} · 保存后用于后续使用</p>}
    {sourceWorks.length > 0 && <p className="loom-hint">来源：{sourceWorks.map(work => work.title).join('、')}</p>}
    <DefinitionEditor value={definition} onChange={setDefinition} ChecksEditor={ChecksEditor} guided={Boolean(manualDraft)} />
    {!workflow && onProposed && <>{definition.parameters.length > 0 && <UseInputFields definition={definition} values={parameters} onChange={setParameters} />}<ExecutionEditor api={api} catalog={catalog} value={execution} onChange={setExecution} /></>}
    <footer><button type="submit" value="save" disabled={disabled}>{manualDraft ? '保存模板' : proposal ? '保存本次说明' : workflow ? '保存新版本' : sourceWorks.length ? '保存工作流' : '创建工作流'}</button>
      {!proposal && !workflow && onProposed && <><button type="submit" value="once" disabled={disabled || !execution.model}>执行一次</button><button type="submit" value="save-run" className="loom-primary" disabled={disabled || !execution.model}>保存为工作流并执行</button></>}
    </footer>
  </form></InlinePage>;
}

function ExecutionEditor({ api, catalog, value, onChange, showAcceptance = true }) {
  const [permissions, setPermissions] = useState(null), [error, setError] = useState(null);
  useEffect(() => { let active = true; api.rpc('permissions', {}).then(result => { if (active) setPermissions(result); }, reason => { if (active) setError(reason); }); return () => { active = false; }; }, [api]);
  return <details open={!value.model || undefined}><summary>{showAcceptance ? '模型、权限与验收' : '模型与权限'}</summary><ErrorNotice error={error} />
    <ModelPicker catalog={catalog} value={value.model} onChange={model => onChange({ ...value, model })} />
    <Field label="执行权限"><select aria-label="本次执行权限" disabled={!permissions} value={value.permissionPreset ?? ''} onChange={event => onChange({ ...value, permissionPreset: event.target.value || null })}><option value="">沿用原生权限</option>
      {value.permissionPreset && !permissions?.defaultOptions.some(p => p.value === value.permissionPreset) && <option value={value.permissionPreset}>{permissionLabel(value.permissionPreset)}</option>}
      {permissions?.defaultOptions.map(p => <option key={p.value} value={p.value}>{permissionLabel(p.value)}</option>)}
    </select></Field>{showAcceptance && <label className="loom-checkbox"><input aria-label="自动验收" type="checkbox" checked={value.autoAccept} onChange={event => onChange({ ...value, autoAccept: event.target.checked })} />检查和预验收通过后自动验收</label>}
  </details>;
}
export function UseWorkflow({ workflow, proposal = null, fromDetail = false, api, catalog, defaultModel, defaultPermission = null, workspaces, execute, onProposed, onClose }) {
  const definition = proposal ? proposal.definitionSnapshot : definitionFields(workflow);
  const [parameters, setParameters] = useState(() => parameterDrafts(definition, proposal?.parameters));
  const [changes, setChanges] = useState({});
  const [execution, setExecution] = useState(() => proposal ? proposal.execution : { model: defaultModel, permissionPreset: defaultPermission, autoAccept: false });
  const [commandFor] = useState(createCommandMemo);
  const form = useSubmit(async () => {
    const stageInputs = stageInputValues(definition, changes);
    const fields = { parameters: parameterValues(definition, parameters), ...(stageInputs.length ? { stageInputs } : {}), ...execution };
    const command = proposal ? { type: 'use.update', useId: proposal.id, expectedVersion: proposal.version, ...fields } : { type: 'workflow.start', workflowId: workflow.id, expectedVersion: workflow.version, ...fields };
    const result = await execute(commandFor(command));
    const saved = await api.readUse(proposal ? result.id : result.use.id);
    for (const { stageId, name, value } of stageInputs) {
      const ref = saved.definitionSnapshot.stages.find(s => s.id === stageId)?.inputs[name];
      if (ref?.kind !== 'value' || JSON.stringify(ref.value) !== JSON.stringify(value)) throw new InputError('本次步骤输入未保存。请重新加载 Loom 服务后再试。');
    }
    onProposed(saved);
  });
  return <InlinePage title={proposal ? '修改本次输入' : '使用工作流'} onBack={onClose} busy={form.busy}><form onSubmit={form.submit}><FormError error={form.error} />
    <h3>{definition.title}</h3><p className="loom-hint">{workspaces.find(w => w.workspaceId === (proposal?.workspaceId ?? workflow.workspaceId))?.title ?? '项目名称暂不可用'} · {definition.stages.length} 项工作</p>
    <UseInputFields definition={definition} values={parameters} onChange={setParameters} changes={changes} onStageChange={setChanges} />
    <ExecutionEditor api={api} catalog={catalog} value={execution} onChange={setExecution} />
    <footer><button className="loom-primary" disabled={form.busy || !execution.model}>{fromDetail ? '保存本次输入' : proposal ? '保存并核对' : '下一步：核对工作'}</button></footer>
  </form></InlinePage>;
}
export function ProposalDialog({ proposal, api, catalog, workspaces, execute, onClose, onConfirmed, onEdit, onEditDefinition, onDetails }) {
  const [commandFor] = useState(createCommandMemo);
  const workspace = workspaces.find(w => w.workspaceId === proposal.workspaceId);
  const available = Boolean(workspace && resolvedModel(proposal.execution.model, catalog));
  const form = useSubmit(async () => {
    if (!available) throw new Error('执行目标暂不可用，请刷新后重试');
    const result = await execute(commandFor({ type: 'use.confirm', useId: proposal.id, expectedVersion: proposal.version }));
    const saved = await api.readUse(proposal.id);
    if (saved.status !== 'confirmed') throw new Error('确认后的工作状态尚未读回');
    onConfirmed({ ...result, use: saved }); onClose();
  });
  return <InlinePage title={reviewLabel()} onBack={onClose} busy={form.busy}><form onSubmit={form.submit}><ErrorNotice error={form.error} />
    <h3>{proposal.definitionSnapshot.title}</h3><p>项目：{workspace?.title ?? '项目名称暂不可用'} · 本次共 {proposal.definitionSnapshot.stages.length} 项工作</p>
    <SummaryText>{splitRequirements(proposal.definitionSnapshot.description).requirements}</SummaryText>
    <DefinitionSummary definition={proposal.definitionSnapshot} parameters={proposal.parameters} />
    <ExecutionSummary execution={proposal.execution} catalog={catalog} />
    {!available && <p role="status" className="loom-warning">{workspace ? '请在本次设置中选择可用的执行模型。' : '所属项目暂不可用，请刷新工作台。'}</p>}
    <footer>{onDetails && <button type="button" disabled={form.busy} onClick={() => onDetails(proposal)}>查看本次工作</button>}{onEdit && <button type="button" disabled={form.busy} onClick={() => onEdit(proposal)}>修改本次输入</button>}{onEditDefinition && <button type="button" disabled={form.busy} onClick={() => onEditDefinition(proposal)}>修改本次说明</button>}<button className="loom-primary" disabled={form.busy || !available}>{proposal.definitionSnapshot.stages.length === 1 ? '确认执行' : `确认执行本次 ${proposal.definitionSnapshot.stages.length} 项工作`}</button></footer>
  </form></InlinePage>;
}

export function ConsentDialog({ work, api, catalog, workspaces = [], onClose, onApproved }) {
  const [autoAccept, setAutoAccept] = useState(Boolean(work.authorization?.autoAccept));
  const [commandFor] = useState(createCommandMemo);
  const workspace = workspaces.find(item => item.workspaceId === work.workspaceId);
  const targetAvailable = Boolean(resolvedModel(work.model, catalog) && workspace?.title);
  const form = useSubmit(async () => {
    if (!targetAvailable) throw new Error('执行目标名称暂不可用，请刷新后重试。');
    await api.rpc('command', commandFor({ type: 'work.confirm', workId: work.id, expectedVersion: work.version, autoAccept }));
    const saved = await api.readWork(work.id);
    if (saved.modelConsent?.modelRevision !== work.modelRevision || saved.checksConsent?.checksRevision !== work.checksRevision) throw new Error('执行确认后的模型或检查已变化，请刷新后重新确认。');
    await onApproved(); onClose();
  });
  return <InlinePage title={reviewLabel()} onBack={onClose} busy={form.busy}><form onSubmit={form.submit}>
    <ErrorNotice error={form.error} /><h3>{work.title}</h3><p>项目：{workspace?.title || '项目名称暂不可用'}</p>
    {(Object.keys(work.inputs).length > 0 || work.description) && <WorkInputs inputs={work.inputs} description={work.description} />}
    {work.scope && <p>操作范围：{work.scope}</p>}<ExecutionSummary execution={work} catalog={catalog} showAcceptance={false} />
    {!targetAvailable && <p className="loom-warning">执行目标名称暂不可用，请刷新后重试。</p>}

    <CheckSummary checks={work.checks} />
    {work.gate?.required && !work.gate.released && <p>执行前需要人工放行。</p>}
    <label className="loom-checkbox"><input aria-label="自动验收" type="checkbox" checked={autoAccept} onChange={event => setAutoAccept(event.target.checked)} />检查和预验收通过后自动验收</label>
    <footer><button className="loom-primary" disabled={form.busy || !targetAvailable}>{form.busy ? '确认中…' : '确认执行'}</button></footer>
  </form></InlinePage>;
}

export function ConfirmAction({ title, children, confirmLabel, onConfirm, onClose, danger = false, neutral = false, api, targetKind, targetId, targets, blocked = false, settled = false, onOpenReference }) {
  const deletions = useMemo(() => targets ?? (targetId ? [{ kind: targetKind, id: targetId }] : []), [targets, targetId, targetKind]);
  const [check,setCheck]=useState(undefined), [readError,setReadError]=useState(null);
  useEffect(()=>{
    if(!deletions.length) return;
    let active=true;
    setReadError(null);setCheck(undefined);
    Promise.all(deletions.map(async ({kind,id,title}) => {
      const block = await api.rpc('checkDeletion',{kind,id});
      return block && {...block,title};
    })).then(values=>{if(active)setCheck(values.filter(Boolean));},error=>{if(active)setReadError(error);});
    return ()=>{active=false;};
  },[api,deletions]);
  const form = useSubmit(async () => { if(await onConfirm() !== false) onClose(); });
  const refused=targetId && ['INVALID_STATE','INVALID_DEPENDENCY'].includes(form.error?.code);
  const blocks=refused ? [{message:form.error.message,references:form.error.details?.references ?? []}] : check;
  const canConfirm=!blocked && !settled && (!deletions.length || blocks?.length === 0);
  return <Modal title={title} onClose={onClose} busy={form.busy}><form onSubmit={canConfirm ? form.submit : event=>event.preventDefault()}>{children}
    {deletions.length > 0 && check===undefined && !readError && <p role="status">正在核对删除范围…</p>}
    <ErrorNotice error={readError ?? (!refused && form.error)} />
    {blocks?.map((block,index) => <section key={index} className="loom-warning" role="alert"><p>{block.title && `「${block.title}」：`}{block.message}</p>{block.references.length>0 && <ul>{block.references.map(ref=><li key={`${ref.kind}:${ref.id}`}>{ref.kind==='intent' ? `关联请求：${ref.title}` : ref.title ? <button type="button" onClick={()=>onOpenReference(ref)}>{`查看${ref.kind==='work'?'工作':'工作流'}：${ref.title}`}</button> : '历史引用（原工作已不可用）'}</li>)}</ul>}</section>)}
    <footer><button type="button" disabled={form.busy} onClick={onClose}>返回</button>{canConfirm && <button className={danger ? 'loom-danger' : neutral ? undefined : 'loom-primary'} disabled={form.busy}>{form.busy ? '处理中…' : confirmLabel}</button>}</footer>
  </form></Modal>;
}
