// Compile every addon page with Hydro's production federation and target.
// Run in Linux against the separately installed UI package before release.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const esbuild = require('esbuild');
const root = path.resolve(__dirname,'../..');
const localRequire = createRequire(path.join(root,'package.json'));
const mod={exports:{}};
new Function('module','exports','require','__dirname',esbuild.transformSync(
  fs.readFileSync(path.join(root,'editor-draft-build.ts'),'utf8'),{loader:'ts',format:'cjs'}).code)(mod,mod.exports,localRequire,root);
const federation={name:'native-federation-fixture',setup(build){
  const names={'react/jsx-runtime':'jsxRuntime',react:'React','react-dom/client':'ReactDOM','react-dom':'ReactDOM',jquery:'$'};
  build.onResolve({filter:/^@hydrooj\/ui-default/},()=>({path:'api',namespace:'ui-default'}));
  for(const name of Object.keys(names))build.onResolve({filter:new RegExp(`^${name}$`)},()=>({path:names[name],namespace:'ui-default'}));
  build.onLoad({filter:/.*/,namespace:'ui-default'},args=>({contents:args.path==='api'?'module.exports = window.HydroExports;':`module.exports = window.HydroExports[${JSON.stringify(args.path)}];`,loader:'tsx'}));
}};
(async()=>{
  const pages=fs.readdirSync(path.join(root,'frontend')).filter(name=>/\.page\.[jt]sx?$/.test(name));
  const result=await esbuild.build({stdin:{contents:pages.map(name=>`import ${JSON.stringify(path.join(root,'frontend',name))};`).join('\n'),resolveDir:require('node:os').tmpdir(),loader:'ts'},
    tsconfigRaw:'{"compilerOptions":{"experimentalDecorators":true}}',format:'iife',bundle:true,write:false,
    outdir:require('node:os').tmpdir(),target:['chrome65'],minify:true,
    plugins:[mod.exports.createEditorDraftBuildPlugin(),federation]});
  if(result.errors.length)throw Error('Frontend build failed');
  const js=result.outputFiles.filter(f=>f.path.endsWith('.js')).map(f=>f.text).join('\n');
  const css=result.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
  for(const marker of ['oi33-scoreboard-query','oi33DraftGuard','data-article-compose','oi33-training-chapters']) {
    if(!js.includes(marker)&&!css.includes(marker))throw Error(`Missing built feature: ${marker}`);
  }
  const report={ok:true,pages:pages.length,javascriptBytes:Buffer.byteLength(js),cssBytes:Buffer.byteLength(css),
    uiPackage:localRequire.resolve('@hydrooj/ui-default/package.json'),reduxPackage:localRequire.resolve('redux'),warnings:result.warnings.length};
  fs.mkdirSync(path.join(__dirname,'reports'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'reports/frontend-build.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
