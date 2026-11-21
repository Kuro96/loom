import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { LoomStore } from '../src/core/store.mjs';
import { createLoomApi } from '../src/client/api.mjs';

const requireReact = createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS, 'package.json') : import.meta.url);

const React = requireReact('react'), { create, act } = requireReact('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

globalThis.document = { activeElement: null };

globalThis.HTMLElement = class {};

async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'], write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(requireReact, module, module.exports);
  return module.exports;
}

const forms = await load('src/client/forms.jsx'), panels = await load('src/client/panels.jsx');

const model = { provider: 'p', model: 'm' };

const catalog = { groups: [{ id: 'p', name: '研发服务', models: [{ id: 'm', name: '执行模型' }] }] };

const user = { kind: 'user' }, agent = { kind: 'agent' };

const workspaces = [{ workspaceId: 'project', title: '产品研发', path: 'D:/project' }];

const definition = { title: '上传并训练', description: '交付模型', knowledge: '项目方法', parameters: [{ name: 'batch', description: '数据批次', required: true }], stages: [
  { id: 'upload', title: '上传数据', instructions: '上传本次数据', scope: '选定批次', inputs: { batch: { kind: 'parameter', path: ['batch'] } }, outputs: [{ name: 'dataset', description: '数据集', required: true }] },
  { id: 'train', title: '训练模型', instructions: '训练并下载', scope: '选定实验', manualGate: true, inputs: { dataset: { kind: 'output', stageId: 'upload', output: 'dataset', path: ['id'] } }, checks: [{ kind: 'command', command: 'node', args: ['verify.mjs', ' a b ', ''] }] },
] };

function fixture(t) {
  const store = new LoomStore(':memory:'); store.syncWorkspaces(workspaces);
  store.command({ type: 'settings.update', roleModels: { worker: model }, permissionPreset: 'danger-full-access' }, user);
  t.after(() => store.close());
  const calls = [];
  const api = createLoomApi(async (_channel, endpoint, payload) => {
    const method = endpoint.slice('loom/'.length);
    if (method === 'command') { calls.push(payload); return { ok: true, value: store.command(payload, user) }; }
    if (method === 'query') return { ok: true, value: store.query(payload) };
    if (method === 'permissions') return { ok: true, value: { defaultOptions: [{ value: 'danger-full-access', name: '完全权限' }, { value: 'workspace-write', name: '项目读写' }] } };
    throw new Error(method);
  });
  return { store, calls, api, props: { api, workspaceId: 'project', workspaces, catalog, defaultModel: model, defaultPermission: 'danger-full-access', execute: command => api.rpc('command', command), onClose() {}, onCreated() {}, onProposed() {} } };
}

function text(node) { if (typeof node === 'string') return node; if (!node) return ''; return (Array.isArray(node) ? node : node.children ?? []).map(text).join(''); }

// Native details shows just its summary until the reader expands it.
function visibleText(node) {
  if (typeof node === 'string') return node;
  const children = node.type === 'details' && !node.props.open ? node.findAllByType('summary').slice(0, 1) : node.children;
  return children.map(visibleText).join('');
}

async function mount(t, Component, props) {
  let renderer;
  await act(async () => { renderer = create(React.createElement(Component, props), { createNodeMock: element => element.type === 'dialog' ? { showModal() {} } : null }); });
  t.after(async () => act(async () => renderer.unmount()));
  const label = name => renderer.root.findByProps({ 'aria-label': name });
  const button = name => renderer.root.findAllByType('button').find(node => text(node) === name);
  return { renderer, label, button,
    async click(name) { assert.ok(button(name), `button ${name}`); await act(async () => button(name).props.onClick()); },
    async change(name, value) { await act(async () => label(name).props.onChange({ target: { value, checked: value } })); },
    async submit(name, mode) { await act(async () => (name ? label(name) : renderer.root.findByType('form')).props.onSubmit({ preventDefault() {}, nativeEvent: { submitter: { value: mode } } })); },
    async update(props) { await act(async () => renderer.update(React.createElement(Component, props))); },
  };
}

