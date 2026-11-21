import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
export const installed=Boolean(process.versions.electron);
export const nativeOnly={skip:installed?false:'requires installed DSH Electron native subprocess provider'};
const installRoot=process.env.DSH_INSTALL_ROOT ?? dirname(process.execPath);
export const command=process.env.LOOM_CHECK_NODE ?? (installed ? join(installRoot,'resources/runtime/primary-runtime/dependencies/node/bin',process.platform==='win32'?'node.exe':'node') : process.execPath);
export async function subprocessHost(t) {
  const require=createRequire(join(installRoot,'resources/app.asar/dsh/package.json'));
  const {Context}=require('@deepseek-ai/cordis');
  const {LocalSubprocessRuntime}=require('@deepseek-ai/dsh-subprocess-local');
  const ctx=new Context();
  const fiber=await ctx.plugin(LocalSubprocessRuntime);
  t.after(()=>fiber.dispose());
  return ctx.subprocess;
}
export async function pidFrom(path) {
  for(let i=0;i<500 && !existsSync(path);i++) await delay(10);
  assertFile(path);
  return Number(readFileSync(path,'utf8'));
}
function assertFile(path) {if(!existsSync(path)) throw new Error(`Process did not become ready: ${path}`);}
export function detachedCheck(marker) {
  return {kind:'command',command,args:['-e',`const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},5000)`)}],{detached:true,stdio:'ignore'});c.unref();`]};
}
export function activeCheck(marker) {
  return {kind:'command',command,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},5000)`]};
}
