import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {TurnUsage} from '../src/context/usage.mjs';
import {LoomStore} from '../src/core/store.mjs';

const require=createRequire(process.env.LOOM_CLIENT_TEST_DEPS?resolve(process.env.LOOM_CLIENT_TEST_DEPS,'package.json'):import.meta.url);
const React=require('react'),{create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const bundle=await build({entryPoints:['src/client/panels.jsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/*'],write:false});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(require,module,module.exports);
const {SettingsPanel}=module.exports;

async function mount(t,read) {
  const store=new LoomStore(':memory:');
  const requests=[];
  const api={rpc:async(method,payload)=>{
    if(method==='permissions') return {defaultOptions:[]};
    assert.equal(method,'usage');requests.push(payload);return read(payload);
  }};
  let view;
  await act(async()=>{view=create(React.createElement(SettingsPanel,{settings:store.getSettings(),api}));});
  t.after(async()=>{await act(async()=>view.unmount());store.close();});
  const toggle=open=>act(async()=>{
    const node=view.root.findAllByType('details').find(details=>details.findAllByType('summary')[0].children.join('').startsWith('高级与诊断'));
    assert.equal(typeof node.props.onToggle,'function');
    node.props.onToggle({currentTarget:{open}});
  });
  return {view,toggle,requests,text:()=>JSON.stringify(view.toJSON())};
}

test('opening diagnostics loads chart totals and selecting a column opens only that turn’s call details',async t=>{
  const ledger=new TurnUsage(':memory:',{isPiAi:provider=>provider==='loom-test-provider'}); t.after(()=>ledger.close());
  const at=Date.parse('2024-01-01T00:00:00Z');
  const identity={busId:'bus',segment:3,sessionId:'session-3',turn:8};
  ledger.start(identity,at);
  for(const [callId,purpose,provider,model,usage] of [
    ['main-1','conversation','loom-test-provider','flash',{inputTokens:3100,cacheReadTokens:2400,cacheWriteTokens:100,outputTokens:190,totalTokens:5790}],
    ['main-2','conversation','loom-test-provider','flash',undefined],
    ['review','compaction','openai-codex','reviewer',{inputTokens:7100,outputTokens:320,totalTokens:7420}],
  ]) ledger.begin({...identity,callId,purpose,provider,model,step:1,startedAt:at+100})({endedAt:at+200,usage,usageSource:'adapter-reported',finish:{kind:'stop'}});
  ledger.end(identity,at+500,'completed');
  const row=ledger.query('bus').items[0];
  const {view,toggle,requests,text}=await mount(t,payload=>ledger.query('bus',payload));
  assert.deepEqual(requests,[]);
  await toggle(true);
  assert.equal(requests.length,1);
  assert.match(text(),/有回顾/);assert.match(text(),/部分统计（已报告 1\/2）/);
  assert.match(text(),/5,600/);assert.match(text(),/2,400/);assert.match(text(),/190/);
  assert.equal(text().includes('7,100'),false);
  const column=view.root.findAllByType('button').find(node=>node.props['aria-label']?.startsWith('第 3 段 · 第 8 轮'));
  assert.equal(Boolean(column),true);
  await act(async()=>column.props.onClick());
  assert.equal(requests.length,2);
  assert.equal(requests[1].key,row.key);
  assert.match(text(),/含回顾合计/);assert.match(text(),/12,700/);assert.match(text(),/7,100/);assert.match(text(),/缓存写入/);
});

test('closing diagnostics discards an earlier request failure and reopening displays the new read',async t=>{
  const stale=Promise.withResolvers();let opened=0;
  const {requests,toggle,text}=await mount(t,()=>++opened===1?stale.promise:{items:[],error:null});
  await toggle(true);await toggle(false);await toggle(true);
  assert.equal(requests.length,2);
  await act(async()=>stale.reject(new Error('stale diagnostics')));
  assert.match(text(),/暂无已结束的总控轮次/);assert.doesNotMatch(text(),/stale diagnostics/);
});
