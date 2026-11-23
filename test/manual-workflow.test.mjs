import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoomStore } from '../src/core/store.mjs';
import { draftFromManual } from '../src/host/manual-workflow.mjs';

const markdown = '# 样本处理\n为本批生成清单。\n从上游清单生成摘要，等人工放行。';
const user = { kind: 'user' }, model = { provider: 'local', model: 'fixture' };
const definition = {
  title: '样本处理', parameters: [{ name: 'batch', description: '批次', required: true }], stages: [
    { id: 'prepare', workIndex: 1, title: '制作清单', instructions: '用本批输入制作样本清单，报告清单标识。', inputs: { batch: { kind: 'parameter', path: ['batch'] } }, outputs: [{ name: 'manifest', description: '样本清单', required: true }] },
    { id: 'summarize', workIndex: 2, title: '整理摘要', instructions: '检查上游清单并生成本地摘要。', inputs: { source: { kind: 'output', stageId: 'prepare', output: 'manifest', path: [] } }, manualGate: false, checks: [{ kind: 'file', path: 'summary.md' }] },
  ],
};
const answer = () => ({ definition: structuredClone(definition), citations: [
  { stageId: 'prepare', source: 1, quote: '为本批生成清单。' },
  { stageId: 'summarize', source: 1, quote: '从上游清单生成摘要，等人工放行。' },
], questions: [], resources: [] });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-manual-'));
  const path = join(directory, 'project');
  await mkdir(path);
  await writeFile(join(path, 'guide.md'), markdown);
  const workspace = { id: 'project', path, title: '样本项目' };
  const database = join(directory, 'loom.sqlite');
  let store = new LoomStore(database);
  store.syncWorkspaces([{ workspaceId: workspace.id, path, title: workspace.title }, { workspaceId: 'other', path: directory, title: '其他项目' }]);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const reopen = () => { store.close(); store = new LoomStore(database); return store; };
  return { directory, path, store, reopen, draft: (overrides, generate) => draftFromManual({
    workspace, store, generate, request: { workspaceId: workspace.id, paths: ['guide.md'], workList: '制作清单\n整理摘要', ...overrides },
  }) };
}

test('manual generation requires a bounded work list even through a direct request', async t => {
  const { draft } = await fixture(t);
  for (const workList of ['', '  \n ', 'a'.repeat(4001), ['制作清单']]) {
    await assert.rejects(draft({ workList }, assert.fail), { code: 'MANUAL_INPUT' });
  }
});

test('picked manuals retain separate original names, order and citation line numbers', async t => {
  const { draft } = await fixture(t);
  const files = [{ name: '本地清单.md', content: '# 清单\n为本批生成清单。' }, { name: '本地摘要.markdown', content: '从上游清单生成摘要，等人工放行。' }];
  const result = await draft({ paths: [], files }, async ({ sources, selectedPaths }) => {
    assert.deepEqual(sources.map(({ title, content }) => ({ name: title, content })), files);
    assert.deepEqual(selectedPaths, []);
    const result = answer();
    result.citations[1].source = 2;
    result.resources = [{ stageId: 'prepare', kind: 'project', name: files[0].name }];
    return result;
  });
  assert.deepEqual(result.citations.map(({ title, line }) => [title, line]), [['本地清单.md', 2], ['本地摘要.markdown', 1]]);
  assert.equal(result.resources[0].status, 'unverified');
});

test('direct requests reject invalid picked-file names, types, bodies and excess selections', async t => {
  const { draft } = await fixture(t);
  const name = 'manual.md', content = '# Manual';
  for (const files of [null, [{ name: '../manual.md', content }], [{ name: 'other.txt', content }], [{ name, content: 1 }], [{ name, content: ' ' }], [{ name, content: 'a\u0000b' }], [{ name, content }, { name: 'Manual.MD', content }], Array.from({ length: 12 }, (_, i) => ({ name: `${i}.md`, content }))]) {
    await assert.rejects(draft({ files }, assert.fail), { code: 'MANUAL_INPUT' });
  }
});

test('picked files and pasted Markdown share the same UTF-8 byte limit', async t => {
  const { draft } = await fixture(t);
  const files = [{ name: 'manual.md', content: '清'.repeat(16 * 1024) }];
  await assert.rejects(draft({ paths: [], files, markdown: 'a' }, assert.fail), { code: 'MANUAL_SIZE' });
});

test('generated consumers must reference the whole required producer output', async t => {
  const { draft } = await fixture(t);
  await assert.rejects(draft({}, async () => {
    const result = answer(); result.definition.stages[1].inputs.source.path = ['id']; return result;
  }), { code: 'MANUAL_DRAFT_INVALID', message: /整个输出/ });
});

