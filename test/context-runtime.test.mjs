import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BusState } from '../src/context/state.mjs';
import { installed, native, nativeHost } from './context-native-helper.mjs';
import { createLoomContext } from '../src/context/index.mjs';

test('periodic review failure preserves pending input and history for retry', {skip:!installed,timeout:30000}, async()=>{
  const host=await nativeHost(); const received=[];
  const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;received.push(JSON.parse(body));res.writeHead(418);res.end('review transport boundary');});
  server.listen(0,'127.0.0.1');await once(server,'listening'); let manager;
  try {
    process.env.LOOM_LOOPBACK_PROBE_KEY='loopback-probe-key';
    await host.root.plugin(native('dsh-llm-pi-ai'),{providers:{'moonshotai-cn':{apiKeyEnv:'LOOM_LOOPBACK_PROBE_KEY',api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,headers:{authorization:'Bearer local-probe'},models:[{id:'kimi-k3.1-pro',maxTokens:128}],retryPolicy:{mode:'normal',maxRetries:0}}}}).await();
    const directory=join(host.directory,'loom');
    manager=await createLoomContext(host.ctx,{directory,workspaceId:host.workspace.id,getSettings:()=>({roleModels:{bus:null,review:null},context:{debug:true,reviewEverySteps:1,reviewMaxTokens:128}}),query:async()=>({items:[],total:0,nextCursor:null}),command:async()=>{throw Error('unexpected');},modelCatalog:async()=>({default:{provider:'moonshotai-cn',model:'kimi-k3.1-pro'}})});
    const bus=await manager.ensureBus(),agent=host.ctx.agents.get(bus.sessionId);
    const user=text=>native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text}]});
    agent.session.append('user/message',user('old details '.repeat(300)),{surfaceOp:'append'});
    agent.session.append('user/message',user('previous intent'),{surfaceOp:'append'});
    const incoming=user('Keep the second displayed work and its constraints');
    agent.followup(incoming); await agent.whenIdle();
    const persisted=new BusState(directory,host.workspace.id);
    assert.deepEqual(persisted.pending().messages,[incoming]);
    assert.ok(persisted.pending().error.code);
    assert.ok(!agent.session.deriveMessages().some(m=>m.id===incoming.id));
    assert.ok(agent.session.deriveMessages().some(m=>JSON.stringify(m).includes('old details')));
    assert.equal(received.length,1,JSON.stringify(manager.getStatus()));
    assert.ok(JSON.stringify(received[0]).includes('Loom context review'));
    assert.equal(manager.getStatus().wire.latest.purpose,'compaction');
    assert.equal(manager.getStatus().wire.latest.wireCaptured,true);
  } finally {if(manager)await manager.dispose();server.close();await once(server,'close');await host.close();}
});
