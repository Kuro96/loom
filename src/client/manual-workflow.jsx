import { useEffect, useRef, useState } from 'react';
import { ErrorNotice, Field, InlinePage, WorkspacePicker } from './components.jsx';
import { CreateWorkflow } from './forms.jsx';
import { DefinitionSummary } from './workflow-summary.jsx';
import { manualEvidenceLimit, manualSelectionLimit, pickedName, markdownBody, manualLines as lines, manualApproval, manualHandoffIssue, manualResourceStatus as resourceStatus } from '../core/manual-sources.mjs';
import { cleanDefinition, definitionFields } from './definition.jsx';
import { InputError } from './use-inputs.jsx';

const initial = { workList: '', files: [], paths: '', markdown: '', works: [], verifyPaths: '', clarification: '' };
const includeEvidence = (text, evidence, separator = '\n') => [text, evidence].filter(Boolean).join(separator);
const editableText = (text, evidence) => evidence ? text.slice(0, -evidence.length).trimEnd() : text;
const requiresGate = (stage, review) => review.required || manualApproval([stage.title, stage.instructions, stage.scope].join('\n'));

function ReferenceWorks({ api, workspaceId, value, onChange, disabled }) {
  const [page, setPage] = useState(null), [error, setError] = useState(null);
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(false);
  const request = useRef(0);
  function read(after = null) {
    const token = ++request.current;
    setBusy(true);
    setError(null);
    api.rpc('query', { kind: 'work', workspaceId, limit: 20, ...(after ? { after } : {}) }).then(result => {
      if (request.current !== token) return;
      setPage(previous => after ? { ...result, items: [...previous.items, ...result.items] } : result);
      setBusy(false);
    }, reason => {
      if (request.current !== token) return;
      setError(reason); setBusy(false);
    });
  }
  useEffect(() => { read(); return () => { request.current++; }; }, [api, workspaceId, retry]);
  const available = new Set(page ? page.items.map(work => work.id) : []);
  const toggle = (work, checked) => onChange(checked ? [...value.filter(item => item.id !== work.id), { id: work.id, version: work.version, title: work.title }] : value.filter(item => item.id !== work.id));
  return <details><summary>参考已有工作（可选）{value.length > 0 ? ` · 已选 ${value.length} 项` : ''}</summary>
    <p className="loom-hint">只使用所选工作的说明，作为手册步骤的参考。</p>
    <ErrorNotice error={error} onRetry={() => setRetry(count => count + 1)} />
    {busy && <p role="status">正在读取项目工作…</p>}
    {page && !page.total && <p className="loom-hint">此项目暂无工作。</p>}
    {(page ? page.items : []).concat(value.filter(item => !available.has(item.id))).map(work => {
      const selected = value.find(item => item.id === work.id), stale = selected && selected.version !== work.version;
      return <label key={work.id} className="loom-checkbox"><input aria-label={`参考工作：${work.title}`} type="checkbox" checked={Boolean(selected)} disabled={disabled || (!selected && value.length >= 12)} onChange={event => toggle(work, event.target.checked)} />
        <span>{work.title}{work.createdAt && ` · ${new Date(work.createdAt).toLocaleString()}`}{stale && ' · 已更新，请取消再选'}</span></label>;
    })}
    {page?.nextCursor && <button type="button" disabled={busy || disabled} onClick={() => read(page.nextCursor)}>加载更多工作</button>}
    {error?.code === 'CONFLICT' && <button type="button" disabled={disabled} onClick={() => onChange([])}>清除参考选择</button>}
  </details>;
}

function Resources({ resources, definition, onVerify }) {
  if (!resources.length) return null;
  return <section aria-label="资源核对"><h3>资源核对</h3><ul className="loom-check-list">{resources.map(({ stageId, name, kind, status }, index) => <li key={index}>
    <strong>{name}</strong> · {resourceStatus[status]}
    {stageId && <> · {definition.stages.find(stage => stage.id === stageId).title}</>}
    {onVerify && kind === 'project' && status === 'unverified' && <> <button type="button" onClick={() => onVerify('verifyPaths', name)}>添加到文件核对</button></>}
    {kind === 'skill' && status === 'unverified' && '。可在来源中填写项目内 SKILL.md 的路径，首次使用时核对技能是否可用。'}
    {kind === 'external' && '。放行前请核对服务、登录和权限。'}
  </li>)}</ul></section>;
}

