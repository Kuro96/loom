import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {native,nativeHost} from './context-native-helper.mjs';
import {inject} from '../src/index.mjs';

export const testModel={provider:'loom-test-provider',model:'fixture-flash'};
export async function deadline(promise,label,ms=5000) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`timeout: ${label}`)),ms);})]);}
  finally{clearTimeout(timer);}
}
export async function startupHost(respond=(_wire,_req,res)=>{res.writeHead(418);res.end('startup transport probe');}, modelOptions={}) {
  const host=await nativeHost(),received=[];
  const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const wire=JSON.parse(body);received.push(wire);await respond(wire,req,res);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const add=async(name,config={})=>{const mod=native(name);return deadline(host.root.plugin(mod.default??mod,config).await(),`load ${name}`);};
  try {
    await add('dsh-llm-pi-ai',{providers:{'loom-test-provider':{api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,headers:{authorization:'Bearer local-startup'},models:[{id:testModel.model,...modelOptions}],retryPolicy:{mode:'normal',maxRetries:0}}}});
    await add('dsh-agent-default-model',testModel);
    await add('dsh-session-query');await add('dsh-session-title',{fallbackMaxWords:8,fallbackMaxBytes:96,maxTitleBytes:120});
    await add('dsh-credentials-local',{dshHome:host.directory,path:join(host.directory,'credentials'),watch:false});
    await add('dsh-host-webserver',{host:'127.0.0.1',port:0});
    await add('dsh-client-connection');await add('dsh-typert-registry');await add('dsh-api-remote-access');await add('dsh-api-gateway');
    await add('dsh-fs-local',{cwd:host.directory,diffBasisMaxBytes:1048576});
    await add('dsh-attachment-local',{dshHome:host.directory});await add('dsh-commands');await add('dsh-client-file-upload');
    await add('dsh-subprocess-local');await add('dsh-sandbox-local');
    await add('dsh-sandbox-policy',{mode:'workspace-write',additionalWritableRoots:[]});
    await add('dsh-pwsh-sandbox',{cwd:host.directory});await add('dsh-user-approval');await add('dsh-permission-presets');
    await add('dsh-api-workspace-controller');await add('dsh-api-session-controller',{nativeOpen:false});
    let ctx;
    await host.root.plugin({name:'startup-driver',inject:[...inject.filter(name=>name!=='loomBootstrap'),'sessions'],apply(c){ctx=c;}}).await();
    return {...host,ctx,received,async close(){server.close();await once(server,'close');await host.close();}};
  }catch(error){server.close();await once(server,'close');await host.close();throw error;}
}
