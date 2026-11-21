import { Field } from './components.jsx';
import { parseJSON, parseStages } from './state.mjs';

export function valueDraft(value = '') {
  return { type: typeof value === 'string' ? 'text' : 'json', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}
export function parseValue(draft) { return draft.type === 'text' ? draft.text : parseJSON(draft.text, '输入值'); }
export function ValueEditor({ label, ariaLabel = label, draft, onChange }) {
  return <div className="loom-inline-fields"><Field label={label}><textarea aria-label={ariaLabel} rows={2} value={draft.text} onChange={event => onChange({ ...draft, text: event.target.value })} /></Field>
    <Field label="格式"><select aria-label={`${ariaLabel}格式`} value={draft.type} onChange={event => onChange({ ...draft, type: event.target.value })}><option value="text">文本</option><option value="json">结构化值</option></select></Field></div>;
}
export function definitionFields(value) {
  return { title: value.title, description: value.description ?? '', knowledge: value.knowledge ?? '', parameters: value.parameters ?? [], stages: value.stages.map(stage => ({ instructions: '', scope: '', dependsOn: [], manualGate: false, checks: [], inputs: {}, outputs: [], ...stage })) };
}
export function cleanDefinition(value) {
  const parameters = value.parameters.map(({ _defaultDraft, ...item }) => _defaultDraft ? { ...item, default: parseValue(_defaultDraft) } : item);
  const stages = value.stages.map(stage => ({ ...stage, inputs: Object.fromEntries(Object.entries(stage.inputs ?? {}).map(([name, { _valueDraft, ...ref }]) => [name, _valueDraft ? { ...ref, value: parseValue(_valueDraft) } : ref])) }));
  if (!stages.length) throw new Error('请添加至少一个步骤');
  return { ...value, title: value.title.trim(), parameters, stages: parseStages(JSON.stringify(stages)) };
}
export function definitionFromWorks(works) {
  const ids = new Map(works.map((work, index) => [work.id, `step_${index + 1}`])), parameters = [];
  const stages = works.map((work, index) => ({ id: ids.get(work.id), title: work.title, instructions: work.description, scope: work.scope,
    dependsOn: work.dependsOn.filter(id => ids.has(id)).map(id => ids.get(id)), manualGate: Boolean(work.gate?.required), checks: work.checks, outputs: work.outputs,
    inputs: Object.fromEntries(Object.entries(work.inputs).map(([name, ref]) => {
      if (ref.kind === 'value') return [name, ref];
      if (ids.has(ref.workId)) return [name, { kind: 'output', stageId: ids.get(ref.workId), output: ref.output, path: ref.path }];
      const parameter = `step_${index + 1}_${name}`;
      parameters.push({ name: parameter, description: `${work.title} · ${name}`, required: true });
      return [name, { kind: 'parameter', path: [parameter] }];
    })),
  }));
  return { title: works.length === 1 ? works[0].title : '工作组合', description: '', knowledge: works[0].definitionSnapshot?.knowledge ?? '', parameters, stages };
}
export function DefinitionEditor({ value, onChange, ChecksEditor }) {
  const { stages, parameters } = value;
  const update = patch => onChange({ ...value, ...patch });
  const updateStage = (index, patch) => update({ stages: stages.map((stage, i) => i === index ? { ...stage, ...patch } : stage) });
  function removeStage(id) {
    update({ stages: stages.filter(stage => stage.id !== id).map(stage => ({ ...stage, dependsOn: (stage.dependsOn ?? []).filter(dependency => dependency !== id), inputs: Object.fromEntries(Object.entries(stage.inputs ?? {}).filter(([, ref]) => ref.kind !== 'output' || ref.stageId !== id)) })) });
  }
  const parameter = (index, patch) => update({ parameters: parameters.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return <>
    <Field label="工作流标题 *"><input aria-label="工作流标题" autoFocus required value={value.title} onChange={event => update({ title: event.target.value })} /></Field>
    <Field label="工作流说明"><textarea aria-label="工作流说明" rows={3} value={value.description} onChange={event => update({ description: event.target.value })} /></Field>
    <details><summary>输入参数 · {parameters.length}</summary>
      {parameters.map((item, index) => <section className="loom-stage" key={index}><div className="loom-inline-fields">
        <Field label="名称"><input aria-label={`参数名称 ${index + 1}`} required value={item.name} onChange={event => parameter(index, { name: event.target.value })} /></Field>
        <Field label="说明"><input aria-label={`参数说明 ${index + 1}`} value={item.description} onChange={event => parameter(index, { description: event.target.value })} /></Field></div>
        <label className="loom-checkbox"><input aria-label={`必填参数 ${index + 1}`} type="checkbox" checked={item.required} onChange={event => parameter(index, { required: event.target.checked })} />每次使用时填写</label>
        <label className="loom-checkbox"><input aria-label={`默认值 ${index + 1}`} type="checkbox" checked={Object.hasOwn(item, 'default') || Boolean(item._defaultDraft)} onChange={event => {
          const { default: ignored, _defaultDraft, ...rest } = item;
          update({ parameters: parameters.map((p, i) => i !== index ? p : event.target.checked ? { ...rest, _defaultDraft: valueDraft('') } : rest) });
        }} />设置默认值</label>
        {(Object.hasOwn(item, 'default') || item._defaultDraft) && <ValueEditor label={`参数默认值 ${index + 1}`} draft={item._defaultDraft ?? valueDraft(item.default)} onChange={draft => parameter(index, { _defaultDraft: draft })} />}
        <button type="button" onClick={() => update({ parameters: parameters.filter((_, i) => i !== index) })}>删除输入参数 {index + 1}</button>
      </section>)}
      <button type="button" onClick={() => update({ parameters: [...parameters, { name: '', description: '', required: true }] })}>添加输入参数</button>
    </details>
    <section className="loom-stage-editor"><h3>步骤</h3>
      {!stages.length && <p className="loom-hint">添加要重复执行的工作说明。</p>}
      {stages.map((stage, index) => {
        const number = index + 1, inputs = Object.entries(stage.inputs ?? {}), outputs = stage.outputs ?? [];
        function input(at, name, ref) {
          if (inputs.some(([key], i) => i !== at && key === name)) return;
          updateStage(index, { inputs: Object.fromEntries(inputs.map((entry, i) => i === at ? [name, ref] : entry)) });
        }
        const previous = stages.filter(item => item.id !== stage.id);
        return <section className="loom-stage" key={stage.id}><header><strong>步骤 {number}</strong><button type="button" aria-label={`删除步骤 ${number}`} onClick={() => removeStage(stage.id)}>删除步骤</button></header>
          <Field label="步骤名称"><input aria-label={`步骤名称 ${number}`} required value={stage.title} onChange={event => updateStage(index, { title: event.target.value })} /></Field>
          <Field label="工作说明与完成条件"><textarea aria-label={`步骤说明 ${number}`} rows={3} value={stage.instructions} onChange={event => updateStage(index, { instructions: event.target.value })} /></Field>
          <details><summary>设置范围、依赖与检查</summary><Field label="操作范围"><input aria-label={`操作范围 ${number}`} value={stage.scope ?? ''} onChange={event => updateStage(index, { scope: event.target.value })} /></Field>
          {previous.length > 0 && <fieldset aria-label={`前置步骤 ${number}`}><legend>前置步骤</legend>{previous.map(dependency => <label className="loom-checkbox" key={dependency.id}><input type="checkbox" value={dependency.id} checked={(stage.dependsOn ?? []).includes(dependency.id)} onChange={event => updateStage(index, { dependsOn: event.target.checked ? [...(stage.dependsOn ?? []), dependency.id] : stage.dependsOn.filter(id => id !== dependency.id) })} /><span>{dependency.title || '待命名步骤'}</span></label>)}</fieldset>}
          <label className="loom-checkbox"><input aria-label={`人工关卡 ${number}`} type="checkbox" checked={Boolean(stage.manualGate)} onChange={event => updateStage(index, { manualGate: event.target.checked })} /><span>执行前由我放行</span></label>
          <details><summary>输入与结果交接 · {inputs.length}</summary>{inputs.map(([name, ref], at) => {
            const label = `${number}.${at + 1}`, source = stages.find(item => item.id === ref.stageId);
            return <section className="loom-stage" key={at}><div className="loom-inline-fields"><Field label="输入名称"><input aria-label={`输入名称 ${label}`} required value={name} onChange={event => input(at, event.target.value, ref)} /></Field>
              <Field label="来源"><select aria-label={`输入来源 ${label}`} value={ref.kind} onChange={event => input(at, name, event.target.value === 'value' ? { kind: 'value', value: '' } : event.target.value === 'parameter' ? { kind: 'parameter', path: [] } : { kind: 'output', stageId: '', output: '', path: [] })}><option value="value">固定值</option><option value="parameter">本次输入</option><option value="output">步骤结果</option></select></Field></div>
              {ref.kind === 'value' && <ValueEditor label={`输入值 ${label}`} draft={ref._valueDraft ?? valueDraft(ref.value)} onChange={draft => input(at, name, { ...ref, _valueDraft: draft })} />}
              {ref.kind === 'parameter' && <Field label="输入参数"><select aria-label={`输入参数 ${label}`} value={ref.path[0] ?? ''} onChange={event => input(at, name, { ...ref, path: [event.target.value, ...ref.path.slice(1)] })}><option value="">选择参数</option>{parameters.map((p, i) => <option key={i} value={p.name}>{p.description || p.name}</option>)}</select></Field>}
              {ref.kind === 'output' && <div className="loom-inline-fields"><Field label="来源步骤"><select aria-label={`来源步骤 ${label}`} value={ref.stageId} onChange={event => input(at, name, { ...ref, stageId: event.target.value, output: '' })}><option value="">选择步骤</option>{previous.map(s => <option key={s.id} value={s.id}>{s.title || '待命名步骤'}</option>)}</select></Field>
                <Field label="来源输出"><select aria-label={`来源输出 ${label}`} value={ref.output} onChange={event => input(at, name, { ...ref, output: event.target.value })}><option value="">选择输出</option>{(source?.outputs ?? []).map(o => <option key={o.name} value={o.name}>{o.description || o.name}</option>)}</select></Field></div>}
              {ref.kind !== 'value' && <Field label="字段路径（可选，用点分隔）"><input aria-label={`字段路径 ${label}`} value={(ref.kind === 'parameter' ? ref.path.slice(1) : ref.path).join('.')} onChange={event => input(at, name, { ...ref, path: [...(ref.kind === 'parameter' ? ref.path.slice(0, 1) : []), ...(event.target.value ? event.target.value.split('.') : [])] })} /></Field>}
              <button type="button" onClick={() => updateStage(index, { inputs: Object.fromEntries(inputs.filter((_, i) => i !== at)) })}>删除输入 {label}</button>
            </section>;
          })}<button type="button" onClick={() => {
            let name = 'input'; for (let suffix = 1; Object.hasOwn(stage.inputs ?? {}, name); suffix++) name = `input_${suffix}`;
            updateStage(index, { inputs: { ...stage.inputs, [name]: { kind: 'value', value: '' } } });
          }}>添加输入 {number}</button></details>
          <details><summary>交接字段 · {outputs.length}</summary>{outputs.map((output, at) => {
            const label = `${number}.${at + 1}`, edit = patch => updateStage(index, { outputs: outputs.map((o, i) => i === at ? { ...o, ...patch } : o) });
            return <section className="loom-stage" key={at}><div className="loom-inline-fields"><Field label="名称"><input aria-label={`输出名称 ${label}`} required value={output.name} onChange={event => edit({ name: event.target.value })} /></Field><Field label="说明"><input aria-label={`输出说明 ${label}`} value={output.description} onChange={event => edit({ description: event.target.value })} /></Field></div>
              <label className="loom-checkbox"><input type="checkbox" aria-label={`必需输出 ${label}`} checked={output.required} onChange={event => edit({ required: event.target.checked })} />验收前必须填写</label><button type="button" onClick={() => updateStage(index, { outputs: outputs.filter((_, i) => i !== at) })}>删除输出 {label}</button></section>;
          })}<button type="button" onClick={() => updateStage(index, { outputs: [...outputs, { name: '', description: '', required: true }] })}>添加输出 {number}</button></details>
          <details><summary>完成检查 · {stage.checks.length}</summary><ChecksEditor checks={stage.checks} onChange={checks => updateStage(index, { checks })} /></details></details>
        </section>;
      })}
      <button type="button" onClick={() => update({ stages: [...stages, { id: crypto.randomUUID(), title: '', instructions: '', scope: '', dependsOn: [], manualGate: false, checks: [], inputs: {}, outputs: [] }] })}>添加步骤</button>
    </section>
    <details><summary>工作流知识</summary><Field label="共享方法与约束"><textarea aria-label="工作流知识" rows={4} value={value.knowledge} onChange={event => update({ knowledge: event.target.value })} /></Field></details>
  </>;
}
