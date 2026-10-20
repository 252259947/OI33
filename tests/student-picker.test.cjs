const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function compile(file, require) {
    const module = { exports: {} };
    const js = transformSync(source(file), { loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    vm.runInNewContext(js, { module, exports: module.exports, require, console, Set, Map, Number, Date, Error, RegExp });
    return module.exports;
}
function harness() {
    const users = [1, 2, 3, 4, 5, 6, 7].map((_id) => ({ _id, uname: `user${_id}`, role: _id === 2 ? 'coach' : 'default' }));
    const enrolled = users.map((u) => ({ _id: u._id, domainId: u._id === 7 ? 'foreign' : 'school',
        realName: u._id === 1 ? '王[同学]' : '王同学', accountType: u._id === 3 ? 'temporary' : 'regular', enabled: u._id !== 4 }));
    const matches = (doc, query) => Object.entries(query).every(([key, value]) =>
        value instanceof RegExp ? value.test(doc[key] || '') : value && typeof value === 'object' && '$in' in value ? value.$in.includes(doc[key]) : doc[key] === value);
    const cursor = (rows, query) => {
        let limit = Infinity;
        return { project() { return this; }, limit(n) { limit = n; return this; }, toArray: async () => rows.filter((doc) => matches(doc, query)).slice(0, limit) };
    };
    const identities = [{ _id: 5, realname_flag: 2 }];
    const ForbiddenError = class extends Error {};
    const model = {
        getHomeworkRoster: async () => ({ entries: [{ uid: 1 }, { uid: 4 }, { uid: 6, exemptAt: new Date() }] }),
        listClassGroups: async () => [{ name: 'A', uids: [1, 3, 4] }],
        getTeachingStudentScope: async (domain, ids) => ({ inDomain: ids.filter((id) => id !== 7),
            eligible: ids.filter((id) => ![3, 7].includes(id)) }),
    };
    const roles = { isEducationCoach: (user) => user.role === 'coach', isEducationAdmin: (user) => user.admin,
        assertEducationCoach: (user) => { if (user.role !== 'coach') throw new ForbiddenError(); } };
    const handler = compile('handler/student-picker.ts', (name) => {
        if (name === 'hydrooj') return {
            Handler: class {}, ForbiddenError, ValidationError: Error, param: () => () => {}, Types: {}, PRIV: {}, PERM: {},
            DomainModel: { collUser: { find: (q) => cursor(users.map((u) => ({ uid: u._id, domainId: u._id === 7 ? 'foreign' : 'school', join: true })), q) } },
            UserModel: { coll: { find: (q) => cursor(users, q) }, getList: async (_, ids) => Object.fromEntries(users.filter((u) => ids.includes(u._id)).map((u) => [u._id, u])) },
            ContestModel: { get: async (domain) => { assert.equal(domain, 'school'); return { rule: 'homework', assign: ['A'] }; } },
        };
        if (name.endsWith('education-auth')) return roles;
        if (name.endsWith('education-policy')) return { uniqueStudentIds: (ids) => [...new Set(ids)].sort((a, b) => a - b) };
        if (name === '../model/education') return model;
        if (name.endsWith('enrollment')) return { enrollmentColl: { find: (q) => cursor(enrolled, q) } };
        if (name.endsWith('user')) return { userColl: { find: (q) => cursor(identities, q) } };
        if (name === './education') return { rosterNames: async (_, ids) => Object.fromEntries(ids.map((id) => [id, enrolled.find((e) => e._id === id)?.realName || `UID ${id}`])) };
        throw Error(name);
    });
    return { ...handler, ForbiddenError };
}
test('name search is domain scoped, excludes inactive/temporary/teacher/admin accounts and projects identity only', async () => {
    const h = harness();
    const data = await h.findTeachingStudents('school', '王');
    assert.deepEqual(Array.from(data.students, (s) => s.uid).sort(), [1, 6]);
    assert.deepEqual(Object.keys(data.students[0]).sort(), ['name', 'uid', 'username']);
    assert.deepEqual(Array.from((await h.findTeachingStudents('school', '[')).students, (s) => s.uid), [1], 'Literal regex characters');
    assert.equal((await h.findTeachingStudents('school', '.*')).students.length, 0);
    assert.equal((await h.findTeachingStudents('school', '', [])).students.length, 0);
    assert.deepEqual(Array.from((await h.findTeachingStudents('school', '', [4], true)).students, (s) => s.uid), [4], 'A disabled historical student can still be exempted');
});
test('student lookup checks teaching role, trusted domain and homework management permission', async () => {
    const h = harness();
    const handler = new h.EducationStudentsHandler();
    Object.assign(handler, { domain: { _id: 'school' }, args: {}, response: { addHeader() {} }, user: { role: 'default' } });
    await assert.rejects(handler.prepare(), h.ForbiddenError);
    handler.user = { role: 'coach', own: () => false };
    handler.args.domainId = 'foreign';
    await assert.rejects(handler.prepare(), h.ForbiddenError);
    handler.args = {};
    await handler.prepare();
    await assert.rejects(handler.get('school', '', 'id', 'add'), h.ForbiddenError);
    handler.user.own = () => true;
    handler.checkPerm = () => {};
    await handler.get('untrusted', '王', 'id', 'add');
    assert.deepEqual(Array.from(handler.response.body.students, (s) => s.uid), [1]);
    await handler.get('school', '', 'id', 'exempt');
    assert.deepEqual(Array.from(handler.response.body.students, (s) => s.uid).sort(), [1, 4]);
    await assert.rejects(handler.get('school', 'a'.repeat(81)));
    await assert.rejects(handler.get('school', '', undefined, 'exempt'));
});
class Loader extends nunjucks.Loader {
    getSource(name) { return { src: name === 'layout/basic.html' ? '{% block content %}{% endblock %}' : source(`templates/${name}`), path: name }; }
}
function html() {
    const env = new nunjucks.Environment(new Loader(), { autoescape: true });
    env.addGlobal('url', () => '/oi33/education/students');
    return env.render('oi33_education_classes.html', { csrfToken: 'fixture-token', groups: [{ name: 'A', uids: [17, 18] }],
        names: { 17: '王同学', 18: '<script>bad()</script>' } });
}
test('class picker keeps protected POST and UID fallback with escaped names and unchanged roster semantics', () => {
    const rendered = html();
    assert.equal((rendered.match(/name="csrfToken" value="fixture-token"/g) || []).length, 2);
    assert.match(rendered, /name="uids"[^>]*>17, 18/);
    assert.match(rendered, /已发布作业的应交名单不自动重算/);
    assert.doesNotMatch(rendered, /<script>bad/);
    assert.match(rendered, /data-student-seed/);
});
test('UID fallback accepts separated positive integer lists and rejects malformed or excessive input', () => {
    const { parseStudentIds } = compile('frontend/student-picker.page.ts', (name) => {
        if (name === '@hydrooj/ui-default') return { addPage() {}, NamedPage: class {} };
        if (name.endsWith('.css')) return {};
        throw new Error(name);
    });
    assert.deepEqual(Array.from(parseStudentIds('')), []);
    assert.deepEqual(Array.from(parseStudentIds('18，20 20\n0017,18')), [17, 18, 20]);
    for (const value of ['0', '-1', '1.5', '12a', '1e3', '9007199254740993', Array(5001).fill('1').join(',')]) {
        assert.throws(() => parseStudentIds(value), /有效的学生 UID/);
    }
});
test('real Chrome name picker handles multiselect, removal, UID fallback, stale results and confirmations in both themes',
    { skip: !process.env.OI33_LAYOUT_TEST }, async () => {
        const { chromium } = require('playwright');
        const bundle = buildSync({ stdin: { contents: source('frontend/student-picker.page.ts').replace(/^import.*$/gm, ''), loader: 'ts' }, bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('http://fixture.test/**', async (route) => {
                const url = new URL(route.request().url());
                if (url.pathname.includes('/students')) {
                    if (url.searchParams.get('q') === 'slow') await new Promise((r) => setTimeout(r, 500));
                    const students = url.searchParams.get('q') === 'slow' ? [{ uid: 99, name: '旧请求', username: 'slow' }]
                        : url.searchParams.get('mode') === 'exempt' ? [{ uid: 4, name: '历史学生', username: 'old' }]
                            : [{ uid: 19, name: '王同学', username: 'wang2026' }, { uid: 20, name: '王同学', username: 'wang2027' }];
                    await route.fulfill({ json: { students, more: false } });
                } else {
                    const env = new nunjucks.Environment(new Loader(), { autoescape: true });
                    env.addGlobal('url', () => '/oi33/education/students');
                    const homework = '<form id="homework-picker"><select name="mode"><option value="sync">同步</option><option value="add">补发</option><option value="exempt">免除</option></select>'
                        + env.render('partials/education_student_picker.html', { pickerTid: 'fixture-homework', pickerUids: [], names: {} }) + '</form>';
                    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"></head><body><style>${source('frontend/student-picker.css')}</style>${html()}${homework}<script>function addPage(p){p.fn()} class NamedPage{constructor(n,fn){this.fn=fn}}</script></body></html>` });
                }
            });
            await page.goto('http://fixture.test/classes');
            await page.addScriptTag({ content: bundle });
            assert.deepEqual(errors, []);
            const picker = page.locator('[data-student-picker]').nth(1);
            await page.getByText('编辑班型成员', { exact: true }).click();
            assert.equal(await picker.locator('[data-student-selected] button').count(), 2);
            await picker.locator('[data-student-search]').fill('王');
            const firstMatch = picker.locator('[data-student-results] label').filter({ hasText: 'UID 19' });
            const sameName = picker.locator('[data-student-results] label').filter({ hasText: 'UID 20' });
            await firstMatch.locator('input').check();
            assert.equal(await picker.locator('[name="uids"]').inputValue(), '17, 18, 19');
            await sameName.locator('input').check();
            assert.equal(await picker.locator('[name="uids"]').inputValue(), '17, 18, 19, 20', 'Same names remain independently selectable by UID');
            await sameName.locator('input').uncheck();
            await picker.locator('[data-student-selected] button').filter({ hasText: 'UID 17' }).click();
            assert.equal(await picker.locator('[name="uids"]').inputValue(), '18, 19');
            await picker.locator('[data-student-search]').fill('slow');
            await page.waitForTimeout(250);
            await picker.locator('[data-student-search]').fill('王');
            await page.waitForTimeout(650);
            assert.ok(!(await picker.locator('[data-student-results]').innerText()).includes('99'));
            await picker.locator('summary').click();
            await picker.locator('[name="uids"]').fill('18，20 20');
            assert.equal(await picker.locator('[data-student-selected] button').count(), 2);
            let confirmText = '';
            page.once('dialog', async (dialog) => { confirmText = dialog.message(); await dialog.dismiss(); });
            await picker.locator('xpath=..').getByRole('button', { name: '保存成员' }).click();
            assert.match(confirmText, /新增 1 人/); assert.match(confirmText, /移除 1 人/);
            const homework = page.locator('#homework-picker');
            assert.equal(await homework.locator('[data-student-picker]').isVisible(), false);
            await homework.locator('[name="mode"]').selectOption('add');
            await homework.locator('[data-student-search]').fill('slow');
            await page.waitForTimeout(250);
            await homework.locator('[name="mode"]').selectOption('exempt');
            await homework.locator('[data-student-search]').fill('王');
            await homework.locator('[data-student-results] input').check();
            await page.waitForTimeout(600);
            assert.equal(await homework.locator('[name="uids"]').inputValue(), '4');
            assert.doesNotMatch(await homework.locator('[data-student-results]').innerText(), /UID 99|UID 19/);
            await homework.locator('[name="mode"]').selectOption('sync');
            assert.equal(await homework.locator('[name="uids"]').inputValue(), '');
            assert.equal(await homework.locator('[data-student-picker]').isVisible(), false);
            if (process.env.OI33_PICKER_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.OI33_PICKER_SCREENSHOT_DIR, { recursive: true });
                await picker.screenshot({ path: path.join(process.env.OI33_PICKER_SCREENSHOT_DIR, 'student-picker-light.png') });
            }
            await page.evaluate(() => document.documentElement.style.cssText = '--oi33-surface:#1a1f2d;--oi33-text:#eef1f8;--oi33-text-2:#b8c1d3;--oi33-brand-soft:#292b55');
            const colors = await picker.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el.querySelector('button')).color }));
            assert.equal(colors.bg, 'rgb(26, 31, 45)'); assert.equal(colors.fg, 'rgb(238, 241, 248)');
            assert.equal(await page.locator('script').count(), 2, 'Escaped name cannot inject scripts');
            if (process.env.OI33_PICKER_SCREENSHOT_DIR) await picker.screenshot({
                path: path.join(process.env.OI33_PICKER_SCREENSHOT_DIR, 'student-picker-dark.png'),
            });
        } finally { await browser.close(); }
    });
