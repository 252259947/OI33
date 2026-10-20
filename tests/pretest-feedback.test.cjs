const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync, transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'frontend/pretest-feedback.ts');
const compiled = transformSync(fs.readFileSync(helperPath, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { compareSampleText, pretestResult } = mod.exports;
const sample = { id: '1', input: '1 2\n', output: '3\n' };
const record = (status, message, compilerTexts = []) => ({
    status, testCases: [{ message }], compilerTexts, time: 1, memory: 128,
});

test('sample comparison distinguishes exact, line-ending and whitespace differences without judging AC/WA', () => {
    assert.equal(compareSampleText('1\n2\n', '1\r\n2\r\n').kind, 'same');
    assert.equal(compareSampleText('1 2\n', ' 1\t2 \n\n').kind, 'whitespace');
    assert.equal(compareSampleText('', '\n').kind, 'whitespace');
    const diff = compareSampleText('1\n2\n', '1\n3\n');
    assert.equal(diff.kind, 'different');
    assert.match(diff.message, /第 2 行、第 1 列/);
    assert.match(diff.message, /多解或特殊判题不能据此判断错误/);
    assert.match(compareSampleText('', '').message, /不代表整题通过/);
    assert.equal(compareSampleText('a'.repeat(200001), 'a').kind, 'large');
});

test('successful pretests are runtime success only, including custom and empty-output cases', () => {
    const source = record(1, '3\n');
    const before = JSON.stringify(source);
    const result = pretestResult(source, sample);
    assert.equal(result.kind, 'same');
    assert.match(result.status, /运行成功，不代表整题通过/);
    assert.equal(JSON.stringify(source), before);
    assert.equal(pretestResult(record(1, ''), { id: '1', input: '', output: '' }).kind, 'same');
    assert.equal(pretestResult(record(1, 'wrong'), sample).kind, 'different');
    assert.equal(pretestResult(record(1, '3\n')).kind, 'custom');
    assert.match(pretestResult(record(1, '3\n')).comparison, /自定义输入没有标准输出/);
    assert.equal(pretestResult(record(1, '3\n'), { ...sample, output: null }).kind, 'custom');
    assert.equal(pretestResult({ status: 1, testCases: [] }, sample).kind, 'custom');
});

test('waiting and failed runs never perform sample comparison and ANSI output is plain text', () => {
    for (const status of [0, 20, 21, 22]) {
        assert.equal(pretestResult(record(status, '3\n'), sample).kind, 'pending');
    }
    assert.equal(pretestResult(null, sample).kind, 'pending');
    for (const status of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 30, 31, 32, 33, 999]) {
        const result = pretestResult(record(status, '3\n'), sample);
        assert.equal(result.kind, 'error');
        assert.match(result.comparison, /不进行样例输出对照/);
    }
    const compile = pretestResult(record(7, '', ['\u001b[31merror: broken code\u001b[0m']), sample);
    assert.equal(compile.actual, 'error: broken code');
    assert.equal(pretestResult(record(1, '<script>alert(1)</script>')).actual, '<script>alert(1)</script>');
});

test('page integration keeps existing pretest endpoint, request shape, hotkeys and submit path', () => {
    const source = fs.readFileSync(path.join(root, 'frontend/problem-workbench.page.ts'), 'utf8');
    assert.match(source, /request\.post\(\(window as any\)\.UiContext\.postSubmitUrl/);
    assert.match(source, /input: \[latest\.pretest\.input\]/);
    assert.match(source, /pretest: true/);
    assert.match(source, /feedback\.start\(latest\.pretest\.input\)/);
    assert.match(source, /feedback\.bindRecord\(snapshot, String\(result\.rid\)\)/);
    assert.match(source, /scratchpad__toolbar__submit/);
    assert.match(source, /installEditorWheelZoom/);
    assert.doesNotMatch(fs.readFileSync(helperPath, 'utf8'), /innerHTML|request\.|fetch\(|\.score\s*=/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('Chrome and actual Monaco: sample selector, bound results, failures and unchanged editor/submit flow', async () => {
    const { chromium } = require('playwright');
    const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
    const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
    const bundle = buildSync({
        entryPoints: [path.join(root, 'frontend/problem-workbench.page.ts')],
        bundle: true, write: false, format: 'iife', external: ['@hydrooj/ui-default'], loader: { '.css': 'empty' },
    }).outputFiles[0].text;
    const helperBundle = buildSync({
        entryPoints: [helperPath], bundle: true, write: false, format: 'iife', globalName: 'PretestHelper',
    }).outputFiles[0].text;
    const pretestReducer = transformSync(fs.readFileSync(path.join(root,
        'node_modules/@hydrooj/ui-default/components/scratchpad/reducers/pretest.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    const hotkeySource = transformSync(fs.readFileSync(path.join(root,
        'node_modules/@hydrooj/ui-default/components/hotkey/hotkey.page.js'), 'utf8'), { format: 'cjs' }).code;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('http://pretest.fixture.invalid/**', async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                + '<html data-page="problem_detail"><head><meta charset="utf-8"></head><body class="mode--scratchpad"><div id="scratchpad">'
                + '<div class="scratchpad__toolbar flex-row flex-cross-center"><button class="scratchpad__toolbar__item scratchpad__toolbar__button scratchpad__toolbar__pretest enabled" data-global-hotkey="f9"><div><span class="icon icon-debug"></span> 运行自测 (F9)</div></button>'
                + '<button class="scratchpad__toolbar__item scratchpad__toolbar__button scratchpad__toolbar__submit enabled" data-global-hotkey="f10"><div><span class="icon icon-play"></span> 递交评测 (F10)</div></button>'
                + '<button class="scratchpad__toolbar__item scratchpad__toolbar__button enabled" data-global-hotkey="alt+q" name="problem-sidebar__quit-scratchpad"><div><span class="icon icon-close"></span> 退出 (Alt+Q)</div></button>'
                + '<button class="scratchpad__toolbar__item scratchpad__toolbar__button enabled" data-global-hotkey="alt+p" data-tooltip="Toggle Pretest Panel (Alt+P)"><div><span class="icon icon-edit"></span> <span>自测</span></div></button>'
                + '<div class="scratchpad__toolbar__item"><select class="select"><option>C++14</option></select></div></div>'
                + '<div class="problem-content"><div class="richmedia">'
                + '<pre><code class="language-input2">4 5\n</code></pre><pre><code class="language-output2">9\n</code></pre>'
                + '<pre><code class="language-input1">1 2\n</code></pre><pre><code class="language-output1">3\n</code></pre>'
                + '<pre><code class="language-input3"></code></pre><pre><code class="language-output3">hello\n</code></pre>'
                + '</div></div><div class="ScratchpadMonacoEditor" style="width:100%;height:280px"></div>'
                + '<div id="native-pretest-allotment" style="position:relative;height:0;visibility:hidden;overflow:hidden"><div class="splitpane-fill" id="pretest-pane"><div class="scratchpad__panel-title">自测</div>'
                + '<div class="flex-col flex-fill"><textarea class="scratchpad__data-input"></textarea><pre class="native-result">Accepted</pre></div>'
                + '</div></div></div></body></html>' });
            const file = path.resolve(publicRoot, '.' + pathname);
            if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return route.fulfill({ status: 404, body: '' });
            }
            return route.fulfill({ body: fs.readFileSync(file),
                contentType: file.endsWith('.js') ? 'application/javascript'
                    : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
        });
        await page.goto('http://pretest.fixture.invalid/fixture');
        await page.evaluate(() => {
            window.UiContext = JSON.stringify({ cdn_prefix: 'http://pretest.fixture.invalid/', postSubmitUrl: '/p/fixture/submit',
                getRecordDetailUrl: '/record/{rid}',
                pdoc: { pid: 'Fixture', config: { type: 'default' } } });
            window.UserContext = JSON.stringify({ viewLang: 'en', codeFontFamily: 'monospace' });
            window.UiContextNew = '{}';
            window.UserContextNew = '{}';
        });
        await page.addScriptTag({ content: main });
        await page.evaluate(async ({ reducer, hotkeys }) => {
            window.webpackChunk_hydrooj_ui_default.push([[987655], {}, (require) => { window.hydroRequire = require; }]);
            await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
            window.NativeHydro = window.hydroRequire(51604);
            window.nativeMonaco = await window.NativeHydro.loadMonaco([]);
            document.querySelector('.page-loader')?.remove();
            const mod = { exports: {} };
            new Function('module', 'exports', 'require', reducer)(mod, mod.exports,
                () => ({ STATUS_TEXTS: { 1: 'Accepted', 7: 'Compile Error' } }));
            window.pretestReducer = mod.exports.default;
            window.registeredPages = [];
            window.actions = [];
            window.posts = [];
            window.requests = [];
            window.listeners = new Set();
            window.state = {
                ui: { activePage: 'problem', isPosting: false, pretestWaitSec: 0, pretest: { visible: false },
                    records: { visible: false }, settings: { config: { fontSize: 14, tabSize: 4 } } },
                editor: { lang: 'cc.cc14o2', code: 'int main() { return 0; }' },
                pretest: { input: '', output: '', rid: null }, records: { items: {}, rows: [] },
            };
            window.store = {
                getState: () => window.state,
                subscribe: (listener) => { window.listeners.add(listener); return () => window.listeners.delete(listener); },
                dispatch: (action) => {
                    window.actions.push({ type: action.type, payload: action.payload?.then ? '[promise]' : action.payload });
                    if (action.payload?.then) {
                        window.store.dispatch({ type: `${action.type}_PENDING` });
                        return action.payload.then((data) => window.store.dispatch({ type: `${action.type}_FULFILLED`, payload: data }),
                            (error) => window.store.dispatch({ type: `${action.type}_REJECTED`, payload: error }));
                    }
                    const state = window.state;
                    state.pretest = window.pretestReducer(state.pretest, action);
                    if (action.type === 'SCRATCHPAD_POST_PRETEST_PENDING') state.ui.isPosting = true;
                    if (/SCRATCHPAD_POST_PRETEST_(FULFILLED|REJECTED)/.test(action.type)) state.ui.isPosting = false;
                    if (action.type === 'SCRATCHPAD_POST_PRETEST_FULFILLED') state.ui.pretestWaitSec = 5;
                    if (action.type === 'SCRATCHPAD_POST_PRETEST_REJECTED') state.ui.pretestWaitSec = 3;
                    if (action.type === 'SCRATCHPAD_RECORDS_PUSH') state.records.items = { ...state.records.items, [action.payload.rdoc._id]: action.payload.rdoc };
                    if (action.type === 'SCRATCHPAD_UI_SET_VISIBILITY') state.ui[action.payload.uiElement].visible = action.payload.visibility;
                    if (action.type === 'SCRATCHPAD_UI_TOGGLE_VISIBILITY') {
                        state.ui[action.payload.uiElement].visible = !state.ui[action.payload.uiElement].visible;
                    }
                    // Allotment owns visibility and pane height in Hydro. The
                    // enhancement must never override a hidden native pane.
                    const pane = document.querySelector('#native-pretest-allotment');
                    pane.style.height = state.ui.pretest.visible ? '200px' : '0px';
                    pane.style.visibility = state.ui.pretest.visible ? 'visible' : 'hidden';
                    pane.style.overflow = 'hidden';
                    document.querySelector('.scratchpad__toolbar__pretest').classList.toggle('disabled',
                        !!(state.ui.isPosting || state.ui.pretestWaitSec || state.pretest.isRunning));
                    if (action.type === 'SCRATCHPAD_SETTING_UPDATE') {
                        state.ui.settings.config = { ...state.ui.settings.config, [action.payload.setting]: action.payload.value };
                        window.fixtureEditor.updateOptions(state.ui.settings.config);
                    }
                    for (const listener of window.listeners) listener();
                },
            };
            const { monaco, registerAction } = window.nativeMonaco;
            const model = monaco.editor.createModel(window.state.editor.code, 'plaintext');
            window.fixtureEditor = monaco.editor.create(document.querySelector('.ScratchpadMonacoEditor'),
                { model, fontSize: 14, minimap: { enabled: false } });
            registerAction(window.fixtureEditor, model);
            window.fixtureEditor.setPosition({ lineNumber: 1, column: 7 });
            window.fixtureCtx = { scratchpad: { store: window.store, editor: window.fixtureEditor, monaco } };
            window.require = () => ({
                ...window.NativeHydro, ctx: window.fixtureCtx, addPage: (value) => window.registeredPages.push(value),
                request: { post: (url, body) => {
                    window.posts.push({ url, body });
                    return new Promise((resolve, reject) => window.requests.push({ resolve, reject }));
                } },
            });
            // Run the installed Hydro hotkey code, including its jQuery-triggered click path.
            const hotkeyMod = { exports: {} };
            new Function('module', 'exports', 'require', hotkeys)(hotkeyMod, hotkeyMod.exports, (name) => {
                if (name === 'jquery') return window.NativeHydro.$;
                if (name === 'lodash') return { isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b) };
                return { AutoloadPage: window.NativeHydro.AutoloadPage };
            });
            hotkeyMod.exports.default.afterLoading();
            window.nativePretests = 0;
            window.nativeSubmits = 0;
            window.nativePanelToggles = 0;
            document.querySelector('.scratchpad__toolbar__pretest').addEventListener('click', (event) => {
                if (!event.currentTarget.classList.contains('disabled')) window.nativePretests++;
            });
            document.querySelector('.scratchpad__toolbar__submit').addEventListener('click', () => window.nativeSubmits++);
            // Match the original toolbar's onClick; the product enhancement must leave this handler intact.
            document.querySelector('[data-global-hotkey="alt+p"]').addEventListener('click', () => {
                window.nativePanelToggles++;
                window.store.dispatch({ type: 'SCRATCHPAD_UI_TOGGLE_VISIBILITY', payload: { uiElement: 'pretest' } });
            });
            window.complete = (rid, status, message, compilerTexts = []) => window.store.dispatch({
                type: 'SCRATCHPAD_RECORDS_PUSH', payload: { rdoc: { _id: rid, status, time: 1, memory: 128, testCases: [{ message }], compilerTexts } },
            });
            window.clearCooldown = () => {
                window.state.ui.pretestWaitSec = 0;
                window.store.dispatch({ type: 'FIXTURE_TICK_FINISHED' });
            };
        }, { reducer: pretestReducer, hotkeys: hotkeySource });
        await page.addStyleTag({ content: [
            'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css',
            'frontend/oi33-design-system.css', 'frontend/problem-workbench.css',
        ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') });
        await page.addStyleTag({ content: 'html,body{margin:0}#scratchpad{position:relative!important;inset:auto!important;width:50vw!important;height:auto!important;margin:30px auto}'
            + '.problem-content{display:none!important}.scratchpad__toolbar{position:static!important;display:flex!important}'
            + '.ScratchpadMonacoEditor{width:100%!important}#pretest-pane{display:flex;flex-direction:column;position:absolute;height:100%;width:100%;top:0;left:0}' });
        await page.addScriptTag({ content: bundle });
        await page.addScriptTag({ content: helperBundle });
        await page.evaluate(() => window.registeredPages[0].afterLoading());
        await page.waitForSelector('.oi33-pretest-feedback', { state: 'attached' });
        const initial = await page.evaluate(() => ({ code: window.fixtureEditor.getValue(), position: window.fixtureEditor.getPosition() }));
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        assert.equal(await page.locator('#native-pretest-allotment').evaluate((node) => node.getBoundingClientRect().height), 0);
        const toggle = page.getByRole('button', { name: '测试数据 (Alt+P)', exact: true });
        assert.equal(await toggle.isVisible(), true);
        assert.match(await toggle.textContent(), /测试数据/);
        assert.doesNotMatch(await toggle.locator('div > span:not(.icon)').textContent(), /^自测$/);
        assert.match(await toggle.getAttribute('title'), /打开或收起样例和自定义输入/);
        assert.match(await toggle.getAttribute('title'), /Alt\+P/);
        assert.equal(await toggle.getAttribute('data-tooltip'), null, 'Native title replaces the overflowing Hydro tooltip');
        await toggle.click();
        assert.equal(await page.locator('[aria-label="选择自测样例"]').isVisible(), true);
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        const visibleGeometry = await page.evaluate(() => {
            const pane = document.querySelector('#pretest-pane').getBoundingClientRect();
            const input = document.querySelector('[aria-label="自测输入"]').getBoundingClientRect();
            return { height: pane.height, inside: input.top >= pane.top && input.bottom <= pane.bottom && input.bottom <= innerHeight };
        });
        assert.equal(visibleGeometry.height, 200);
        assert.equal(visibleGeometry.inside, true);
        assert.equal(await page.evaluate(() => window.posts.length), 0, 'Opening data does not submit or run');
        assert.equal(await page.locator('.oi33-pretest-feedback__status').isVisible(), false, 'Idle has no explanatory status banner');
        assert.equal(await page.locator('.oi33-pretest-feedback__comparison').isVisible(), false);
        assert.equal(await page.locator('.oi33-pretest-feedback__resources').isVisible(), false);
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), false);
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).isDisabled(), true, 'No chosen sample yet');
        assert.match(await page.locator('.oi33-pretest-feedback').innerText(), /运行后查看结果/);
        assert.doesNotMatch(await page.locator('.oi33-pretest-feedback').innerText(), /选择样例或输入数据后|仅核对公开样例/);
        const resultHeading = page.locator('.oi33-pretest-feedback__heading');
        await resultHeading.hover();
        assert.match(await resultHeading.getAttribute('title'), /运行成功不代表整题通过/);
        assert.match(await page.locator('[aria-label="选择自测样例"]').getAttribute('title'), /公开样例/);
        assert.equal(await page.locator('.oi33-pretest-feedback').getAttribute('title'), null, 'Help is on relevant controls, not a page-wide hover banner');
        const runButton = page.locator('.oi33-pretest-feedback__run');
        const closeButton = page.locator('.oi33-pretest-feedback__close');
        const assertPaneGeometry = async (label) => {
            const boxes = await page.evaluate(() => {
                const box = (node) => { const r = node.getBoundingClientRect(); return {
                    x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
                    scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
                }; };
                return {
                    pane: box(document.querySelector('#native-pretest-allotment')),
                    panel: box(document.querySelector('.oi33-pretest-feedback')),
                    editor: box(document.querySelector('.ScratchpadMonacoEditor')),
                    toolbar: box(document.querySelector('.scratchpad__toolbar')),
                    actions: [...document.querySelectorAll('.scratchpad__toolbar > button, .scratchpad__toolbar select')]
                        .map(box).filter(item => item.width > 0 && item.height > 0).sort((a, b) => a.x - b.x),
                    columns: [...document.querySelectorAll('.oi33-pretest-feedback__column')].map(box),
                    bodies: ['.oi33-pretest-feedback__input-body', '.oi33-pretest-feedback__result-body'].map(sel => box(document.querySelector(sel))),
                    run: box(document.querySelector('.oi33-pretest-feedback__run')),
                    close: box(document.querySelector('.oi33-pretest-feedback__close')),
                };
            });
            assert.equal(boxes.pane.height, 200, label);
            assert.ok(boxes.toolbar.bottom <= boxes.editor.y + 1, `${label}: toolbar does not overlap editor`);
            assert.ok(Math.abs(boxes.editor.bottom - boxes.pane.y) < 1, `${label}: editor and pretest meet without overlap/gap`);
            assert.ok(Math.abs(boxes.editor.x - boxes.pane.x) < 1 && Math.abs(boxes.editor.right - boxes.pane.right) < 1,
                `${label}: editor and pretest horizontal boundaries align`);
            boxes.actions.forEach((action, index) => {
                assert.ok(action.y >= boxes.toolbar.y - 1 && action.bottom <= boxes.toolbar.bottom + 1
                    && action.x >= boxes.toolbar.x - 1 && action.right <= boxes.toolbar.right + 1,
                `${label}: toolbar action stays within toolbar ${JSON.stringify({ action, toolbar: boxes.toolbar })}`);
                if (index) assert.ok(boxes.actions[index - 1].right <= action.x + 1, `${label}: toolbar actions do not overlap`);
            });
            assert.equal(boxes.columns.length, 2, label);
            assert.ok(Math.abs(boxes.columns[0].y - boxes.columns[1].y) < 1, `${label}: header alignment`);
            assert.ok(Math.abs(boxes.columns[0].bottom - boxes.columns[1].bottom) < 1, `${label}: bottom alignment`);
            assert.ok(Math.abs(boxes.bodies[0].y - boxes.bodies[1].y) < 1, `${label}: body top alignment`);
            assert.ok(Math.abs(boxes.bodies[0].bottom - boxes.bodies[1].bottom) < 1, `${label}: body bottom alignment`);
            assert.ok(boxes.columns[0].right <= boxes.columns[1].x + 1, `${label}: no overlap`);
            assert.ok(boxes.columns.every(box => box.width > 250), `${label}: useful column width`);
            for (const item of [boxes.panel, ...boxes.columns, ...boxes.bodies, boxes.run, boxes.close]) {
                assert.ok(item.y >= boxes.pane.y - 1 && item.bottom <= boxes.pane.bottom + 1
                    && item.x >= boxes.pane.x - 1 && item.right <= boxes.pane.right + 1, `${label}: clipped control ${JSON.stringify(item)}`);
                assert.ok(item.scrollWidth <= item.clientWidth + 2, `${label}: horizontal overflow`);
            }
            assert.ok(boxes.run.x > boxes.columns[0].x + boxes.columns[0].width / 2, `${label}: run is at the right edge of input`);
            assert.ok(boxes.run.bottom > boxes.columns[0].bottom - 15, `${label}: run is at input bottom`);
        };
        await assertPaneGeometry('initial idle');
        const screenshotLayouts = async (suffix = '') => {
            for (const [width, height] of [[1440, 900], [1920, 1080]]) for (const dark of [false, true]) {
                await page.setViewportSize({ width, height });
                await page.evaluate((darkMode) => {
                    document.documentElement.classList.toggle('theme--dark', darkMode);
                    // Fixture-only theme switch; real pages resolve this during mount.
                    // Never alter the editor model or font settings for screenshots.
                    window.nativeMonaco.monaco.editor.setTheme(darkMode ? 'vs-dark' : 'vs');
                    window.fixtureEditor.layout();
                }, dark);
                await assertPaneGeometry(`${width}x${height} ${dark ? 'dark' : 'light'} ${suffix}`);
                if (process.env.OI33_PRETEST_SCREENSHOT_DIR && width === 1440) {
                    fs.mkdirSync(process.env.OI33_PRETEST_SCREENSHOT_DIR, { recursive: true });
                    await page.locator('#pretest-pane').screenshot({
                        path: path.join(process.env.OI33_PRETEST_SCREENSHOT_DIR, `pretest-redesign-${dark ? 'dark' : 'light'}${suffix}.png`),
                    });
                    await page.locator('#scratchpad').screenshot({
                        path: path.join(process.env.OI33_PRETEST_SCREENSHOT_DIR, `pretest-redesign-workbench-${dark ? 'dark' : 'light'}${suffix}.png`),
                    });
                }
            }
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.evaluate(() => {
                document.documentElement.classList.remove('theme--dark');
                window.nativeMonaco.monaco.editor.setTheme('vs');
            });
        };
        await screenshotLayouts('-idle');
        await page.evaluate(() => window.registeredPages[0].afterLoading());
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.state.ui.pretest.visible), true, 'Repeat mount preserves the open panel');
        await page.keyboard.press('Alt+p');
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        await page.keyboard.press('Alt+p');
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        assert.equal(await page.evaluate(() => window.nativePanelToggles), 3, 'Original button and hotkey each toggle exactly once');
        assert.equal(await page.evaluate(() => window.posts.length), 0);
        assert.deepEqual(await page.locator('[aria-label="选择自测样例"] option').allTextContents(), ['自定义输入', '样例 1', '样例 2', '样例 3']);
        assert.equal(await page.locator('.native-result').isVisible(), false);
        await runButton.click();
        assert.equal(await page.inputValue('[aria-label="自测输入"]'), '1 2\n');
        assert.equal(await page.evaluate(() => window.posts.length), 1);
        assert.deepEqual(await page.evaluate(() => window.posts[0].body), {
            lang: 'cc.cc14o2', code: initial.code, input: ['1 2\n'], pretest: true,
        });
        assert.equal(await page.evaluate(() => window.nativePretests), 0);
        assert.equal(await runButton.isDisabled(), true, 'Pending HTTP disables the local run button');
        await runButton.evaluate(button => button.click());
        await page.keyboard.press('F9');
        assert.equal(await page.evaluate(() => window.posts.length), 1, 'Pending repeated button/hotkey does not submit twice');
        await page.evaluate(() => window.requests[0].resolve({ rid: 'run1' }));
        await page.evaluate(() => window.complete('run1', 1, '3\n'));
        assert.equal(await runButton.isDisabled(), true, 'Native cooldown also disables the local button');
        await runButton.evaluate(button => button.click());
        assert.equal(await page.evaluate(() => window.posts.length), 1);
        await page.evaluate(() => window.clearCooldown());
        assert.equal(await runButton.isDisabled(), false);
        assert.equal(await page.getAttribute('.oi33-pretest-feedback__record', 'href'), '/record/run1');
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /运行成功，不代表整题通过/);
        assert.equal(await page.textContent('.oi33-pretest-feedback__resources'), '1 ms · 128 KiB');
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /文本一致/);
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).isDisabled(), false);
        await page.getByRole('tab', { name: '预期输出', exact: true }).click();
        assert.equal(await page.locator('.oi33-pretest-feedback__expected').isVisible(), true);
        assert.equal(await page.locator('.oi33-pretest-feedback__actual').isVisible(), false);
        assert.equal(await page.textContent('.oi33-pretest-feedback__expected'), '3\n');
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).getAttribute('aria-selected'), 'true');
        const expectedId = await page.getByRole('tab', { name: '预期输出', exact: true }).getAttribute('aria-controls');
        assert.equal(await page.locator('.oi33-pretest-feedback__expected').getAttribute('id'), expectedId);
        await page.keyboard.press('Home');
        assert.equal(await page.getByRole('tab', { name: '实际输出', exact: true }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await page.getByRole('tab', { name: '实际输出', exact: true }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('End');
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).getAttribute('tabindex'), '0');
        assert.equal(await page.getByRole('tab', { name: '实际输出', exact: true }).getAttribute('tabindex'), '-1');
        await page.getByRole('tab', { name: '实际输出', exact: true }).click();
        assert.equal(await page.locator('.oi33-pretest-feedback__actual').isVisible(), true);
        await screenshotLayouts();

        await page.selectOption('[aria-label="选择自测样例"]', '2');
        assert.equal(await page.inputValue('[aria-label="自测输入"]'), '4 5\n');
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), true);
        await page.getByRole('tab', { name: '预期输出', exact: true }).click();
        assert.equal(await page.textContent('.oi33-pretest-feedback__expected'), '3\n', 'Stale result remains bound to executed sample 1');
        await page.keyboard.press('F9');
        // A result may reach the websocket before the HTTP response assigns rid.
        await page.evaluate(() => window.complete('run2', 1, '9 \n'));
        await page.evaluate(() => window.requests[1].resolve({ rid: 'run2' }));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /仅空白字符不同/);
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), false);
        await page.evaluate(() => window.clearCooldown());
        assert.equal(await page.locator('.oi33-pretest-feedback__actual').isVisible(), true, 'Starting a new run returns to actual output tab');
        await page.evaluate(() => window.complete('run1', 1, 'old late result'));
        assert.doesNotMatch(await page.textContent('.oi33-pretest-feedback'), /old late result/);

        await page.selectOption('[aria-label="选择自测样例"]', '3');
        await page.keyboard.press('F9');
        assert.deepEqual(await page.evaluate(() => window.posts[2].body.input), ['']);
        await page.evaluate(() => window.requests[2].resolve({ rid: 'run3' }));
        await page.evaluate(() => window.complete('run3', 1, 'alternative valid output\n'));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /多解或特殊判题不能据此判断错误/);
        await page.evaluate(() => window.clearCooldown());

        await page.selectOption('[aria-label="选择自测样例"]', '');
        await page.locator('[aria-label="自测输入"]').fill('');
        await page.keyboard.press('F9');
        assert.deepEqual(await page.evaluate(() => window.posts[3].body.input), ['']);
        await page.evaluate(() => window.requests[3].resolve({ rid: 'run4' }));
        await page.evaluate(() => window.complete('run4', 1, '<img src=x onerror="alert(1)">'));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /自定义输入没有标准输出/);
        assert.equal(await page.locator('.oi33-pretest-feedback img').count(), 0);
        assert.equal(await page.getByRole('tab', { name: '预期输出', exact: true }).isDisabled(), true, 'Custom run has no fabricated expected output');
        await page.evaluate(() => window.clearCooldown());
        await page.locator('[aria-label="自测输入"]').fill('new input');
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), true);
        await page.keyboard.press('F9');
        await page.evaluate(() => window.requests[4].resolve({ rid: 'run5' }));
        await page.evaluate(() => window.complete('run5', 7, '', ['error: expected semicolon']));
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /编译失败/);
        assert.match(await page.textContent('.oi33-pretest-feedback'), /error: expected semicolon/);
        await page.evaluate(() => window.clearCooldown());
        await page.keyboard.press('F9');
        await page.evaluate(() => window.requests[5].reject(new Error('rate limited')));
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /未提交成功/);
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /rate limited/);
        await page.evaluate(() => window.clearCooldown());
        await page.evaluate(() => {
            window.state.pretest.isRunning = true;
            window.store.dispatch({ type: 'FIXTURE_RUNNING' });
        });
        assert.equal(await runButton.isDisabled(), true, 'Run in progress is disabled even after cooldown');
        await runButton.evaluate(button => button.click());
        await page.keyboard.press('F9');
        assert.equal(await page.evaluate(() => window.posts.length), 6);
        await page.evaluate(() => {
            window.state.pretest.isRunning = false;
            window.store.dispatch({ type: 'FIXTURE_STOPPED' });
        });
        assert.equal(await runButton.isDisabled(), false);

        // No samples, unmatched/missing output and duplicate markup are all safe.
        const extracted = await page.evaluate(() => {
            const empty = document.createElement('div');
            const duplicate = document.createElement('div');
            duplicate.innerHTML = '<pre><code class="language-input1"></code></pre><pre><code class="language-input1">duplicate</code></pre>';
            return { none: window.PretestHelper.readPublicSamples(empty), partial: window.PretestHelper.readPublicSamples(duplicate) };
        });
        assert.deepEqual(extracted, { none: [], partial: [{ id: '1', input: '', output: null }] });
        // Re-mount must not add a second request handler or panel.
        await page.evaluate(() => window.registeredPages[0].afterLoading());
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.oi33-pretest-feedback').count(), 1);
        await page.keyboard.press('F9');
        assert.equal(await page.evaluate(() => window.posts.length), 7);
        await page.evaluate(() => window.requests[6].resolve({ rid: 'run6' }));
        await page.evaluate(() => window.complete('run6', 1, 'ok'));
        await page.evaluate(() => window.clearCooldown());
        await closeButton.click();
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        assert.equal(await page.evaluate(() => window.state.ui.pretest.visible), false);
        await toggle.click();
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        assert.equal(await page.evaluate(() => window.posts.length), 7, 'Close and reopen do not issue a run');
        await page.keyboard.press('F10');
        assert.equal(await page.evaluate(() => window.nativeSubmits), 1);
        assert.equal(await page.evaluate(() => window.state.ui.pretest.visible), false);
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        await page.keyboard.press('Alt+p');
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        assert.equal(await page.evaluate(() => window.posts.length), 7, 'Reopening after submit does not run again');
        assert.deepEqual(await page.evaluate(() => ({ code: window.fixtureEditor.getValue(), position: window.fixtureEditor.getPosition() })), initial);
        assert.deepEqual(errors, []);
        // Use the actual shared dark-theme tokens, not fixture-only colors.
        await page.evaluate(() => document.documentElement.classList.add('theme--dark'));
        const colors = await page.locator('[aria-label="自测输入"]').evaluate((node) => {
            const css = getComputedStyle(node);
            return { foreground: css.color, background: css.backgroundColor };
        });
        assert.equal(colors.foreground, 'rgb(238, 241, 248)');
        assert.notEqual(colors.foreground, colors.background);
        await assertPaneGeometry('custom run after reopen');

        // Long input/output scroll within their own controls; the 200 px pane
        // and the run/close controls remain intact, including expanded stale input.
        await page.evaluate(() => window.complete('run6', 1, `${'x'.repeat(500)}\n`.repeat(100)));
        await page.locator('[aria-label="自测输入"]').fill('changed\n'.repeat(80));
        await page.locator('.oi33-pretest-feedback__stale summary').click();
        await assertPaneGeometry('long output with expanded stale input');
        const scrolling = await page.evaluate(() => {
            const input = document.querySelector('[aria-label="自测输入"]');
            const actual = document.querySelector('.oi33-pretest-feedback__actual');
            return {
                inputScrolls: input.scrollHeight > input.clientHeight,
                outputScrolls: actual.scrollWidth > actual.clientWidth && actual.scrollHeight > actual.clientHeight,
                outputOverflow: getComputedStyle(actual).overflow,
            };
        });
        assert.deepEqual(scrolling, { inputScrolls: true, outputScrolls: true, outputOverflow: 'auto' });

        // Hydro removes its native pretest action for unsupported languages/types.
        // Our button must follow that real capability change instead of inventing an API path.
        await page.evaluate(() => {
            window.detachedPretest = document.querySelector('.scratchpad__toolbar__pretest');
            window.detachedPretest.remove();
        });
        await page.waitForFunction(() => document.querySelector('.oi33-pretest-feedback__run').disabled);
        assert.match(await runButton.getAttribute('title'), /当前题型或语言不支持自测/);
        await runButton.evaluate(button => button.click());
        assert.equal(await page.evaluate(() => window.posts.length), 7);
        await page.evaluate(() => document.querySelector('.scratchpad__toolbar').prepend(window.detachedPretest));
        await page.waitForFunction(() => !document.querySelector('.oi33-pretest-feedback__run').disabled);
        assert.match(await runButton.getAttribute('title'), /运行当前输入/);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
