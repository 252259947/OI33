const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync, transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'frontend/editor-wheel-zoom.ts');
const compiled = transformSync(fs.readFileSync(helperPath, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { EDITOR_FONT_MIN, EDITOR_FONT_MAX, installEditorWheelZoom } = mod.exports;

function fixture(size = 14) {
    const container = new EventTarget();
    let dispose;
    const changes = [];
    const updates = [];
    const editor = {
        getOption: () => size,
        updateOptions: (options) => {
            updates.push(options);
            if (options.fontSize !== undefined) size = options.fontSize;
        },
        onDidDispose: (listener) => {
            dispose = listener;
            return { dispose() {} };
        },
    };
    const bind = () => installEditorWheelZoom(editor, container, 52, (value) => changes.push(value));
    bind();
    return {
        editor, container, changes, updates, bind,
        size: () => size,
        dispose: () => dispose(),
        wheel: (deltaY, flags = { ctrlKey: true }) => {
            const event = new Event('wheel', { cancelable: true });
            Object.assign(event, { deltaY, ...flags });
            container.dispatchEvent(event);
            return event.defaultPrevented;
        },
    };
}

test('Ctrl wheel uses 1px steps and exact 10–40px limits without changing the initial font', () => {
    assert.equal(EDITOR_FONT_MIN, 10);
    assert.equal(EDITOR_FONT_MAX, 40);
    const f = fixture();
    assert.equal(f.size(), 14);
    assert.deepEqual(f.changes, []);
    assert.equal(f.wheel(-120), true);
    assert.equal(f.size(), 15);
    assert.equal(f.wheel(120), true);
    assert.equal(f.size(), 14);
    for (let index = 0; index < 100; index++) assert.equal(f.wheel(-120), true);
    assert.equal(f.size(), 40);
    const upperChanges = f.changes.length;
    assert.equal(f.wheel(-120), true);
    assert.equal(f.changes.length, upperChanges);
    for (let index = 0; index < 100; index++) assert.equal(f.wheel(120), true);
    assert.equal(f.size(), 10);
    const lowerChanges = f.changes.length;
    assert.equal(f.wheel(120), true);
    assert.equal(f.changes.length, lowerChanges);
    assert.equal(f.wheel(-120), true);
    assert.equal(f.size(), 11);
});

test('ordinary scrolling, horizontal wheel, invalid deltas and other shortcuts remain untouched', () => {
    const f = fixture();
    for (const [delta, flags] of [[120, {}], [-120, { metaKey: true }], [0, { ctrlKey: true }],
        [NaN, { ctrlKey: true }], [Infinity, { ctrlKey: true }],
        [120, { ctrlKey: true, altKey: true }], [120, { ctrlKey: true, shiftKey: true }],
        [120, { ctrlKey: true, metaKey: true }]]) {
        assert.equal(f.wheel(delta, flags), false);
    }
    assert.equal(f.size(), 14);
    assert.deepEqual(f.changes, []);
});

test('repeated mount is idempotent and disposing removes the event listener', () => {
    const f = fixture(20);
    f.bind();
    f.bind();
    f.wheel(-120);
    assert.equal(f.size(), 21);
    assert.deepEqual(f.changes, [21]);
    f.dispose();
    assert.equal(f.wheel(-120), false);
    assert.equal(f.size(), 21);
    const next = fixture(14);
    next.wheel(-120);
    assert.equal(next.size(), 15);
});

test('out-of-range existing preferences are clamped while valid preferences are preserved', () => {
    assert.equal(fixture(8).size(), 10);
    assert.equal(fixture(72).size(), 40);
    for (const size of [10, 12, 17, 22, 40]) assert.equal(fixture(size).size(), size);
});

test('integration stays in problem scratchpads, waits for lazy Monaco and keeps the size selector in sync', () => {
    const source = fs.readFileSync(path.join(root, 'frontend/problem-workbench.page.ts'), 'utf8');
    assert.match(source, /problemPages = \['problem_detail', 'contest_detail_problem', 'homework_detail_problem'\]/);
    assert.match(source, /!scratchpad\?\.editor && scratchpad\?\.load\) await scratchpad\.load/);
    assert.match(source, /container\.contains\(editor\.getDomNode\(\)\)/);
    assert.match(source, /commitEditorSetting\(store, customOptions, 'fontSize', size\)/);
    assert.match(source, /select\.value = String\(size\)/);
    assert.match(source, /fontSize <= EDITOR_FONT_MAX/);
    const helper = fs.readFileSync(helperPath, 'utf8');
    assert.doesNotMatch(helper, /(?:window|document)\.addEventListener/);
    assert.doesNotMatch(helper, /setValue|executeEdits|setPosition|scrollTo/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real installed Monaco and Chrome: bounded wheel, lazy mount, settings and code remain correct', async () => {
    const { chromium } = require('playwright');
    const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
    const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
    assert.ok(main.includes('U.bind(U,51604)'), 'Recheck the native Hydro API module after a UI upgrade');
    const bundle = buildSync({
        entryPoints: [path.join(root, 'frontend/problem-workbench.page.ts')],
        bundle: true, write: false, format: 'iife', globalName: 'ProblemWorkbench',
        external: ['@hydrooj/ui-default'], loader: { '.css': 'empty' },
    }).outputFiles[0].text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.route('http://editor.fixture.invalid/**', async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                + '<html data-page="problem_detail"><body><div id="outside">题目正文</div><div id="scratchpad">'
                + '<div class="scratchpad__toolbar"><div class="scratchpad__toolbar__item"><select><option>C++14</option></select></div></div>'
                + '<div class="problem-content"><p>Fixture statement</p></div>'
                + '<div class="ScratchpadMonacoEditor" style="width:1000px;height:480px"></div></div>'
                + '<div id="other" style="width:1000px;height:140px"></div></body></html>' });
            const file = path.resolve(publicRoot, '.' + pathname);
            if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return route.fulfill({ status: 404, body: '' });
            }
            return route.fulfill({ body: fs.readFileSync(file),
                contentType: file.endsWith('.js') ? 'application/javascript'
                    : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
        });
        await page.goto('http://editor.fixture.invalid/fixture');
        await page.evaluate(() => {
            window.UiContext = JSON.stringify({ cdn_prefix: 'http://editor.fixture.invalid/', pdoc: { pid: 'ZoomFixture' } });
            window.UserContext = JSON.stringify({ viewLang: 'en', codeFontFamily: 'monospace' });
            window.UiContextNew = '{}';
            window.UserContextNew = '{}';
        });
        // Load the shipped Hydro bootstrap after DOMContentLoaded; do not run its unrelated page autoloaders.
        await page.addScriptTag({ content: main });
        await page.evaluate(async () => {
            window.webpackChunk_hydrooj_ui_default.push([[987654], {}, (require) => { window.hydroRequire = require; }]);
            await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
            window.NativeHydro = window.hydroRequire(51604);
            window.nativeMonaco = await window.NativeHydro.loadMonaco([]);
            document.querySelector('.page-loader')?.remove();
            window.registeredPages = [];
            window.settings = { fontSize: 14, tabSize: 4 };
            window.actions = [];
            window.store = {
                getState: () => ({ ui: { activePage: 'problem', settings: { config: window.settings } }, records: {} }),
                dispatch: (action) => {
                    window.actions.push(action);
                    if (action.type === 'SCRATCHPAD_SETTING_UPDATE') {
                        window.settings = { ...window.settings, [action.payload.setting]: action.payload.value };
                        // Match Hydro's componentDidUpdate: settings are reapplied after every code edit too.
                        window.fixtureEditor?.updateOptions(window.settings);
                    }
                },
                subscribe: () => () => {},
            };
            window.fixtureCtx = { scratchpad: { store: window.store } };
            window.fixtureCtx.scratchpad.load = new Promise((resolve) => { window.resolveScratchpad = resolve; });
            window.require = () => ({
                ...window.NativeHydro, ctx: window.fixtureCtx,
                addPage: (value) => window.registeredPages.push(value),
            });
            window.code = Array.from({ length: 160 }, (_, n) => `int value${n} = ${n};`).join('\n');
            window.createEditor = () => {
                const { monaco, registerAction } = window.nativeMonaco;
                const model = monaco.editor.createModel(window.code, 'plaintext');
                const editor = monaco.editor.create(document.querySelector('.ScratchpadMonacoEditor'), {
                    model, fontSize: window.settings.fontSize, minimap: { enabled: false }, smoothScrolling: false,
                });
                registerAction(editor, model);
                editor.setPosition({ lineNumber: 4, column: 5 });
                window.fixtureEditor = editor;
                Object.assign(window.fixtureCtx.scratchpad, { editor, monaco });
                window.resolveScratchpad();
            };
            window.otherEditor = window.nativeMonaco.monaco.editor.create(document.querySelector('#other'), {
                value: 'Markdown/editor outside the scratchpad', language: 'plaintext', fontSize: 14,
            });
            window.outsideWheel = [];
            document.querySelector('#outside').addEventListener('wheel', (event) => window.outsideWheel.push(event.defaultPrevented));
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => window.registeredPages[0].afterLoading());
        await page.waitForSelector('[data-oi33-editor-font-size]', { state: 'attached' });
        await page.evaluate(() => window.createEditor());
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().mouseWheelZoom === false);
        const font = () => page.evaluate(() => window.fixtureEditor.getOption(window.nativeMonaco.monaco.editor.EditorOption.fontSize));
        const snapshot = () => page.evaluate(() => ({
            code: window.fixtureEditor.getValue(),
            position: window.fixtureEditor.getPosition(),
            model: window.fixtureEditor.getModel().id,
            ratio: window.devicePixelRatio, scale: window.visualViewport.scale,
            width: document.querySelector('.ScratchpadMonacoEditor').getBoundingClientRect().width,
            otherFont: window.otherEditor.getOption(window.nativeMonaco.monaco.editor.EditorOption.fontSize),
        }));
        const initial = await snapshot();
        assert.equal(await font(), 14);
        const box = await page.locator('.ScratchpadMonacoEditor').boundingBox();
        const hit = await page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y);
            return { inside: !!element?.closest('.ScratchpadMonacoEditor'), tag: element?.outerHTML?.slice(0, 400) };
        }, { x: box.x + 300, y: box.y + 160 });
        assert.equal(hit.inside, true, JSON.stringify({ box, hit }));
        await page.mouse.move(box.x + 300, box.y + 160);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 15);
        assert.equal(await page.inputValue('[data-oi33-editor-font-size]'), '15');
        await page.mouse.wheel(0, 120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 14);
        assert.deepEqual(await snapshot(), initial);
        await page.keyboard.up('Control');
        await page.mouse.wheel(0, 600);
        await page.waitForFunction(() => window.fixtureEditor.getScrollTop() > 0);
        assert.equal(await font(), 14);
        const nativeWheel = async (delta) => {
            await page.keyboard.down('Control');
            await page.mouse.wheel(0, delta);
            await page.keyboard.up('Control');
        };
        await page.evaluate(() => window.fixtureEditor.setScrollTop(0));
        await page.selectOption('[data-oi33-editor-font-size]', '39', { force: true });
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 39);
        await nativeWheel(-120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 40);
        await nativeWheel(-120);
        assert.equal(await font(), 40);
        assert.equal(await page.inputValue('[data-oi33-editor-font-size]'), '40');
        await page.selectOption('[data-oi33-editor-font-size]', '11', { force: true });
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 11);
        await nativeWheel(120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 10);
        await nativeWheel(120);
        assert.equal(await font(), 10);
        assert.equal(await page.inputValue('[data-oi33-editor-font-size]'), '10');
        await page.evaluate(() => {
            const container = document.querySelector('.ScratchpadMonacoEditor');
            window.fastWheelPrevented = [];
            for (let i = 0; i < 60; i++) {
                const event = new WheelEvent('wheel', { deltaY: i < 35 ? -120 : 120, ctrlKey: true, bubbles: true, cancelable: true });
                container.dispatchEvent(event);
                window.fastWheelPrevented.push(event.defaultPrevented);
            }
            window.fixtureEditor.updateOptions(window.settings);
        });
        assert.equal(await font(), 15);
        assert.equal(await page.inputValue('[data-oi33-editor-font-size]'), '15');
        assert.equal(await page.evaluate(() => window.fastWheelPrevented.every(Boolean)), true);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('editor.config')).fontSize), 15);
        assert.deepEqual(await snapshot(), initial);
        // Re-entering the existing scratchpad must not install another wheel listener.
        for (let index = 0; index < 3; index++) {
            await page.evaluate(() => window.registeredPages[0].afterLoading());
            await page.waitForTimeout(80);
        }
        await nativeWheel(-120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 16);
        assert.equal(await font(), 16);
        const ignored = await page.evaluate(() => {
            const targets = [document.querySelector('.ScratchpadMonacoEditor'), document.querySelector('#outside'), document.querySelector('#other')];
            return targets.map((target, index) => {
                const event = new WheelEvent('wheel', { deltaY: index ? -120 : 0, ctrlKey: true, bubbles: true, cancelable: true });
                target.dispatchEvent(event);
                return event.defaultPrevented;
            });
        });
        assert.deepEqual(ignored, [false, false, false]);
        assert.deepEqual(await snapshot(), initial);
        // A fresh editor after disposal/PJAX gets its own binding and the stored size.
        await page.evaluate(() => {
            window.fixtureEditor.getModel().dispose();
            window.fixtureEditor.dispose();
            document.querySelector('.ScratchpadMonacoEditor').replaceChildren();
            window.registeredPages[0].afterLoading();
        });
        await page.waitForTimeout(100);
        await page.evaluate(() => window.createEditor());
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().mouseWheelZoom === false);
        await nativeWheel(-120);
        await page.waitForFunction(() => window.fixtureEditor.getRawOptions().fontSize === 17);
        assert.equal(await page.inputValue('[data-oi33-editor-font-size]'), '17');
        assert.equal(await page.evaluate(() => window.fixtureEditor.getValue()), initial.code);
        const beforeEdit = await page.evaluate(() => window.fixtureEditor.getPosition());
        await page.evaluate(() => window.fixtureEditor.executeEdits('fixture', [{
            range: window.fixtureEditor.getSelection(), text: 'x',
        }]));
        await page.evaluate(() => window.fixtureEditor.updateOptions(window.settings));
        assert.equal(await font(), 17);
        assert.equal(await page.evaluate(() => window.fixtureEditor.getValue().includes('x')), true);
        assert.deepEqual(beforeEdit, initial.position);
    } finally {
        await browser.close();
    }
});
