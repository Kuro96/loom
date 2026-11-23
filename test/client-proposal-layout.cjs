// Run with standalone Electron: electron test/client-proposal-layout.cjs
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');

app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'loom-proposal-layout-')));

const binding = name => ({ kind: 'parameter', path: [name] });
const longCaption = '本次样本批次标识；请按批次登记核对原始材料和审核回包，不能仅凭文件名认定。';
const path = `review/${'sample-record-'.repeat(12)}manifest.json`;
const model = { provider: 'fixture', model: 'sample' };
const stage = (id, fields) => ({ id, title: id, dependsOn: [], outputs: [], checks: [], ...fields });
const data = {
  proposal: { id: 'fixture', workspaceId: 'docs', version: 1, execution: { model, permissionPreset: 'read-only' },
    parameters: { batch: 'Batch-07', source: path, settings: { enabled: true } },
    definitionSnapshot: { title: '样本批次核对', description: '核对登记、材料和审核回包，整理本批记录。', parameters: [
      { name: 'batch', description: longCaption }, { name: 'source', description: '回包文件路径' },
      { name: 'settings', description: '校验选项' },
    ], stages: [
      stage('核对样本回包', { instructions: '对照登记，检查原始材料与审核回包的对应关系。', scope: '只读核对样本和登记。', inputs: { batch: binding('batch'), source: binding('source'), settings: binding('settings') }, outputs: [{ description: '本批核对记录', required: true }], checks: [{kind:'file', path:'review/report.md'}] }),
    ] } },
  workspaces: [{ workspaceId: 'docs', title: '示例项目' }],
  catalog: { groups: [{ id: 'fixture', name: '示例服务', models: [{ id:'sample', name:'示例模型' }] }] },
};

async function run() {
  const { styles } = await import('../src/client/styles.mjs');
  const script = await build({ stdin: { loader: 'jsx', resolveDir: resolve(__dirname, '..'), contents: `
    import { createRoot } from 'react-dom/client';
    import { ProposalDialog } from './src/client/forms.jsx';
    const data = ${JSON.stringify(data)};
    window.actions = [];
    const track = name => () => window.actions.push(name);
    createRoot(document.querySelector('.loom-chat')).render(<ProposalDialog {...data}
      onClose={track('back')} onEdit={track('inputs')} onEditDefinition={track('instructions')} />);
  ` }, bundle: true, jsx:'automatic', define:{ 'process.env.NODE_ENV': '"production"' }, write:false });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}
    html, body{margin:0;height:100%}
    .loom-root{--dsw-font-family:system-ui,sans-serif;--ds-font-family-code:monospace;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-module-platform:#f5f6f8;--dsw-alias-border-l2:#dce0e5;--dsw-alias-label-primary:#20252c;--dsw-alias-label-secondary:#505964;--dsw-alias-brand-primary:#316ce0;--dsw-radius-sm:6px}
  </style><div class="loom-root"><div class="loom-chat"></div></div></html>`;
  const win = new BrowserWindow({ show:false, width:1098, height:714, useContentSize:true, webPreferences:{backgroundThrottling:false} });
  try {
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const page = code => win.webContents.executeJavaScript(code);
    const settle = () => page('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    await page(script.outputFiles[0].text);
    for (const [w,h] of [[1098,714],[390,520]]) {
      win.setContentSize(w,h);
      await settle();
      const result = await page(`(() => {
        const list=document.querySelector('.loom-decision-steps li dl.loom-summary'), row=list.firstElementChild;
        const title=row.querySelector('dt'), value=row.querySelector('dd');
        const box=node=>node.getBoundingClientRect();
        const [dt,dd]=[box(title),box(value)];
        const execution=[...document.querySelectorAll('dl.loom-summary dt')].find(n=>n.textContent==='执行模型');
        const scroll=title.closest('.loom-page-body');
        const actions=[...scroll.querySelectorAll('footer button')].map(n=>n.textContent);
        return {width:innerWidth, inputs:list.clientWidth,labelWidth:dt.width, sameLeft:Math.abs(dt.left-dd.left)<1,
          stacked:dd.top>=dt.bottom, intact:title.textContent==='批次'&&value.textContent==='Batch-07',
          compact:Math.abs(box(execution).top-box(execution.nextElementSibling).top)<1,
          heading:list.previousElementSibling?.textContent, pageOverflow:scroll.scrollWidth>scroll.clientWidth, actions};
      })()`);
      assert.equal(result.width,w);
      assert.equal(result.intact,true);
      assert.ok(result.stacked && result.sameLeft && result.labelWidth > result.inputs * 0.9, `input value is cramped: ${JSON.stringify(result)}`);
      assert.equal(result.heading,'本步输入');
      assert.equal(result.compact,true,'keep compact execution key/value rows');
      assert.equal(result.pageOverflow,false);
      assert.deepEqual(result.actions,['修改本次输入','修改本次说明','确认执行']);
      if (w===1098 && process.env.LOOM_PROPOSAL_CAPTURE) {
        await win.webContents.capturePage();
        const image=await win.webContents.capturePage();
        writeFileSync(process.env.LOOM_PROPOSAL_CAPTURE,image.toPNG());
      }
    }
    const disclosure = await page(`(() => {
      const summary=[...document.querySelectorAll('summary')].find(node=>node.textContent==='执行说明');
      const note=[...summary.parentElement.querySelectorAll('p')].find(node=>node.textContent.includes(${JSON.stringify(longCaption)}));
      const initiallyVisible=summary.parentElement.open;
      summary.click();
      return {initiallyVisible, expanded:summary.parentElement.open&&note.getBoundingClientRect().height>0};
    })()`);
    assert.deepEqual(disclosure,{initiallyVisible:false,expanded:true});
    await page(`document.querySelector('.loom-page header button').click();document.querySelector('footer button').click()`);
    assert.deepEqual(await page('window.actions'),['back','inputs']);
  } finally { win.destroy(); }
}

setTimeout(() => app.exit(2), 20000).unref();
app.whenReady().then(run).then(() => {
  console.log('PASS: workflow confirmation shows short labels and expands notes at desktop and narrow widths');
  app.exit(0);
}, error => { console.error(error); app.exit(1); });
