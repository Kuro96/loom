import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { LoomStore } from '../src/core/store.mjs';
import { createLoomApi } from '../src/client/api.mjs';
import { draftFromManual } from '../src/host/manual-workflow.mjs';

const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ['src/client/manual-workflow.jsx', 'src/client/forms.jsx'], outdir: 'client-tests', bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'], write: false });
function load(output) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output.text)(require, module, module.exports);
  return module.exports;
}
const { WorkflowCreation } = load(bundle.outputFiles.find(file => file.path.endsWith('manual-workflow.js')));
const { UseWorkflow, ProposalDialog } = load(bundle.outputFiles.find(file => file.path.endsWith('forms.js')));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const user = { kind: 'user' }, model = { provider: 'p', model: 'm' };
const catalog = { groups: [{ id: 'p', name: '测试服务', models: [{ id: 'm', name: '模型' }] }] };
const workspaces = [{ workspaceId: 'project', title: '样本项目', path: process.cwd() }, { workspaceId: 'other', title: '其他项目', path: process.cwd() }];
const manual = '整理本批材料，交付本地清单。';
const workList = '1. 整理材料';
const response = { definition: { title: '批次清单', parameters: [{ name: 'batch', description: '批次编号', required: true }], stages: [{ id: 'list', workIndex: 1, title: '整理材料', instructions: '整理本批材料并交付本地清单。', inputs: { batch: { kind: 'parameter', path: ['batch'] } }, outputs: [{ name: 'manifest', description: '本批清单', required: true }] }] }, citations: [{ stageId: 'list', source: 1, quote: manual }], questions: [], resources: [] };

const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
async function fixture(t, generate) {
  const store = new LoomStore(':memory:'); store.syncWorkspaces(workspaces);
  store.command({ type: 'work.create', workspaceId: 'project', title: '本地示例', description: '本项目的处理记录', model }, user);
  store.command({ type: 'work.create', workspaceId: 'other', title: '其他项目资料', model }, user);
  const api = createLoomApi(async (_path, endpoint, payload) => {
    let value;
    if (endpoint === 'loom/command') value = store.command(payload, user);
    else if (endpoint === 'loom/query') value = store.query(payload);
    else if (endpoint === 'loom/permissions') value = { defaultOptions: [] };
    else if (endpoint === 'loom/manualDraft') value = await draftFromManual({ workspace: { id: 'project', title: '样本项目', path: process.cwd() }, store, request: payload, generate });
    else throw Error(endpoint);
    return { ok: true, value };
  });
  const props = { workspaceId: 'project', workspaces, api, execute: command => api.rpc('command', command), catalog, defaultModel: model, onClose() {} };
  let view;
  async function render(Component, extra = {}) {
    await act(async () => { if (view) view.update(React.createElement(Component, { ...props, ...extra })); else view = create(React.createElement(Component, { ...props, ...extra })); });
  }
  t.after(async () => { await act(async () => view.unmount()); store.close(); });
  const field = label => view.root.findAllByProps({ 'aria-label': label }).find(node => ['input', 'textarea', 'select'].includes(node.type));
  const buttonFor = label => view.root.findAllByType('button').find(node => text(node) === label);
  const click = async label => {
    const button = buttonFor(label);
    assert.ok(Boolean(button && !button.props.disabled), `enabled button: ${label}`);
    await act(async () => button.props.onClick());
  };
  return { store, render, click, field, button: buttonFor, text: () => text(view.root), change: async (label, value) => act(async () => field(label).props.onChange({ target: { value, checked: value } })), submit: async () => act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} })) };
}

