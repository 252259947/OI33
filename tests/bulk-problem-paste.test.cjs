const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync, buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend/bulk-problem-paste.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports);
const { parseProblemTokens, exactProblem, mergeProblemIds, resolveProblemTokens, parseTrainingChapters, updateTrainingChapter } = mod.exports;
const example = 'LuoguB2002, LuoguB2025, LuoguB2007, LuoguB2003, LuoguB2005, LuoguB2017, LuoguB2008, LuoguB2009, LuoguB2010, LuoguB2028, LuoguB2022, LuoguB2006, LuoguB2015, LuoguB2013, LuoguB2014, LuoguB2012, LuoguB2027, LuoguB2032, LuoguB2031, LuoguB2030';
const noPause = async () => {};

test('the requested twenty Luogu problem IDs preserve pasted order', async () => {
    const tokens = parseProblemTokens(example);
    assert.equal(tokens.length, 20);
    const result = await resolveProblemTokens(tokens, async (token) => [{ docId: tokens.indexOf(token) + 10, pid: token }], noPause);
    assert.deepEqual(result.map((p) => p.pid), example.split(', '));
    assert.deepEqual(result.map((p) => p.docId), Array.from({ length: 20 }, (_, i) => i + 10));
});

test('mixed delimiters, CRLF, duplicates, UTF whitespace and input bounds', () => {
    assert.deepEqual(parseProblemTokens(' LuoguB2002，UVA100; P23\n\r23\tLuoguB2002；LuoguB2025　UVA100 '), ['LuoguB2002', 'UVA100', 'P23', '23', 'LuoguB2025']);
    assert.throws(() => parseProblemTokens(''), /粘贴题号/);
    assert.throws(() => parseProblemTokens('X'.repeat(129)), /题号过长/);
    assert.throws(() => parseProblemTokens('X'.repeat(32001)), /过长/);
    assert.throws(() => parseProblemTokens(Array.from({ length: 201 }, (_, i) => String(i)).join(',')), /200/);
});

test('only exact PID/canonical ID matches; no first fuzzy search result', () => {
    const docs = [{ docId: 123, pid: 'LuoguB20020' }, { docId: 200, pid: 'LuoguB2002' }, { docId: 321, pid: 'P123' }];
    assert.equal(exactProblem('LuoguB2002', docs).docId, 200);
    assert.equal(exactProblem('LuoguB200', docs), undefined);
    assert.equal(exactProblem('P123', docs).docId, 321);
    assert.equal(exactProblem('123', docs).docId, 123);
    assert.equal(exactProblem('P123', docs.slice(0, 2)), undefined, 'Do not confuse an inaccessible actual PID with a numeric alias');
    assert.equal(exactProblem('https://evil.example/p/123', docs), undefined);
    assert.equal(exactProblem('other-domain/123', docs), undefined);
    assert.equal(exactProblem('bad', [{ pid: 'bad', docId: NaN }]), undefined);
});

test('canonical ID aliases deduplicate and current selected order is retained', () => {
    assert.deepEqual(mergeProblemIds([9, 3, 9], [3, 20, 7, 20]), [9, 3, 20, 7]);
    assert.throws(() => mergeProblemIds([NaN], [2]), /尚未完成选择/);
});

test('one nonexistent/denied problem or network failure rejects the entire result', async () => {
    const selected = [9];
    let writes = 0;
    const apply = async (lookup) => {
        const result = await resolveProblemTokens(['P1', 'missing', 'P3'], lookup, noPause);
        writes++;
        selected.push(...result.map((p) => p.docId));
    };
    await assert.rejects(apply(async (token) => token === 'missing' ? [] : [{ docId: +token.slice(1), pid: token }]), /missing.*未添加任何题目/);
    await assert.rejects(apply(async () => { throw new Error('429'); }), /请求受限.*未添加任何题目/);
    assert.deepEqual(selected, [9]);
    assert.equal(writes, 0);
});

test('lookup concurrency and request rate are explicitly bounded', async () => {
    let active = 0;
    let max = 0;
    const pauses = [];
    await resolveProblemTokens(Array.from({ length: 20 }, (_, i) => String(i + 1)), async (token) => {
        active++;
        max = Math.max(active, max);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return [{ docId: Number(token) }];
    }, async (ms) => { pauses.push(ms); });
    assert.equal(max, 4);
    assert.deepEqual(pauses, [400, 400, 400, 400]);
});

