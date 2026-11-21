import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from '../src/host/checks.mjs';
import { nativeOnly, subprocessHost, detachedCheck, activeCheck, pidFrom } from './checks-native-helper.mjs';

test('group cancellation reaps detached descendants of a completed first command',nativeOnly,async t=>{
  const subprocess=await subprocessHost(t);
  const dir=mkdtempSync(join(process.env.TMPDIR,'loom-checks-container-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=join(dir,'first'),second=join(dir,'second'),controller=new AbortController();
  const running=runChecks(dir,[detachedCheck(first),activeCheck(second)],{subprocess,commandConsent:true,signal:controller.signal});
  const rejected=assert.rejects(running,{name:'AbortError'});
  const pids=[await pidFrom(first),await pidFrom(second)];
  pids.forEach(pid=>process.kill(pid,0));
  controller.abort();
  await rejected;
  pids.forEach(pid=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}));
});
