import test from 'node:test';
import assert from 'node:assert/strict';
import { installed, native, permissionHost } from './permissions-native-helper.mjs';

test('native permission helper sets the durable preset and both knobs, preserves null and verifies readback',{skip:!installed},async t=>{
  const host=await permissionHost(t);
  const {Session,SessionId}=native('dsh-session');
  const session=Session.create(SessionId('permission-helper'));
  assert.equal(host.permissions.current(session),'workspace-write');
  const {applyPermissionPreset}=await import('../src/permissions.mjs');
  const ctx={permissionPresets:host.permissions};
  assert.equal(applyPermissionPreset(ctx,session,'danger-full-access'),'danger-full-access');
  assert.equal(host.permissions.current(session),'danger-full-access');
  assert.equal(host.permissions.defaultPreset,'workspace-write');
  const entries=session.snapshotEvents();
  assert.deepEqual(entries.filter(e=>['permission/preset','sandbox/mode','approval/policy'].includes(e.type)).map(e=>[e.type,e.data]),[
    ['permission/preset',{preset:'danger-full-access'}],['sandbox/mode',{mode:'danger-full-access'}],['approval/policy',{policy:'never'}],
  ]);
  const seq=session.seq;
  applyPermissionPreset(ctx,session,null);
  applyPermissionPreset(ctx,session,'danger-full-access');
  assert.equal(session.seq,seq);
  assert.throws(()=>applyPermissionPreset(ctx,session,'absent'),/unknown preset/);
  assert.equal(session.seq,seq);
  assert.throws(()=>applyPermissionPreset({permissionPresets:{set:()=>{},current:()=> 'workspace-write'}},session,'danger-full-access'),/读回/);
});
