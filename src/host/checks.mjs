import { stat, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

async function execute(check,cwd,options,group,handles) {
  options.signal?.throwIfAborted();
  if(options.subprocess===undefined) throw new Error('验收命令需要宿主 subprocess 服务');
  const maximum=options.outputBytes ?? 65536;
  const handle=options.subprocess.spawn({argv:[check.command,...(check.args ?? [])],cwd,
    stdio:{stdin:'ignore',stdout:{maxBytes:maximum},stderr:{maxBytes:maximum}},
    graceMs:100,signal:group.signal});
  handles.add(handle);
  let timedOut=false,outcome;
  const timer=setTimeout(()=>{timedOut=true;group.abort(new DOMException('验收命令执行超时','TimeoutError'));},options.timeoutMs ?? 30000);
  try { outcome=await handle.done; }
  catch(error) {
    options.signal?.throwIfAborted();
    if(!timedOut) throw error;
    outcome={exitCode:null,signal:null};
  } finally {clearTimeout(timer);}
  options.signal?.throwIfAborted();
  const stdout=handle.collected.stdout.readFrom(0),stderr=handle.collected.stderr.readFrom(0);
  return {kind:'command',command:check.command,args:check.args ?? [],...outcome,
    stdout:stdout.text,stderr:stderr.text,timedOut,truncated:stdout.lossy||stderr.lossy,
    passed:!timedOut&&outcome.exitCode===(check.expectedExit ?? 0),
    detail:timedOut?'验收命令执行超时':`退出码 ${outcome.exitCode}`};
}

function cleanupGroup(handles) {
  return async function cleanup(timeoutMs=5000) {
    const signal=AbortSignal.timeout(timeoutMs);
    const results=await Promise.allSettled([...handles].map(async handle=>{
      handle.terminate();
      if(!await handle.waitForExit(signal)) throw new Error('验收进程范围停止尚未确认');
      handles.delete(handle);
    }));
    const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(errors.length) {
      const error=new AggregateError(errors,'验收进程范围停止尚未确认');
      error.code='CHECK_STOP_UNCONFIRMED';
      error.retryCleanup=cleanup;
      throw error;
    }
  };
}

/** Read objective acceptance evidence from files or user-approved commands. */
export async function runChecks(workspacePath, checks, options={}) {
  const results=[];
  const handles=new Set(),group=new AbortController(),cleanup=cleanupGroup(handles);
  const abort=()=>group.abort(options.signal.reason);
  options.signal?.addEventListener('abort',abort,{once:true});
  try {
  const root=await realpath(workspacePath);
  const inScope=(path)=>{const rel=relative(root,path); return rel!== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);};
  for (const check of checks) {
    options.signal?.throwIfAborted();
    if(group.signal.aborted) {
      results.push({kind:check.kind,passed:false,blocked:'previous_timeout',detail:'前序验收命令超时，本项尚未执行'});
      continue;
    }
    if(check.kind==='command') {
      results.push(options.commandConsent===true ? await execute(check,workspacePath,options,group,handles) : {kind:'command',passed:false,blocked:'approval_required',detail:'验收命令需要用户确认'});

      continue;
    }
    if (check.kind!=='file') throw new Error(`未知验收检查类型：${check.kind}`);
    let path=resolve(root,check.path);
    if(!inScope(path)) throw new Error('验收文件超出工作区范围');
    let info;
    try { path=await realpath(path); info=await stat(path); }
    catch(error) {
      if(error.code!=='ENOENT') throw error;
      results.push({kind:'file',path,passed:false,missing:true,detail:'验收文件尚未生成'});
      continue;
    }
    if(!inScope(path)) throw new Error('验收文件链接超出工作区范围');
    if(check.contains!==undefined && info.size>8*1024*1024) {
      results.push({kind:'file',path,passed:false,bytes:info.size,detail:'文本检查上限为8MiB'});
      continue;
    }
    const passed=info.isFile() && (check.contains===undefined || (await readFile(path,'utf8')).includes(check.contains));
    results.push({kind:check.kind,path,passed,bytes:info.size,modifiedAt:info.mtime.toISOString(),detail:passed?'文件检查通过':'文件内容与验收条件不符'});
  }
  return results.map((result,index)=>({...result,check:structuredClone(checks[index])}));
  } finally {
    options.signal?.removeEventListener('abort',abort);
    await cleanup(options.cleanupTimeoutMs ?? 5000);
  }
}
