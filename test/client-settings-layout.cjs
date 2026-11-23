// Run from a standalone Electron runtime: electron test/client-settings-layout.cjs
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');

app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'loom-settings-layout-')));

async function run() {
  const { styles } = await import('../src/client/styles.mjs');
  const bundle = await build({
    stdin: { loader: 'jsx', resolveDir: resolve(__dirname, '..'), contents: `
      import { createRoot } from 'react-dom/client';
      import { SettingsPanel } from './src/client/panels.jsx';
      const base = {provider:'fixture', model:'one', reasoningEffort:'high'};
      const catalog = {default:base, groups:[{id:'fixture', name:'Fixture', models:[
        {id:'one', name:'First', reasoning:{efforts:[{id:'high', name:'High'}]}}, {id:'two', name:'Second'}]}]};
      let saved = {version:1, roleModels:{bus:base, review:base, worker:base, acceptance:base}, permissionPreset:null, context:{debug:false}};
      const values = {permissions:{defaultOptions:[{value:'workspace-write', name:'Workspace write'}]}, usage:{items:[]}};
      const api = {rpc:async method => method==='snapshot' ? {settings:saved} : values[method]};
      const execute = async input => {
        window.commands.push(input);
        saved = {...saved, version:saved.version+1, permissionPreset:input.permissionPreset};
      };
      window.commands = [];
      const status = {context:{status:'idle'}, engine:{ready:true}};
      createRoot(document.querySelector('.loom-root')).render(<SettingsPanel settings={saved} {...{catalog,api,status,execute}} />);
    ` },
    bundle: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, write: false,
  });
  const html = `<!doctype html><meta charset="utf-8"><style>${styles}
    body{margin:0;font-family:sans-serif} #outer{height:460px;overflow:auto}
    .loom-root{position:relative;width:304px;height:320px;--dsw-font-family:sans-serif}
  </style><div id="outer"><div style="height:100px"></div><div class="loom-root"></div><div style="height:500px"></div></div>`;
  const win = new BrowserWindow({ show: false, width: 580, height: 580, webPreferences: { backgroundThrottling: false, partition: 'loom-settings-layout' } });
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  const contents = win.webContents;
  const cdp = contents.debugger;
  cdp.attach();
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const page = source => contents.executeJavaScript(source);
  const settle = () => page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
  async function press(key, windowsVirtualKeyCode, text = '') {
    const params = { key, code: key, windowsVirtualKeyCode };
    await cdp.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', text });
    await cdp.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await settle();
  }
  await page(bundle.outputFiles[0].text);
  await page(`new Promise(resolve => {
    const poll = () => document.querySelector('[aria-label="执行权限"] option[value="workspace-write"]') ? resolve() : requestAnimationFrame(poll);
    poll();
  })`);
  await page(`
    window.bodyScroll = document.querySelector('.loom-page-body');
    window.outer = document.querySelector('#outer');
    window.save = document.querySelector('button[type=submit]');
    window.roles = document.querySelector('details[aria-label="分角色模型"]');
    window.debug = [...document.querySelectorAll('summary')].find(node => node.textContent.startsWith('高级与诊断')).parentElement;
    window.box = node => {
      const {top, bottom, left, right} = node.getBoundingClientRect();
      return {top, bottom, left, right};
    };
    window.draft = document.querySelector('[aria-label="执行权限"]');
    draft.value = 'workspace-write';
    draft.dispatchEvent(new Event('change', {bubbles:true}));
    outer.scrollTop = 40;
  `);
  const reveal = await page(`(() => {
    roles.firstElementChild.focus({preventScroll:true});
    const gap = box(bodyScroll).bottom - box(roles.firstElementChild).bottom;
    bodyScroll.scrollTop += 6 - gap;
    return {top:bodyScroll.scrollTop, outer:outer.scrollTop, save:box(save)};
  })()`);
  await press('Enter', 13, '\r');
  const opened = await page(`({open:roles.open, top:bodyScroll.scrollTop, outer:outer.scrollTop, body:box(bodyScroll),
    summary:box(roles.firstElementChild), first:box(roles.querySelector('select')), save:box(save), focus:document.activeElement===roles.firstElementChild})`);
  assert.equal(opened.open, true);
  assert.ok(opened.first.bottom <= opened.body.bottom, `role model clipped after opening: ${JSON.stringify(opened)}`);
  assert.ok(opened.summary.top >= opened.body.top && opened.focus, 'the activated summary stays visible and focused');
  assert.equal(opened.outer, reveal.outer);
  assert.deepEqual(opened.save, reveal.save);
  assert.ok(opened.top > reveal.top && opened.body.bottom - opened.first.bottom <= 10, 'opening scrolls only enough to reveal the first control');
  await press('Tab', 9);
  assert.equal(await page('document.activeElement.getAttribute("aria-label")'), '协调');

  await page('roles.firstElementChild.focus();');
  await press('Enter', 13, '\r');
  assert.equal(await page('roles.open'), false);
  const below = await page(`(() => {
    debug.firstElementChild.focus();
    return {outer:outer.scrollTop, save:box(save), summary:box(debug.firstElementChild)};
  })()`);
  const pointer = { x: below.summary.left + 8, y: (below.summary.top + below.summary.bottom) / 2, button: 'left', clickCount: 1 };
  await cdp.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mousePressed' });
  await cdp.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mouseReleased' });
  await settle();
  const diagnostics = await page(`({open:debug.open, summary:box(debug.firstElementChild), first:box(draft.form.querySelector('input[type=checkbox]')),
    body:box(bodyScroll), save:box(save), outer:outer.scrollTop, draft:draft.value, focus:document.activeElement===debug.firstElementChild})`);
  assert.equal(diagnostics.open, true);
  assert.ok(diagnostics.summary.top >= diagnostics.body.top && diagnostics.first.bottom <= diagnostics.body.bottom && diagnostics.focus,
    `diagnostics should reveal its first control and keep focus: ${JSON.stringify(diagnostics)}`);
  assert.equal(diagnostics.outer, below.outer);
  assert.deepEqual(diagnostics.save, below.save);
  assert.equal(diagnostics.draft, 'workspace-write');
  assert.ok(diagnostics.save.top >= diagnostics.body.bottom, 'save occupies separate space below the scrollport');
  const end = await page(`(() => {
    bodyScroll.scrollTop = bodyScroll.scrollHeight;
    const tail = window.tail = [...debug.querySelectorAll('summary')].at(-1);
    const rect = box(tail);
    return {tail:rect, body:box(bodyScroll), save:box(save), top:bodyScroll.scrollTop,
      hit:document.elementFromPoint(rect.left+8,(rect.top+rect.bottom)/2)===tail,
      horizontal:bodyScroll.scrollWidth>bodyScroll.clientWidth};
  })()`);
  assert.ok(end.tail.bottom <= end.body.bottom && end.tail.bottom <= end.save.top && end.hit && !end.horizontal,
    `final diagnostics control must be reachable above save: ${JSON.stringify(end)}`);
  await page('tail.focus({preventScroll:true});');
  await press('Enter', 13, '\r');
  assert.deepEqual(await page('({open:tail.parentElement.open, top:bodyScroll.scrollTop})'), { open: true, top: end.top },
    'opening a nested detail keeps the diagnostics scroll position');
  assert.equal(await page('commands.length'), 0);
  await page('save.focus({preventScroll:true});');
  await press('Enter', 13, '\r');
  assert.deepEqual(await page('commands'), [{ type: 'settings.update', expectedVersion: 1, roleModels: {}, permissionPreset: 'workspace-write' }]);
  assert.equal(await page('document.querySelector(".loom-success").textContent'), '设置已保存。');
}

setTimeout(() => { console.error('Settings layout test timed out'); app.exit(1); }, 15000).unref();
app.whenReady().then(run).then(() => {
  console.log('PASS: settings disclosure layout and keyboard navigation');
  app.exit(0);
}, error => { console.error(error); app.exit(1); });
