import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed } from './context-native-helper.mjs';
import { startupHost, testModel as model, deadline } from './host-native-helper.mjs';
import { LoomStore } from '../src/core/store.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

function stream(res, delta, reason = 'stop') {
  const chunk = choices => `data: ${JSON.stringify({id:'bus-autostart',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}

test('bus publication queues eligible work with host provenance and respects review boundaries', {skip:!installed,timeout:40000}, async () => {
  let command, receivedWorker;
  const host = await startupHost((wire, _req, res) => {
    if (wire.tools?.some(t => t.function.name === 'loom_report')) {
      receivedWorker?.resolve(wire); stream(res, {content:'收到。'}); return;
    }
    if (wire.messages.at(-1).role === 'tool') { stream(res, {content:'已保存。'}); return; }
    stream(res, {tool_calls:[{index:0,id:`publish-${command.idempotencyKey}`,type:'function',function:{name:'loom_command',arguments:JSON.stringify({request:JSON.stringify(command)})}}]}, 'tool_calls');
  });
  const directory = join(host.directory, 'loom');
  try {
    await host.root.plugin(bootstrap, {directory}).await();
    await host.root.plugin(loom, {directory,intervalMs:60000}).await();
    const peer = host.ctx.connection.createPeer({principal:{kind:'owner'}});
    try {
      const route = host.ctx.connection.createSharedFetchHandler('/api');
      async function rpc(endpoint, payload = {}) {
        const method = `loom/${endpoint}`;
        const {result} = await (await route.fetch(new Request(`http://localhost/api/${method}`, {method:'POST',body:JSON.stringify({type:'client-request',rpcId:endpoint,method,payload})}),peer)).json();
        assert.equal(result.ok,true,JSON.stringify(result)); return result.value;
      }
      const {sessionId} = await rpc('ensureBus'), agent = host.ctx.agents.get(sessionId);
      const workspaceId = host.workspace.id;
      async function publish(input) {
        command = input;
        await host.ctx.sessionController.prompt({sessionId,requestId:`input-${input.idempotencyKey}`,mode:'queue',content:[{type:'text',text:input.idempotencyKey}]},AbortSignal.timeout(5000));
        await deadline(agent.whenIdle(),input.idempotencyKey);
      }
      const stages = [{id:'first',title:'整理清单'},{id:'second',title:'复核清单',dependsOn:['first'],manualGate:true}];
      const batch = {type:'use.create',workspaceId,definition:{title:'样本检查',stages},idempotencyKey:'batch'};
      assert.equal((await rpc('snapshot')).settings.busAutoStart,true);
      await publish(batch);
      const [use] = (await rpc('query',{kind:'use',workspaceId})).items;
      assert.equal(use.status,'confirmed');
      assert.equal(use.confirmation.actor.kind,'host');
      assert.equal(use.execution.autoAccept,false);
      const works = (await rpc('query',{kind:'work',useId:use.id})).items;
      assert.deepEqual(works.map(w=>w.status),['queued','queued']);
      assert.equal(works[0].modelConsent.actor.source,'bus-auto-start');
      assert.equal(works[0].permissionPreset,'workspace-write');
      assert.equal(works[1].gate.released,false);
      assert.deepEqual(works[1].dependsOn,[works[0].id]);
      const store = new LoomStore(join(directory,'loom.sqlite'));
      try { assert.deepEqual(store.readyWork().map(w=>w.id),[works[0].id]); }
      finally { store.close(); }
      const worker = Promise.withResolvers(); receivedWorker = worker;
      await rpc('tick');
      const request = await deadline(worker.promise,'actual model request for auto-started work');
      assert.equal(request.model,model.model);
      assert.equal((await rpc('query',{kind:'run',workId:works[1].id})).total,0);
      const template = await rpc('command',{type:'workflow.create',workspaceId,title:'固定流程',stages:[{id:'report',title:'整理报告'}]});
      await publish({type:'workflow.start',workflowId:template.id,expectedVersion:template.version,idempotencyKey:'template'});
      assert.equal((await rpc('query',{kind:'use',workflowId:template.id})).items[0].status,'confirmed');
      const standalone = {type:'work.create',workspaceId,title:'独立工作',idempotencyKey:'standalone'};
      await publish(standalone);
      await publish(standalone);
      const current = () => rpc('query',{kind:'work',workspaceId});
      assert.deepEqual((await current()).items.filter(w=>w.title===standalone.title).map(w=>w.status),['queued']);
      const manual = (await rpc('command',{...standalone,title:'手动新建',idempotencyKey:'manual'}));
      assert.equal(manual.status,'awaiting_model');
      await publish({...standalone,title:'命令检查',idempotencyKey:'command-check',checks:[{kind:'command',command:'node'}]});
      await publish({...standalone,title:'先看提案',idempotencyKey:'preview',reviewRequired:true});
      await publish({...standalone,title:'完全权限',idempotencyKey:'full',permissionPreset:'danger-full-access'});
      await rpc('command',{type:'settings.update',busAutoStart:false});
      await publish({...standalone,title:'关闭后发布',idempotencyKey:'disabled'});
      const final = (await current()).items;
      for (const title of ['命令检查','先看提案','完全权限','关闭后发布']) {
        const work = final.find(w=>w.title===title);
        assert.equal(work.status,'awaiting_model',title);
        assert.equal(work.modelConsent,null,title);
      }
      assert.equal((await rpc('snapshot')).settings.busAutoStart,false);
    } finally { await peer.dispose(); }
  } finally { await host.close(); }
});
