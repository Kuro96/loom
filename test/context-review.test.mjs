import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed, native } from './context-native-helper.mjs';
import { startupHost, testModel } from './host-native-helper.mjs';
import { createLoomContext } from '../src/context/index.mjs';

test('periodic review sends one historical region and uses its checkpoint in the next bus request',{skip:!installed},async()=>{
  const summary={summary:'Use project B.',constraints:[],unresolved:[],references:[]};
  const host=await startupHost((body,_req,res)=>{
    const content=body.tools?'OK':JSON.stringify(summary);
    const frame=(delta,finish_reason)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(frame({content},null)+frame({},'stop')+'data: [DONE]\n\n');
  });
  let manager;
  try {
    const context={reviewEverySteps:2};
    manager=await createLoomContext(host.ctx,{directory:join(host.directory,'loom'),workspaceId:host.workspace.id,getSettings:()=>({roleModels:{bus:testModel},context})});
    const agent=host.ctx.agents.get((await manager.ensureBus()).sessionId);
    const user=text=>native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text}]});
    const old=user('Use the second project. '.repeat(40)),latest=user('Continue the work');
    agent.followup(old);await agent.whenIdle();
    assert.equal(host.received.length,1);
    agent.followup(latest);await agent.whenIdle();
    assert.equal(host.received.length,3);
    const [,review,main]=host.received;
    const {history}=JSON.parse(review.messages.find(m=>m.role==='user').content);
    assert.deepEqual(history,[old]);
    const replacements=agent.session.snapshotEvents().filter(event=>event.type==='user/message' && event.surfaceOp?.op==='replace');
    assert.equal(replacements.length,1);
    assert.ok(main.messages.some(m=>m.content===replacements[0].data.content[0].text && m.content.includes(summary.summary)));
    assert.deepEqual(agent.session.deriveMessages().filter(m=>m.id===latest.id),[latest]);
    assert.equal(manager.getStatus().pending,false);
    context.segmentMaxEvents=1;
    context.checkpointMaxBytes=128;
    const nextSegment=host.ctx.agents.get((await manager.ensureBus()).sessionId);
    const handover=nextSegment.session.snapshotEvents().find(e=>e.type==='plugin:dsh-loom/handover');
    const memory=JSON.parse(handover.data.message.content[0].text.split('\n').slice(1).join('\n'));
    assert.equal(memory.summary?.summary,summary.summary);
    assert.equal(memory.focus.latestIntent,'Continue the work');
  } finally {if(manager)await manager.dispose();await host.close();}
});
