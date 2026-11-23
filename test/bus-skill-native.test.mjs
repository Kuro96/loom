import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { installed, native } from './context-native-helper.mjs';
import { deadline, startupHost, testModel, wireText } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

const cooperation='Lead with the actual outcome and the next decision.';
const bilingual='Preserve the same terminology and level of certainty in both versions.';
const markers={'cooperative-answering':cooperation,'asd-ste100-zh':bilingual};

async function writeSkill(root,name,text,{blocked=false}={}) {
  await mkdir(join(root,name),{recursive:true});
  await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: Writing instructions for the test\n${blocked?'disable-model-invocation: true\n':''}---\n${text}\n`);
}

async function writingHost(t,{userSkills=[],blocked=[],customSkills=false,projectSkills=false,registry=true}={}) {
  const reportRequest=Promise.withResolvers();
  const host=await startupHost((wire,_req,res)=>{
    if(wire.tools?.some(tool=>tool.function.name==='loom_report')) reportRequest.resolve(wire);
    const chunk=JSON.stringify({id:'writing',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'索引已就绪。'},finish_reason:'stop'}]});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(`data: ${chunk}\n\ndata: [DONE]\n\n`);
  });
  let peer;
  t.after(async()=>{await peer?.dispose();await host.close();});
  const directory=join(host.directory,'loom');
  if(registry) {
    const custom=join(host.directory,'custom');
    for(const [name,text] of Object.entries(markers)) {
      if(userSkills.includes(name)) await writeSkill(join(host.directory,'skills'),name,text);
      if(blocked.includes(name)) await writeSkill(join(host.directory,'agents','skills'),name,text,{blocked:true});
      if(customSkills) await writeSkill(custom,name,'Custom writing instructions.');
      if(projectSkills) {
        for(const cwd of [host.directory,join(directory,'control')]) await writeSkill(join(cwd,'.dsh','skills'),name,'Project-local writing instructions.');
      }
    }
    await writeSkill(join(host.directory,'skills'),'other-skill','Unrelated skill instructions.');
    await host.root.plugin(native('dsh-skill').default).await();
    await host.root.plugin(native('dsh-skill-filesystem'),{dshHome:host.directory,agentsHome:join(host.directory,'agents'),bundledSkillDir:join(host.directory,'bundled'),customSkillDirs:customSkills?[custom]:[],watch:false}).await();
  }
  await host.root.plugin(bootstrap,{directory}).await();
  await host.root.plugin(loom,{directory,intervalMs:60000}).await();
  peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
  const route=host.ctx.connection.createSharedFetchHandler('/api');
  async function rpc(endpoint,payload={}) {
    const method=`loom/${endpoint}`;
    const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload})}),peer)).json();
    assert.equal(result.ok,true,JSON.stringify(result));
    return result.value;
  }
  async function prompt(sessionId) {
    await host.ctx.sessionController.prompt({sessionId,requestId:'skill-check',mode:'queue',content:[{type:'text',text:'请简述要交付什么'}]},AbortSignal.timeout(5000));
    await deadline(host.ctx.agents.get(sessionId).whenIdle(),'writing request');
  }
  async function requests() {
    const {sessionId}=await rpc('ensureBus');
    await prompt(sessionId);
    const work=await rpc('command',{type:'work.create',workspaceId:host.workspace.id,title:'整理索引',model:testModel});
    await rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
    await rpc('tick');
    const [run]=(await rpc('query',{kind:'run',workId:work.id})).items;
    assert.ok(run,'dispatch writes a real Loom run');
    const worker=await deadline(reportRequest.promise,'worker request');
    const [bus]=host.received;
    assert.deepEqual(bus.tools.map(tool=>tool.function.name),['loom_command','loom_focus','loom_query']);
    assert.deepEqual(worker.tools.map(tool=>tool.function.name),['loom_report']);
    return [bus,worker].map(wire=>wire.messages.map(wireText).join('\n'));
  }
  return {...host,requests};
}

for(const [title,options] of [
  ['cooperative answering is independently optional',{userSkills:['cooperative-answering']}],
  ['bilingual writing is independently optional',{userSkills:['asd-ste100-zh']}],
  ['both writing skills use the host view over same-name project skills',{userSkills:Object.keys(markers),projectSkills:true}],
  ['a model-disabled skill is omitted while the other skill stays active',{userSkills:['cooperative-answering'],blocked:['asd-ste100-zh']}],
  ['project-local writing skills are outside the Loom host lookup',{projectSkills:true}],
  ['custom directory skills are outside the Loom writing source allowlist',{customSkills:true}],
  ['missing skill service preserves the built-in writing rules',{registry:false}],
]) test(title,{skip:!installed,timeout:30000},async t=>{
  const host=await writingHost(t,options);
  const registry=host.root.get('skills');
  for(const name of options.blocked ?? []) assert.equal((await registry.get(name)).invocation.modelInvocable,false);
  if(options.customSkills) assert.equal((await registry.get('asd-ste100-zh')).source,'custom');
  const [bus,worker]=await host.requests();
  for(const [role,text] of [['bus',bus],['worker',worker]]) {
    for(const [name,marker] of Object.entries(markers)) {
      assert.equal(text.includes(marker),options.userSkills?.includes(name) ?? false,`${role}: ${name}`);
    }
    assert.doesNotMatch(text,/Unrelated skill instructions|Project-local writing instructions|Custom writing instructions/);
  }
  assert.match(bus,/Answer in the user's language/);
  assert.match(worker,/document:\{english,chinese\}.*先用简短英文.*再忠实翻译为自然中文/);
  if(options.userSkills?.length===2) {
    const {agent}=await host.ctx.agents.create({sessionId:'ordinary-writing',meta:{cwd:host.directory},agentOptions:testModel});
    const {createUserMessage}=native('dsh-llm');
    agent.followup(createUserMessage({source:{kind:'user-rpc',rpcId:'ordinary-writing'},content:[{type:'text',text:'普通对话'}]}));
    await deadline(agent.whenIdle(),'ordinary request');
    const request=host.received.find(wire=>wire.messages.some(message=>wireText(message)==='普通对话'));
    const text=request.messages.map(wireText).join('\n');
    assert.ok(!text.includes(cooperation));
    assert.ok(!text.includes(bilingual));
    assert.ok(!request.tools?.some(tool=>tool.function.name==='loom_report'));
  }
});