test('structured definition editor saves parameters, named outputs and downstream result references', async t => {
  const f = fixture(t), view = await mount(t, forms.CreateWorkflow, f.props);
  await view.change('工作流标题', '上传并训练');
  await view.click('添加输入参数');
  await view.change('参数名称 1', 'batch');
  await view.change('参数说明 1', '数据批次');
  await view.click('添加步骤');
  await view.change('步骤名称 1', '上传数据');
  await view.change('操作范围 1', '本次数据');
  await view.click('添加输出 1');
  await view.change('输出名称 1.1', 'dataset');
  await view.change('输出说明 1.1', '数据集');
  await view.click('添加输入 1');
  await view.change('输入名称 1.1', 'batch');
  await view.change('输入来源 1.1', 'parameter');
  await view.change('输入参数 1.1', 'batch');
  await view.click('添加步骤');
  await view.change('步骤名称 2', '训练模型');
  await view.click('添加输入 2');
  await view.change('输入名称 2.1', 'dataset');
  await view.change('输入来源 2.1', 'output');
  const stepId = view.label('来源步骤 2.1').findAllByType('option').find(node => text(node) === '上传数据').props.value;
  await view.change('来源步骤 2.1', stepId);
  await view.change('来源输出 2.1', 'dataset');
  await view.change('字段路径 2.1', 'id');
  await view.submit();
  const saved = f.store.query({ kind: 'workflow' }).items[0];
  assert.deepEqual(saved.parameters, [{ name: 'batch', description: '数据批次', required: true }]);
  assert.deepEqual(saved.stages[0].inputs.batch, { kind: 'parameter', path: ['batch'] });
  assert.deepEqual(saved.stages[1].inputs.dataset, { kind: 'output', stageId: stepId, output: 'dataset', path: ['id'] });
  assert.deepEqual(saved.stages[1].dependsOn, [stepId]);
  assert.equal(saved.stages[0].scope, '本次数据');
  assert.equal(f.store.query({ kind: 'work' }).total, 0);
});

function finishWork(f, work, outputs = null) {
  const run = f.store.reserveRun(work.id);
  let reportCallId;
  if (outputs) {
    reportCallId = `result-${run.id}`;
    f.store.reportRun(run.id, { kind: 'result', summary: '交付完成', outputs }, { sessionId: run.sessionId, requestId: run.requestId, turn: 0, callId: reportCallId });
  }
  f.store.finishRun(run.id, { reason: 'completed', summary: '交付完成', eventCursor: 0, ...(reportCallId ? { reportCallId } : {}) });
  const current = f.store.getWork(work.id);
  return f.store.command({ type: 'work.accept', workId: work.id, runId: run.id, expectedVersion: current.version }, user);
}

function workProps(f, work, works = [work]) {
  return { ...f.props, work, works, workflows: [], busy: false, onAction: command => f.props.execute(command), onConsent() {}, onAccept() {}, onCancel() {}, onOpenSession() {}, onNativeSession() {} };
}

test('proposed work previews only its saved step and sends the whole use for confirmation', async t => {
  const f = fixture(t);
  const stages = definition.stages.map((stage, index) => index === 1 ? { ...stage, instructions: '---\r\nrevision: fixture-v1\r\n---\r\n训练并下载', inputs: { ...stage.inputs, source: { kind: 'value', value: 'gui-work-source.txt' }, limit: { kind: 'value', value: 0 }, batch: { kind: 'parameter', path: ['batch'] } }, outputs: [{ name: 'file', description: '模型文件' }] } : stage);
  const proposal = f.store.command({ type: 'use.create', workspaceId: 'project', definition: { ...definition, stages }, parameters: { batch: false }, model }, agent).use;
  let editing = false, reviewing = false;
  const view = await mount(t, panels.ProposedWorkDetail, { proposal, stageId: 'train', busy: false, onEdit: () => { editing = true; }, onReview: () => { reviewing = true; } });
  assert.equal(text(view.renderer.root.findByType('h2')), '训练模型');
  assert.match(text(view.renderer.root.findByType('header')), /待确认/);
  const input = view.label('工作输入');
  assert.match(visibleText(input), /gui-work-source\.txt/);
  assert.match(visibleText(input), /训练并下载/);
  assert.match(visibleText(input), /数据批次否/);
  assert.doesNotMatch(visibleText(input), /revision|fixture-v1|limit|上传数据|---/);
  for (const value of ['limit0', '上传数据', '数据集', 'id']) assert.ok(text(input).includes(value), value);
  assert.doesNotMatch(text(input), /操作范围|选定实验|上传本次数据/);
  await view.click('输出');
  assert.match(text(view.label('工作输出')), /尚未执行/);
  assert.doesNotMatch(text(view.label('工作输出')), /模型文件|预计交付|必需/);
  assert.equal(view.label('工作输出').findAllByType('button').length, 0);
  await view.click('报告');
  assert.match(text(view.label('工作报告')), /待确认|尚未执行/);
  assert.equal(view.label('工作报告').findAllByType('button').length, 0);
  await view.click('修改本次输入');
  assert.equal(editing, true); assert.equal(reviewing, false);
  await view.click('核对本次 2 项工作');
  assert.equal(reviewing, true);
  assert.equal(f.store.query({ kind: 'work' }).total, 0);
  const only = f.store.command({ type: 'use.create', workspaceId: 'project', definition: { ...definition, stages: [stages[0]] }, parameters: { batch: '首批' }, model }, agent).use;
  await view.update({ proposal: only, stageId: 'upload', busy: true });
  assert.match(text(view.label('工作输入')), /首批/);
  assert.equal(view.button('核对本次工作').props.disabled, true);
});

