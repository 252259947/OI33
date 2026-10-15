const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const route = '/oi33/enrollment/review';
class Loader extends nunjucks.Loader {
    getSource(name) {
        return { src: name === 'layout/basic.html' ? '{% block content %}{% endblock %}'
            : fs.readFileSync(path.join(root, 'templates', name), 'utf8'), path: name };
    }
}
const env = new nunjucks.Environment(new Loader(), { autoescape: true });
env.addGlobal('url', (name, args = {}) => {
    if (name === 'home_security') return '/home/security';
    assert.equal(name, 'oi33_enrollment_review');
    const query = new URLSearchParams(args.query || {}).toString();
    return route + (query ? `?${query}` : '');
});
env.addGlobal('datetimeSpan', () => '<span>2026-10-08</span>');
function render(context = {}) {
    return env.render('oi33_enrollment_review.html', { handler: { csrfToken: 'csrf-test' },
        filterStatus: '', filterName: '', page: 1, pages: 1, total: 0, enrollments: [], ...context });
}
function form(html, marker) {
    const match = new RegExp(`<form[^>]*${marker}[^>]*>([\\s\\S]*?)</form>`).exec(html);
    assert.ok(match, marker);
    return match[0];
}

test('review filters render exactly three status choices, selected status, and a separate text-name GET form', () => {
    for (const filterStatus of ['', 'approved', 'unapproved']) {
        const html = render({ filterStatus, filterName: '张三' });
        const status = form(html, 'data-enrollment-status-filter');
        assert.match(status, /method="get"/);
        assert.match(status, /action="\/oi33\/enrollment\/review"/);
        assert.deepEqual([...status.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
            .map((match) => [match[1], match[2]]), [['', '全部'], ['approved', '已审核'], ['unapproved', '审核未通过']]);
        assert.match(status, new RegExp(`<option value="${filterStatus}" selected>`));
        assert.doesNotMatch(status, /name="(?:name|uid|page)"/);
        const search = form(html, 'data-enrollment-name-filter');
        assert.match(search, /method="get"/);
        assert.match(search, new RegExp(`type="hidden" name="status" value="${filterStatus}"`));
        assert.match(search, /type="text" name="name" maxlength="80" value="张三"/);
        assert.match(search, /学生姓名/);
        assert.match(search, /<button[^>]*type="submit"[^>]*>筛选<\/button>/);
        assert.doesNotMatch(search, /type="number"|name="uid"|name="page"/);
        assert.match(html, /待人工确认及已退回的申请/);
    }
});

test('review filters escape names in inputs and preserve status/name across both pagination links', () => {
    const filterName = '张" & <script>window.injected=1</script>';
    const html = render({ filterStatus: 'unapproved', filterName, page: 2, pages: 3, total: 65 });
    const search = form(html, 'data-enrollment-name-filter');
    assert.ok(search.includes('&quot;'));
    assert.ok(search.includes('&amp;'));
    assert.ok(search.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>window.injected'));
    const links = [...html.matchAll(/<a class="button" href="([^"]*)">(上一页|下一页)<\/a>/g)];
    assert.equal(links.length, 2);
    for (const [index, match] of links.entries()) {
        const url = new URL(match[1].replace(/&amp;/g, '&'), 'https://test.invalid');
        assert.equal(url.pathname, route);
        assert.equal(url.searchParams.get('status'), 'unapproved');
        assert.equal(url.searchParams.get('name'), filterName);
        assert.equal(url.searchParams.get('page'), index === 0 ? '1' : '3');
        assert.equal(url.searchParams.has('uid'), false);
    }
    assert.doesNotMatch(render(), />上一页<|>下一页</);
});

test('review client registers only this admin page and does not auto-submit name input', () => {
    const source = fs.readFileSync(path.join(root, 'frontend/enrollment-review.page.ts'), 'utf8');
    assert.match(source, /NamedPage\('oi33_enrollment_review'/);
    assert.match(source, /select\.addEventListener\('change'/);
    assert.match(source, /form\.requestSubmit\(\)/);
    assert.match(source, /WeakSet/);
    assert.doesNotMatch(source, /addEventListener\('input'|request\.post|fetch\(/);
});

test('password reset controls require a server allowlist and use CSRF-protected POST with a revision', () => {
    const entry = { _id: 45, realName: '<script>not-a-script</script>', revision: 9, status: 'approved',
        accountType: 'regular', enabled: true, history: [] };
    for (const passwordResetAllowedUids of [undefined, [], [46]]) {
        assert.doesNotMatch(render({ enrollments: [entry], passwordResetAllowedUids }), /data-enrollment-password-reset/);
    }
    const html = render({ enrollments: [entry], passwordResetAllowedUids: [45] });
    const reset = form(html, 'data-enrollment-password-reset');
    assert.match(reset, /method="post"/);
    assert.match(reset, /action="\/oi33\/enrollment\/review"/);
    for (const [name, value] of [['csrfToken', 'csrf-test'], ['uid', '45'], ['revision', '9'], ['action', 'reset_password']]) {
        assert.match(reset, new RegExp(`type="hidden" name="${name}" value="${value}"`));
    }
    assert.match(reset, />重置密码<\/button>/);
    assert.doesNotMatch(reset, /name="(?:password|realName)"/);
    assert.doesNotMatch(html, /<script>not-a-script<\/script>/);
    assert.match(html, /&lt;script&gt;not-a-script&lt;\/script&gt;/);
});

test('mandatory password change page uses native secure POST fields without filling secrets', () => {
    const html = env.render('oi33_password_change.html', { handler: { csrfToken: 'csrf-private' } });
    const change = form(html, 'data-enrollment-password-change');
    assert.match(change, /method="post"/);
    assert.match(change, /action="\/home\/security"/);
    assert.match(change, /type="hidden" name="csrfToken" value="csrf-private"/);
    assert.match(change, /type="hidden" name="operation" value="change_password"/);
    for (const name of ['current', 'password', 'verifyPassword']) {
        const input = change.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
        assert.ok(input, name);
        assert.match(input, /type="password"/);
        assert.match(input, /required/);
        assert.match(input, /minlength="6"/);
        assert.match(input, /maxlength="255"/);
        assert.match(input, new RegExp(`autocomplete="${name === 'current' ? 'current-password' : 'new-password'}"`));
        assert.doesNotMatch(input, /value=/);
    }
    assert.doesNotMatch(change, /name="uid"|name="revision"|name="requiresPasswordChange"/);
    assert.match(html, /123456/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real Chrome reset confirmation cancels safely and submits exactly one protected POST', async () => {
    const { chromium } = require('playwright');
    const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/enrollment-review.page.ts')], bundle: true,
        write: false, format: 'iife', globalName: 'ReviewFilters', external: ['@hydrooj/ui-default'] }).outputFiles[0].text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const posted = [];
    try {
        const page = await browser.newPage();
        await page.route('http://oi33-reset.test/**', async (request) => {
            const req = request.request();
            if (req.method() === 'POST') posted.push(new URLSearchParams(req.postData()));
            const html = render({ enrollments: [{ _id: 45, realName: '测试学生', revision: 9, status: 'approved',
                enabled: true, accountType: 'regular', history: [] }], passwordResetAllowedUids: [45] });
            await request.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body>'
                + html + '<script>window.pages=[];window.require=()=>({NamedPage:function(name,callback){this.name=name;this.callback=callback;},addPage:page=>window.pages.push(page)});</script>'
                + `<script>${bundle}</script><script>window.pages.forEach(page=>page.callback());</script></body></html>` });
        });
        await page.goto(`http://oi33-reset.test${route}?uid=999&revision=999`);
        const button = page.locator('form[data-enrollment-password-reset] button');
        await page.evaluate(() => { window.confirmCalls = []; window.confirm = (message) => { window.confirmCalls.push(message); return false; }; });
        await button.click();
        assert.equal(posted.length, 0);
        assert.equal(await page.evaluate(() => window.confirmCalls.length), 1);
        assert.match(await page.evaluate(() => window.confirmCalls[0]), /123456/);
        await page.evaluate(() => {
            window.ReviewFilters.installEnrollmentReviewFilters(); window.ReviewFilters.installEnrollmentReviewFilters();
            window.confirm = (message) => { window.confirmCalls.push(message); return true; };
        });
        await Promise.all([page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()), button.click()]);
        await page.waitForLoadState('load');
        assert.equal(posted.length, 1);
        assert.deepEqual(Object.fromEntries(posted[0]), { csrfToken: 'csrf-test', uid: '45', revision: '9', action: 'reset_password' });
        assert.equal(new URL(page.url()).search, '', 'never submit forged query uid/revision');
    } finally { await browser.close(); }
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real Chrome GET forms: immediate status reset, explicit name submit, Enter and pagination', async () => {
    const { chromium } = require('playwright');
    const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/enrollment-review.page.ts')], bundle: true,
        write: false, format: 'iife', globalName: 'ReviewFilters', external: ['@hydrooj/ui-default'] }).outputFiles[0].text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const navigations = [];
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(10000);
        await page.route('http://oi33-enrollment.test/**', async (request) => {
            const req = request.request();
            const url = new URL(req.url());
            navigations.push({ url: req.url(), method: req.method(), body: req.postData() });
            const html = render({ filterStatus: url.searchParams.get('status') || '', filterName: url.searchParams.get('name') || '',
                page: Number(url.searchParams.get('page')) || 1, pages: 4, total: 100 });
            await request.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body>'
                + html + '<script>window.pages=[];window.require=()=>({NamedPage:function(name,callback){this.name=name;this.callback=callback;},addPage:page=>window.pages.push(page)});</script>'
                + `<script>${bundle}</script><script>window.pages.forEach(page=>page.callback());</script></body></html>` });
        });
        const current = () => new URL(page.url());
        const nameInput = 'form[data-enrollment-name-filter] input[name=name]';
        const statusSelect = 'form[data-enrollment-status-filter] select[name=status]';
        const submit = 'form[data-enrollment-name-filter] button[type=submit]';
        const navigate = async (action) => {
            await Promise.all([page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()), action()]);
            await page.waitForLoadState('load');
        };
        await page.goto(`http://oi33-enrollment.test${route}?status=approved&name=${encodeURIComponent('张三')}&page=3&uid=10`);
        assert.equal(await page.inputValue(nameInput), '张三');
        assert.equal(await page.inputValue(statusSelect), 'approved');
        assert.equal(await page.getAttribute(nameInput, 'type'), 'text');
        assert.equal(await page.getAttribute(nameInput, 'maxlength'), '80');
        assert.equal(await page.evaluate(() => window.pages[0].name), 'oi33_enrollment_review');

        // Typing and blurring must not apply the in-progress name filter.
        await page.fill(nameInput, '尚未提交的姓名');
        await page.locator(nameInput).blur();
        assert.equal(navigations.length, 1);
        assert.equal(current().searchParams.get('name'), '张三');
        // Repeated page initialization must not submit twice on one status change.
        await page.evaluate(() => { window.ReviewFilters.installEnrollmentReviewFilters(); window.ReviewFilters.installEnrollmentReviewFilters(); });
        await navigate(() => page.selectOption(statusSelect, 'unapproved'));
        assert.equal(navigations.length, 2);
        assert.deepEqual([...current().searchParams], [['status', 'unapproved']]);
        assert.equal(await page.inputValue(nameInput), '');
        assert.equal(await page.inputValue('form[data-enrollment-name-filter] input[name=status]'), 'unapproved');
        assert.match(await page.textContent('body'), /第 1 页/);

        // The search button applies only the current status and typed name.
        await page.fill(nameInput, 'Alice & 张');
        assert.equal(navigations.length, 2);
        await navigate(() => page.click(submit));
        assert.deepEqual([...current().searchParams], [['status', 'unapproved'], ['name', 'Alice & 张']]);
        assert.equal(await page.inputValue(nameInput), 'Alice & 张');
        await navigate(() => page.getByRole('link', { name: '下一页', exact: true }).click());
        assert.deepEqual([...current().searchParams], [['page', '2'], ['status', 'unapproved'], ['name', 'Alice & 张']]);
        await navigate(() => page.getByRole('link', { name: '上一页', exact: true }).click());
        assert.equal(current().searchParams.get('page'), '1');
        assert.equal(current().searchParams.get('name'), 'Alice & 张');

        // Enter is the keyboard equivalent of explicit name submission.
        await page.fill(nameInput, '李四');
        await navigate(() => page.press(nameInput, 'Enter'));
        assert.deepEqual([...current().searchParams], [['status', 'unapproved'], ['name', '李四']]);
        await navigate(() => page.selectOption(statusSelect, 'approved'));
        assert.deepEqual([...current().searchParams], [['status', 'approved']]);
        assert.equal(await page.inputValue(nameInput), '');
        await page.fill(nameInput, '再次输入但不提交');
        await navigate(() => page.selectOption(statusSelect, ''));
        assert.deepEqual([...current().searchParams], [['status', '']]);
        assert.equal(await page.inputValue(nameInput), '');
        assert.ok(navigations.every((item) => item.method === 'GET' && item.body === null));

        const dangerousName = '\"><img src=x onerror="window.injected=1">';
        await page.goto(`http://oi33-enrollment.test${route}?name=${encodeURIComponent(dangerousName)}`);
        assert.equal(await page.inputValue(nameInput), dangerousName);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        assert.equal(await page.locator('img').count(), 0);
    } finally { await browser.close(); }
});

