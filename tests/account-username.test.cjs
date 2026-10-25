const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function compile(source, dependencies = {}, globals = {}) {
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', ...Object.keys(globals), code)(module, module.exports, (name) => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`Unexpected dependency: ${name}`);
    }, ...Object.values(globals));
    return module.exports;
}
class ForbiddenError extends Error {}
class ValidationError extends Error { constructor(field, _unused, message) { super(message || field); this.field = field; } }
class NotFoundError extends Error {}
const PRIV = { PRIV_USER_PROFILE: 1 };

function harness() {
    const nativeServer = read('node_modules/hydrooj/src/service/server.ts');
    const { requireSudo } = compile(nativeServer.slice(nativeServer.indexOf('export function requireSudo'),
        nativeServer.indexOf('export class Handler')), {}, { Time: { hour: 3600000 } });
    const enrollment = read('handler/enrollment.ts');
    const { requireAccountMutationOrigin } = compile(enrollment.slice(enrollment.indexOf('export function requireAccountMutationOrigin'),
        enrollment.indexOf('function assertAccountAdmin')), {}, { ForbiddenError });
    const state = { users: new Map([[42, { _id: 42, uname: '原用户名', mail: 'parent@example.test', hash: 'unchanged-hash',
        priv: 1, realName: '实名不变' }]]), enrollment: null, events: [], writes: [], logs: [], routes: [], menus: [], failWrite: null };
    class Handler {
        constructor() {
            this.user = { _id: 42, hasPriv: (priv) => priv === 1 };
            this.args = { expectedUid: '42' };
            this.domain = { _id: 'system' };
            this.session = { sudo: Date.now() };
            this.request = { method: 'post', originalPath: '/oi33/account/username',
                headers: { origin: 'https://fixture.invalid', referer: 'https://fixture.invalid/oi33/account/username' } };
            this.context = { request: { protocol: 'https', host: 'fixture.invalid' } };
            this.headers = {};
            this.response = { addHeader: (name, value) => { this.headers[name] = value; } };
        }
        checkPriv(priv) { if (!this.user.hasPriv(priv)) throw new ForbiddenError('login required'); }
        async limitRate(...args) { state.events.push(['rate', ...args]); }
        url(name, args = {}) { return name === 'user_sudo' ? '/user/sudo' : `/oi33/account/username${args.query ? '?notification=saved' : ''}`; }
    }
    const { Oi33AccountUsernameHandler, normalizeLoginUsername, apply } = compile(read('handler/account-username.ts'), {
        hydrooj: { Handler, PRIV, Types: { String: {}, PositiveInt: {} }, UserModel: {
            coll: { async findOne(query, options) {
                state.events.push(['read', query, options]);
                const user = state.users.get(query._id);
                return user ? { _id: user._id, uname: user.uname } : null;
            } },
            async getByUname(domain, username) {
                state.events.push(['unique', domain, username]);
                return [...state.users.values()].find((user) => user.uname.toLowerCase() === username.toLowerCase()) || null;
            },
            async setUname(uid, username) {
                if (state.failWrite) throw state.failWrite;
                state.writes.push({ uid, username });
                state.users.get(uid).uname = username;
            },
        }, ForbiddenError, ValidationError, NotFoundError, requireSudo, param: () => (_target, _key, descriptor) => descriptor },
        '../model/enrollment': { getEnrollment: async () => state.enrollment },
        '../model/log': { addLog: async (log) => state.logs.push(log) },
        './enrollment': { requireAccountMutationOrigin },
    });
    apply({ Route: (...args) => state.routes.push(args), injectUI: (...args) => state.menus.push(args) });
    return { state, Handler: Oi33AccountUsernameHandler, normalizeLoginUsername };
}

test('login usernames have a memorable unambiguous format compatible with native login', () => {
    const h = harness();
    for (const value of ['Abc', 'student42', ' A_b23 ', 'A'.repeat(31)]) {
        assert.equal(h.normalizeLoginUsername(value), value.trim());
    }
    for (const value of ['', 'ab', 'a'.repeat(32), '42', '123', '_student', '9student', 'name@example.test',
        '真实姓名', 'student name', 'a-b', 'a/b', '<script>', null, { username: 'alice' }]) {
        assert.throws(() => h.normalizeLoginUsername(value), ValidationError, String(value));
    }
});

