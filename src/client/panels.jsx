import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { applyDefaultModel, blockingReasons, createCommandMemo, saveSettings } from './state.mjs';
import { Badge, ErrorNotice, Field, InlinePage, Json, ModelPicker } from './components.jsx';
import { UsagePanel } from './usage-panel.jsx';
import { GateEvidence, pendingInteraction, retryEvidenceIssue, WorkInputs, WorkOutputs, WorkReport } from './work-result.jsx';

import { batchActionLabel, reviewLabel } from './reader-fields.mjs';

const liveStates = ['dispatching', 'running', 'pause_requested', 'cancel_requested'];

// Coalesce workbench polls during a slow read; invalidate on target change.
function useDetailRead(read, refresh) {
  const [state, setState] = useState(null), reload = useRef(null);
  useEffect(() => {
    let active = true, reading = false, again = false;
    reload.current = async () => {
      if (!read) return;
      if (reading) { again = true; return; }
      reading = true;
      do {
        again = false;
        try {
          const value = await read(() => active);
          if (active) setState({ read, value });
        } catch (error) { if (active) setState({ read, error }); }
      } while (active && again);
      reading = false;
    };
    return () => { active = false; };
  }, [read]);
  useEffect(() => { void reload.current(); }, [read, refresh]);
  return { ...(state?.read === read ? state : null), loading: Boolean(read && state?.read !== read), retry: () => reload.current() };
}

function useCurrentRun(api, work) {
  const { id } = work, resultId = work.result?.runId;
  const status = resultId ? null : work.status, version = resultId ? null : work.version;
  const live = liveStates.includes(status);
  const needed = live || Boolean(work.wait && !resultId) || Boolean(resultId && (work.result.review?.source === 'acceptance-error' || Object.values(work.inputs).some(ref => ref.kind === 'result')));
  const read = useCallback(async active => {
    // A result pins an immutable run. Otherwise read the last matching run,
    // following the store's oldest-first cursor chain rather than list order in the UI.
    const filters = ['running', 'pause_requested', 'cancel_requested'].includes(status) ? { status } : {};
    let after, run;
    do {
      const page = await api.rpc('query', { kind: 'run', workId: id, limit: 10, ...filters, ...(after ? { after } : {}) });
      run = resultId ? page.items.find(item => item.id === resultId) : page.items.at(-1);
      after = page.nextCursor;
    } while (active() && after && !(resultId && run));
    if (resultId && !run) throw new Error('未找到本次结果对应的执行记录。');
    if (!resultId && run && (run.workVersion > version || (live ? ![...liveStates, 'accepted'].includes(run.status) : !run.wait))) return null;
    return run;
  }, [api, id, resultId, status, version, live]);
  return useDetailRead(needed ? read : null, live ? work : null);
}


function StopStatus({ work, api }) {
  const { id, status } = work;
  const read = useCallback(async () => {
    // Requesting a stop supersedes prior pending controls on this work.
    const { items } = await api.rpc('query', { kind: 'control', workId: id, status: 'pending', limit: 1 });
    return items.find(item => item.kind === (status === 'pause_requested' ? 'pause' : 'cancel'));
  }, [api, id, status]);
  const receipt = useDetailRead(read, work), detail = receipt.value?.detail;
  const activity = Array.isArray(detail) ? detail : detail?.activity;
  return <><p role="status">{receipt.value?.attempts > 0 ? '停止尚未确认' : '正在停止执行…'}
    {typeof detail === 'string' && ` · ${detail}`}{Array.isArray(activity) && activity.length > 0 && ` · 仍有 ${activity.length} 项活动`}
    {detail?.verification && (detail.verification === 'stop_unconfirmed' ? ' · 检查进程停止尚未确认' : ' · 正在停止检查进程')}</p>
    <ErrorNotice error={receipt.error} onRetry={receipt.retry} /></>;
}

