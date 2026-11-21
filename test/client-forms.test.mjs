import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { LoomStore } from '../src/core/store.mjs';

const requireReact = createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS, 'package.json') : import.meta.url);

const React = requireReact('react'), { create, act } = requireReact('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'], write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(requireReact, module, module.exports);
  return module.exports;
}

const forms = await load('src/client/forms.jsx'), components = await load('src/client/components.jsx');

const model = { provider: 'provider-uuid', model: 'model-uuid' };

const catalog = { groups: [{ id: model.provider, name: '研发服务', models: [{ id: model.model, name: '轻量模型' }] }] };

const workspaces = [{ workspaceId: 'workspace-uuid', title: '产品研发', path: 'D:/private/workspace' }];

function text(node) { if (typeof node === 'string') return node; if (!node) return ''; return (Array.isArray(node) ? node : node.children ?? []).map(text).join(''); }

async function mount(t, Component, props) {
  const previousDocument = globalThis.document, previousElement = globalThis.HTMLElement;
  let shown = 0, focused = 0;
  class FocusTarget { isConnected = true; focus() { focused++; } }
  globalThis.HTMLElement = FocusTarget;
  globalThis.document = { activeElement: new FocusTarget() };
  let renderer;
  await act(async () => { renderer = create(React.createElement(Component, props), { createNodeMock: element => element.type === 'dialog' ? { showModal() { shown++; } } : null }); });
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.document = previousDocument; globalThis.HTMLElement = previousElement; });
  return { renderer, shown: () => shown, focused: () => focused,
    label: label => renderer.root.findByProps({ 'aria-label': label }),
    button: label => renderer.root.findAllByType('button').find(node => text(node) === label),
    change: async (label, value) => act(async () => renderer.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } })),
    submit: async () => act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })),
  };
}

function database(t) {
  const store = new LoomStore(':memory:');
  store.syncWorkspaces(workspaces);
  t.after(() => store.close());
  return store;
}

test('reusing a template preserves scalar types and identifies the missing input field before save', async t => {
  const store = database(t), user = { kind: 'user' };
  const workflow = store.command({ type: 'workflow.create', workspaceId: 'workspace-uuid', title: '筛选资料',
    parameters: [{ name: 'data', description: '数据清单' }, { name: 'enabled', default: true }, { name: 'count', default: 3 }],
    stages: [{ id: 'review', title: '核对资料', inputs: { batch: { kind: 'parameter', path: ['data', 'batch'] }, enabled: { kind: 'parameter', path: ['enabled'] }, count: { kind: 'parameter', path: ['count'] } } }] }, user);
  let saved;
  const view = await mount(t, forms.UseWorkflow, { workflow, defaultModel: model, catalog, workspaces, onClose() {},
    execute: command => store.command(command, user), api: { rpc: async () => ({ defaultOptions: [] }), readUse: async id => store.getUse(id) }, onProposed: proposal => { saved = proposal; } });
  const data = '本次输入 data';
  await view.change(data, '{"other":"甲"}');
  await view.change('本次输入 enabled', 'false');
  await view.change('本次输入 count', '0');
  await view.submit();
  assert.match(text(view.renderer.root.findByProps({ role: 'alert' })), /数据清单.*batch/);
  assert.equal(store.query({ kind: 'use' }).total, 0);
  await view.change(data, '{"batch":"甲"}');
  await view.submit();
  assert.deepEqual(saved.parameters, { data: { batch: '甲' }, enabled: false, count: 0 });
});

test('consent shows named targets and exact arguments, then authorizes current SQLite revisions', async t => {
  const store = database(t);
  const args = ['', ' spaced ', 'line\nbreak', '"quoted"', '\\folder'];
  const work = store.command({ type: 'work.create', workspaceId: 'workspace-uuid', title: '检查交付', model, checks: [{ kind: 'command', command: 'node', args }] }, { kind: 'user' });
  let approved = 0;
  const commands = [];
  const props = { work, catalog, workspaces, onClose() {}, onApproved() { approved++; }, api: {
    rpc: async (method, command) => { assert.equal(method, 'command'); commands.push(command); return store.command(command, { kind: 'user' }); },
    readWork: async id => store.query({ kind: 'work', id }).items[0],
  } };
  const view = await mount(t, forms.ConsentDialog, props);
  assert.equal(view.renderer.root.findAllByProps({ className: 'loom-json' }).length, 0);
  assert.match(text(view.renderer.toJSON()), /研发服务 \/ 轻量模型/);
  assert.match(text(view.renderer.toJSON()), /产品研发/);
  assert.doesNotMatch(text(view.renderer.toJSON()), /uuid|D:\/private|修订/);
  const codes = view.renderer.root.findAllByType('code').map(text);
  assert.ok(codes.includes('node'));
  for (const arg of args) assert.ok(codes.includes(JSON.stringify(arg)), `exact parameter ${JSON.stringify(arg)}`);
  await view.submit();
  const saved = await props.api.readWork(work.id);
  assert.equal(saved.modelConsent.modelRevision, work.modelRevision);
  assert.equal(saved.checksConsent.checksRevision, work.checksRevision);
  assert.equal(saved.modelConsent.actor.kind, 'user');
  assert.equal(approved, 1);
  assert.deepEqual(commands.map(command => command.type), ['work.confirm']);
  assert.equal(saved.authorization.actor.kind, 'user');
});
