import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

const error=(code,message)=>Object.assign(new Error(message),{code});

/** Publish an immutable, reproducible Markdown view outside the execution workspace. */
export async function materializeDocument(controlPath,document) {
  const {english,chinese}=document;
  const label=document.role==='worker'?'执行报告':'补充报告';
  const title=document.title.replace(/[\r\n]+/g,' ');
  const body=`# ${title}\n\n## English\n\n${english}\n\n## 中文\n\n${chinese}\n`;
  const digest=createHash('sha256').update(JSON.stringify([document.id,document.runId,body])).digest('hex');
  let folder=await realpath(controlPath);
  for(const part of ['reports',digest.slice(0,24)]) {
    folder=join(folder,part);await mkdir(folder,{recursive:true,mode:0o700});
    if(!(await lstat(folder)).isDirectory()) throw error('INVALID_STATE','报告目录不可用');
  }
  const file=join(folder,`${label}.md`);
  try {
    const entry=await lstat(file);
    if(!entry.isFile()) throw error('INVALID_STATE','报告文件不可用');
    if(entry.size===Buffer.byteLength(body) && await readFile(file,'utf8')===body) return file;
  } catch(e) {if(e.code!=='ENOENT') throw e;}
  const temp=join(folder,`${randomUUID()}.tmp`);
  try {await writeFile(temp,body,{flag:'wx',mode:0o600});await rename(temp,file);}
  finally {await rm(temp,{force:true});}
  return file;
}

/** Only named, existing, project-local deliveries can be opened from a work result. */
export async function deliveryPath(workspace,path) {
  if(typeof path!=='string'||!path.trim()||/^[/\\]|[:\x00]/.test(path)||path.replace(/\\/g,'/').split('/').includes('..')) throw error('INVALID_INPUT','交付文件须位于项目内');
  const root=await realpath(workspace);
  try {
    const target=await realpath(resolve(root,path)), local=relative(root,target);
    if(!local || local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local)) throw error('INVALID_INPUT','交付文件须位于项目内');
    if(!(await stat(target)).isFile()) throw error('NOT_FOUND','交付文件不存在');
    return local.split(sep).join('/');
  } catch(e) {if(e.code==='ENOENT'||e.code==='ENOTDIR') throw error('NOT_FOUND','交付文件不存在');throw e;}
}

export async function previewTarget(store,controlPath,registry,request) {
  const {workId,documentId,runId,index}=request;
  if(typeof workId!=='string') throw error('INVALID_INPUT','缺少工作');
  const work=store.getWork(workId);
  if(!work) throw error('NOT_FOUND','未找到工作');
  if(typeof documentId==='string') {
    const doc=store.getDocument(workId,documentId);
    if(!doc) throw error('NOT_FOUND','未找到这项工作的报告');
    const run=store.getRun(doc.runId);
    if(!run || run.workId!==workId) throw error('NOT_FOUND','未找到报告所属的执行');
    return {sessionId:run.sessionId,path:await materializeDocument(controlPath,doc)};
  }
  if(!work.result || work.result.runId!==runId) throw error('CONFLICT','工作结果已更新，请重新打开');
  const files=work.result.deliverables;
  if(!Number.isSafeInteger(index)||index<0||!files||index>=files.length) throw error('NOT_FOUND','未找到交付文件');
  const workspace=registry.get(work.workspaceId), run=store.getRun(runId);
  if(!workspace || !run || run.workId!==workId) throw error('NOT_FOUND','交付文件所属项目或执行不可用');
  return {sessionId:run.sessionId,path:await deliveryPath(workspace.path,files[index].path)};
}
