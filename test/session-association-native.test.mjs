import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installed, native, nativeHost } from './context-native-helper.mjs';
import { startupHost, testModel } from './host-native-helper.mjs';
import * as bootstrap from '../src/bootstrap.mjs';
import * as loom from '../src/index.mjs';

async function createSession(host, workspace, sessionId, title) {
  const owner=await host.ctx.agents.create({sessionId,meta:{cwd:workspace.path},agentOptions:testModel});
  await workspace.attachSession(sessionId);
  await host.ctx.sessionController.rename({sessionId,title});
  return owner;
}

for(const compression of ['none','zstd']) {
  test(`native ${compression} associations isolate a rejected session artifact`,{skip:!installed,timeout:30000},async t=>{
    const host=await startupHost(undefined,{},compression); t.after(()=>host.close());
    const {ctx,workspace}=host;
    const directory=join(host.directory,'loom');
    await host.root.plugin(bootstrap,{directory}).await();
    await host.root.plugin(loom,{directory,intervalMs:60000}).await();
    const elsewherePath=join(host.directory,'elsewhere');await mkdir(elsewherePath);
    const elsewhere=await ctx.workspaceRegistry.create(elsewherePath,'Other project');
    const good=await createSession(host,workspace,'good-cold','同项目历史');
    const bad=await createSession(host,workspace,'wrong-encoding','同项目旧记录');
    const live=await createSession(host,workspace,'good-live','同项目活动会话');
    const other=await createSession(host,elsewhere,'other-project','另一项目');
    const localPath=ctx.sessionPersistence.locate(bad.agent.session.header).path;
    await good.dispose();await bad.dispose();await other.dispose();
    assert.equal(ctx.agents.get(good.agent.id),undefined);
    const opposite=await nativeHost(compression==='none'?'zstd':'none');t.after(()=>opposite.close());
    const encoded=await opposite.ctx.agents.create({sessionId:bad.agent.id,meta:{cwd:workspace.path},agentOptions:testModel});
    const encodedPath=opposite.ctx.sessionPersistence.locate(encoded.agent.session.header).path;
    await opposite.ctx.sessionPersistence.flush();await encoded.dispose();
    const incompatible=join(dirname(localPath),compression==='none'?'session.v4.jsonl.zstd':'session.v4.jsonl');
    await copyFile(encodedPath,incompatible);await rm(localPath);
    const original=await readFile(incompatible);

    const signal=new AbortController().signal;
    await assert.rejects(ctx.sessionController.list({},signal),error=>error.code==='SESSION_QUERY_PERSISTENCE_FAILED' && error.cause.message.includes('configured for compression'));
    const peer=ctx.connection.createPeer({principal:{kind:'owner'}});
    const route=ctx.connection.createSharedFetchHandler('/api');
    async function rpc(endpoint,payload) {
      const method=`loom/${endpoint}`;
      const response=await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:endpoint,method,payload})}),peer);
      return (await response.json()).result;
    }
    try {
      const listed=await rpc('nativeSessions',{workspaceId:workspace.id});
      assert.equal(listed.ok,true,JSON.stringify(listed));
      assert.deepEqual(new Map(listed.value.items.map(row=>[row.sessionId,row.title])),new Map([
        [good.agent.id,'同项目历史'],[live.agent.id,'同项目活动会话'],
      ]));
      assert.deepEqual(listed.value.unavailable.map(row=>row.sessionId),[bad.agent.id]);
      const global=await rpc('nativeSessions',{});
      assert.equal(global.ok,true,JSON.stringify(global));
      assert.deepEqual(new Set(global.value.map(row=>row.sessionId)),new Set([good.agent.id,live.agent.id,other.agent.id]));
      const associate=sessionId=>rpc('command',{type:'work.create',workspaceId:workspace.id,sessionId,title:'延续已有工作'});
      const work=await associate(good.agent.id);
      assert.equal(work.ok,true,JSON.stringify(work));
      assert.equal(work.value.sessionId,good.agent.id);
      assert.equal(ctx.agents.get(good.agent.id),undefined);
      assert.equal((await associate(bad.agent.id)).error.code,'SESSION_QUERY_PERSISTENCE_FAILED');
      assert.match((await associate(other.agent.id)).error.message,/必须属于所选工作区/);

      // A fresh backend rejects the mixed root even for a matching artifact.
      const {Context}=native('cordis'), fresh=new Context();
      try {
        await fresh.plugin(native('dsh-session-persistence-jsonl'),{root:join(host.directory,'sessions'),compression}).await();
        const persistence=fresh.get('sessionPersistence');
        await assert.rejects(persistence.stat(good.agent.id),/configured for compression/);
        await assert.rejects(persistence.open(good.agent.id,'read'),/configured for compression/);
      } finally {await fresh.fiber.dispose();}
      assert.deepEqual(await readFile(incompatible),original);
    } finally {
      await peer.dispose();
      await live.dispose();
    }
  });
}
