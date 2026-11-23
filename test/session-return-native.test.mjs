import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, dirname } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { installed } from './context-native-helper.mjs';

async function installedHeaders() {
  const source = join(process.env.DSH_INSTALL_ROOT ?? dirname(process.execPath),
    'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client');
  const native = await build({
    entryPoints: ['skeleton/ConversationHeader.tsx', 'skeleton/ConversationSession.tsx'],
    outdir: 'headers', bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    plugins: [{name:'installed-dsh-header', setup(ctx) {
      ctx.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/}, () => ({path:'view-controls', namespace:'unused'}));
      ctx.onLoad({filter:/./, namespace:'unused'}, () => ({contents:'export function Button() { throw new Error("unexpected view control"); } export { Button as Menu, Button as Tooltip, Button as IconEllipsisOutlineRegular };'}));
      ctx.onResolve({filter:/./}, ({path, importer, kind}) => kind === 'entry-point' || path.startsWith('.')
        ? {path:posix.join(posix.dirname(importer), path), namespace:'asar'} : {path,external:true});
      ctx.onLoad({filter:/\.css$/, namespace:'asar'}, () => ({contents:'export default {}'}));
      ctx.onLoad({filter:/DefaultConversationViews\.tsx$/, namespace:'asar'}, () => ({contents:'export const DefaultConversationViews = undefined'}));
      ctx.onLoad({filter:/\.tsx?$/, namespace:'asar'}, ({path}) => ({contents:readFileSync(join(source,path),'utf8'), loader:path.endsWith('.tsx')?'tsx':'ts'}));
    }}],
  });
  const require = createRequire(import.meta.url);
  return Object.assign({}, ...native.outputFiles.map(file => {
    const module = {exports:{}};
    new Function('require','module','exports',file.text)(require,module,module.exports);
    return module.exports;
  }));
}

test('one Loom return survives the installed native header switching from blank to titled', {skip:!installed}, async t => {
  const {act,inject} = await import('./workspace-reader-helper.mjs');
  const {ConversationHeader,ConversationSessionHeader} = await installedHeaders();
  const {openMain,previewNavigation,returnActions} = inject({});
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  t.after(async () => {await act(async () => root.unmount()); container.remove();});
  const title = '执行会话', sessionId = 'worker', origin = {workId:'original-work', view:'报告'};
  const nativeControl = id => React.createElement('button', {id}, id);
  const nativeSlot = (name, props) => {
    const entry = returnActions.find(({options}) => options.name === name);
    return entry ? React.createElement(entry.Component,{...entry.options.inject(sessionId),sessionId,...props}) : null;
  };
  function header(blank, key) {
    return React.createElement(ConversationHeader, { key, sessionId, useSession: s => s({blank}), useConversation: s => s({activeTargets:new Set()}),
      renderSlot(name, props) {
        if (name === 'conversation.header.leading') return nativeSlot(name,props) ?? nativeControl('native-leading');
        assert.equal(name,'conversation.session.header');
        return React.createElement(ConversationSessionHeader,{ ...props, sessionId,
          useContextMenu: () => ({getTriggerProps: () => ({})}), useConversationViews: () => [], useStore: () => 'chat',
          useSessions: select => select({byId:{[sessionId]:{id:sessionId,displayTitle:title}}}), useEntryPins: () => [], useEntryActions: () => false, t: key => key,
          renderFactorySlot: () => nativeControl('native-menu'),
          renderSlot: (name, props) => nativeSlot(name,props) ?? (name === 'conversation.session.header.corner' ? nativeControl('native-corner') : null),
        });
      },
    });
  }
  const draw = (blank, key) => root.render(React.createElement(React.Fragment,null,key === undefined ? null : header(blank,key),nativeSlot('shell.overlay',{})));
  const buttons = () => [...container.querySelectorAll('header button')].filter(b=>b.textContent.endsWith('返回'));
  await act(async () => {openMain(sessionId,origin); draw();});
  assert.equal(container.querySelector('.loom-session-return'),null);
  await act(async () => draw(true,1));
  assert.equal(container.querySelector('nav'),null,'the installed blank header omits the title cluster');
  assert.equal(buttons().length,1,'blank native header must contain exactly one Loom return');
  assert.ok(container.querySelector('#native-leading') && container.querySelector('#native-corner'));
  await act(async () => draw(false,2));
  assert.equal(container.querySelector('nav').textContent,title);
  assert.equal(buttons().length,1,'titled native header must contain exactly one Loom return after remount');
  assert.ok(container.querySelector('#native-leading') && container.querySelector('#native-corner') && container.querySelector('#native-menu'));
  await act(async () => buttons()[0].click());
  assert.equal(previewNavigation.current,origin);
  assert.equal(buttons().length,0);
});