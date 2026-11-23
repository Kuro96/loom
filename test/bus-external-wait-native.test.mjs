import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installed } from './context-native-helper.mjs';
import { deadline, startupHost, wireText } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

function reply(res, delta, reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'wait-fixture',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}
const tool=(res,id,name,args)=>reply(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');

for (const found of [true,false]) test(found ? 'the coordinator finds a receipt in a different project conversation and advances the original work' : 'the coordinator asks for a specific missing fact after its project search finds no receipt', {skip:!installed,timeout:30000}, async () => {
  const phrase='receipt-R17', clue='receipt-R17 moved to project ledger Bin-B9', foreign='receipt-R17 unrelated project ledger Bin-X7';
  let work, firstWorker, clueSession, otherSession, searchReply, busInput, unexpectedCommand;
  const worker=Promise.withResolvers();
  const host=await startupHost((wire,_req,res)=>{
    const message=wire.messages.at(-1), text=wireText(message);
    const names=wire.tools?.map(item=>item.function.name) ?? [];
    if(names.includes('loom_report')) {
      if(!firstWorker) {
        firstWorker=wire;
        return tool(res,'initial-uncertain','loom_report',{report:{kind:'uncertain',summary:'Original receipt location missing',document:{english:'The original location is obsolete.',chinese:'原位置停用。'},uncertainty:{operationId:work.id,remoteRef:phrase,reason:'Original location is obsolete',attempted:'Checked the original work conversation',missingInformation:'Where is the active receipt ledger?'}}});
      }
      worker.resolve(wire);
      return reply(res,{content:'Read the original operation.'});
    }
    if(!names.includes('loom_command')) return reply(res,{content:'Recorded.'});
    if(message.role!=='tool') {
      busInput=text;
      return tool(res,'unrelated-command','loom_command',{request:JSON.stringify({type:'work.create',workspaceId:work.workspaceId,title:'Unrelated fixture work'})});
    }
    if(message.tool_call_id==='unrelated-command') {
      unexpectedCommand=text;
      return tool(res,'lookup-receipt','loom_query',{request:JSON.stringify({kind:'project.sessionSearch',workId:work.id,query:phrase})});
    }
    if(message.tool_call_id==='lookup-receipt') {
      if(!text.startsWith('{')) {searchReply={error:text};return reply(res,{content:'Search failed.'});}
      searchReply=JSON.parse(text);
      const match=searchReply.items.find(item=>item.sessionId===clueSession);
      const sources=[match ? `DSH ${match.sessionId} event ${match.eventSeq}` : 'Project knowledge; project session search for receipt-R17 found no indexed hit'];
      return tool(res,'resolve-receipt','loom_command',{request:JSON.stringify({type:'work.resolveWait',workId:work.id,expectedVersion:searchReply.workVersion,operationId:work.id,action:match?'continue':'ask',sources,
        ...(match?{information:match.snippet}:{missingInformation:'Which ledger now contains the R17 receipt?'})})});
    }
    return reply(res,{content:'Receipt follow-up recorded.'});
  });
  try {
    const directory=join(host.directory,'loom');
    await host.root.plugin(bootstrap,{directory}).await();
    await host.root.plugin(loom,{directory,intervalMs:40}).await();
    const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
    try {
      const route=host.ctx.connection.createSharedFetchHandler('/api');
      async function rpc(endpoint,payload={}) {
        const method=`loom/${endpoint}`;
        const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload})}),peer)).json();
        assert.equal(result.ok,true,JSON.stringify(result));return result.value;
      }
      const workspaceId=host.workspace.id;
      const {sessionId:busId}=await rpc('ensureBus');
      const otherPath=join(host.directory,'other');
      await mkdir(otherPath);
      const other=(await host.ctx.workspaceController.create({path:otherPath})).workspace.workspaceId;
      async function note(project,text) {
        const {sessionId}=await host.ctx.sessionController.create({workspaceId:project});
        await host.ctx.sessionController.prompt({sessionId,requestId:`note-${project}`,mode:'queue',content:[{type:'text',text}]},AbortSignal.timeout(5000));
        await deadline(host.ctx.agents.get(sessionId).whenIdle(),'seed source conversation');
        return sessionId;
      }
      otherSession=await note(other,foreign);
      if(found) clueSession=await note(workspaceId,clue);
      work=await rpc('command',{type:'work.create',workspaceId,title:'Check the original shipment receipt',inputs:{checksum:{kind:'value',value:'sample-17'}}});
      work=await rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
      const fetchWork=async()=>(await rpc('query',{kind:'work',workId:work.id})).items[0];
      const until=async predicate=>{for(let i=0;i<180;i++){const value=await fetchWork();if(predicate(value))return value;assert.ok(!searchReply?.error,searchReply?.error);await delay(50);}assert.fail('The coordinator did not settle the wait');};
      if(found) {
        await until(value=>value.status==='queued' || value.status==='dispatching' || value.wait?.handoff?.information);
        const resumed=await deadline(worker.promise,'worker receives coordinator handoff',9000);
        assert.match(resumed.messages.map(wireText).join('\n'),/project ledger Bin-B9/);
        const runs=(await rpc('query',{kind:'run',workId:work.id})).items;
        assert.equal(runs.length,2);
        assert.equal(runs[1].sessionId,runs[0].sessionId);
        assert.equal(runs[1].operationId,runs[0].operationId);
        assert.equal(runs[1].inputs.checksum,runs[0].inputs.checksum);
        assert.equal(runs[1].wait.handoff.actor.sessionId,busId);
      } else {
        const paused=await until(value=>value.status==='paused');
        assert.equal(paused.wait.missingInformation,'Which ledger now contains the R17 receipt?');
        assert.match(paused.wait.attempted,/project session search/);
        assert.equal((await rpc('query',{kind:'run',workId:work.id})).total,1);
      }
      assert.ok(busInput,'Loom automatically prompted the coordinator');
      assert.match(unexpectedCommand,/自动复查只能处理当前外部操作/);
      assert.equal((await rpc('query',{kind:'work',workspaceId})).total,1);
      assert.ok(searchReply,'The coordinator read the native project search result');
      assert.ok(!searchReply.items.some(item=>item.sessionId===otherSession));
      assert.doesNotMatch(JSON.stringify(searchReply),/Bin-X7/);
      const before=await fetchWork();
      const unauthenticated={type:'work.resolveWait',workId:work.id,expectedVersion:before.version,operationId:work.id,action:'continue',sources:['Project records'],information:'Read again'};
      const method='loom/command';
      const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload:unauthenticated})}),peer)).json();
      assert.equal(result.error.code,'FORBIDDEN');
    } finally {await peer.dispose();}
  } finally {await host.close();}
});