test('upload materials stay visible and execution controls stay folded after confirmation', async t => {
  const f = fixture(t), parameters = { source: 'gui-work-source.txt', sourceSha: 'example-digest', sourceBytes: 17, dropReceipt: true, downloadFailures: 0, processNow: false, batch: '盘点一组' };
  const inputs = Object.fromEntries(Object.keys(parameters).map(name => [name, { kind: 'parameter', path: [name] }]));
  const definition = { title: '仓库盘点', parameters: Object.keys(parameters).map(name => ({ name, description: ({ batch: '数据批次', sourceSha: '文件校验值', dropReceipt: '丢弃服务回执' })[name] || name })),
    stages: [{ id: 'upload', title: '上传文件', instructions: '上传本次盘点清单。', scope: '仅仓库服务', inputs }] };
  const proposal = f.store.command({ type: 'use.create', workspaceId: 'project', definition, parameters, model }, agent).use;
  const preview = await mount(t, panels.ProposedWorkDetail, { proposal, stageId: 'upload' });
  const confirmed = f.store.command({ type: 'use.confirm', useId: proposal.id, expectedVersion: proposal.version }, user);
  const concrete = await mount(t, panels.WorkDetail, { ...workProps(f, confirmed.works[0]), source: confirmed.use });
  for (const view of [preview, concrete]) {
    const input = view.label('工作输入'), primary = visibleText(input);
    assert.match(primary, /gui-work-source\.txt/);
    assert.match(primary, /数据批次盘点一组/);
    assert.match(primary, /上传本次盘点清单/);
    assert.doesNotMatch(primary, /example-digest|文件校验值|sourceBytes|丢弃服务回执|downloadFailures|processNow/);
    const params = input.findByType('details');
    assert.match(text(params), /example-digest/);
    assert.match(text(params), /downloadFailures0/);
    assert.match(text(params), /processNow否/);
    assert.doesNotMatch(text(input), /仅仓库服务/);
  }
});

