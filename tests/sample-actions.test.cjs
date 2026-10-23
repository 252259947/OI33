const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'frontend/sample-actions.ts');

test('sample action enhancement stays scoped and keeps native copy and fill handlers', () => {
    const source = fs.readFileSync(helperPath, 'utf8');
    const page = fs.readFileSync(path.join(root, 'frontend/problem-workbench.page.ts'), 'utf8');
    assert.match(source, /export function installSampleActions/);
    assert.match(source, /MutationObserver/, 'Native highlighting can finish after the page mounts');
    assert.match(source, /WeakSet/, 'Repeated mounts reuse the existing observer');
    assert.doesNotMatch(source, /innerHTML|outerHTML|replaceWith|cloneNode|request\.|fetch\(|clipboard\.write|execCommand/,
        'Presentation must not replace native controls or reimplement their data operations');
    assert.match(page, /installSampleActions/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('Chrome and native Hydro highlighter: localized sample actions preserve copy/fill and fit both themes', async () => {
    const { chromium } = require('playwright');
    const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
    const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
    const locales = require('js-yaml').load(fs.readFileSync(path.join(root,
        'node_modules/@hydrooj/ui-default/locales/zh.yaml'), 'utf8'));
    const bundle = buildSync({
        entryPoints: [helperPath], bundle: true, write: false, format: 'iife', globalName: 'SampleActions',
    }).outputFiles[0].text;
    const feedbackBundle = buildSync({
        entryPoints: [path.join(root, 'frontend/pretest-feedback.ts')], bundle: true, write: false,
        format: 'iife', globalName: 'SampleFeedback',
    }).outputFiles[0].text;
    const origin = 'http://127.0.0.1:41937';
    const values = {
        input1: '1  2\t3\n\n 4\n', output1: '6\t7 \n', input2: '', output2: '',
        input3: 'unpaired input\n', output4: 'standalone output\n',
        input5: `${'1234567890'.repeat(40)}\n`.repeat(12), output5: '<tag> & result\n',
    };
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        const page = await context.newPage();
        const errors = [];
        const unexpectedRequests = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (request.method() !== 'GET') unexpectedRequests.push(`${request.method()} ${request.url()}`);
        });
        await page.route(`${origin}/**`, async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                + '<html data-page="sample_actions_fixture"><head><meta charset="utf-8"></head><body>'
                + '<main class="fixture-host"><div class="problem-content richmedia typo" id="statement"></div></main>'
                + '</body></html>' });
            const file = path.resolve(publicRoot, '.' + pathname);
            if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return route.fulfill({ status: 404, body: '' });
            }
            return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js')
                ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
        });
        await page.goto(`${origin}/fixture`);
        await page.evaluate(({ origin, values, locales }) => {
            window.UiContext = JSON.stringify({ cdn_prefix: `${origin}/`, pdoc: { pid: 'SampleActionsFixture' } });
            window.UserContext = JSON.stringify({ viewLang: 'zh', codeFontFamily: 'monospace' });
            window.LOCALES = locales;
            window.UiContextNew = '{}';
            window.UserContextNew = '{}';
            const statement = document.querySelector('#statement');
            for (const [id, value] of Object.entries(values)) {
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.id = id;
                code.className = `language-${id}`;
                code.textContent = value;
                pre.append(code);
                statement.append(pre);
            }
            const ordinary = document.createElement('pre');
            ordinary.innerHTML = '<code class="language-cpp" id="ordinary-code">int main() { return 0; }\n</code>';
            statement.append(ordinary);
        }, { origin, values, locales });
        // Use the installed, unmodified Prism toolbar, ClipboardJS and Hydro fill handler.
        // Only the application's presentation enhancement is bundled separately.
        await page.addScriptTag({ content: main });
        await page.evaluate(async () => {
            window.webpackChunk_hydrooj_ui_default.push([[987659], {}, (require) => { window.hydroRequire = require; }]);
            await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
            window.NativeHydro = window.hydroRequire(51604);
            window.highlighterPage = window.hydroRequire(10881).default;
            if (window.highlighterPage.name !== 'highlighterPage') throw new Error('Recheck the native Hydro highlighter module after a UI upgrade');
            document.querySelector('.page-loader')?.remove();
            window.actions = [];
            window.pretestInput = 'previous input';
            window.state = { pretest: { input: window.pretestInput }, ui: {}, records: { items: {} } };
            window.listeners = new Set();
            window.store = {
                getState: () => window.state,
                subscribe: (listener) => { window.listeners.add(listener); return () => window.listeners.delete(listener); },
                dispatch: (action) => {
                    window.actions.push(action);
                    if (action.type === 'SCRATCHPAD_PRETEST_DATA_CHANGE') {
                        window.pretestInput = action.payload.value;
                        window.state.pretest.input = action.payload.value;
                    }
                    for (const listener of window.listeners) listener();
                },
            };
        });
        await page.addStyleTag({ content: [
            'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css',
            'frontend/oi33-design-system.css', 'frontend/problem-workbench.css',
        ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') });
        await page.addStyleTag({ content: 'html,body{margin:0;min-height:100%;overflow:auto!important}'
            + '.fixture-host{width:min(1000px,calc(100vw - 80px));margin:32px;padding:24px;box-sizing:border-box;background:var(--oi33-surface);border:1px solid var(--oi33-line);border-radius:16px}'
            + '.mode--scratchpad .fixture-host{width:calc(50vw - 40px)}' });
        await page.addScriptTag({ content: bundle });
        await page.addScriptTag({ content: feedbackBundle });
        // Mount first, then let the real asynchronous highlighter insert its toolbar.
        await page.evaluate(() => {
            window.SampleActions.installSampleActions(document.querySelector('#statement'));
            window.highlighterPage.afterLoading();
        });
        await page.waitForSelector('#statement .oi33-sample-action--copy');
        await page.waitForFunction(() => document.querySelectorAll('.oi33-sample-action--copy').length === 8);
        const block = (id) => page.locator(`#${id}`).locator('xpath=../..');
        const copy = (id) => block(id).locator('.oi33-sample-action--copy');
        const fill = (id) => block(id).locator('.oi33-sample-action--fill');
        // Windows' real clipboard normalizes LF to CRLF. Preserve every other
        // byte, including tabs, trailing spaces, blank lines and final newline.
        const readClipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
        assert.equal(await page.locator('.oi33-sample-block').count(), 8);
        assert.equal(await page.locator('.oi33-sample-action--fill').count(), 4);
        assert.equal(await copy('input1').textContent(), '复制');
        assert.equal(await copy('input1').getAttribute('aria-label'), '复制样例输入 1');
        assert.equal(await copy('output1').getAttribute('aria-label'), '复制样例输出 1');
        assert.equal(await copy('input1').getAttribute('title'), '复制样例输入 1');
        assert.equal(await fill('input1').textContent(), '填充到自测');
        assert.equal(await fill('input1').isVisible(), false, 'Ordinary problem view retains the native hidden fill control');
        assert.equal(await block('ordinary-code').locator('.oi33-sample-action').count(), 0, 'Ordinary source-code blocks are not restyled');
        assert.equal(await block('ordinary-code').locator('.toolbar a').first().textContent(), 'Copy');

        for (const id of ['input1', 'output1', 'input2', 'output2', 'input3', 'output4', 'output5']) {
            await page.evaluate(() => navigator.clipboard.writeText('sentinel before copy'));
            await copy(id).click();
            // Native ClipboardJS has no selection to copy for an empty sample;
            // this presentation-only change must preserve its existing behavior.
            assert.equal(await readClipboard(), values[id] || 'sentinel before copy',
                `${id}: native copy retains nonempty whitespace/escaping or leaves an empty selection unchanged`);
            assert.equal(await page.locator(`#${id}`).textContent(), values[id], 'Decoration cannot mutate the sample payload');
        }
        // Native anchor keyboard activation remains intact after its text/classes change.
        await copy('output1').focus();
        await page.keyboard.press('Enter');
        assert.equal(await readClipboard(), values.output1);
        assert.equal(await page.evaluate(() => window.actions.length), 0, 'Copy never changes pretest or formal submission state');

        await page.evaluate(() => document.body.classList.add('mode--scratchpad'));
        for (const id of ['input1', 'input2', 'input3']) {
            const count = await page.evaluate(() => window.actions.length);
            await fill(id).click();
            assert.equal(await page.evaluate(() => window.pretestInput), values[id]);
            assert.equal(await page.evaluate(() => window.actions.length), count + 1, 'Fill preserves exactly one native state update');
            assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
                type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: values[id] },
            });
        }
        assert.equal(await block('output1').locator('.oi33-sample-action--fill').count(), 0, 'Output has no fill-input action');
        assert.deepEqual(unexpectedRequests, [], 'Copy/fill do not create a self-test or formal submission');

        const assertGeometry = async (label, alignedPairs = false) => {
            const result = await page.evaluate((alignedPairs) => {
                const violations = [];
                const intersects = (a, b) => a.left < b.right - 1 && b.left < a.right - 1
                    && a.top < b.bottom - 1 && b.top < a.bottom - 1;
                for (const wrapper of document.querySelectorAll('.oi33-sample-block')) {
                    const id = wrapper.querySelector('pre > code').id;
                    const bounds = wrapper.getBoundingClientRect();
                    const pre = wrapper.querySelector('pre').getBoundingClientRect();
                    const toolbar = wrapper.querySelector(':scope > .toolbar').getBoundingClientRect();
                    const title = wrapper.querySelector(':scope > .oi33-sample-label, :scope > h2')?.getBoundingClientRect();
                    if (toolbar.left < bounds.left - 1 || toolbar.right > bounds.right + 1) violations.push(`${id}: toolbar outside sample`);
                    if (toolbar.bottom > pre.top + 1) violations.push(`${id}: toolbar overlays sample text`);
                    if (title && intersects(title, toolbar)) violations.push(`${id}: title overlaps actions`);
                    if (title && Math.abs((title.top + title.bottom - toolbar.top - toolbar.bottom) / 2) > 1) {
                        violations.push(`${id}: sample label and actions are not centered on the same row`);
                    }
                    if (title && title.bottom > pre.top + 1) violations.push(`${id}: label overlays sample text`);
                    const buttons = [...wrapper.querySelectorAll('.oi33-sample-action')].filter((node) => node.getClientRects().length);
                    for (let i = 0; i < buttons.length; ++i) {
                        const node = buttons[i];
                        const rect = node.getBoundingClientRect();
                        const css = getComputedStyle(node);
                        if (rect.height < 28 || rect.height > 34) violations.push(`${id}: button height ${rect.height}`);
                        if (css.fontSize !== '12px' || css.borderRadius !== '8px') violations.push(`${id}: inconsistent compact button styling`);
                        if (css.color === css.backgroundColor || css.backgroundColor === 'rgba(0, 0, 0, 0)') violations.push(`${id}: unreadable or missing button surface`);
                        if (i && intersects(rect, buttons[i - 1].getBoundingClientRect())) violations.push(`${id}: actions overlap`);
                    }
                }
                if (alignedPairs) {
                    for (const input of document.querySelectorAll('.oi33-sample-block > pre > code')) {
                        const id = input.className.match(/language-input(\d+)/)?.[1];
                        if (!id) continue;
                        const output = document.querySelector(`code.language-output${id}`);
                        if (!output) continue;
                        const a = input.parentElement.getBoundingClientRect();
                        const b = output.parentElement.getBoundingClientRect();
                        if (b.left >= a.right - 1 && Math.abs(a.top - b.top) > 1) violations.push(`sample ${id}: paired input/output tops differ (${a.top}, ${b.top})`);
                    }
                }
                if (document.documentElement.scrollWidth > innerWidth + 1) violations.push('page overflows horizontally');
                return violations;
            }, alignedPairs);
            assert.deepEqual(result, [], label);
        };
        const settleTheme = async (dark) => {
            await page.evaluate((dark) => document.documentElement.classList.toggle('theme--dark', dark), dark);
            await page.mouse.click((await page.viewportSize()).width - 5, 5);
            // Wait for the real color transition, rather than taking a misleading
            // dark-theme screenshot with the previous light button backgrounds.
            await page.waitForFunction(() => {
                const vars = getComputedStyle(document.documentElement);
                const probe = document.createElement('span');
                return [...document.querySelectorAll('.oi33-sample-action')].every((node) => {
                    const fill = node.classList.contains('oi33-sample-action--fill');
                    probe.style.backgroundColor = vars.getPropertyValue(fill ? '--oi33-brand-soft' : '--oi33-surface');
                    probe.style.color = vars.getPropertyValue(fill ? '--oi33-brand-strong' : '--oi33-text-2');
                    const actual = getComputedStyle(node);
                    return actual.backgroundColor === probe.style.backgroundColor && actual.color === probe.style.color;
                });
            }, null, { timeout: 3000 }).catch(async (error) => {
                error.message += `\nTheme diagnostics: ${JSON.stringify(await page.evaluate(() => ({ vars: ['--oi33-surface', '--oi33-brand-soft', '--oi33-brand-strong', '--oi33-text-2'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name)]), actions: [...document.querySelectorAll('.oi33-sample-action')].map((node) => ({ cls: node.className, foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, visible: !!node.getClientRects().length })) })))}`;
                throw new Error(error.message);
            });
        };
        // Close real notification UI before taking visual evidence. Error toasts
        // from the native empty-copy behavior must not cover the sample layout.
        for (let attempt = 0; attempt < 8 && await page.locator('.mantine-Notification-closeButton').count(); ++attempt) {
            await page.locator('.mantine-Notification-closeButton').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
            await page.waitForFunction(() => !document.querySelector('.mantine-Notification-closeButton')
                || [...document.querySelectorAll('.mantine-Notification-root')].every((node) => getComputedStyle(node).opacity === '0'), null, { timeout: 5000 }).catch(() => {});
        }
        await page.waitForFunction(() => document.querySelectorAll('.mantine-Notification-root').length === 0, null, { timeout: 15000 });
        for (const width of [1180, 1280, 1440, 1920]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const dark of [false, true]) {
                await settleTheme(dark);
                await page.evaluate(() => scrollTo(0, 0));
                await assertGeometry(`${width}px ${dark ? 'dark' : 'light'} scratchpad sample columns`, true);
                if (process.env.OI33_SAMPLE_SCREENSHOT_DIR) {
                    fs.mkdirSync(process.env.OI33_SAMPLE_SCREENSHOT_DIR, { recursive: true });
                    await page.screenshot({ path: path.join(process.env.OI33_SAMPLE_SCREENSHOT_DIR,
                        `sample-actions-${width === 1440 ? '' : `${width}-`}${dark ? 'dark' : 'light'}.png`) });
                }
            }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const width of [480, 420, 360]) {
            await page.locator('.fixture-host').evaluate((node, width) => { node.style.width = `${width}px`; }, width);
            for (const dark of [false, true]) {
                await settleTheme(dark);
                await assertGeometry(`dragged statement pane to ${width}px, ${dark ? 'dark' : 'light'}`);
            }
        }
        await page.locator('.fixture-host').evaluate((node) => node.style.removeProperty('width'));
        await page.evaluate(() => document.body.classList.remove('mode--scratchpad'));
        await assertGeometry('ordinary problem view');
        assert.equal(await fill('input1').isVisible(), false);

        // Repeated add-on mounts must leave the original link objects and their native listeners alive.
        await page.evaluate(() => {
            window.originalCopy = document.querySelector('#input1').closest('.code-toolbar').querySelector('.oi33-sample-action--copy');
            window.originalFill = document.querySelector('#input1').closest('.code-toolbar').querySelector('.oi33-sample-action--fill');
            window.originalNativeTitle = document.querySelector('#input1').closest('.code-toolbar').querySelector(':scope > h2');
            for (let i = 0; i < 4; ++i) window.SampleActions.installSampleActions(document.querySelector('#statement'));
        });
        assert.equal(await copy('input1').evaluate((node) => node === window.originalCopy), true);
        assert.equal(await fill('input1').evaluate((node) => node === window.originalFill), true);
        assert.equal(await block('input1').locator(':scope > h2').evaluate((node) => node === window.originalNativeTitle), true,
            'The native sample heading remains the original DOM node');
        assert.equal(await page.locator('.oi33-sample-action--copy').count(), 8);
        assert.equal(await page.locator('.oi33-sample-action--fill').count(), 4);
        await page.evaluate(() => {
            document.body.classList.add('mode--scratchpad');
            const fragment = document.createElement('div');
            fragment.className = 'richmedia';
            fragment.id = 'new-fragment';
            fragment.innerHTML = '<pre><code class="language-input6" id="input6">new input\n</code></pre>'
                + '<pre><code class="language-output6" id="output6">new output\n</code></pre>';
            document.querySelector('#statement').append(fragment);
            window.NativeHydro.$(fragment).trigger('vjContentNew');
        });
        await page.waitForFunction(() => document.querySelectorAll('.oi33-sample-action--copy').length === 10);
        assert.equal(await copy('input6').textContent(), '复制', 'PJAX content gets enhancement after native highlighting');
        await copy('input6').click();
        assert.equal(await readClipboard(), 'new input\n');
        const beforeFill = await page.evaluate(() => window.actions.length);
        await fill('input6').click();
        assert.equal(await page.evaluate(() => window.actions.length), beforeFill + 1);
        assert.equal(await page.evaluate(() => window.pretestInput), 'new input\n');
        await page.evaluate(() => {
            window.SampleActions.installSampleActions(document.querySelector('#statement'));
            window.NativeHydro.$('#new-fragment').trigger('vjContentNew');
        });
        await page.waitForTimeout(50);
        assert.equal(await page.locator('#new-fragment .oi33-sample-action--copy').count(), 2);
        assert.equal(await page.locator('#new-fragment .oi33-sample-action--fill').count(), 1);
        await fill('input6').click();
        assert.equal(await page.evaluate(() => window.actions.length), beforeFill + 2, 'Repeated fragment events never duplicate the native fill handler');
        assert.deepEqual(unexpectedRequests, []);
        assert.deepEqual(errors, []);

        // Actual LuoguU719049 structure: the sample is marked by headings and
        // input/output labels, not Hydro's language-inputN/outputN classes.
        await page.evaluate(() => {
            const statement = document.querySelector('#statement');
            statement.innerHTML = '<h2 id="legacy-group1">样例1</h2><p id="legacy-label-input1">输入：</p>'
                + '<pre><code class="language-text" id="legacy-input1">8\n5 2 -3 7 -3 4 0 -3\n</code></pre>'
                + '<p id="legacy-label-output1">输出：</p><pre><code class="language-text" id="legacy-output1">-3 3\n</code></pre>'
                + '<h2 id="legacy-group2">样例 2</h2><h3 id="legacy-label-input2"><strong>输入样例 2</strong></h3><pre><code class="language-text" id="legacy-input2"></code></pre>'
                + '<h3 id="legacy-label-output2">输出样例 2</h3><pre><code class="language-text" id="legacy-output2">empty input\n</code></pre>'
                + '<h2>样例说明</h2><pre><code class="language-cpp" id="legacy-explanation">int answer = -3;\n</code></pre>'
                + '<h2>输入格式</h2><pre><code class="language-text" id="legacy-format">n m\n</code></pre>'
                + '<h2>解题代码</h2><p>这不是样例输入：</p>'
                + '<pre><code class="language-cpp" id="legacy-ordinary">int main() { return 0; }\n</code></pre>';
            window.originalCompatLabels = [...statement.querySelectorAll('[id^="legacy-label-"]')]
                .map((node) => ({ node, id: node.id, text: node.textContent, html: node.innerHTML, tag: node.tagName }));
            window.originalCompatSamples = window.SampleFeedback.readPublicSamples(statement);
            window.labelClicks = 0;
            document.querySelector('#legacy-label-input1').addEventListener('click', () => window.labelClicks++);
            window.SampleActions.installSampleActions(statement);
            window.NativeHydro.$(statement).trigger('vjContentNew');
        });
        await page.waitForFunction(() => document.querySelectorAll('.oi33-sample-action--copy').length === 4);
        assert.equal(await page.locator('.oi33-sample-action--fill').count(), 2);
        assert.equal(await copy('legacy-input1').textContent(), '复制');
        assert.equal(await fill('legacy-input1').textContent(), '填充到自测');
        assert.equal(await copy('legacy-output1').getAttribute('aria-label'), '复制样例输出 1');
        const assertOriginalLabels = async () => {
            assert.deepEqual(await page.evaluate(() => window.originalCompatLabels.flatMap(({ node, id, text, html, tag }) => {
                const code = document.querySelector(`#${id.replace('label-', '')}`);
                const wrapper = code.closest('.code-toolbar');
                return node !== document.getElementById(id) || node.textContent !== text || node.innerHTML !== html
                    || node.tagName !== tag || node.parentElement !== wrapper || wrapper.firstElementChild !== node
                    || !node.classList.contains('oi33-sample-label') || document.querySelectorAll(`#${id}`).length !== 1
                    ? [id] : [];
            })), [], 'Plain sample labels move intact into their own action row without cloning, rewriting or duplication');
            assert.equal(await page.locator('#statement > #legacy-group1').count(), 1, 'The sample group heading stays outside the sample action row');
            assert.equal(await page.locator('#statement > #legacy-group2').count(), 1);
            assert.deepEqual(await page.evaluate(() => window.SampleFeedback.readPublicSamples(document.querySelector('#statement'))),
                await page.evaluate(() => window.originalCompatSamples), 'Moving headings cannot change sample discovery or expected output pairs');
        };
        await assertOriginalLabels();
        await page.locator('#legacy-label-input1').click();
        assert.equal(await page.evaluate(() => window.labelClicks), 1, 'Moving the label preserves attached listeners');
        for (const [id, value] of [['legacy-input1', '8\n5 2 -3 7 -3 4 0 -3\n'], ['legacy-output1', '-3 3\n']]) {
            await copy(id).click();
            assert.equal(await readClipboard(), value, `${id}: native ClipboardJS still copies the heading-based sample`);
        }
        for (const id of ['legacy-explanation', 'legacy-format', 'legacy-ordinary']) {
            assert.equal(await block(id).locator('.oi33-sample-action').count(), 0, `${id}: descriptive/code blocks are not samples`);
            assert.equal(await block(id).locator('.toolbar a').first().textContent(), 'Copy');
        }
        assert.deepEqual(await page.evaluate(() => window.SampleFeedback.readPublicSamples(document.querySelector('#statement'))), [
            { id: '1', input: '8\n5 2 -3 7 -3 4 0 -3\n', output: '-3 3\n' },
            { id: '2', input: '', output: 'empty input\n' },
        ], 'The dropdown uses the same public sample identity/input/output as the statement actions');
        await page.evaluate(() => {
            const nativePanel = document.createElement('div');
            nativePanel.className = 'splitpane-fill';
            nativePanel.style.cssText = 'position:relative;height:200px;width:100%;margin-top:24px';
            nativePanel.innerHTML = '<textarea class="scratchpad__data-input"></textarea>';
            document.querySelector('.fixture-host').append(nativePanel);
            window.compatFeedback = window.SampleFeedback.installPretestFeedback(document.querySelector('.fixture-host'), window.store);
            // This is the public hook invoked by the existing workbench's
            // delegated .scratchpad-fill-button click listener after dispatch.
            document.querySelector('#statement').addEventListener('click', (event) => {
                if (event.target.closest('.scratchpad-fill-button')) setTimeout(() => window.compatFeedback.filledSample());
            });
        });
        const compatActionCount = await page.evaluate(() => window.actions.length);
        await fill('legacy-input1').click();
        await page.waitForFunction(() => document.querySelector('[aria-label="选择自测样例"]').value === '1');
        assert.equal(await page.locator('[aria-label="自测输入"]').inputValue(), '8\n5 2 -3 7 -3 4 0 -3\n');
        assert.equal(await page.evaluate(() => window.actions.length), compatActionCount + 1);
        await page.getByRole('tab', { name: '预期输出', exact: true }).click();
        assert.equal(await page.locator('.oi33-pretest-feedback__expected').textContent(), '-3 3\n');
        await page.selectOption('[aria-label="选择自测样例"]', '2');
        assert.equal(await page.locator('[aria-label="自测输入"]').inputValue(), '');
        assert.equal(await page.locator('.oi33-pretest-feedback__expected').textContent(), 'empty input\n');
        await fill('legacy-input1').click();
        await page.waitForFunction(() => document.querySelector('[aria-label="选择自测样例"]').value === '1');
        const afterSecondFill = await page.evaluate(() => window.actions.length);
        await page.evaluate(() => {
            const statement = document.querySelector('#statement');
            window.savedCompatCopy = document.querySelector('#legacy-input1').closest('.code-toolbar').querySelector('.oi33-sample-action--copy');
            window.savedCompatFill = document.querySelector('#legacy-input1').closest('.code-toolbar').querySelector('.oi33-sample-action--fill');
            for (let i = 0; i < 4; ++i) window.SampleActions.installSampleActions(statement);
            window.NativeHydro.$(statement).trigger('vjContentNew');
        });
        await page.waitForFunction(() => document.querySelectorAll('.oi33-sample-action--copy').length === 4);
        assert.equal(await copy('legacy-input1').evaluate((node) => node === window.savedCompatCopy), true);
        assert.equal(await fill('legacy-input1').evaluate((node) => node === window.savedCompatFill), true);
        await assertOriginalLabels();
        await fill('legacy-input1').click();
        assert.equal(await page.evaluate(() => window.actions.length), afterSecondFill + 1, 'New heading-based fill has one handler after re-highlighting');
        for (const width of [1280, 1440, 1920]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const dark of [false, true]) {
                await settleTheme(dark);
                await page.evaluate(() => scrollTo(0, 0));
                await assertGeometry(`heading-based samples, ${width}px ${dark ? 'dark' : 'light'} theme`);
                if (process.env.OI33_SAMPLE_SCREENSHOT_DIR) {
                    await page.screenshot({ path: path.join(process.env.OI33_SAMPLE_SCREENSHOT_DIR,
                        `sample-header-plain-${width}-${dark ? 'dark' : 'light'}.png`) });
                }
            }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const width of [480, 420, 360]) {
            await page.locator('.fixture-host').evaluate((node, width) => { node.style.width = `${width}px`; }, width);
            for (const dark of [false, true]) {
                await settleTheme(dark);
                await assertGeometry(`heading-based samples, dragged pane ${width}px ${dark ? 'dark' : 'light'}`);
            }
        }
        await assertOriginalLabels();
        await page.evaluate(() => window.compatFeedback.dispose());
        assert.deepEqual(unexpectedRequests, [], 'Heading-based samples never submit or run code');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
