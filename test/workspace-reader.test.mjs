import test from 'node:test';
import assert from 'node:assert/strict';
import { act, inject, mount, ok } from './workspace-reader-helper.mjs';

const target = { sessionId: 'worker', path: 'output/file.txt' };
const delivery = { workId: 'work', runId: 'run', index: 0 };
const page = (text, offset = 1, eof = true, version = 'v1') => ok({ text, offset, lines: text.split('\n').length, eof, version, absolutePath: target.path });

test('the workbench reads the selected delivery under its run session and closes locally', async t => {
  const face = inject({ preview(request) { assert.deepEqual(request, delivery); return ok(target); },
    read(sessionId, path, range, signal) { assert.equal(sessionId, target.sessionId); assert.equal(path, target.path); assert.deepEqual(range, { offset: 1 }); assert.ok(signal instanceof AbortSignal); return page('交付文件正文'); } });
  const view = await mount(t, face, delivery);
  assert.match(view.text(), /交付文件正文/);
  assert.equal(view.ui.root.findAllByType('dialog').length, 0, 'the reader uses the inline panel');
  await view.click('返回'); assert.equal(view.closed(), 1);
});

test('a bilingual report retains both languages across a page boundary, including fenced source', async t => {
  const request = { workId: 'work', documentId: 'report' };
  const face = inject({ preview(input) { assert.deepEqual(input, request); return ok({ sessionId: 'previous-run', path: 'C:/control/报告.md' }); },
    read(id, path, { offset }) { assert.equal(id, 'previous-run'); assert.equal(path, 'C:/control/报告.md');
      if (offset === 1) return page('# Report\n\n## English\n\nBoth `rows` match.\n\n- first item', 1, false);
      assert.equal(offset, 8); return page('\n## 中文\n\n两行均匹配。\n```txt\n# 原文\n```', offset); } });
  const view = await mount(t, face, request, '执行报告');
  assert.deepEqual(view.ui.root.findByType('li').children, ['first item']);
  assert.deepEqual(view.ui.root.findByType('code').children, ['rows']);
  await view.click('继续阅读');
  assert.deepEqual(view.ui.root.findByType('article').findAllByType('h2').map(n => n.children.join('')), ['English', '中文']);
  assert.deepEqual(view.ui.root.findByType('li').children, ['first item']);
  assert.match(view.text(), /两行均匹配。/); assert.match(view.text(), /# 原文/);
});

test('HTML is read as a complete document in an isolated static frame', async t => {
  const html = '<h1>核对结果</h1><script>document.title="unexpected"</script>';
  const face = inject({ preview: () => ok({ ...target, path: '交付 #1.HTML' }),
    readBytes(id, path, options, signal) { assert.equal(id, 'worker'); assert.equal(path, '交付 #1.HTML'); assert.deepEqual(options, {}); assert.ok(signal instanceof AbortSignal);
      return ok({ data: new TextEncoder().encode(html), eof: true }); } });
  const view = await mount(t, face, delivery);
  const frame = view.ui.root.findByType('iframe');
  assert.equal(frame.props.sandbox, ''); assert.match(frame.props.srcDoc, /<h1>核对结果<\/h1>/);
  assert.ok(frame.props.srcDoc.indexOf("default-src 'none'") < frame.props.srcDoc.indexOf('<h1>')); assert.doesNotMatch(frame.props.srcDoc, /<script/i);
  assert.equal(view.ui.root.findAllByType('script').length, 0);
});

test('a malformed HTML file reports an error without closing the reader', async t => {
  const face=inject({preview:()=>ok({...target,path:'broken.html'}),readBytes:()=>ok({eof:true,data:Uint8Array.of(255)})});
  const view=await mount(t,face,delivery);
  assert.ok(view.ui.root.findByProps({role:'alert'})); await view.click('返回'); assert.equal(view.closed(),1);
});

test('a non-text delivery offers its original bytes as a download in the reader', async t => {
  const bytes = Uint8Array.from([0, 255, 23]), file = { ...target, path: '输出/测量.raw' };
  const face = inject({ preview: () => ok(file), read: () => ({ ok: false, error: { code: 'workspace-file/not-text', message: 'binary' } }),
    readBytes(id, path, options) { assert.equal(id, target.sessionId); assert.equal(path, file.path); assert.deepEqual(options, {}); return ok({ data: bytes, eof: true }); } });
  const view = await mount(t, face, delivery);
  assert.match(view.text(), /测量.raw/); await view.click('准备下载');
  const link = view.ui.root.findByType('a'); assert.equal(link.props.download, '测量.raw');
  assert.deepEqual(new Uint8Array(await (await fetch(link.props.href)).arrayBuffer()), bytes);
});

test('retry revalidates the original request; a late read cannot overwrite the next selection', async t => {
  let attempt = 0, calls = [], release, oldSignal;
  const face = inject({ preview(req) { calls.push(req); return ok({ ...target, path: req.index === 0 ? 'first.txt' : 'next.txt' }); },
    read(_id, path, _range, signal) {
      if (path === 'next.txt') return page('新文件正文');
      if (++attempt === 1) return { ok: false, error: { code: 'FORBIDDEN', message: 'read denied' } };
      oldSignal = signal; return new Promise(resolve => { release = resolve; });
    } });
  const view = await mount(t, face, delivery);
  assert.match(view.text(), /read denied/); await view.click('重试');
  const next = { ...delivery, index: 1 }; await view.switchTo(next, '另一文件');
  assert.deepEqual(calls, [delivery, delivery, next]); assert.equal(oldSignal.aborted, true);
  await act(async () => release(page('旧文件正文')));
  assert.match(view.text(), /新文件正文/); assert.doesNotMatch(view.text(), /旧文件正文/);
});