if (process.env.OI33_LAYOUT_TEST === '1') test('desktop review filters align and stay readable in both themes and core CSS load orders', async () => {
    const { chromium } = require('playwright');
    const theme = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
    const custom = ['frontend/oi33-design-system.css', 'frontend/enrollment.css']
        .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const fixture = render({ filterStatus: 'approved', filterName: '测试学生', total: 100 });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        for (const [order, sheet] of [['core-first', theme + custom], ['core-last', custom + theme]]) {
            for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
                for (const width of [1024, 1440]) {
                    await page.setViewportSize({ width, height: 980 });
                    await page.setContent(`<!doctype html><html ${mode}><head><meta charset="utf-8"><style>${sheet}</style></head><body><main class="main">${fixture}</main></body></html>`);
                    const result = await page.evaluate(() => {
                        const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255)
                            .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                        const controls = ['form[data-enrollment-status-filter] select', 'form[data-enrollment-name-filter] input[name=name]',
                            'form[data-enrollment-name-filter] button'].map((selector) => {
                            const element = document.querySelector(selector), style = getComputedStyle(element);
                            const rect = element.getBoundingClientRect();
                            let parent = element;
                            while (parent.parentElement && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
                            const foreground = style.webkitTextFillColor || style.color, background = getComputedStyle(parent).backgroundColor;
                            const [lo, hi] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
                            return { x: rect.x, y: rect.y, right: rect.right, height: rect.height, contrast: (hi + .05) / (lo + .05) };
                        });
                        return { scrollWidth: document.documentElement.scrollWidth, controls };
                    });
                    const details = JSON.stringify({ order, mode, width, ...result });
                    assert.ok(result.scrollWidth <= width + 1, `No horizontal overflow: ${details}`);
                    for (const control of result.controls) {
                        assert.ok(control.x >= 0 && control.right <= width && control.height >= 42, `Controls not clipped: ${details}`);
                        assert.ok(Math.abs(control.y - result.controls[0].y) < 1, `Filters share one row: ${details}`);
                        assert.ok(control.contrast >= 4.5, `Filter text contrast: ${details}`);
                    }
                }
            }
        }
    } finally { await browser.close(); }
});

