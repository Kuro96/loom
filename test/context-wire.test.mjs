import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WireObserver } from '../src/context/wire.mjs';
import { contextConfig } from '../src/context/budget.mjs';

test('HTTP receives the full request when its debug record exceeds a journal page', async () => {
  const directory=await mkdtemp(join(process.env.TMPDIR,'loom-wire-')),received=[];
  const server=createServer(async(req,res)=>{let body='';for await(const part of req) body+=part;received.push(body);res.end();});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/v1/chat/completions?key=hidden`;
  const config=contextConfig({debug:true,debugMaxBytes:1000,debugFiles:3});
  const observer=new WireObserver({getAdditionalProviders:()=>['loom-test-provider'],directory,getConfig:()=>config,owns:id=>id==='owned',identity:()=>({busId:'bus'})});
  const original=globalThis.fetch;
  observer.install();
  try {
    const body=JSON.stringify({messages:[{role:'user',content:'private-text'.repeat(20000)}]});
    const final={inputTokens:3,outputTokens:1,cacheReadTokens:4,totalTokens:8};
    for await(const _ of observer.observe({sessionId:'owned',provider:'loom-test-provider',model:'x'},async function*(){
      await fetch(url,{method:'POST',headers:{authorization:'Bearer header-secret-12345','content-type':'application/json'},body});
      yield {type:'usage',usage:{inputTokens:1,outputTokens:0}};
      yield {type:'usage',usage:final};
    })) {}
    assert.deepEqual(received,[body]);
    const status=observer.status();
    assert.deepEqual(status.latest.usage,final);
    assert.deepEqual(status.usageTotals,final);
    const files=await readdir(directory);
    assert.ok(files.length>=1 && files.length<=config.debugFiles);
    for(const file of files) assert.ok((await stat(join(directory,file))).size<=config.debugMaxBytes);
    const log=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).join('');
    assert.doesNotMatch(log,/header-secret-12345|\?key=|private-text/);
    const requests=log.trim().split('\n').map(JSON.parse).filter(row=>row.type==='wire-request');
    assert.ok(requests.some(row=>row.wireBytes===Buffer.byteLength(body) && !Object.hasOwn(row,'payload')));
  } finally {await observer.dispose();assert.equal(globalThis.fetch,original);server.close();await once(server,'close');await rm(directory,{recursive:true,force:true});}
});