export function WorkflowCreation({ workspaceId, workspaces, controlWorkspaceId, api, execute, onClose, onCreated, ...formProps }) {
  const projects = workspaces.filter(item => item.workspaceId !== controlWorkspaceId);
  const [step, setStep] = useState('choose'), [workspace, setWorkspace] = useState(workspaceId === controlWorkspaceId ? '' : workspaceId);
  const [fields, setFields] = useState(initial), [result, setResult] = useState(null);
  const [editor, setEditor] = useState(null), [decisions, setDecisions] = useState(new Map());
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const active = useRef(false), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const change = key => value => {
    setFields(previous => ({ ...previous, [key]: value }));
    setError(null);
    if (key !== 'clarification') setResult(null);
  };
  const backToSources = () => { setError(null); setResult(null); setStep('sources'); };
  function switchProject(value) {
    setWorkspace(value); setFields(initial); setResult(null); setError(null);
  }
  async function pickFiles(event) {
    const input = event.currentTarget, picked = Array.from(input.files);
    input.value = '';
    if (!picked.length || pending.current) return;
    const fail = message => setError({ code: 'MANUAL_INPUT', message });
    if (fields.files.length + picked.length + lines(fields.paths).length > manualSelectionLimit) return fail('最多选择 12 个手册文件。');
    const bytes = fields.files.reduce((total, file) => total + new TextEncoder().encode(file.content).length, 0);
    if (bytes + picked.reduce((total, file) => total + file.size, 0) > manualEvidenceLimit) return fail('所选 Markdown 文件合计最多 48 KiB。');
    const names = new Set(fields.files.map(file => file.name.toLowerCase()));
    for (const { name } of picked) {
      if (!pickedName(name)) return fail(`请选择 .md 或 .markdown 文件：${name}`);
      if (names.has(name.toLowerCase())) return fail(`手册名称重复，请移除或重命名：${name}`);
      names.add(name.toLowerCase());
    }
    pending.current = true; setBusy(true); setError(null);
    const files = [];
    try {
      for (const file of picked) {
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
        catch (reason) {
          if (!(reason instanceof TypeError || reason instanceof DOMException)) throw reason;
          if (active.current) fail(`无法读取 ${file.name}，请重新选择非空 UTF-8 Markdown 文件。`);
          return;
        }
        if (!markdownBody(content)) {
          if (active.current) fail(`请选择非空 UTF-8 Markdown 文件：${file.name}`);
          return;
        }
        files.push({ name: file.name, content });
      }
      if (active.current) change('files')([...fields.files, ...files]);
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const canGenerate = workspace && fields.workList.trim() && (fields.files.length || fields.paths.trim() || fields.markdown.trim());
  async function generate(event) {
    event.preventDefault();
    if (pending.current || !canGenerate) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const next = await api.rpc('manualDraft', { workspaceId: workspace, workList: fields.workList, files: fields.files, paths: lines(fields.paths), markdown: fields.markdown,
        works: fields.works.map(({ id, version }) => ({ id, version })), verifyPaths: lines(fields.verifyPaths), clarification: fields.clarification,
        questions: result?.state === 'clarify' ? result.questions : [] });
      if (!active.current) return;
      setResult(next);
      if (next.state === 'review') {
        setEditor(definitionFields({ ...next.definition, knowledge: editableText(next.definition.knowledge, next.provenance),
          stages: next.definition.stages.map(stage => ({ ...stage, scope: editableText(stage.scope, next.gateReviews[stage.id].evidence) })) }));
        setDecisions(new Map());
        setStep('review');
      }
    } catch (reason) { if (active.current) setError(reason); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  if (step === 'blank') return <CreateWorkflow {...formProps} workspaceId={workspaceId} workspaces={workspaces} api={api} execute={execute} onCreated={onCreated} onClose={saved => saved ? onClose() : setStep('choose')} />;
  if (step === 'edit') {
    const definition = { ...editor, stages: editor.stages.map(stage => ({ ...stage, manualGate: requiresGate(stage, result.gateReviews[stage.id]) || decisions.get(stage.id) !== 'ready' })) };
    function finalize(draft) {
      const issue = manualHandoffIssue(draft);
      if (issue) throw new InputError(issue);
      const positions = new Map(result.workMapping.flatMap(({ stageIds }, index) => stageIds.map(id => [id, index])));
      const stages = draft.stages.map(stage => {
        const review = result.gateReviews[stage.id], decision = decisions.get(stage.id);
        if (decision !== 'release' && (decision !== 'ready' || requiresGate(stage, review))) throw new InputError(`请返回草稿核对，确认「${stage.title}」的放行方式。`);
        const dependencies = [...stage.dependsOn, ...Object.values(stage.inputs).filter(ref => ref.kind === 'output').map(ref => ref.stageId)];
        if (dependencies.some(id => positions.get(id) > positions.get(stage.id))) throw new InputError(`「${stage.title}」依赖清单中靠后的工作，请调整依赖。`);
        const evidence = review.evidence || (requiresGate(stage, review) ? '步骤说明要求人工放行' : '');
        return { ...stage, manualGate: decision === 'release', scope: includeEvidence(stage.scope, evidence) };
      });
      return { ...draft, stages, knowledge: includeEvidence(draft.knowledge, result.provenance, '\n\n') };
    }
    return <CreateWorkflow workspaceId={workspace} workspaces={projects} api={api} execute={execute} onCreated={onCreated}
      onClose={saved => saved ? onClose() : setStep('review')} manualDraft={{ definition, onChange: setEditor, finalize }} />;
  }
  if (step === 'review') {
    const { citations, resources, workMapping, gateReviews } = result;
    let summary, summaryIssue;
    try {
      summary = cleanDefinition(editor);
      summaryIssue = manualHandoffIssue(summary);
    } catch (reason) {
      // The editor can retain incomplete fields while the user reviews sources.
      if (reason.constructor !== Error && !(reason instanceof InputError)) throw reason;
      summaryIssue = reason.message;
    }
    const workLabels = new Map(workMapping.flatMap(({ title, stageIds }) => stageIds.map(id => [id, title])));
    const reviewFor = stage => {
      const review = gateReviews[stage.id];
      const required = requiresGate(stage, review), selected = decisions.get(stage.id);
      return { required, evidence: review.evidence || (required ? '步骤说明要求人工放行' : ''), decision: required && selected === 'ready' ? '' : selected ?? '' };
    };
    return <InlinePage key="review" title="从手册创建 · 核对草稿" onBack={backToSources}>
      <h3>{editor.title || result.definition.title}</h3>{editor.description && <p>{editor.description}</p>}
      {summaryIssue ? <p role="alert" className="loom-warning">草稿尚需调整：{summaryIssue}</p> : <p role="status" className="loom-hint">草稿待首次试运行。先保存模板，再填写首批输入并确认执行。</p>}
      <p className="loom-hint">逐步核对产出与手册依据，并选择放行方式。</p>
      {editor.parameters.length > 0 && <section><h4>每批输入</h4><ul>{editor.parameters.map((param, index) => <li key={index}>{param.description || param.name}{param.required && ' · 必填'}</li>)}</ul></section>}
      {!summaryIssue && <DefinitionSummary definition={summary} reviewStage={stage => {
        const { required, evidence, decision } = reviewFor(stage);
        const label = `放行方式：${stage.title}`;
        return <><p>对应工作：{workLabels.get(stage.id)}</p>
          {stage.outputs.length > 0 && <p>产出：{stage.outputs.map(output => (output.description || output.name) + (output.required ? '（必需）' : '')).join('、')}</p>}
          {stage.scope && <p className="loom-description">操作范围：{stage.scope}</p>}
          <Field label={label} hint={evidence || '普通步骤可在前置工作完成后开始。'}><select aria-label={label} value={decision} onChange={event => {
            const value = event.target.value;
            setDecisions(previous => new Map(previous).set(stage.id, value));
          }}><option value="">待核对（默认需要放行）</option><option value="release">保留人工放行</option>{!required && <option value="ready">普通步骤，条件满足后执行</option>}</select></Field></>;
      }} />}
      <Resources resources={resources} definition={editor} onVerify={(field, name) => { if (!lines(fields[field]).includes(name)) change(field)([...lines(fields[field]), name].join('\n')); backToSources(); }} />
      <details><summary>步骤依据 · {[...new Set(citations.map(item => item.title))].join('、')}</summary>{editor.stages.map(stage => <section key={stage.id}><h4>{stage.title}</h4>
        <ul>{citations.filter(ref => ref.stageId === stage.id).map(({ title, quote, line, version }, index) => <li key={index}>{title}{version === undefined ? '' : `（版本 ${version}）`} 第 {line} 行：「{quote}」</li>)}</ul>
      </section>)}</details>
      <div className="loom-actions"><button type="button" onClick={backToSources}>调整来源</button><button type="button" className="loom-primary" disabled={!summaryIssue && editor.stages.some(stage => !reviewFor(stage).decision)} onClick={() => setStep('edit')}>编辑草稿</button></div>
    </InlinePage>;
  }
  if (step === 'choose') return <InlinePage key="choose" title="新建工作流" onBack={onClose}>
    <p>已有手册或项目技能？先生成可核对的步骤，再保存为每批可复用的模板。</p>
    <div className="loom-actions"><button type="button" className="loom-primary" onClick={() => setStep('sources')}>从手册创建</button><button type="button" onClick={() => setStep('blank')}>手动添加步骤</button></div>
  </InlinePage>;
  return <InlinePage key="sources" title="从手册创建 · 选择来源" onBack={() => setStep('choose')} busy={busy}>
    <form onSubmit={generate}>
      <Field label="所属项目"><WorkspacePicker workspaces={projects} value={workspace} onChange={switchProject} disabled={busy} /></Field>
      <Field label="要做哪些工作" hint="按顺序写，每行一项（最多 24 项）。例如：先写「整理材料」，下一行写「核对清单」。"><textarea aria-label="要做哪些工作" rows={3} required maxLength={4000} value={fields.workList} onChange={event => change('workList')(event.target.value)} disabled={busy} /></Field>
      <Field label="选择 Markdown 文件" hint="可多选 .md 或 .markdown 文件。手册正文和参考工作说明合计最多 48 KiB。"><input aria-label="选择 Markdown 文件" type="file" multiple accept=".md,.markdown" onChange={pickFiles} disabled={busy || !workspace} /></Field>
      {fields.files.length > 0 && <ol className="loom-check-list" aria-label="已选手册">{fields.files.map(file => <li key={file.name}><button type="button" disabled={busy} onClick={() => change('files')(fields.files.filter(item => item !== file))}>移除 {file.name}</button></li>)}</ol>}
      <details open={result?.state === 'blocked' || undefined}><summary>填写项目内路径或粘贴手册</summary>
        <Field label="项目内手册路径" hint="每行一个相对路径，例如 docs/操作手册.md；可指定项目内的 SKILL.md。"><textarea aria-label="项目内手册路径" rows={2} value={fields.paths} onChange={event => change('paths')(event.target.value)} disabled={busy} /></Field>
        <Field label="粘贴 Markdown 手册"><textarea aria-label="粘贴 Markdown 手册" rows={4} value={fields.markdown} onChange={event => change('markdown')(event.target.value)} disabled={busy} /></Field>
      </details>
      {workspace && <ReferenceWorks key={workspace} api={api} workspaceId={workspace} value={fields.works} onChange={change('works')} disabled={busy} />}
      <details open={result?.state === 'blocked' || undefined}><summary>核对项目文件（可选）</summary>
        <Field label="待核对的文件路径" hint="每行一个相对路径。检查文件是否存在，运行条件在首次使用时核对。"><textarea aria-label="待核对的文件路径" rows={2} value={fields.verifyPaths} onChange={event => change('verifyPaths')(event.target.value)} disabled={busy} /></Field></details>
      {result?.state === 'blocked' && <><p role="alert" className="loom-warning">请补齐缺失的文件，或更正路径后再生成。也可以粘贴手册正文。</p><Resources resources={result.resources} /></>}
      {result?.state === 'clarify' && <section role="status"><h3>生成前需要确认</h3><ul>{result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></section>}
      <Field label="补充说明（可选）"><textarea aria-label="补充说明" rows={2} maxLength={4000} value={fields.clarification} onChange={event => change('clarification')(event.target.value)} disabled={busy} /></Field>
      {error && (['WORKSPACE_MISMATCH', 'CONFLICT', 'NOT_FOUND'].includes(error.code) || error.code?.startsWith('MANUAL_') ? <p role="alert" className="loom-warning">{error.message}</p> : <ErrorNotice error={error} />)}
      {error && ['CONFLICT', 'WORKSPACE_MISMATCH'].includes(error.code) && <button type="button" onClick={() => { change('works')([]); setError(null); }}>清除参考选择并重新选择</button>}
      <p className="loom-hint">生成时，工作清单、手册正文、参考工作说明和补充说明会发送给配置的协调模型。请确认这些内容可用于本次生成。</p>
      <footer><button className="loom-primary" disabled={busy || !canGenerate}>{busy ? '请稍候…' : '生成工作流草稿'}</button></footer>
    </form>
  </InlinePage>;
}
