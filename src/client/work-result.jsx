import { useState } from 'react';
import { ErrorNotice } from './components.jsx';
import { statusLabel } from './state.mjs';
import { handoffLabel, inputLabel, ValueDisplay } from './workflow-summary.jsx';
import { parameterFor, readerField, splitRequirements } from './reader-fields.mjs';

export function SummaryText({ children, label = '展开全文' }) {
  if (!children) return null;
  return children.length > 280 ? <><p className="loom-description">{children.slice(0, 280)}…</p><details><summary>{label}</summary><p className="loom-description">{children}</p></details></> : <p className="loom-description">{children}</p>;
}
function Checks({ checks }) {
  if (!checks.length) return null;
  const passed = checks.filter(item => item.passed);
  return <>{passed.length > 0 && <details><summary>{passed.length} 项检查通过</summary><ul>{passed.map((item,index)=>{
    const check = item.check ?? item;
    return <li key={index}>{check.path ? <>文件：<code>{check.path}</code></> : <>命令：<code>{check.command}</code>{check.args?.length > 0 && <ol className="loom-arguments">{check.args.map((arg,i)=><li key={i}><code>{arg || '（空参数）'}</code></li>)}</ol>}</>}</li>;
  })}</ul></details>}<ul className="loom-check-list">{checks.filter(item => !item.passed).map((item, index) => {
    const check = item.check ?? item;
    return <li className="loom-check-row" key={index}><div><strong>{check.kind === 'command' ? '命令检查未通过' : '文件检查未通过'}</strong></div>
      {item.detail && <SummaryText>{item.detail}</SummaryText>}
      {check.path && <p>文件：<code>{check.path}</code></p>}
      {(check.contains !== undefined || check.command || item.exitCode !== undefined || item.stdout || item.stderr || item.truncated) && <details><summary>检查详情</summary><dl className="loom-meta">

        {check.contains !== undefined && <><dt>包含文本</dt><dd>{check.contains}</dd></>}
        {check.command && <><dt>命令</dt><dd><code>{check.command}</code></dd><dt>参数</dt><dd><ol className="loom-arguments">{(check.args ?? []).map((arg, i) => <li key={i}><code>{arg || '（空参数）'}</code></li>)}</ol></dd></>}
        {item.exitCode !== undefined && <><dt>退出码</dt><dd>{item.exitCode}</dd></>}
      </dl>{item.truncated && <p className="loom-hint">输出已截断，仅展示已收集的部分。</p>}
        {item.stdout && <section><h4>标准输出</h4><SummaryText label="展开已收集输出">{item.stdout}</SummaryText></section>}
        {item.stderr && <section><h4>错误输出</h4><SummaryText label="展开已收集输出">{item.stderr}</SummaryText></section>}</details>}
    </li>;
  })}</ul></>;
}
function WaitDetail({ wait, status }) {
  if (!wait) return null;
  return <section aria-label="外部操作"><h3>{wait.missingInformation ? '需要补充信息' : status === 'waiting' ? '等待外部结果' : wait.reason ? '远端结果待核实' : '远端操作'}</h3>
    <dl className="loom-summary"><dt>远端引用</dt><dd>{wait.remoteRef}</dd>{wait.condition && <><dt>恢复条件</dt><dd>{wait.condition}</dd></>}{wait.checkMethod && <><dt>核对方法</dt><dd>{wait.checkMethod}</dd></>}{wait.nextCheckAt && <><dt>下次检查</dt><dd>{new Date(wait.nextCheckAt).toLocaleString()}</dd></>}{wait.reason && <><dt>待处理原因</dt><dd>{wait.reason}</dd></>}{wait.attempted && <><dt>已查来源</dt><dd>{wait.attempted}</dd></>}{wait.missingInformation && <><dt>需要补充</dt><dd>{wait.missingInformation}</dd></>}</dl>
    {status === 'cancelled' ? <p className="loom-warning">本地跟踪已结束 · 远端操作状态需另行核实</p> : status === 'waiting' && <p className="loom-hint">调度器会在到期后继续核对这笔操作。</p>}
  </section>;
}

function Verdict({ result, retry }) {
  const references = Array.isArray(result.review?.evidence) ? result.review.evidence : result.review?.evidence?.references;
  return <>
    {result.review && <section><h4>预验收 · {result.review.source === 'acceptance-error' ? '暂不可用' : result.review.passed ? '通过' : '待处理'}</h4>
      <SummaryText>{result.review.summary}</SummaryText>{retry}
      {Array.isArray(references) && references.length > 0 && <details><summary>验收依据</summary><ul>{references.filter(item => typeof item === 'string').map((item, index) => <li key={index}><SummaryText>{item}</SummaryText></li>)}</ul></details>}
    </section>}
    {result.acceptance && <p className="loom-success">{['work', 'workflow'].includes(result.acceptance.mode) ? '已自动验收' : '已确认验收'}{result.acceptance.at ? ` · ${new Date(result.acceptance.at).toLocaleString()}` : ''}</p>}
  </>;
}