if (process.env.OI33_LAYOUT_TEST === '1') test('mandatory password inputs and labels stay legible in both themes and CSS orders', async () => {
    const { chromium } = require('playwright');
    const theme = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
    const custom = ['frontend/oi33-design-system.css', 'frontend/enrollment.css']
        .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const fixture = env.render('oi33_password_change.html', { handler: { csrfToken: 'csrf-test' } });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
        for (const [order, sheet] of [['core-first', theme + custom], ['core-last', custom + theme]]) {
            for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
                await page.setContent(`<!doctype html><html ${mode}><head><meta charset="utf-8"><style>${sheet}</style></head><body><main class="main">${fixture}</main></body></html>`);
                for (const name of ['current', 'password', 'verifyPassword']) await page.fill(`input[name="${name}"]`, 'qa-visible-password');
                const results = await page.locator('.oi33-password-change').evaluate((container) => {
                    const parse = (color) => color.match(/[\d.]+/g).map(Number);
                    const backgroundOf = (element) => {
                        const result = [0, 0, 0]; let remaining = 1;
                        for (let node = element; node && remaining > 0; node = node.parentElement) {
                            const color = parse(getComputedStyle(node).backgroundColor), alpha = color[3] ?? 1;
                            for (let index = 0; index < 3; index++) result[index] += color[index] * alpha * remaining;
                            remaining *= 1 - alpha;
                        }
                        return result.map((value) => value + 255 * remaining);
                    };
                    const luminance = (color) => color.slice(0, 3).map((v) => v / 255)
                        .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                    return [...container.querySelectorAll('label,input[type=password],button,.oi33-enrollment__muted,.oi33-enrollment__notice')].map((element) => {
                        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
                        const foreground = parse(style.webkitTextFillColor || style.color), background = backgroundOf(element);
                        const [lo, hi] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
                        return { tag: element.tagName, name: element.getAttribute('name'), foreground, background,
                            x: rect.x, right: rect.right, height: rect.height, contrast: (hi + .05) / (lo + .05) };
                    });
                });
                for (const control of results) {
                    const details = JSON.stringify({ order, mode, ...control });
                    assert.ok(control.contrast >= 4.5, details);
                    assert.ok(control.x >= 0 && control.right <= 1440 && control.height >= 20, details);
                }
                assert.equal(await page.locator('input[type=password]').count(), 3);
                assert.equal(await page.locator('form').evaluate((form) => form.checkValidity()), true);
            }
        }
    } finally { await browser.close(); }
});