test('username page reads only the current account name and requires a signed-in self session', async () => {
    const h = harness();
    const page = new h.Handler();
    page.request.method = 'get';
    page.args.uid = 7;
    await page.prepare();
    await page.get();
    assert.equal(page.headers['Cache-Control'], 'private, no-store');
    assert.equal(page.headers.Pragma, 'no-cache');
    assert.deepEqual(page.response.body, { currentUsername: '原用户名', currentUid: 42 });
    assert.deepEqual(h.state.events[0], ['read', { _id: 42 }, { projection: { uname: 1 } }]);
    for (const uid of [0, -1, 42.5]) {
        const bad = new h.Handler(); bad.user._id = uid;
        await assert.rejects(bad.prepare(), ForbiddenError);
    }
    const impersonating = new h.Handler(); impersonating.session.sudoUid = 3;
    await assert.rejects(impersonating.prepare(), ForbiddenError);
    const anonymous = new h.Handler(); anonymous.user.hasPriv = () => false;
    await assert.rejects(anonymous.prepare(), ForbiddenError);
    assert.equal(h.state.routes[0][0], 'oi33_account_username');
    assert.equal(h.state.routes[0][1], '/oi33/account/username');
    assert.equal(h.state.routes[0][3], PRIV.PRIV_USER_PROFILE);
});

test('cross-origin or missing origin is denied before sudo can retain a pending mutation', async () => {
    for (const headers of [{}, { origin: 'https://foreign.invalid' }, { origin: 'null' },
        { origin: 'https://fixture.invalid', referer: 'https://foreign.invalid/' }]) {
        const h = harness();
        const page = new h.Handler(); page.request.headers = headers; page.session = {};
        page.args = { username: 'student42' };
        await assert.rejects(page.prepare(), ForbiddenError);
        assert.deepEqual(page.session, {});
        assert.deepEqual(h.state.events, []);
        assert.deepEqual(h.state.writes, []);
    }
});

test('native sudo defers a username mutation until recent authentication succeeds', async () => {
    const h = harness();
    const page = new h.Handler(); page.session = {}; page.args = { username: 'student42', expectedUid: '42' };
    await page.prepare();
    assert.equal(await page.post('system', 'student42'), 'cleanup');
    assert.equal(page.response.redirect, '/user/sudo');
    assert.equal(page.session.sudoArgs.redirect, '/oi33/account/username');
    assert.deepEqual(h.state.writes, []);
    assert.deepEqual(h.state.events, []);
    page.session.sudo = Date.now();
    await page.post('system', 'student42');
    assert.deepEqual(h.state.writes, [{ uid: 42, username: 'student42' }]);
    assert.equal(page.session.sudoArgs, null);
});

test('renaming writes only the authenticated username and retains password, mail, identity and UID', async () => {
    const h = harness();
    const before = { ...h.state.users.get(42) };
    const page = new h.Handler();
    page.args = { uid: 7, expectedUid: '42', mail: 'replacement@example.test', password: 'not-used', realName: 'not-used', username: 'Student_42' };
    await page.prepare();
    await page.post('forged-domain', ' Student_42 ');
    assert.deepEqual(h.state.events[0], ['rate', 'oi33_username_change', 3600, 5, '42']);
    assert.deepEqual(h.state.writes, [{ uid: 42, username: 'Student_42' }]);
    assert.deepEqual(h.state.users.get(42), { ...before, uname: 'Student_42' });
    assert.deepEqual(h.state.logs, [{ type: 'admin', action: 'change_username', sender: 42, userId: 42,
        domainId: 'system', reason: '用户自助修改登录用户名' }]);
    assert.doesNotMatch(JSON.stringify(h.state.logs), /原用户名|实名不变|replacement|not-used/);
    assert.match(page.response.redirect, /^\/oi33\/account\/username\?notification=/);
});

