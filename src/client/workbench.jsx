import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { needsBusConnection } from './state.mjs';
import { BoundConversation, ConversationBoundary, Empty, ErrorNotice } from './components.jsx';
import { ConfirmAction, ConsentDialog, CreateWork, CreateWorkflow, UseWorkflow, ProposalDialog } from './forms.jsx';
import { ProposedWorkDetail, SettingsPanel, WorkDetail, WorkflowDetail } from './panels.jsx';

import { UseDetail } from './workflow-panels.jsx';
import { readWorkList, UNCLASSIFIED } from './work-list.mjs';
import { definitionFromWorks } from './definition.jsx';
import { batchActionLabel } from './reader-fields.mjs';
import { ProjectNavigation, groupWorkflows } from './project-navigation.jsx';
import { WorkRow, PendingRequests, PendingRequestPage } from './work-decisions.jsx';
import { ManageConfirmation, ManagedWorkRow, managementTarget } from './work-management.jsx';

const PAGE_SIZE = 25, LIVE_REFRESH_MS = 3000, DIRECTORY_REFRESH_MS = 15000;
const confirmations = new Set(['accept', 'cancel', 'deleteWork', 'cancelUse', 'deleteUse', 'manage']);
const workCategories = [['interaction', '待处理'], ['pending', '进行中'], ['completed', '已结束']];
const allCategories = workCategories.map(([value]) => value);

function newest(previous, next) {
  return previous && next && previous.id === next.id && previous.version > next.version ? previous : next;
}

function ListViewport({ ready, positions, tab, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (ready && ref.current) ref.current.scrollTop = positions.current[tab]; }, [ready, positions, tab]);
  return <div ref={ref} className="loom-list-scroll" onScroll={event => {
    if (ready) positions.current[tab] = event.currentTarget.scrollTop;
  }}>{children}</div>;
}

async function readCatalog(api, first, workspaceId) {
  const items = [...first.items];
  for (let cursor = first.nextCursor; cursor != null;) {
    const page = await api.rpc('query', { kind: 'workflow', ...(workspaceId ? { workspaceId } : {}), limit: 100, after: cursor });
    items.push(...page.items); cursor = page.nextCursor;
  }
  return items;
}

