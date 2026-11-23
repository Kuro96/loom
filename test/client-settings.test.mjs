import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { LoomStore } from '../src/core/store.mjs';

const requireReact = createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS, 'package.json') : import.meta.url);

const React = requireReact('react'), { create, act } = requireReact('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const bundle = await build({ entryPoints: ['src/client/panels.jsx'], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'], write: false });

const module = { exports: {} };

new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(requireReact, module, module.exports);

const { SettingsPanel, DebugPanel } = module.exports;

const base = { provider: 'loom-test-provider', model: 'fixture-flash', reasoningEffort: 'high' };

const next = { provider: 'loom-test-provider', model: 'next' };

const models = { default: base, groups: [{ id: 'loom-test-provider', name: 'Fixture Provider', models: [{ id: base.model, name: 'Fixture Flash', reasoning: { efforts: [{ id: 'high', name: '高' }] } }, { id: 'next', name: 'Next' }] }] };

const roles = Object.fromEntries(['bus', 'review', 'worker', 'acceptance'].map(role => [role, base]));

async function mount(t, roleModels = roles) {
  const store = new LoomStore(':memory:');
  store.command({ type: 'settings.update', roleModels, permissionPreset: 'danger-full-access', context: { debug: true, reviewEverySteps: 6, reviewMaxTokens: 8192, segmentMaxEvents: 1200, checkpointMaxBytes: 10000 } }, { kind: 'user' });
  const commands = [];
  const props = { settings: store.getSettings(), catalog: models, reloadModels() {}, catalogError: null,
    execute: async input => { commands.push(input); return store.command(input, { kind: 'user' }); },
    api: { rpc: async method => {
      if (method === 'snapshot') return { settings: store.getSettings() };
      if (method === 'permissions') return { defaultOptions: [{ value: 'danger-full-access', name: 'Full access' }, { value: 'workspace-write', name: 'Workspace write' }] };
      throw Error(method);
    } } };
  let renderer;
  await act(async () => { renderer = create(React.createElement(SettingsPanel, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); store.close(); });
  const form = () => renderer.root.findByProps({ 'aria-label': 'Loom 设置' });
  const select = label => renderer.root.findByProps({ 'aria-label': label });
  const change = async (label, value) => act(async () => select(label).props.onChange({ target: { value } }));
  const save = async () => act(async () => form().props.onSubmit({ preventDefault() {} }));
  return { renderer, store, props, commands, select, change, save };
}

test('automatic execution after bus publication defaults on and saves through settings', async t => {
  const view = await mount(t), label = '总控发布后自动执行';
  assert.equal(view.store.getSettings().busAutoStart, true);
  assert.equal(view.select(label).props.checked, true);
  await act(async () => view.select(label).props.onChange({ target: { checked: false } }));
  await view.save();
  assert.equal(view.commands.at(-1).busAutoStart, false);
  assert.equal(view.store.getSettings().busAutoStart, false);
  assert.equal(view.select(label).props.checked, false);
});

test('default model change preserves distinct roles and their visible override summary', async t => {
  const worker = { provider: 'other', model: 'worker', reasoningEffort: 'low' };
  const view = await mount(t, { ...roles, worker });
  assert.match(view.renderer.root.findByProps({ 'aria-label': '分角色模型' }).findAllByType('summary')[0].children.join(''), /已单独配置：工作执行/);
  await view.change('默认模型', JSON.stringify([next.provider, next.model]));
  await view.save();
  assert.deepEqual(view.store.getSettings().roleModels.worker, worker);
  assert.equal(view.select('工作执行').props.value, JSON.stringify(['other', 'worker']));
  assert.equal(Object.hasOwn(view.commands.at(-1).roleModels, 'worker'), false);
});

test('model conflict rereads persisted roles and allows retry with the current version', async t => {
  const view = await mount(t);
  view.store.command({ type: 'settings.update', roleModels: { bus: next } }, { kind: 'user' });
  await view.change('默认模型', JSON.stringify(['other', 'stale']));
  await view.save();
  assert.match(JSON.stringify(view.renderer.toJSON()), /CONFLICT/);
  assert.equal(view.select('默认模型').props.value, JSON.stringify([next.provider, next.model]));
  await view.save();
  assert.equal(view.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('reasoning effort is available beside its model and follows model capabilities', async t => {
  const view = await mount(t);
  const picker = view.renderer.root.findAllByProps({ className: 'loom-model-picker' })[0];
  assert.deepEqual(picker.findAllByType('select').map(node => node.props['aria-label']), ['默认模型', '默认模型推理强度']);
  assert.equal(picker.findAllByType('details').length, 0);
  assert.equal(view.select('默认模型推理强度').props.value, 'high');
  await view.change('默认模型推理强度', '');
  await view.save();
  assert.equal(view.store.getSettings().roleModels.bus.reasoningEffort, undefined);
  await view.change('默认模型推理强度', 'high');
  await view.save();
  assert.equal(view.store.getSettings().roleModels.bus.reasoningEffort, 'high');
  await view.change('默认模型', JSON.stringify([next.provider, next.model]));
  assert.equal(picker.findAllByType('select').length, 1);
  await view.save();
  assert.deepEqual(view.store.getSettings().roleModels.bus, next);
});

test('one save applies model permission and debug as one verified command', async t => {
  const view = await mount(t), before = view.store.getSettings();
  await view.change('默认模型', JSON.stringify([next.provider, next.model]));
  await view.change('执行权限', 'workspace-write');
  await act(async () => view.select('调试记录').props.onChange({ target: { checked: false } }));
  assert.equal(view.commands.length, 0);
  await view.save();
  assert.equal(view.commands.length, 1);
  assert.equal(view.store.getSettings().permissionPreset, 'workspace-write');
  assert.deepEqual(view.store.getSettings().context, { ...before.context, debug: false });
  assert.equal(view.store.getSettings().roleModels.worker.model, next.model);
});
