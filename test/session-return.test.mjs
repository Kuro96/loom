import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {build} from 'esbuild';

const req=createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS,'package.json') : import.meta.url);
const React=req('react'),{act,create}=req('react-test-renderer'); globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const bundle=await build({entryPoints:['src/client/session-return.jsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/*'],write:false});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(req,module,module.exports);
const {sessionNavigation,SessionReturn}=module.exports;
test('an explicit work-session visit has one return action until return or independent session navigation',async t=>{
 let surface,notify,panel='loom';const setSurface=id=>{surface=id;notify();};
 const ctx={effect:fn=>fn(),uiWorkspace:{openSession(id){panel=null;setSurface(id);}},layout:{panelInfo:{getSnapshot:()=>({activePanelId:panel})},selectPanel(id){panel=id;setSurface(undefined);}},sidebarRight:{mounted:{getSnapshot:()=>surface,subscribe(fn){notify=fn;return ()=>{};}}}};
 const navigation=sessionNavigation(ctx);let ui;await act(async()=>{ui=create(React.createElement(SessionReturn,{navigation}));});
 t.after(()=>act(async()=>ui.unmount()));const buttons=()=>ui.root.findAllByType('button');
 assert.equal(buttons().length,0);const origin={workId:'w',view:'报告',tab:'work',workflowFilter:'f'};
 await act(async()=>navigation.open('s',origin));
 assert.equal(buttons().length,1);assert.ok(buttons()[0].children.includes('返回上一页'));
 await act(async()=>buttons()[0].props.onClick());assert.equal(panel,'loom');assert.deepEqual(navigation.current,origin);assert.equal(buttons().length,0);
 await act(async()=>{navigation.open('s',origin);setSurface('elsewhere');setSurface('s');});assert.equal(buttons().length,0);
});
