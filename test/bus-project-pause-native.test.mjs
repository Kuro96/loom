import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {installed} from './context-native-helper.mjs';
import {startupHost,testModel,wireText} from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import {LoomStore} from '../src/core/store.mjs';

function reply(res,delta,reason='stop') {
  const chunk=choices=>`data: ${JSON.stringify({id:'project-pause-fixture',object:'chat.completion.chunk',choices})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk([{index:0,delta,finish_reason:null}])+chunk([{index:0,delta:{},finish_reason:reason}])+'data: [DONE]\n\n');
}
const tool=(res,id,name,args)=>reply(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
const report=(res,id,fields)=>tool(res,id,'loom_report',{report:{...fields,document:{english:'Fixture report.',chinese:'夹具报告。'}}});

test('owner project pause queues automatic coordination while ordinary work and another project progress',{skip:!installed,timeout:30000},async()=>{
  const host=await startupHost((wire,_req,res)=>{
    const messages=wire.messages.map(wireText), names=wire.tools?.map(item=>item.function.name) ?? [];
    if(wire.messages.at(-1).role==='tool') return reply(res,{content:'Recorded.'});
    if(names.includes('loom_command')) {
      const {workId,operationId,expectedVersion}=JSON.parse(messages.findLast(text=>text.startsWith('[Loom help reminder]')).split('\n')[1]);
      return tool(res,'ask','loom_command',{request:JSON.stringify({type:'work.resolveWait',workId,operationId,expectedVersion,action:'ask',
        sources:['Project ledger'],missingInformation:'Which ledger is current?'})});
    }
    if(names.includes('loom_report')) {
      if(messages.some(text=>text.startsWith('任务：Find the current ledger'))) return report(res,'help',{kind:'help',summary:'Ledger needed',
        help:{missingInformation:'Which ledger is current?',attempted:'Read project notes',expectedEvidence:'A ledger revision'}});
      return report(res,'ordinary',{kind:'result',summary:'Ordinary work finished',outputs:{}});
    }
    return reply(res,{content:JSON.stringify({passed:true,summary:'Checked the result',evidence:['Fixture result']})});
  });
  try {
    const directory=join(host.directory,'loom'), workspaceId=host.workspace.id;
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
      const get=async workId=>(await rpc('query',{kind:'work',workId})).items[0];
      const project=async()=>(await rpc('snapshot',{workspaceId})).workspaces.find(row=>row.workspaceId===workspaceId);
      const setPaused=(paused,expectedVersion)=>rpc('command',{type:'workspace.setCoordinationPaused',workspaceId,paused,expectedVersion});
      const claims=async workId=>(await rpc('query',{kind:'event',workId})).items.filter(event=>event.type==='work.waitCoordination');
      const until=async(f,label)=>{
        for(let i=0;i<160;i++){const value=await f();if(value)return value;await delay(40);}
        assert.fail(label);
      };
      async function create(project,title) {
        const work=await rpc('command',{type:'work.create',workspaceId:project,title,model:testModel});
        return rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
      }
      await rpc('ensureBus');
      const otherPath=join(host.directory,'other');await mkdir(otherPath);
      const other=(await host.ctx.workspaceController.create({path:otherPath})).workspace.workspaceId;
      const initial=await project();
      assert.equal(initial.coordinationPaused,false);
      const paused=await setPaused(true,initial.version);
      assert.equal(paused.version,initial.version+1);
      const reopened=new LoomStore(join(directory,'loom.sqlite'));
      try {assert.deepEqual(reopened.query({kind:'workspace',workspaceId}).items,[paused]);}
      finally {reopened.close();}
      const original=await create(workspaceId,'Find the current ledger for this project');
      const foreign=await create(other,'Find the current ledger for the other project');
      const ordinary=await create(workspaceId,'Write an ordinary result');
      await until(async()=>(await get(ordinary.id)).status==='review','ordinary ready work still runs in the paused project');
      await until(async()=>(await get(foreign.id)).status==='paused','the other project settles its coordination decision');
      await rpc('tick');
      assert.equal((await claims(foreign.id)).length,1);
      assert.equal((await claims(original.id)).length,0,'the paused project must not claim a new help request');
      assert.equal((await get(original.id)).status,'waiting');
      assert.deepEqual(await project(),{...initial,coordinationPaused:true,version:paused.version});
      const resumed=await setPaused(false,paused.version);
      assert.equal(resumed.version,paused.version+1);
      await until(async()=>(await get(original.id)).status==='paused','explicit resume enables the queued coordination action');
      assert.equal((await claims(original.id)).length,1);
      assert.deepEqual(await project(),{...initial,coordinationPaused:false,version:resumed.version});
      const {items}=await rpc('query',{kind:'event',workspaceId});
      assert.deepEqual(items.filter(event=>event.type==='workspace.setCoordinationPaused').map(({actor,detail})=>({actor,detail})),[
        {actor:{kind:'user'},detail:{version:paused.version,coordinationPaused:true}},
        {actor:{kind:'user'},detail:{version:resumed.version,coordinationPaused:false}},
      ]);
    } finally {await peer.dispose();}
  } finally {await host.close();}
});