function DetailShell({ title, status, context, view, onView, actions, children }) {
  return <article className="loom-detail">
    <header className="loom-detail-header"><h2>{title}</h2><Badge status={status} /></header>
    {context && <p className="loom-hint">{context}</p>}
    <div className="loom-subtabs" role="group" aria-label="工作详情视图">{['输入', '输出', '报告'].map(name => <button type="button" key={name} aria-pressed={view === name} onClick={() => onView(name)}>{name}</button>)}</div>
    <div className="loom-actions">{actions}</div>
    {children}
  </article>;
}

export function ProposedWorkDetail({ proposal, stageId, ...actions }) {
  const definition = proposal.definitionSnapshot, stage = definition.stages.find(item => item.id === stageId);
  return <ProposedStage key={`${proposal.id}:${stageId}`} proposal={proposal} definition={definition} stage={stage} {...actions} />;
}
function ProposedStage({ proposal, definition, stage, busy, onEdit, onReview, onManage }) {
  const [view, setView] = useState('输入');
  const count = definition.stages.length;
  return <DetailShell title={stage.title} status={proposal.status} context={`${definition.title} · ${new Date(proposal.createdAt).toLocaleString()}`} view={view} onView={setView} actions={<>
    {proposal.status === 'proposed' && <><button type="button" disabled={busy} onClick={() => onEdit()}>修改本次输入</button>
    <button type="button" className="loom-primary" disabled={busy} onClick={() => onReview()}>{reviewLabel(count)}</button></>}
    {proposal.status === 'proposed' && onManage && <button type="button" disabled={busy} onClick={() => onManage('cancelUse',proposal)}>{batchActionLabel('取消',count)}</button>}
    {onManage && <button type="button" className="loom-danger-text" disabled={busy} onClick={() => onManage('deleteUse',proposal)}>{batchActionLabel('删除',count)}</button>}
  </>}>
    {view === '输入' ? <WorkInputs inputs={stage.inputs} description={stage.instructions} stage={stage} definition={definition} parameters={proposal.parameters} />
      : view === '输出' ? <WorkOutputs status={proposal.status} /> : <WorkReport status={proposal.status} />}
  </DetailShell>;
}

function FeedbackForm({ work, api, busy, onAction, onClose, steer }) {
  const [feedback, setFeedback] = useState(''), [impact, setImpact] = useState(null), [rerun, setRerun] = useState([]);
  const [error, setError] = useState(null), [sending, setSending] = useState(false);
  const blocked = impact?.works.some(item => liveStates.includes(item.status));
  async function submit() {
    setSending(true); setError(null);
    try {
      let command;
      if (steer) command = { type: 'work.steer', workId: work.id, expectedVersion: work.version, text: feedback };
      else {
        const preview = impact?.preview ?? await api.rpc('query', { kind: 'rework', workId: work.id });
        if (preview.version !== work.version) throw Object.assign(new Error('工作已更新，请重新查看返工影响。'), { code: 'CONFLICT' });
        if (!impact && preview.affected.length) {
          setImpact({ preview, works: await Promise.all(preview.affected.map(item => api.readWork(item.workId))) }); return;
        }
        command = { type: 'work.rework', workId: work.id, expectedVersion: preview.version, feedback, impactToken: preview.impactToken, rerunWorkIds: rerun };
      }
      if (await onAction(command) !== false) onClose();
      else { setImpact(null); setRerun([]); }
    } catch (reason) { setError(reason); }
    finally { setSending(false); }
  }
  return <section aria-label={steer ? '补充执行要求' : '返工反馈'}>
    <Field label={steer ? '补充要求' : '需要调整的内容'}><textarea autoFocus aria-label="反馈" rows={3} disabled={sending || Boolean(impact)} value={feedback} onChange={event => setFeedback(event.target.value)} /></Field>
    {impact && <section aria-label="受影响的工作"><h3>受影响的工作</h3><p className="loom-hint">勾选要重跑的工作，其余保留原结果。</p>
      {impact.works.map(item => <label className="loom-checkbox" key={item.id}><input type="checkbox" disabled={sending} aria-label={`重跑工作 ${item.title}`} checked={rerun.includes(item.id)} onChange={event => setRerun(event.target.checked ? [...rerun, item.id] : rerun.filter(id => id !== item.id))} /><span>{item.title} · <Badge status={item.status} /></span></label>)}
      {blocked && <p className="loom-warning">请先停止受影响的活动工作，再重新核对影响。</p>}
    </section>}
    <ErrorNotice error={error} />
    <div className="loom-actions"><button type="button" disabled={busy || sending || blocked || !feedback.trim()} onClick={submit}>{steer ? '发送干预' : impact ? '确认返工' : '提交返工'}</button>
      <button type="button" disabled={sending} onClick={onClose}>返回</button></div>
  </section>;
}