test('result handoff identifies consumed versions and rework requires the selected downstream impact', async t => {
  const f = fixture(t);
  const stages = [{ id: 'collect', title: '收集数据', outputs: [{ name: 'rows', required: true }] }, ...definition.stages.map(stage => ({ ...stage, manualGate: false, checks: [] }))];
  stages[1].inputs = { rows: { kind: 'output', stageId: 'collect', output: 'rows', path: [] } };
  const source = f.store.command({ type: 'use.create', workspaceId: 'project', definition: { ...definition, stages }, parameters: { batch: '批次甲' }, model }, agent);
  const group = f.store.command({ type: 'use.confirm', useId: source.use.id, expectedVersion: source.use.version }, user);
  const original = finishWork(f, group.works[0], { rows: 12 });
  const upstream = finishWork(f, group.works[1], { dataset: { id: '远端数据集甲' } });
  const downstream = finishWork(f, group.works[2]);
  const run = f.store.getRun(downstream.result.runId);
  assert.equal(run.consumedResults[0].resultVersion, upstream.result.version);
  const consumer = await mount(t, panels.WorkDetail, workProps(f, downstream, [upstream, downstream]));
  await consumer.click('输入');
  assert.match(text(consumer.renderer.toJSON()), /来自上游的输入/);
  assert.match(text(consumer.renderer.toJSON()), /远端数据集甲/);
  assert.match(text(consumer.renderer.toJSON()), new RegExp(`结果版本 ${upstream.result.version}`));
  const view = await mount(t, panels.WorkDetail, workProps(f, upstream, [upstream, downstream]));
  assert.match(text(view.label('工作报告')), /交付完成/);
  await view.click('输出');
  assert.match(text(view.label('工作输出')), /已验收/);
  assert.doesNotMatch(text(view.label('工作输出')), /远端数据集甲|训练模型|已交接给/);
  assert.ok(!view.button('发起返工'));
  f.store.command({ type: 'work.rework', workId: original.id, expectedVersion: original.version, feedback: '更正原始数据', impactToken: f.store.previewRework(original.id).impactToken }, user);
  await view.update(workProps(f, f.store.getWork(upstream.id), [original, upstream, downstream]));
  assert.match(text(view.renderer.toJSON()), /上游结果已变更/);
  assert.equal(view.renderer.root.findAllByType('textarea').length, 0);
  await view.click('发起返工');
  await view.change('反馈', '更正上传结果');
  await view.click('提交返工');
  assert.equal(f.store.getWork(upstream.id).status, 'accepted');
  assert.match(text(view.renderer.toJSON()), /受影响的工作/);
  await view.change(`重跑工作 ${downstream.title}`, true);
  await view.click('确认返工');
  assert.equal(f.store.getWork(upstream.id).status, 'queued');
  assert.equal(f.store.getWork(downstream.id).status, 'queued');
  const command = f.calls.find(call => call.type === 'work.rework');
  assert.deepEqual(command.rerunWorkIds, [downstream.id]);
  assert.equal(typeof command.impactToken, 'string');
  assert.equal(f.store.getRun(run.id).consumedResults[0].value, '远端数据集甲');
});

test('approval and editing show the same materials without requiring the reader to decode a handoff', async t => {
  const f = fixture(t), literal = value => ({ kind: 'value', value });
  const stages = [{ ...definition.stages[0], inputs: { source: literal('清单.txt'), sourceSha: literal('内部校验值'), dropReceipt: literal(false), batch: { kind: 'parameter', path: ['batch'] } } },
    { ...definition.stages[1], inputs: { ...definition.stages[1].inputs, destination: literal('发件/结果.txt') } }];
  const proposal = f.store.command({ type: 'use.create', workspaceId: 'project', definition: { ...definition, stages }, parameters: { batch: '东区' }, model, autoAccept: true, permissionPreset: 'danger-full-access' }, agent).use;
  const review = await mount(t, forms.ProposalDialog, { ...f.props, proposal });
  assert.equal(review.renderer.root.findAllByType('dialog').length, 0);
  const visible = visibleText(review.renderer.root.findByType('form'));
  for (const value of ['来源材料', '清单.txt', '保存位置', '发件/结果.txt', '数据批次', '东区', '确认执行本次 2 项工作', '需要放行', '完全权限', '自动验收', '选定批次', '选定实验', 'node', '" a b "', '""']) assert.ok(visible.includes(value), value);
  assert.deepEqual(review.label('本次输入清单').findAllByType('strong').map(text), stages.map(stage => stage.title));
  assert.match(visible, /产出：数据集.*前置工作：上传数据/s);
  assert.doesNotMatch(visible, /内部校验值|sourceSha|dropReceipt|自动接收|交付：/);
  assert.match(text(review.renderer.toJSON()), /内部校验值/);
  const edit = await mount(t, forms.UseWorkflow, { ...f.props, proposal });
  const editable = visibleText(edit.renderer.root.findByType('form'));
  assert.match(editable, /来源材料/); assert.match(editable, /保存位置/);
  assert.doesNotMatch(editable, /sourceSha|dropReceipt|自动接收/);
});

test('standalone consent distinguishes inputs and permissions from execution internals', async t => {
  const f = fixture(t), work = f.store.command({ type: 'work.create', workspaceId: 'project', title: '校核清单', description: '---\nrevision: dev-only\n---\n核对清单。', scope: '指定目录', model, inputs: { destination: { kind: 'value', value: '结果.txt' }, sourceSha: { kind: 'value', value: '内部校验值' } }, outputs: [{ name: 'remoteRef', description: '远端内部标识' }] }, user);
  const view = await mount(t, forms.ConsentDialog, { ...f.props, work });
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0);
  const visible = visibleText(view.renderer.root.findByType('form'));
  for (const value of ['保存位置', '结果.txt', '核对清单。', '指定目录', '确认执行']) assert.ok(visible.includes(value), value);
  assert.doesNotMatch(visible, /dev-only|sourceSha|远端内部标识|内部校验值/);
});

