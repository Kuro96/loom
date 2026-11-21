import { modelLabel } from './state.mjs';
import { parameterFor, readerField, splitRequirements } from './reader-fields.mjs';

export const permissionLabel = value => ({ 'danger-full-access': '完全权限', 'workspace-write': '项目读写', 'read-only': '只读' }[value] ?? (value === null ? '沿用原生权限' : '权限名称暂不可用'));
export const inputLabel = name => readerField(name).label;
export function handoffLabel(definition, ref) {
  const source = definition.stages.find(stage => stage.id === ref.stageId);
  const output = source.outputs.find(item => item.name === ref.output);
  return `自动接收「${source.title}」的${output.description || output.name}${ref.path.length ? `（${ref.path.join('.')}）` : ''}`;
}
export function ValueDisplay({ value }) {
  if (value === null) return <span>空值</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (value === '') return <span className="loom-hint">空文本</span>;
  if (typeof value !== 'object') return <span className="loom-value">{String(value)}</span>;
  return <details><summary>{Array.isArray(value) ? `${value.length} 项` : `${Object.keys(value).length} 个字段`}</summary><dl className="loom-summary">{Object.entries(value).map(([name, item]) => <div className="loom-value-row" key={name}><dt>{name}</dt><dd><ValueDisplay value={item} /></dd></div>)}</dl></details>;
}

export function CheckSummary({ checks }) {
  return checks.length > 0 && <ul className="loom-check-list">{checks.map((check, index) => <li key={index}>{check.kind === 'file' ? <>完成条件：存在文件 <code>{check.path}</code>{check.contains !== undefined && <>，内容包含「{check.contains}」</>}</> : <>确认后允许运行：<code>{check.command}</code>{check.args.map((arg, i) => <span key={i}> <code>{JSON.stringify(arg)}</code></span>)}</>}</li>)}</ul>;
}
function StageValue({ definition, parameters, refValue: ref }) {
  if (ref.kind === 'output') return handoffLabel(definition, ref);
  if (ref.kind === 'value') return <ValueDisplay value={ref.value} />;
  const param = parameterFor(definition, ref);
  const value = ref.path.slice(1).reduce((v, key) => v?.[key], parameters ? parameters[ref.path[0]] : param?.default);
  return value === undefined ? (parameters ? '未填写' : '使用时填写') : <>{!parameters && '默认：'}<ValueDisplay value={value} /></>;
}
export function DefinitionSummary({ definition, parameters = null }) {
  const confirming = parameters !== null, bound = new Set(), notes = [];
  const stages = definition.stages;
  const sharedScope = confirming && stages[0]?.scope && stages.every(stage => stage.scope === stages[0].scope) ? stages[0].scope : null;
  const shared = confirming ? (definition.parameters ?? []).filter(param => stages.filter(stage => Object.values(stage.inputs).some(ref => ref.kind === 'parameter' && ref.path[0] === param.name)).length > 1) : [];
  const sharedNames = new Set(shared.map(param => param.name));
  const rows = stages.map(stage => {
    const primary = [], secondary = [];
    for (const [name, ref] of Object.entries(stage.inputs ?? {})) {
      const param = parameterFor(definition, ref), field = readerField(name, ref, param);
      if (param) bound.add(param.name);
      const fromShared = param && sharedNames.has(param.name);
      (field.secondary ? secondary : primary).push(<div key={name} className="loom-value-row"><dt>{field.label}{ref.kind === 'parameter' && ref.path.length > 1 && ` · ${ref.path.slice(1).join('.')}`}</dt><dd>{fromShared ? `沿用共用输入「${readerField(param.name, null, param).label}」` : <StageValue definition={definition} parameters={parameters} refValue={ref} />}</dd></div>);
    }
    const checks = stage.checks ?? [], requires = splitRequirements(stage.instructions).requirements;
    const prerequisites = stage.dependsOn?.length > 0 && <p>前置工作：{stage.dependsOn.map(id => stages.find(s => s.id === id)?.title ?? '来源工作').join('、')}</p>;
    if (secondary.length || !confirming && (requires || prerequisites || stage.scope || checks.length)) notes.push(<section key={stage.id}><h4>{stage.title}</h4>
      {!confirming && requires && <p className="loom-description">{requires}</p>}{secondary.length > 0 && <dl className="loom-summary">{secondary}</dl>}
      {!confirming && <>{prerequisites}{stage.scope && <p>操作范围：{stage.scope}</p>}<CheckSummary checks={checks} /></>}
    </section>);
    return <li key={stage.id}><strong>{stage.title}</strong>{stage.manualGate && <span className="loom-hint"> · 需要放行</span>}
      {confirming && requires && <p className="loom-description">{requires}</p>}
      {primary.length > 0 && <dl className="loom-summary">{primary}</dl>}
      {confirming && <>{stage.outputs.length > 0 ? <p>产出：{stage.outputs.map(output => (output.description || output.name) + (output.required ? '（必需）' : '')).join('、')}</p> : !checks.length && <p className="loom-hint">本项未单列产出或检查条件。</p>}
        {prerequisites}{stage.scope && !sharedScope && <p>操作范围：{stage.scope}</p>}<CheckSummary checks={checks} /></>}
    </li>;
  });
  const unused = (definition.parameters ?? []).filter(p => !bound.has(p.name));
  return <section aria-label={confirming ? '本次输入清单' : '工作流步骤'}>
    {shared.length > 0 && <section><h4>共用输入</h4><dl className="loom-summary">{shared.map(param => <div className="loom-value-row" key={param.name}><dt>{readerField(param.name, null, param).label}</dt><dd><ValueDisplay value={parameters[param.name]} /></dd></div>)}</dl></section>}
    {sharedScope && <p>共用操作范围：{sharedScope}</p>}
    <ol className="loom-decision-steps">{rows}</ol>
    {(notes.length > 0 || unused.length > 0 || definition.knowledge) && <details><summary>查看执行细节</summary>{notes}
      {unused.length > 0 && <section><h4>未关联步骤的参数</h4>{unused.map(p => <p key={p.name}>{readerField(p.name, null, p).label}：<ValueDisplay value={parameters ? (Object.hasOwn(parameters, p.name) ? parameters[p.name] : '未填写') : (Object.hasOwn(p, 'default') ? p.default : '使用时填写')} /></p>)}</section>}
      {definition.knowledge && <p className="loom-description">{definition.knowledge}</p>}</details>}
  </section>;
}
export function ExecutionSummary({ execution, catalog, showAcceptance = true }) {
  return <dl className="loom-summary"><dt>执行模型</dt><dd>{modelLabel(execution.model, catalog)}</dd><dt>执行权限</dt><dd>{permissionLabel(execution.permissionPreset)}{execution.permissionPreset === 'danger-full-access' && '（文件和命令不受项目范围限制）'}</dd>{showAcceptance && <><dt>验收方式</dt><dd>{execution.autoAccept ? '检查和预验收通过后自动验收' : '逐项确认验收'}</dd></>}</dl>;
}
