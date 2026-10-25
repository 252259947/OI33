const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync, transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

if (process.env.OI33_LAYOUT_TEST === '1') test('real Monaco restores account appearance across problems and devices, isolates accounts and retries failed themes', async () => {
  const { chromium } = require('playwright');
  const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
  const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
  assert.ok(main.includes('U.bind(U,51604)'), 'Verify Hydro module after an upgrade');
  const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/problem-workbench.page.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'ProblemWorkbench',
    external: ['@hydrooj/ui-default'], loader: { '.css': 'empty' } }).outputFiles[0].text;
  const reducer = transformSync('const Notification = {success() {}, error() {}}; const i18n = text => text;\n'
    + fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/components/scratchpad/reducers/ui.ts'), 'utf8')
      .replace(/^import[^\n]+\n/gm, ''), { loader: 'ts', format: 'iife', globalName: 'NativeUiReducer' }).code;
  const origin = 'http://account-editor.fixture.invalid';
  const clone = value => JSON.parse(JSON.stringify(value));
  const cloud = new Map([[42, { fontSize: 23, tabSize: 4, theme: 'vs-dark' }]]);
  const saved = [], errors = [];
  let phase = 'setup';
  let failTheme = '';
  const markup = '<div id="scratchpad"><div class="scratchpad__toolbar">'
    + '<div class="scratchpad__toolbar__item"><select><option>C++14</option></select></div></div>'
    + '<div class="problem-content"><p>Fixture problem</p></div>'
    + '<div class="ScratchpadMonacoEditor" style="width:1000px;height:480px"></div></div>';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  async function setup(context, uid, legacy) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ phase, name: error.name, message: error.message, stack: error.stack }));
    await page.route(`${origin}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/oi33/editor-settings') {
        const currentUid = await page.evaluate(() => window.fixtureUid);
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          assert.equal(input.expectedUid, currentUid, 'A stale login cannot overwrite the active account');
          const { expectedUid, initialize, ...patch } = input;
          assert.ok(Object.keys(patch).every(key => ['fontSize', 'tabSize', 'theme'].includes(key)));
          saved.push({ uid: currentUid, patch: clone(patch), initialize });
          if (!initialize || !cloud.has(currentUid)) cloud.set(currentUid, { ...cloud.get(currentUid), ...patch });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ uid: currentUid, settings: cloud.get(currentUid) ?? null }) });
      }
      if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html',
        body: `<!doctype html><html data-page="problem_detail"><body>${markup}</body></html>` });
      if (pathname === failTheme) { failTheme = ''; return route.fulfill({ status: 503, body: 'temporary fixture failure' }); }
      const file = path.resolve(publicRoot, '.' + pathname);
      if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript'
        : file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
    });
    await page.exposeFunction('fixtureCloud', async (kind, currentUid, input) => {
      if (kind === 'post') {
        assert.equal(input.expectedUid, currentUid, 'A stale account must not write to a new login');
        const { expectedUid, initialize, ...patch } = input;
        assert.ok(Object.keys(patch).every(key => ['fontSize', 'tabSize', 'theme'].includes(key)));
        saved.push({ uid: currentUid, patch: clone(patch), initialize });
        if (!initialize || !cloud.has(currentUid)) cloud.set(currentUid, { ...cloud.get(currentUid), ...patch });
      }
      return { uid: currentUid, settings: clone(cloud.get(currentUid) ?? null) };
    });
    await page.goto(`${origin}/fixture`);
    await page.evaluate(({ uid, settings, legacy, origin }) => {
      if (legacy) {
        localStorage.setItem('editor.config', JSON.stringify(legacy));
        localStorage.setItem('oi33/editor-theme', 'vs');
      }
      window.UiContext = JSON.stringify({ cdn_prefix: origin + '/', pdoc: { pid: 'AccountFixture' },
        oi33EditorSettings: { uid, settings } });
      window.UserContext = JSON.stringify({ _id: uid, viewLang: 'en', codeFontFamily: 'monospace' });
      window.UiContextNew = '{}'; window.UserContextNew = '{}';
      window.fixtureUid = uid;
    }, { uid, settings: clone(cloud.get(uid) ?? null), legacy, origin });
    await page.addScriptTag({ content: main });
    await page.addScriptTag({ content: reducer });
    await page.evaluate(async () => {
      window.webpackChunk_hydrooj_ui_default.push([[987654], {}, require => { window.hydroRequire = require; }]);
      await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
      window.NativeHydro = window.hydroRequire(51604);
      window.nativeMonaco = await window.NativeHydro.loadMonaco([]);
      document.querySelector('.page-loader')?.remove();
      window.registeredPages = [];
      window.fixtureCtx = { scratchpad: {} };
      window.fixtureCode = 'int main() {\n    return 0;\n}';
      window.mountFixtureEditor = () => {
        window.settings = { fontSize: 14, tabSize: 4 };
        window.uiState = { activePage: 'problem', settings: { config: window.settings } };
        window.store = {
          getState: () => ({ ui: window.uiState, records: {} }),
          dispatch: action => {
            window.uiState = window.NativeUiReducer.default(window.uiState, action);
            if (action.type === 'SCRATCHPAD_SETTING_UPDATE') {
              window.settings = window.uiState.settings.config;
              window.fixtureEditor?.updateOptions(window.settings);
            }
          }, subscribe: () => () => {},
        };
        const { monaco, registerAction } = window.nativeMonaco;
        const model = monaco.editor.createModel(window.fixtureCode, 'plaintext');
        window.fixtureEditor = monaco.editor.create(document.querySelector('.ScratchpadMonacoEditor'), {
          model, fontSize: 14, minimap: { enabled: false }, smoothScrolling: false,
        });
        registerAction(window.fixtureEditor, model);
        window.fixtureEditor.setPosition({ lineNumber: 2, column: 5 });
        Object.assign(window.fixtureCtx.scratchpad, { editor: window.fixtureEditor, store: window.store, monaco });
      };
      window.mountFixtureEditor();
      window.require = () => ({ ...window.NativeHydro, ctx: window.fixtureCtx,
        request: {
          get: async url => {
            if (url !== '/oi33/editor-settings') throw Error('Unexpected fixture GET ' + url);
            return window.fixtureCloud('get', window.fixtureUid);
          },
          post: async (url, input) => {
            if (url !== '/oi33/editor-settings') throw Error('Unexpected fixture POST ' + url);
            return window.fixtureCloud('post', window.fixtureUid, input);
          },
        }, addPage: value => window.registeredPages.push(value),
      });
    });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => window.registeredPages[0].afterLoading());
    await page.waitForSelector('[data-oi33-editor-font-size]', { state: 'attached' });
    await page.waitForFunction(() => window.fixtureEditor.getRawOptions().mouseWheelZoom === false);
    return page;
  }
  const values = page => page.evaluate(() => ({
    fontSize: window.fixtureEditor.getOption(window.nativeMonaco.monaco.editor.EditorOption.fontSize),
    tabSize: window.fixtureEditor.getModel().getOptions().tabSize,
    theme: document.querySelector('[data-oi33-editor-theme]').value,
    code: window.fixtureEditor.getValue(), position: window.fixtureEditor.getPosition(),
  }));
  async function waitAppearance(page, settings) {
    try { await page.waitForFunction(expected => {
      const monaco = window.nativeMonaco.monaco;
      return window.fixtureEditor.getOption(monaco.editor.EditorOption.fontSize) === expected.fontSize
        && window.fixtureEditor.getModel().getOptions().tabSize === expected.tabSize
        && document.querySelector('[data-oi33-editor-theme]').value === expected.theme;
    }, settings, { timeout: 8000 }); } catch (error) {
      assert.fail(`Appearance mismatch: expected ${JSON.stringify(settings)}, actual ${JSON.stringify(await values(page))}; ${error.message}`);
    }
  }
  async function nextProblem(page, uid, settings) {
    // Our synthetic navigation runs several problem mounts in milliseconds.
    // Let Monaco's cursor highlight request finish before tearing down the editor;
    // disposing its unobserved Delayer promise mid-flight creates an upstream
    // Canceled rejection unrelated to account-settings restoration.
    await page.waitForFunction(() => !window.fixtureEditor
      .getContribution('editor.contrib.wordHighlighter')?.wordHighlighter?.runDelayer.isTriggered());
    await page.evaluate(({ markup, uid, settings }) => {
      // Match ScratchpadEditorContainer.componentWillUnmount's disposal order.
      const model = window.fixtureEditor.getModel();
      window.fixtureEditor.dispose(); model.dispose();
      document.querySelector('#scratchpad').outerHTML = markup;
      window.fixtureUid = uid;
      window.UiContext.oi33EditorSettings = { uid, settings };
      window.UiContext.pdoc = { pid: 'NextFixture' };
      window.mountFixtureEditor();
      window.registeredPages[0].afterLoading();
    }, { markup, uid, settings });
    await page.waitForSelector('[data-oi33-editor-font-size]', { state: 'attached' });
  }
  async function waitTheme(page, name) {
    const config = JSON.parse(fs.readFileSync(path.join(publicRoot, 'monaco/themes', `${name}.json`), 'utf8'));
    const hex = config.colors['editor.background'].slice(1);
    const rgb = `rgb(${[0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.monaco-editor-background'))
      .backgroundColor === expected, rgb, { timeout: 8000 });
  }
  try {
    const firstDevice = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await setup(firstDevice, 42, { fontSize: 12, tabSize: 2 });
    await waitAppearance(page, cloud.get(42));
    const original = await values(page);
    await page.selectOption('[data-oi33-editor-font-size]', '25', { force: true });
    await page.selectOption('[data-oi33-editor-tab-size]', '8', { force: true });
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved');
    assert.deepEqual(cloud.get(42), { fontSize: 25, tabSize: 8, theme: 'vs-dark' });
    await waitAppearance(page, cloud.get(42));
    await page.evaluate(() => document.querySelector('.ScratchpadMonacoEditor').dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true, bubbles: true })));
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved'
      && window.fixtureEditor.getRawOptions().fontSize === 26);
    assert.equal(cloud.get(42).fontSize, 26);
    assert.deepEqual((await values(page)).code, original.code);
    assert.deepEqual((await values(page)).position, original.position);

    const secondDevice = await browser.newContext();
    phase = 'second device';
    const secondPage = await setup(secondDevice, 42);
    await waitAppearance(secondPage, { fontSize: 26, tabSize: 8, theme: 'vs-dark' });

    cloud.set(42, { fontSize: 21, tabSize: 2, theme: 'dracula' });
    phase = 'next problem Dracula';
    await nextProblem(page, 42, clone(cloud.get(42))); await waitAppearance(page, cloud.get(42));
    await waitTheme(page, 'Dracula');
    // The same-account sync helper survives navigation, but its UI callback must
    // address this new toolbar and store rather than the now-detached first one.
    await page.selectOption('[data-oi33-editor-font-size]', '22', { force: true });
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved'
      && window.fixtureEditor.getRawOptions().fontSize === 22);
    assert.deepEqual(cloud.get(42), { fontSize: 22, tabSize: 2, theme: 'dracula' });
    const beforeRetry = await values(page);

    // A theme asset failure must be recoverable without changing or rewriting cloud settings.
    failTheme = '/monaco/themes/Nord.json';
    phase = 'theme asset failure and retry';
    cloud.set(42, { fontSize: 21, tabSize: 2, theme: 'nord' });
    await nextProblem(page, 42, clone(cloud.get(42)));
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'failed');
    await page.click('[data-oi33-editor-settings] > button');
    await page.click('[data-editor-sync-status]');
    await waitTheme(page, 'Nord');
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved');
    assert.deepEqual((await values(page)).code, beforeRetry.code);

    // This login uses the same browser origin but must not inherit account 42's appearance.
    phase = 'new account';
    await nextProblem(page, 43, null);
    await waitAppearance(page, { fontSize: 14, tabSize: 4, theme: 'vs' });
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved');
    assert.deepEqual(cloud.get(43), { fontSize: 14, tabSize: 4, theme: 'vs' });
    assert.deepEqual(cloud.get(42), { fontSize: 21, tabSize: 2, theme: 'nord' });

    // Local quota/storage failure must not disable the authenticated cloud save path.
    phase = 'storage quota';
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('fixture quota exceeded'); }; });
    await page.selectOption('[data-oi33-editor-font-size]', '28', { force: true });
    await page.waitForFunction(() => document.querySelector('[data-editor-sync-status]').dataset.state === 'saved'
      && window.fixtureEditor.getRawOptions().fontSize === 28);
    assert.equal(cloud.get(43).fontSize, 28);
    assert.equal(saved.some(item => Object.hasOwn(item.patch, 'code')), false);
    // Hydro 4.58.4's registerAction listener still writes editor.config without a
    // catch on every configuration change. The deliberate global setItem fault
    // consequently produces this upstream error even though account sync and the
    // actual editor setting recover; assert its exact origin, never hide errors
    // from the implementation or any earlier (normal) part of the scenario.
    const quotaErrors = errors.filter(error => error.phase === 'storage quota');
    assert.deepEqual(errors.filter(error => error.phase !== 'storage quota'), []);
    assert.equal(quotaErrors.length, 1);
    assert.match(quotaErrors[0].message, /^fixture quota exceeded/);
    assert.match(quotaErrors[0].stack, /at f \(http:\/\/account-editor\.fixture\.invalid\/751\.0c40a3\.chunk\.js:811:17000\)/);
    assert.match(quotaErrors[0].stack, /at u\.value \(http:\/\/account-editor\.fixture\.invalid\/751\.0c40a3\.chunk\.js:811:20304\)/);
  } finally { await browser.close(); }
});
