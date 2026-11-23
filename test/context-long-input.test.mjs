import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { installed, native, nativeHost } from './context-native-helper.mjs';
import { BusState } from '../src/context/state.mjs';
import { createLoomContext } from '../src/context/index.mjs';
import { jsonBytes } from '../src/context/budget.mjs';

async function runInput(t,{text,focus,retry=false,focusBytes}) {
  const host=await nativeHost(),received=[];
  const directory=join(host.directory,'loom');
  const persisted=new BusState(directory,host.workspace.id);
  const display={sessionId:'source-session',replyId:'source-reply',shownAt:'2026-01-01T00:00:00.000Z',items:[{id:'second'},{id:'first'}]};
  persisted.recordDisplay(display);
  persisted.setFocus({constraints:['Keep the constraints'],references:['Keep the references'],...focus});
  if(focusBytes) {
    const constraints=[...persisted.value.focus.constraints,''];
    constraints[constraints.length-1]='x'.repeat(focusBytes-jsonBytes({...persisted.value.focus,constraints}));
    persisted.setFocus({constraints});
    assert.equal(jsonBytes(persisted.value.focus),focusBytes);
  }
  const before=structuredClone(persisted.value.focus);
  const incoming=native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text}]});
  if(retry) persisted.setPending([incoming],{code:'LOOM_ADMISSION_REJECTED',retryable:true});
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req.setEncoding('utf8'))body+=part;
    received.push(JSON.parse(body));res.writeHead(418);res.end('local transport boundary');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');let manager;
  t.after(async()=>{if(manager)await manager.dispose();server.close();await once(server,'close');await host.close();});
  await host.root.plugin(native('dsh-llm-pi-ai'),{providers:{'loom-test-provider':{api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,headers:{authorization:'Bearer local-probe'},models:[{id:'probe'}],retryPolicy:{mode:'normal',maxRetries:0}}}}).await();
  manager=await createLoomContext(host.ctx,{directory,workspaceId:host.workspace.id,getSettings:()=>({roleModels:{bus:{provider:'loom-test-provider',model:'probe'}}}),query:async()=>({items:[]}),command:async()=>{throw Error('unexpected command');},modelCatalog:async()=>({default:null})});
  const bus=await manager.ensureBus(),agent=host.ctx.agents.get(bus.sessionId);
  agent.followup(incoming);await agent.whenIdle();
  const after=new BusState(directory,host.workspace.id);
  assert.equal(received.length,1,JSON.stringify(after.pending()?.error));
  const admitted=agent.session.deriveMessages().filter(message=>message.id===incoming.id);
  assert.deepEqual(admitted,[incoming]);
  assert.equal(after.pending(),null);
  const wireTexts=received[0].messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.filter(block=>block.type==='text').map(block=>block.text).join(''));
  assert.equal(wireTexts.filter(value=>value===text).length,1);
  assert.ok(jsonBytes(after.value.focus)<=8000);
  for(const key of ['constraints','references']) assert.deepEqual(after.value.focus[key],before[key]);
  assert.deepEqual(after.value.display,display);
  return {focus:after.value.focus,wireTexts};
}

test('long pending input survives focus recovery and reaches native admission and provider once',{skip:!installed,timeout:30000},async t=>{
  const text='保留原始记录与项目顺序。\n'.repeat(1600);
  const {focus}=await runInput(t,{text,retry:true});
  assert.ok(jsonBytes(focus.latestIntent)<=2048);
  assert.notEqual(focus.latestIntent,text);
  assert.match(focus.latestIntent,/preview/i);
});
