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

function recordTurn(ledger,usages) {
  const at=Date.parse('2024-01-01T00:00:00Z'),identity={busId:'bus',segment:1,sessionId:'session-1',turn:2};
  ledger.start(identity,at);
  for(const [index,[model,usage]] of usages.entries()) {
    ledger.begin({...identity,step:index+1,callId:model,purpose:'conversation',provider:'deepseek-official',model,startedAt:at+index})
      ({endedAt:at+index+1,usage,usageSource:'adapter-reported',finish:{kind:'stop'}});
  }
  ledger.end(identity,at+usages.length+1,'completed');
  return ledger.query('bus').items[0].key;
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

test('legacy usage shows one historical coverage notice while totals and calls stay readable',async t=>{
  const ledger=new TurnUsage(':memory:',{legacyGap:true});t.after(()=>ledger.close());
  const {view,toggle,requests,text}=await mount(t,payload=>ledger.query('bus',payload));
  const coverage='历史用量覆盖不全；逐轮采集从启用后开始。';
  function assertCoverage() {
    assert.equal(text().split(coverage).length-1,1);
    assert.deepEqual(view.root.findAllByProps({role:'status'}).map(node=>node.children.join('')),[coverage]);
    assert.equal(view.root.findAllByProps({role:'alert'}).length,0);
    assert.equal(view.root.findAllByType('button').filter(node=>node.children.join('')==='重试').length,0);
  }
  await toggle(true);
  assertCoverage();
  assert.match(text(),/暂无已结束的总控轮次/);

  const key=recordTurn(ledger,[['measured',{inputTokens:1200,outputTokens:0}],['unreported',undefined]]);
  await act(async()=>view.root.findAllByType('button').find(node=>node.children.join('')==='刷新用量').props.onClick());
  assertCoverage();
  assert.match(text(),/部分统计（已报告 1\/2）/);
  assert.equal(view.root.findByType('h4').children.join(''),'最近 1 轮');
  assert.match(text(),/1,200/);
  await act(async()=>view.root.findByProps({'aria-expanded':false}).props.onClick());
  assert.deepEqual(requests,[{},{},{key}]);
  assertCoverage();
  const details=view.root.findByProps({'aria-label':'调用明细'});
  assert.deepEqual(details.findAllByType('p').map(node=>node.children.join('')), [
    'measured（deepseek-official） · 输入 1,200 · 输出 0 · 缓存写入 0',
    'unreported（deepseek-official） · 输入 未报告 · 输出 未报告 · 缓存写入 未报告',
  ]);
});

test('a storage issue beside available usage has one alert and retries the open usage view',async t=>{
  const ledger=new TurnUsage(':memory:');t.after(()=>ledger.close());
  const key=recordTurn(ledger,[['measured',{inputTokens:1200,outputTokens:0}]]);
  ledger.db.exec('PRAGMA query_only=ON');
  ledger.start({busId:'bus',segment:1,sessionId:'session-1',turn:3},Date.parse('2024-01-01T00:01:00Z'));
  const {view,toggle,requests,text}=await mount(t,payload=>ledger.query('bus',payload));
  await toggle(true);
  assert.equal(view.root.findAllByProps({role:'alert'}).length,1);
  await act(async()=>view.root.findByProps({'aria-expanded':false}).props.onClick());
  assert.equal(view.root.findAllByProps({role:'alert'}).length,1);
  assert.match(text(),/LOOM_USAGE_STORAGE/);
  assert.match(text(),/调用明细/);
  assert.match(text(),/输入 1,200/);
  const retry=view.root.findAllByType('button').filter(node=>node.children.join('')==='重试');
  assert.equal(retry.length,1);
  await act(async()=>retry[0].props.onClick());
  assert.deepEqual(requests,[{},{key},{},{key}]);
});

test('a rejected detail read retries the selected turn',async t=>{
  const ledger=new TurnUsage(':memory:',{legacyGap:true});t.after(()=>ledger.close());
  const key=recordTurn(ledger,[['measured',{inputTokens:1200,outputTokens:0}]]);
  let detailReads=0;
  const {view,toggle,requests,text}=await mount(t,payload=>{
    if(payload.key===key && ++detailReads===1) throw new Error('usage connection lost');
    return ledger.query('bus',payload);
  });
  await toggle(true);
  await act(async()=>view.root.findByProps({'aria-expanded':false}).props.onClick());
  assert.match(text(),/usage connection lost/);
  const retry=view.root.findByProps({role:'alert'}).findByType('button');
  assert.equal(retry.children.join(''),'重试');
  await act(async()=>retry.props.onClick());
  assert.deepEqual(requests,[{},{key},{key}]);
  assert.match(text(),/输入 1,200/);
  assert.equal(view.root.findAllByProps({role:'alert'}).length,0);
});

test('closing diagnostics discards an earlier request failure and reopening displays the new read',async t=>{
  const stale=Promise.withResolvers();let opened=0;
  const {requests,toggle,text}=await mount(t,()=>++opened===1?stale.promise:{items:[],error:null});
  await toggle(true);await toggle(false);await toggle(true);
  assert.equal(requests.length,2);
  await act(async()=>stale.reject(new Error('stale diagnostics')));
  assert.match(text(),/暂无已结束的总控轮次/);assert.doesNotMatch(text(),/stale diagnostics/);
});
