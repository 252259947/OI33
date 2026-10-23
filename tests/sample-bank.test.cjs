const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { buildSync } = require('esbuild');

// This optional acceptance test consumes a read-only export of real public
// statements. No live account, database mutation or judge submission is used.
if (process.env.OI33_LAYOUT_TEST === '1' && process.env.OI33_SAMPLE_BANK_FIXTURE) {
    test('real public problem-bank export: native-rendered sample copy/fill/readout acceptance', async () => {
        const { chromium } = require('playwright');
        const root = path.resolve(__dirname, '..');
        const sourcePath = path.resolve(process.env.OI33_SAMPLE_BANK_FIXTURE);
        const source = fs.readFileSync(sourcePath, 'utf8');
        const fixture = JSON.parse(source);
        assert.equal(fixture.readOnly, true, 'Use the audited read-only fixture export');
        assert.ok(fixture.samples.length >= 30, 'Acceptance covers a stratified bank sample, not just one handpicked problem');
        for (const entry of fixture.samples) {
            assert.equal(entry.hidden, false, `${entry.pid}: private/hidden statements must not enter the fixture`);
            assert.equal(typeof entry.html, 'string', `${entry.pid}: requires actual Hydro-rendered HTML`);
            assert.ok(Array.isArray(entry.expectedRenderedSamples), `${entry.pid}: requires independently reviewed exact rendered sample expectations`);
        }
        const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
        const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
        const locales = require('js-yaml').load(fs.readFileSync(path.join(root,
            'node_modules/@hydrooj/ui-default/locales/zh.yaml'), 'utf8'));
        const bundles = [
            ['sample-actions.ts', 'SampleActions'], ['pretest-feedback.ts', 'SampleFeedback'],
        ].map(([file, globalName]) => buildSync({
            entryPoints: [path.join(root, 'frontend', file)], bundle: true, write: false, format: 'iife', globalName,
        }).outputFiles[0].text);
        const origin = 'http://127.0.0.1:41938';
        const result = {
            generatedAt: new Date().toISOString(), sourcePath,
            sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
            productionWrites: 0, samples: [],
        };
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
            const page = await context.newPage();
            const errors = [];
            const writes = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => { if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`); });
            await page.route(`${origin}/**`, async (route) => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                    + '<html data-page="sample_bank_fixture"><head><meta charset="utf-8"></head><body class="mode--scratchpad">'
                    + '<main class="fixture-host"><div class="problem-content richmedia typo" id="statement"></div></main>'
                    + '</body></html>' });
                const file = path.resolve(publicRoot, '.' + pathname);
                if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                    return route.fulfill({ status: 404, body: '' });
                }
                return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js')
                    ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
            });
            // The snapshot may contain external images. Keep acceptance offline
            // and deterministic; no external services are required for sample UI.
            await page.route('**/*', async (route) => {
                if (route.request().url().startsWith(origin)) return route.fallback();
                return route.abort();
            });
            await page.goto(`${origin}/fixture`);
            await page.evaluate(({ origin, locales }) => {
                window.UiContext = JSON.stringify({ cdn_prefix: `${origin}/`, pdoc: { pid: 'BankFixture' } });
                window.UserContext = JSON.stringify({ viewLang: 'zh', codeFontFamily: 'monospace' });
                window.UiContextNew = '{}';
                window.UserContextNew = '{}';
                window.LOCALES = locales;
            }, { origin, locales });
            await page.addScriptTag({ content: main });
            await page.evaluate(async () => {
                window.webpackChunk_hydrooj_ui_default.push([[987661], {}, (require) => { window.hydroRequire = require; }]);
                await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
                window.NativeHydro = window.hydroRequire(51604);
                window.highlighterPage = window.hydroRequire(10881).default;
                if (window.highlighterPage.name !== 'highlighterPage') throw new Error('Recheck the native highlighter module after a UI upgrade');
                document.querySelector('.page-loader')?.remove();
                window.actions = [];
                window.input = '';
                window.store = { dispatch: (action) => {
                    window.actions.push(action);
                    if (action.type === 'SCRATCHPAD_PRETEST_DATA_CHANGE') window.input = action.payload.value;
                } };
                window.highlighterPage.afterLoading();
            });
            await page.addStyleTag({ content: [
                'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css',
                'frontend/oi33-design-system.css', 'frontend/problem-workbench.css',
            ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') });
            await page.addStyleTag({ content: 'html,body{margin:0;min-height:100%;overflow:auto!important}'
                + '.fixture-host{width:calc(50vw - 40px);margin:32px;padding:24px;box-sizing:border-box;background:var(--oi33-surface);border:1px solid var(--oi33-line);border-radius:16px}' });
            for (const content of bundles) await page.addScriptTag({ content });
            await page.evaluate(() => window.SampleActions.installSampleActions(document.querySelector('#statement')));
            const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
            const dismissNotices = async () => {
                await page.locator('.mantine-Notification-closeButton').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
                await page.waitForFunction(() => !document.querySelector('.mantine-Notification-root'), null, { timeout: 5000 });
            };
            for (const entry of fixture.samples) {
                await page.evaluate((html) => {
                    document.querySelector('#statement').innerHTML = html;
                    window.actions = [];
                    window.bankLabels = [...document.querySelectorAll('#statement pre > code')].flatMap((code) => {
                        const label = code.parentElement.previousElementSibling;
                        const value = label?.textContent.trim().replace(/[:：]\s*$/, '').trim();
                        if (!label || !/^(?:(?:输入|输出)(?:(?:样例|示例))?|(?:样例|示例)(?:输入|输出)|(?:sample |example )?(?:input|output))(?:\s*[#＃]?\s*\d+)?$/i.test(value)) return [];
                        return [{ code, label, text: label.textContent, html: label.innerHTML, tag: label.tagName }];
                    });
                    window.NativeHydro.$('#statement').trigger('vjContentNew');
                    window.SampleActions.installSampleActions(document.querySelector('#statement'));
                }, entry.html);
                await page.waitForFunction(() => [...document.querySelectorAll('#statement pre > code')]
                    .every((node) => node.parentElement.parentElement.classList.contains('code-toolbar')));
                await page.waitForFunction(() => [...document.querySelectorAll('#statement .oi33-sample-block')]
                    .every((node) => node.querySelector('.oi33-sample-action--copy')));
                const expected = entry.expectedRenderedSamples.map((sample) => ({ ...sample, id: String(sample.id) }));
                const actual = await page.evaluate(() => window.SampleFeedback.readPublicSamples(document.querySelector('#statement')));
                assert.deepEqual(actual, expected, `${entry.pid}: shared resolver must match independently reviewed public samples`);
                const expectedCopies = expected.reduce((sum, sample) => sum + 1 + (sample.output === null ? 0 : 1), 0);
                assert.equal(await page.locator('#statement .oi33-sample-action--copy').count(), expectedCopies,
                    `${entry.pid}: no unmatched decoration or ordinary-code false positives`);
                assert.equal(await page.locator('#statement .oi33-sample-action--fill').count(), expected.length,
                    `${entry.pid}: each sample input has exactly one fill control`);
                await page.evaluate(() => {
                    window.bankSampleNodes = [...document.querySelectorAll('.oi33-sample-block')].map((block) => ({
                        block, code: block.querySelector('pre > code'), text: block.querySelector('pre > code').textContent,
                        header: block.querySelector(':scope > .oi33-sample-label, :scope > h2'),
                        copy: block.querySelector('.oi33-sample-action--copy'), fill: block.querySelector('.oi33-sample-action--fill'),
                    }));
                });
                let copied = 0;
                for (const sample of expected) {
                    for (const [kind, value] of [['输入', sample.input], ['输出', sample.output]]) {
                        if (value === null) continue;
                        const copy = page.getByRole('link', { name: `复制样例${kind} ${sample.id}`, exact: true });
                        assert.equal(await copy.count(), 1, `${entry.pid}: unique ${kind} sample ${sample.id}`);
                        await page.evaluate(() => navigator.clipboard.writeText('sample-bank sentinel'));
                        await copy.click();
                        assert.equal(await clipboard(), value.replace(/\r\n/g, '\n') || 'sample-bank sentinel',
                            `${entry.pid}: ${kind} ${sample.id} clipboard text`);
                        copied++;
                        await dismissNotices();
                    }
                    const fill = page.locator(`.oi33-sample-action--fill[aria-label="将样例输入 ${sample.id} 填充到自测"]`);
                    const before = await page.evaluate(() => window.actions.length);
                    await fill.click();
                    assert.equal(await page.evaluate(() => window.input), sample.input, `${entry.pid}: fill payload`);
                    assert.equal(await page.evaluate(() => window.actions.length), before + 1, `${entry.pid}: one fill dispatch`);
                    assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
                        type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: sample.input },
                    }, `${entry.pid}: fill never starts a judge or changes editor code`);
                    await dismissNotices();
                }
                await page.evaluate(() => {
                    for (let i = 0; i < 3; ++i) window.SampleActions.installSampleActions(document.querySelector('#statement'));
                    window.NativeHydro.$('#statement').trigger('vjContentNew');
                });
                assert.equal(await page.locator('#statement .oi33-sample-action--copy').count(), expectedCopies);
                assert.deepEqual(await page.evaluate(() => window.bankSampleNodes.flatMap(({ block, code, text, header, copy, fill }) => {
                    return code.parentElement.parentElement !== block || code.textContent !== text
                        || !header || block.querySelector(':scope > .oi33-sample-label, :scope > h2') !== header
                        || block.querySelector('.oi33-sample-action--copy') !== copy || block.querySelector('.oi33-sample-action--fill') !== fill
                        ? [text.slice(0, 30)] : [];
                })), [], `${entry.pid}: repeat mount/highlight preserves sample/header/action nodes and payloads`);
                assert.deepEqual(await page.evaluate(() => window.bankLabels.flatMap(({ code, label, text, html, tag }) => {
                    const block = code.closest('.oi33-sample-block');
                    if (!block) return [];
                    return !label.isConnected || label.textContent !== text || label.innerHTML !== html || label.tagName !== tag
                        || (!/\blanguage-(?:input|output)\d*/.test(code.className)
                            && (label.parentElement !== block || !label.classList.contains('oi33-sample-label')))
                        ? [text] : [];
                })), [], `${entry.pid}: original sample labels retain DOM identity, markup and heading semantics`);
                assert.deepEqual(await page.evaluate(() => window.SampleFeedback.readPublicSamples(document.querySelector('#statement'))), expected,
                    `${entry.pid}: header relocation and remount preserve dropdown input/output pairs`);
                for (const width of [1280, 1440, 1920]) for (const dark of [false, true]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.mouse.click(width - 5, 5);
                    await page.evaluate((dark) => document.documentElement.classList.toggle('theme--dark', dark), dark);
                    await page.waitForFunction(() => {
                        const vars = getComputedStyle(document.documentElement);
                        const probe = document.createElement('span');
                        return [...document.querySelectorAll('.oi33-sample-action')].every((node) => {
                            const fill = node.classList.contains('oi33-sample-action--fill');
                            probe.style.backgroundColor = vars.getPropertyValue(fill ? '--oi33-brand-soft' : '--oi33-surface');
                            return getComputedStyle(node).backgroundColor === probe.style.backgroundColor;
                        });
                    });
                    const violations = await page.evaluate(() => [...document.querySelectorAll('.oi33-sample-block')].flatMap((block) => {
                        const toolbar = block.querySelector(':scope > .toolbar').getBoundingClientRect();
                        const pre = block.querySelector(':scope > pre').getBoundingClientRect();
                        const parent = block.getBoundingClientRect();
                        const title = block.querySelector(':scope > .oi33-sample-label, :scope > h2')?.getBoundingClientRect();
                        return toolbar.bottom > pre.top + 1 || toolbar.left < parent.left - 1 || toolbar.right > parent.right + 1
                            || !title || title.bottom > pre.top + 1 || title.right > toolbar.left + 1
                            || Math.abs((title.top + title.bottom - toolbar.top - toolbar.bottom) / 2) > 1
                            ? [block.querySelector('pre > code').textContent.slice(0, 30)] : [];
                    }));
                    assert.deepEqual(violations, [], `${entry.pid}: ${width}px ${dark ? 'dark' : 'light'} label and controls share one row above the sample`);
                }
                result.samples.push({ pid: entry.pid, category: entry.category, contentSha256: entry.contentSha256,
                    sampleCount: expected.length, copied, filled: expected.length, themes: ['light', 'dark'], widths: [1280, 1440, 1920],
                    headerRowsAligned: true, nodeIdentityPreserved: true, passed: true });
            }
            assert.deepEqual(writes, [], 'Bank acceptance never sends a submission or production write');
            assert.deepEqual(errors, []);
            result.ok = true;
            if (process.env.OI33_SAMPLE_BANK_RESULT) {
                fs.mkdirSync(path.dirname(path.resolve(process.env.OI33_SAMPLE_BANK_RESULT)), { recursive: true });
                fs.writeFileSync(process.env.OI33_SAMPLE_BANK_RESULT, JSON.stringify(result, null, 2));
            }
        } finally {
            await browser.close();
        }
    });
}
