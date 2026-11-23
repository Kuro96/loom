import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir(new URL('../lib/',import.meta.url),{recursive:true});
await build({entryPoints:['src/index.mjs'],outfile:'lib/index.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true});
await build({entryPoints:['src/bootstrap.mjs'],outfile:'lib/bootstrap.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true});
const id=JSON.stringify(manifest.name);
const result=await build({entryPoints:['src/client/index.jsx'],outfile:'lib/client.js',bundle:true,write:false,platform:'browser',format:'cjs',target:'es2022',jsx:'automatic',external:['react','react/*','react-dom','@deepseek-ai/dsh-client-ui-primitives'],banner:{js:`window.__ModuleLoader__.load({id:${id},factory:function(require){var module={exports:{}};var exports=module.exports;`},footer:{js:'return module.exports;}});'},sourcemap:true});
const css=result.outputFiles.find(f=>f.path.endsWith('.css')).text;
for(const f of result.outputFiles.filter(f=>f.path.endsWith('.js')||f.path.endsWith('.js.map'))) await writeFile(f.path, f.path.endsWith('.js')?f.text.replace(' + __LOOM_DOCUMENT_CSS__',()=>` + ${JSON.stringify(css)}`):f.contents);
// Publish DSH's original worker-equipped viewer chunks under the current bundle's loader identity.
const pkg='@deepseek-ai/dsh-client-ui-sidebar-documentpreview', dir=dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
for(const name of ['client.pdf.js','client.excel.js']) {
  const chunk=await readFile(join(dir,'lib',name),'utf8');
  const registration=`window.__ModuleLoader__.load({id:\`${pkg}\`,chunk:\`${name}\``;
  if(!chunk.includes(registration)) throw Error(`Unknown document viewer bundle: ${name}`);
  await writeFile(`lib/${name}`,chunk.replace(registration,`window.__ModuleLoader__.load({id:${id},chunk:\`${name}\``));
}
console.log(`Built ${manifest.name}@${manifest.version}: host + native client`);
