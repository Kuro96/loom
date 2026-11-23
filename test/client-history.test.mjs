import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
import { LoomStore } from '../src/core/store.mjs';

const requireReact = createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS, 'package.json') : import.meta.url);

const React = requireReact('react');

const { create, act } = requireReact('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

globalThis.document = { activeElement: null };

globalThis.HTMLElement = class {};

const bundle = await build({ entryPoints: ['src/client/workbench.jsx'], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/*'], write: false });

const module = { exports: {} };

new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(requireReact, module, module.exports);

const { LoomPanel } = module.exports;

async function mount(t, { bus = { sessionId: 'bus-1', segment: 1 }, context = { status: 'idle', workspaceId: 'control' }, statusGate, statusError, works = [], sessionsGate, store, readWorkGate, commandGate, query, onRPC, command = request => store.command(request, { kind: 'user' }), catalog = { groups: [] }, previewNavigation, renderSlot = name => React.createElement('div', { 'data-native-slot': name }, React.createElement('button', null, 'native send')) } = {}) {
  let health = { bus, context, engine: { ready: true, running: false, faulted: false } };
  const opened = [], retained = [], released = [];
  const entries = [{ type: 'event', event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'old intent' }] } } }];
  const window = { entries, hasMore: false };
  const snapshot = { bus, workspaces: [], works: { items: works, total: works.length, nextCursor: null }, settings: { version: 1, roleModels: {}, permissionPreset: null, context: { debug: false } } };
  const page = request => store ? store.query({ kind: 'work', ...request }) : { items: works, total: works.length, nextCursor: null };
  const props = {
    previewNavigation,
    api: { rpc: async (method, request) => {
      onRPC?.(method, request);
      if (method === 'status') { if (statusError) throw statusError; return statusGate ? statusGate.promise : health; }
      if (method === 'snapshot') return { ...snapshot, works: page(request), workflows: store ? store.query({ kind: 'workflow', workspaceId: request.workspaceId, limit: 100 }) : { items: [], total: 0, nextCursor: null }, bus: health.bus, ...(store ? { uses: store.query({ kind: 'use', ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}), limit: 100 }), settings: store.getSettings(), workspaces: store.query({ kind: 'workspace' }).items } : { uses: { items: [], total: 0, nextCursor: null } }) };
      if (method === 'query') return query ? query(request) : store ? store.query(request) : { items: [], total: 0, nextCursor: null };
      if (method === 'models') return catalog;
      if (method === 'command') {
        const result = await command(request);
        return commandGate ? commandGate(request, result) : result;
      }
      if (method === 'checkDeletion') return store.checkDeletion(request);
      if (method === 'permissions') return { defaultOptions: [{ value: 'danger-full-access', name: 'Full access' }] };
      if (method === 'nativeSessions') return sessionsGate ? sessionsGate.promise : [{ sessionId: 'bus-1', workspaceId: 'control' }, { sessionId: 'bus-2', workspaceId: 'control' }, { sessionId: 'worker', workspaceId: 'project' }];
      throw new Error(`Unexpected RPC ${method}`);
    }, readWork: async id => readWorkGate ? readWorkGate(id) : store ? store.getWork(id) : works.find(work => work.id === id),
    readWorkflow: async id => store.getWorkflow(id), readUse: async id => store.getUse(id) },
    retain: id => { retained.push(id); const binding = { eventSource: { getSnapshot: () => window, subscribe: () => () => {} } }; return { binding, ready: Promise.resolve(binding), release: () => released.push(id) }; },
    openMain: (id,origin) => { opened.push(id); if(previewNavigation) previewNavigation.current=origin; },
    SessionProvider: ({ children }) => children,
    renderSlot,
  };
  let renderer;
  const viewport = { scrollTop: 0 };
  await act(async () => { renderer = create(React.createElement(LoomPanel, props), { createNodeMock: element => element.type === 'dialog' ? { showModal() {} } : element.props.className === 'loom-list-scroll' ? viewport : null }); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const button = text => renderer.root.findAllByType('button').find(node => node.props['aria-label'] === text || node.children.join('') === text ||
    node.props['aria-label']?.includes(`：${text} · `));
  return { renderer, opened, retained, released, button, viewport,
    async rotate(next, nextContext = context) { health = { ...health, bus: next, context: nextContext }; await act(async () => button('刷新').props.onClick()); },
    async failStatus(error) { statusError = error; await act(async () => button('刷新').props.onClick()); },

  };
}

test('pending proposal opens the batch review and requires explicit confirmation', async t => {
  const store = database(t), user = { kind: 'user' };
  const { use } = store.command({ type: 'use.create', workspaceId: 'project', model: { provider: 'p', model: 'm' },
    definition: { title: '本批资料', stages: [{ id: 'first', title: '读资料', scope: '选定批次', instructions: '逐一核对本批文件，缺项时停止并报告。', outputs: [{ name: 'manifest', description: '本批清单', required: true }] }, { id: 'second', title: '核对资料', checks: [{ kind: 'command', command: 'checker', args: ['--batch', '08'] }] }] } }, user);
  const view = await mount(t, { store, catalog: { groups: [{ id: 'p', name: '研发', models: [{ id: 'm', name: '执行模型' }] }] } });
  const rows = view.renderer.root.findAllByProps({ 'data-use-id': use.id });
  assert.equal(rows.length, 1);
  assert.match(rows[0].props['aria-label'], /本批资料.*核对执行/);
  await act(async () => rows[0].props.onClick());
  const text = node => typeof node === 'string' ? node : node.children.map(text).join('');
  assert.match(text(view.renderer.root.findByType('form')), /项目：项目 · 2 项工作.*选定批次.*执行模型/);
  const [first, second] = view.renderer.root.findByProps({ 'aria-label': '本次输入清单' }).findByType('ol').children;
  assert.match(text(first), /逐一核对本批文件.*缺项时停止并报告.*本批清单/);
  assert.match(text(second), /checker.*--batch.*08/);
  const edit = view.button('修改本次说明');
  assert.ok(edit && edit.parent.type !== 'details');
  assert.equal(store.query({ kind: 'work' }).total, 0);
  assert.equal(Boolean(view.button('确认执行本次 2 项工作')), true);
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(store.query({ kind: 'work' }).total, 2);
});

test('a pending standalone work can replace an unavailable execution model before approval', async t => {
  const store = database(t), item = createRecord(store, 'work', '核对原图', { model: { provider: 'p', model: 'retired' } });
  const view = await mount(t, { store, catalog: { groups: [{ id:'p', name:'研发', models:[{ id:'current', name:'可用模型' }] }] } });
  await act(async () => view.renderer.root.findByProps({ 'data-work-id': item.id }).props.onClick());
  assert.ok(view.button('调整执行模型'));
  await act(async () => view.button('调整执行模型').props.onClick());
  await act(async () => view.renderer.root.findByProps({ 'aria-label': '执行模型' }).props.onChange({ target:{value:'["p","current"]'} }));
  await act(async () => view.button('保存模型提案').props.onClick());
  const saved = store.getWork(item.id);
  assert.equal(saved.model.model, 'current');
  assert.equal(saved.modelConsent, null);
  await act(async () => view.button('核对本次工作').props.onClick());
  assert.equal(view.button('确认执行').props.disabled, false);
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(store.getWork(item.id).modelConsent.modelRevision, saved.modelRevision);
});

test('management shows which inputs distinguish repeated uses of the same workflow before deleting', async t => {
  const store = database(t), user = {kind:'user'};
  const flow = createRecord(store, 'workflow', '返图整理', {
    parameters:[{name:'batch',description:'图像批次'}], stages:[{id:'take',title:'核对图像', inputs:{batch:{kind:'parameter',path:['batch']}}}]
  });
  const start = batch => store.command({type:'workflow.start',workflowId:flow.id,expectedVersion:flow.version,parameters:{batch}},user).use;
  const north = start('北线第 07 批'), south = start('南线第 07 批');
  const view = await mount(t,{store});
  await act(async () => view.button('管理').props.onClick());
  const choices = view.renderer.root.findAllByType('input').filter(input => input.props['aria-label']?.startsWith('选择 返图整理'));
  assert.equal(choices.length, 2);
  const target = choices.find(choice => choice.props['aria-label'].includes('南线第 07 批'));
  assert.ok(target && choices.some(choice => choice.props['aria-label'].includes('北线第 07 批')));
  await act(async () => target.props.onChange({target:{checked:true}}));
  await act(async () => view.button('删除所选').props.onClick());
  const scope = JSON.stringify(view.renderer.root.findByProps({'aria-label':'确认范围'}).findAllByType('li').map(node => node.children.join('')));
  assert.match(scope,/南线第 07 批/);
  assert.doesNotMatch(scope,/北线第 07 批/);
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(store.getUse(south.id),null);
  assert.equal(store.getUse(north.id).parameters.batch,'北线第 07 批');
});

test('the pending result entry shows saved checks and sends a retry tied to that result', async t => {
  const store = database(t), user = { kind: 'user' }, calls = [];
  const item = createRecord(store, 'work', '核对本批返图', { checks: [{kind:'file',path:'result.md'}], model: { provider: 'p', model: 'm' } });
  store.command({type:'work.confirm',workId:item.id,expectedVersion:item.version},user);
  const run=store.reserveRun(item.id), checks=[{check:run.checks[0],passed:true}];
  const reportCallId='report';
  store.reportRun(run.id,{kind:'result',summary:'返图整理完成',outputs:{},document:{english:'Done',chinese:'已完成'},deliverables:[{title:'本批清单',path:'result.md'}]},
    {callId:reportCallId,requestId:run.requestId,sessionId:run.sessionId,turn:0});
  store.updateRun(run.id,{observation:{completion:{reason:'completed'}}});
  store.finishRun(run.id,{reason:'completed',summary:'返图整理完成',eventCursor:0,checks,reportCallId,review:{passed:false,source:'acceptance-error',summary:'暂不可用',evidence:[]}});
  const view=await mount(t,{store,command:payload=>{
    calls.push(payload);
    const {run}=store.prepareAcceptanceRetry(payload,user);
    return store.finishAcceptanceRetry(payload,user,run.resultVersion,{passed:true,source:'model:p/m',summary:'产物核对完毕',evidence:['本批清单']});
  }});
  assert.ok(view.button('查看结果'));
  await act(async()=>view.button('查看结果').props.onClick());
  const text=node=>typeof node==='string'?node:node.children.map(text).join('');
  assert.match(text(view.renderer.root.findByProps({'aria-label':'工作输出'})),/执行已完成，结果仍在.*本批清单.*1 项检查通过/);
  assert.match(text(view.renderer.root.findByProps({'aria-label':'工作输出'})),/暂不可用.*重新预验收/);
  assert.equal(Boolean(view.button('取消工作')), false);
  assert.equal(Boolean(view.button('删除工作')), false);
  assert.deepEqual(calls,[]);
  assert.ok(view.button('重新预验收'));
  const before=store.getWork(item.id);
  await act(async()=>view.button('重新预验收').props.onClick());
  assert.deepEqual(calls.map(({type,workId,runId,expectedVersion})=>[type,workId,runId,expectedVersion]),[['work.retryAcceptance',item.id,run.id,before.version]]);
  assert.match(text(view.renderer.root.findByProps({'aria-label':'工作输出'})),/产物核对完毕/);
  assert.equal(Boolean(view.button('重新预验收')),false);
  assert.equal(store.getWork(item.id).status,'review');
});

test('the direct gate entry shows accepted upstream evidence before explicit release', async t => {
  const store = database(t), user = { kind: 'user' }, model = { provider: 'p', model: 'm' };
  const command = (type, work, extra) => store.command({ type, workId: work.id, expectedVersion: work.version, ...extra }, user);
  const upstream = command('work.confirm', createRecord(store, 'work', '交接材料', { model }));
  const gated = command('work.confirm', createRecord(store, 'work', '发布材料', { model, manualGate: true, scope: '本批文件', dependsOn: [upstream.id] }));
  const view = await mount(t, { store });
  assert.equal(Boolean(view.button('查看放行条件')), false);
  const run = store.reserveRun(upstream.id);
  store.finishRun(run.id, { reason: 'completed', summary: '交接清单已经核实', eventCursor: 0 });
  command('work.accept', store.getWork(upstream.id), { runId: run.id });
  await act(async () => view.button('刷新').props.onClick());
  assert.ok(view.button('查看放行条件'));
  await act(async () => view.button('查看放行条件').props.onClick());
  const evidence = view.renderer.root.findByProps({ 'aria-label': '放行条件' });
  const parts = evidence.findAll(node => ['p','dt','dd'].includes(node.type)).flatMap(node => node.children.filter(value => typeof value === 'string'));
  assert.match(parts.join(''), /本批文件.*交接材料.*结果版本.*交接清单已经核实/);
  assert.equal(store.getWork(gated.id).gate.released, false);
  await act(async () => view.button('放行人工关卡').props.onClick());
  assert.equal(store.getWork(gated.id).gate.released, true);
  await act(async () => view.button('返回工作列表').props.onClick());
  assert.equal(Boolean(view.button('查看放行条件')), false);
});

test('native approval opens evidence first and retains the filtered origin when visiting the conversation', async t => {
  const store = database(t), user = { kind: 'user' }, nav = { current: null };
  const item = createRecord(store, 'work', '核对图像', { sessionId: 'worker', model: { provider: 'p', model: 'm' } });
  store.command({ type: 'work.confirm', workId: item.id, expectedVersion: item.version }, user);
  const run = store.reserveRun(item.id);
  store.updateRun(run.id, { pendingInput: ['approval'] });
  const origin = { tab: 'work', workspaceId: 'project', statusFilter: ['interaction'], workflowFilter: '__unclassified', positions: { work: 64 } };
  nav.current = origin;
  const view = await mount(t, { store, previewNavigation: nav });
  assert.match(JSON.stringify(view.renderer.toJSON()), /执行对话中有审批请求/);
  await act(async () => view.button('查看审批请求').props.onClick());
  assert.deepEqual(view.opened, []);
  assert.equal(view.button('查看对话').props.className, 'loom-primary');
  await act(async () => view.button('查看对话').props.onClick());
  assert.deepEqual(view.opened, ['worker']);
  assert.equal(nav.current.workId, item.id);
  assert.deepEqual([nav.current.tab, nav.current.workspaceId, nav.current.statusFilter, nav.current.workflowFilter, nav.current.positions.work], ['work', 'project', ['interaction'], '__unclassified', 64]);
  assert.equal(store.getRun(run.id).status, 'dispatching');
});

test('a delayed native session lookup preserves a newer project selection', async t => {
  const store=database(t), user={kind:'user'}, gate=Promise.withResolvers();
  store.syncWorkspaces([{workspaceId:'project',title:'项目',path:'D:/project'},{workspaceId:'other',title:'另一项目',path:'D:/other'}]);
  const item=createRecord(store,'work','请求补充信息',{sessionId:'worker',model:{provider:'p',model:'m'}});
  store.command({type:'work.confirm',workId:item.id,expectedVersion:item.version},user);
  store.updateRun(store.reserveRun(item.id).id,{pendingInput:['question']});
  const view=await mount(t,{store,sessionsGate:gate});
  let opening;
  await act(async()=>view.button('查看待补输入').props.onClick());
  await act(async()=>{opening=view.button('查看对话').props.onClick();});
  await act(async()=>view.button('选择项目').props.onClick());
  await act(async()=>view.button('另一项目').props.onClick());
  await act(async()=>{gate.reject(new Error('旧项目连接中断'));await opening;});
  assert.deepEqual(view.opened,[]);
  assert.equal(Boolean(view.button('选择项目：另一项目')),true);
  assert.doesNotMatch(JSON.stringify(view.renderer.toJSON()),/旧项目连接中断|已打开工作对话/);
});

test('a delayed native session lookup yields to loading more work', async t => {
  const store = database(t), user = { kind: 'user' }, gate = Promise.withResolvers(), nav = { current: null };
  const item = createRecord(store, 'work', '待补输入', { sessionId: 'worker', model: { provider: 'p', model: 'm' } });
  store.command({ type: 'work.confirm', workId: item.id, expectedVersion: item.version }, user);
  store.updateRun(store.reserveRun(item.id).id, { pendingInput: ['question'] });
  for (let i = 0; i < 25; i++) createRecord(store, 'work', `待核对 ${i}`);
  const view = await mount(t, { store, sessionsGate: gate, previewNavigation: nav });
  const rowCount = () => view.renderer.root.findAll(node => node.type === 'button' && Boolean(node.props['data-work-id'])).length;
  assert.equal(rowCount(), 25);
  let opening;
  await act(async () => view.button('查看待补输入').props.onClick());
  await act(async () => { opening = view.button('查看对话').props.onClick(); });
  await act(async () => view.button('返回工作列表').props.onClick());
  await act(async () => view.button('加载更多工作').props.onClick());
  assert.equal(rowCount(), 26);
  await act(async () => { gate.resolve([{ sessionId: 'worker', workspaceId: 'project' }]); await opening; });
  assert.deepEqual(view.opened, []);
  assert.equal(nav.current, null);
  assert.equal(rowCount(), 26);
});

test('selecting a project from a pending request preserves the request for its coordinator', async t => {
  const store = database(t), agent = { kind: 'agent', sessionId: 'bus-1' };
  const original = store.command({ type: 'intent.create', text: '整理客户发来的第二批图' }, agent);
  const view = await mount(t, { store });
  const click = label => act(async () => { assert.ok(view.button(label), label); return view.button(label).props.onClick(); });
  await click('查看请求');
  assert.match(JSON.stringify(view.renderer.toJSON()), /整理客户发来的第二批图/);
  assert.equal(store.query({ kind: 'intent' }).items[0].workspaceId, null);
  await act(async () => view.renderer.root.findByProps({ 'aria-label': '所属项目' }).props.onChange({ target: { value: 'project' } }));
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const saved = store.query({ kind: 'intent' }).items[0];
  assert.deepEqual([saved.id, saved.status, saved.workspaceId, saved.text], [original.id, 'pending', 'project', original.text]);
  assert.equal(store.query({ kind: 'work' }).total, 0);
  assert.equal(store.query({ kind: 'use' }).total, 0);
  assert.throws(() => store.command({ type: 'intent.assignProject', intentId: original.id, expectedVersion: saved.version, workspaceId: 'project' }, agent), { code: 'FORBIDDEN' });
  await click('回协调对话');
  assert.deepEqual(view.retained, ['bus-1']);
  assert.deepEqual(view.released, []);
  const { use } = store.command({type:'use.create',workspaceId:'project',definition:{title:'第二批图',stages:[{id:'sort',title:'整理'}]}},agent);
  store.command({type:'intent.resolve',intentId:saved.id,workspaceId:'project',useId:use.id},agent);
  await click('刷新');
  assert.equal(Boolean(view.button('查看请求')),false);
  assert.equal(store.getUse(use.id).status,'proposed');
});

test('the same complete project catalog drives both tabs, even with a work referencing a retired source', async t => {
  const scratch = mkdtempSync(resolve(process.env.TMPDIR ?? tmpdir(), 'loom-catalog-')), file = resolve(scratch, 'loom.sqlite');
  const store = new LoomStore(file); t.after(() => { store.close(); rmSync(scratch, { recursive: true, force: true }); });
  store.syncWorkspaces([{ workspaceId: 'project', title: '本项目', path: scratch }, { workspaceId: 'second', title: '另一项目', path: scratch + '/other' }]);
  const other = store.command({ type: 'workflow.create', workspaceId: 'second', title: '其他项目流程', stages: [{ id: 'a', title: '检查' }] }, { kind: 'user' });
  const flows = Array.from({ length: 102 }, (_, n) => createRecord(store, 'workflow', `工作流 ${n}`));
  const historical = createRecord(store, 'workflow', '旧来源');
  const use = store.command({ type: 'workflow.start', workflowId: historical.id, expectedVersion: 1, model: { provider: 'p', model: 'm' } }, { kind: 'user' }).use;
  store.command({ type: 'use.confirm', useId: use.id, expectedVersion: use.version }, { kind: 'user' });
  // Legacy rows are produced by migration. Retain the source ID on the concrete work.
  const db = new DatabaseSync(file);
  try { db.prepare("UPDATE workflows SET status='legacy', body=json_set(body,'$.status','legacy') WHERE id=?").run(historical.id); } finally { db.close(); }
  const view = await mount(t, { store });
  const click = label => act(async () => {
    const button = label === '工作' ? view.renderer.root.findByProps({ 'aria-label': '工作台面板' }).findAllByType('button').find(node => node.children.includes(label))
      : view.renderer.root.findAllByType('button').find(node => node.props['aria-label']?.startsWith('选择项目') && label === '选择项目') ?? view.button(label);
    button.props.onClick();
  });
  const projects = () => view.renderer.root.findByProps({ 'aria-label': '搜索项目' });
  await click('工作流');
  assert.deepEqual(view.renderer.root.findAllByProps({ className: 'loom-workflow-project' }).map(node => node.findByType('h3').children.join('')), ['另一项目', '本项目']);
  await click('选择项目');
  await act(async () => projects().props.onChange({ target: { value: '本项' } }));
  assert.equal(Boolean(view.button('另一项目')), false);
  await click('本项目');
  assert.equal(Boolean(view.button('选择项目：本项目')), true);
  assert.equal(view.renderer.root.findAllByProps({ className: 'loom-work-row' }).length, flows.length);
  await click('工作');
  const options = () => view.renderer.root.findByProps({ 'aria-label': '筛选工作流' }).findAllByType('option').map(n => n.props.value).filter(Boolean);
  assert.deepEqual(options().filter(id => id !== '__unclassified'), flows.map(f => f.id));
  await click('工作流');
  const titles = () => view.renderer.root.findAllByProps({ className: 'loom-work-row' }).map(n => n.findByType('strong').children.join(''));
  assert.deepEqual(titles(), flows.map(f => f.title));
  await click('选择项目');
  await click('另一项目');
  assert.deepEqual(titles(), [other.title]);
  const tabs = view.renderer.root.findByProps({ 'aria-label': '工作台面板' });
  await act(async () => tabs.findAllByType('button').find(n => n.children.join('') === '工作').props.onClick());
  assert.deepEqual(options().filter(id => id !== '__unclassified'), [other.id]);
  await click('总览');
  assert.equal(view.button('总览').props['aria-current'], 'page');
  assert.deepEqual(view.retained, ['bus-1']);
  assert.deepEqual(view.released, []);
});

test('unclassified work stays in its project across pages and a return from the worker session', async t => {
  const store = database(t), nav = { current: null };
  store.syncWorkspaces([{ workspaceId: 'project', title: '项目甲', path: 'D:/project' }, { workspaceId: 'other', title: '项目乙', path: 'D:/other' }]);
  const flow = createRecord(store, 'workflow', '核对资料');
  const otherFlow = createRecord(store, 'workflow', flow.title, { workspaceId: 'other' });
  const works = Array.from({ length: 27 }, (_, i) => createRecord(store, 'work', `独立工作 ${i+1}`, i === 26 ? { sessionId: 'worker' } : {}));
  const linked = createRecord(store, 'work', '按流程工作', { workflowId: flow.id });
  const elsewhere = createRecord(store, 'work', '乙项目独立工作', { workspaceId: 'other' });
  const view = await mount(t, { store, previewNavigation: nav });
  const filter = v => v.renderer.root.findByProps({ 'aria-label': '筛选工作流' });
  const ids = v => v.renderer.root.findAllByProps({ className: 'loom-work-row' }).map(row => row.props['data-work-id']);
  assert.deepEqual(filter(view).findAllByType('optgroup').map(group => [group.props.label, group.findByType('option').props.value]), [['项目甲', flow.id], ['项目乙', otherFlow.id]]);
  await act(async () => view.button('选择项目').props.onClick());
  await act(async () => view.button('项目甲').props.onClick());
  const option = filter(view).findAllByType('option').find(node => node.children.includes('未分类'));
  assert.equal(Boolean(option), true);
  await act(async () => filter(view).props.onChange({ target: { value: option.props.value } }));
  assert.deepEqual(ids(view), works.slice(0, 25).map(work => work.id));
  await act(async () => view.button('加载更多工作').props.onClick());
  assert.deepEqual(ids(view), works.map(work => work.id));
  view.viewport.scrollTop = 640;
  await act(async () => view.renderer.root.findByProps({ className: 'loom-list-scroll' }).props.onScroll({ currentTarget: view.viewport }));
  const row = () => view.renderer.root.findByProps({ 'data-work-id': works.at(-1).id });
  await act(async () => row().props.onClick());
  await act(async () => view.button('返回工作列表').props.onClick());
  assert.equal(view.viewport.scrollTop, 640);
  await act(async () => row().props.onClick());
  await act(async () => view.button('查看对话').props.onClick());
  assert.deepEqual(view.opened, ['worker']);
  const back = await mount(t, { store, previewNavigation: nav });
  await act(async () => back.button('返回工作列表').props.onClick());
  assert.equal(back.viewport.scrollTop, 640);
  assert.equal(filter(back).props.value, '__unclassified');
  assert.deepEqual(ids(back), works.map(work => work.id));
  await act(async () => back.button('总览').props.onClick());
  await act(async () => back.button('加载更多工作').props.onClick());
  assert.ok(ids(back).includes(linked.id) && ids(back).includes(elsewhere.id));
});

test('late refresh errors from the previous project do not replace the current project', async t => {
  const store = database(t);
  store.syncWorkspaces([{ workspaceId: 'project', title: '项目甲', path: 'D:/project' }, { workspaceId: 'other', title: '项目乙', path: 'D:/other' }]);
  const b = createRecord(store, 'work', '乙项目工作', { workspaceId: 'other' });
  let rejectOld;
  const gate = new Promise((_, reject) => { rejectOld = reject; });
  let holdA = false;
  const view = await mount(t, { store, query: request => holdA && request.workspaceId === 'project' ? gate : store.query(request) });
  await act(async () => view.button('选择项目').props.onClick());
  await act(async () => view.button('项目甲').props.onClick());
  holdA = true;
  await act(async () => { void view.button('刷新').props.onClick(); });
  await act(async () => view.button('选择项目：项目甲').props.onClick());
  await act(async () => view.button('项目乙').props.onClick());
  await act(async () => rejectOld(new Error('旧项目读取失败')));
  assert.equal(view.renderer.root.findAllByProps({ 'data-work-id': b.id }).length, 1);
  assert.doesNotMatch(JSON.stringify(view.renderer.toJSON()), /旧项目读取失败/);
  assert.deepEqual(view.released, []);
});

test('a project list read failure leaves the coordinator attached and lets the project retry', async t => {
  const store = database(t);
  const work = createRecord(store, 'work', '需要核对');
  let broken = true;
  const view = await mount(t, { store, query: request => {
    if (broken && request.workspaceId === 'project') throw new Error('读取项目失败');
    return store.query(request);
  } });
  await act(async () => view.button('选择项目').props.onClick());
  await act(async () => view.button('项目').props.onClick());
  assert.ok(view.renderer.root.findAll(node => node.children.includes('工作列表读取失败')).length);
  assert.deepEqual(view.released, []);
  broken = false;
  await act(async () => view.button('重试').props.onClick());
  assert.equal(view.renderer.root.findAllByProps({ 'data-work-id': work.id }).length, 1);
  assert.deepEqual(view.retained, ['bus-1']);
});

test('pause writes the original work while a delayed readback leaves the new project selected', async t => {
  const store = database(t), actor = { kind: 'user' };
  store.syncWorkspaces([{ workspaceId: 'project', title: '项目甲', path: 'D:/project' }, { workspaceId: 'other', title: '项目乙', path: 'D:/other' }]);
  const draft = createRecord(store, 'work', '甲工作', { model: { provider: 'p', model: 'm' } });
  const a = store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, actor);
  const b = createRecord(store, 'work', '乙工作', { workspaceId: 'other' });
  const delayed = Promise.withResolvers();
  let hold = false;
  const view = await mount(t, { store, readWorkGate: id => hold && id === a.id ? delayed.promise : store.getWork(id) });
  const root = view.renderer.root;
  const click = label => act(async () => view.button(label).props.onClick());
  await click('选择项目'); await click('项目甲');
  await act(async () => root.findByProps({ 'data-work-id': a.id }).props.onClick());
  hold = true;
  await act(async () => { void view.button('暂停工作').props.onClick(); });
  assert.equal(store.getWork(a.id).status, 'paused');
  await click('选择项目：项目甲'); await click('项目乙');
  const row = root.findByProps({ 'data-work-id': b.id });
  await act(async () => delayed.resolve(store.getWork(a.id)));
  assert.equal(Boolean(view.button('选择项目：项目乙')), true);
  assert.equal(row.props['data-work-id'], b.id);
  assert.equal(root.findAllByProps({ 'aria-label': '工作详情视图' }).length, 0);
  assert.doesNotMatch(JSON.stringify(view.renderer.toJSON()), /甲工作|已完成。/);
});

test('a reply received after selecting another work in the same project keeps the new detail', async t => {
  const store = database(t), actor = { kind: 'user' }, gate = Promise.withResolvers();
  const draft = createRecord(store, 'work', '较早工作', { model: { provider: 'p', model: 'm' } });
  const a = store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, actor);
  const b = createRecord(store, 'work', '当前工作');
  const view = await mount(t, { store, commandGate: async (command, result) => {
    if (command.type === 'work.pause') await gate.promise;
    return result;
  } });
  const select = id => act(async () => view.renderer.root.findByProps({ 'data-work-id': id }).props.onClick());
  await select(a.id);
  await act(async () => { void view.button('暂停工作').props.onClick(); });
  assert.equal(store.getWork(a.id).status, 'paused');
  await act(async () => view.button('返回工作列表').props.onClick());
  await select(b.id);
  await act(async () => gate.resolve());
  const title = view.renderer.root.findByProps({ className: 'loom-detail-header' }).findByType('h2');
  assert.equal(title.children.join(''), b.title);
  assert.equal(Boolean(view.button('关闭操作提示')), false);
});

test('workbench keeps the catalog on a slower clock while live work evidence keeps refreshing', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
  const store = database(t), actor = { kind: 'user' }, calls = [];
  const draft = createRecord(store, 'work', '活动工作', { model: { provider: 'p', model: 'm' } });
  const work = store.command({ type: 'work.confirm', workId: draft.id, expectedVersion: draft.version }, actor);
  const run = store.reserveRun(work.id);
  const view = await mount(t, { store, onRPC: (method, request) => calls.push([method, request.kind]) });
  await act(async () => view.renderer.root.findByProps({ 'data-work-id': work.id }).props.onClick());
  const count = (method, kind) => calls.filter(call => call[0] === method && call[1] === kind).length;
  const before = { snapshot: count('snapshot'), runs: count('query', 'run') };
  const later = createRecord(store, 'workflow', '后来加入的工作流');
  const pending = () => view.renderer.root.findAll(node => node.type === 'p' && node.children.includes('请在执行对话中补充输入。')).length;
  assert.equal(pending(), 0);
  store.updateRun(run.id, { pendingInput: ['question'] });
  for (let i = 0; i < 3; i++) await act(async () => t.mock.timers.tick(3000));
  assert.equal(count('snapshot'), before.snapshot);
  assert.ok(count('query', 'run') > before.runs);
  assert.equal(pending(), 1);
  store.updateRun(run.id, { pendingInput: [], diagnostic: '等待原生交互：question' });
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(pending(), 0, 'The live empty value supersedes a legacy diagnostic');
  assert.equal(count('snapshot'), before.snapshot);
  await act(async () => view.button('工作流').props.onClick());
  assert.doesNotMatch(JSON.stringify(view.renderer.toJSON()), /后来加入的工作流/);
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(count('snapshot'), before.snapshot + 1);
  assert.equal(view.renderer.root.findAllByType('strong').filter(node => node.children.includes(later.title)).length, 1);
});

test('workbench confirms the conversation proposal and reuses its workflow with new inputs', async t => {
  const store = database(t), model = { provider: 'p', model: 'm' };
  store.command({ type: 'settings.update', roleModels: { worker: model } }, { kind: 'user' });
  const workflow = createRecord(store, 'workflow', '可复用交付', { parameters: [{ name: 'batch', description: '数据批次', required: true }], stages: [{ id: 'one', title: '整理资料', inputs: { batch: { kind: 'parameter', path: ['batch'] } } }] });
  const first = store.command({ type: 'workflow.start', workflowId: workflow.id, expectedVersion: workflow.version, parameters: { batch: '一号批次' }, model }, { kind: 'agent' });
  const view = await mount(t, { store, catalog: { groups: [{ id: 'p', name: '研发服务', models: [{ id: 'm', name: '执行模型' }] }] } });
  assert.equal(view.renderer.root.findByProps({ className: 'loom-split' }).props['data-rail-collapsed'], false);
  const pending = view.renderer.root.findAllByProps({ 'data-use-id': first.use.id });
  assert.equal(pending.length, 1);
  await act(async () => pending[0].props.onClick());
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0);
  assert.ok(view.button('查看本次工作'));
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0, 'execution review belongs in the main pane');
  assert.equal(store.getUse(first.use.id).status, 'proposed');
  const main = () => view.renderer.root.findByProps({ className: 'loom-chat' });
  await act(async () => main().findAllByType('button').find(button => button.children.join('') === '修改本次输入').props.onClick());
  await act(async () => view.renderer.root.findByProps({ 'aria-label': '本次输入 batch' }).props.onChange({ target: { value: '本次不保存' } }));
  await act(async () => view.button('返回').props.onClick());
  assert.ok(main().findByType('form').findAll(node => node.children.includes('一号批次')).length);
  assert.equal(store.getUse(first.use.id).status, 'proposed');
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(store.getUse(first.use.id).status, 'confirmed');
  assert.equal(store.query({ kind: 'work' }).total, 1);
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0);
  await act(async () => view.button('工作流').props.onClick());
  await act(async () => view.renderer.root.findByProps({ className: 'loom-work-row' }).props.onClick());
  assert.match(JSON.stringify(view.renderer.toJSON()), /使用历史/);
  await act(async () => view.button('使用工作流').props.onClick());
  assert.ok(view.renderer.root.findByProps({ className: 'loom-chat' }).findByType('form'));
  await act(async () => view.renderer.root.findByProps({ 'aria-label': '本次输入 batch' }).props.onChange({ target: { value: '二号批次' } }));
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const second = store.query({ kind: 'use' }).items[1];
  assert.equal(second.status, 'proposed');
  assert.match(JSON.stringify(view.renderer.toJSON()), /二号批次/);
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(store.query({ kind: 'work' }).total, 2);
  assert.notEqual(store.getUse(second.id).workIds[0], store.getUse(first.use.id).workIds[0]);
  assert.equal(view.renderer.root.findAllByProps({ 'data-native-slot': 'loom.conversation' }).length, 1);
  await act(async () => view.button('工作流').props.onClick());
  await act(async () => view.renderer.root.findByProps({ 'data-use-id': second.id }).props.onClick());
  assert.match(JSON.stringify(view.renderer.toJSON()), /本次工作/);
  await act(async () => view.button('允许本次工作自动验收').props.onClick());
  assert.equal(store.getWork(store.getUse(second.id).workIds[0]).authorization.autoAccept, true);
  assert.equal(store.getWork(store.getUse(first.use.id).workIds[0]).authorization.autoAccept, false);
  await act(async () => view.renderer.root.findByProps({ className: 'loom-work-row' }).props.onClick());
  assert.ok(view.button('返回本次工作'));
  await act(async () => view.button('返回本次工作').props.onClick());
  assert.ok(view.renderer.root.findByProps({ className: 'loom-work-row' }));
  await act(async () => view.button('返回工作流详情').props.onClick());
  assert.ok(view.button('使用工作流'));
});

test('editing one use changes its step materials, keeps automatic handoffs and returns to the same proposal', async t => {
  const store = database(t), model = { provider: 'p', model: 'm' };
  const flow = createRecord(store, 'workflow', '每批交付', { stages: [
    { id: 'prepare', title: '准备文件', inputs: { folder: { kind: 'value', value: '原目录' } }, outputs: [{ name: 'file', description: '清单' }] },
    { id: 'notes', title: '整理材料' },
    { id: 'publish', title: '核对清单', inputs: { file: { kind: 'output', stageId: 'prepare', output: 'file', path: [] } } },
  ] });
  const initial = store.command({ type: 'workflow.start', workflowId: flow.id, expectedVersion: flow.version, model }, { kind: 'agent' }).use;
  const view = await mount(t, { store, catalog: { groups: [{ id: 'p', name: '服务', models: [{ id: 'm', name: '模型' }] }] } });
  const click = async name => act(async () => view.button(name).props.onClick());
  const field = name => view.renderer.root.findByProps({ 'aria-label': name });
  const fill = async (name, value) => act(async () => field(name).props.onChange({ target: { value } }));
  const submit = async () => act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const pendingRows = view.renderer.root.findAllByProps({ 'data-use-id': initial.id });
  assert.equal(pendingRows.length, 1);
  await act(async () => pendingRows[0].props.onClick());
  await click('查看本次工作');
  await act(async () => view.renderer.root.findAllByProps({ className: 'loom-work-row' })
    .find(row => row.findByType('strong').children.join('') === '整理材料').props.onClick());
  await click('修改本次输入');
  assert.equal(field('准备文件 · folder').props.value, '原目录');
  await fill('准备文件 · folder', '放弃的编辑');
  await click('返回');
  assert.ok(view.button('修改本次输入'));
  await click('修改本次输入');
  assert.equal(field('准备文件 · folder').props.value, '原目录');
  await fill('准备文件 · folder', '本批目录');
  await fill('整理材料 · 本次材料', '客户提供的表格');
  await submit();
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0);
  await click('核对本次 3 项工作');
  assert.ok(view.button('确认执行本次 3 项工作'));
  const preview = field('本次输入清单');
  for (const value of ['本批目录', '客户提供的表格', '自动接收「准备文件」的清单']) assert.ok(preview.findAll(node => node.children.includes(value)).length, value);
  assert.equal(store.query({ kind: 'work' }).total, 0);
  await submit();
  const saved = store.getUse(initial.id), [first, notes, last] = saved.workIds.map(id => store.getWork(id));
  assert.equal(first.inputs.folder.value, '本批目录');
  assert.equal(notes.inputs.materials.value, '客户提供的表格');
  assert.equal(last.inputs.file.workId, first.id);
  assert.equal(saved.workflowId, flow.id);
  assert.deepEqual(store.getWorkflow(flow.id), flow);
  assert.equal(view.renderer.root.findByProps({ className: 'loom-detail-header' }).findByType('h2').children.join(''), '整理材料');
  await click('返回本次工作');
  await click('返回工作列表');
  assert.equal(view.renderer.root.findAllByProps({ 'data-use-id': initial.id }).length, 0);
  assert.equal(view.renderer.root.findAllByProps({ 'data-work-id': notes.id }).length, 1);
});

test('returning from a native session restores the same work in the management pane', async t => {
  const store=database(t), work=createRecord(store,'work','核对上传文件');
  const nav={current:{workId:work.id,view:'报告',workspaceId:'project'}};
  const view=await mount(t,{store,previewNavigation:nav});
  assert.equal(view.renderer.root.findByProps({className:'loom-detail-header'}).findByType('h2').children.join(''),work.title);
  assert.ok(view.button('返回工作列表'));
  await act(async()=>view.button('返回工作列表').props.onClick());
  assert.equal(nav.current,null);
});

test('settings occupies the main pane and returning preserves the work tab and coordinator draft', async t => {
  function Composer() {
    const [draft, setDraft] = React.useState(''), [attachment, setAttachment] = React.useState('');
    return React.createElement('div', null,
      React.createElement('textarea', { 'aria-label': '总控草稿', value: draft, onChange: event => setDraft(event.target.value) }),
      React.createElement('input', { 'aria-label': '总控附件', value: attachment, onChange: event => setAttachment(event.target.value) }));
  }
  const store = database(t), work = createRecord(store, 'work', '待查看的工作');
  const view = await mount(t, { store, renderSlot: () => React.createElement(Composer) });
  const { root } = view.renderer;
  const input = name => root.findByProps({ 'aria-label': name });
  await act(async () => {
    input('总控草稿').props.onChange({ target: { value: '保留原草稿' } });
    input('总控附件').props.onChange({ target: { value: '交付清单.txt' } });
  });
  await act(async () => view.button('设置').props.onClick());
  assert.equal(root.findAllByType('dialog').length, 0, 'settings belongs in the main pane');
  assert.equal(root.findByProps({ className: 'loom-split' }).props['data-mobile-pane'], 'page');
  assert.equal(root.findByProps({ className: 'loom-conversation-body' }).props.inert, true);
  assert.equal(root.findByProps({ className: 'loom-conversation-body' }).props.hidden, true, 'hide the entire native composer while settings owns the pane');
  assert.ok(root.findByProps({ className: 'loom-chat' }).findByProps({ 'aria-label': 'Loom 设置' }));
  await act(async () => view.button('返回').props.onClick());
  assert.equal(root.findByProps({ className: 'loom-split' }).props['data-mobile-pane'], 'chat');
  assert.equal(root.findByProps({ className: 'loom-conversation-body' }).props.hidden, false);
  await act(async () => root.findByProps({ 'data-work-id': work.id }).props.onClick());
  await act(async () => view.button('报告').props.onClick());
  await act(async () => view.button('设置').props.onClick());
  await act(async () => view.button('返回').props.onClick());
  assert.equal(root.findByProps({ className: 'loom-split' }).props['data-mobile-pane'], 'work');
  assert.equal(view.button('报告').props['aria-pressed'], true);
  assert.equal(input('总控草稿').props.value, '保留原草稿');
  assert.equal(input('总控附件').props.value, '交付清单.txt');
  assert.deepEqual(view.retained, ['bus-1']);
  assert.deepEqual(view.released, []);
});

test('only the work conversation action leaves Loom and restores the originating work', async t=>{
  const store=database(t), work=createRecord(store,'work','查看执行过程',{sessionId:'worker'}), nav={current:null};
  const view=await mount(t,{store,previewNavigation:nav});
  await act(async()=>view.renderer.root.findByProps({'data-work-id':work.id}).props.onClick());
  await act(async()=>view.button('查看对话').props.onClick());
  assert.deepEqual(view.opened,['worker']);assert.equal(nav.current.workId,work.id);
  const back=await mount(t,{store,previewNavigation:nav});
  assert.ok(back.button('返回工作列表'));assert.ok(back.button('查看对话'));
});

test('completed work saves a reusable definition with source evidence and leaves its result intact', async t => {
  const store = database(t), model = { provider: 'p', model: 'm' };
  let work = createRecord(store, 'work', '报告交付', { model, description: '完成报告并检查', scope: 'report 目录', inputs: { batch: { kind: 'value', value: '批次甲' } }, checks: [{ kind: 'file', path: 'report.md' }] });
  work = store.command({ type: 'work.confirm', workId: work.id, expectedVersion: work.version }, { kind: 'user' });
  const run = store.reserveRun(work.id);
  store.finishRun(run.id, { reason: 'completed', summary: '报告完成', eventCursor: 0 });
  work = store.command({ type: 'work.accept', workId: work.id, expectedVersion: store.getWork(work.id).version, runId: run.id }, { kind: 'user' });
  const original = structuredClone(work);
  const view = await mount(t, { store });
  await act(async () => view.renderer.root.findByProps({ className: 'loom-work-row' }).props.onClick());
  assert.ok(view.button('保存为工作流'));
  await act(async () => view.button('保存为工作流').props.onClick());
  await act(async () => view.renderer.root.findByProps({ 'aria-label': '工作流标题' }).props.onChange({ target: { value: '报告方法' } }));
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const workflow = store.query({ kind: 'workflow' }).items[0];
  assert.deepEqual(workflow.sourceWorkIds, [work.id]);
  assert.equal(workflow.stages[0].instructions, original.description);
  assert.equal(workflow.stages[0].scope, original.scope);
  assert.deepEqual(workflow.stages[0].checks, original.checks);
  assert.deepEqual(store.getWork(work.id), original);
  assert.equal(view.renderer.root.findAllByType('dialog').length, 0);
});

test('work status filter exposes three multi-select choices with select-all and invert', async t => {
  const store = database(t), user = { kind:'user' }, model = { provider:'p', model:'m' };
  const ended = createRecord(store, 'work', '上次盘点', { model });
  store.command({ type:'work.cancel', workId:ended.id, expectedVersion:ended.version }, user);
  const active = createRecord(store, 'work', '本次盘点', { model });
  store.command({ type:'work.confirm', workId:active.id, expectedVersion:active.version }, user);
  const flow = createRecord(store, 'workflow', '盘点流程');
  const proposal = store.command({ type:'workflow.start', workflowId:flow.id, expectedVersion:flow.version, model }, user).use;
  const view = await mount(t, { store });
  const filter = () => view.renderer.root.findByProps({ 'aria-label': '筛选工作状态' });
  const inputs = () => filter().findAllByType('input');
  const section = label => view.renderer.root.findByProps({ 'aria-label': `${label}的工作` });
  const rows = () => view.renderer.root.findAllByProps({ className:'loom-work-row' });
  assert.deepEqual(inputs().map(input => input.props['aria-label']), ['待处理', '进行中', '已结束']);
  assert.ok(inputs().every(input => input.props.type === 'checkbox' && input.props.checked));
  assert.ok(section('待处理').findByProps({ 'data-use-id':proposal.id }));
  assert.ok(section('进行中').findByProps({ 'data-work-id':active.id }));
  assert.ok(section('已结束').findByProps({ 'data-work-id':ended.id }));
  await act(async () => inputs()[1].props.onChange({ target: { checked: false } }));
  assert.deepEqual(inputs().map(input => input.props.checked), [true, false, true]);
  assert.equal(rows().length, 2);
  await act(async () => view.button('反选').props.onClick());
  assert.deepEqual(inputs().map(input => input.props.checked), [false, true, false]);
  assert.deepEqual(rows().map(row => row.props['data-work-id']), [active.id]);
  await act(async () => view.button('全选').props.onClick());
  assert.ok(inputs().every(input => input.props.checked));
  assert.equal(rows().length, 3);
  await act(async () => view.button('反选').props.onClick());
  assert.ok(inputs().every(input => !input.props.checked));
  assert.equal(rows().length, 0);
  assert.match(JSON.stringify(view.renderer.toJSON()), /请选择要查看的状态/);
});

function database(t) {
  const store = new LoomStore(':memory:');
  store.syncWorkspaces([{ workspaceId: 'project', title: '项目', path: 'D:/project' }]);
  t.after(() => store.close());
  return store;
}

const createRecord = (store, kind, title, extra = {}) => store.command({ type: `${kind}.create`, workspaceId: 'project', title, ...(kind === 'workflow' ? { stages: [{ id: 'step', title: '交付' }] } : {}), ...extra }, { kind: 'user' });

test('embedded conversation follows the coordinator without a session toolbar', async t => {
  const view = await mount(t);
  for (const name of ['切换对话','刷新对话列表','在会话页打开当前对话']) assert.equal(view.renderer.root.findAllByProps({'aria-label':name}).length,0,name);
  await view.rotate({ sessionId: 'bus-2', segment: 2 });
  assert.deepEqual(view.retained,['bus-1','bus-2']);assert.deepEqual(view.released,['bus-1']);
  assert.deepEqual(view.opened, []);
  assert.equal(view.renderer.root.findAllByProps({ 'data-native-slot': 'loom.conversation' }).length, 1);
});

test('cancel keeps the work readable; only confirmed deletion removes it from the list', async t => {
  const store=database(t), work=createRecord(store,'work','整理清单',{description:'按日期整理。'}), view=await mount(t,{store});
  const click=name=>act(async()=>view.button(name).props.onClick()), submit=()=>act(async()=>view.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  await act(async()=>view.renderer.root.findByProps({'data-work-id':work.id}).props.onClick());
  assert.doesNotMatch(view.button('取消工作').props.className||'',/danger/);
  assert.match(view.button('删除工作').props.className,/danger/);
  await click('取消工作');assert.doesNotMatch(view.button('确认取消').props.className||'',/danger/);await submit();
  assert.equal(store.getWork(work.id).description,'按日期整理。');assert.equal(store.getWork(work.id).status,'cancelled');
  await click('删除工作');await click('返回');assert.ok(store.getWork(work.id));
  await click('删除工作');assert.match(view.button('确认删除').props.className,/danger/);await submit();
  assert.equal(store.getWork(work.id),null);assert.equal(view.renderer.root.findAllByProps({'data-work-id':work.id}).length,0);assert.ok(view.button('＋ 工作'));
});

test('deletion links open each dependent work before confirmation and return to the source',async t=>{
  const store=database(t), source=createRecord(store,'work','上传文件'), downstream=createRecord(store,'work','等待处理',{dependsOn:[source.id]});
  const view=await mount(t,{store}), click=name=>act(async()=>view.button(name).props.onClick());
  await act(async()=>view.renderer.root.findByProps({'data-work-id':source.id}).props.onClick());
  await click('报告');await click('删除工作');
  assert.ok(!view.button('确认删除'),'blocked work should not offer confirmation');
  assert.ok(view.button('查看工作：等待处理'));await click('查看工作：等待处理');
  assert.equal(view.renderer.root.findByType('article').findByType('h2').children.join(''),downstream.title);
  await click('返回上传文件');
  assert.equal(view.renderer.root.findByType('article').findByType('h2').children.join(''),source.title);
  assert.equal(view.button('报告').props['aria-pressed'],true);assert.deepEqual(view.opened,[]);
});

test('a cancelled proposal stays readable until the user deletes that exact batch',async t=>{
  const store=database(t), flow=createRecord(store,'workflow','资料整理',{stages:[{id:'one',title:'收集'},{id:'two',title:'分类'}]});
  const start=()=>store.command({type:'workflow.start',workflowId:flow.id,expectedVersion:flow.version},{kind:'user'}).use;
  const first=start(), other=start(), view=await mount(t,{store});
  const click=name=>act(async()=>view.button(name).props.onClick()), submit=()=>act(async()=>view.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  await act(async()=>view.renderer.root.findByProps({'data-use-id':first.id}).props.onClick());
  await click('查看本次工作');
  await click('取消本次 2 项工作');await submit();assert.equal(store.getUse(first.id).status,'cancelled');
  await click('返回工作列表');const ended=view.renderer.root.findByProps({'aria-label':'已结束的工作'});await act(async()=>ended.findAllByProps({'data-use-id':first.id})[0].props.onClick());
  assert.ok(view.button('删除本次 2 项工作'));assert.ok(!view.button('核对本次 2 项工作'));
  await click('删除本次 2 项工作');await submit();assert.equal(store.getUse(first.id),null);assert.equal(store.getUse(other.id).status,'proposed');assert.ok(store.getWorkflow(flow.id));
});

test('work management confirms each selected target once in the shared dialog', async t => {
  const store = database(t), calls = [], user = { kind: 'user' };
  const work = createRecord(store, 'work', '待清理工作');
  const { use } = store.command({ type: 'use.create', workspaceId: 'project', definition: { title: '待清理批次', stages: [{id:'one',title:'读取'},{id:'two',title:'整理'}] } }, user);
  const view = await mount(t, { store, command: payload => { calls.push(payload.type); return store.command(payload, user); } });
  const click = name => act(async () => { const button = view.button(name); assert.ok(button, name); button.props.onClick(); });
  const submit = () => act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await click('管理'); await click('全选已加载'); await click('取消所选');
  assert.equal(view.renderer.root.findByType('dialog').props.className, 'loom-surface loom-dialog');
  const items = view.renderer.root.findByProps({ 'aria-label': '确认范围' });
  assert.match(JSON.stringify(items.findAllByType('li').map(node => node.children.join(''))), /待清理批次.*整批 2 项工作/);
  assert.doesNotMatch(view.button('确认取消').props.className ?? '', /danger/);
  assert.deepEqual(calls, []);
  await submit();
  assert.deepEqual(calls.sort(), ['use.cancel', 'work.cancel']);
  assert.equal(store.getUse(use.id).status, 'cancelled');
  assert.equal(store.getWork(work.id).status, 'cancelled');
  await click('返回'); await click('全选已加载'); await click('删除所选');
  assert.equal(view.button('确认删除').props.className, 'loom-danger');
  await submit();
  assert.equal(store.getWork(work.id), null);
  assert.equal(store.getUse(use.id), null);
});

test('management deletion exposes a blocking reference and returns to the confirmation', async t => {
  const store = database(t), source = createRecord(store, 'work', '上游清单');
  createRecord(store, 'work', '下游归档', { dependsOn: [source.id] });
  const view = await mount(t, { store });
  const click = name => act(async () => { const button = view.button(name); assert.ok(button, name); button.props.onClick(); });
  await click('管理'); await click('全选已加载'); await click('删除所选');
  assert.equal(Boolean(view.button('确认删除')), false);
  await click('查看工作：下游归档'); await click('返回管理');
  assert.ok(view.button('查看工作：下游归档'));
  assert.equal(store.query({ kind: 'work' }).total, 2);
});

test('management reports partial success and leaves later targets untouched after a version conflict', async t => {
  const store = database(t), user = { kind: 'user' }, calls = [];
  const items = ['第一项','第二项','第三项'].map(title => createRecord(store, 'work', title));
  const view = await mount(t, { store, command: payload => { calls.push(payload.workId); return store.command(payload, user); } });
  const click = name => act(async () => { const button = view.button(name); assert.ok(button, name); button.props.onClick(); });
  await click('管理'); await click('全选已加载'); await click('取消所选');
  store.command({ type: 'work.setModel', workId: items[1].id, expectedVersion: items[1].version, model: { provider: 'p', model: 'm' } }, user);
  await act(async () => view.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const report = JSON.stringify(view.renderer.root.findByProps({'aria-label':'处理结果'}).findAllByType('li').map(node => node.children.filter(value => typeof value === 'string').join('')));
  assert.match(report, /第一项：已取消.*第二项：未取消.*第三项：未执行/);
  assert.deepEqual(calls, items.slice(0, 2).map(item => item.id));
  assert.equal(store.getWork(items[2].id).status, items[2].status);
});
