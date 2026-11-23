import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {createSnapshotStore} from '@deepseek-ai/dsh-client-store';
import {LoomStore} from '../src/core/store.mjs';
import {act,inject,mountPanel,ok} from './workspace-reader-helper.mjs';

const bundle=await build({entryPoints:['src/client/session-return.jsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/*','react-dom'],write:false});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {sessionNavigation}=module.exports;
const origin={workspaceId:'project',workId:'w',view:'报告',tab:'work',workflowFilter:'f',statusFilter:['done'],workDepth:3,positions:{work:640}};

function setup(t) {
  const panelInfo=createSnapshotStore({activePanelId:'loom'});
  const main=createSnapshotStore({key:'previous'});
  let transition=new AbortController(), requested, dispose;
  const layout={panelInfo,
    selectPanel(id){transition.abort();panelInfo.set({activePanelId:id});},
    beginNavigation(){transition.abort();transition=new AbortController();return transition.signal;},
  };
  const uiWorkspace={openSession(id){requested=id;layout.selectPanel(null);}};
  const ctx={effect:fn=>{dispose=fn();},layout,uiWorkspace,uiSession:{adapter:{current:main}},
    sidebarRight:{mounted:createSnapshotStore(undefined)}};
  const navigation=sessionNavigation(ctx);
  t.after(dispose);
  return {navigation,open:id=>uiWorkspace.openSession(id),layout,publish:(key=requested)=>main.set({key})};
}

test('the Loom visit follows a delayed native binding independently of the right sidebar',t=>{
  const {navigation,layout,publish}=setup(t);
  navigation.open('worker',origin);
  assert.equal(navigation.getSnapshot(),null);
  publish('other');
  assert.equal(navigation.getSnapshot(),null);
  publish();
  assert.equal(navigation.getSnapshot().id,'worker');
  navigation.back(navigation.getSnapshot());
  assert.equal(layout.panelInfo.getSnapshot().activePanelId,'loom');
  assert.equal(navigation.current,origin);
  assert.equal(navigation.getSnapshot(),null);
});

test('a native reopen of the same session consumes the Loom visit',t=>{
  const {navigation,layout,publish,open}=setup(t);
  navigation.open('worker',origin);publish();
  const visit=navigation.getSnapshot();
  assert.equal(visit.id,'worker');
  open('worker');
  assert.equal(navigation.getSnapshot(),null);
  navigation.back(visit);
  assert.equal(layout.panelInfo.getSnapshot().activePanelId,null);
  assert.equal(navigation.current,null);
});

test('a native panel selection cancels a pending Loom visit before its session binds',t=>{
  const {navigation,layout,publish,open}=setup(t);
  navigation.open('worker',origin);layout.selectPanel('settings');open('worker');publish();
  assert.equal(navigation.getSnapshot(),null);
  assert.equal(navigation.current,null);
});

test('a stale click cannot return from a newer Loom visit to the same session',t=>{
  const {navigation,layout,publish}=setup(t);
  navigation.open('worker',origin);publish();
  const first=navigation.getSnapshot();
  assert.equal(first.id,'worker');
  const second={...origin,workId:'w2',view:'输入'};
  layout.selectPanel('loom');navigation.open('worker',second);
  navigation.back(first);
  assert.equal(layout.panelInfo.getSnapshot().activePanelId,null);
  navigation.back(navigation.getSnapshot());
  assert.equal(navigation.current,second);
});

test('returning from a referenced work session preserves the route back to the deletion source', async t=>{
  const store=new LoomStore(':memory:');
  t.after(()=>store.close());
  store.syncWorkspaces([{workspaceId:'project',title:'项目',path:'D:/project'}]);
  const createWork=(title,extra={})=>store.command({type:'work.create',workspaceId:'project',title,...extra},{kind:'user'});
  const source=createWork('上传文件'), related=createWork('等待处理',{dependsOn:[source.id],sessionId:'worker'});
  const face=inject({endpoints:{
    'loom/query':request=>ok(store.query(request)),
    'loom/models':()=>ok({groups:[]}),
    'loom/status':()=>ok({bus:null,context:{status:'idle',workspaceId:'control'},engine:{faulted:false}}),
    'loom/snapshot':()=>ok({workflows:store.query({kind:'workflow'}),uses:store.query({kind:'use'}),workspaces:store.query({kind:'workspace'}).items,settings:store.getSettings()}),
    'loom/checkDeletion':request=>ok(store.checkDeletion(request)),
    'loom/nativeSessions':()=>ok([{sessionId:'worker',workspaceId:'project'}]),
  }});
  const findButton=(ui,label)=>ui.root.findAllByType('button').find(b=>b.props['aria-label']===label || b.children.join('')===label);
  const click=async(ui,label)=>{const b=findButton(ui,label);assert.ok(Boolean(b),label);await act(async()=>b.props.onClick());};
  const heading=ui=>ui.root.findByType('article').findByType('h2').children.join('');
  const workbench=await mountPanel(t,face);
  await act(async()=>workbench.root.findByProps({'data-work-id':source.id}).props.onClick());
  await click(workbench,'报告');
  await click(workbench,'删除工作');
  await click(workbench,'查看工作：等待处理');
  assert.equal(heading(workbench),related.title);
  assert.ok(Boolean(findButton(workbench,'返回上传文件')));
  await click(workbench,'查看对话');
  assert.deepEqual(face.sessionVisits,['worker']);
  await act(async()=>workbench.unmount());
  const nav=face.previewNavigation;
  nav.back(nav.getSnapshot());
  const restored=await mountPanel(t,face);
  assert.equal(heading(restored),related.title);
  await click(restored,'返回上传文件');
  assert.equal(heading(restored),source.title);
  assert.equal(findButton(restored,'报告').props['aria-pressed'],true);
});
