const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, buildSync, transformSync } = require('esbuild');
const { combineReducers, createStore } = require('redux');
const root = path.resolve(__dirname, '..');
const uiRoot = path.join(root, 'node_modules/@hydrooj/ui-default');
const compiled = buildSync({ entryPoints: [path.join(root, 'frontend/editor-draft-guard.ts')], bundle: true,
    write: false, format: 'cjs', external: ['@hydrooj/ui-default/*'] }).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { createEditorDraftReducer, editorDraftKey } = mod.exports;
const pluginMod = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', transformSync(fs.readFileSync(path.join(root,
    'editor-draft-build.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(pluginMod, pluginMod.exports, require, root);
const { createEditorDraftBuildPlugin } = pluginMod.exports;

test('actual native editor reducer: quota/security errors never prevent Redux code or language updates', () => {
    let blocked = false;
    const saved = new Map();
    const storage = { getItem: key => saved.get(key), setItem: (key, value) => {
        if (blocked) throw new DOMException('Storage unavailable', blocked);
        saved.set(key, value);
    } };
    const user = { _id: 42 }, context = { pdoc: { domainId: 'system', docId: 88 }, tdoc: { _id: 'contest-A' },
        codeLang: 'cc.cc14o2', codeTemplate: 'old code' };
    const nativeModule = { exports: {} };
    new Function('module', 'exports', 'UserContext', 'UiContext', 'localStorage', transformSync(fs.readFileSync(
        path.join(uiRoot, 'components/scratchpad/reducers/editor.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(
        nativeModule, nativeModule.exports, user, context, storage);
    const native = combineReducers({ editor: nativeModule.exports.default,
        records: (state = { retained: true }, action) => {
            if (action.type === 'UNRELATED_FAILURE') throw new Error('unrelated bug');
            return action.type === 'RECORD_UPDATE' ? { retained: false } : state;
        } });
    const store = createStore(native);
    const capturedDispatch = store.dispatch;
    blocked = 'QuotaExceededError';
    assert.throws(() => capturedDispatch({ type: 'SCRATCHPAD_EDITOR_UPDATE_CODE', payload: 'new code' }), /Storage unavailable/);
    assert.equal(store.getState().editor.code, 'old code', 'Reproduces the native defect before protection');
    const statuses = [];
    const guard = createEditorDraftReducer(native, editorDraftKey(user, context), storage, value => statuses.push(value));
    store.replaceReducer(guard.reducer);
    capturedDispatch({ type: 'SCRATCHPAD_EDITOR_UPDATE_CODE', payload: 'new code' });
    blocked = 'SecurityError';
    capturedDispatch({ type: 'SCRATCHPAD_EDITOR_SET_LANG', payload: 'py.py3' });
    assert.deepEqual(store.getState().editor, { code: 'new code', lang: 'py.py3' });
    assert.deepEqual(statuses.at(-1), { failed: true, fields: ['code', 'lang'] });
    capturedDispatch({ type: 'RECORD_UPDATE' });
    assert.equal(store.getState().records.retained, false);
    assert.throws(() => capturedDispatch({ type: 'UNRELATED_FAILURE' }), /unrelated bug/, 'Never swallow unrelated reducer errors');
    blocked = false;
    guard.save(store.getState().editor);
    assert.equal(guard.isFailed(), false);
    assert.deepEqual(Object.fromEntries(saved), { '42/system/88@contest-A': 'new code', '42/system/88@contest-A#lang': 'py.py3' });
});

test('draft cache keys retain native account/domain/problem/contest isolation', () => {
    const context = { pdoc: { domainId: 'system', docId: 88 } };
    const keys = [editorDraftKey({ _id: 42 }, context), editorDraftKey({ _id: 43 }, context),
        editorDraftKey({ _id: 42 }, { pdoc: { domainId: 'other', docId: 88 } }),
        editorDraftKey({ _id: 42 }, { pdoc: { domainId: 'system', docId: 89 } }),
        editorDraftKey({ _id: 42 }, { ...context, tdoc: { _id: 'contest-A' } }),
        editorDraftKey({ _id: 42 }, { ...context, tdoc: { _id: 'contest-B' } })];
    assert.equal(new Set(keys).size, 6);
    assert.equal(editorDraftKey({}, context), null);
    assert.equal(editorDraftKey({ _id: 42 }, {}), null);
});

test('production resolver bundles installed reducers before federation and rejects another importer', async () => {
    const federation = { name: 'fixture-hydro-federation', setup(builder) {
        builder.onResolve({ filter: /^@hydrooj\/ui-default/ }, () => ({ path: 'api', namespace: 'fixture-api' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-api' }, () => ({ contents: 'module.exports = window.HydroExports;' }));
    } };
    const result = await build({ entryPoints: [path.join(root, 'frontend/editor-draft-guard.ts')],
        bundle: true, write: false, format: 'iife', globalName: 'DraftGuard', metafile: true,
        plugins: [createEditorDraftBuildPlugin(), federation] });
    const inputs = Object.keys(result.metafile.inputs).map(value => value.replace(/\\/g, '/'));
    for (const reducer of ['index', 'editor', 'ui', 'pretest', 'records', 'state']) {
        assert.ok(inputs.some(value => value.endsWith(`/scratchpad/reducers/${reducer}.ts`)), reducer);
    }
    assert.ok(inputs.some(value => value.includes('/redux/')));
    assert.ok(inputs.some(value => value.includes('/lodash/')));
    assert.ok(inputs.some(value => value.includes('/@hydrooj/common/')));
    const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oi33-native-reducer-fixture-'));
    try {
        fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ version: '4.58.4' }));
        fs.cpSync(path.join(uiRoot, 'components/scratchpad/reducers'), path.join(temporary, 'components/scratchpad/reducers'), { recursive: true });
        const separate = await build({ entryPoints: [path.join(root, 'frontend/editor-draft-guard.ts')],
            bundle: true, write: false, format: 'iife', metafile: true,
            plugins: [createEditorDraftBuildPlugin(path.join(temporary, 'package.json')), federation] });
        assert.ok(Object.keys(separate.metafile.inputs).some(value => value.includes('oi33-native-reducer-fixture-')),
            'Production may keep the native UI outside the addon node_modules tree');
    } finally {
        assert.ok(path.resolve(temporary).startsWith(path.resolve(require('node:os').tmpdir()) + path.sep));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    await assert.rejects(build({ stdin: { contents: 'import "@hydrooj/ui-default/oi33-native-scratchpad-reducer";',
        sourcefile: 'unauthorized-fixture.ts', resolveDir: root }, bundle: true, write: false, logLevel: 'silent',
        plugins: [createEditorDraftBuildPlugin(), federation] }), /Unexpected native draft reducer importer/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real Monaco, native React Redux editor/toolbar and native reducers submit newest code when storage fails', async () => {
    const { chromium } = require('playwright');
    const publicRoot = path.join(uiRoot, 'public');
    const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
    const stubs = { name: 'fixture-only-react-api', setup(builder) {
        const libraries = { react: 'window.NativeHydro.React', 'react-redux': 'window.NativeHydro.redux',
            classnames: '(...items) => items.flatMap(item => typeof item === "string" ? [item] : Object.keys(item || {}).filter(key => item[key])).join(" ")',
            'prop-types': '{object:{},string:{},node:{},bool:{},func:{}}',
            'vj/context': '{ctx: window.fixtureCtx}',
            'vj/components/monaco/loader': '{load: (...args) => window.NativeHydro.loadMonaco(...args)}',
            'vj/utils': '{i18n: text => text, getAvailableLangs: () => window.LANGS, request: window.fixtureRequest}',
            'vj/components/react/IconComponent': '() => null' };
        builder.onResolve({ filter: /^(react|react-redux|prop-types|classnames|vj\/)/ }, args => libraries[args.path]
            ? { path: args.path, namespace: 'fixture-native-api' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture-native-api' }, args => ({ contents: `module.exports = ${libraries[args.path]};` }));
    } };
    const source = `import nativeReducer from ${JSON.stringify(path.join(uiRoot, 'components/scratchpad/reducers/index.ts'))};
        import Toolbar from ${JSON.stringify(path.join(uiRoot, 'components/scratchpad/ScratchpadToolbarContainer.jsx'))};
        import Editor from ${JSON.stringify(path.join(uiRoot, 'components/scratchpad/ScratchpadEditorContainer.tsx'))};
        import { installEditorDraftGuard } from ${JSON.stringify(path.join(root, 'frontend/editor-draft-guard.ts'))};
        window.setupNativeFixture = async () => {
            const {React, createRoot, Provider, store} = await window.NativeHydro.loadReactRedux(nativeReducer);
            window.store = store;
            window.fixtureCtx.scratchpad = {store, init(editor, monaco) {this.editor=editor;this.monaco=monaco;}};
            window.reactRoot = createRoot(document.querySelector('#scratchpad'));
            window.reactRoot.render(React.createElement(Provider, {store}, React.createElement('div', {className:'native-editor-pane'},
                React.createElement(Toolbar), React.createElement('div', {style:{height:'400px'}}, React.createElement(Editor)))));
            window.installGuard = () => installEditorDraftGuard(document.querySelector('#scratchpad'),store,UserContext,UiContext);
        };`;
    const bundle = (await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false,
        format: 'iife', plugins: [createEditorDraftBuildPlugin(), stubs] })).outputFiles[0].text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('http://draft.fixture.invalid/**', async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="scratchpad"></div></body></html>' });
            const file = path.resolve(publicRoot, '.' + pathname);
            if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript'
                : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
        });
        await page.goto('http://draft.fixture.invalid/fixture');
        await page.evaluate(() => {
            window.UserContext = JSON.stringify({ _id: 42, viewLang: 'en', codeFontFamily: 'monospace' });
            window.UiContext = JSON.stringify({ cdn_prefix: 'http://draft.fixture.invalid/',
                pdoc: { docId: 88, pid: 'Fixture', domainId: 'system', config: { type: 'default' } },
                tdoc: { _id: 'contest-A' }, codeTemplate: 'int main() { return 0; }', codeLang: 'cc.cc14o2',
                postSubmitUrl: '/p/88/submit?tid=contest-A' });
            window.UiContextNew = '{}'; window.UserContextNew = '{}';
        });
        await page.addScriptTag({ content: main });
        await page.evaluate(async () => {
            window.webpackChunk_hydrooj_ui_default.push([[987656], {}, require => { window.hydroRequire = require; }]);
            await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
            window.NativeHydro = window.hydroRequire(51604);
            window.React = window.NativeHydro.React;
            window.HydroExports = window.NativeHydro;
            window.LANGS = { 'cc.cc14o2': { display: 'C++14', monaco: 'cpp' }, 'cc.cc17': { display: 'C++17', monaco: 'cpp' } };
            window.fixtureCtx = {};
            window.posts = [];
            window.fixtureRequest = { post: (url, body) => { window.posts.push({ url, body }); return new Promise(resolve => { window.resolvePost = resolve; }); },
                get: () => Promise.resolve({ rdocs: [] }) };
            document.querySelector('.page-loader')?.remove();
        });
        await page.addScriptTag({ content: bundle });
        assert.deepEqual(errors, [], 'Native fixture bundle must initialize');
        await page.addStyleTag({ content: fs.readFileSync(path.join(publicRoot, 'theme-4.58.4.css'), 'utf8')
            + fs.readFileSync(path.join(root, 'frontend/problem-workbench.css'), 'utf8')
            + '#scratchpad{position:relative!important;inset:auto!important;width:1000px;height:600px;margin:30px auto}' });
        await page.evaluate(() => window.setupNativeFixture());
        await page.waitForFunction(() => !!window.fixtureCtx.scratchpad.editor);
        await page.evaluate(() => window.installGuard());
        assert.equal(await page.getAttribute('#scratchpad', 'data-oi33-draft-guard'), '1');
        await page.evaluate(() => {
            window.originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key.startsWith('42/system/88@contest-A')) throw new DOMException('fixture quota', 'QuotaExceededError');
                return window.originalSetItem.call(this, key, value);
            };
            window.fixtureCtx.scratchpad.editor.setValue('int main() { return 42; }');
        });
        await page.waitForFunction(() => window.store.getState().editor.code.includes('return 42'));
        assert.equal(await page.locator('.oi33-editor-draft-warning').isVisible(), true);
        assert.match(await page.textContent('.oi33-editor-draft-warning'), /草稿未保存/);
        await page.selectOption('.scratchpad__toolbar select', 'cc.cc17');
        await page.waitForFunction(() => window.store.getState().editor.lang === 'cc.cc17');
        assert.equal(await page.evaluate(() => window.fixtureCtx.scratchpad.editor.getValue()), 'int main() { return 42; }');
        await page.locator('.scratchpad__toolbar__submit').click();
        assert.deepEqual(await page.evaluate(() => window.posts[0]), { url: '/p/88/submit?tid=contest-A',
            body: { code: 'int main() { return 42; }', lang: 'cc.cc17' } });
        await page.locator('.scratchpad__toolbar__submit').evaluate(button => button.click());
        assert.equal(await page.evaluate(() => window.posts.length), 1, 'Native pending gate still prevents duplicate submit');
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '下载代码', exact: true }).click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'Fixture-backup.cpp');
        assert.equal(fs.readFileSync(await download.path(), 'utf8'), 'int main() { return 42; }');
        await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
        await page.getByRole('button', { name: '重试保存', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.oi33-editor-draft-warning').hidden);
        assert.deepEqual(await page.evaluate(() => ({ code: localStorage.getItem('42/system/88@contest-A'),
            lang: localStorage.getItem('42/system/88@contest-A#lang') })), { code: 'int main() { return 42; }', lang: 'cc.cc17' });
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
