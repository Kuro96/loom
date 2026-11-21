import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from '../src/host/checks.mjs';
import { nativeOnly, subprocessHost, command } from './checks-native-helper.mjs';

const root = new URL('../.agents/verification/tmp/', import.meta.url);

test('command checks require explicit consent before starting a real process', nativeOnly, async t => {
  const subprocess=await subprocessHost(t);
  const dir=mkdtempSync(new URL('commands-',root));
  try {
    const checks=[{kind:'command',command,args:['-e',"require('fs').writeFileSync('verified.txt','done'); console.log('PROCESS_OK')"]}];
    const denied=await runChecks(dir,checks);
    assert.equal(denied[0].blocked,'approval_required');
    const allowed=await runChecks(dir,checks,{subprocess,commandConsent:true});
    assert.equal(allowed[0].passed,true);
    assert.equal(allowed[0].exitCode,0);
    assert.match(allowed[0].stdout,/PROCESS_OK/);
    assert.equal((await runChecks(dir,[{kind:'file',path:'verified.txt',contains:'done'}]))[0].passed,true);
  } finally {rmSync(dir,{recursive:true});}
});

mkdirSync(root,{recursive:true});

test('file acceptance checks read the actual delivered artifact', async () => {
  const dir=mkdtempSync(new URL('checks-',root));
  try {
    writeFileSync(join(dir,'result.txt'),'LOOM_ARTIFACT_OK\n');
    const result=await runChecks(dir,[{kind:'file',path:'result.txt',contains:'LOOM_ARTIFACT_OK'}]);
    assert.equal(result[0].passed,true);
    assert.deepEqual(result[0].check,{kind:'file',path:'result.txt',contains:'LOOM_ARTIFACT_OK'});
    writeFileSync(join(dir,'result.txt'),'unfinished');
    assert.equal((await runChecks(dir,[{kind:'file',path:'result.txt',contains:'LOOM_ARTIFACT_OK'}]))[0].passed,false);
  } finally {rmSync(dir,{recursive:true});}
});

test('file checks reject escaping the workspace and report missing output', async () => {
  const dir=mkdtempSync(new URL('bounds-',root));
  try {
    await assert.rejects(runChecks(dir,[{kind:'file',path:'../outside.txt'}]),/工作区范围/);
    const missing=await runChecks(dir,[{kind:'file',path:'missing.txt'}]);
    assert.equal(missing[0].passed,false);
    assert.equal(missing[0].missing,true);
  } finally {rmSync(dir,{recursive:true});}
});
