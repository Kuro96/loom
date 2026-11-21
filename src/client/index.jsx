import { LoomPanel } from './workbench.jsx';
import { styles } from './styles.mjs';
import { createLoomApi } from './api.mjs';
import { WorkspaceReader } from './workspace-reader.jsx';
import { readWorkspaceFile } from './file-preview.mjs';
import { documentViews } from './document-views.jsx';
import { sessionNavigation, SessionReturn } from './session-return.jsx';

export const name = 'loom';
export const inject = ['connection', 'slots', 'sessions', 'uiSession', 'uiWorkspace', 'conversation', 'layout', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'locale', 'documentPreviews', 'fileDrag'];

function EmbeddedConversation({ renderFactorySlot }) {
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false });
}

export function apply(ctx) {
  const api = createLoomApi((channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload));
  const navigation=sessionNavigation(ctx);
  const views=documentViews(ctx);
  const unavailable=()=>Promise.reject(new Error('DSH Office 预览服务暂不可用。'));
  let convert=unavailable;
  ctx.inject(['remote','remote.officeKit'], scope=>{
    convert=(id,path,signal)=>scope.remote.officeKit.render(id,path,'foreground',signal);
    scope.effect(()=>()=>{convert=unavailable;});
  });
  const injected = {
    api,
    previewNavigation: navigation,
    retain: id => ctx.sessions.retain(id, { source: 'loomConversation' }),
    openMain: navigation.open,
    WorkspaceReader: props => <WorkspaceReader {...props} views={views} />,
    readFile: readWorkspaceFile(ctx.remote.workspaceFiles, (id,path,signal)=>convert(id,path,signal)),
  };
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'loom.session-return',inject:()=>({navigation})},SessionReturn));
  ctx.effect(() => {
    const element = document.createElement('style');
    element.dataset.plugin = 'dsh-loom';
    element.textContent = styles + __LOOM_DOCUMENT_CSS__;
    document.head.appendChild(element);
    return () => element.remove();
  }, 'loom: workbench styles');
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'loom',
      children: { 'loom.conversation': { kind: 'single', scope: 'session' } },
      inject: () => injected,
    }, LoomPanel);
    yield ctx.slots.register({ name: 'loom.conversation' }, EmbeddedConversation);
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'loom', label: 'Loom 工作台', order: 30 },
    ({ size }) => <span aria-hidden="true" style={{ fontSize: size, lineHeight: 1 }}>◫</span>));
}