export function pendingInteraction(run) {
  if (!run) return null;
  const kinds = run.pendingInput ?? (run.diagnostic?.startsWith('等待原生交互：') ? run.diagnostic.slice('等待原生交互：'.length).split('、') : []);
  if (kinds.includes('approval')) return '请在执行对话中处理审批确认。';
  if (kinds.includes('question')) return '请在执行对话中补充输入。';
  return kinds.length ? '执行对话中有待处理请求。' : null;
}


function SourceName({ works, refValue }) {
  const source = works.find(item => item.id === refValue.workId);
  const output = source?.outputs.find(item => item.name === refValue.output);
  return <>{source?.title ?? '来源工作'} / {output?.description || refValue.output}{refValue.path.length ? ` · ${refValue.path.join('.')}` : ''}</>;
}

function ConsumedResults({ refs, works }) {
  return refs.length > 0 && <section><h4>来自上游的输入</h4><dl className="loom-summary">{refs.map(ref => <div className="loom-value-row" key={ref.inputName}>
    <dt>{inputLabel(ref.inputName)}</dt><dd><ValueDisplay value={ref.value} /><p className="loom-hint">来源：<SourceName works={works} refValue={ref} /> · 结果版本 {ref.resultVersion}</p></dd>
  </div>)}</dl></section>;
}

export function WorkInputs({ inputs: bindings, description, feedback, works = [], current, stage, definition, parameters }) {
  const consumed = current?.value?.consumedResults ?? [];
  const { requirements, metadata } = splitRequirements(description);
  const referencedControls = Object.entries(bindings).filter(([name, ref]) => readerField(name, ref, parameterFor(definition, stage?.inputs[name])).secondary && requirements?.includes(name));
  const procedure = referencedControls.length > 1 ? requirements : null;
  const materials = [], secondary = [];
  for (const [name, ref] of Object.entries(bindings)) {
    if (consumed.some(item => item.inputName === name)) continue;
    const binding = stage?.inputs[name];
    const field = readerField(name, ref, parameterFor(definition, binding));
    const row = <div className="loom-value-row" key={name}><dt>{field.label}{binding?.kind === 'parameter' && binding.path.length > 1 && ` · ${binding.path.slice(1).join('.')}`}</dt>
      <dd>{ref.kind === 'output' ? handoffLabel(definition, ref) : ref.kind === 'result' ? <><SourceName works={works} refValue={ref} /><p className="loom-hint">{current?.loading ? '正在读取本次执行输入…' : current?.error ? '本次消费记录暂不可用' : '执行时读取来源结果'}</p></> : <ValueDisplay value={ref.kind === 'parameter' ? ref.path.reduce((v, key) => v[key], parameters) : ref.value} />}</dd></div>;
    (field.secondary ? secondary : materials).push(row);
  }
  return <section aria-label="工作输入">
    <h3>本次输入</h3>
    {materials.length > 0 && <dl className="loom-summary">{materials}</dl>}
    {requirements && !procedure && <><h4>工作要求</h4><SummaryText>{requirements}</SummaryText></>}
    {feedback && <><h4>本次反馈</h4><SummaryText>{feedback}</SummaryText></>}
    {!materials.length && !requirements && !feedback && <p className="loom-hint">本次没有单独填写材料。</p>}
    {(secondary.length > 0 || consumed.length > 0 || metadata) && <details className="loom-advanced"><summary>执行参数</summary>
      {procedure && <p className="loom-description">{procedure}</p>}
      {secondary.length > 0 && <dl className="loom-summary">{secondary}</dl>}
      <ConsumedResults refs={consumed} works={works} />
      {metadata && <pre className="loom-description">{metadata}</pre>}
    </details>}
  </section>;
}

function ReaderEntry({ title, onOpen }) {
  const [opening, setOpening] = useState(false), [error, setError] = useState(null);
  if (!onOpen) return <span>{title}</span>;
  async function open() {
    setError(null); setOpening(true);
    try { await onOpen(); }
    catch (reason) { setError(reason); }
    finally { setOpening(false); }
  }
  return <><button type="button" disabled={opening} onClick={open}>{title}</button><ErrorNotice error={error} onRetry={open} /></>;
}

