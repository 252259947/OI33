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
    if (name === 'user_detail') {
        assert.deepEqual(Object.keys(args).filter((key) => key !== '__keywords'), ['uid'], 'Profile URLs contain only the stable UID');
        assert.ok(Number.isSafeInteger(args.uid) && args.uid > 0);
        return `/user/${args.uid}`;
    }
    assert.equal(name, 'oi33_enrollment_review');
    const query = new URLSearchParams(args.query || {}).toString();
    return route + (query ? `?${query}` : '');
});
env.addGlobal('datetimeSpan', () => '<span>2026-10-08</span>');
function render(context = {}) {
    return env.render('oi33_enrollment_review.html', { handler: { csrfToken: 'csrf-test', user: { _id: 2 } },
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

test('review card names link to the corresponding user profile without putting real names in URLs', () => {
    const entries = [
        { _id: 46, realName: '测试学生甲', revision: 2 },
        { _id: 45, realName: '张" & <script>window.profileInjected=1</script>', revision: 9 },
    ].map((entry) => ({ ...entry, status: 'approved', accountType: 'regular', enabled: true, history: [] }));
    const html = render({ enrollments: entries, passwordResetAllowedUids: [45, 46] });
    const links = [...html.matchAll(/<a\b(?=[^>]*class="[^"]*\boi33-enrollment__profile-link\b)[^>]*>([\s\S]*?)<\/a>/g)];
    const cards = [...html.matchAll(/<section class="section">[\s\S]*?<\/section>/g)]
        .map((match) => match[0]).filter((card) => card.includes('<h2'));
    assert.equal(links.length, entries.length);
    assert.equal(cards.length, entries.length);
    for (const [index, link] of links.entries()) {
        const entry = entries[index];
        assert.match(link[0], new RegExp(`href="/user/${entry._id}"`));
        assert.match(link[0], /title="查看个人主页"/);
        assert.doesNotMatch(link[0], /target=|onclick=|tabindex="-1"|role="button"/);
        assert.match(cards[index], new RegExp(`href="/user/${entry._id}"`), 'Name points to its own card UID');
        assert.match(cards[index], new RegExp(`UID ${entry._id}</span>`));
    }
    assert.equal(links[0][1], entries[0].realName);
    assert.ok(links[1][1].includes('&quot;') && links[1][1].includes('&amp;') && links[1][1].includes('&lt;script&gt;'));
    assert.doesNotMatch(html, /<script>window\.profileInjected/);
    const postForms = [...html.matchAll(/<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/g)];
    assert.equal(postForms.length, 4, 'Both account-action forms stay independent per student');
    for (const [index, entry] of entries.entries()) {
        for (const post of postForms.slice(index * 2, index * 2 + 2)) {
            assert.match(post[0], /name="csrfToken" value="csrf-test"/);
            assert.match(post[0], new RegExp(`name="uid" value="${entry._id}"`));
            assert.match(post[0], new RegExp(`name="revision" value="${entry.revision}"`));
            assert.doesNotMatch(post[0], /oi33-enrollment__profile-link/);
        }
    }
    const unnamed = render({ enrollments: [{ _id: 47, realName: '', status: 'pending', enabled: true, revision: 1, history: [] }] });
    assert.match(unnamed, /href="\/user\/47"[^>]*>查看个人主页<\/a>/, 'Missing names retain a usable profile link');
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

test('account action row keeps independent protected forms and moves reset guidance into the button tooltip', () => {
    const hint = '重置为 123456，下次登录必须修改。';
    for (const variant of [
        { status: 'approved', enabled: true, accountType: 'regular', reset: true, action: 'disable' },
        { status: 'pending', enabled: true, accountType: 'regular', reset: true, action: 'disable' },
        { status: 'approved', enabled: false, accountType: 'regular', reset: false, action: 'enable' },
        { status: 'approved', enabled: true, accountType: 'temporary', reset: false, action: 'disable' },
    ]) {
        const html = render({ enrollments: [{ _id: 45, realName: '测试学生', revision: 9, history: [], ...variant }],
            passwordResetAllowedUids: variant.reset ? [45] : [] });
        const row = html.match(/<div class="oi33-enrollment__account-actions">([\s\S]*?)<\/div>/)?.[1];
        assert.ok(row, JSON.stringify(variant));
        const forms = [...row.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]);
        assert.equal(forms.length, variant.reset ? 2 : 1);
        for (const renderedForm of forms) {
            assert.equal((renderedForm.match(/<form\b/g) || []).length, 1, 'No nested forms');
            assert.match(renderedForm, /method="post"/);
            for (const [name, value] of [['csrfToken', 'csrf-test'], ['uid', '45'], ['revision', '9']]) {
                assert.match(renderedForm, new RegExp(`type="hidden" name="${name}" value="${value}"`));
            }
        }
        assert.match(forms[0], new RegExp(`name="action" value="${variant.action}"`));
        assert.doesNotMatch(forms[0], /data-enrollment-password-reset|reset_password/);
        assert.equal(/value="convert"/.test(forms[0]), variant.accountType === 'temporary');
        if (variant.reset) {
            assert.match(forms[1], /data-enrollment-password-reset/);
            assert.match(forms[1], new RegExp(`<button[^>]*title="${hint}"[^>]*>重置密码<\/button>`));
            assert.doesNotMatch(forms[1], /<span\b/);
        }
        assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), new RegExp(hint), 'Hint is not persistent page text');
        assert.doesNotMatch(row, /oi33-enrollment__review-form/, 'Pending-review form remains separate from account actions');
    }
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
        assert.deepEqual(Object.fromEntries(posted[0]), { returnStatus: '', returnName: '', returnPage: '1', csrfToken: 'csrf-test', uid: '45', revision: '9', action: 'reset_password' });
        assert.equal(new URL(page.url()).search, '', 'never submit forged query uid/revision');
        await page.evaluate(() => { window.confirmCalls = []; window.confirm = (message) => { window.confirmCalls.push(message); return false; }; });
        await page.locator('.oi33-enrollment__account-actions button[name=action][value=disable]').click();
        assert.equal(posted.length, 1, 'Canceling disable must not send a request');
        assert.match(await page.evaluate(() => window.confirmCalls[0]), /停用.*测试学生.*UID 45/);
        assert.doesNotMatch(await page.evaluate(() => window.confirmCalls[0]), /123456/);
        await page.evaluate(() => { window.confirm = () => true; });
        await Promise.all([page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
            page.locator('.oi33-enrollment__account-actions button[name=action][value=disable]').click()]);
        await page.waitForLoadState('load');
        assert.equal(posted.length, 2);
        assert.deepEqual(Object.fromEntries(posted[1]), { returnStatus: '', returnName: '', returnPage: '1', csrfToken: 'csrf-test', uid: '45', revision: '9', action: 'disable' });
    } finally { await browser.close(); }
});