test('proposal edits preserve its source but require the refreshed definition and input revision', async t => {
  const f = fixture(t), flow = f.store.command({ type: 'workflow.create', workspaceId: 'project', ...definition }, user);
  const initial = f.store.command({ type: 'workflow.start', workflowId: flow.id, expectedVersion: flow.version, parameters: { batch: '旧输入' }, model }, agent).use;
  let proposal;
  const edit = await mount(t, forms.CreateWorkflow, { ...f.props, proposal: initial, onProposed: saved => { proposal = saved; } });
  assert.ok(edit.button('保存本次说明'));
  await edit.change('步骤说明 1', '本次补充上传要求');
  await edit.change('本次输入 batch', '新输入');
  await edit.submit();
  assert.equal(proposal.workflowId, null);
  assert.equal(proposal.sourceWorkflowId, flow.id);
  assert.equal(proposal.parameters.batch, '新输入');
  assert.equal(proposal.definitionSnapshot.stages[0].instructions, '本次补充上传要求');
  assert.equal(f.store.getWorkflow(flow.id).stages[0].instructions, '上传本次数据');
  const stale = await mount(t, forms.ProposalDialog, { ...f.props, proposal: initial, onConfirmed() { assert.fail('stale proposal'); } });
  await stale.submit();
  assert.match(text(stale.renderer.toJSON()), /CONFLICT/);
  assert.equal(f.store.query({ kind: 'work' }).total, 0);
  const current = await mount(t, forms.ProposalDialog, { ...f.props, proposal, onConfirmed() {} });
  await current.submit();
  assert.equal(f.store.query({ kind: 'work' }).items[0].inputs.batch.value, '新输入');
});