export function LoomPanel(props) {
  const { api, retain, openMain, WorkspaceReader, readFile, previewNavigation, SessionProvider, renderSlot } = props;
  const [resume]=useState(()=>previewNavigation?.current);
  useEffect(()=>{ if(previewNavigation) previewNavigation.current=null; },[previewNavigation]);
  const [snapshot, setSnapshot] = useState(null), [workPage, setWorkPage] = useState(null), [status, setStatus] = useState(null);
  const [workspaceId, setWorkspace] = useState(resume?.workspaceId ?? ''), [statusFilter, setStatusFilter] = useState(resume?.statusFilter ?? allCategories), [workflowFilter, setWorkflowFilter] = useState(resume?.workflowFilter ?? '');
  const [workDepth, setWorkDepth] = useState(resume?.workDepth ?? 1);
  const [managing, setManaging] = useState(false), [checked, setChecked] = useState(() => new Set());
  const positions = useRef({ work: 0, workflow: 0, ...resume?.positions });

  const [tab, setTab] = useState(resume?.tab ?? 'work'), [selectedId, setSelectedId] = useState(resume?.workId ?? null), [selectedFlowId, setSelectedFlowId] = useState(resume?.flowId ?? null);
  const [attentionWorkId,setAttentionWorkId] = useState(resume?.attentionWorkId ?? null);
  const [focusedWork, setFocusedWork] = useState(null), [focusedFlow, setFocusedFlow] = useState(null);
  const [selectedUseId, setSelectedUseId] = useState(resume?.parentId ?? null), [focusedUse, setFocusedUse] = useState(null), [workSource, setWorkSource] = useState(null);
  const [selectedStageId, setSelectedStageId] = useState(resume?.stageId ?? null);
  const [stageFromUse, setStageFromUse] = useState(resume?.stageFromUse ?? false);
  const [useOriginFlow, setUseOriginFlow] = useState(resume?.useOriginFlow ?? null);
  const [trail,setTrail]=useState(resume?.trail ?? []), [restoredView,setRestoredView]=useState(null);
  const [dependencies, setDependencies] = useState({ workId: null, items: [] });

  const detailView=useRef(resume?.view), rememberView=useCallback(view=>{ detailView.current=view; },[]);
  const refreshSerial = useRef(0), currentRefresh = useRef(null), mounted = useRef(true);
  const [catalog, setCatalog] = useState(null), [catalogError, setCatalogError] = useState(null);

  const [liveError, setConnectionError] = useState(null), [directoryError, setDirectoryError] = useState(null), [actionError, setActionError] = useState(null), [notice, setNotice] = useState('');
  const connectionError = liveError ?? (directoryError?.workspaceId === workspaceId ? directoryError.reason : null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [syncedAt, setSyncedAt] = useState(null);
  const [surface, setSurface] = useState(null), [railPreference, setRailPreference] = useState(resume?.railOpen ?? (resume ? true : null)), [mobilePane, setMobilePane] = useState(resume?.mobilePane ?? (resume ? 'work' : 'chat'));
  const showingPage = Boolean(surface && !confirmations.has(surface.kind));
  const viewScope = useMemo(() => ({ workspaceId, tab, selectedId, selectedFlowId, selectedUseId, selectedStageId, statusFilter, workflowFilter, workDepth, mobilePane, managing }),
    [workspaceId, tab, selectedId, selectedFlowId, selectedUseId, selectedStageId, statusFilter, workflowFilter, workDepth, mobilePane, managing]);
  const currentView = useRef(null), currentSurface = useRef(null), action = useRef(null);
  useLayoutEffect(() => {
    currentView.current = viewScope;
    action.current = null; setBusy(false); setActionError(null); setNotice('');
    return () => { currentView.current = null; };
  }, [viewScope]);
  useLayoutEffect(() => { currentSurface.current = surface; }, [surface]);
  const viewIsCurrent = () => currentView.current === viewScope;
  const inSurface = handler => (...args) => {
    if (viewIsCurrent() && currentSurface.current === surface) return handler(...args);
  };
  const returnFocus = useRef(null), settingsButton = useRef(null);
  function openPage(content) {
    if (!showingPage && document.activeElement !== document.body) returnFocus.current = document.activeElement;
    setSurface(content);
  }
  const closeSurface = () => setSurface(null);
  useLayoutEffect(() => {
    if (showingPage || !returnFocus.current) return;
    const origin = returnFocus.current;
    returnFocus.current = null;
    const target = origin instanceof HTMLElement && origin.getClientRects().length && !origin.matches(':disabled') ? origin : settingsButton.current;
    target.focus({ preventScroll: true });
  }, [showingPage]);
  function origin(view=detailView.current) {
    return {tab,workId:selectedId,view,workspaceId,statusFilter,workflowFilter,workDepth,positions:{...positions.current},parentId:selectedUseId,stageId:selectedStageId,stageFromUse,flowId:selectedFlowId,useOriginFlow,railOpen,mobilePane,attentionWorkId};
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSerial.current++; }; }, []);

  const reloadModels = useCallback(async () => {
    try { const value = await api.rpc('models', {}); if (mounted.current) { setCatalog(value); setCatalogError(null); } }
    catch (reason) { if (mounted.current) setCatalogError(reason); }
  }, [api]);
  useEffect(() => { void reloadModels(); }, [reloadModels]);

  const directoryTask = useRef(null);
  const readDirectory = useCallback(function load() {
    const scope = directoryTask.current;
    if (scope?.load !== load) return;
    if (scope.pending) return scope.pending;
    const current = () => directoryTask.current === scope;
    scope.pending = (async () => {
      try {
        const first = await api.rpc('snapshot', { categories: [], ...(workspaceId ? { workspaceId } : {}) });
        if (!current()) return;
        const workflows = await readCatalog(api, first.workflows, workspaceId);
        if (!current()) return;
        setSnapshot({ ...first, workflows, workspaceId }); setDirectoryError(null);
      } catch (reason) { if (current()) setDirectoryError({ workspaceId, reason }); }
      finally { scope.pending = null; }
    })();
    return scope.pending;
  }, [api, workspaceId]);
  useLayoutEffect(() => {
    directoryTask.current = { load: readDirectory, pending: null };
    setDirectoryError(null);
    return () => { directoryTask.current = null; };
  }, [readDirectory]);
  useEffect(() => {
    void readDirectory();
    const interval = setInterval(readDirectory, DIRECTORY_REFRESH_MS);
    return () => clearInterval(interval);
  }, [readDirectory]);

  const refresh = useCallback(async function refreshScope(foreground = false) {
    if (currentRefresh.current !== refreshScope) return;
    const serial = ++refreshSerial.current;
    const isCurrent = () => mounted.current && currentRefresh.current === refreshScope && serial === refreshSerial.current;
    if (foreground) { setLoading(true); setConnectionError(null); }
    try {
      const [list, selectedWork, use, flow] = await Promise.all([
        readWorkList(api, { workspaceId, workflowId: workflowFilter, categories: statusFilter, depth: workDepth, pageSize: PAGE_SIZE }),
        selectedId ? api.readWork(selectedId) : null,
        selectedUseId ? api.readUse(selectedUseId) : null,
        selectedFlowId ? api.readWorkflow(selectedFlowId) : null,
        api.rpc('status', {}).then(health => { if (isCurrent()) setStatus(health); }),
      ]);
      if (!isCurrent()) return;
      const mappedId = selectedStageId && use?.stageWorkIds[selectedStageId];
      const work = mappedId ? await api.readWork(mappedId) : selectedWork;
      if (!isCurrent()) return;
      const [dependencyItems, source] = await Promise.all([
        work ? Promise.all(work.dependsOn.map(id => api.readWork(id))) : [],
        work?.useId && work.useId !== selectedUseId ? api.readUse(work.useId) : null,
      ]);
      if (!isCurrent()) return;
      setWorkPage({ list, workspaceId, workflowFilter, statusFilter });
      setFocusedWork(previous => newest(previous, work)); setFocusedFlow(previous => newest(previous, flow));
      setDependencies({ workId: work?.id ?? null, items: dependencyItems });
      setFocusedUse(previous => newest(previous, use)); setWorkSource(previous => newest(previous, work?.useId && work.useId === selectedUseId ? use : source));
      setSyncedAt(new Date()); setConnectionError(null);
      if (selectedStageId && use && !use.definitionSnapshot.stages.some(s => s.id === selectedStageId)) setSelectedStageId(null);
    } catch (reason) {
      if (isCurrent()) setConnectionError(reason);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [api, workspaceId, statusFilter, workflowFilter, workDepth, selectedId, selectedFlowId, selectedUseId, selectedStageId]);

  useLayoutEffect(() => {
    currentRefresh.current = refresh;
    return () => { currentRefresh.current = null; };
  }, [refresh]);

  useEffect(() => {
    let inFlight = false;
    async function poll(foreground = false) {
      if (inFlight) return;
      inFlight = true;
      try { await refresh(foreground); }
      finally { inFlight = false; }
    }
    void poll(true);
    const interval = setInterval(poll, LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const retry = () => Promise.all([refresh(true), readDirectory()]);
  async function execute(command) {
    const ownsReceipt = () => viewIsCurrent() && currentSurface.current === surface;
    const result = await api.rpc('command', command);
    if (!ownsReceipt()) return result;
    if (command.type === 'work.delete' || command.type === 'use.delete') {
      if(relatedParent){returnFromReference();setNotice('已删除。');return result;}
      // Deletion has no detail to read back. Changing selection refreshes the originating list.
      refreshSerial.current++; setSelectedId(null); setSelectedUseId(null); setSelectedStageId(null);
      setFocusedWork(null); setFocusedUse(null); setWorkSource(null); setStageFromUse(false);
      if (useOriginFlow) { setSelectedFlowId(useOriginFlow); setTab('workflow'); }
      setUseOriginFlow(null); setNotice('已删除。'); return result;
    }
    const readback = async (id, target, read, apply) => {
      if (!target || id !== target.id) return;
      const confirmed = await read(id);
      if (ownsReceipt() && confirmed?.id === id) apply(previous => previous?.id === id ? newest(previous, confirmed) : previous);
    };
    try {
      if (command.type.startsWith('work.')) await readback(command.workId, focusedWork, api.readWork, setFocusedWork);
      else if (command.type.startsWith('workflow.') && command.type !== 'workflow.start') await readback(command.workflowId, focusedFlow, api.readWorkflow, setFocusedFlow);
      else if (command.type.startsWith('use.')) await readback(command.useId, focusedUse, api.readUse, setFocusedUse);
    } catch (reason) {
      if (ownsReceipt()) throw reason;
    }
    if (ownsReceipt()) await Promise.all([refresh(), /^(workflow|settings|workspace)\./.test(command.type) && readDirectory()]);
    return result;
  }
  async function run(task, label = '已完成。') {
    if (action.current !== null) return false;
    const token = action.current = {};
    const current = () => viewIsCurrent() && action.current === token;
    const showReceipt = () => current() && currentSurface.current === surface;
    setBusy(true); setActionError(null); setNotice('');
    try { if (await task() === false || !showReceipt()) return false; setNotice(label); return true; }
    catch (reason) { if (showReceipt()) setActionError(reason); return false; }
    finally { if (current()) { action.current = null; setBusy(false); } }
  }
  const onAction = command => run(() => execute(command));
  function openReference(ref) {
    const manage = surface?.kind === 'manage' ? surface : null;
    const from={...origin(),title:manage ? '管理' : focusedWork?.title ?? focusedUse.definitionSnapshot.title, manage};
    refreshSerial.current++;setTrail(prev=>[...prev,{from,to:ref.id,kind:ref.kind}]);setRestoredView(null);closeSurface();
    setFocusedWork(null);setFocusedUse(null);setWorkSource(null);setSelectedUseId(null);setSelectedStageId(null);setStageFromUse(false);setUseOriginFlow(null);
    setSelectedId(ref.kind==='work'?ref.id:null);setSelectedFlowId(ref.kind==='workflow'?ref.id:null);setFocusedFlow(null);setTab(ref.kind==='workflow'?'workflow':'work');
  }
  function returnFromReference(){
    const from=relatedParent.from;refreshSerial.current++;setTrail(prev=>prev.slice(0,-1));setRestoredView(from);
    setFocusedWork(null);setFocusedUse(null);setFocusedFlow(null);setTab(from.tab);setSelectedId(from.workId);setSelectedUseId(from.parentId);setSelectedStageId(from.stageId);setStageFromUse(from.stageFromUse);setSelectedFlowId(from.flowId);setUseOriginFlow(from.useOriginFlow);
    if (from.manage) setSurface(from.manage);
  }
  function selectWork(work, parentUse = null, view, attention = false) { setAttentionWorkId(attention ? work.id : null); setRestoredView(view ? { workId: work.id, view } : null); setSelectedStageId(null); if (!parentUse) setUseOriginFlow(null); setSelectedUseId(parentUse?.id ?? null); setFocusedUse(parentUse); setWorkSource(parentUse); setSelectedId(work.id); setFocusedWork(work); setTab('work'); setRailPreference(true); setMobilePane('work'); }
  function openUse(use, stageId = null, fromUse = false) {
    setStageFromUse(fromUse);
    if (tab === 'workflow') setUseOriginFlow(selectedFlowId);
    else if (selectedUseId !== use.id) setUseOriginFlow(null);
    setSelectedStageId(stageId); setSelectedUseId(use.id); setFocusedUse(use); setSelectedId(null); setFocusedWork(null); setTab('work'); setRailPreference(true); setMobilePane('work');
  }
  function selectUse(item) { openUse(item); }
  function manageUse(kind,proposal) { setSurface({kind,proposal:structuredClone(proposal),key:crypto.randomUUID()}); }
  const reviewUse = proposal => openPage({ kind: 'proposal', proposal });
  const showProposal = proposal => {
    if (surface?.fromDetail) { setFocusedUse(previous => newest(previous, proposal)); closeSurface(); }
    else reviewUse(proposal);
  };
  const leaveEditor = () => surface?.proposal && !surface.fromDetail ? reviewUse(surface.proposal) : closeSurface();
  function confirmedUse(result) {
    const workId = selectedUseId === result.use.id && result.use.stageWorkIds[selectedStageId];
    if (workId) { setFocusedUse(previous => newest(previous, result.use)); setWorkSource(previous => newest(previous, result.use)); setFocusedWork(previous => newest(previous, result.works.find(w => w.id === workId))); }
    else openUse(result.use);
  }
  function backFromDetail() {
    if(relatedParent){returnFromReference();return;}
    if (parentLabel === '本次工作') { setSelectedId(null); setSelectedStageId(null); setStageFromUse(false); setFocusedWork(null); return; }
    setSelectedStageId(null); setSelectedId(null); setFocusedWork(null); setSelectedUseId(null); setFocusedUse(null);
    if (useOriginFlow) { setSelectedFlowId(useOriginFlow); setTab('workflow'); }
    setUseOriginFlow(null);
  }
  function saveWorks(works, definition = definitionFromWorks(works)) { openPage({ kind: 'saveWorkflow', sourceWorks: structuredClone(works), definition: structuredClone(definition), workspaceId: works[0].workspaceId }); }
  function resetWorkPage() { positions.current.work = 0; setWorkDepth(1); setChecked(new Set()); if (surface?.kind === 'manage') closeSurface(); }
  function changeStatusFilter(selection) { setStatusFilter(selection); setRailPreference(true); resetWorkPage(); }
  function changeWorkflowFilter(id) { setWorkflowFilter(id); resetWorkPage(); }
  function changeWorkspace(id) {
    closeSurface();
    setTrail([]);setRestoredView(null);
    positions.current.workflow = 0;
    setWorkspace(id); changeWorkflowFilter(''); setSelectedStageId(null); setUseOriginFlow(null);
    setSelectedUseId(null); setFocusedUse(null); setWorkSource(null);
    setSelectedId(null); setSelectedFlowId(null); setFocusedWork(null); setFocusedFlow(null);
  }
  async function ensureBus() {
    await api.rpc('ensureBus', {});
    await refresh();
  }

  const currentBus = status?.bus ?? snapshot?.bus;
  const busNeedsConnection = needsBusConnection(currentBus, status?.context);
  const target = currentBus?.sessionId;
  const busPending = !status?.context?.status || !status.context.workspaceId;
  const workspaces = snapshot ? snapshot.workspaces : [];
  const scopeReady = snapshot?.workspaceId === workspaceId;
  const workflows = scopeReady ? snapshot.workflows : [];
  const workflowGroups = !workspaceId ? groupWorkflows(workflows, workspaces) : [];
  const list = workPage?.workspaceId === workspaceId && workPage.workflowFilter === workflowFilter && workPage.statusFilter === statusFilter ? workPage.list : null;
  const filtered = Boolean(workflowFilter) || statusFilter.length !== allCategories.length;
  const workflowOption = flow => <option key={flow.id} value={flow.id}>{flow.title}</option>;
  const works = list?.rows.flatMap(row => row.work ? [row.work] : []) ?? [];
  const managementRows = new Map(), seen = new Set();
  if (managing && list) for (const row of list.rows) {
    const target = managementTarget(row);
    if (target && !seen.has(target.key)) { seen.add(target.key); managementRows.set(row.key, target); }
  }
  const selectedTargets = [...managementRows.values()].filter(target => checked.has(target.key));
  function toggleManagement() { setChecked(new Set()); setManaging(value => !value); }
  function setupManagement(operation) {
    if (selectedTargets.length) setSurface({ kind: 'manage', operation, targets: selectedTargets, key: crypto.randomUUID() });
  }
  const detailWorks = dependencies.workId === focusedWork?.id
    ? [...new Map([...works, ...dependencies.items].map(work => [work.id, work])).values()] : works;
  function openNativeSession(sessionId,view,work=focusedWork) {
    return run(async () => {
      const sessions = await api.rpc('nativeSessions', {});
      if (!viewIsCurrent() || currentSurface.current !== surface) return false;
      if (busPending || connectionError || !work || work.sessionId !== sessionId || work.workspaceId === status.context.workspaceId || !sessions.some(s=>s.sessionId===sessionId && s.workspaceId===work.workspaceId)) throw new Error('工作对话暂不可用，请稍后重试。');
      return openMain(sessionId, { ...origin(view), trail });
    }, '已打开工作对话。');
  }
  function openWorkDecision(row, decision) {
    if (decision === 'proposal') return reviewUse(row.proposal);
    const { work } = row;
    selectWork(work, null, decision === 'result' ? '输出' : decision === 'failed' ? '报告' : '输入', decision !== 'execution');
  }
  const guardedBusy = busy || loading || Boolean(connectionError);
  const railOpen = railPreference ?? Boolean(workspaces.length || list?.rows.length || snapshot?.uses.total || workflows.length);
  const last=trail.at(-1),relatedParent=last && ((tab==='work' && last.kind==='work' && last.to===selectedId) || (tab==='workflow' && last.kind==='workflow' && last.to===selectedFlowId)) ? last : null;
  const entry=restoredView ?? resume;
  const parentLabel = relatedParent ? relatedParent.from.title : (focusedWork && selectedUseId && !selectedStageId) || (stageFromUse && selectedStageId) ? '本次工作' : useOriginFlow ? '工作流详情' : '工作列表';
  const workflowRow = flow => <button type="button" className="loom-work-row" key={flow.id} onClick={() => { setSelectedFlowId(flow.id); setFocusedFlow(flow); }}><div><strong>{flow.title}</strong><small>{flow.stages.length} 个步骤 · 版本 {flow.version}</small></div></button>;

  return <section className="loom-root" aria-label="Loom 工作台">

    <header className="loom-topbar" inert={showingPage}><div className="loom-brand"><strong>Loom</strong></div>
      <button type="button" className="loom-rail-toggle" aria-label={railOpen ? '收起工作栏' : '展开工作栏'} aria-expanded={railOpen} onClick={() => setRailPreference(!railOpen)}>工作</button>

      <div className="loom-connection"><span className={connectionError ? 'loom-dot loom-dot-error' : 'loom-dot'} />{connectionError ? '连接中断 · 自动重试' : loading ? '同步中…' : `已同步 ${syncedAt?.toLocaleTimeString() ?? ''}`}</div>
      <button type="button" disabled={loading} onClick={retry}>刷新</button>
      <button ref={settingsButton} type="button" disabled={!snapshot} onClick={() => openPage({ kind: 'settings' })}>设置</button>
    </header>
    <div className="loom-global-messages">{status?.engine.faulted && <p className="loom-warning" role="status">调度已暂停。<button type="button" onClick={() => openPage({ kind: 'settings' })} disabled={!snapshot}>打开设置查看诊断</button></p>}<ErrorNotice error={connectionError} onRetry={retry} /><ErrorNotice error={actionError} onDismiss={() => setActionError(null)} />{notice && <p className="loom-success" role="status">{notice}<button type="button" aria-label="关闭操作提示" onClick={() => setNotice('')}>×</button></p>}</div>
    <nav className="loom-mobile-tabs" role="tablist" aria-label="主要视图" hidden={showingPage}>
      <button type="button" role="tab" aria-label="显示对话视图" aria-selected={mobilePane === 'chat'} onClick={() => setMobilePane('chat')}>对话</button>
      <button type="button" role="tab" aria-label="显示工作视图" aria-selected={mobilePane === 'work'} onClick={() => { setRailPreference(true); setMobilePane('work'); }}>工作</button>
    </nav>
    <div className="loom-split" data-rail-collapsed={!railOpen} data-mobile-pane={showingPage ? 'page' : mobilePane}>
      <section className="loom-management" aria-label="工作管理" inert={showingPage}>
        <ProjectNavigation projects={workspaces} workspaceId={workspaceId} onChange={changeWorkspace} />
        <nav className="loom-tabs" aria-label="工作台面板">{[['work', '工作'], ['workflow', '工作流']].map(([id, label]) => <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
        {!snapshot || !status ? <Empty>{loading ? '正在读取工作台…' : '工作台暂时不可用，请重试连接。'}</Empty> : <>
          {tab === 'work' && (focusedWork || focusedUse ? <>
            <header className="loom-panel-header"><button type="button" aria-label={`返回${parentLabel}`} onClick={backFromDetail}>← {parentLabel}</button></header>
            <div className="loom-detail-scroll">{focusedWork ? <WorkDetail key={focusedWork.id} work={focusedWork} works={detailWorks} workspaces={workspaces} workflows={workflows} source={workSource} onSave={work => saveWorks([work])} catalog={catalog} busy={guardedBusy} onAction={onAction} onConsent={work => openPage({ kind: 'consent', work: structuredClone(work) })} onAccept={work => setSurface({ kind: 'accept', work: structuredClone(work) })} onCancel={attentionWorkId === focusedWork.id ? undefined : work => setSurface({ kind: 'cancel', work: structuredClone(work) })} onOpenSession={openNativeSession} api={api}
              initialView={entry && (entry.workId===focusedWork.id || entry.stageId && entry.stageId===focusedWork.stageId && entry.parentId===focusedWork.useId) ? entry.view : undefined} onViewChange={rememberView} onDelete={attentionWorkId === focusedWork.id ? undefined : work=>setSurface({kind:'deleteWork',work:structuredClone(work),key:crypto.randomUUID()})}
              onOpenReport={(work,doc) => openPage({kind:'reader',title:doc.title,request:{workId:work.id,documentId:doc.id}})}
              onOpenFile={(work,file) => openPage({kind:'reader',title:file.title,request:{workId:work.id,runId:work.result.runId,index:work.result.deliverables.findIndex(item => item.path===file.path)}})} />
              : focusedUse.status !== 'confirmed' && selectedStageId && focusedUse.definitionSnapshot.stages.some(s => s.id === selectedStageId) ? <ProposedWorkDetail key={`${focusedUse.id}:${selectedStageId}`} proposal={focusedUse} stageId={selectedStageId} busy={guardedBusy} onManage={manageUse} onEdit={() => openPage({ kind: 'useWorkflow', proposal: focusedUse, fromDetail: true })} onReview={() => reviewUse(focusedUse)} />
              : <UseDetail key={focusedUse.id} proposal={focusedUse} api={api} workspaces={workspaces} busy={guardedBusy} onManage={manageUse} onAction={onAction} onSelectStage={stage => openUse(focusedUse, stage.id, true)} onReview={() => reviewUse(focusedUse)} onSelectWork={work => selectWork(work, focusedUse)} onSave={(proposal, works) => saveWorks(works, proposal.definitionSnapshot.stages.length ? proposal.definitionSnapshot : definitionFromWorks(works))} />}</div>
          </> : <>
            <div className="loom-status-filter" role="group" aria-label="筛选工作状态">
              <div className="loom-filter-heading"><span>状态</span><div><button type="button" onClick={() => changeStatusFilter(allCategories)}>全选</button><button type="button" onClick={() => changeStatusFilter(allCategories.filter(value => !statusFilter.includes(value)))}>反选</button></div></div>
              <div className="loom-filter-options">{workCategories.map(([value, label]) => <label key={value}><input type="checkbox" aria-label={label} checked={statusFilter.includes(value)} onChange={event => changeStatusFilter(allCategories.filter(id => id === value ? event.target.checked : statusFilter.includes(id)))} /><span>{label}</span></label>)}</div>
            </div>
            <div className="loom-list-toolbar">
              <select aria-label="筛选工作流" value={workflowFilter} onChange={event => changeWorkflowFilter(event.target.value)}>
                <option value="">不限工作流（含未分类）</option><option value={UNCLASSIFIED}>未分类</option>
                {workspaceId ? workflows.map(workflowOption) : workflowGroups.map(group => <optgroup key={group.id} label={group.label}>{group.workflows.map(workflowOption)}</optgroup>)}
              </select>
              {!managing && <button type="button" className="loom-primary" disabled={guardedBusy} onClick={() => openPage({ kind: 'createWork' })}>＋ 工作</button>}
              <button type="button" aria-pressed={managing} onClick={toggleManagement}>{managing ? '退出管理' : '管理'}</button></div>
            {managing && <div className="loom-list-toolbar" aria-label="管理所选工作">
              <strong role="status">已选 {selectedTargets.length} 条</strong>
              <button type="button" disabled={guardedBusy || !managementRows.size} onClick={() => setChecked(new Set([...managementRows.values()].map(target => target.key)))}>全选已加载</button>
              <button type="button" disabled={!selectedTargets.length} onClick={() => setChecked(new Set())}>清除选择</button>
              <button type="button" disabled={guardedBusy || !selectedTargets.length} onClick={() => setupManagement('cancel')}>取消所选</button>
              <button type="button" className="loom-danger-text" disabled={guardedBusy || !selectedTargets.length} onClick={() => setupManagement('delete')}>删除所选</button>
            </div>}
            <ListViewport key={`work:${workspaceId}`} tab="work" ready={Boolean(list)} positions={positions}><div className="loom-work-list">{workCategories.map(([category, label]) => {
              const rows = list?.rows.filter(row => row.category === category && !row.intent);
              const requests = category === 'interaction' ? list?.rows.filter(row => row.intent) ?? [] : [];
              return rows?.length || requests.length ? <section key={category} aria-label={requests.length ? label : `${label}的工作`}><h3 className="loom-group-title">{label}</h3>
                {!managing && <PendingRequests rows={requests} workspaces={workspaces} onOpen={intent => openPage({kind:'intent',intent})} />}
                {rows.map(row => {
                  if (!managing) return <WorkRow key={row.key} {...{row,workspaceId,workflowFilter,workflows,workspaces}} busy={guardedBusy}
                    onDetail={() => row.work ? selectWork(row.work) : openUse(row.proposal, row.stageId)} onDecision={decision => openWorkDecision(row, decision)} />;
                  const target = managementRows.get(row.key);
                  return target && <ManagedWorkRow key={target.key} {...{ target, workspaceId, workspaces }} checked={checked.has(target.key)} onChange={event => {
                    const selected = event.target.checked;
                    setChecked(previous => { const next = new Set(previous); if (selected) next.add(target.key); else next.delete(target.key); return next; });
                  }} />;
                })}
              </section> : null;
            })}{!list?.rows.length && <Empty>
              {connectionError ? '工作列表读取失败' : !statusFilter.length ? '请选择要查看的状态' : !list ? '正在读取工作…' : filtered ? '没有符合条件的工作' : workspaceId ? '此项目暂无工作' : '暂无工作'}
              {list && filtered && !connectionError && <button type="button" onClick={() => { changeWorkflowFilter(''); changeStatusFilter(allCategories); }}>清除筛选</button>}
            </Empty>}</div>
              {list?.hasMore && <button type="button" className="loom-load-more" aria-label="加载更多工作" disabled={loading} onClick={() => setWorkDepth(depth => depth + 1)}>加载更多</button>}</ListViewport>
          </>)}
          {tab === 'workflow' && (focusedFlow ? <>
            <header className="loom-panel-header"><button type="button" aria-label={relatedParent?`返回${parentLabel}`:'返回工作流列表'} onClick={() => { if(relatedParent){returnFromReference();return;} setSelectedFlowId(null); setFocusedFlow(null); }}>← {relatedParent?parentLabel:'工作流'}</button></header>
            <div className="loom-detail-scroll"><WorkflowDetail key={focusedFlow.id} workflow={focusedFlow} workspaces={workspaces} busy={guardedBusy} api={api} onUse={workflow => openPage({ kind: 'useWorkflow', workflow: structuredClone(workflow) })} onEdit={workflow => openPage({ kind: 'editWorkflow', workflow: structuredClone(workflow) })} onSelectUse={selectUse} /></div>
          </> : <>
            <div className="loom-list-toolbar"><strong>工作流</strong><button type="button" className="loom-primary" disabled={guardedBusy} onClick={() => openPage({ kind: 'createWorkflow' })}>＋ 工作流</button></div>
            <ListViewport key={`workflow:${workspaceId}`} tab="workflow" ready={scopeReady} positions={positions}><div className="loom-work-list">{workspaceId ? workflows.map(workflowRow) : workflowGroups.map(group =>
              <section className="loom-workflow-project" aria-label={`${group.label}的工作流`} key={group.id}><h3 className="loom-group-title">{group.label}</h3>{group.workflows.map(workflowRow)}</section>)}{!workflows.length && <Empty>{connectionError ? '工作流目录读取失败' : !scopeReady ? '正在读取工作流…' : workspaceId ? '此项目暂无工作流' : '暂无工作流'}</Empty>}</div>
            </ListViewport>
          </>)}

        </>}
      </section>
      <section className="loom-chat" aria-label={showingPage ? '主面板' : '协调对话'}>
        <div className="loom-conversation-body" inert={showingPage}>{target && busPending ? <Empty>正在确认会话状态…</Empty> : target && !busNeedsConnection ? <ConversationBoundary key={target}><BoundConversation target={target} retain={retain} SessionProvider={SessionProvider} renderSlot={renderSlot} /></ConversationBoundary> : <Empty><span className="loom-empty-icon">◫</span><h2>{target ? '继续协调工作' : '开始协调工作'}</h2><p>告诉协调助手你的目标。</p><button type="button" className="loom-primary" disabled={busy || !snapshot || Boolean(connectionError)} onClick={() => run(ensureBus, '已连接协调对话。')}>{target ? '继续对话' : '开始对话'}</button></Empty>}</div>
        {surface?.kind === 'settings' && <SettingsPanel api={api} settings={snapshot.settings} status={status} catalog={catalog} catalogError={catalogError} reloadModels={reloadModels} execute={execute} onClose={closeSurface} onTick={() => run(async () => { await api.rpc('tick', {}); await refresh(); })} />}
        {surface?.kind === 'reader' && <WorkspaceReader title={surface.title} request={surface.request} api={api} readFile={readFile} useContextMenu={props.useContextMenu} onClose={closeSurface} />}
        {surface?.kind === 'createWork' && <CreateWork workspaceId={workspaceId} workspaces={workspaces} workflows={workflows} catalog={catalog} defaultModel={snapshot.settings.roleModels.worker} defaultPermission={snapshot.settings.permissionPreset} api={api} execute={execute} onClose={inSurface(closeSurface)} onCreated={inSurface(selectWork)} />}
        {['createWorkflow', 'editWorkflow', 'saveWorkflow', 'editProposal'].includes(surface?.kind) && <CreateWorkflow key={surface.proposal?.id ?? surface.workflow?.id ?? 'create'} workflow={surface.workflow} proposal={surface.proposal} initialDefinition={surface.definition} sourceWorks={surface.sourceWorks} workspaceId={surface.workspaceId ?? workspaceId} workspaces={workspaces} execute={execute} api={api} catalog={catalog} defaultModel={snapshot.settings.roleModels.worker} defaultPermission={snapshot.settings.permissionPreset} onProposed={surface.kind === 'saveWorkflow' ? undefined : inSurface(showProposal)} onClose={inSurface(leaveEditor)} onCreated={inSurface(flow => { setSelectedFlowId(flow.id); setFocusedFlow(previous => newest(previous, flow)); setTab('workflow'); })} />}
        {surface?.kind === 'useWorkflow' && <UseWorkflow key={surface.proposal?.id ?? surface.workflow.id} workflow={surface.workflow} proposal={surface.proposal} fromDetail={surface.fromDetail} api={api} execute={execute} workspaces={workspaces} catalog={catalog} defaultModel={snapshot.settings.roleModels.worker} defaultPermission={snapshot.settings.permissionPreset} onProposed={inSurface(showProposal)} onClose={inSurface(leaveEditor)} />}
        {surface?.kind === 'proposal' && <ProposalDialog key={`${surface.proposal.id}:${surface.proposal.version}`} proposal={surface.proposal} api={api} execute={execute} workspaces={workspaces} catalog={catalog} onClose={inSurface(closeSurface)} onEdit={proposal => openPage({ kind: 'useWorkflow', proposal })} onEditDefinition={proposal => openPage({ kind: 'editProposal', proposal })} onDetails={selectedUseId === surface.proposal.id ? undefined : inSurface(proposal => { openUse(proposal); closeSurface(); })} onConfirmed={inSurface(confirmedUse)} />}
        {surface?.kind === 'consent' && <ConsentDialog work={surface.work} catalog={catalog} workspaces={workspaces} api={api} onClose={inSurface(closeSurface)} onApproved={inSurface(refresh)} />}
        {surface?.kind === 'intent' && <PendingRequestPage key={surface.intent.id} intent={surface.intent} projects={workspaces.filter(item => item.workspaceId !== status.context.workspaceId)} execute={execute} onClose={inSurface(closeSurface)}
          onReadback={inSurface(intent => setSurface(current => current === surface ? {...current,intent:newest(current.intent,intent)} : current))}
          onConversation={inSurface(() => { closeSurface(); setMobilePane('chat'); })} />}
      </section>
    </div>
    {surface?.kind === 'manage' && <ManageConfirmation key={surface.key} api={api} action={surface} workspaces={workspaces} onClose={inSurface(closeSurface)}
      isCurrent={() => viewIsCurrent() && currentSurface.current === surface} onOpenReference={inSurface(openReference)} onReadback={inSurface(async () => { setChecked(new Set()); await refresh(); })} />}
    {surface?.kind === 'accept' && <ConfirmAction title="验收本次结果" confirmLabel="确认验收" onClose={inSurface(closeSurface)} onConfirm={() => execute({ type: 'work.accept', workId: surface.work.id, expectedVersion: surface.work.version, ...(surface.work.result?.runId ? { runId: surface.work.result.runId } : {}) })}><h3>{surface.work.title}</h3><p>确认当前结果符合要求，并继续后续工作？</p></ConfirmAction>}
    {surface?.kind === 'deleteWork' && <ConfirmAction key={surface.key} api={api} targetKind="work" targetId={surface.work.id} onOpenReference={openReference} title="删除这项工作" confirmLabel="确认删除" danger onClose={inSurface(closeSurface)} onConfirm={() => execute({type:'work.delete',workId:surface.work.id,expectedVersion:surface.work.version,idempotencyKey:surface.key})}>
      <h3>{surface.work.title}</h3><p>只删除这项工作在 Loom 内的要求和执行记录。项目文件和原生对话会保留。</p></ConfirmAction>}
    {['cancelUse','deleteUse'].includes(surface?.kind) && <ConfirmAction key={surface.key} api={api} targetKind="use" targetId={surface.kind==='deleteUse'?surface.proposal.id:null} onOpenReference={openReference} title={batchActionLabel(surface.kind==='deleteUse'?'删除':'取消', surface.proposal.definitionSnapshot.stages.length)} confirmLabel={surface.kind==='deleteUse'?'确认删除':'确认取消'} danger={surface.kind==='deleteUse'} neutral onClose={inSurface(closeSurface)} onConfirm={() => execute({type:surface.kind==='deleteUse'?'use.delete':'use.cancel',useId:surface.proposal.id,expectedVersion:surface.proposal.version,idempotencyKey:surface.key})}>
      <h3>{surface.proposal.definitionSnapshot.title}</h3><p>{new Date(surface.proposal.createdAt).toLocaleString()} · {surface.proposal.definitionSnapshot.stages.map(s=>s.title).join('、')}</p>
      <p>{surface.kind==='deleteUse'?'永久删除本次工作要求和输入记录。工作流模板和其他批次会保留。':'这批工作将不再执行，可在「已结束」查看原来的要求和输入。'}</p></ConfirmAction>}
    {surface?.kind === 'cancel' && <ConfirmAction title="取消工作" confirmLabel="确认取消" neutral onClose={inSurface(closeSurface)} onConfirm={() => execute({ type: 'work.cancel', workId: surface.work.id, expectedVersion: surface.work.version })}><h3>{surface.work.title}</h3><p>停止这项工作，保留工作要求、执行记录和已有文件。</p></ConfirmAction>}
  </section>;
}
