import { useEffect, useRef, useState } from 'react';
import { Badge, ErrorNotice, MoreButton } from './components.jsx';
import { mergePage } from './state.mjs';
import { DefinitionSummary } from './workflow-summary.jsx';
import { SummaryText } from './work-result.jsx';
import { batchActionLabel, reviewLabel, splitRequirements } from './reader-fields.mjs';

export function useRecordPage(api, query, revision) {
  const [page, setPage] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(true);
  const loader = useRef(null), generation = useRef(0);
  const key = JSON.stringify(query);
  useEffect(() => {
    const request = ++generation.current, filters = JSON.parse(key);
    let current = null, running = false, refreshPending = false, morePending = false;
    setPage(null); setError(null); setBusy(true);
    loader.current = async more => {
      if (more) { morePending = true; setBusy(true); } else refreshPending = true;
      if (running) return;
      running = true;
      while (request === generation.current && (refreshPending || morePending)) {
        const adding = morePending;
        if (adding) morePending = false; else refreshPending = false;
        if (adding && !current?.nextCursor) continue;
        setBusy(adding || !current);
        const count = Math.max(25, current?.items.length ?? 0);
        try {
          let incoming = await api.rpc('query', { ...filters, limit: 25, ...(adding ? { after: current.nextCursor } : {}) });
          while (!adding && incoming.nextCursor !== null && incoming.items.length < count && request === generation.current) incoming = mergePage(incoming, await api.rpc('query', { ...filters, limit: 25, after: incoming.nextCursor }));
          if (request === generation.current) { current = adding ? mergePage(current, incoming) : incoming; setPage(current); setError(null); }
        } catch (reason) { if (request === generation.current) setError(reason); }
      }
      running = false;
      if (request === generation.current) setBusy(false);
    };
    return () => { generation.current++; };
  }, [api, key]);
  useEffect(() => { void loader.current(false); }, [api, key, revision]);
  return { page, error, busy, more: () => loader.current(true), refresh: () => loader.current(false) };
}
export function WorkflowDetail({ workflow, workspaces = [], busy, api, onUse, onEdit, onSelectUse }) {
  const history = useRecordPage(api, { kind: 'use', workflowId: workflow.id }, workflow);
  return <article className="loom-detail"><header className="loom-detail-header"><h2>{workflow.title}</h2><span className="loom-hint">版本 {workflow.version}</span></header>
    <p>{workspaces.find(item => item.workspaceId === workflow.workspaceId)?.title ?? '项目名称暂不可用'}</p>
    <SummaryText>{splitRequirements(workflow.description).requirements}</SummaryText>
    {workflow.status === 'legacy' ? <p className="loom-hint">历史来源 · 只读</p> : <div className="loom-actions"><button type="button" className="loom-primary" disabled={busy} onClick={() => onUse(workflow)}>使用工作流</button><button type="button" disabled={busy} onClick={() => onEdit(workflow)}>编辑模板</button></div>}
    <DefinitionSummary definition={workflow} />
    <ErrorNotice error={history.error} onRetry={history.refresh} />
    {history.page?.items.length > 0 && <details aria-label="工作流使用历史"><summary>使用历史</summary>
      <div className="loom-use-list">{history.page.items.map(item => <button type="button" className="loom-work-row" key={item.id} data-use-id={item.id} onClick={() => onSelectUse(item)}><strong>{new Date(item.createdAt).toLocaleString()}</strong><span>{item.status === 'proposed' ? '待确认' : item.status === 'cancelled' ? '已取消' : `已结束 ${item.progress.completed} / ${item.progress.total}`}</span></button>)}</div><MoreButton page={history.page} busy={history.busy} onMore={history.more} />
    </details>}
  </article>;
}

export function UseDetail({ proposal, workspaces, onSelectStage, onReview, onManage, ...props }) {
  const count = proposal.definitionSnapshot.stages.length;
  return <article className="loom-detail"><header className="loom-detail-header"><h2>{proposal.definitionSnapshot.title}</h2><span className="loom-hint">本次工作</span></header>
    <p className="loom-hint">{workspaces.find(w => w.workspaceId === proposal.workspaceId)?.title} · {new Date(proposal.createdAt).toLocaleString()}</p>
    {proposal.status !== 'confirmed' ? <>{proposal.definitionSnapshot.stages.map(stage => <button className="loom-work-row" type="button" key={stage.id} onClick={() => onSelectStage(stage)}><strong>{stage.title}</strong><Badge status={proposal.status} /></button>)}<div className="loom-actions">
      {proposal.status === 'proposed' && <><button type="button" className="loom-primary" disabled={props.busy} onClick={onReview}>{reviewLabel(count)}</button><button type="button" disabled={props.busy} onClick={() => onManage('cancelUse',proposal)}>{batchActionLabel('取消',count)}</button></>}
      <button type="button" className="loom-danger-text" disabled={props.busy} onClick={() => onManage('deleteUse',proposal)}>{batchActionLabel('删除',count)}</button></div></> : <ConfirmedWorks proposal={proposal} {...props} />}
  </article>;
}
function ConfirmedWorks({ proposal, api, busy, onAction, onSelectWork, onSave }) {
  const state = useRecordPage(api, { kind: 'work', useId: proposal.id }, proposal);
  const automatic = proposal.execution.autoAccept;
  return <><p className="loom-hint">已结束 {proposal.progress.completed} / {proposal.progress.total}</p><ErrorNotice error={state.error} onRetry={state.refresh} />{state.page ? <>
      {state.page.items.map(work => <button type="button" className="loom-work-row" key={work.id} onClick={() => onSelectWork(work)}><div><strong>{work.title}</strong></div><Badge status={work.status} /></button>)}
      <MoreButton page={state.page} busy={state.busy} onMore={state.more} />
      {onSave && state.page.total > 0 && state.page.items.length === state.page.total && state.page.items.every(work => work.status === 'accepted') && <button type="button" disabled={busy} onClick={() => onSave(proposal, state.page.items)}>保存为工作流</button>}
    </> : <p className="loom-hint">正在读取工作…</p>}
    {proposal.progress.total > proposal.progress.completed && <button type="button" disabled={busy} onClick={() => onAction({ type: 'use.authorize', useId: proposal.id, expectedVersion: proposal.version, autoAccept: !automatic })}>{automatic ? '改为逐项确认验收' : '允许本次工作自动验收'}</button>}
  </>;
}
