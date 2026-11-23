import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { installed } from './context-native-helper.mjs';
import { startupHost, testModel as model, wireText } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

const excerpt = '为本批整理一份样本清单。';
const approval = '由主管批准后才能复核。';
const workList = '整理清单\n复核清单';
const draft = { definition: { title: '样本清单', stages: [
  { id: 'list', workIndex: 1, title: '整理清单', instructions: '完成本批并返回本地清单。' },
  { id: 'review', workIndex: 2, title: '复核清单', instructions: '核对本地清单。', manualGate: false },
] }, questions: [], citations: [{ stageId: 'list', source: 1, quote: excerpt }, { stageId: 'review', source: 2, quote: approval }], resources: [] };

test('installed host generates a draft over the configured model connection with selected sources and no tool access', { skip: !installed, timeout: 25000 }, async () => {
  const host = await startupHost((_wire, _req, res) => {
    const chunk = choices => `data: ${JSON.stringify({ id: 'loom-manual-test', object: 'chat.completion.chunk', choices })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk([{ index: 0, delta: { content: JSON.stringify(draft) }, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + 'data: [DONE]\n\n');
  });
  try {
    const directory = join(host.directory, 'loom');
    await host.root.plugin(bootstrap, { directory }).await();
    await host.root.plugin(loom, { directory, intervalMs: 60000 }).await();
    const peer = host.ctx.connection.createPeer({ principal: { kind: 'owner' } });
    try {
      const route = host.ctx.connection.createSharedFetchHandler('/api');
      const rpc = async (endpoint, payload) => {
        const request = new Request(`http://localhost/api/loom/${endpoint}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method: `loom/${endpoint}`, payload }) });
        return (await (await route.fetch(request, peer)).json()).result;
      };
      await writeFile(join(host.directory, 'selected.md'), `# 手册\n${excerpt}`);
      await writeFile(join(host.directory, 'private.md'), '其他资料');
      assert.equal((await rpc('command', { type: 'settings.update', roleModels: { bus: model } })).ok, true);
      const incomplete = await rpc('manualDraft', { workspaceId: host.workspace.id, paths: ['selected.md'] });
      assert.equal(incomplete.error.code, 'MANUAL_INPUT');
      const missing = await rpc('manualDraft', { workspaceId: host.workspace.id, workList, paths: ['missing.md'] });
      assert.equal(missing.ok && missing.value.state, 'blocked');
      assert.equal(host.received.length, 0);
      const result = await rpc('manualDraft', { workspaceId: host.workspace.id, workList, files: [
        { name: '整理.md', content: `# 清单\r\n${excerpt}` }, { name: '复核.markdown', content: approval },
      ], paths: ['selected.md'] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.value.state, 'review');
      assert.equal(result.value.definition.title, '样本清单');
      assert.deepEqual(result.value.citations.map(({ title, line }) => [title, line]), [['整理.md', 2], ['复核.markdown', 1]]);
      assert.deepEqual(result.value.workMapping.map(work => work.title), workList.split('\n'));
      assert.equal(result.value.gateReviews.review.required, true);
      const [wire] = host.received;
      assert.equal(host.received.length, 1);
      assert.equal(wire.model, model.model);
      assert.equal(wire.tools?.length ?? 0, 0);
      assert.equal(wire.messages.length, 2);
      const evidence = JSON.parse(wireText(wire.messages[1]));
      assert.equal(evidence.workList, workList);
      assert.deepEqual(evidence.sources.map(source => source.title), ['整理.md', '复核.markdown', 'selected.md']);
      assert.deepEqual(evidence.selectedPaths, ['selected.md']);
      assert.match(evidence.sources[0].content, /为本批整理一份样本清单/);
      for (const kind of ['workflow', 'use', 'work', 'run']) assert.equal((await rpc('query', { kind })).value.total, 0);
    } finally { await peer.dispose(); }
  } finally { await host.close(); }
});
