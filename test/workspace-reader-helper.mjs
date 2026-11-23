import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';

const req = createRequire(process.env.LOOM_CLIENT_TEST_DEPS ? resolve(process.env.LOOM_CLIENT_TEST_DEPS, 'package.json') : import.meta.url);
const React = req('react'), { act, create } = req('react-test-renderer');
export { act };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost/'});
for(const k of ['window','document','HTMLElement','Element','DOMParser']) globalThis[k] = dom.window[k];
const bundle = await build({ entryPoints: ['src/client/index.jsx'], outfile:'reader.cjs', bundle:true, platform:'node', format:'cjs', jsx:'automatic', external:['react','react/*','react-dom','react-dom/*'], loader:{'.woff2':'empty','.woff':'empty','.ttf':'empty'}, define:{__LOOM_DOCUMENT_CSS__:'""'}, write:false });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles.find(f=>f.path.endsWith('.cjs')).text)(req, module, module.exports);

// Exercise the face actually injected into LoomPanel, including the two different RPC envelopes.
export function inject({ preview, read, readBytes, renderOffice, endpoints = {} }) {
  const sessionVisits = [], returnActions = [];
  const panelInfo = createSnapshotStore({activePanelId:'loom'}), current = createSnapshotStore({key:undefined});
  let main, Panel, transition = new AbortController();
  const layout = {panelInfo,
    selectPanel(id) { transition.abort(); panelInfo.set({activePanelId:id}); },
    beginNavigation() { transition.abort(); transition = new AbortController(); return transition.signal; },
  };
  module.exports.apply({
    effect() {},
    inject(keys, bind) { if (renderOffice) bind({remote:{officeKit:{render:renderOffice}},effect(){}}); },
    fileDrag:{actions:{}}, locale:{bind:()=>key=>key},
    documentPreviews:{candidates(path){const kind={md:'markdown',js:'code',html:'html',png:'image',pdf:'pdf',xlsx:'excel',docx:'office',pptx:'office'}[path.split('.').pop().toLowerCase()];return kind?[{id:`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/${kind}`}]:[];}},
    slots: { inject(name, mount) { if (name === 'main') [...mount()]; else mount(); }, register(options, component) {
      if (options.key === 'loom') { main = options.inject; Panel = component; }
      if (options.id === 'loom.session-return') returnActions.push({options, Component:component});
    } },
    layout, uiSession:{adapter:{current}},
    connection: { rpc: { call(channel, endpoint, request) { assert.equal(channel, '/api'); return endpoint === 'loom/preview' ? preview(request) : endpoints[endpoint](request); } } },
    remote: { workspaceFiles: { read, readBytes }, officeKit:{render:renderOffice} },
    uiWorkspace: { openSession(id) { sessionVisits.push(id); current.set({key:id}); layout.selectPanel(null); } },
  });
  const props = main();
  assert.equal(typeof props.WorkspaceReader, 'function', 'LoomPanel needs a local reader');
  assert.equal(main().WorkspaceReader, props.WorkspaceReader);
  return { ...props, Panel, sessionVisits, returnActions };
}
export const ok = value => ({ ok: true, value });
async function render(t, element) {
  let ui;
  await act(async () => { ui = create(element, { createNodeMock: el => el.type === 'dialog' ? { showModal() {} } : null }); });
  t.after(() => act(async () => ui.unmount()));
  return ui;
}
export const mountPanel = (t, { Panel, ...props }) => render(t, React.createElement(Panel, props));
export async function mount(t, face, request, title = '交付文件') {
  let closed = 0;
  const element = (request, title) => React.createElement(face.WorkspaceReader, { request, title, api: face.api, readFile: face.readFile, onClose() { closed++; } });
  const ui = await render(t, element(request, title));
  return { ui, text: () => JSON.stringify(ui.toJSON()), closed: () => closed,
    switchTo: (next, label) => act(async () => ui.update(element(next, label))),
    click: label => act(async () => ui.root.findAllByType('button').find(b => b.props['aria-label'] === label || b.children.join('') === label).props.onClick()) };
}