if (process.env.OI33_LAYOUT_TEST === '1') test('account POST keeps active filters, page and scroll location after its success redirect', async () => {
    const { chromium } = require('playwright');
    const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/enrollment-review.page.ts')], bundle: true,
        write: false, format: 'iife', globalName: 'ReviewFilters', external: ['@hydrooj/ui-default'] }).outputFiles[0].text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let posted;
    const server = require('node:http').createServer(async (request, response) => {
        if (request.method === 'POST') {
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            posted = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
            const query = new URLSearchParams({ status: posted.returnStatus, name: posted.returnName, page: posted.returnPage });
            response.writeHead(302, { location: `${route}?${query}` }); response.end(); return;
        }
        const html = render({ filterStatus: 'approved', filterName: '学生', page: 2, pages: 3, total: 80,
            actionNotice: posted ? '学生 12（UID 112）：停用账号成功。' : '',
            enrollments: Array.from({ length: 30 }, (_, i) => ({ _id: 100 + i, realName: `学生 ${i}`, revision: 2,
                status: 'approved', enabled: true, accountType: 'regular', history: [] })) });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><style>.section{min-height:320px;margin:24px}.section__body{padding:20px}</style>'
            + html + '<script>window.require=()=>({NamedPage:function(){},addPage(){}});window.confirm=()=>true;</script>'
            + `<script>${bundle}</script><script>ReviewFilters.installEnrollmentReviewFilters();</script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${server.address().port}${route}?status=approved&name=${encodeURIComponent('学生')}&page=2`);
        const action = page.locator('button[name=action][value=disable]').nth(12);
        await action.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => scrollY);
        assert.ok(before > 1000);
        await Promise.all([page.waitForURL((url) => url.pathname === route && url.searchParams.get('status') === 'approved'
            && url.searchParams.get('page') === '2', { waitUntil: 'load' }), action.click()]);
        await page.waitForSelector('[data-enrollment-action-success]', { timeout: 5000 }).catch(async () => {
            assert.fail(JSON.stringify({ posted, url: page.url(), body: (await page.locator('body').innerText()).slice(0, 600) }));
        });
        await page.waitForFunction((y) => Math.abs(scrollY - y) < 2, before);
        assert.equal(new URL(page.url()).searchParams.get('name'), '学生');
        assert.equal(posted.returnPage, '2');
        assert.equal(posted.uid, '112');
        assert.equal(posted.returnStatus, 'approved');
        assert.match(await page.locator('[data-enrollment-action-success]').innerText(), /停用账号成功/);
    } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
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

