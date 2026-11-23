import { createRequire, registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
export const installed = Boolean(process.versions.electron);
const installRoot = process.env.DSH_INSTALL_ROOT ?? dirname(process.execPath);
export const require = createRequire(installed ? join(installRoot,'resources/app.asar/dsh/package.json') : import.meta.url);
const contextSource = new URL('../src/', import.meta.url).href;
if(installed) registerHooks({resolve(specifier,context,next) {
  if(specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(contextSource)) return next(require.resolve(specifier),context);
  return next(specifier,context);
}});
export const native = name => require(`@deepseek-ai/${name}`);
export async function nativeHost(compression='none') {
  const directory=await mkdtemp(join(process.env.TMPDIR,'loom-native-'));
  const {Context}=native('cordis'); const root=new Context();
  for(const name of ['dsh-storage','dsh-session-projection','dsh-session','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-llm','dsh-agent','dsh-token-meter']) {
    const mod=native(name); await root.plugin(mod.default ?? mod).await();
  }
  await root.plugin(native('dsh-storage-json'),{root:join(directory,'storage')}).await();
  await root.plugin(native('dsh-storage-domain'),{backend:'json'}).await();
  await root.plugin(native('dsh-session-persistence-jsonl'),{root:join(directory,'sessions'),compression}).await();
  await root.plugin(native('dsh-workspace').default).await();
  await root.plugin(native('dsh-agent-loop').default,{agents:[]}).await();
  let ctx;
  const owner=await root.plugin({name:'loom-native-tests',inject:['agents','sessions','llm','tools','systemPrompt','workspaceRegistry','sessionPersistence'],apply(c){ctx=c;}}).await();
  const workspace=await ctx.workspaceRegistry.create(directory,'Loom native tests');
  return {root,ctx,directory,workspace,async close(){await owner.dispose();await root.fiber.dispose();await rm(directory,{recursive:true,force:true});}};
}
