import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed } from './context-native-helper.mjs';
import { startupHost, testModel as model } from './host-native-helper.mjs';
import { LoomStore } from '../src/core/store.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

const high = { ...model, reasoningEffort: 'high' };
const xhigh = { ...model, reasoningEffort: 'xhigh' };

test('the installed host persists a reasoning effort change for result pre-acceptance alone', { skip: !installed, timeout: 25000 }, async () => {
  const host = await startupHost(undefined, { reasoningEfforts: { high: 'high', xhigh: 'xhigh' } });
  try {
    const directory = join(host.directory, 'loom');
    await host.root.plugin(bootstrap, { directory }).await();
    await host.root.plugin(loom, { directory, intervalMs: 60000 }).await();
    const peer = host.ctx.connection.createPeer({ principal: { kind: 'owner' } });
    try {
      const route = host.ctx.connection.createSharedFetchHandler('/api');
      async function rpc(endpoint, payload = {}) {
        const method = `loom/${endpoint}`;
        const request = new Request(`http://localhost/api/${method}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method, payload }) });
        const { result } = await (await route.fetch(request, peer)).json();
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.value;
      }
      const { groups } = await rpc('models');
      const selected = groups.find(group => group.id === model.provider).models.find(item => item.id === model.model);
      assert.ok(selected.reasoning.efforts.some(effort => effort.id === 'xhigh'));
      const before = await rpc('command', { type: 'settings.update', roleModels: { bus: high, worker: high, acceptance: high } });
      await rpc('command', { type: 'settings.update', expectedVersion: before.version, roleModels: { acceptance: xhigh } });
      const { settings } = await rpc('snapshot');
      assert.equal(settings.version, before.version + 1);
      assert.deepEqual(settings.roleModels, { ...before.roleModels, acceptance: xhigh });
      assert.equal(host.received.length, 0, 'saving settings must not call the model');
      const fresh = new LoomStore(join(directory, 'loom.sqlite'));
      try { assert.deepEqual(fresh.getSettings(), settings); }
      finally { fresh.close(); }
    } finally { await peer.dispose(); }
  } finally { await host.close(); }
});
