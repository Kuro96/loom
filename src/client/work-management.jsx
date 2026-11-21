import { useState } from 'react';
import { ConfirmAction } from './forms.jsx';
import { projectName } from './project-navigation.jsx';
import { parameterFor, readerField } from './reader-fields.mjs';

function inputSummary(fields, definition, parameters) {
  const summary = new Set();
  for (const inputs of fields) for (const [name, ref] of Object.entries(inputs)) {
    const { label, secondary } = readerField(name, ref, parameterFor(definition, ref));
    if (secondary) continue;
    const value = ref.kind === 'value' ? ref.value : ref.path.reduce((current, key) => current?.[key], parameters);
    if (['string','number','boolean'].includes(typeof value) && value !== '') summary.add(`${label}：${value}`);
    if (summary.size === 3) return [...summary];
  }
  return [...summary];
}

export function managementTarget(row) {
  if (row.intent) return null;
  if (row.proposal) {
    const { id, status, version, workspaceId, createdAt, definitionSnapshot, parameters } = row.proposal;
    const materials = inputSummary(definitionSnapshot.stages.map(stage => stage.inputs), definitionSnapshot, parameters);
    return { key: `use:${id}`, kind: 'use', id, status, version, workspaceId, createdAt, materials, title: definitionSnapshot.title, count: definitionSnapshot.stages.length };
  }
  const { id, status, version, workspaceId, title, createdAt, inputs } = row.work;
  return { key: `work:${id}`, kind: 'work', id, status, version, workspaceId, title, createdAt, materials: inputSummary([inputs]) };
}

export function targetLabel(target) {
  return `${target.title} · ${target.kind === 'use' ? `整批 ${target.count} 项工作` : '单项工作'}`;
}

const createdAtFormat = new Intl.DateTimeFormat(undefined, { year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', fractionalSecondDigits:3 });
function targetContext(target) {
  return [...target.materials, `创建于 ${createdAtFormat.format(new Date(target.createdAt))}`].join(' · ');
}

export function ManagedWorkRow({ target, checked, onChange, workspaceId, workspaces }) {
  const context = [...(!workspaceId ? [projectName(workspaces, target.workspaceId)] : []), targetContext(target)].join(' · ');
  return <label className="loom-work-row loom-checkbox loom-managed-row">
    <input type="checkbox" aria-label={`选择 ${targetLabel(target)} · ${context}`} checked={checked} onChange={onChange} />
    <div><strong>{targetLabel(target)}</strong><small title={context}>{context}</small></div>
  </label>;
}

function cancelBlock(target) {
  if (target.kind === 'use' && target.status !== 'proposed') return '仅待确认的提案可取消。';
  if (target.status === 'cancel_requested') return '已发出取消请求，正在等待停止回执。';
  if (target.status === 'cancelled') return '已经取消。';
  if (target.status === 'accepted') return '已验收的工作不能取消。';
  return null;
}

const refusals = new Set(['CONFLICT', 'NOT_FOUND', 'INVALID_STATE', 'INVALID_DEPENDENCY', 'INVALID_INPUT', 'FORBIDDEN']);

function cancelReceipt(status) {
  if (status === 'cancelled') return '已取消';
  if (status === 'cancel_requested') return '已发出取消请求，等待停止回执';
  return null;
}

async function readReceipt(api, target, operation) {
  const key = target.kind === 'use' ? 'useId' : 'workId';
  const page = await api.rpc('query', { kind: target.kind, [key]: target.id, limit: 1 });
  const current = page.items.find(record => record.id === target.id);
  return operation === 'delete' ? current ? null : '已删除' : cancelReceipt(current?.status);
}

export function ManageConfirmation({ api, action, workspaces, onClose, onOpenReference, onReadback, isCurrent }) {
  const [receipts, setReceipts] = useState(null);
  const { operation, targets, key } = action;
  const deleting = operation === 'delete';
  const label = deleting ? '删除' : '取消';
  const blocks = deleting ? [] : targets.flatMap(target => {
    const message = cancelBlock(target);
    return message ? [{ target, message }] : [];
  });
  async function submit() {
    const results = [];
    let stopped = false;
    for (const target of targets) {
      if (!isCurrent()) return false;
      if (stopped) { results.push({ target, message: '未执行' }); continue; }
      const idField = target.kind === 'use' ? 'useId' : 'workId';
      const command = { type: `${target.kind}.${operation}`, [idField]: target.id, expectedVersion: target.version, idempotencyKey: `${key}:${target.key}` };
      let result;
      try { result = await api.rpc('command', command); }
      catch (reason) {
        let confirmed;
        if (!refusals.has(reason.code)) {
          try { confirmed = await readReceipt(api, target, operation); }
          catch (readError) { results.push({ target, message: '状态待核实', error: readError }); stopped = true; continue; }
        }
        if (confirmed) results.push({ target, message: confirmed });
        else { results.push({ target, message: refusals.has(reason.code) ? `未${label}` : '状态待核实', error: reason }); stopped = true; }
        continue;
      }
      const message = deleting ? '已删除' : cancelReceipt(result.status);
      if (!message) throw new Error('取消回执缺少当前状态。');
      results.push({ target, message });
    }
    if (isCurrent()) {
      setReceipts(results);
      await onReadback();
    }
    return false;
  }
  return <ConfirmAction api={api} title={`${label}所选记录`} confirmLabel={`确认${label}`} danger={deleting} neutral={!deleting}
    targets={deleting ? targets : undefined} settled={Boolean(receipts)} blocked={blocks.length > 0} onClose={onClose} onOpenReference={onOpenReference} onConfirm={submit}>
    <p>{deleting ? '删除 Loom 内的记录。项目文件、原生对话和工作流模板会保留。' : '停止所选工作，保留要求、记录和已有文件。'}</p>
    <ul aria-label="确认范围">{targets.map(target => <li key={target.key}>{projectName(workspaces, target.workspaceId)}：{targetLabel(target)} · {targetContext(target)}</li>)}</ul>
    {blocks.length > 0 && <ul className="loom-blockers" role="alert">{blocks.map(({target,message}) => <li key={target.key}>{target.title}：{message}</li>)}</ul>}
    {receipts && <section aria-label="处理结果" role="status"><h3>处理结果</h3><ul>{receipts.map(({target,message,error}) => <li key={target.key}>
      {target.title}：{message}{error && <p className="loom-hint">{error.message}</p>}
    </li>)}</ul></section>}
  </ConfirmAction>;
}
