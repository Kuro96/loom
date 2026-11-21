import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { catalogModels, errorText, modelFromKey, modelKey, modelLabel, statusLabel, switchModel, transcriptMessages } from './state.mjs';

export function Badge({ status }) {
  return <span className={`loom-badge loom-status-${status}`}>{statusLabel(status)}</span>;
}

export function Json({ value, empty = '暂无记录' }) {
  return <pre className="loom-json">{value == null ? empty : typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Field({ label, hint, children }) {
  return <label className="loom-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ children }) { return <div className="loom-empty">{children}</div>; }

export function ErrorNotice({ error, onRetry, onDismiss }) {
  if (!error) return null;
  const message = { CONFLICT: '内容已更新，请刷新后重试。', NOT_FOUND: '内容暂不可用，请刷新后重试。', INVALID_INPUT: '请检查填写内容后重试。', FORBIDDEN: '此操作需要授权。', INVALID_STATE: '当前状态暂时无法执行此操作。' }[error.code] || '操作未完成，请重试或查看技术详情。';
  return <div className="loom-error" role="alert"><p>{message}</p>
    <details className="loom-advanced"><summary>技术详情</summary><pre>{typeof error === 'string' ? error : errorText(error)}</pre></details>
    <div className="loom-actions">{onRetry && <button type="button" onClick={onRetry}>重试</button>}{onDismiss && <button type="button" onClick={onDismiss}>关闭提示</button>}</div>
  </div>;
}

export function ModelPicker({ catalog, value, onChange, label = '执行模型', allowEmpty = true, emptyLabel = '选择模型', disabled = false }) {
  const options = catalog ? catalogModels(catalog) : [];
  const key = modelKey(value);
  const efforts = options.find(option => option.key === key)?.reasoning?.efforts ?? [];
  return <div className="loom-model-picker"><Field label={label}>
    <select aria-label={label} value={key} disabled={disabled} onChange={event => {
      const selected = modelFromKey(event.target.value);
      onChange(switchModel(value, selected, catalog));
    }}>
      <option value="" disabled={!allowEmpty}>{emptyLabel}</option>
      {key && !options.some(option => option.key === key) && <option value={key}>{modelLabel(value, catalog)}</option>}
      {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
  </Field>
    {value && (efforts.length > 0 || value.reasoningEffort) && <Field label="推理强度">
      <select aria-label={`${label}推理强度`} value={value.reasoningEffort ?? ''} disabled={disabled} onChange={event => {
        const { reasoningEffort, ...model } = value;
        onChange(event.target.value ? { ...model, reasoningEffort: event.target.value } : model);
      }}><option value="">默认</option>
        {value.reasoningEffort && !efforts.some(effort => effort.id === value.reasoningEffort) && <option value={value.reasoningEffort}>已保存的推理选项（名称暂不可用）</option>}
        {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name || '选项名称暂不可用'}</option>)}
      </select>
    </Field>}
  </div>;
}

export function WorkspacePicker({ workspaces, value, onChange, disabled = false }) {
  return <select aria-label="所属项目" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">选择原生项目</option>
    {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title || '项目名称暂不可用'}</option>)}
  </select>;
}

export function MoreButton({ page, busy, onMore }) {
  return page.nextCursor != null && <div className="loom-pagination"><button type="button" disabled={busy} onClick={onMore}>加载更多</button></div>;
}

function focusHeading(node) {
  if (node) node.focus({ preventScroll: true });
}

export function InlinePage({ title, children, onBack, busy = false, reader = false }) {
  const titleId = useId();
  return <section className={`loom-surface loom-page${reader ? ' loom-page-reader' : ''}`} aria-labelledby={titleId}>
    <header className="loom-panel-header"><button type="button" disabled={busy} aria-label="返回" onClick={onBack}>← 返回</button><h2 id={titleId} tabIndex={-1} ref={focusHeading}>{title}</h2></header>
    <div className="loom-page-body">{children}</div>
  </section>;
}

export function Modal({ title, children, onClose, busy = false }) {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialog.current.showModal();
    return () => { if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus(); };
  }, []);
  return <dialog className="loom-surface loom-dialog" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} aria-label="关闭对话框" onClick={onClose}>×</button></header>
    {children}
  </dialog>;
}

export function BoundConversation({ target, retain, SessionProvider, renderSlot, readOnly = false }) {
  const [reference, setReference] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReference(null); setError(null);
    let owned;
    try { owned = retain(target); }
    catch (reason) { setError(reason); return; }
    owned.ready.then(
      () => { if (active) setReference(owned); },
      reason => { if (active) setError(reason); },
    );
    return () => { active = false; owned.release(); };
  }, [target, retain, attempt]);
  if (error) return <ErrorNotice error={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (!reference) return <Empty>正在连接原生会话…</Empty>;
  if (readOnly) return <HistoryTranscript source={reference.binding.eventSource} />;
  return <SessionProvider session={reference}>{renderSlot('loom.conversation', {})}</SessionProvider>;
}

export function HistoryTranscript({ source }) {
  const window = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot());
  const messages = transcriptMessages(window.entries);
  return <section className="loom-history-transcript" aria-label="历史对话记录" style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}>
    <p className="loom-hint">历史对话 · 只读{window.hasMore ? ' · 显示最近记录' : ''}</p>
    {messages.map((message, index) => <article className="loom-history-message" key={`${message.id}-${index}`}><header>{message.role}</header><div className="loom-description">{message.text}</div></article>)}
    {!messages.length && <p className="loom-hint">暂无消息</p>}
  </section>;
}

export class ConversationBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <ErrorNotice error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
