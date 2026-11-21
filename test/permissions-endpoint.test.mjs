import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed, permissionHost } from './permissions-native-helper.mjs';
import * as loom from '../src/index.mjs';
import * as bootstrap from '../src/bootstrap.mjs';

test('plugin injects native permissions and exposes a read-only catalog RPC',{skip:!installed},async t=>{
  const host=await permissionHost(t),routes=new Map();
  host.root.provide('connection',{fetch:{register:route=>{routes.set(route.path,route);return ()=>routes.delete(route.path);}}});
  host.root.provide('webServer',{});
  host.root.provide('subprocess',{});
  host.root.provide('workspaceController',{create:async({path})=>{const workspace=await host.ctx.workspaceRegistry.create(path,'Loom control');return {workspace:{workspaceId:workspace.id}};}});
  host.root.provide('sessionController',{modelCatalog:async()=>({groups:[],default:null})});
  await host.root.plugin(bootstrap,{directory:join(host.directory,'loom')}).await();
  const plugin=await host.root.plugin(loom,{directory:join(host.directory,'loom'),intervalMs:60000}).await();
  t.after(()=>plugin.dispose());
  const route=routes.get('/api/loom/permissions');
  assert.ok(route,'permissions RPC must be registered');
  assert.ok(loom.inject.includes('permissionPresets'));
  const before=host.permissions.catalog();
  const response=await route.fetch(new Request('http://localhost/api/loom/permissions',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'permission-catalog',method:'loom/permissions',payload:{permissionPreset:'danger-full-access'}})}));
  const envelope=await response.json();
  assert.equal(envelope.result.ok,true);
  assert.deepEqual(envelope.result.value,before);
  assert.deepEqual(host.permissions.catalog(),before);
});
