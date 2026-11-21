import test from 'node:test';
import assert from 'node:assert/strict';
import { LoomStore } from '../src/core/store.mjs';
import { readWorkList } from '../src/client/work-list.mjs';

const model = { provider: 'local', model: 'worker' };

function fixture(t) {
  const store = new LoomStore(':memory:');
  t.after(() => store.close());
  store.syncWorkspaces(['a', 'b'].map(id => ({ workspaceId: id, title: id, path: `D:/${id}` })));
  const command = payload => store.command(payload, { kind: 'user' });
  const calls = [];
  const api = { rpc(method, query) {
    assert.equal(method, 'query');
    calls.push(query);
    return store.query(query);
  } };
  const work = extra => command({ type: 'work.create', workspaceId: 'a', title: 'Inspect', model, ...extra });
  return { store, command, calls, work, read: options => readWorkList(api, options) };
}

test('work rows follow server categories, including an active run waiting for native input', async t => {
  const { store, command, work, read } = fixture(t);
  const queue = extra => {
    const item = work(extra);
    return command({ type: 'work.confirm', workId: item.id, expectedVersion: item.version, autoAccept: false });
  };
  const native = queue(), run = store.reserveRun(native.id);
  store.updateRun(run.id, { diagnostic: '等待原生交互：选择文件' });
  const gated = queue({ manualGate: true }), queued = queue();
  const ended = command({ type: 'work.cancel', workId: work().id });

  const { rows, hasMore } = await read({ categories: ['interaction', 'completed', 'pending'] });
  assert.deepEqual(rows.map(row => [row.category, row.work.id]), [
    ['pending', queued.id], ['completed', ended.id], ['interaction', native.id], ['interaction', gated.id],
  ]);
  for (const row of rows) {
    const item = store.getWork(row.work.id);
    assert.deepEqual(row.work, item);
    assert.deepEqual([row.status, row.title, row.workspaceId, row.workflowId, row.createdAt],
      [item.status, item.title, item.workspaceId, item.workflowId, item.createdAt]);
  }
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.equal(hasMore, false);
});

test('a structured native request overrides legacy diagnostics and clears independently of the Work version', async t => {
  const { store, command, work, read } = fixture(t);
  const item = work(), queued = command({ type: 'work.confirm', workId: item.id, expectedVersion: item.version });
  const run = store.reserveRun(queued.id), version = store.getWork(item.id).version;
  store.updateRun(run.id, { pendingInput: ['question', 'approval'], diagnostic: '原生消息不可展开' });
  const [row] = (await read({ categories: ['interaction'] })).rows;
  assert.equal(row?.decision, 'native_approval');
  store.updateRun(run.id, { pendingInput: [], diagnostic: '等待原生交互：approval' });
  assert.equal((await read({ categories: ['interaction'] })).rows.length, 0);
  assert.equal(store.getWork(item.id).version, version);
});

const definition = { title: 'Review', stages: [{ id: 'first', title: 'Inspect' }, { id: 'second', title: 'Inspect' }] };

test('confirmation replaces just that decision with the generated works', async t => {
  const { command, read } = fixture(t);
  const flow = command({ type: 'workflow.create', workspaceId: 'a', ...definition });
  const start = () => command({ type: 'workflow.start', workflowId: flow.id, expectedVersion: flow.version, model }).use;
  const first = start(), second = start();
  const before = await read();
  assert.deepEqual(before.rows.map(row => [row.proposal, row.title, row.category, row.status,
    row.workspaceId, row.workflowId, row.createdAt]), [first, second].map(use =>
    [use, definition.title, 'interaction', 'proposed', 'a', flow.id, use.createdAt]));
  assert.equal(new Set(before.rows.map(row => row.key)).size, 2);

  const { works } = command({ type: 'use.confirm', useId: first.id, expectedVersion: first.version });
  const after = await read();
  assert.deepEqual(after.rows.slice(0, 2).map(row => [row.work, row.category, row.stageId]),
    works.map(work => [work, 'pending', work.stageId]));
  assert.deepEqual(after.rows.slice(2), before.rows.slice(1));
  assert.equal(after.hasMore, false);
});

test('load more counts decisions before paging across use and work cursors', async t => {
  const { command, work, read, calls } = fixture(t);
  const propose = stages => command({ type: 'use.create', workspaceId: 'a', definition: { ...definition, stages } }).use;
  const long = propose([...definition.stages, { id: 'third', title: 'Inspect' }]);
  const short = definition.stages.slice(0, 1);
  const next = propose(short), last = propose(short);
  const works = [work(), work(), work()];
  const expected = [long.id, next.id, last.id, ...works.map(item => item.id)];
  for (const depth of [1, 2, 3, 4, 1]) {
    const start = calls.length;
    const { rows, hasMore } = await read({ categories: ['interaction'], depth, pageSize: 2 });
    assert.deepEqual(rows.map(row => row.proposal?.id ?? row.work.id), expected.slice(0, depth * 2));
    assert.equal(hasMore, depth * 2 < expected.length);
    if (depth === 1) assert.deepEqual(calls.slice(start).map(query => query.kind), ['use']);
  }
  assert.ok(calls.every(query => query.limit <= 2));
  assert.ok(calls.some(query => query.kind === 'use' && query.after));
  assert.ok(calls.some(query => query.kind === 'work' && query.after));
});

test('workspace and workflow filters scope both proposals and work rows before paging', async t => {
  const { command, work, read } = fixture(t);
  const flow = command({ type: 'workflow.create', workspaceId: 'a', ...definition });
  const fromFlow = command({ type: 'workflow.start', workflowId: flow.id, expectedVersion: flow.version }).use;
  const inline = workspaceId => command({ type: 'use.create', workspaceId, definition }).use;
  const a = inline('a'), b = inline('b');
  const wa = work(), wb = work({ workspaceId: 'b' }), linked = work({ workflowId: flow.id });
  const ids = async (workspaceId, workflowId) => {
    const { rows, hasMore } = await read({ workspaceId, workflowId, categories: ['interaction'], pageSize: 1, depth: 10 });
    assert.equal(hasMore, false);
    return rows.map(row => row.proposal?.id ?? row.work.id);
  };
  assert.deepEqual(await ids('a', flow.id), [fromFlow.id, linked.id]);
  assert.deepEqual(await ids('a', null), [a.id, wa.id]);
  assert.deepEqual(await ids('b', '__unclassified'), [b.id, wb.id]);
  assert.deepEqual(await ids('b', flow.id), []);
  assert.deepEqual(await ids('a', ''), [fromFlow.id, a.id, wa.id, linked.id]);
});

test('clearing the selection makes no query; the ended list includes completed works and cancelled proposals', async t => {
  const { command, work, read, calls } = fixture(t);
  const ended = command({ type: 'work.cancel', workId: work().id });
  assert.deepEqual(await read({ categories: [] }), { rows: [], hasMore: false });
  assert.deepEqual(calls, []);
  const { rows, hasMore } = await read({ categories: ['completed'] });
  assert.deepEqual(rows.map(row => row.work.id), [ended.id]);
  assert.equal(hasMore, false);
  assert.deepEqual(calls.map(q => [q.kind, q.categories ?? q.status]), [['work', ['completed']],['use','cancelled']]);
});

test('invalid pagination is rejected before querying', async t => {
  const { read, calls } = fixture(t);
  for (const options of [{ depth: -1 }, { depth: 1.5 }, { pageSize: 0 }, { pageSize: 201 }]) {
    await assert.rejects(read(options), RangeError);
  }
  assert.deepEqual(calls, []);
});
