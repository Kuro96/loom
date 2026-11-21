import { useState } from 'react';
import { Field } from './components.jsx';
import { handoffLabel, inputLabel } from './workflow-summary.jsx';
import { readerField } from './reader-fields.mjs';
import { readPath } from '../core/schema.mjs';

function draftFor(value = '') {
  const type = { string: 'text', number: 'number', boolean: 'boolean' }[typeof value] ?? 'json';
  return { type, text: type === 'json' ? JSON.stringify(value, null, 2) : String(value) };
}
function readDraft(draft, label) {
  if (draft.type === 'text') return draft.text;
  if (draft.type === 'boolean') return draft.text === 'true';
  if (draft.type === 'number') {
    if (draft.text.trim() && Number.isFinite(Number(draft.text))) return Number(draft.text);
    throw new InputError(`「${label}」需要填写数字。`);
  }
  try { return JSON.parse(draft.text); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new InputError(`请检查「${label}」的数据格式。`); }
}
export class InputError extends Error {}

export function parameterDrafts(definition, supplied = {}) {
  return Object.fromEntries(definition.parameters.filter(p => Object.hasOwn(supplied, p.name) || Object.hasOwn(p, 'default')).map(p => [p.name, draftFor(Object.hasOwn(supplied, p.name) ? supplied[p.name] : p.default)]));
}
export function parameterValues(definition, drafts) {
  const entries = [];
  for (const p of definition.parameters) {
    const label = p.description || p.name;
    if (!Object.hasOwn(drafts, p.name)) {
      if (p.required && !Object.hasOwn(p, 'default')) throw new InputError(`请填写「${label}」。`);
    } else entries.push([p.name, readDraft(drafts[p.name], label)]);
  }
  const values = Object.fromEntries(entries);
  for (const stage of definition.stages) for (const ref of Object.values(stage.inputs)) {
    if (ref.kind !== 'parameter') continue;
    const [name, ...path] = ref.path, p = definition.parameters.find(item => item.name === name);
    if (!p) throw new InputError(`请为「${stage.title}」选择有效的输入参数。`);
    const value = Object.hasOwn(values, name) ? values[name] : p.default;
    if (value === undefined || !readPath(value, path).found) throw new InputError(path.length ? `「${p.description || name}」需要字段 ${path.join('.')}（${stage.title}）。` : `请填写「${p.description || name}」（${stage.title}）。`);
  }
  return values;
}
function ValueField({ label, ariaLabel, value, onChange, formats, hint }) {
  const change = text => onChange({ ...value, text });
  return <div className="loom-run-field"><Field label={label} hint={hint}>
    {value.type === 'boolean' ? <select aria-label={ariaLabel} value={value.text} onChange={e => change(e.target.value)}><option value="true">是</option><option value="false">否</option></select>
      : value.type === 'number' ? <input aria-label={ariaLabel} type="number" step="any" value={value.text} onChange={e => change(e.target.value)} />
      : <textarea aria-label={ariaLabel} rows={value.type === 'json' ? 4 : 2} value={value.text} onChange={e => change(e.target.value)} />}</Field>
    {formats && <Field label="数据格式"><select aria-label={`${ariaLabel}格式`} value={value.type} onChange={e => onChange({ type: e.target.value, text: e.target.value === 'boolean' ? String(value.text === 'true') : value.text })}>
      <option value="text">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option><option value="json">结构化数据（JSON）</option></select></Field>}
  </div>;
}

function stageFields(stage) {
  const refs = Object.entries(stage.inputs);
  const fields = refs.filter(([, ref]) => ref.kind === 'value').map(([name, ref]) => ({ name, value: ref.value }));
  if (refs.every(([, ref]) => ref.kind === 'output') && !Object.hasOwn(stage.inputs, 'materials')) fields.push({ name: 'materials', placeholder: true });
  return fields;
}
export function stageInputValues(definition, changes) {
  return definition.stages.flatMap(stage => stageFields(stage).flatMap(field => {
    const draft = changes[JSON.stringify([stage.id, field.name])];
    if (!draft || (field.placeholder && draft.type === 'text' && !draft.text.trim())) return [];
    const value = readDraft(draft, `${stage.title} · ${inputLabel(field.name)}`);
    return !field.placeholder && JSON.stringify(value) === JSON.stringify(field.value) ? [] : [{ stageId: stage.id, name: field.name, value }];
  }));
}

export function UseInputFields({ definition, values, onChange, changes, onStageChange }) {
  const [formats, setFormats] = useState(false), [initial] = useState(values);
  const paths = new Map(), aliases = new Map();
  for (const stage of definition.stages) for (const [input, ref] of Object.entries(stage.inputs)) {
    if (ref.kind !== 'parameter' || !ref.path.length) continue;
    const [name, ...path] = ref.path;
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name).add(input);
    if (!paths.has(name)) paths.set(name, new Set());
    if (path.length) paths.get(name).add(path.join('.'));
  }
  const primary = [], secondary = [];
  for (const p of definition.parameters) {
      const fields = paths.get(p.name), structured = Boolean(fields?.size);
      const names = [...(aliases.get(p.name) ?? [p.name])], display = names.map(name => readerField(name, null, p));
      const label = names.length === 1 ? display[0].label : readerField(p.name, null, p).label;
      const missing = (p.required || fields) && !Object.hasOwn(initial, p.name);
      const group = !missing && (display.every(field => field.secondary) || !fields && !p.required) ? secondary : primary;
      group.push(<ValueField key={`param:${p.name}`} label={`${label}${p.required || fields ? ' *' : '（可选）'}`} ariaLabel={`本次输入 ${p.name}`} hint={structured ? `JSON 字段：${[...fields].join('、')}` : !fields && onStageChange ? '这个参数尚未关联到步骤。' : undefined} value={values[p.name] ?? (structured ? { type: 'json', text: '' } : draftFor())} onChange={draft => onChange({ ...values, [p.name]: draft })} formats={formats} />);
  }
  if (onStageChange) for (const stage of definition.stages) {
    const handoffs = Object.entries(stage.inputs).filter(([, ref]) => ref.kind === 'output');
    const main = [], extra = handoffs.map(([name, ref]) => <p key={name} className="loom-hint">{handoffLabel(definition, ref)}</p>);
    for (const field of stageFields(stage)) {
      const key = JSON.stringify([stage.id, field.name]), { label, secondary: control } = readerField(field.name);
      (control || field.placeholder && handoffs.length ? extra : main).push(<ValueField key={key} label={field.placeholder ? `${label}（可选）` : label} ariaLabel={`${stage.title} · ${label}`} value={changes[key] ?? draftFor(field.value)} onChange={draft => onStageChange({ ...changes, [key]: draft })} formats={formats} />);
    }
    for (const [group, items] of [[primary, main], [secondary, extra]]) if (items.length) group.push(<section key={`stage:${stage.id}`} className="loom-step-input"><h4>{stage.title}</h4>{items}</section>);
  }
  return <section aria-label="填写本次输入"><h3>本次输入</h3>{primary}
    {!primary.length && <p className="loom-hint">没有需要填写的材料。</p>}
    {(primary.length > 0 || secondary.length > 0) && <details><summary>执行参数与格式</summary>{secondary}<button className="loom-format-toggle" type="button" aria-pressed={formats} onClick={() => setFormats(!formats)}>{formats ? '收起数据格式' : '调整数据格式'}</button></details>}
  </section>;
}