test('an old username form cannot rename a later logged-in account or retain sudo arguments', async () => {
    for (const expectedUid of [undefined, null, '7', 7, '', '042', ['42'], '42.0']) {
        const h = harness(); const page = new h.Handler(); page.session = {};
        page.args = { username: 'student42', expectedUid };
        await assert.rejects(page.prepare(), /登录账号已改变/);
        assert.deepEqual(page.session, {});
        assert.deepEqual(h.state.writes, []);
        assert.deepEqual(h.state.events, []);
    }
    const h = harness(); const page = new h.Handler();
    await page.prepare();
    page.user._id = 7;
    await assert.rejects(page.post('system', 'student42'), /登录账号已改变/);
    assert.deepEqual(h.state.writes, []);
});

test('case-insensitive duplicates and a concurrent unique-index conflict both fail without a success log', async () => {
    const h = harness(); h.state.users.set(7, { _id: 7, uname: 'Student_42' });
    const page = new h.Handler(); await page.prepare();
    await assert.rejects(page.post('system', 'student_42'), /已被使用/);
    assert.deepEqual(h.state.writes, []);
    h.state.users.delete(7);
    h.state.failWrite = Object.assign(new Error('duplicate key'), { code: 11000 });
    await assert.rejects(page.post('system', 'student_42'), /已被使用/);
    assert.equal(h.state.users.get(42).uname, '原用户名');
    assert.deepEqual(h.state.logs, []);
    h.state.failWrite = new Error('database unavailable');
    await assert.rejects(page.post('system', 'student_42'), /database unavailable/);
});

test('unchanged usernames are idempotent and inactive or temporary accounts cannot rename', async () => {
    const h = harness(); h.state.users.get(42).uname = 'student42';
    const page = new h.Handler(); await page.prepare(); await page.post('system', 'student42');
    assert.deepEqual(h.state.writes, []); assert.deepEqual(h.state.logs, []);
    for (const enrollment of [{ enabled: false, accountType: 'regular' }, { enabled: true, accountType: 'temporary' }]) {
        h.state.enrollment = enrollment;
        await assert.rejects(new h.Handler().prepare(), ForbiddenError);
    }
    h.state.enrollment = { enabled: true, accountType: 'regular', status: 'pending' };
    await new h.Handler().prepare();
});

test('own username maintenance is available before review but never bypasses forced password change', () => {
    const { decideEnrollmentAccess } = compile(read('model/enrollment-policy.ts'));
    const c = { uid: 42, domainId: 'system', handler: 'Oi33AccountUsername', method: 'post' };
    assert.equal(decideEnrollmentAccess(null, c).allowed, true);
    const account = { status: 'pending', accountType: 'regular', enabled: true, contestScopes: [] };
    assert.equal(decideEnrollmentAccess(account, c).allowed, true);
    assert.equal(decideEnrollmentAccess({ ...account, requiresPasswordChange: true }, c).allowed, false);
});

test('username form separates public login identity from real name and escapes the current name', () => {
    class Loader extends nunjucks.Loader {
        getSource(name) { return { src: name === 'layout/home_base.html' ? '{% block home_content %}{% endblock %}'
            : read(`templates/${name}`), path: name }; }
    }
    const env = new nunjucks.Environment(new Loader(), { autoescape: true });
    env.addGlobal('url', (name) => { assert.equal(name, 'oi33_account_username'); return '/oi33/account/username'; });
    const html = env.render('oi33_account_username.html', { currentUsername: '<script>unsafe</script>', currentUid: 42,
        handler: { csrfToken: 'csrf-fixture' } });
    assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /用户名用于登录和公开显示，不是实名认证姓名/);
    assert.match(html, /name="csrfToken" value="csrf-fixture"/);
    assert.match(html, /name="expectedUid" value="42"/);
    assert.match(html, /method="post" action="\/oi33\/account\/username"/);
    assert.match(html, /name="username" required minlength="3" maxlength="31"/);
    assert.doesNotMatch(html, /name="(?:uid|mail|password|realName)"/);
    assert.match(read('templates/components/home.html'), /'oi33_account_username', label='登录用户名'/);
});