export function GateEvidence({ work, works, busy, onRelease, onOpenFile, onOpenReport }) {
  const dependencies = work.dependsOn.map(id => works.find(item => item.id === id));
  const ready = dependencies.every(item => item?.status === 'accepted' && item.result);
  return <section aria-label="放行条件"><h3>放行条件</h3>
    <p>{work.scope ? `操作范围：${work.scope}` : '开始执行前需要人工放行。'}</p>
    {dependencies.length > 0 && <dl className="loom-summary">{dependencies.map((item, index) => <div className="loom-value-row" key={work.dependsOn[index]}>
      <dt>{item?.title ?? '上游工作'}</dt><dd>{item?.status === 'accepted' && item.result ? <>
        <p>已验收 · 结果版本 {item.result.version}</p><SummaryText>{item.result.summary}</SummaryText>
        {item.result.deliverables?.map(file => <ReaderEntry key={file.path} title={file.title} onOpen={onOpenFile && (() => onOpenFile(item,file))} />)}
        {item.documents.filter(doc => doc.runId === item.result.runId).map(doc => <ReaderEntry key={doc.id} title={doc.title} onOpen={onOpenReport && (() => onOpenReport(item,doc))} />)}
        {!item.result.summary && !item.result.deliverables?.length && !item.documents.some(doc => doc.runId === item.result.runId) && <p>此结果未附摘要或交付文件。</p>}
      </> : <p>{item ? `当前状态：${statusLabel(item.status)}。等待可用的验收结果。` : '正在读取上游结果。'}</p>}</dd>
    </div>)}</dl>}
    <button type="button" className="loom-primary" disabled={busy || !ready} onClick={onRelease}>放行人工关卡</button>
  </section>;
}

export function retryEvidenceIssue(run) {
  if (run.checkResults.length !== run.checks.length || run.checkResults.some(check => !check.passed)) return '请先处理未通过或缺失的客观检查。';
  const candidate = run.reports.find(report => report.source.callId === run.reportCallId);
  if (run.observation?.completion?.reason !== 'completed' || run.reportFormat === 'bilingual-v1' && !candidate?.report.document && !Object.keys(run.outputs).length) return '请先补齐本次执行的报告证据。';
  return null;
}

export function WorkOutputs({ status, result, onOpen, retry }) {
  const files = result?.deliverables ?? [];
  return <section aria-label="工作输出"><h3>完成情况</h3>
    <p>{status === 'proposed' ? '尚未执行' : status === 'review' ? result.review?.source === 'acceptance-error' ? '执行已完成，结果仍在' : '执行完成，待验收' : statusLabel(status)}</p>
    {files.length > 0 && <><h4>交付文件</h4><ul>{files.map(file => <li key={`${result.runId}:${file.path}`}>
      <ReaderEntry title={file.title} onOpen={onOpen && (() => onOpen(file))} /> {file.title !== file.path && <code>{file.path}</code>}
    </li>)}</ul></>}
    {status === 'review' && <><Checks checks={result.checks} /><Verdict result={result} retry={retry} /></>}
  </section>;
}

function ReportEntries({ documents, onOpen }) {
  return [['worker', '执行者报告'], ['coordinator', '协调报告']].map(([role, label]) => {
    const entries = documents.filter(doc => doc.role === role);
    return entries.length > 0 && <section key={role} aria-label={label}><h4>{label} · 中英双语</h4><ul>{entries.map(doc => <li key={doc.id}>
      <ReaderEntry title={doc.title} onOpen={onOpen && (() => onOpen(doc))} />
    </li>)}</ul></section>;
  });
}

export function WorkReport({ result, status, wait, run, documents = [], onOpen, retry }) {
  const [showHistory, setShowHistory] = useState(false);
  const runId = result?.runId ?? run?.id;
  const byRun = new Map();
  for (const doc of documents) {
    if (!byRun.has(doc.runId)) byRun.set(doc.runId, []);
    byRun.get(doc.runId).push(doc);
  }
  const current = byRun.get(runId) ?? [];
  byRun.delete(runId);
  return <section aria-label="工作报告"><h3>工作报告</h3>
    <ReportEntries documents={current} onOpen={onOpen} />
    {result ? <>{result.summary && <><h4>执行摘要</h4><SummaryText label="完整摘要">{result.summary}</SummaryText></>}
      <Checks checks={result.checks ?? []} /><Verdict result={result} retry={retry} />
      {!result.acceptance && <p className="loom-hint">{status === 'review' ? '待验收' : '尚未验收'}</p>}
    </> : <><SummaryText>{run?.summary || (!current.length && (status === 'proposed' ? '尚未执行' : '本次暂无执行报告'))}</SummaryText><WaitDetail wait={wait} status={status} /></>}
    {byRun.size > 0 && <div className="loom-actions"><button type="button" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>查看以往报告</button></div>}
    {byRun.size > 0 && showHistory && <section aria-label="以往报告">{Array.from(byRun, ([id, docs]) => <section key={id}>
      <p className="loom-hint">报告时间：{new Date(docs[0].createdAt).toLocaleString()}</p><ReportEntries documents={docs} onOpen={onOpen} />
    </section>)}</section>}
  </section>;
}