test('each listed work is mapped in order to steps grounded in selected manuals', async t => {
  const { draft, store } = await fixture(t);
  const work = store.command({ type: 'work.create', workspaceId: 'project', title: '参考', description: '从上游清单生成摘要，等人工放行。', model }, user);
  const refs = { works: [{ id: work.id, version: work.version }] };
  for (const mutate of [
    value => { value.definition.stages.pop(); value.citations.pop(); },
    value => value.definition.stages.reverse(),
    value => { value.citations[1].source = 2; },
  ]) await assert.rejects(draft(refs, async () => { const value = answer(); mutate(value); return value; }), { code: 'MANUAL_DRAFT_INVALID' });
  const result = await draft({}, async () => answer());
  assert.deepEqual(result.workMapping.map(({ title, stageIds }) => [title, stageIds]), [['制作清单', ['prepare']], ['整理摘要', ['summarize']]]);
});

test('two confirmed batches use scalar handoffs and stop at both default and documented gates', async t => {
  const { store, reopen, draft } = await fixture(t);
  const example = store.command({ type: 'work.create', workspaceId: 'project', title: '样本登记', description: '登记参考', model }, user);
  store.command({ type: 'work.create', workspaceId: 'other', title: '私有工作', model }, user);
  const result = await draft({ works: [{ id: example.id, version: example.version }] }, async evidence => {
    assert.deepEqual(evidence.sources.map(({ title, content }) => [title, content]), [['guide.md', markdown], ['样本登记', '登记参考']]);
    return answer();
  });
  assert.equal(result.state, 'review');
  assert.equal(store.query({ kind: 'workflow' }).total, 0);
  assert.equal(store.query({ kind: 'use' }).total, 0);
  assert.equal(store.query({ kind: 'work' }).total, 2);
  assert.deepEqual(result.definition.stages[1].dependsOn, ['prepare']);
  assert.equal(result.definition.stages[0].manualGate, true);
  assert.equal(result.definition.stages[1].manualGate, true);
  assert.equal(result.gateReviews.summarize.required, true);
  assert.match(result.definition.stages[1].scope, /guide\.md.*人工放行/);
  const saved = store.command({ type: 'workflow.create', workspaceId: 'project', ...result.definition }, user);
  assert.equal(store.query({ kind: 'work' }).total, 2);
  const scheduler = reopen();
  const template = scheduler.query({ kind: 'workflow' }).items[0];
  assert.equal(template.id, saved.id);
  const proposals = ['batch-a', 'batch-b'].map(batch => scheduler.command({ type: 'workflow.start', workflowId: template.id, expectedVersion: template.version, model, parameters: { batch } }, user).use);
  assert.deepEqual(proposals.map(use => use.status), ['proposed', 'proposed']);
  assert.equal(scheduler.query({ kind: 'work' }).total, 2);
  for (const proposal of proposals) {
    const { works: [producer, consumer] } = scheduler.command({ type: 'use.confirm', useId: proposal.id, expectedVersion: proposal.version }, user);
    assert.throws(() => scheduler.reserveRun(producer.id), { code: 'NOT_READY' });
    scheduler.command({ type: 'work.releaseGate', workId: producer.id, expectedVersion: producer.version }, user);
    const run = scheduler.reserveRun(producer.id), batch = proposal.parameters.batch;
    assert.equal(run.inputs.batch, batch);
    assert.match(run.prompt, /guide\.md（第 2 行）/);
    scheduler.reportRun(run.id, { kind: 'result', summary: '本批清单', outputs: { manifest: `${batch}-manifest.md` } }, { sessionId: run.sessionId, requestId: run.requestId, turn: 0, callId: `report:${batch}` });
    scheduler.finishRun(run.id, { reason: 'completed', summary: '本批清单', eventCursor: 0, reportCallId: `report:${batch}` });
    scheduler.command({ type: 'work.accept', workId: producer.id, expectedVersion: scheduler.getWork(producer.id).version, runId: run.id }, user);
    assert.equal(scheduler.getWork(consumer.id).gate.released, false);
    assert.equal(scheduler.readyWork().some(work => work.id === consumer.id), false);
    assert.throws(() => scheduler.reserveRun(consumer.id), { code: 'NOT_READY' });
    scheduler.command({ type: 'work.releaseGate', workId: consumer.id, expectedVersion: scheduler.getWork(consumer.id).version }, user);
    const next = scheduler.reserveRun(consumer.id);
    assert.equal(next.inputs.source, `${batch}-manifest.md`);
    assert.equal(next.consumedResults[0].runId, run.id);
    scheduler.finishRun(next.id, { reason: 'completed', summary: '已生成摘要', eventCursor: 0 });
  }
});

