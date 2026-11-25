import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installed, native } from './context-native-helper.mjs';
import { deadline, startupHost, wireText } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import { LoomStore } from '../src/core/store.mjs';

function reply(res, delta, reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'wait-fixture',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}
const tool=(res,id,name,args)=>reply(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');

for (const scenario of ['related','original','retry','missing','help']) test(`external wait coordination: ${scenario}`, {skip:!installed,timeout:30000}, async t => {
  const found=scenario!=='missing';
  const help=scenario==='help';
  const phrase=help?'dataset manifest':'receipt-R17', clue=help?'dataset manifest verified in project ledger Bin-B9':'receipt-R17 moved to project ledger Bin-B9', foreign=`${phrase} unrelated project ledger Bin-X7`;
  let work, firstWorker, clueSession, otherSession, otherWork, searchReply, busInput, unexpectedCommand, crossProject, allWorks, chosen, foreignEvidence, rejected=false;
  const pages=[];
  if(scenario==='retry') t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const worker=Promise.withResolvers();
  const downstream=Promise.withResolvers();
  const mainEntered=Promise.withResolvers(), releaseMain=Promise.withResolvers();
  const host=await startupHost(async(wire,_req,res)=>{
    const message=wire.messages.at(-1), text=wireText(message);
    const names=wire.tools?.map(item=>item.function.name) ?? [];
    if(wire.messages.some(item=>wireText(item)==='Hold the visible coordinator')) {
      mainEntered.resolve();await releaseMain.promise;
      return reply(res,{content:'Visible coordinator finished.'});
    }
    if(names.includes('loom_report')) {
      const input=wire.messages.filter(item=>item.role==='user').map(wireText).findLast(content=>content.startsWith('任务：'));
      if(input?.startsWith('任务：Consume verified manifest')) {
        downstream.resolve(input);
        return reply(res,{content:'Manifest consumed.'});
      }
      if(!firstWorker) {
        firstWorker=wire;
        if(help) return tool(res,'initial-help','loom_report',{report:{kind:'help',summary:'Dataset version needed',document:{english:'Dataset version needed.',chinese:'缺少数据集版本。'},help:{missingInformation:'Which dataset manifest is current?',attempted:'Checked the input list',expectedEvidence:'A version and its ledger entry'}}});
        return tool(res,'initial-uncertain','loom_report',{report:{kind:'uncertain',summary:'Original receipt location missing',document:{english:'The original location is obsolete.',chinese:'原位置停用。'},uncertainty:{operationId:work.id,remoteRef:phrase,reason:'Original location is obsolete',attempted:'Checked the original work conversation',missingInformation:'Where is the active receipt ledger?'}}});
      }
      worker.resolve(wire);
      if(help) {
        const record=input.split('\n').find(line=>line.startsWith('求助与交接记录：'));
        const {handoff}=JSON.parse(record.slice('求助与交接记录：'.length));
        const manifest=(handoff.evidence?.[0].snippet??handoff.information).match(/ledger (Bin-\w+)/)[1];
        return tool(res,'manifest-result','loom_report',{report:{kind:'result',summary:`Manifest verified in ${manifest}`,document:{english:`Manifest verified in ${manifest}.`,chinese:`已在 ${manifest} 核对清单。`},outputs:{manifest}}});
      }
      return reply(res,{content:'Read the original operation.'});
    }
    if(wire.messages.some(item=>wireText(item).includes('Independently pre-evaluate'))) {
      return reply(res,{content:JSON.stringify({passed:true,summary:'Checked the manifest',evidence:['manifest Bin-B9']})});
    }
    if(wireText(wire.messages[0]).startsWith('Loom context review.')) return reply(res,{content:JSON.stringify({summary:'Receipt coordination in progress.',constraints:[],unresolved:[],references:[]})});
    if(!names.includes('loom_command')) return reply(res,{content:'Recorded.'});
    if(message.role!=='tool') {
      busInput=wire.messages.map(wireText).find(content=>/^\[Loom (?:help|external-wait) reminder\]/.test(content));
      return tool(res,'unrelated-command','loom_command',{request:JSON.stringify({type:'work.create',workspaceId:work.workspaceId,title:'Unrelated fixture work'})});
    }
    if(message.tool_call_id==='unrelated-command') {
      unexpectedCommand=text;
      return tool(res,'cross-project','loom_query',{request:JSON.stringify({kind:'project.sessionSearch',workId:otherWork.id,query:phrase})});
    }
    if(message.tool_call_id==='cross-project') {
      crossProject=text;
      return tool(res,'work-list','loom_query',{request:JSON.stringify({kind:'work'})});
    }
    if(message.tool_call_id==='work-list') {
      allWorks=text;
      return tool(res,'lookup-receipt','loom_query',{request:JSON.stringify({kind:'project.sessionSearch',workId:work.id,query:phrase})});
    }
    const resolve=(id,match,source)=>tool(res,id,'loom_command',{request:JSON.stringify({type:'work.resolveWait',workId:work.id,
      expectedVersion:searchReply.workVersion,operationId:work.id,action:match?'continue':'ask',
      sources:[source??(match?.source??(match?`DSH ${match.sessionId} event ${match.eventSeq}`:'Project knowledge; project session search for receipt-R17 found no indexed hit'))],
      ...(match?{information:match.snippet}:{missingInformation:'Which ledger now contains the R17 receipt?'})})});
    if(message.tool_call_id==='foreign-evidence') {
      foreignEvidence=text;
      return resolve('resolve-receipt',chosen);
    }
    if(message.tool_call_id.startsWith('lookup-receipt')) {
      if(!text.startsWith('{')) {searchReply={error:text};return reply(res,{content:'Search failed.'});}
      searchReply=JSON.parse(text);
      pages.push(searchReply);
      const match=searchReply.items.find(item=>item.sessionId===clueSession && item.snippet.includes('Bin-B9'));
      if(!match && searchReply.next) return tool(res,`lookup-receipt-${searchReply.next.beforeSeq ?? searchReply.next.offset}`,'loom_query',{request:JSON.stringify(searchReply.next)});
      chosen=match;
      return help && match ? resolve('foreign-evidence',match,`DSH ${otherSession} event ${match.eventSeq}`) : resolve('resolve-receipt',match);
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
      if(scenario==='retry') host.ctx.on('agent/pre-step',(step,next)=>{
        if(!rejected && step.messages.some(message=>message.source.kind==='loom-external-wait')) {
          rejected=true; t.mock.timers.setTime(Date.now()+61000);
          return {kind:'reject'};
        }
        return next();
      });
      const otherPath=join(host.directory,'other');
      await mkdir(otherPath);
      const other=(await host.ctx.workspaceController.create({path:otherPath})).workspace.workspaceId;
      async function note(project,...notes) {
        const {sessionId}=await host.ctx.sessionController.create({workspaceId:project});
        for(const [index,text] of notes.entries()) {
          await host.ctx.sessionController.prompt({sessionId,requestId:`note-${project}-${index}`,mode:'queue',content:[{type:'text',text}]},AbortSignal.timeout(5000));
          await deadline(host.ctx.agents.get(sessionId).whenIdle(),'seed source conversation');
        }
        return sessionId;
      }
      otherSession=await note(other,foreign);
      const fixtures=new LoomStore(join(directory,'loom.sqlite'));
      const user={kind:'user'};
      try {
        otherWork=await rpc('command',{type:'work.create',workspaceId:other,title:'Other-project private fixture'});
        fixtures.command({type:'work.confirm',workId:otherWork.id,expectedVersion:otherWork.version},user);
        const run=fixtures.reserveRun(otherWork.id),due=new Date(Date.now()+3600000).toISOString();
        fixtures.reportRun(run.id,{kind:'wait',summary:'Foreign fixture',wait:{operationId:otherWork.id,remoteRef:phrase,condition:'ready',nextCheckAt:due}},{sessionId:run.sessionId,requestId:run.requestId,turn:1,callId:'foreign'});
        fixtures.settleReport(run.id,{callId:'foreign',eventCursor:0,coordinate:true});
        fixtures.claimExternalWait(otherWork.id,fixtures.getWork(otherWork.id).version,due);
      } finally {fixtures.close();}
      if(found) clueSession=await note(workspaceId,clue,...(scenario==='related'?Array.from({length:6},(_,i)=>`${phrase} any update? ${i}`):[]));
      if(help) {
        const {createUserMessage}=native('dsh-llm');
        host.ctx.agents.get(busId).followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Hold the visible coordinator'}]}));
        await deadline(mainEntered.promise,'visible coordinator reached provider');
      }
      work=await rpc('command',{type:'work.create',workspaceId,title:'Check the original shipment receipt',inputs:{checksum:{kind:'value',value:'sample-17'}},
        ...(help?{outputs:[{name:'manifest',required:true}]}:{}),...(scenario==='original'?{sessionId:clueSession}:{})});
      work=await rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
      const fetchWork=async()=>(await rpc('query',{kind:'work',workId:work.id})).items[0];
      const until=async predicate=>{for(let i=0;i<180;i++){const value=await fetchWork();if(predicate(value))return value;assert.ok(!searchReply?.error,searchReply?.error);if(found && value.status==='paused')break;await delay(50);}assert.fail(`The coordinator did not settle the wait: ${JSON.stringify(pages)}`);};
      if(help) {
        await until(value=>value.wait?.kind==='help');
        for(let cycle=0;cycle<5;cycle++) {await rpc('tick');await delay(40);}
        assert.notEqual(host.ctx.agents.get(busId).status,'idle');
        const events=(await rpc('query',{kind:'event',workId:work.id})).items;
        assert.equal(events.filter(event=>event.type==='work.waitCoordination').length,0,'hold the original queue while the main coordinator is busy');
        assert.equal((await fetchWork()).status,'waiting');
        releaseMain.resolve();
        await deadline(host.ctx.agents.get(busId).whenIdle(),'visible coordinator released');
      }
      if(found) {
        await until(value=>value.wait?.handoff?.information);
        const resumed=await deadline(worker.promise,'worker receives coordinator handoff',9000);
        assert.match(resumed.messages.map(wireText).join('\n'),/project ledger Bin-B9/);
        const runs=(await rpc('query',{kind:'run',workId:work.id})).items;
        assert.equal(runs.length,2);
        assert.equal(runs[1].sessionId,runs[0].sessionId);
        assert.equal(runs[1].operationId,runs[0].operationId);
        assert.equal(runs[1].inputs.checksum,runs[0].inputs.checksum);
        const coordinatorId=runs[1].wait.handoff.actor.sessionId;
        assert.notEqual(coordinatorId,busId);
        assert.ok(host.workspace.sessionIds.includes(coordinatorId));
        if(help) {
          const events=(await rpc('query',{kind:'event',workId:work.id})).items;
          assert.equal(events.filter(event=>event.type==='work.waitCoordination').length,1);
          assert.equal(runs[1].wait.kind,'help');
          assert.equal(runs[1].wait.help.expectedEvidence,'A version and its ledger entry');
          assert.equal(runs[1].wait.source.callId,'initial-help');
          assert.equal(Object.hasOwn(runs[1].wait,'remoteRef'),false);
          assert.match(foreignEvidence,/本轮查到|已失效/);
          const evidence={sessionId:chosen.sessionId,eventSeq:chosen.eventSeq,snippet:chosen.snippet};
          assert.deepEqual(runs[1].wait.handoff.evidence,[evidence]);
          assert.ok(resumed.messages.filter(item=>item.role==='user').some(item=>wireText(item).includes(JSON.stringify(evidence))));
          const decisions=events.filter(event=>event.type==='work.resolveWait');
          assert.equal(decisions.length,1);
          assert.deepEqual(decisions[0].detail.evidence,[evidence]);
          const finished=await until(value=>value.status==='review');
          assert.deepEqual(finished.result.outputs,{manifest:'Bin-B9'});
          assert.equal(finished.result.runId,runs[1].id);
          const local=await rpc('nativeSessions',{workspaceId});
          const global=await rpc('nativeSessions');
          assert.ok(local.items.some(({sessionId})=>sessionId===clueSession));
          assert.ok(local.items.every(({sessionId})=>sessionId!==coordinatorId));
          assert.ok(global.every(({sessionId})=>sessionId!==coordinatorId));
          await assert.rejects(rpc('command',{type:'work.create',workspaceId,sessionId:coordinatorId,title:'Invalid work association'}),/协调会话不能关联为执行会话/);
        }
      } else {
        const paused=await until(value=>value.status==='paused');
        assert.equal(paused.wait.missingInformation,'Which ledger now contains the R17 receipt?');
        assert.match(paused.wait.attempted,/project session search/);
        assert.equal((await rpc('query',{kind:'run',workId:work.id})).total,1);
      }
      assert.ok(busInput,'Loom automatically prompted the coordinator');
      assert.match(crossProject,/本项目|当前外部操作/);
      assert.doesNotMatch(crossProject,/Bin-X7/);
      assert.deepEqual(JSON.parse(allWorks).items.map(item=>item.id),[work.id]);
      assert.match(unexpectedCommand,/自动复查只能处理当前外部操作/);
      assert.equal((await rpc('query',{kind:'work',workspaceId})).total,1);
      if(help) {
        const input={kind:'result',workId:work.id,output:'manifest'};
        let consumer=await rpc('command',{type:'work.create',workspaceId,title:'Consume verified manifest',inputs:{manifest:input}});
        consumer=await rpc('command',{type:'work.confirm',workId:consumer.id,expectedVersion:consumer.version});
        assert.equal((await rpc('query',{kind:'run',workId:consumer.id})).total,0);
        const ready=await fetchWork();
        await rpc('command',{type:'work.accept',workId:work.id,expectedVersion:ready.version,runId:ready.result.runId});
        assert.match(await deadline(downstream.promise,'downstream receives the verified manifest'),/本次输入：\{"manifest":"Bin-B9"\}/);
        const {items:[consumed]}=await rpc('query',{kind:'run',workId:consumer.id});
        assert.equal(consumed.consumedResults.length,1);
        assert.equal(consumed.consumedResults[0].runId,ready.result.runId);
        assert.equal(consumed.consumedResults[0].resultVersion,ready.result.version);
        assert.equal(consumed.consumedResults[0].value,'Bin-B9');
      }
      assert.ok(searchReply,'The coordinator read the native project search result');
      if(scenario==='related') {
        assert.ok(pages.length>1 && pages[0].next.beforeSeq!==undefined);
        assert.ok(pages.at(-1).items.some(item=>item.snippet.includes('Bin-B9')));
      }
      if(scenario==='retry') {
        assert.equal(rejected,true);
        assert.equal((await rpc('status')).context.pending,false);
        const events=(await rpc('query',{kind:'event',workId:work.id})).items;
        assert.deepEqual(events.filter(event=>event.type==='work.waitCoordination').map(event=>event.detail.attempt),[1,2]);
      }
      assert.ok(!searchReply.items.some(item=>item.sessionId===otherSession));
      assert.doesNotMatch(JSON.stringify(searchReply),/Bin-X7/);
      const before=await fetchWork();
      const unauthenticated={type:'work.resolveWait',workId:work.id,expectedVersion:before.version,operationId:work.id,action:'continue',sources:['Project records'],information:'Read again'};
      const method='loom/command';
      const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload:unauthenticated})}),peer)).json();
      assert.equal(result.error.code,'FORBIDDEN');
    } finally {await peer.dispose();}
  } finally {releaseMain.resolve();await host.close();}
});
