import { useEffect, useState } from 'react';
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
function PinnedSource({ api, source, workspaceId }) {
  const { workId, runId, resultVersion, output } = source;
  const [read, setRead] = useState(null), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      let after = null;
      do {
        const page = await api.rpc('query', { kind: 'run', workspaceId, workId, limit: 25, ...(after ? { after } : {}) });
        if (!active) return;
        const run = page.items.find(item => item.id === runId);
        if (run) {
          if (run.workId !== workId || run.workspaceId !== workspaceId || run.status !== 'completed' || run.resultVersion !== resultVersion || typeof run.outputs[output] !== 'string') break;
          setRead({ value: run.outputs[output] });
          return;
        }
        after = page.nextCursor;
      } while (after !== null);
      throw new Error('这次查证所用的来源结果暂不可读。');
    }
    void load().catch(error => { if (active) setRead({ error }); });
    return () => { active = false; };
  }, [api, workspaceId, workId, runId, resultVersion, output, attempt]);
  return <section aria-label="已核实的来源"><h4>已核实的来源</h4><p className="loom-hint">已验收的文本 · 结果版本 {resultVersion}</p>
    {read?.error ? <ErrorNotice error={read.error} onRetry={() => { setRead(null); retry(i => i + 1); }} />
      : read ? <p className="loom-description">{read.value}</p> : <p role="status">正在读取查证所用的结果…</p>}</section>;
}

