import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {installed,native} from './context-native-helper.mjs';
import {startupHost,testModel} from './host-native-helper.mjs';
import {previewTarget} from '../src/host/report-preview.mjs';
import {LoomStore} from '../src/core/store.mjs';

test('the local reader displays workflow-a.txt and its published bilingual report from the native session filesystem', {skip:!installed},async t=>{
  const host=await startupHost();t.after(()=>host.close());
  const api=native('dsh-api-workspace-files');await host.root.plugin(api.default??api,{}).await();
  let reader;
  await host.root.plugin({name:'loom-report-reader-test',inject:['workspaceFiles'],apply(ctx){reader=ctx.workspaceFiles;}}).await();
  const project=process.env.LOOM_READER_FIXTURE_DIR ? resolve(process.env.LOOM_READER_FIXTURE_DIR) : host.directory;
  if (project===host.directory) await writeFile(join(project,'workflow-a.txt'),'LOOM_STAGE_A\n');
  const control=join(host.directory,'control'); await mkdir(control);
  const ws=await host.ctx.workspaceRegistry.create(project,'Reader project');
  const store=new LoomStore(':memory:'); t.after(()=>store.close());
  store.syncWorkspaces([{workspaceId:ws.id,title:'Reader project',path:project}]);
  const user={kind:'user'},work=store.command({type:'work.create',workspaceId:ws.id,title:'核对交付',model:testModel},user);
  store.command({type:'work.confirm',workId:work.id,expectedVersion:work.version},user);
  const run=store.reserveRun(work.id);
  const session=await host.ctx.agents.create({sessionId:run.sessionId,meta:{cwd:project}});t.after(()=>session.dispose());
  const document={english:'The file is ready.',chinese:'文件已就绪。'};
  store.reportRun(run.id,{kind:'result',summary:'交付完成',outputs:{},document,deliverables:[{title:'交付文本',path:'workflow-a.txt'}]},
    {sessionId:run.sessionId,requestId:run.requestId,turn:1,callId:'report'});
  store.finishRun(run.id,{reason:'completed',eventCursor:2,summary:'完成',reportCallId:'report'});
  const authorize=request=>previewTarget(store,control,host.ctx.workspaceRegistry,request);
  const [doc]=store.getWork(work.id).documents;
  const other=store.command({type:'work.create',workspaceId:ws.id,title:'另一工作'},user);
  await assert.rejects(authorize({workId:other.id,documentId:doc.id}),{code:'NOT_FOUND'});
  await assert.rejects(authorize({workId:work.id,runId:'obsolete',index:0}),{code:'CONFLICT'});

  const {act,inject,mountPanel,ok}=await import('./workspace-reader-helper.mjs');
  const props=inject({endpoints:{'loom/query':q=>ok(store.query(q)),'loom/models':()=>ok({groups:[]}), 'loom/status':()=>ok({bus:null,engine:{faulted:false}}),
    'loom/snapshot':()=>ok({workflows:store.query({kind:'workflow'}),uses:store.query({kind:'use'}),workspaces:store.query({kind:'workspace'}).items,settings:store.getSettings()})},
    preview:async request=>ok(await authorize(request)),read:async(id,path,range,signal)=>{
    assert.equal(id,session.agent.id);
    return ok(await reader.read({sessionId:id,workspaceRoot:session.agent.session.header.cwd},path,range,signal));
  }});
  const ui=await mountPanel(t,props);
  const button=label=>ui.root.findAllByType('button').find(b=>b.children.join('')===label || b.props['aria-label']===label);
  const click=b=>act(async()=>b.props.onClick());
  async function readEntry(label) {
    await click(button(label));
    assert.equal(ui.root.findAllByType('dialog').length,0);
    const panel=ui.root.findByProps({className:'loom-chat'}), deadline=Date.now()+5000;
    while (panel.findAllByProps({className:'loom-page-body'}).some(body=>body.findAllByProps({role:'status'}).length)) {
      assert.ok(Date.now()<deadline,'preview read timed out');
      await act(async()=>new Promise(r=>setTimeout(r,10)));
    }
    return panel;
  }
  await click(ui.root.findByProps({'data-work-id':work.id}));
  await click(button('输出'));
  const fileView=await readEntry('交付文本'); assert.equal(fileView.findByProps({'data-textpreview-line':1}).children.join('').trim(),'LOOM_STAGE_A');
  await click(button('返回')); assert.equal(button('输出').props['aria-pressed'],true); assert.ok(button('交付文本'));
  await click(button('报告'));
  const reportView=await readEntry(doc.title);
  assert.deepEqual(reportView.findByType('article').findAllByType('p').map(p=>p.children.join('')),[document.english,document.chinese]);
  await click(button('返回')); assert.equal(button('报告').props['aria-pressed'],true); assert.ok(button(doc.title));
  assert.deepEqual(props.sessionVisits,[]);
});