function ModelChoice({ work, catalog, busy, onAction }) {
  const [model, setModel] = useState(work.model);
  return <section><ModelPicker catalog={catalog} value={model} onChange={setModel} disabled={busy} /><button type="button" disabled={busy || !model || JSON.stringify(model) === JSON.stringify(work.model)} onClick={() => onAction({ type: 'work.setModel', workId: work.id, expectedVersion: work.version, model })}>保存模型提案</button></section>;
}

export function WorkDetail({ work, works, workspaces = [], workflows = [], source = null, onSave, catalog, busy, onAction, onConsent, onAccept, onCancel, onDelete, onOpenSession, onOpenFile, onOpenReport, initialView, onViewChange, api }) {
  const { status } = work;
  const [selectedView, setView] = useState(initialView ?? null), [form, setForm] = useState(null);
  const [commandFor] = useState(createCommandMemo);
  const view = selectedView ?? (status === 'accepted' && work.result?.deliverables?.length ? '输出' : work.result || work.wait || status === 'cancelled' ? '报告' : '输入');
  useEffect(() => { onViewChange?.(view); }, [onViewChange, view]);
  const beforeRun = ['awaiting_model', 'queued', 'paused'].includes(status);
  const pendingConsent = beforeRun && (work.modelConsent?.modelRevision !== work.modelRevision || work.checks.some(check => check.kind === 'command') && work.checksConsent?.checksRevision !== work.checksRevision);
  const canSteer = ['dispatching', 'running'].includes(status);
  const canRework = ['review', 'failed'].includes(status) || work.inputChanges.length > 0 && ['accepted', 'paused', 'cancelled'].includes(status);
  const missingOutput = status === 'review' && work.outputs.some(item => item.required && !Object.hasOwn(work.result.outputs ?? {}, item.name));
  const openForm = kind => setForm({ kind, version: work.version });
  const activeForm = form?.version === work.version ? form.kind : null;
  const feedbackOpen = activeForm === 'steer' && canSteer || activeForm === 'rework' && canRework;
  const command = type => onAction({ type, workId: work.id, expectedVersion: work.version });
  const blockers = beforeRun ? blockingReasons(work, works) : [];
  const workflow = work.useId ? source?.definitionSnapshot : workflows.find(item => item.id === work.workflowId);
  const stage = workflow?.stages.find(item => item.id === work.stageId);
  const context = [workspaces.find(item => item.workspaceId === work.workspaceId)?.title, workflow?.title, source && new Date(source.createdAt).toLocaleString()].filter(Boolean).join(' · ');
  const current = useCurrentRun(api, work);
  const interaction = canSteer && pendingInteraction(current.value);
  const gatePending = status === 'queued' && work.gate?.required && !work.gate.released;
  const retryPending = status === 'review' && work.result.review?.source === 'acceptance-error';
  const retryIssue = retryPending && !missingOutput && current.value ? retryEvidenceIssue(current.value) : null;
  const retry = retryPending && !missingOutput && current.value && !retryIssue && <button type="button" disabled={busy} onClick={() => onAction(commandFor({ type: 'work.retryAcceptance', workId: work.id, runId: work.result.runId, expectedVersion: work.version }))}>重新预验收</button>;
  return <DetailShell title={work.title} status={status} context={context} view={view} onView={setView} actions={<>
    {pendingConsent && work.model && <button className="loom-primary" type="button" disabled={busy} onClick={() => onConsent(work)}>{reviewLabel()}</button>}
    {pendingConsent && work.model && activeForm !== 'model' && <button type="button" disabled={busy} onClick={() => openForm('model')}>调整执行模型</button>}
    {view === '输入' && retry}
    {status === 'review' && !missingOutput && <button className="loom-primary" type="button" disabled={busy} onClick={() => onAccept(work)}>验收结果</button>}
    {canRework && !feedbackOpen && <button type="button" disabled={busy} onClick={() => openForm('rework')}>发起返工</button>}
    {canSteer && !feedbackOpen && <button type="button" disabled={busy} onClick={() => openForm('steer')}>补充执行要求</button>}
    {work.sessionId && <button type="button" className={interaction ? 'loom-primary' : undefined} onClick={() => onOpenSession(work.sessionId, view)}>查看对话</button>}
    {['queued', 'dispatching', 'running', 'waiting'].includes(status) && <button type="button" disabled={busy} onClick={() => command('work.pause')}>暂停工作</button>}
    {status === 'paused' && !pendingConsent && <button type="button" disabled={busy} onClick={() => command('work.resume')}>继续工作</button>}
    {onCancel && !['accepted', 'cancelled', 'cancel_requested'].includes(status) && <button type="button" disabled={busy} onClick={() => onCancel(work)}>取消工作</button>}
    {status === 'accepted' && onSave && <button type="button" disabled={busy} onClick={() => onSave(work)}>保存为工作流</button>}
    {onDelete && !liveStates.includes(status) && <button type="button" className="loom-danger-text" disabled={busy} onClick={() => onDelete(work)}>删除工作</button>}
  </>}>
    {pendingConsent && (!work.model || activeForm === 'model') && <ModelChoice key={work.modelRevision} work={work} catalog={catalog} busy={busy} onAction={onAction} />}
    {feedbackOpen && <FeedbackForm work={work} api={api} busy={busy} onAction={onAction} onClose={() => setForm(null)} steer={canSteer} />}
    {gatePending && <GateEvidence work={work} works={works} busy={busy} onRelease={() => command('work.releaseGate')} onOpenFile={onOpenFile} onOpenReport={onOpenReport} />}
    {!gatePending && blockers.length > 0 && <ul className="loom-blockers">{blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {missingOutput && <p className="loom-warning">缺少验收所需的结果，请发起返工。</p>}
    {retryIssue && <p className="loom-warning">{retryIssue}</p>}
    {retryPending && !missingOutput && current.loading && <p className="loom-hint">正在读取本次预验收证据…</p>}
    {['pause_requested', 'cancel_requested'].includes(status) && <StopStatus work={work} api={api} />}
    {interaction && <p className="loom-warning" role="status">{interaction}</p>}
    {work.wait && !work.result && view !== '报告' && <p className="loom-warning">{status === 'cancelled' ? '本地跟踪已结束，远端状态待核实' : work.wait.reason || work.wait.condition} · <button type="button" onClick={() => setView('报告')}>查看远端操作</button></p>}
    {work.inputChanges.length > 0 && <p className="loom-warning">上游结果已变更 · {work.inputChanges.map(change => `${works.find(item => item.id === change.workId)?.title ?? '来源工作'}（原结果版本 ${change.resultVersion}）`).join('、')}</p>}
    <ErrorNotice error={current.error} onRetry={current.retry} />
    {view === '输入' ? <WorkInputs {...work} works={works} current={current} stage={stage} definition={workflow} />
      : view === '输出' ? <WorkOutputs status={status} result={work.result} retry={retry} onOpen={onOpenFile && (file => onOpenFile(work, file))} />
      : <WorkReport {...work} run={current.value} retry={retry} onOpen={onOpenReport && (doc => onOpenReport(work, doc))} />}
  </DetailShell>;
}

export { WorkflowDetail } from './workflow-panels.jsx';

const roleNames = { bus: '协调', review: '上下文回顾', worker: '工作执行', acceptance: '结果预验收' };
const permissionNames = { 'danger-full-access': '完全权限', 'workspace-write': '项目读写', 'read-only': '只读' };
function revealSettingsDisclosure(details) {
  const body = details.closest('.loom-page-body');
  const { top, bottom } = body.getBoundingClientRect();
  const headingTop = details.firstElementChild.getBoundingClientRect().top;
  const firstControlBottom = details.querySelector('select, input').getBoundingClientRect().bottom;
  // Reserve room for the focus ring; in a very short page, favor the summary.
  const before = headingTop - (top + 6);
  const after = firstControlBottom - (bottom - 6);
  const delta = before < 0 ? before : Math.min(before, Math.max(0, after));
  if (delta) body.scrollTop += delta;
}

function scrollOnSettingsToggle(details) {
  if (!details) return;
  // Bind the native toggle so nested diagnostic disclosures keep their position.
  function toggle() { if (details.open) revealSettingsDisclosure(details); }
  details.addEventListener('toggle', toggle);
  return () => details.removeEventListener('toggle', toggle);
}

export function SettingsPanel({ settings, catalog, catalogError, reloadModels, execute, api, status, onTick, onClose }) {
  const formId = useId();
  const [current, setCurrent] = useState(settings), [models, setModels] = useState(settings.roleModels);
  const [preset, setPreset] = useState(settings.permissionPreset), [debug, setDebug] = useState(Boolean(settings.context.debug));
  const [permissions, setPermissions] = useState(null), [permissionError, setPermissionError] = useState(null), [reload, setReload] = useState(0);
  const [diagnostics, setDiagnostics] = useState(false);
  const [error, setError] = useState(null), [saved, setSaved] = useState(''), [busy, setBusy] = useState(false);
  function readback(value) { setCurrent(value); setModels(value.roleModels); setPreset(value.permissionPreset); setDebug(Boolean(value.context.debug)); }
  const dirty = JSON.stringify(models) !== JSON.stringify(current.roleModels) || preset !== current.permissionPreset || debug !== Boolean(current.context.debug);
  useEffect(() => {
    if (!dirty && !busy && settings.version > current.version) readback(settings);
  }, [settings.version, dirty, busy, current.version]);
  useEffect(() => {
    let active = true;
    setPermissions(null); setPermissionError(null);
    api.rpc('permissions').then(value => { if (active) setPermissions(value); }, reason => { if (active) setPermissionError(reason); });
    return () => { active = false; };
  }, [api, reload]);
  const option = permissions?.defaultOptions.find(item => item.value === preset);
  const changedModels = Object.fromEntries(Object.entries(models).filter(([role, value]) => JSON.stringify(value) !== JSON.stringify(current.roleModels[role])));
  const invalidPermission = preset !== current.permissionPreset && preset !== null && !option;
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(null); setSaved('');
    const payload = { roleModels: changedModels,
      ...(preset !== current.permissionPreset ? { permissionPreset: preset } : {}),
      ...(debug !== Boolean(current.context.debug) ? { context: { debug } } : {}) };
    try { await saveSettings(execute, api, payload, current.version, readback); setSaved('设置已保存。'); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  const overrides = Object.entries(roleNames).filter(([role]) => role !== 'bus' && models[role] && JSON.stringify(models[role]) !== JSON.stringify(models.bus));
  const footer = <footer className="loom-settings-save"><button className="loom-primary" type="submit" form={formId} disabled={busy || invalidPermission}>{busy ? '保存中…' : '保存设置'}</button></footer>;
  return <InlinePage title="设置" onBack={onClose} busy={busy} footer={footer}><form id={formId} className="loom-settings" aria-label="Loom 设置" onSubmit={save}>
    <ErrorNotice error={error} /><ErrorNotice error={catalogError} onRetry={reloadModels} />
    {saved && <p className="loom-success" role="status">{saved}</p>}
    <section className="loom-settings-section">
      <ModelPicker label="默认模型" value={models.bus} catalog={catalog} disabled={busy} onChange={value => { setModels(previous => applyDefaultModel(previous, value, catalog)); setSaved(''); }} />
      <details className="loom-advanced" aria-label="分角色模型" ref={scrollOnSettingsToggle}><summary>分角色模型{overrides.length > 0 ? ` · 已单独配置：${overrides.map(([, name]) => name).join('、')}` : ''}</summary>
        {Object.entries(roleNames).map(([role, title]) => <div className="loom-setting-row" key={role}><ModelPicker label={title} disabled={busy} value={models[role]} catalog={catalog} onChange={value => { setModels(previous => ({ ...previous, [role]: value })); setSaved(''); }} emptyLabel={role === 'worker' || role === 'bus' ? '沿用原生默认模型' : '沿用协调模型'} /></div>)}
      </details>
    </section>
    <section className="loom-settings-section">
      <ErrorNotice error={permissionError} onRetry={() => setReload(value => value + 1)} />
      <Field label="执行权限"><select aria-label="执行权限" disabled={busy || !permissions} value={preset ?? ''} onChange={event => { setPreset(event.target.value || null); setSaved(''); }}>
        <option value="">沿用原生权限</option>
        {preset !== null && !option && <option value={preset}>{permissionNames[preset] ?? '已保存的权限'}{permissions ? '（当前不可用）' : ''}</option>}
        {permissions?.defaultOptions.map(item => <option key={item.value} value={item.value}>{permissionNames[item.value] ?? item.name}</option>)}
      </select></Field>
      {!permissions && !permissionError && <p className="loom-setting-hint" role="status">正在加载权限选项…</p>}
      {preset === 'danger-full-access' && <p className="loom-setting-hint">允许完整文件访问和命令执行。</p>}
    </section>
    <details className="loom-advanced" ref={scrollOnSettingsToggle} onToggle={event => setDiagnostics(event.currentTarget.open)}><summary>高级与诊断{debug ? ' · 调试记录已开启' : ''}</summary>
      <label className="loom-setting-row"><span className="loom-setting-label">调试记录</span><input className="loom-setting-control" aria-label="调试记录" type="checkbox" checked={debug} disabled={busy} onChange={event => { setDebug(event.target.checked); setSaved(''); }} /></label>
      <p className="loom-setting-hint">日志可能包含对话、文件内容及工具结果；分享前请检查敏感信息。</p>
      <button type="button" disabled={busy} onClick={reloadModels}>刷新模型列表</button>
      {catalog?.failures?.length > 0 && <details><summary>模型连接详情</summary><Json value={catalog.failures} /></details>}
      {diagnostics && <DebugPanel api={api} status={status} settings={current} onTick={onTick} busy={busy} />}
    </details>
  </form></InlinePage>;
}

export function DebugPanel({ api, status, settings, onTick, busy }) {
  return <div className="loom-diagnostics">
    <UsagePanel api={api} />
    {status && <RuntimeDiagnostics status={status} settings={settings} onTick={onTick} busy={busy} />}
  </div>;
}
function RuntimeDiagnostics({ status, settings, onTick, busy }) {
  const context = status.context;
  const engine = status.engine;
  const state = { idle: '就绪', running: '处理中', unloaded: '尚未连接', pending: '等待中' }[context.status] ?? '状态待确认';
  return <>
    <section className="loom-settings-section"><h3>运行状态</h3>
      <p>协调会话：{state}</p>
      <p>调度器：{engine.faulted ? '需要处理' : engine.running ? '调度中' : engine.ready ? '就绪' : '尚未就绪'}</p>
      {engine.error && <ErrorNotice error={engine.error} />}
      {context.maintenanceError && <ErrorNotice error={context.maintenanceError} />}
      <button type="button" disabled={busy} onClick={onTick}>立即调度一次</button>

    </section>
    <section className="loom-settings-section"><h3>调试记录{settings.context.debug ? '已开启' : '已关闭'}</h3>
      <p className="loom-setting-hint">分享日志前请检查敏感信息。</p>
    </section>
    <details className="loom-advanced"><summary>技术详情</summary>
      <section><h3>协调会话与调度器</h3><Json value={{ bus: status.bus, engine }} /></section>
      <section><h3>日志位置</h3><Json value={{ directory: status.directory, debugDirectory: context.debugDirectory ?? 'context/debug（相对数据目录）' }} /></section>
      <section><h3>上下文与用量</h3><Json value={context} /></section>
      <section><h3>已保存配置</h3><Json value={settings.context} /></section>
    </details>
  </>;
}