test('save-and-execute retries a lost proposal receipt without duplicating either definition or proposal', async t => {
  const f = fixture(t), execute = f.props.execute;
  let lost = true, proposal;
  const view = await mount(t, forms.CreateWorkflow, { ...f.props, initialDefinition: definition, onProposed: saved => { proposal = saved; }, execute: async command => {
    const result = await execute(command);
    if (command.type === 'workflow.start' && lost) { lost = false; throw new Error('connection interrupted after commit'); }
    return result;
  } });
  await view.change('本次输入 batch', '批次一');
  await view.submit(null, 'save-run');
  assert.equal(f.store.query({ kind: 'workflow' }).total, 1);
  assert.equal(f.store.query({ kind: 'use' }).total, 1);
  assert.match(text(view.renderer.toJSON()), /connection interrupted/);
  await view.submit(null, 'save-run');
  assert.equal(f.store.query({ kind: 'workflow' }).total, 1);
  assert.equal(f.store.query({ kind: 'use' }).total, 1);
  assert.equal(proposal.id, f.store.query({ kind: 'use' }).items[0].id);
  assert.equal(view.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('work detail opens the input, delivered output and acceptance report directly', async t => {
  const f = fixture(t);
  const draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '核对库存', description: '核对仓库账目', scope: '华南仓',
    inputs: { batch: { kind: 'value', value: '冬季盘点' } }, outputs: [{ name: 'count', description: '差异件数', required: true }], checks: [{ kind: 'file', path: '核对表.csv' }] }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id);
  const file = { title: '差异明细', path: '盘点/差异明细.csv' };
  f.store.reportRun(run.id, { kind: 'result', summary: '库存已核对', outputs: { count: 0 }, deliverables: [file] }, { sessionId: run.sessionId, requestId: run.requestId, turn: 0, callId: 'inventory' });
  f.store.finishRun(run.id, { reason: 'completed', summary: '', reportCallId: 'inventory', eventCursor: 1,
    checks: [{ check: run.checks[0], passed: true }], review: { passed: true, summary: '账实相符', source: 'acceptance', evidence: { references: ['见盘点明细'] } } });
  const work = f.store.getWork(draft.id), opened = [];
  const view = await mount(t, panels.WorkDetail, { ...workProps(f, work), onOpenFile: (...args) => opened.push(args) });
  await view.click('输入');
  const input = text(view.label('工作输入'));
  for (const value of ['冬季盘点', '核对仓库账目']) assert.ok(input.includes(value), value);
  assert.doesNotMatch(input, /华南仓|操作范围/);
  await view.click('输出');
  assert.match(text(view.label('工作输出')), /待验收/);
  assert.doesNotMatch(visibleText(view.label('工作输出')), /差异件数|暂无工作使用|库存已核对|核对表\.csv/);
  await view.click(file.title);
  assert.deepEqual(opened, [[work, file]]);
  await view.click('报告');
  const report = text(view.label('工作报告'));
  for (const value of ['库存已核对', '检查通过', '账实相符', '见盘点明细', '待验收']) assert.ok(report.includes(value), value);
  assert.doesNotMatch(visibleText(view.label('工作报告')), /检查详情|核对表\.csv/);
  assert.ok(view.button('验收结果'));
  assert.equal(view.renderer.root.findAllByType('textarea').length, 0);
  assert.ok(view.button('发起返工'));
  const accepted = f.store.command({ type: 'work.accept', workId: work.id, runId: run.id, expectedVersion: work.version }, user);
  let saved;
  await view.update({ ...workProps(f, accepted), onSave: item => { saved = item; } });
  assert.match(text(view.label('工作报告')), /已确认验收/);
  assert.ok(!view.button('验收结果'));
  await view.click('保存为工作流');
  assert.equal(saved.id, work.id);
  assert.doesNotMatch(text(view.renderer.toJSON()), /授权与更多操作|允许此工作自动验收|历史与诊断|发起返工|提交返工|调整执行模型|待检查/);
});

test('work detail binds a handoff to its consuming run after upstream rework', async t => {
  const f = fixture(t);
  const start = f.store.command({ type: 'use.create', workspaceId: 'project', definition: { ...definition, stages: definition.stages.map(stage => ({ ...stage, checks: [], manualGate: false })) }, parameters: { batch: '盘点批次' }, model }, agent).use;
  const [first, second] = f.store.command({ type: 'use.confirm', useId: start.id, expectedVersion: start.version }, user).works;
  const old = finishWork(f, first, { dataset: { id: '原数据集' } });
  let consumer = finishWork(f, second);
  const redo = (work, selected = []) => f.store.command({ type: 'work.rework', workId: work.id, expectedVersion: work.version, feedback: '复核', impactToken: f.store.previewRework(work.id).impactToken, rerunWorkIds: selected }, user);
  for (let n = 0; n < 10; n++) consumer = finishWork(f, redo(consumer));
  const latest = finishWork(f, redo(old), { dataset: { id: '新数据集' } });
  const props = () => workProps(f, f.store.getWork(second.id), [latest, f.store.getWork(second.id)]);
  const view = await mount(t, panels.WorkDetail, props());
  await view.click('输入');
  const input = () => text(view.label('工作输入'));
  assert.match(input(), /原数据集/);
  assert.doesNotMatch(visibleText(view.label('工作输入')), /原数据集|结果版本/);
  assert.match(input(), new RegExp(`结果版本 ${old.result.version}`));
  assert.doesNotMatch(input(), /新数据集/);
  redo(f.store.getWork(second.id));
  await view.update(props());
  assert.doesNotMatch(input(), /原数据集|来自上游的输入/, 'a requeued work has no current consumption');
  consumer = finishWork(f, second);
  await view.update(props());
  assert.match(input(), /新数据集/);
  assert.match(input(), new RegExp(`结果版本 ${latest.result.version}`));
  assert.doesNotMatch(input(), /原数据集/);
  assert.doesNotMatch(input(), new RegExp(latest.result.runId));
  assert.equal(f.store.getRun(consumer.result.runId).consumedResults[0].runId, latest.result.runId);
});

test('work detail keeps a standalone text report accessible without named deliverables', async t => {
  const f = fixture(t);
  const draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '核对发票', description: '对照收据逐张核对' }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id);
  f.store.finishRun(run.id, { reason: 'completed', summary: '三张发票均已核对。', eventCursor: 0 });
  const view = await mount(t, panels.WorkDetail, workProps(f, f.store.getWork(draft.id)));
  assert.match(text(view.label('工作报告')), /三张发票均已核对。/);
  assert.equal(view.label('工作报告').findAllByType('button').length, 0);
  await view.click('输入');
  assert.match(text(view.label('工作输入')), /对照收据逐张核对/);
  await view.click('输出');
  assert.match(text(view.label('工作输出')), /待验收/);
  assert.equal(view.label('工作输出').findAllByType('button').length, 0);
  await view.click('报告');
  assert.match(text(view.label('工作报告')), /三张发票均已核对。/);
  const accepted = f.store.command({ type: 'work.accept', workId: draft.id, runId: run.id, expectedVersion: f.store.getWork(draft.id).version }, user);
  const { runId, version, summary, acceptance } = accepted.result;
  // Migrated text results retain their original fields, including absent check results.
  await view.update(workProps(f, { ...accepted, result: { runId, version, summary, acceptance } }));
  assert.match(text(view.label('工作报告')), /三张发票均已核对。.*已确认验收/s);
});