test('guided sources lead to an editable save-only template and the same first-batch confirmation', async t => {
  let flow, proposal, confirmed;
  const f = await fixture(t, async ({ sources, workList: goal }) => {
    assert.equal(goal, workList);
    assert.deepEqual(sources.map(source => source.title), ['粘贴的手册', '本地示例']);
    return response;
  });
  await f.render(WorkflowCreation, { onCreated: value => { flow = value; } });
  await f.click('从手册创建');
  await f.change('粘贴 Markdown 手册', manual);
  assert.equal(f.button('生成工作流草稿').props.disabled, true);
  await f.change('要做哪些工作', workList);
  assert.match(f.text(), /本地示例/);
  assert.doesNotMatch(f.text(), /其他项目资料/);
  await f.change('参考工作：本地示例', true);
  await f.submit();
  assert.match(f.text(), /草稿待首次试运行/);
  assert.match(f.text(), /粘贴的手册/);
  assert.match(f.text(), /产出：本批清单（必需）/);
  assert.equal(f.button('编辑草稿').props.disabled, true);
  await f.change('放行方式：整理材料', 'ready');
  assert.equal(f.store.query({ kind: 'workflow' }).total, 0);
  await f.click('编辑草稿');
  await f.change('工作流标题', '已编辑批次清单');
  await f.change('步骤名称 1', '核对本批材料');
  await f.change('步骤说明 1', '按新的样本顺序核对材料。');
  await f.change('参数说明 1', '本批样本编号');
  await f.change('输出说明 1.1', '已编辑清单');
  await f.click('← 返回');
  assert.match(f.text(), /粘贴的手册/);
  assert.match(f.text(), /核对本批材料按新的样本顺序核对材料/);
  assert.match(f.text(), /每批输入本批样本编号/);
  assert.match(f.text(), /产出：已编辑清单（必需）/);
  await f.click('编辑草稿');
  assert.equal(f.field('工作流标题').props.value, '已编辑批次清单');
  assert.equal(f.field('输出说明 1.1').props.value, '已编辑清单');
  await f.submit();
  assert.equal(flow.title, '已编辑批次清单');
  assert.equal(f.store.query({ kind: 'use' }).total, 0);
  assert.equal(f.store.query({ kind: 'work' }).total, 2);
  await f.render(UseWorkflow, { workflow: flow, onProposed: value => { proposal = value; } });
  await f.change('本次输入 batch', 'first-001');
  await f.submit();
  assert.equal(proposal.status, 'proposed');
  assert.equal(f.store.query({ kind: 'work' }).total, 2);
  await f.render(ProposalDialog, { proposal, onConfirmed: value => { confirmed = value; } });
  await f.submit();
  assert.equal(confirmed.works.length, 1);
  assert.equal(f.store.reserveRun(confirmed.works[0].id).inputs.batch, 'first-001');
});

test('an incomplete edited handoff remains editable when reviewing its sources', async t => {
  const f = await fixture(t, async () => response);
  await f.render(WorkflowCreation);
  await f.click('从手册创建');
  await f.change('要做哪些工作', workList);
  await f.change('粘贴 Markdown 手册', manual);
  await f.submit();
  await f.change('放行方式：整理材料', 'ready');
  await f.click('编辑草稿');
  await f.click('添加输入 1');
  await f.change('输入来源 1.2', 'output');
  await f.click('← 返回');
  assert.match(f.text(), /草稿尚需调整.*有效的来源步骤和输出/);
  assert.match(f.text(), /粘贴的手册/);
  await f.click('编辑草稿');
  assert.equal(f.field('输入来源 1.2').props.value, 'output');
  await f.click('删除输入 1.2');
  await f.click('← 返回');
  assert.doesNotMatch(f.text(), /草稿尚需调整/);
  assert.equal(f.field('放行方式：整理材料').props.value, 'ready');
});

test('the review requires an explicit release decision when the cited text requires approval', async t => {
  const quote = '人工审核通过后才能运行。';
  let saved;
  const f = await fixture(t, async () => ({ ...response, citations: [{ stageId: 'list', source: 1, quote }], resources: [{ stageId: 'list', kind: 'external', name: '主管审核服务' }] }));
  await f.render(WorkflowCreation, { onCreated: value => { saved = value; } });
  await f.click('从手册创建');
  await f.change('要做哪些工作', workList);
  await f.change('粘贴 Markdown 手册', `${manual}\n${quote}`);
  await f.submit();
  assert.equal(f.button('编辑草稿').props.disabled, true);
  const choices = f.field('放行方式：整理材料').findAllByType('option').map(node => node.props.value);
  assert.deepEqual(choices, ['', 'release']);
  await f.change('放行方式：整理材料', 'release');
  await f.click('编辑草稿');
  const gate = f.field('人工关卡 1');
  assert.equal(gate.props.checked, true);
  assert.equal(gate.props.disabled, true);
  await f.change('操作范围 1', '仅限本项目');
  await f.change('工作流知识', '按样本编号排序');
  await f.submit();
  assert.match(saved.knowledge, /按样本编号排序[\s\S]*粘贴的手册/);
  const proposal = f.store.command({ type: 'workflow.start', workflowId: saved.id, expectedVersion: saved.version, model, parameters: { batch: 'test-batch' } }, user).use;
  const { works: [work] } = f.store.command({ type: 'use.confirm', useId: proposal.id, expectedVersion: proposal.version }, user);
  assert.match(work.scope, /仅限本项目[\s\S]*粘贴的手册.*人工放行.*主管审核服务（尚未验证）/);
  assert.throws(() => f.store.reserveRun(work.id), { code: 'NOT_READY' });
});

