import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as host from '../src/host/report-preview.mjs';


async function dirs(t) {
  const root=await mkdtemp(join(process.env.TMPDIR || tmpdir(),'loom-read-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
test('native report preview reads the original English and Chinese text and keeps each revision separate',async t=>{
  const root=await dirs(t), doc={id:'doc-1',role:'worker',title:'盘点结果',runId:'r-1',english:'Three files matched.\n\n| a | b |',chinese:'三份文件相符。'};
  const file=await host.materializeDocument(root,doc);
  assert.match(file,/\.md$/);const content=await readFile(file,'utf8');
  assert.ok(content.indexOf(doc.english)>=0 && content.indexOf(doc.chinese)>content.indexOf(doc.english));
  assert.equal(await host.materializeDocument(root,doc),file);
  const supplement=await host.materializeDocument(root,{...doc,id:'doc-2',role:'coordinator',title:'待决定事项',english:'Choose a folder.',chinese:'请选择目录。'});
  assert.notEqual(supplement,file);assert.equal(await readFile(file,'utf8'),content);
});

test('published deliveries resolve inside the project; missing or out-of-project files are rejected',async t=>{
  const root=await dirs(t),project=join(root,'workspace');await mkdir(project);const file='结果 #1.html';
  await writeFile(join(project,file),'<p>完成</p>');
  assert.equal(await host.deliveryPath(project,file),file);

  await assert.rejects(host.deliveryPath(project,'missing.html'),{code:'NOT_FOUND'});
  await writeFile(join(root,'outside.md'),'private');
  await assert.rejects(host.deliveryPath(project,'../outside.md'),{code:'INVALID_INPUT'});
});
