const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

function harness() {
    const calls = [];
    class ForbiddenError extends Error {}
    const decorator = (_target, _key, descriptor) => descriptor;
    const dependencies = {
        hydrooj: { Handler: class {}, PRIV: {}, Types: {}, param: () => decorator, requireSudo: decorator,
            ForbiddenError, ValidationError: Error, db: { collection: () => ({}) } },
        '../model/education-auth': {}, '../model/user': {},
        '../model/enrollment': { getEnrollment: async () => { calls.push('enrollment'); return null; } },
        '../model/enrollment-policy': {}, './enrollment-name-review': {},
        '../model/account-password': { isAccountAdmin: () => true },
    };
    const source = fs.readFileSync(path.join(__dirname, '../handler/enrollment.ts'), 'utf8');
    const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
        return dependencies[name];
    });
    const request = (headers = {}, name = 'Oi33EnrollmentReview', origin = 'https://oj.fixture.invalid') => ({
        constructor: { name: `${name}Handler` }, request: { method: 'post', headers, host: 'ignored.invalid' },
        context: { request: { protocol: new URL(origin).protocol.slice(0, -1), host: new URL(origin).host,
            origin: headers.origin } }, user: { _id: 0 }, args: { operation: 'change_password' },
        response: { addHeader: () => {} }, session: {},
    });
    return { api: module.exports, request, calls, ForbiddenError };
}

test('account mutation source check accepts only genuine same-origin browser submissions', () => {
    const h = harness();
    for (const headers of [
        { origin: 'https://oj.fixture.invalid' },
        { referer: 'https://oj.fixture.invalid/oi33/enrollment/review?name=student' },
        { origin: 'https://oj.fixture.invalid', referer: 'https://oj.fixture.invalid/sudo' },
        { origin: 'https://oj.fixture.invalid:443', 'sec-fetch-site': 'same-origin' },
        { origin: '', referer: 'https://oj.fixture.invalid/home/security', 'sec-fetch-site': 'none' },
    ]) assert.doesNotThrow(() => h.api.requireAccountMutationOrigin(h.request(headers)), JSON.stringify(headers));
    assert.doesNotThrow(() => h.api.requireAccountMutationOrigin(h.request({ origin: 'http://127.0.0.1:8899' },
        'HomeSecurity', 'http://127.0.0.1:8899')), 'Isolated HTTP keeps its exact scheme and port');
});

test('missing, null, malformed, cross-site, scheme/port and conflicting origin headers fail closed', () => {
    const h = harness();
    for (const headers of [
        {}, { origin: '', referer: '' }, { origin: 'null' }, { origin: 'not-a-url' },
        { origin: null }, { origin: ['https://oj.fixture.invalid'] },
        { origin: 'https://foreign.invalid', referer: '' },
        { origin: 'https://foreign.invalid', referer: 'https://oj.fixture.invalid/' },
        { origin: 'https://oj.fixture.invalid', referer: 'https://foreign.invalid/' },
        { referer: 'https://oj.fixture.invalid.foreign.invalid/' },
        { origin: 'http://oj.fixture.invalid' }, { origin: 'https://oj.fixture.invalid:444' },
        { origin: 'https://oj.fixture.invalid https://foreign.invalid' },
        { origin: 'https://oj.fixture.invalid/path' }, { origin: 'https://oj.fixture.invalid/?query=1' },
        { origin: 'https://oj.fixture.invalid/#hash' }, { origin: 'https://user@oj.fixture.invalid' },
        { origin: 'file://oj.fixture.invalid' }, { origin: ' https://oj.fixture.invalid' },
        { origin: 'https:oj.fixture.invalid' }, { referer: 'https://oj.fixture.invalid\\path' },
        { origin: 'https://oj.fixture.invalid', 'sec-fetch-site': 'cross-site' },
        { origin: 'https://oj.fixture.invalid', 'sec-fetch-site': ['same-origin'] },
    ]) {
        const request = h.request(headers);
        request.allowCors = true;
        request.context.cors = true;
        request.args.origin = 'https://oj.fixture.invalid';
        assert.throws(() => h.api.requireAccountMutationOrigin(request), h.ForbiddenError, JSON.stringify(headers));
    }
    const missingContext = h.request({ origin: 'https://oj.fixture.invalid' });
    delete missingContext.context.request.host;
    assert.throws(() => h.api.requireAccountMutationOrigin(missingContext), h.ForbiddenError);
});

test('real installed Koa resolves target from protocol/host, never its attacker-controlled origin getter', () => {
    const h = harness();
    const koaRequest = require('koa/lib/request');
    for (const proxy of [false, true]) {
        const headers = { origin: 'https://foreign.invalid', host: 'oj.fixture.invalid',
            'x-forwarded-proto': 'https', 'x-forwarded-host': 'oj.fixture.invalid' };
        const actual = Object.create(koaRequest);
        actual.req = { headers, socket: { encrypted: !proxy } };
        actual.app = { proxy };
        assert.equal(actual.origin, 'https://foreign.invalid', 'Koa 3 exposes the incoming header here');
        assert.equal(actual.protocol, 'https');
        assert.equal(actual.host, 'oj.fixture.invalid');
        const bad = h.request(headers); bad.context.request = actual;
        assert.throws(() => h.api.requireAccountMutationOrigin(bad), h.ForbiddenError);
        headers.origin = 'https://oj.fixture.invalid';
        assert.doesNotThrow(() => h.api.requireAccountMutationOrigin(bad));
        delete headers.origin;
        headers.referer = 'https://oj.fixture.invalid/home/security';
        assert.doesNotThrow(() => h.api.requireAccountMutationOrigin(bad));
    }
});

test('origin guard runs before account mutation lookup, sudo capture and native password wrapper', async () => {
    const h = harness();
    for (const name of ['Oi33EnrollmentReview', 'HomeSecurity']) {
        const bad = h.request({ origin: 'https://foreign.invalid' }, name);
        await assert.rejects(h.api.enforceEnrollment(bad), h.ForbiddenError);
    }
    const bad = h.request({ origin: 'https://foreign.invalid', referer: '' });
    await assert.rejects(h.api.Oi33EnrollmentReviewHandler.prototype.post.call(bad,
        'system', 45, 2, 'reset_password'), h.ForbiddenError);
    bad.postChangePassword = () => h.calls.push('native-change');
    assert.throws(() => h.api.installEnrollmentPasswordChange(bad), h.ForbiddenError);
    assert.equal(bad.__oi33PasswordChangeWrapped, undefined);
    assert.deepEqual(bad.session, {}, 'Rejected request cannot store a sudo continuation');
    assert.deepEqual(h.calls, [], 'Rejected request cannot query identity or call password operation');
});

test('source guard is scoped to account mutations and does not restrict GETs, judge HTTP or websocket dispatch', async () => {
    const h = harness();
    const read = h.request({}, 'Oi33EnrollmentReview'); read.request.method = 'get';
    await h.api.enforceEnrollment(read);
    await h.api.enforceEnrollment(h.request({}, 'JudgeFilesDownload'));
    await h.api.enforceEnrollment(h.request({}, 'RecordDetailConnection'), true);
    assert.deepEqual(h.calls, []);
});