function SourceEvidence({ handoff }) {
  const structured = handoff.evidence ?? [];
  const cited = new Set();
  const entries = structured.map(entry => {
    if (entry.kind === 'github-ref') {
      const branch = entry.ref.replace(/^refs\/heads\//, '');
      const key = `GitHub ${entry.repository} ${entry.ref}`;
      const url = /^[\w.-]+\/[\w.-]+$/.test(entry.repository) && /^refs\/heads\/[\w.-]+$/.test(entry.ref) &&
        entry.url === `https://github.com/${entry.repository}/tree/${branch}` ? entry.url : null;
      cited.add(key);
      return <li key={key}><strong>{entry.repository} · {branch}</strong><p className="loom-description"><code>{entry.sha}</code></p>
        <time dateTime={entry.observedAt}>{new Date(entry.observedAt).toLocaleString()}</time>
        {url && <> · <a href={url} target="_blank" rel="noopener noreferrer">查看分支</a></>}</li>;
    }
    if (typeof entry.sessionId === 'string' && Number.isSafeInteger(entry.eventSeq) && typeof entry.snippet === 'string') {
      const key = `DSH ${entry.sessionId} event ${entry.eventSeq}`;
      cited.add(key);
      return <li key={key}><strong>项目对话摘录</strong><p className="loom-description">{entry.snippet}</p><small className="loom-hint">消息位置 {entry.eventSeq}</small></li>;
    }
    return null;
  });
  return <ul className="loom-check-list">{entries}{handoff.sources.filter(source => !cited.has(source)).map((text, index) => <li key={index}>{text}</li>)}</ul>;
}

export function workWaitReason(wait) {
  return wait.help?.missingInformation || wait.reason || wait.condition;
}

function WaitDetail({ wait, status, run, workspaceId, sessionId, api, onRelatedWork, pauseControls, projectPaused, questionControls, evidenceOpen, onEvidenceChange }) {
  if (!wait) return null;
  const { help, handoff, investigation } = wait;
  const reason = workWaitReason(wait);
  const waiting = status === 'waiting', paused = status === 'paused';
  const question = paused && wait.missingInformation;
  const nextCheck = waiting && !projectPaused && (wait.coordination?.retryAt ?? wait.nextCheckAt);
  const source = handoff?.investigation?.source;
  const admitted = handoff?.information && run?.observation?.admitted === true && run.sessionId === sessionId &&
    run.wait?.operationId === wait.operationId && run.wait.handoff?.at === handoff.at;
  const continuable = ['queued', 'dispatching', 'running'].includes(status);
  const attempted = help?.attempted || (!handoff && wait.attempted);
  const investigating = waiting && investigation?.status === 'pending';
  return <section className="loom-coordination" aria-label="工作协调">
    {question ? <p className="loom-warning">{question}</p>
      : waiting && projectPaused ? <p className="loom-hint">项目协调已暂停</p>
      : waiting ? <p className="loom-warning">{investigation?.status === 'pending' ? '后台正在查证' : investigation?.status === 'failed' ? '协查未核实结果，等待后台复查' : wait.coordination ? '已安排后台查证' : '等待后台复查'}</p>
      : continuable && wait.information ? <p className="loom-coordination-receipt" role="status">已提交补充信息 · {status === 'running' ? '原工作执行中' : '等待原工作继续'}</p>
      : admitted ? <p className="loom-coordination-receipt">已交回原工作</p>
      : continuable && handoff?.information ? <p className="loom-coordination-receipt">已核实线索，等待原工作继续</p>
      : paused ? <p className="loom-hint">已暂停自动协调</p>
      : status === 'cancelled' && wait.remoteRef ? <p className="loom-warning">本地跟踪已结束 · 远端结果待核实</p> : null}
    <dl className="loom-summary">
      {reason && reason !== question && <><dt>{waiting || paused ? '卡点' : '原卡点'}</dt><dd>{reason}</dd></>}
      {(waiting || paused && !question) && <><dt>负责人</dt><dd>项目后台总控</dd></>}
      {investigation && <><dt>{investigating ? '当前动作' : '关联协查'}</dt><dd>
        {onRelatedWork ? <button className="loom-coordination-link" type="button" onClick={() => onRelatedWork(investigation.workId)}>查看协查工作</button> : '协查工作'}（只读）</dd></>}
      {waiting && !investigating && !projectPaused && <><dt>当前动作</dt><dd>{wait.checkMethod || (help ? '查证缺失信息' : '核对外部结果')}</dd></>}
      {nextCheck && <><dt>下次检查</dt><dd><time dateTime={nextCheck}>{new Date(nextCheck).toLocaleString()}</time></dd></>}
      {paused && !question && wait.nextCheckAt && <><dt>下次检查</dt><dd>恢复协调后复查</dd></>}
      {wait.remoteRef && <><dt>远端引用</dt><dd>{wait.remoteRef}</dd></>}
      {handoff?.information && <><dt>交接内容</dt><dd>{handoff.information}</dd></>}
      {wait.information && <><dt>已补充</dt><dd>{wait.information}</dd></>}
      {handoff?.information && <><dt>接收方</dt><dd>原工作</dd></>}
      {admitted && status === 'running' && <><dt>下一步</dt><dd>原工作正在执行</dd></>}
    </dl>
    {pauseControls}{questionControls}
    {(attempted || help?.expectedEvidence || handoff) && <details open={evidenceOpen} onToggle={event => onEvidenceChange(event.currentTarget.open)}><summary>查看查证记录</summary>
      {attempted && <><h4>已查来源</h4><SummaryText>{attempted}</SummaryText></>}
      {help?.expectedEvidence && <><h4>需要核实的证据</h4><SummaryText>{help.expectedEvidence}</SummaryText></>}
      {handoff && !source && evidenceOpen && <SourceEvidence handoff={handoff} />}
      {source && evidenceOpen && <PinnedSource key={`${source.runId}:${source.resultVersion}:${source.output}`} {...{ api, source, workspaceId }} />}
    </details>}
  </section>;
}

function InvestigationDetail({ investigation, result, api, workspaceId, onRelatedWork, evidenceOpen, onEvidenceChange }) {
  if (!investigation) return null;
  const verified = result?.review?.source === 'native-investigation' && result.review.passed && result.acceptance;
  return <section className="loom-coordination" aria-label="只读协查">
    <dl className="loom-summary"><dt>原工作</dt><dd>{onRelatedWork && <button className="loom-coordination-link" type="button" onClick={() => onRelatedWork(investigation.parentWorkId)}>查看原工作</button>}</dd>
      <dt>范围</dt><dd>读取本项目已验收的固定版本文本</dd></dl>
    {verified && <details open={evidenceOpen} onToggle={event => onEvidenceChange(event.currentTarget.open)}><summary>查看查证记录</summary>
      {evidenceOpen && <PinnedSource {...{ api, workspaceId }} source={investigation.source} />}
    </details>}
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
  const observation = run.observation;
  if (observation?.questionReceipts?.some(receipt => ['open', 'continued'].includes(receipt.status) &&
      receipt.sessionId === run.sessionId && receipt.requestId === run.requestId &&
      observation.questionCalls.some(call => call.callSeq === receipt.callSeq))) return '原生提问仍待回答，请打开执行对话。';
  return kinds.length ? '执行对话中有待处理请求。' : null;
}

function NativeDiagnostic({ run }) {
  const fault = run?.nativeFault;
  if (fault?.scope !== 'run') return null;
  const retry = new Date(fault.retryAt);
  return <section className="loom-coordination" aria-label="执行诊断"><p className="loom-warning" role="status">执行状态待核对</p>
    <dl className="loom-summary"><dt>当前动作</dt><dd>{fault.operation}</dd><dt>下次检查</dt><dd><time dateTime={retry.toISOString()}>{retry.toLocaleString()}</time></dd></dl>
    {run.diagnostic && <details><summary>技术详情</summary><p className="loom-description">{run.diagnostic}</p></details>}
  </section>;
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

export function WorkReport({ result, status, wait, investigation, run, workspaceId, sessionId, api, documents = [], onOpen, onRelatedWork, retry, pauseControls, projectPaused, questionControls, evidenceOpen = false, onEvidenceChange }) {
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
    <WaitDetail {...{ wait, status, run, workspaceId, sessionId, api, onRelatedWork, pauseControls, projectPaused, questionControls, evidenceOpen, onEvidenceChange }} />
    <InvestigationDetail {...{ investigation, result, api, workspaceId, onRelatedWork, evidenceOpen, onEvidenceChange }} />
    <NativeDiagnostic run={run} />
    {result ? <>{result.summary && <><h4>执行摘要</h4><SummaryText label="完整摘要">{result.summary}</SummaryText></>}
      <Checks checks={result.checks ?? []} /><Verdict result={result} retry={retry} />
      {!result.acceptance && <p className="loom-hint">{status === 'review' ? '待验收' : '尚未验收'}</p>}
    </> : <SummaryText>{run?.summary || (!wait && !investigation && !run?.nativeFault && !current.length && (status === 'proposed' ? '尚未执行' : '本次暂无执行报告'))}</SummaryText>}
    {byRun.size > 0 && <div className="loom-actions"><button type="button" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>查看以往报告</button></div>}
    {byRun.size > 0 && showHistory && <section aria-label="以往报告">{Array.from(byRun, ([id, docs]) => <section key={id}>
      <p className="loom-hint">报告时间：{new Date(docs[0].createdAt).toLocaleString()}</p><ReportEntries documents={docs} onOpen={onOpen} />
    </section>)}</section>}
  </section>;
}