if (process.env.OI33_LAYOUT_TEST === '1') test('desktop profile names remain legible and navigate by mouse and keyboard in both themes and CSS orders', async () => {
    const { chromium } = require('playwright');
    const theme = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
    const custom = ['frontend/oi33-design-system.css', 'frontend/enrollment.css']
        .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const fixture = render({ enrollments: [
        { _id: 46, realName: '测试学生甲', revision: 2 },
        { _id: 45, realName: '张" & <script>window.profileInjected=1</script>', revision: 9 },
    ].map((entry) => ({ ...entry, status: 'approved', accountType: 'regular', enabled: true, history: [] })),
    passwordResetAllowedUids: [45, 46] });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const navigations = [];
    try {
        const page = await browser.newPage();
        let documentHtml = '';
        await page.route('http://oi33-profile.test/**', async (request) => {
            const req = request.request(), url = new URL(req.url());
            if (req.isNavigationRequest()) navigations.push({ pathname: url.pathname, search: url.search, method: req.method() });
            await request.fulfill({ contentType: 'text/html; charset=utf-8', body: url.pathname === route
                ? documentHtml : '<!doctype html><title>Profile</title><h1>个人主页</h1>' });
        });
        const inspectLink = async (link) => link.evaluate((element) => {
            const parse = (color) => color.match(/[\d.]+/g).map(Number);
            const backgroundOf = (start) => {
                const result = [0, 0, 0]; let remaining = 1;
                for (let node = start; node && remaining > 0; node = node.parentElement) {
                    const color = parse(getComputedStyle(node).backgroundColor), alpha = color[3] ?? 1;
                    for (let i = 0; i < 3; i++) result[i] += color[i] * alpha * remaining;
                    remaining *= 1 - alpha;
                }
                return result.map((value) => value + 255 * remaining);
            };
            const luminance = (color) => color.slice(0, 3).map((v) => v / 255)
                .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            const foreground = parse(style.webkitTextFillColor || style.color), background = backgroundOf(element);
            const [lo, hi] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
            return { foreground, background, sectionBackground: getComputedStyle(element.closest('.section')).backgroundColor,
                headerBackground: getComputedStyle(element.closest('.section__header')).backgroundColor,
                contrast: (hi + .05) / (lo + .05), x: rect.x, right: rect.right, height: rect.height,
                display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
                decoration: style.textDecorationLine, outline: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle,
                tabindex: element.tabIndex, focused: document.activeElement === element, focusVisible: element.matches(':focus-visible') };
        });
        for (const [order, sheet] of [['core-first', theme + custom], ['core-last', custom + theme]]) {
            for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
                for (const width of [1024, 1440]) {
                    await page.setViewportSize({ width, height: 980 });
                    documentHtml = `<!doctype html><html ${mode}><head><meta charset="utf-8"><style>${sheet}</style></head><body><main class="main">${fixture}</main></body></html>`;
                    await page.goto(`http://oi33-profile.test${route}`);
                    const links = page.locator('a.oi33-enrollment__profile-link');
                    assert.equal(await links.count(), 2);
                    assert.equal(await page.evaluate(() => window.profileInjected), undefined);
                    for (let index = 0; index < 2; index++) {
                        const link = links.nth(index);
                        const normal = await inspectLink(link);
                        const details = JSON.stringify({ order, mode, width, index, normal });
                        assert.ok(normal.contrast >= 4.5, `Normal text contrast: ${details}`);
                        assert.ok(normal.height >= 20 && normal.x >= 0 && normal.right <= width + 1, `Profile text stays in viewport: ${details}`);
                        assert.equal(normal.tabindex, 0, details);
                        assert.notEqual(normal.display, 'none', details);
                        assert.equal(normal.visibility, 'visible', details);
                        assert.notEqual(normal.pointerEvents, 'none', details);
                    }
                    await links.first().hover();
                    const hovered = await inspectLink(links.first());
                    assert.ok(hovered.contrast >= 4.5, JSON.stringify({ order, mode, width, hovered }));
                    assert.ok(hovered.decoration.includes('underline'), 'Hover identifies the name as a link');
                    await Promise.all([page.waitForURL('http://oi33-profile.test/user/46'), links.first().click()]);
                    assert.equal(page.context().pages().length, 1, 'Profile opens in the same tab');

                    // Reach the second student's link through the normal keyboard focus order.
                    await page.goto(`http://oi33-profile.test${route}`);
                    await page.locator('input[name=name]').focus();
                    const second = page.locator('a.oi33-enrollment__profile-link').nth(1);
                    let focused = false;
                    for (let attempt = 0; attempt < 16; attempt++) {
                        await page.keyboard.press('Tab');
                        focused = await second.evaluate((element) => document.activeElement === element);
                        if (focused) break;
                    }
                    assert.equal(focused, true, 'Second profile link is reachable with Tab');
                    const keyboard = await inspectLink(second);
                    const details = JSON.stringify({ order, mode, width, keyboard });
                    assert.ok(keyboard.focusVisible && keyboard.outline >= 2 && keyboard.outlineStyle !== 'none', `Visible keyboard focus: ${details}`);
                    assert.ok(keyboard.contrast >= 4.5 && keyboard.decoration.includes('underline'), `Readable focused name: ${details}`);
                    await Promise.all([page.waitForURL('http://oi33-profile.test/user/45'), page.keyboard.press('Enter')]);
                }
            }
        }
        const profiles = navigations.filter((item) => item.pathname.startsWith('/user/'));
        assert.equal(profiles.length, 24, 'Each desktop theme/order variant navigates both profiles');
        assert.ok(navigations.every((item) => item.method === 'GET' && item.search === ''), 'Profile clicks never submit an account mutation or include real names');
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

if (process.env.OI33_LAYOUT_TEST === '1') test('desktop account buttons share one aligned row with hover-only guidance in both themes and CSS orders', async () => {
    const { chromium } = require('playwright');
    const theme = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
    const custom = ['frontend/oi33-design-system.css', 'frontend/enrollment.css']
        .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const hint = '重置为 123456，下次登录必须修改。';
    const fixture = render({ enrollments: [{ _id: 45, realName: '测试学生', revision: 9, status: 'approved',
        enabled: true, accountType: 'regular', history: [] }], passwordResetAllowedUids: [45] });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        for (const [order, sheet] of [['core-first', theme + custom], ['core-last', custom + theme]]) {
            for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
                for (const width of [1024, 1440]) {
                    await page.setViewportSize({ width, height: 980 });
                    await page.setContent(`<!doctype html><html ${mode}><head><meta charset="utf-8"><style>${sheet}</style></head><body><main class="main">${fixture}</main></body></html>`);
                    const reset = page.locator('[data-enrollment-password-reset] button');
                    assert.equal(await reset.getAttribute('title'), hint);
                    assert.equal((await page.innerText('body')).includes(hint), false);
                    await reset.hover();
                    assert.equal(await reset.getAttribute('title'), hint, 'Native hover tooltip retains the reset explanation');
                    const result = await page.locator('.oi33-enrollment__account-actions').evaluate((row) => {
                        const rectangle = (element) => {
                            const { x, y, right, height } = element.getBoundingClientRect();
                            const style = getComputedStyle(element);
                            return { x, y, right, height, borderTop: parseFloat(style.borderTopWidth), paddingTop: parseFloat(style.paddingTop) };
                        };
                        return { display: getComputedStyle(row).display,
                            buttons: [...row.querySelectorAll('button')].map(rectangle),
                            forms: [...row.children].map(rectangle), scrollWidth: document.documentElement.scrollWidth };
                    });
                    const details = JSON.stringify({ order, mode, width, ...result });
                    assert.equal(result.display, 'flex', details);
                    assert.equal(result.buttons.length, 2, details);
                    assert.equal(result.forms.length, 2, details);
                    const [disable, resetRect] = result.buttons;
                    assert.ok(Math.abs(disable.y - resetRect.y) < 1, `Same button row: ${details}`);
                    assert.ok(Math.abs(disable.height - resetRect.height) < 1, `Matching heights: ${details}`);
                    assert.ok(Math.abs(resetRect.x - disable.right - 12) < 1, `Consistent 12px gap: ${details}`);
                    for (const button of result.buttons) {
                        assert.ok(button.height >= 42 && button.x >= 0 && button.right <= width, `Visible desktop buttons: ${details}`);
                    }
                    for (const renderedForm of result.forms) {
                        assert.equal(renderedForm.borderTop, 0, `No action divider: ${details}`);
                        assert.equal(renderedForm.paddingTop, 0, `No extra reset top padding: ${details}`);
                    }
                    assert.ok(result.scrollWidth <= width + 1, `No horizontal overflow: ${details}`);
                }
            }
        }
    } finally { await browser.close(); }
});