test('an unresolved question preserves the work list and evidence through an answer and Back', async t => {
  const question = '清单应按哪个字段排序？';
  const f = await fixture(t, async ({ clarification, questions, sources, workList: goal }) => {
    assert.equal(sources[0].content, manual);
    assert.equal(goal, workList);
    if (!clarification) return { questions: [question] };
    assert.deepEqual({ questions, clarification }, { questions: [question], clarification: '按样本编号。' });
    return response;
  });
  await f.render(WorkflowCreation);
  await f.click('从手册创建');
  await f.change('要做哪些工作', workList);
  await f.change('粘贴 Markdown 手册', manual);
  await f.submit();
  assert.match(f.text(), /清单应按哪个字段排序/);
  assert.equal(f.field('粘贴 Markdown 手册').props.value, manual);
  await f.change('补充说明', '按样本编号。');
  await f.submit();
  assert.match(f.text(), /草稿待首次试运行/);
  await f.click('← 返回');
  assert.equal(f.field('要做哪些工作').props.value, workList);
  assert.equal(f.field('粘贴 Markdown 手册').props.value, manual);
});

test('changing the manual drops the previous generation question', async t => {
  const question = '清单应按哪个字段排序？';
  const f = await fixture(t, async ({ questions, sources }) => {
    assert.deepEqual(questions, []);
    return sources[0].content === manual ? { questions: [question] } : response;
  });
  await f.render(WorkflowCreation);
  await f.click('从手册创建');
  await f.change('要做哪些工作', workList);
  await f.change('粘贴 Markdown 手册', manual);
  await f.submit();
  assert.match(f.text(), /清单应按哪个字段排序/);
  await f.change('粘贴 Markdown 手册', `# 新手册\n${manual}`);
  assert.doesNotMatch(f.text(), /清单应按哪个字段排序/);
  await f.submit();
  assert.match(f.text(), /草稿待首次试运行/);
});

test('the file chooser keeps named manuals in order and removes only the mistaken selection', async t => {
  const first = new File([`# 手册\n${manual}`], '整理.markdown');
  const remove = new File(['不相关的说明'], '误选.md');
  const last = new File(['按样本编号核对。'], '核对.MD');
  const f = await fixture(t, async ({ sources, selectedPaths }) => {
    assert.deepEqual(sources.map(({ title, content }) => [title, content]), [[first.name, `# 手册\n${manual}`], [last.name, '按样本编号核对。']]);
    assert.deepEqual(selectedPaths, []);
    return { ...response, citations: [...response.citations, { stageId: 'list', source: 2, quote: '按样本编号核对。' }] };
  });
  await f.render(WorkflowCreation);
  await f.click('从手册创建');
  await f.change('要做哪些工作', workList);
  const picker = f.field('选择 Markdown 文件');
  assert.equal(picker?.props.type, 'file');
  assert.equal(picker.props.multiple, true);
  assert.equal(picker.props.accept, '.md,.markdown');
  await act(async () => picker.props.onChange({ currentTarget: { files: [first, remove, last], value: first.name } }));
  assert.match(f.text(), /整理\.markdown.*误选\.md.*核对\.MD/);
  await f.click('移除 误选.md');
  assert.doesNotMatch(f.text(), /误选\.md/);
  assert.equal(f.button('生成工作流草稿').props.disabled, false);
  await f.submit();
  assert.match(f.text(), /整理\.markdown、核对\.MD/);
  await f.click('← 返回');
  assert.match(f.text(), /整理\.markdown.*核对\.MD/);
  await f.change('所属项目', 'other');
  assert.doesNotMatch(f.text(), /整理\.markdown|核对\.MD/);
  assert.equal(f.field('要做哪些工作').props.value, '');
});

test('the file chooser rejects invalid UTF-8 without losing a prior selection', async t => {
  const f = await fixture(t, assert.fail);
  await f.render(WorkflowCreation);
  await f.click('从手册创建');
  const pick = (...files) => act(async () => f.field('选择 Markdown 文件').props.onChange({ currentTarget: { files, value: files[0].name } }));
  await pick(new File([manual], '手册.md'));
  await pick(new File([Uint8Array.of(0xff)], '坏文件.md'));
  assert.match(f.text(), /坏文件\.md.*UTF-8/);
  assert.ok(Boolean(f.button('移除 手册.md')));
  assert.equal(Boolean(f.button('移除 坏文件.md')), false);
});
