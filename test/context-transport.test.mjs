import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installed, native } from './context-native-helper.mjs';
import { WireObserver } from '../src/context/wire.mjs';
import { contextConfig } from '../src/context/budget.mjs';

test('DeepSeek reports actual input, output and cached usage after an HTTP request', {skip:!installed,timeout:15000},async()=>{
  const directory=await mkdtemp(join(process.env.TMPDIR,'loom-deepseek-wire-')),received=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;received.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{usage:{input_tokens:7,cache_read_input_tokens:11}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:'OK'}},{type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const {DeepSeekAdapter,resolveAdapterOptions}=native('dsh-llm-deepseek');
  const observer=new WireObserver({directory,getConfig:()=>contextConfig({debug:true}),owns:id=>id==='probe',identity:()=>({busId:'bus',segment:1})});
  observer.install();
  try {
    const provider='deepseek-official',model='deepseek-flash';
    const adapter=new DeepSeekAdapter({options:()=>resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}`,thinking:'disabled',models:[{id:model,maxTokens:64}]}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'local-probe',prepareExtensions:async()=>({fields:{loom_probe:'extension present only at final boundary'},accept:async()=>{}})});
    const options={provider,model,sessionId:'probe',maxTokens:64,messages:[native('dsh-llm').createUserMessage({source:{kind:'user'},content:[{type:'text',text:'transport probe'}]})]};
    const consume=async()=>{for await(const _ of observer.observe(options,()=>adapter.stream(options))) {}};
    await consume();
    assert.deepEqual(observer.status().latest.usage,{inputTokens:7,cacheReadTokens:11,outputTokens:1,totalTokens:19});
    assert.equal(observer.status().callsWithUsage,1);
    const records=(await readFile(join(directory,'wire-0.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.type==='wire-request');
    assert.equal(records.length,1);assert.deepEqual(records.map(row=>row.payload),received);
    assert.equal(JSON.parse(received[0]).loom_probe,'extension present only at final boundary');
  } finally {await observer.dispose();server.close();await once(server,'close');await rm(directory,{recursive:true,force:true});}
});
