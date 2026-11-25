import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {installed} from './context-native-helper.mjs';
import {deadline,startupHost,testModel,wireText} from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';
import {LoomStore} from '../src/core/store.mjs';

const gitURL='https://api.github.com/repos/Kuro96/loom/git/ref/heads/main';
const fixtureSha='a'.repeat(40);
function stream(res,delta,reason='stop') {
  const chunk=(data,finish_reason)=>`data: ${JSON.stringify({id:'resource-pilot',object:'chat.completion.chunk',choices:[{index:0,delta:data,finish_reason}]})}\n\n`;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(chunk(delta,null)+chunk({},reason)+'data: [DONE]\n\n');
}
const tool=(res,id,name,args)=>stream(res,{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
const report=(res,id,fields)=>tool(res,id,'loom_report',{report:{...fields,document:{english:fields.summary,chinese:'核对发布分支。'}}});
const args=request=>({request:JSON.stringify(request)});

for(const scenario of ['fixture','live','scope','other-work','missing','denied','limited','unavailable','interrupted']) {
 const live=scenario==='live', found=live || scenario==='fixture', hasGrant=scenario!=='scope';
 test(`coordination reads a configured GitHub ref: ${scenario}`,{skip:!installed || (live && process.env.LOOM_LIVE_READ_PILOT!=='1'),timeout:30000},async t=>{
  let lookup,commandResult,work,scopeError,reminder,forged,plainSource;const reads=[];
  const resumed=Promise.withResolvers();
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,init)=>{
    if(String(url)!==gitURL) return fetch(url,init);
    reads.push({url:String(url),method:init.method,redirect:init.redirect});
    if(live) return fetch(url,init);
    if(found || scenario==='other-work') return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:fixtureSha}});
    if(scenario==='interrupted') return new Response(new ReadableStream({start(controller){controller.error(new TypeError('Response body interrupted'));}}),{status:503});
    const status={missing:404,denied:403,limited:403,unavailable:503}[scenario];
    return new Response(null,{status,headers:scenario==='limited'?{'x-ratelimit-remaining':'0'}:{}});
  });
  const host=await startupHost((wire,_req,res)=>{
    const last=wire.messages.at(-1), text=wireText(last), messages=wire.messages.map(wireText);
    const names=wire.tools?.map(item=>item.function.name)??[];
    if(names.includes('loom_report')) {
      const handoff=messages.flatMap(s=>s.split('\n')).find(s=>s.startsWith('现有外部操作记录：'));
      if(!handoff) return report(res,'initial-wait',{kind:'uncertain',summary:'Need the remote branch head',uncertainty:{operationId:work.id,remoteRef:'github:Kuro96/loom@main',reason:'Source not in the work transcript',attempted:'Checked current inputs',missingInformation:'Which commit is on the release branch?'}});
      if(last.tool_call_id==='verified-head') return stream(res,{content:'Recorded.'});
      const evidence=JSON.parse(handoff.slice('现有外部操作记录：'.length)).handoff.evidence?.[0];
      if(evidence===undefined) return stream(res,{content:'No branch receipt supplied.'});
      resumed.resolve(evidence);
      return report(res,'verified-head',{kind:'result',summary:'Verified the release branch',outputs:{head:evidence.sha}});
    }
    if(names.includes('loom_command')) {
      if(last.role!=='tool') {
        reminder=messages.find(s=>s.startsWith('[Loom external-wait reminder]'));
        const foreign={kind:'project.githubRef',workId:work.id,workspaceId:'unrelated'};
        return tool(res,'foreign-scope','loom_query',args(foreign));
      }
      if(last.tool_call_id==='foreign-scope') {
        scopeError=text;
        return tool(res,'source','loom_query',args({kind:'project.githubRef',workId:work.id}));
      }
      if(last.tool_call_id==='source') {
        lookup=text.startsWith('{') ? JSON.parse(text) : text;
        const {expectedVersion,operationId}=JSON.parse(reminder.split('\n')[1]);
        const decision={type:'work.resolveWait',workId:work.id,expectedVersion,operationId};
        if(scenario==='missing') return tool(res,'plain-source','loom_command',args({...decision,action:'continue',sources:['Old release notes'],information:'Use the guessed head.'}));
        if(lookup.status==='found') return tool(res,'forged','loom_command',args({...decision,action:'continue',sources:['GitHub Other/demo refs/heads/main'],information:'Wrong branch'}));
        return tool(res,'resolve','loom_command',args(lookup.status==='unavailable'
          ?{...decision,action:'wait',sources:['Release branch read'],condition:'分支查询可用',checkMethod:'复查已配置的发布分支',nextCheckAt:new Date(Date.now()+60000).toISOString()}
          :{...decision,action:'ask',sources:['Release branch read'],missingInformation:'需要确认发布分支。'}));
      }
      if(last.tool_call_id==='plain-source') {
        plainSource=text;
        const {expectedVersion,operationId}=JSON.parse(reminder.split('\n')[1]);
        return tool(res,'resolve','loom_command',args({type:'work.resolveWait',workId:work.id,expectedVersion,operationId,
          action:'ask',sources:['Release branch read'],missingInformation:'需要确认发布分支。'}));
      }
      if(last.tool_call_id==='forged') {
        forged=text;
        const {expectedVersion,operationId}=JSON.parse(reminder.split('\n')[1]);
        return tool(res,'resolve','loom_command',args({type:'work.resolveWait',workId:work.id,expectedVersion,operationId,
          action:'continue',sources:[lookup.source],information:'Claim from coordinator must not replace the observed SHA'}));
      }
      commandResult=text;
      return stream(res,{content:'Lookup recorded.'});
    }
    return stream(res,{content:JSON.stringify({passed:true,summary:'Readback checked',evidence:['Branch head observed']})});
  });
  try {
    const directory=join(host.directory,'loom'),workspaceId=host.workspace.id;
    await mkdir(directory,{recursive:true});
    const fixture=new LoomStore(join(directory,'loom.sqlite'));
    let operationId;
    try {
      fixture.syncWorkspaces([{workspaceId,path:host.workspace.path,title:'Loom pilot'}]);
      const owner={kind:'user'};
      const create=()=>fixture.command({type:'work.create',workspaceId,model:testModel,title:'Verify Loom release branch',outputs:[{name:'head',required:true}]},owner);
      work=create();
      operationId=scenario==='other-work'?create().id:work.id;
    } finally {fixture.close();}
    await host.root.plugin(bootstrap,{directory}).await();
    await host.root.plugin(loom,{directory,intervalMs:40,...(hasGrant?{githubRef:{workspaceId,operationId,repository:'Kuro96/loom',branch:'main'}}:{})}).await();
    const peer=host.ctx.connection.createPeer({principal:{kind:'owner'}});
    try {
      const route=host.ctx.connection.createSharedFetchHandler('/api');
      async function rpc(endpoint,payload={}) {
        const method=`loom/${endpoint}`;
        const {result}=await (await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:method,method,payload})}),peer)).json();
        assert.equal(result.ok,true,JSON.stringify(result));return result.value;
      }
      await rpc('command',{type:'work.confirm',workId:work.id,expectedVersion:work.version});
      async function waitFor(predicate) {
        for(let i=0;i<180;i++){const value=predicate(await rpc('query',{kind:'work',workId:work.id}));if(value) return value;await delay(40);}
        assert.fail(JSON.stringify({lookup,commandResult,scopeError}));
      }
      await waitFor(()=>lookup);
      assert.match(scopeError,/本项目|当前外部操作/);
      if(!found) {
        const status={scope:'forbidden','other-work':'forbidden',missing:'not_found',denied:'forbidden',limited:'unavailable',unavailable:'unavailable',interrupted:'unavailable'}[scenario];
        assert.equal(lookup.status,status,JSON.stringify(lookup));
        assert.equal(reads.length,hasGrant && scenario!=='other-work'?1:0);
        if(status==='unavailable') await waitFor(({items:[item]})=>item.status==='waiting' && item.wait.checkMethod==='复查已配置的发布分支');
        else await waitFor(({items:[item]})=>item.status==='paused');
        if(scenario==='missing') assert.match(plainSource,/发布分支|来源/);
        return;
      }
      assert.equal(lookup.status,'found',JSON.stringify(lookup));
      assert.deepEqual(reads,[{url:gitURL,method:'GET',redirect:'error'}]);
      const fact=await deadline(resumed.promise,'original Work receives authority readback');
      assert.match(forged,/本轮查到/);
      assert.equal(fact.kind,'github-ref');
      assert.equal(fact.ref,'refs/heads/main');
      assert.equal(fact.url,'https://github.com/Kuro96/loom/tree/main');
      assert.match(fact.sha,/^[a-f0-9]{40}$/);
      if(!live) assert.equal(fact.sha,fixtureSha);
      const done=await waitFor(({items:[item]})=>item.status==='review' && item);
      const {items:[first,next]}=await rpc('query',{kind:'run',workId:work.id});
      assert.equal(next.sessionId,first.sessionId);
      assert.equal(next.operationId,first.operationId);
      assert.deepEqual(next.wait.handoff.evidence,[fact]);
      assert.doesNotMatch(next.wait.handoff.information,/Claim from coordinator/);
      assert.equal(done.result.outputs.head,fact.sha);
      const {items:events}=await rpc('query',{kind:'event',workId:work.id});
      const [decision]=events.filter(item=>item.type==='work.resolveWait');
      assert.deepEqual(decision.detail.evidence,[fact]);
      if(live) t.diagnostic(JSON.stringify({repository:fact.repository,ref:fact.ref,sha:fact.sha,observedAt:fact.observedAt,source:fact.url,workId:work.id,sessionId:next.sessionId,originalRunId:first.id,resumedRunId:next.id}));
    } finally {await peer.dispose();}
  } finally {await host.close();}
 });
}