test('an explicitly selected missing manual stops before the model and a corrected path can regenerate', async t => {
  const { draft } = await fixture(t);
  const failed = await draft({ paths: ['missing.md'] }, assert.fail);
  assert.equal(failed.state, 'blocked');
  assert.deepEqual(failed.resources, [{ name: 'missing.md', kind: 'manual', status: 'missing' }]);
  assert.equal((await draft({}, async () => answer())).state, 'review');
});

test('unverified external or project dependencies require release and explicit local verification distinguishes missing files', async t => {
  const { draft, path } = await fixture(t);
  const generate = async () => ({ ...answer(), resources: [
    { stageId: 'prepare', kind: 'project', name: 'scripts/local.mjs' },
    { stageId: 'summarize', kind: 'external', name: '凭据与外部服务' },
  ] });
  const unverified = await draft({}, generate);
  assert.equal(unverified.state, 'review');
  assert.deepEqual(unverified.resources.map(r => r.status), ['unverified', 'unverified']);
  assert.deepEqual(unverified.definition.stages.map(s => s.manualGate), [true, true]);
  assert.match(unverified.definition.stages[1].scope, /凭据与外部服务.*尚未验证/);
  const verified = { verifyPaths: ['scripts/local.mjs'] };
  assert.equal((await draft(verified, generate)).state, 'blocked');
  await mkdir(join(path, 'scripts'));
  await writeFile(join(path, 'scripts', 'local.mjs'), 'throw Error("This file is for existence verification")');
  const fixed = await draft(verified, generate);
  assert.equal(fixed.state, 'review');
  assert.deepEqual(fixed.resources.map(r => r.status), ['present', 'unverified']);
  assert.equal(fixed.definition.stages[0].manualGate, true);
  assert.match(fixed.definition.stages[0].scope, /scripts\/local\.mjs.*文件存在.*运行待验证/);
});

test('material questions return to the source step instead of accepting a speculative draft', async t => {
  const { draft } = await fixture(t);
  const question = '本批材料应按哪个字段去重？';
  const result = await draft({}, async () => ({ questions: [question] }));
  assert.deepEqual(result, { state: 'clarify', questions: [question], resources: [] });
  const next = await draft({ clarification: '按样本编号去重。' }, async evidence => {
    assert.equal(evidence.clarification, '按样本编号去重。'); return answer();
  });
  assert.equal(next.state, 'review');
});

test('source and resource selection rejects traversal and project links before reading', async t => {
  const { draft, directory, path } = await fixture(t);
  await writeFile(join(directory, 'private.md'), 'outside project');
  await symlink(directory, join(path, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const paths of [['../private.md'], ['outside/private.md']]) {
    await assert.rejects(draft({ paths }, assert.fail), { code: 'MANUAL_PATH' });
  }
});

test('selected project SKILL.md is read as source while scripts remain existence-only checks', async t => {
  const { draft, path } = await fixture(t);
  await mkdir(join(path, '.agents', 'skills', 'sample'), { recursive: true });
  const skill = '.agents/skills/sample/SKILL.md';
  await writeFile(join(path, skill), markdown);
  const result = await draft({ paths: [skill] }, async evidence => {
    assert.equal(evidence.sources[0].kind, 'skill');
    return answer();
  });
  assert.equal(result.state, 'review');
});

test('foreign or changed reference works are rejected before model invocation', async t => {
  const { draft, store } = await fixture(t);
  const foreign = store.command({ type: 'work.create', workspaceId: 'other', title: '其他项目', model }, user);
  await assert.rejects(draft({ works: [{ id: foreign.id, version: foreign.version }] }, assert.fail), { code: 'WORKSPACE_MISMATCH' });
  const local = store.command({ type: 'work.create', workspaceId: 'project', title: '本项目', model }, user);
  await assert.rejects(draft({ works: [{ id: local.id, version: local.version + 1 }] }, assert.fail), { code: 'CONFLICT' });
});

test('model cannot supply a shell check, unsafe path, false citation or missing upstream result', async t => {
  const { draft, store } = await fixture(t);
  const variants = [
    value => value.definition.stages[0].checks = [{ kind: 'command', command: 'node', args: ['anything'] }],
    value => value.definition.stages[0].checks = [{ kind: 'file', path: '../other.txt' }],
    value => value.citations[0].quote = '引用不存在',
    value => value.definition.stages[1].inputs.source.output = 'missing',
  ];
  for (const mutate of variants) await assert.rejects(draft({}, async () => { const value = answer(); mutate(value); return value; }), { code: 'MANUAL_DRAFT_INVALID' });
  assert.equal(store.query({ kind: 'workflow' }).total, 0);
});