test('the worker report opens the selected run document and retries a reader failure', async t => {
  const f = fixture(t), draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '核对箱单' }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id), document = { english: 'The packing list matches.', chinese: '箱单一致。' };
  f.store.reportRun(run.id, { kind: 'result', summary: '箱单已核对', document, outputs: {} }, { sessionId: run.sessionId, requestId: run.requestId, turn: 1, callId: 'packing-list' });
  f.store.finishRun(run.id, { reason: 'completed', summary: '', reportCallId: 'packing-list', eventCursor: 2 });
  const work = f.store.getWork(draft.id), [doc] = work.documents, opened = [];
  const view = await mount(t, panels.WorkDetail, { ...workProps(f, work), onOpenReport: async (target, meta) => {
    opened.push([target.id, meta]);
    if (opened.length === 1) throw new Error('文档预览连接中断');
    assert.equal(f.store.getDocument(target.id, meta.id).chinese, document.chinese);
  } });
  assert.match(visibleText(view.label('工作报告')), /执行者报告/);
  await view.click(doc.title);
  assert.match(text(view.renderer.root.findByProps({ role: 'alert' })), /文档预览连接中断/);
  await view.click('重试');
  assert.deepEqual(opened, [[work.id, doc], [work.id, doc]]);
  assert.equal(view.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
  await view.click('输出');
  assert.equal(view.label('工作输出').findAllByType('button').length, 0);
});

test('returning from the native reader restores the tab once per mount', async t => {
  const f = fixture(t), draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '核对发票' }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const work = finishWork(f, draft), notified = [], opened = [];
  const props = { ...workProps(f, work), onViewChange: view => { notified.push(view); }, onOpenSession: (...args) => opened.push(args) };
  for (const initialView of ['输入', '输出', '报告']) {
    const view = await mount(t, panels.WorkDetail, { ...props, initialView });
    assert.equal(view.button(initialView).props['aria-pressed'], true);
    assert.equal(notified.at(-1), initialView);
    const next = initialView === '输入' ? '报告' : '输入';
    await view.click(next);
    await view.update({ ...props, initialView: initialView === '输出' ? '报告' : '输出' });
    assert.equal(view.button(next).props['aria-pressed'], true);
    assert.equal(notified.at(-1), next);
    await view.click('查看对话');
    assert.deepEqual(opened.at(-1), [work.sessionId, next]);
  }
});

test('work detail keeps actionable file-check evidence in a failed report', async t => {
  const f = fixture(t), draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '交付发票', checks: [{ kind: 'file', path: '发票.csv' }] }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id);
  const { runChecks } = await import('../src/host/checks.mjs');
  const checks = await runChecks(process.cwd(), run.checks);
  f.store.finishRun(run.id, { reason: 'failed', summary: '交付失败', eventCursor: 1, checks });
  const view = await mount(t, panels.WorkDetail, workProps(f, f.store.getWork(draft.id)));
  assert.match(text(view.label('工作报告')), /检查未通过/);
  assert.match(text(view.label('工作报告')), /验收文件尚未生成/);
  assert.match(text(view.label('工作报告')), /发票\.csv/);
  assert.ok(view.button('发起返工'));
  assert.ok(!view.button('验收结果'));
});

