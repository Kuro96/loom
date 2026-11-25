import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {installed,native} from './context-native-helper.mjs';
import {deadline,startupHost,testModel,wireText} from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import {LoomStore} from '../src/core/store.mjs';

function reply(res,delta,reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'investigation-fixture',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}
const tool=(res,id,name,args)=>reply(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
const query=(res,id,request)=>tool(res,id,'loom_query',{request:JSON.stringify(request)});
const command=(res,id,request)=>tool(res,id,'loom_command',{request:JSON.stringify(request)});
const report=(res,id,fields)=>tool(res,id,'loom_report',{report:{...fields,document:{english:'Fixture result.',chinese:'夹具结果。'}}});
const fact='Ledger Bin-B9, version v17';
const missing='registry-index-77no-match';
const batch='original-versioned-batch-31';

for(const disposition of ['continue','pause','cancel']) test(`native read-only investigation after a session miss: ${disposition}`,{skip:!installed,timeout:30000},async()=>{
  let original,foreign,source,search,dispatch,notSearched,wrongProject,wrongVersion,verified,blockedTool,blockedHelp,blockedValue,invocations=0;
  const investigation=Promise.withResolvers(), release=Promise.withResolvers(), continued=Promise.withResolvers(), consumed=Promise.withResolvers();
  const busEntered=Promise.withResolvers(), busRelease=Promise.withResolvers();
  const host=await startupHost(async(wire,_req,res)=>{
    const last=wire.messages.at(-1),text=wireText(last);
    const contents=wire.messages.map(wireText);
    const names=wire.tools?.map(item=>item.function.name) ?? [];
    if(contents.includes('Keep the main coordinator busy')) {busEntered.resolve();await busRelease.promise;return reply(res,{content:'Finished.'});}
    if(names.includes('loom_command')) {
      const reminder=contents.find(value=>value.startsWith('[Loom help reminder]'));
      const {workId,expectedVersion,operationId}=JSON.parse(reminder.split('\n')[1]);
      const pick=(workId,runId,resultVersion)=>({workId,runId,resultVersion,output:'manifest'});
      const select=(id,pin)=>command(res,id,{type:'work.resolveWait',workId,expectedVersion,operationId,action:'investigate',source:pin});
      const pin=pick(source.id,source.result.runId,source.result.version);
      switch(last.tool_call_id) {
        case 'before-search': notSearched=text;return query(res,'search',{kind:'project.sessionSearch',workId,query:missing});
        case 'search': search=JSON.parse(text);if(search.next!==null)return query(res,'search',search.next);
          return select('wrong-project',pick(foreign.id,foreign.result.runId,foreign.result.version));
        case 'wrong-project': wrongProject=text;return select('wrong-version',{...pin,resultVersion:pin.resultVersion+1});
        case 'wrong-version': wrongVersion=text;return select('dispatch',pin);
        case 'dispatch': dispatch=text;return reply(res,{content:'Coordination recorded.'});
        default: return select('before-search',pin);
      }
    }
    if(names.includes('loom_report')) {
      if(contents.some(value=>value.startsWith('[Loom investigation]'))) {
        if(last.tool_call_id==='probe-tools') {
          blockedTool=text;
          return report(res,'probe-help',{kind:'help',summary:'Another investigation',help:{missingInformation:'More',attempted:'Read',expectedEvidence:'More'}});
        }
        if(last.tool_call_id==='probe-help') {blockedHelp=text;return report(res,'probe-output',{kind:'result',summary:'Unconfirmed',outputs:{fact:'invalid fact'}});}
        if(last.tool_call_id==='verified-fact') return reply(res,{content:'Investigation done.'});
        if(last.tool_call_id==='probe-output') {
          blockedValue=text;
          const pinned=JSON.parse(contents.find(value=>value.startsWith('[Loom investigation]')).split('\n').find(line=>line.startsWith('本次输入：')).slice('本次输入：'.length));
          investigation.resolve(wire);
          await release.promise;
          return report(res,'verified-fact',{kind:'result',summary:'Read the pinned manifest',outputs:{fact:pinned.manifest}});
        }
        return tool(res,'probe-tools','fixture_side_effect',{});
      }
      if(contents.some(value=>value.startsWith('任务：Existing accepted ledger'))) return report(res,'ledger',{kind:'result',summary:'Fixture ledger',outputs:{manifest:fact,batch}});
      if(contents.some(value=>value.startsWith('任务：Foreign ledger'))) return report(res,'foreign-ledger',{kind:'result',summary:'Foreign fixture ledger',outputs:{manifest:'Foreign sample'}});
      const downstream=contents.find(value=>value.startsWith('任务：Use the verified manifest'));
      if(downstream!==undefined) {consumed.resolve(downstream);return reply(res,{content:'Consumed the verified manifest.'});}

      const continuation=contents.find(value=>value.includes('求助与交接记录：'));
      if(continuation!==undefined) {
        const manifest=JSON.parse(continuation.split('\n求助与交接记录：')[1]).handoff.information;
        continued.resolve(wire);
        return report(res,'original-result',{kind:'result',summary:'Original work used the ledger',outputs:{manifest}});
      }
      return report(res,'initial-help',{kind:'help',summary:'Dataset manifest needed',help:{missingInformation:'Which manifest is current?',attempted:'Checked the original inputs',expectedEvidence:'An accepted ledger entry'}});
    }
    verified=wire;
    return reply(res,{content:JSON.stringify({passed:true,summary:'Checked fixture result',evidence:['Fixture result evidence']})});
  });
  try {
    const {defineTool}=native('dsh-tools');
    await host.root.plugin({name:'investigation-test-tool',inject:['tools'],apply(ctx){
      ctx.tools.register(defineTool({name:'fixture_side_effect',description:'Fixture tool',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute(){invocations++;return 'executed';}}));
    }}).await();
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
      const {sessionId:busId}=await rpc('ensureBus');
      const workspaceId=host.workspace.id;
      const get=async workId=>(await rpc('query',{kind:'work',workId})).items[0];
      const runs=async workId=>(await rpc('query',{kind:'run',workId})).items;
      const until=async(f,label)=>{
        for(let i=0;i<180;i++){const value=await f();if(value)return value;await delay(40);}
        assert.fail(`${label}; coordinator reply: ${dispatch}`);
      };
      async function create(project,title,fields={}) {
        const work=await rpc('command',{type:'work.create',workspaceId:project,title,model:testModel,...fields});
        return rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
      }
      async function accepted(project,title,names) {
        const work=await create(project,title,{outputs:names.map(name=>({name,required:true}))});
        const finished=await until(async()=>{const value=await get(work.id);return value.status==='review' && value;},title);
        return rpc('command',{type:'work.accept',workId:work.id,expectedVersion:finished.version,runId:finished.result.runId});
      }
      const otherPath=join(host.directory,'other');await mkdir(otherPath);
      const other=(await host.ctx.workspaceController.create({path:otherPath})).workspace.workspaceId;
      foreign=await accepted(other,'Foreign ledger',['manifest']);
      source=await accepted(workspaceId,'Existing accepted ledger',['manifest','batch']);
      await rpc('command',{type:'workspace.setKnowledge',workspaceId,knowledge:'Private project prompt content'});
      if(disposition==='continue') {
        const {createUserMessage}=native('dsh-llm');
        host.ctx.agents.get(busId).followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Keep the main coordinator busy'}]}));
        await deadline(busEntered.promise,'main coordinator is busy');
      }
      original=await create(workspaceId,'Resolve original manifest',{outputs:[{name:'manifest',required:true}],inputs:{checksum:{kind:'value',value:'original-17'},
        batch:{kind:'result',workId:source.id,output:'batch'}}});
      if(disposition==='continue') {
        await until(async()=>(await get(original.id)).status==='waiting','A is queued for coordination');
        await rpc('tick');
        const {items}=await rpc('query',{kind:'event',workId:original.id});
        assert.equal(items.some(event=>event.type==='work.waitCoordination'),false);
        busRelease.resolve();
      }
      await until(()=>dispatch,'coordinator decision');
      assert.match(dispatch,/"investigation"/,JSON.stringify({dispatch,search,notSearched,wrongProject,wrongVersion}));
      assert.deepEqual(search.items,[]);
      assert.match(notSearched,/查找|搜索/);
      assert.match(wrongProject,/来源|项目/);
      assert.match(wrongVersion,/版本/);
      const childId=JSON.parse(dispatch).wait.investigation.workId;
      await until(async()=>{
        if(blockedValue!==undefined) return true;
        const {engine}=await rpc('status');
        assert.equal(engine.error,null,JSON.stringify(engine.error));
        const [run]=await runs(childId);
        if(run?.finishedAt) assert.fail(JSON.stringify({run,wire:host.received.slice(-2).map(w=>w.messages.map(wireText))}));
        return false;
      },'isolated native investigation');
      const wire=await deadline(investigation.promise,'isolated native investigation');
      const prompt=wire.messages.map(wireText).join('\n');
      assert.deepEqual(wire.tools.map(item=>item.function.name),['loom_report']);
      assert.doesNotMatch(prompt,/Private project prompt content|original-17|Foreign sample|original-versioned-batch-31/);
      assert.match(prompt,/Ledger Bin-B9, version v17/);
      assert.ok(verified,'ordinary work reached pre-acceptance');
      assert.match(blockedTool,/仅接受所属原生轮次的 loom_report/);
      assert.match(blockedHelp,/协查|result/);
      assert.match(blockedValue,/一致|证据/);
      const originalWait=await get(original.id);
      const related=(await rpc('query',{kind:'work',workspaceId})).items.filter(work=>work.investigation?.parentWorkId===original.id);
      assert.equal(related.length,1);
      const [child]=related;
      assert.equal(originalWait.wait.investigation.workId,child.id);
      const [bRun]=await runs(child.id),[aRun]=await runs(original.id);
      assert.equal(aRun.status,'waiting');
      assert.notEqual(bRun.sessionId,aRun.sessionId);
      assert.notEqual(bRun.sessionId,source.sessionId);
      assert.notEqual(bRun.sessionId,busId);
      assert.ok(host.workspace.sessionIds.includes(bRun.sessionId));
      assert.equal(bRun.permissionPreset,null);
      assert.deepEqual(bRun.inputs,{manifest:fact});
      assert.deepEqual(bRun.consumedResults,[{inputName:'manifest',workId:source.id,runId:source.result.runId,resultVersion:source.result.version,output:'manifest',path:[],value:fact}]);
      if(disposition==='pause') await rpc('command',{type:'work.pause',workId:original.id,expectedVersion:originalWait.version});
      if(disposition==='cancel') {
        host.ctx.on('session/event',(session,event)=>{
          if(session.id!==bRun.sessionId || event.type!=='turn/end') return;
          const db=new LoomStore(join(directory,'loom.sqlite'));
          try {db.command({type:'work.cancel',workId:original.id,expectedVersion:originalWait.version},{kind:'user'});}
          finally {db.close();}
        });
      }
      release.resolve();
      const finished=await until(async()=>{const [value]=await runs(child.id);return ['completed','failed'].includes(value.status) && value;},'investigation run settlement');
      const bEvents=host.ctx.agents.get(bRun.sessionId).session.snapshotEvents();
      const received=bEvents.find(event=>event.type==='tool/result' && event.data.message.toolCallId==='verified-fact');
      assert.ok(received,'read back the native result');
      assert.equal(received.data.message.isError,disposition==='pause');
      assert.equal(invocations,0);
      if(disposition==='continue') {
        assert.equal(finished.outputs.fact,fact);
        const resumed=await deadline(continued.promise,'A receives the verified fact');
        assert.match(resumed.messages.map(wireText).join('\n'),/Ledger Bin-B9, version v17/);
        assert.match(resumed.messages.map(wireText).join('\n'),/original-17/);
        const all=await runs(original.id);
        assert.equal(all.length,2);
        const [,resumedRun]=all;
        assert.equal(resumedRun.sessionId,aRun.sessionId);
        assert.equal(resumedRun.operationId,aRun.operationId);
        assert.deepEqual(resumedRun.inputs,aRun.inputs);
        assert.deepEqual(resumedRun.consumedResults,aRun.consumedResults);
        assert.equal(resumedRun.consumedResults[0].value,batch);
        const proof=resumedRun.wait.handoff.investigation;
        assert.deepEqual(proof.source,{workId:source.id,runId:source.result.runId,resultVersion:source.result.version,output:'manifest'});
        assert.equal(proof.runId,bRun.id);
        assert.equal(proof.sessionId,bRun.sessionId);
        assert.equal(proof.eventSeq,received.seq);
        assert.equal(resumedRun.wait.handoff.actor.kind,'host');
        assert.ok(host.ctx.agents.get(aRun.sessionId).session.snapshotEvents().some(event=>event.type==='user/message' && event.data.source.rpcId===resumedRun.requestId));
        const dependent=await create(workspaceId,'Use the verified manifest',{inputs:{manifest:{kind:'result',workId:original.id,output:'manifest'}}});
        const deliverable=await until(async()=>{const value=await get(original.id);return value.status==='review' && value;},'A produces the manifest');
        assert.deepEqual(deliverable.result.outputs,{manifest:fact});
        assert.equal(deliverable.result.runId,resumedRun.id);
        assert.equal((await runs(dependent.id)).length,0);
        await rpc('command',{type:'work.accept',workId:original.id,expectedVersion:deliverable.version,runId:resumedRun.id});
        const used=await deadline(consumed.promise,'downstream receives A’s manifest');
        assert.ok(used.includes(`本次输入：${JSON.stringify({manifest:fact})}`));
        const [consumerRun]=await runs(dependent.id);
        assert.deepEqual(consumerRun.consumedResults,[{inputName:'manifest',workId:original.id,runId:resumedRun.id,
          resultVersion:deliverable.result.version,output:'manifest',path:[],value:fact}]);
      } else {
        const current=await get(original.id);
        assert.equal(current.status,disposition==='pause'?'paused':'cancelled');
        assert.equal(finished.status,'failed');
        assert.equal(current.wait.handoff,undefined);
        assert.equal((await runs(original.id)).length,1);
      }
    } finally {await peer.dispose();}
  } finally {release.resolve();busRelease.resolve();await host.close();}
});
