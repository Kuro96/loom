import { useState } from 'react';
import { Badge, ErrorNotice, Field, InlinePage, WorkspacePicker } from './components.jsx';
import { projectName } from './project-navigation.jsx';
import { SummaryText } from './work-result.jsx';
import { createCommandMemo } from './state.mjs';

const actions = {
  proposal: ['本批工作等待确认执行', '核对执行'],
  execution: ['执行方案等待确认', '查看执行方案'],
  gate: ['执行前需要人工放行', '查看放行条件'],
  native_approval: ['执行对话中有审批请求', '查看审批请求'],
  native_question: ['执行对话等待补充输入', '查看待补输入'],
  native_other: ['执行对话中有待处理请求', '查看待处理请求'],
  result: ['执行已完成，结果待验收', '查看结果'],
  failed: ['执行已结束，需核对失败原因', '查看报告'],
  external_input: ['外部核对需要补充信息', '查看待补信息'],
  resume: ['工作已暂停，等待继续', '查看工作'],
};

export function WorkRow({ row, workspaceId, workflowFilter, workflows, workspaces, busy, onDetail, onDecision }) {
  const flow = row.workflowId === null ? '未分类' : workflows.find(f => f.id === row.workflowId)?.title ?? '历史工作流';
  const project = !workspaceId && projectName(workspaces, row.workspaceId);
  const decision = row.category === 'interaction' && (row.proposal ? 'proposal' : row.decision);
  const action = actions[decision];
  const missingOutput = decision === 'result' && row.work.outputs.some(output => output.required && !Object.hasOwn(row.work.result.outputs, output.name));
  const reason = decision === 'proposal' ? `${row.proposal.definitionSnapshot.stages.length} 项工作待确认` : missingOutput ? '执行已完成，缺少验收所需的结果' : decision === 'execution' && !row.work.model ? '等待选择执行模型'
    : decision === 'execution' && row.work.modelConsent?.modelRevision === row.work.modelRevision ? '命令检查等待授权'
    : decision === 'external_input' ? row.work.wait.missingInformation : action?.[0];
  const context = [project, ...(action ? [reason] : [!workflowFilter && flow, new Date(row.createdAt).toLocaleString()])].filter(Boolean).join(' · ');
  return <button type="button" className="loom-work-row" data-use-id={row.proposal?.id} data-stage-id={row.stageId} data-work-id={row.work?.id}
    aria-label={action ? `${row.title}：${action[1]} · ${context}` : undefined} disabled={Boolean(action && busy)} onClick={action ? () => onDecision(decision) : onDetail}><div>
    <strong>{row.title}</strong><small title={context}>{context}</small>
  </div>{!action && <Badge status={row.status} />}</button>;
}

export function PendingRequests({ rows, workspaces, onOpen }) {
  if (!rows.length) return null;
  return <section aria-label="待澄清请求"><h3 className="loom-group-title">待澄清请求</h3>{rows.map(({ intent }) => <div className="loom-decision-row" key={intent.id}>
    <div className="loom-request-summary"><strong>{intent.text}</strong><small>{intent.workspaceId ? `${projectName(workspaces, intent.workspaceId)} · 等待协调提案` : '等待确定所属项目'}</small></div>
    <button type="button" onClick={() => onOpen(intent)}>查看请求</button>
  </div>)}</section>;
}

export function PendingRequestPage({ intent, projects, execute, onReadback, onClose, onConversation }) {
  const [workspaceId, setWorkspaceId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [commandFor] = useState(createCommandMemo);
  const choices = projects.map(project => projects.some(other => other.workspaceId !== project.workspaceId && other.title === project.title)
    ? { ...project, title: `${project.title} · ${project.path}` } : project);
  async function submit(event) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await execute(commandFor({ type: 'intent.assignProject', intentId: intent.id, workspaceId, expectedVersion: intent.version ?? 1 }));
      onReadback(saved);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  return <InlinePage title="核对请求归属" onBack={onClose} busy={busy}>
    <h3>原请求</h3><SummaryText>{intent.text}</SummaryText>
    {intent.workspaceId && <p>所属项目：{projectName(choices, intent.workspaceId)}</p>}
    <form onSubmit={submit}>
      <ErrorNotice error={error} />
      <Field label={intent.workspaceId ? '更改项目' : '所属项目'}><WorkspacePicker workspaces={choices} value={workspaceId} onChange={setWorkspaceId} disabled={busy} /></Field>
      <footer><button type="submit" className="loom-primary" disabled={!workspaceId || workspaceId === intent.workspaceId || busy}>确认所属项目</button>
        <button type="button" disabled={busy} onClick={onConversation}>回协调对话</button></footer>
    </form>
  </InlinePage>;
}