test('work detail shows an unconfirmed stop until the current control is acknowledged', async t => {
  const f = fixture(t), draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '停止校验' }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id);
  f.store.updateRun(run.id, { running: true });
  const props = () => workProps(f, f.store.getWork(draft.id));
  const view = await mount(t, panels.WorkDetail, props());
  await view.click('暂停工作');
  const control = f.store.query({ kind: 'control', workId: draft.id }).items[0];
  await view.update(props());
  assert.match(text(view.renderer.toJSON()), /正在停止执行/);
  f.store.ackControl(control.id, { stopped: false, detail: '后台作业仍在写入' });
  await view.update(props());
  assert.match(text(view.renderer.toJSON()), /后台作业仍在写入/);
  assert.ok(!view.button('继续工作'));
  f.store.ackControl(control.id, { stopped: true });
  await view.update(props());
  assert.ok(view.button('继续工作'));
  assert.doesNotMatch(text(view.renderer.toJSON()), /正在停止执行|后台作业仍在写入/);
});

test('work detail surfaces live approval and the settled remote wait', async t => {
  const f = fixture(t), draft = f.store.command({ type: 'work.create', workspaceId: 'project', title: '等待仓库回执', inputs: { materials: { kind: 'value', value: '仓库清单' } } }, user);
  f.store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, user);
  const run = f.store.reserveRun(draft.id);
  f.store.updateRun(run.id, { running: true });
  const opened = [], props = () => ({ ...workProps(f, f.store.getWork(draft.id)), onOpenReport: (work, doc) => opened.push([work.id, doc.id]) });
  const view = await mount(t, panels.WorkDetail, props());
  assert.match(text(view.label('工作输入')), /本次材料仓库清单/);
  const version = f.store.getWork(draft.id).version;
  f.store.updateRun(run.id, { diagnostic: '等待原生交互：approval' });
  await view.update(props());
  assert.equal(f.store.getWork(draft.id).version, version);
  assert.match(text(view.renderer.toJSON()), /审批确认/);
  const receipt = { sessionId: run.sessionId, requestId: run.requestId, turn: 0, callId: 'receipt' };
  const wait = { operationId: draft.id, remoteRef: '仓单 21', condition: '收到签收记录', nextCheckAt: new Date(Date.now() + 3600_000).toISOString() };
  f.store.reportRun(run.id, { kind: 'wait', summary: '清单已送达仓库', wait, document: { english: 'The warehouse received the list.', chinese: '仓库已收到清单。' } }, receipt);
  f.store.settleReport(run.id, { callId: receipt.callId, eventCursor: 2 });
  await view.update(props());
  await view.click('报告');
  assert.match(text(view.label('工作报告')), /清单已送达仓库/);
  assert.match(text(view.label('工作报告')), /仓单 21.*收到签收记录/s);
  assert.doesNotMatch(text(view.renderer.toJSON()), /审批确认/);
  assert.ok(!view.button('执行记录'));
  const waiting = f.store.getWork(draft.id), [workerDoc] = waiting.documents;
  await view.click(workerDoc.title);
  const bus = { kind: 'agent', sessionId: 'coordinator' };
  f.store.command({ type: 'work.addReport', workId: draft.id, runId: run.id, expectedVersion: waiting.version, title: '签收安排', document: { english: 'Confirm the delivery time.', chinese: '请确认送达时间。' } }, bus, { coordinatorSessionId: bus.sessionId });
  await view.update(props());
  const [, coordinatorDoc] = f.store.getWork(draft.id).documents;
  assert.match(visibleText(view.label('工作报告')), /执行者报告.*协调报告.*签收安排/);
  await view.click(coordinatorDoc.title);
  f.store.wakeWaiting(wait.nextCheckAt);
  const next = f.store.reserveRun(draft.id);
  f.store.finishRun(next.id, { reason: 'completed', summary: '仓单已签收。', eventCursor: 3 });
  await view.update(props());
  const report = view.label('工作报告');
  assert.match(visibleText(report), /仓单已签收。/);
  assert.doesNotMatch(visibleText(report), /执行者报告|签收安排/);
  await view.click('查看以往报告');
  const history = view.label('以往报告');
  const [original, addition] = history.findAllByType('button');
  await act(async () => original.props.onClick());
  await act(async () => addition.props.onClick());
  assert.deepEqual(opened, [workerDoc, coordinatorDoc, workerDoc, coordinatorDoc].map(doc => [draft.id, doc.id]));
});
