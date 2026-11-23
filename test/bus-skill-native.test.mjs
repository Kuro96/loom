import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { installed, native } from './context-native-helper.mjs';
import { deadline, startupHost, wireText } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

test('the bus receives the registered communication skill without exposing a generic skill tool', {skip:!installed,timeout:30000}, async () => {
  const host=await startupHost();
  try {
    const directory=join(host.directory,'loom'),root=join(host.directory,'skills');
    const marker='Lead with the actual outcome and the next decision.';
    for(const [name,text] of [['cooperative-answering',marker],['other-skill','Unrelated skill fixture.']]) {
      await mkdir(join(root,name),{recursive:true});
      await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: Local communication fixture\n---\n${text}\n`);
    }
    await host.root.plugin(native('dsh-skill').default ?? native('dsh-skill')).await();
    await host.root.plugin(native('dsh-skill-filesystem'),{dshHome:host.directory,agentsHome:join(host.directory,'agents'),bundledSkillDir:join(host.directory,'bundled'),watch:false}).await();
    await host.root.plugin(bootstrap,{directory}).await();
    await host.root.plugin(loom,{directory,intervalMs:60000}).await();
    const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
    try {
      const route=host.ctx.connection.createSharedFetchHandler('/api'),method='loom/ensureBus';
      const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload:{}})}),peer)).json();
      assert.equal(result.ok,true,JSON.stringify(result));
      const {sessionId}=result.value,agent=host.ctx.agents.get(sessionId);
      await host.ctx.sessionController.prompt({sessionId,requestId:'skill-check',mode:'queue',content:[{type:'text',text:'请简述要交付什么'}]},AbortSignal.timeout(5000));
      await deadline(agent.whenIdle(),'coordinator request');
      const [wire]=host.received;
      assert.match(wire.messages.map(wireText).join('\n'),new RegExp(marker));
      assert.doesNotMatch(wire.messages.map(wireText).join('\n'),/Unrelated skill fixture/);
      assert.deepEqual(wire.tools.map(tool=>tool.function.name),['loom_command','loom_focus','loom_query']);
    } finally { await peer.dispose(); }
  } finally { await host.close(); }
});