test('training uses unique chapter ID, preserves all other chapters and metadata', () => {
    const dag = [{ _id: 1, title: '同名章节', pids: [2], requireNids: [], extra: { note: 'keep' } },
        { _id: 7, title: '同名章节', pids: [8], requireNids: [1], desc: 'keep too' }];
    const text = JSON.stringify(dag);
    const updated = JSON.parse(updateTrainingChapter(text, text, 7, [8, 12, 12, 13]));
    assert.deepEqual(updated[0], dag[0]);
    assert.deepEqual(updated[1], { ...dag[1], pids: [8, 12, 13] });
    assert.throws(() => updateTrainingChapter(text, text + ' ', 7, [8]), /已被修改/);
    assert.throws(() => updateTrainingChapter(text, text, 999, [8]), /已不存在/);
    assert.throws(() => parseTrainingChapters('['), /JSON/);
    assert.throws(() => parseTrainingChapters('[]'), /合法章节/);
    assert.throws(() => parseTrainingChapters(JSON.stringify([...dag, dag[0]])), /合法章节/);
});

test('integration is restricted to editor page names and native component/editor APIs', () => {
    const page = fs.readFileSync(path.join(root, 'frontend/bulk-problem-paste.page.ts'), 'utf8');
    assert.match(page, /'homework_create', 'homework_edit', 'contest_create', 'contest_edit', 'training_create', 'training_edit'/);
    assert.match(page, /form input\[name="pids"\]/);
    assert.match(page, /form textarea\[name="dag"\]\[data-json\]/);
    assert.match(page, /instance\.ref\.setSelectedKeys/);
    assert.match(page, /data\('vjEditorInstance'\)/);
    assert.match(page, /editor\.value\(value\)/);
    assert.doesNotMatch(page, /window\.editor|window\.model|request\.post|\.val\(/);
    assert.match(page, /pendingForms\.has\(event\.target/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('browser paste integration, atomic failures, races, form gates and training refresh', async () => {
    const { chromium } = require('playwright');
    const build = buildSync({ entryPoints: [path.join(root, 'frontend/bulk-problem-paste.page.ts')], bundle: true, write: false,
        outfile: 'bulk.js', format: 'iife', globalName: 'BulkPaste', external: ['@hydrooj/ui-default'] });
    const script = build.outputFiles.find((f) => f.path.endsWith('.js')).text;
    const css = build.outputFiles.find((f) => f.path.endsWith('.css')).text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
        await page.setContent('<form id="form"><input name="pids"><input id="global-search"><button type="submit">保存</button></form>'
            + '<form id="training"><label>计划<textarea name="dag" data-json></textarea></label><button type="submit">保存训练</button></form>');
        await page.addStyleTag({ content: css });
        await page.evaluate(() => {
            const data = new WeakMap();
            window.$ = (node) => ({ data(key) { return data.get(node)?.[key]; }, on() {} });
            let pids = ['99'];
            window.selected = () => pids;
            window.setSelected = (ids) => { pids = ids; };
            const dummy = document.querySelector('[name=pids]');
            const container = document.createElement('div');
            container.innerHTML = '<input id="picker">';
            dummy.after(container);
            const queryInput = container.querySelector('input');
            const instance = { options: { multi: true }, container, ref: {
                getQuery: () => queryInput.value,
                getValue: () => pids.join(','),
                setQuery: (value) => { queryInput.value = value; },
                closeList() {},
                setSelectedKeys: (ids) => { pids = ids; dummy.value = ids.join(','); },
            } };
            const dag = [{ _id: 1, title: '第一章', pids: [99], requireNids: [] }, { _id: 7, title: '第二章', pids: [7], requireNids: [1] }];
            const textarea = document.querySelector('[name=dag]');
            textarea.value = JSON.stringify(dag);
            window.editor = { isValid: true, value(v) { if (typeof v === 'string') textarea.value = v; return textarea.value; } };
            data.set(textarea, { vjEditorInstance: window.editor });
            window.UiContext = { domainId: 'system' };
            window.requests = [];
            window.delayLookup = 0;
            window.require = () => ({ $: window.$, NamedPage: function () {}, addPage() {},
                ReactDOM: { flushSync: (fn) => fn() }, ProblemSelectAutoComplete: { getOrConstruct: () => instance }, request: {
                    async get(url, args) {
                        window.requests.push({ url, args });
                        if (window.delayLookup) await new Promise((r) => setTimeout(r, window.delayLookup));
                        if (args.q === 'missing') return { pdocs: [] };
                        const docId = Number(args.q.replace(/\D/g, ''));
                        return { pdocs: [{ docId, pid: args.q, title: `题目 ${docId}` }] };
                    },
                },
            });
        });
        await page.addScriptTag({ content: script });
        await page.evaluate(() => window.BulkPaste.installBulkProblemPaste());
        const paste = (selector, value) => page.evaluate(({ selector, value }) => {
            const data = new DataTransfer(); data.setData('text/plain', value);
            document.querySelector(selector).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, { selector, value });
        await paste('#picker', example);
        await page.waitForFunction(() => document.querySelector('.oi33-bulk-problem-status').textContent.startsWith('已添加 20'));
        assert.equal((await page.evaluate(() => window.selected())).length, 21);
        await paste('#picker', 'LuoguB2002 missing');
        await page.waitForFunction(() => document.querySelector('.oi33-bulk-problem-status').textContent.includes('missing'));
        assert.equal((await page.evaluate(() => window.selected())).length, 21);
        const before = await page.evaluate(() => window.requests.length);
        await paste('#global-search', 'LuoguB2002, LuoguB2025');
        await paste('#picker', 'LuoguB2002');
        assert.equal(await page.evaluate(() => window.requests.length), before);
        await page.evaluate(() => { window.delayLookup = 100; });
        await paste('#picker', 'LuoguB9, LuoguB8');
        await paste('#picker', 'LuoguB6, LuoguB5');
        assert.equal(await page.evaluate(() => document.querySelector('#form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))), false);
        await page.evaluate(() => window.setSelected(['99', '100']));
        await page.waitForFunction(() => !document.querySelector('[data-oi33-bulk-problem-paste]').hasAttribute('aria-busy'));
        assert.deepEqual(await page.evaluate(() => window.selected()), ['99', '100', '9', '8']);
        await paste('#picker', 'LuoguB2, LuoguB3');
        await page.fill('#picker', 'new query');
        await page.waitForFunction(() => !document.querySelector('[data-oi33-bulk-problem-paste]').hasAttribute('aria-busy'));
        assert.deepEqual(await page.evaluate(() => window.selected()), ['99', '100', '9', '8']);
        await page.selectOption('[aria-label="目标章节"]', '7');
        await page.fill('[aria-label="批量题号"]', 'LuoguB2, LuoguB3');
        await page.click('[data-import]');
        assert.equal(await page.evaluate(() => document.querySelector('#training').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))), false);
        await page.waitForFunction(() => !document.querySelector('[data-import]').disabled);
        assert.deepEqual(await page.evaluate(() => JSON.parse(window.editor.value()).map((c) => c.pids)), [[99], [7, 2, 3]]);
        await page.fill('[aria-label="批量题号"]', 'LuoguB4, LuoguB5');
        await page.click('[data-import]');
        await page.evaluate(() => { const dag = JSON.parse(window.editor.value()); dag[0].title = '保留用户修改'; window.editor.value(JSON.stringify(dag)); });
        await page.waitForFunction(() => !document.querySelector('[data-import]').disabled);
        assert.equal(await page.inputValue('[aria-label="批量题号"]'), 'LuoguB4, LuoguB5');
        assert.deepEqual(await page.evaluate(() => JSON.parse(window.editor.value()).map((c) => c.pids)), [[99], [7, 2, 3]]);
        await page.evaluate(() => { const dag = JSON.parse(window.editor.value()); dag.push({ _id: 12, title: '动态新章节', pids: [], requireNids: [7] }); window.editor.value(JSON.stringify(dag)); });
        await page.click('[data-refresh]');
        assert.match(await page.locator('[aria-label="目标章节"]').textContent(), /动态新章节/);
        assert.equal(await page.evaluate(() => document.querySelector('#training').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))), true);
    } finally { await browser.close(); }
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real shipped Hydro React selector commits tags and submitted pids before unlocking', async () => {
    const { chromium } = require('playwright');
    const output = buildSync({ entryPoints: [path.join(root, 'frontend/bulk-problem-paste.page.ts')], bundle: true, write: false,
        outfile: 'bulk.js', format: 'iife', globalName: 'BulkPaste', external: ['@hydrooj/ui-default'] });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
        await page.setContent('<form><input name="pids" value="99"><button type="submit">保存</button></form>');
        await page.evaluate(() => {
            const modules = {};
            const cache = {};
            const data = new WeakMap();
            window.nativeModules = modules;
            // Load the exact installed production modules without running Hydro's page bootstrap.
            window.webpackChunk_hydrooj_ui_default = { push(chunk) { Object.assign(modules, chunk[1]); } };
            const req = (id) => {
                if (cache[id]) return cache[id].exports;
                if (window.nativeStubs[id]) return window.nativeStubs[id];
                if (!modules[id]) throw new Error(`Missing native module ${id}`);
                const module = { exports: {} };
                cache[id] = module;
                modules[id](module, module.exports, req);
                return module.exports;
            };
            req.d = (exports, definitions) => Object.entries(definitions).forEach(([key, get]) => Object.defineProperty(exports, key, { enumerable: true, get }));
            req.r = (exports) => { Object.defineProperty(exports, '__esModule', { value: true }); };
            req.n = (module) => { const get = module?.__esModule ? () => module.default : () => module; req.d(get, { a: get }); return get; };
            req.o = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
            req.g = window;
            req.nmd = (module) => module;
            req.hmd = (module) => module;
            window.nativeRequire = req;
            const $ = (element) => ({
                0: element, eq() { return this; }, on() { return this; },
                data(key, value) { if (!data.has(element)) data.set(element, {}); if (value !== undefined) data.get(element)[key] = value; return data.get(element)[key]; },
                val(value) { if (value !== undefined) element.value = value; return element.value; },
                addClass(name) { element.classList.add(name); return this; },
                removeClass(name) { element.classList.remove(name); return this; },
                after(node) { element.after(node); return this; },
                removeData(key) { delete data.get(element)?.[key]; return this; },
            });
            const doc = (token) => ({ docId: Number(String(token).replace(/\D/g, '')), pid: `LuoguB${Number(String(token).replace(/\D/g, ''))}`, title: `题目 ${token}` });
            window.nativeLookupCount = 0;
            window.nativeStubs = { 91688: $, 46195: {
                Em: { get: async (_, { q }) => { window.nativeLookupCount++; return { pdocs: [doc(q)] }; } },
                FH: async (_, { ids }) => ids.map(doc),
            } };
            window.UiContext = { domainId: 'system' };
        });
        const publicDir = path.join(root, 'node_modules/@hydrooj/ui-default/public');
        for (const file of fs.readdirSync(publicDir).filter((file) => /^(181\.|604\.|n\.react-dom\.|n\.lodash\.).*\.js$/.test(file))) {
            await page.addScriptTag({ content: fs.readFileSync(path.join(publicDir, file), 'utf8') });
        }
        await page.evaluate(() => {
            const native = window.nativeRequire;
            window.require = () => ({ $: window.nativeStubs[91688], NamedPage: function () {}, addPage() {},
                ProblemSelectAutoComplete: native(67127).A,
                ReactDOM: native(57657), request: window.nativeStubs[46195].Em });
        });
        await page.addScriptTag({ content: output.outputFiles.find((file) => file.path.endsWith('.js')).text });
        await page.evaluate(() => window.BulkPaste.installBulkProblemPaste());
        await page.waitForSelector('.autocomplete-wrapper input');
        await page.waitForFunction(() => document.querySelectorAll('.autocomplete-tag').length === 1);
        await page.evaluate((text) => {
            const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
            document.querySelector('.autocomplete-wrapper input').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        }, example);
        await page.waitForFunction(() => document.querySelector('.oi33-bulk-problem-status').textContent.startsWith('已添加 20'));
        assert.equal(await page.locator('.autocomplete-tag').count(), 21);
        const expected = [99, ...parseProblemTokens(example).map((token) => Number(token.replace(/\D/g, '')))];
        assert.equal(await page.inputValue('[name=pids]'), expected.join(','));
        assert.equal(await page.evaluate(() => new FormData(document.querySelector('form')).get('pids')), expected.join(','));
        assert.equal(await page.evaluate(() => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))), true);
        assert.equal(await page.evaluate(() => window.nativeLookupCount), 20, 'The native numeric-only onPaste did not run after capture interception');
    } finally { await browser.close(); }
});
