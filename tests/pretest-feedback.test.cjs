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
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('http://pretest.fixture.invalid/**', async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                + '<html data-page="problem_detail"><head><meta charset="utf-8"></head><body class="mode--scratchpad"><div id="scratchpad">'
                + '<div class="scratchpad__toolbar"><button class="scratchpad__toolbar__pretest" data-global-hotkey="f9">运行自测 (F9)</button>'
                + '<button class="scratchpad__toolbar__submit" data-global-hotkey="f10">递交评测 (F10)</button>'
                + '<button class="scratchpad__toolbar__button" data-global-hotkey="alt+p"><span class="icon icon-edit"></span> 自测</button>'
                + '<div class="scratchpad__toolbar__item"><select><option>C++14</option></select></div></div>'
                + '<div class="problem-content"><div class="richmedia">'
                + '<pre><code class="language-input2">4 5\n</code></pre><pre><code class="language-output2">9\n</code></pre>'
                + '<pre><code class="language-input1">1 2\n</code></pre><pre><code class="language-output1">3\n</code></pre>'
                + '<pre><code class="language-input3"></code></pre><pre><code class="language-output3">hello\n</code></pre>'
                + '</div></div><div class="ScratchpadMonacoEditor" style="width:1050px;height:280px"></div>'
                + '<div class="splitpane-fill" id="pretest-pane" style="height:300px"><div class="scratchpad__panel-title">自测</div>'
                + '<div class="flex-col flex-fill"><textarea class="scratchpad__data-input"></textarea><pre class="native-result">Accepted</pre></div>'
                + '</div></div></body></html>' });
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
                    if (action.type === 'SCRATCHPAD_RECORDS_PUSH') state.records.items = { ...state.records.items, [action.payload.rdoc._id]: action.payload.rdoc };
                    if (action.type === 'SCRATCHPAD_UI_SET_VISIBILITY') state.ui[action.payload.uiElement].visible = action.payload.visibility;
                    if (action.type === 'SCRATCHPAD_UI_TOGGLE_VISIBILITY') {
                        state.ui[action.payload.uiElement].visible = !state.ui[action.payload.uiElement].visible;
                    }
                    const pane = document.querySelector('#pretest-pane');
                    pane.style.height = state.ui.pretest.visible ? '300px' : '0px';
                    pane.style.visibility = state.ui.pretest.visible ? 'visible' : 'hidden';
                    pane.style.overflow = 'hidden';
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
            document.querySelector('.scratchpad__toolbar__pretest').addEventListener('click', () => window.nativePretests++);
            document.querySelector('.scratchpad__toolbar__submit').addEventListener('click', () => window.nativeSubmits++);
            // Match the original toolbar's onClick; the product enhancement must leave this handler intact.
            document.querySelector('[data-global-hotkey="alt+p"]').addEventListener('click', () => {
                window.nativePanelToggles++;
                window.store.dispatch({ type: 'SCRATCHPAD_UI_TOGGLE_VISIBILITY', payload: { uiElement: 'pretest' } });
            });
            window.complete = (rid, status, message, compilerTexts = []) => window.store.dispatch({
                type: 'SCRATCHPAD_RECORDS_PUSH', payload: { rdoc: { _id: rid, status, time: 1, memory: 128, testCases: [{ message }], compilerTexts } },
            });
        }, { reducer: pretestReducer, hotkeys: hotkeySource });
        await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'frontend/problem-workbench.css'), 'utf8') });
        await page.addStyleTag({ content: 'html,body{margin:0}#scratchpad{width:900px;margin:auto}'
            + '.problem-content{display:none!important}.scratchpad__toolbar{position:static!important;display:flex!important}'
            + '.ScratchpadMonacoEditor{width:900px!important}#pretest-pane{display:flex;flex-direction:column}' });
        await page.addScriptTag({ content: bundle });
        await page.addScriptTag({ content: helperBundle });
        await page.evaluate(() => window.registeredPages[0].afterLoading());
        await page.waitForSelector('.oi33-pretest-feedback', { state: 'attached' });
        const initial = await page.evaluate(() => ({ code: window.fixtureEditor.getValue(), position: window.fixtureEditor.getPosition() }));
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        assert.equal(await page.locator('#pretest-pane').evaluate((node) => node.getBoundingClientRect().height), 0);
        const toggle = page.getByRole('button', { name: '测试数据 (Alt+P)', exact: true });
        assert.equal(await toggle.isVisible(), true);
        assert.match(await toggle.textContent(), /测试数据/);
        assert.match(await toggle.getAttribute('title'), /打开或收起样例和自定义输入/);
        await toggle.click();
        assert.equal(await page.locator('[aria-label="选择自测样例"]').isVisible(), true);
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        const visibleGeometry = await page.evaluate(() => {
            const pane = document.querySelector('#pretest-pane').getBoundingClientRect();
            const input = document.querySelector('[aria-label="自测输入"]').getBoundingClientRect();
            return { height: pane.height, inside: input.top >= pane.top && input.bottom <= pane.bottom && input.bottom <= innerHeight };
        });
        assert.equal(visibleGeometry.height, 300);
        assert.equal(visibleGeometry.inside, true);
        assert.equal(await page.evaluate(() => window.posts.length), 0, 'Opening data does not submit or run');
        if (process.env.OI33_PRETEST_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.OI33_PRETEST_SCREENSHOT_DIR, { recursive: true });
            await page.locator('#scratchpad').screenshot({
                path: path.join(process.env.OI33_PRETEST_SCREENSHOT_DIR, 'pretest-before-run.png'),
            });
        }
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
        await page.keyboard.press('F9');
        assert.equal(await page.inputValue('[aria-label="自测输入"]'), '1 2\n');
        assert.equal(await page.evaluate(() => window.posts.length), 1);
        assert.deepEqual(await page.evaluate(() => window.posts[0].body), {
            lang: 'cc.cc14o2', code: initial.code, input: ['1 2\n'], pretest: true,
        });
        assert.equal(await page.evaluate(() => window.nativePretests), 0);
        await page.evaluate(() => window.requests[0].resolve({ rid: 'run1' }));
        await page.evaluate(() => window.complete('run1', 1, '3\n'));
        assert.equal(await page.getAttribute('.oi33-pretest-feedback__record', 'href'), '/record/run1');
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /运行成功，不代表整题通过/);
        assert.equal(await page.textContent('.oi33-pretest-feedback__resources'), '1 ms · 128 KiB');
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /文本一致/);

        await page.selectOption('[aria-label="选择自测样例"]', '2');
        assert.equal(await page.inputValue('[aria-label="自测输入"]'), '4 5\n');
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), true);
        assert.match(await page.textContent('.oi33-pretest-feedback__column:nth-child(2)'), /样例 1.*3/s);
        await page.keyboard.press('F9');
        // A result may reach the websocket before the HTTP response assigns rid.
        await page.evaluate(() => window.complete('run2', 1, '9 \n'));
        await page.evaluate(() => window.requests[1].resolve({ rid: 'run2' }));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /仅空白字符不同/);
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), false);
        if (process.env.OI33_PRETEST_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.OI33_PRETEST_SCREENSHOT_DIR, { recursive: true });
            await page.locator('.oi33-pretest-feedback').screenshot({
                path: path.join(process.env.OI33_PRETEST_SCREENSHOT_DIR, 'pretest-light.png'),
            });
        }
        await page.evaluate(() => window.complete('run1', 1, 'old late result'));
        assert.doesNotMatch(await page.textContent('.oi33-pretest-feedback'), /old late result/);

        await page.selectOption('[aria-label="选择自测样例"]', '3');
        await page.keyboard.press('F9');
        assert.deepEqual(await page.evaluate(() => window.posts[2].body.input), ['']);
        await page.evaluate(() => window.requests[2].resolve({ rid: 'run3' }));
        await page.evaluate(() => window.complete('run3', 1, 'alternative valid output\n'));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /多解或特殊判题不能据此判断错误/);

        await page.selectOption('[aria-label="选择自测样例"]', '');
        await page.locator('[aria-label="自测输入"]').fill('');
        await page.keyboard.press('F9');
        assert.deepEqual(await page.evaluate(() => window.posts[3].body.input), ['']);
        await page.evaluate(() => window.requests[3].resolve({ rid: 'run4' }));
        await page.evaluate(() => window.complete('run4', 1, '<img src=x onerror="alert(1)">'));
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /自定义输入没有标准输出/);
        assert.equal(await page.locator('.oi33-pretest-feedback img').count(), 0);
        await page.locator('[aria-label="自测输入"]').fill('new input');
        assert.equal(await page.locator('.oi33-pretest-feedback__stale').isVisible(), true);
        await page.keyboard.press('F9');
        await page.evaluate(() => window.requests[4].resolve({ rid: 'run5' }));
        await page.evaluate(() => window.complete('run5', 7, '', ['error: expected semicolon']));
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /编译失败/);
        assert.match(await page.textContent('.oi33-pretest-feedback'), /error: expected semicolon/);
        await page.keyboard.press('F9');
        await page.evaluate(() => window.requests[5].reject(new Error('rate limited')));
        assert.match(await page.textContent('.oi33-pretest-feedback__status'), /未提交成功/);
        assert.match(await page.textContent('.oi33-pretest-feedback__comparison'), /rate limited/);

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
        await page.keyboard.press('F10');
        assert.equal(await page.evaluate(() => window.nativeSubmits), 1);
        assert.equal(await page.evaluate(() => window.state.ui.pretest.visible), false);
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), false);
        await page.keyboard.press('Alt+p');
        assert.equal(await page.locator('[aria-label="自测输入"]').isVisible(), true);
        assert.equal(await page.evaluate(() => window.posts.length), 7, 'Reopening after submit does not run again');
        assert.deepEqual(await page.evaluate(() => ({ code: window.fixtureEditor.getValue(), position: window.fixtureEditor.getPosition() })), initial);
        assert.deepEqual(errors, []);
        // Contrast uses the established theme tokens, not white background/white text.
        await page.evaluate(() => {
            document.body.style.cssText = '--oi33-text:#e5e9f0;--oi33-surface:#22252d;--oi33-surface-2:#171a21;--oi33-text-secondary:#aeb9c9;--oi33-line:#465066;--oi33-line-strong:#566078';
        });
        const colors = await page.locator('[aria-label="自测输入"]').evaluate((node) => {
            const css = getComputedStyle(node);
            return { foreground: css.color, background: css.backgroundColor };
        });
        assert.deepEqual(colors, { foreground: 'rgb(229, 233, 240)', background: 'rgb(23, 26, 33)' });
        const boxes = await page.locator('.oi33-pretest-feedback__column').evaluateAll((nodes) => nodes.map((node) => {
            const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width };
        }));
        assert.ok(boxes.every((box) => box.width > 100));
        assert.ok(boxes[0].right < boxes[1].left && boxes[1].right < boxes[2].left);
        if (process.env.OI33_PRETEST_SCREENSHOT_DIR) await page.locator('.oi33-pretest-feedback').screenshot({
            path: path.join(process.env.OI33_PRETEST_SCREENSHOT_DIR, 'pretest-dark.png'),
        });
    } finally {
        await browser.close();
    }
});
