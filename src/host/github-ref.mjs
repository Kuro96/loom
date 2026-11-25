const segment=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function githubRefReader(grant) {
  const marked=work=>typeof work.wait.remoteRef==='string' && work.wait.remoteRef.startsWith('github:');
  if(grant===undefined) return {requiresReceipt:marked,async read(){return {status:'forbidden'};}};
  if(!grant || typeof grant.workspaceId!=='string' || grant.workspaceId.length===0 || typeof grant.operationId!=='string' || grant.operationId.length===0 ||
    typeof grant.repository!=='string' || typeof grant.branch!=='string' || !segment.test(grant.branch)) throw new TypeError('githubRef requires workspaceId, operationId, repository and branch');
  const {workspaceId,operationId,repository,branch}=grant;
  const repo=repository.split('/');
  if(repo.length!==2 || !repo.every(part=>segment.test(part))) throw new TypeError('githubRef repository must be owner/name');
  const ref=`refs/heads/${branch}`;
  const api=`https://api.github.com/repos/${repository}/git/ref/heads/${branch}`;
  const url=`https://github.com/${repository}/tree/${branch}`;
  const granted=work=>work.workspaceId===workspaceId && work.id===operationId && work.wait.operationId===operationId;
  async function read(work,signal) {
    if(!granted(work) || work.wait.remoteRef!==`github:${repository}@${branch}`) return {status:'forbidden'};
    let response;
    const request=new AbortController();
    try {
      response=await fetch(api,{method:'GET',headers:{Accept:'application/vnd.github+json','User-Agent':'dsh-loom'},redirect:'error',
        signal:AbortSignal.any([signal,request.signal,AbortSignal.timeout(8000)])});
    } catch(error) {
      signal.throwIfAborted();
      if(error instanceof TypeError || error.name==='TimeoutError') return {status:'unavailable'};
      throw error;
    }
    if(!response.ok) {
      request.abort();
      if(response.status===404) return {status:'not_found'};
      if(response.status===401 || (response.status===403 && response.headers.get('x-ratelimit-remaining')!=='0' && !response.headers.has('retry-after'))) return {status:'forbidden'};
      return {status:'unavailable'};
    }
    let value;
    try {value=await response.json();}
    catch(error) {
      signal.throwIfAborted();
      if(error instanceof SyntaxError || error instanceof TypeError || error.name==='AbortError' || error.name==='TimeoutError') return {status:'unavailable'};
      throw error;
    }
    if(value?.ref!==ref || value.object?.type!=='commit' || typeof value.object.sha!=='string' || !/^[0-9a-f]{40}$/.test(value.object.sha)) return {status:'unavailable'};
    return {status:'found',source:`GitHub ${repository} ${ref}`,evidence:{kind:'github-ref',repository,ref,sha:value.object.sha,url,observedAt:new Date().toISOString()}};
  }
  return {read,requiresReceipt:work=>marked(work)||granted(work)};
}
