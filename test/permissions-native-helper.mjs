import { installed, native, nativeHost } from './context-native-helper.mjs';
export { installed, native };
export async function permissionHost(t) {
  const host=await nativeHost();
  t.after(()=>host.close());
  // Permission selection reads this executor capability; these tests execute no shell calls.
  host.root.provide('shell',{sandboxMode:'workspace-write'});
  await host.root.plugin(native('dsh-user-approval').default).await();
  await host.root.plugin(native('dsh-permission-presets').default).await();
  let ctx;
  await host.root.plugin({name:'permission-test-owner',inject:['permissionPresets','sessions','agents','llm','tools','systemPrompt','tokenMeter','workspaceRegistry','sessionPersistence'],apply(c){ctx=c;}}).await();
  return {...host,ctx,permissions:ctx.permissionPresets};
}
