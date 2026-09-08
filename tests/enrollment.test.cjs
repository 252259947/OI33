const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
function loadTs(relative, dependencies = {}) {
    const code = esbuild.transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node18', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code;
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, (name) => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`Unexpected import ${relative}: ${name}`);
    });
    return mod.exports;
}
const policy = loadTs('model/enrollment-policy.ts');
const cid = '0123456789abcdef01234567';
const otherCid = '1123456789abcdef01234567';
const future = () => new Date(Date.now() + 3600000);
const temp = (extra = {}) => ({ status: 'approved', enabled: true, accountType: 'temporary',
    validUntil: future(), contestScopes: [{ domainId: 'system', contestId: cid }], ...extra });
const request = (extra = {}) => ({ uid: 10, domainId: 'system', handler: 'ProblemSubmit', method: 'post', contestId: cid, ...extra });

class FakeObjectId {
    constructor(value) { this.value = String(value); }
    toString() { return this.value; }
    toHexString() { return this.value; }
}
const copy = (v) => {
    if (v instanceof Date) return new Date(v);
    if (v instanceof FakeObjectId) return new FakeObjectId(v.toString());
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
    return v;
};
function same(a, b) {
    if (a instanceof FakeObjectId || b instanceof FakeObjectId) return String(a) === String(b);
    return a === b;
}
function matches(doc, query) {
    return Object.entries(query).every(([key, value]) => {
        if (key === '$or') return value.some((q) => matches(doc, q));
        if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof FakeObjectId)) {
            return Object.entries(value).every(([op, arg]) => {
                if (op === '$in') return arg.includes(doc[key]);
                if (op === '$lt') return doc[key] < arg;
                if (op === '$exists') return (doc[key] !== undefined) === arg;
                throw new Error(`Unsupported test query ${op}`);
            });
        }
        return same(doc[key], value);
    });
}
class MemoryCollection {
    docs = [];
    async createIndex() {}
    async findOne(query) { return copy(this.docs.find((d) => matches(d, query)) || null); }
    async insertOne(doc) {
        if (this.docs.some((d) => same(d._id, doc._id))) throw Object.assign(new Error('duplicate'), { code: 11000 });
        this.docs.push(copy(doc));
        return { insertedId: doc._id };
    }
    async updateOne(query, update, options = {}) {
        let doc = this.docs.find((d) => matches(d, query));
        const inserting = !doc && options.upsert;
        if (inserting) { doc = copy(query); this.docs.push(doc); }
        if (!doc) return { matchedCount: 0 };
        Object.assign(doc, copy(update.$set || {}));
        if (inserting) Object.assign(doc, copy(update.$setOnInsert || {}));
        for (const key of Object.keys(update.$unset || {})) delete doc[key];
        for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
        for (const [key, value] of Object.entries(update.$push || {})) (doc[key] ||= []).push(copy(value));
        return { matchedCount: 1 };
    }
    async countDocuments(query) { return this.docs.filter((d) => matches(d, query)).length; }
    find(query) {
        let found = this.docs.filter((d) => matches(d, query));
        const cursor = { sort: () => cursor, skip: (n) => { found = found.slice(n); return cursor; },
            limit: (n) => { found = found.slice(0, n); return cursor; }, toArray: async () => copy(found) };
        return cursor;
    }
}
function harness() {
    const collections = {};
    const collection = (name) => collections[name] ||= new MemoryCollection();
    const logs = [];
    const userColl = collection('oi33_user');
    const model = loadTs('model/enrollment.ts', {
        hydrooj: { db: { collection } }, './log': { addLog: async (entry) => logs.push(entry) },
        './user': { userColl }, './enrollment-policy': policy,
    });
    class ForbiddenError extends Error {}
    class ValidationError extends Error { constructor(field, message) { super(message); this.field = field; } }
    class Handler {}
    const isAdmin = (user) => user?.role === 'root' || user?.privAll || user?.realname_flag >= 2;
    const auth = { isEducationAdmin: isAdmin, assertEducationAdmin: (user) => { if (!isAdmin(user)) throw new ForbiddenError('admin required'); } };
    const api = loadTs('handler/enrollment.ts', {
        hydrooj: { Handler, PRIV: { PRIV_USER_PROFILE: 1, PRIV_JUDGE: 2 }, Types: {}, param: () => (target, key, descriptor) => descriptor,
            ForbiddenError, ValidationError, ObjectId: FakeObjectId, db: { collection },
            RecordModel: { get: async (domainId, rid) => collection('record').findOne({ _id: rid, domainId }) },
            TokenModel: { TYPE_SESSION: 0, get: async (id) => collection('session').findOne({ _id: id }) },
            UserModel: { getById: async (_, uid) => collection('core_user').findOne({ _id: uid }) } },
        '../model/education-auth': auth, '../model/user': { userColl }, '../model/enrollment': model,
        '../model/enrollment-policy': policy,
    });
    function handler(name, method = 'post', args = {}, uid = 10) {
        const headers = {};
        return { constructor: { name: `${name}Handler` }, user: { _id: uid }, domain: { _id: 'system' },
            args: { domainId: 'system', ...args }, request: { method }, response: { body: {}, addHeader: (k, v) => { headers[k] = v; } },
            headers, context: { HydroContext: { user: { _id: uid }, domain: { _id: 'system' } } }, url: (name) => `/${name}`,
            close(code) { this.closed = code; } };
    }
    async function hookMap() {
        const hooks = {}; const routes = [];
        await api.apply({ on: (name, fn) => { (hooks[name] ||= []).push(fn); }, Route: (...args) => routes.push(args) });
        return { hooks, routes, run: async (name, h) => { let result; for (const fn of hooks[name] || []) result = await fn(h); return result; } };
    }
    return { model, api, collection, userColl, logs, handler, hookMap, ForbiddenError, ValidationError };
}

test('pending identity blocks core writes, API and all sockets while permitting public GET', () => {
    for (const doc of [null, { ...temp(), accountType: 'regular', status: 'pending' }, { ...temp(), accountType: 'regular', status: 'rejected' }]) {
        for (const handler of ['ProblemSubmit', 'ContestDetail', 'HomeworkDetail', 'TrainingDetail', 'ArticleCreate', 'Api']) {
            assert.equal(policy.decideEnrollmentAccess(doc, request({ handler })).allowed, false, handler);
        }
        assert.equal(policy.decideEnrollmentAccess(doc, request({ method: 'get' })).allowed, true);
        assert.equal(policy.decideEnrollmentAccess(doc, request({ method: 'ws', handler: 'RecordMainConnection' })).allowed, false);
        assert.equal(policy.decideEnrollmentAccess(doc, request({ handler: 'Oi33Enrollment' })).allowed, true);
    }
});

test('legacy verified and administrators remain compatible; new document overrides legacy flag', () => {
    assert.equal(policy.decideEnrollmentAccess(null, request({ legacyVerified: true })).allowed, true);
    assert.equal(policy.decideEnrollmentAccess(null, request({ isAdmin: true })).allowed, true);
    assert.equal(policy.decideEnrollmentAccess(temp({ status: 'rejected' }), request({ isAdmin: true, legacyVerified: true })).allowed, false);
    assert.equal(policy.decideEnrollmentAccess(temp({ enabled: false }), request({ isAdmin: true })).allowed, false);
});

test('judge service exemption is privilege-gated, endpoint-exact and overridden by a personnel enrollment', async () => {
    const h = harness(); const hooks = await h.hookMap();
    for (const name of ['JudgeConnection', 'JudgeFilesDownload', 'JudgeFileUpdate']) {
        const judge = h.handler(name, 'post');
        const socket = name === 'JudgeConnection';
        await assert.rejects(h.api.enforceEnrollment(judge, socket), h.ForbiddenError);
        judge.user.hasPriv = (priv) => priv === 2;
        await h.api.enforceEnrollment(judge, socket);
        if (socket) {
            let received = 0; let sent = 0;
            judge.prepare = async () => {};
            judge.message = async () => { received++; };
            judge.send = () => { sent++; };
            h.api.protectEnrollmentConnection(judge);
            await judge.prepare(); await judge.message({ action: 'next' }); await judge.send({ task: true });
            assert.equal(received, 1); assert.equal(sent, 1);
        } else await hooks.run('handler/before-prepare', judge);
    }
    for (const name of ['ProblemSubmit', 'ContestDetail', 'EducationClasses', 'Api', 'WebsocketEventsConnectionManager', 'JudgeConnectionImpersonator']) {
        const notJudgeEndpoint = h.handler(name, 'post');
        notJudgeEndpoint.user.hasPriv = (priv) => priv === 2;
        await assert.rejects(h.api.enforceEnrollment(notJudgeEndpoint, name.includes('Connection')), h.ForbiddenError);
    }
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '临时选手', accountType: 'temporary',
        contestScopes: temp().contestScopes, validUntil: future() }, 1);
    const judge = h.handler('JudgeConnection', 'post');
    judge.user.hasPriv = (priv) => priv === 2;
    await assert.rejects(h.api.enforceEnrollment(judge, true), h.ForbiddenError);
    await h.model.manageEnrollment(10, 1, 'convert', 1);
    await h.model.manageEnrollment(10, 2, 'disable', 1);
    await assert.rejects(h.api.enforceEnrollment(judge, true), /已停用/);
    const core = fs.readFileSync(path.join(root, 'node_modules/hydrooj/src/handler/judge.ts'), 'utf8');
    for (const name of ['JudgeConnection', 'JudgeFilesDownload', 'JudgeFileUpdate']) {
        assert.ok(core.includes(`${name}Handler, builtin.PRIV.PRIV_JUDGE)`), `${name} must retain Hydro's privilege checker`);
    }
});

test('temporary scope is deny-by-default and does not permit problem/discussion/admin route mutations', () => {
    const doc = temp();
    assert.equal(policy.decideEnrollmentAccess(doc, request()).allowed, true);
    assert.equal(policy.decideEnrollmentAccess(doc, request({ contestId: otherCid })).allowed, false);
    assert.equal(policy.decideEnrollmentAccess(doc, request({ domainId: 'other' })).allowed, false);
    assert.equal(policy.decideEnrollmentAccess(doc, request({ contestId: '' })).allowed, false);
    for (const handler of ['ProblemDetail', 'ContestEdit', 'TrainingDetail', 'ArticleCreate', 'Api', 'Home']) {
        assert.equal(policy.decideEnrollmentAccess(doc, request({ handler, method: 'get' })).allowed, handler === 'ProblemDetail', handler);
        assert.equal(policy.decideEnrollmentAccess(doc, request({ handler, operation: 'delete' })).allowed, false);
    }
    assert.equal(policy.decideEnrollmentAccess(doc, request({ handler: 'ContestDetail', operation: 'attend' })).allowed, true);
    assert.equal(policy.decideEnrollmentAccess(doc, request({ handler: 'ContestDetail', operation: 'unlock' })).allowed, false);
    assert.equal(policy.decideEnrollmentAccess(doc, request({ handler: 'HomeSecurity' })).allowed, true);
});

test('expiry boundary, missing expiry, invalid date, disabled and mandatory password change fail closed', () => {
    const doc = temp({ validFrom: new Date(100), validUntil: new Date(200) });
    assert.equal(policy.enrollmentActivity(doc, 99).allowed, false);
    assert.equal(policy.enrollmentActivity(doc, 100).allowed, true);
    assert.equal(policy.enrollmentActivity(doc, 199).allowed, true);
    assert.equal(policy.enrollmentActivity(doc, 200).allowed, false);
    for (const extra of [{ validUntil: undefined }, { validUntil: 'invalid' }, { contestScopes: [] }, { enabled: false }]) {
        assert.equal(policy.enrollmentActivity(temp(extra)).allowed, false);
    }
    assert.equal(policy.decideEnrollmentAccess(temp({ requiresPasswordChange: true }), request()).allowed, false);
    assert.equal(policy.decideEnrollmentAccess(temp({ requiresPasswordChange: true }), request({ handler: 'HomeSecurity' })).allowed, true);
});

test('application validates names and cannot request a management role or self-assign classes', async () => {
    const h = harness();
    await assert.rejects(h.model.submitEnrollment(10, 'system', { realName: '   ' }, 0));
    const doc = await h.model.submitEnrollment(10, 'system', { realName: ' 学生甲 ', requestedGroups: ['基础班', '基础班'], realname_flag: 3, accountType: 'temporary' }, 0);
    assert.equal(doc.realName, '学生甲');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.accountType, 'regular');
    assert.deepEqual(doc.requestedGroups, ['基础班']);
    assert.equal(doc.realname_flag, undefined);
    assert.equal((await h.userColl.findOne({ _id: 10 })).realname_flag, 0);
    assert.equal(h.collection('core_user').docs.length, 0);
    assert.ok(h.logs.every((entry) => !JSON.stringify(entry).includes('学生甲')));
});

test('revision CAS prevents stale review/replay, rejection requires a reason and resubmission works', async () => {
    const h = harness();
    await h.model.submitEnrollment(10, 'system', { realName: '学生甲' }, 0);
    await assert.rejects(h.model.reviewEnrollment(10, 1, 'rejected', 1, ''));
    await h.model.reviewEnrollment(10, 1, 'rejected', 1, '请补充名册编号');
    const updated = await h.model.submitEnrollment(10, 'system', { realName: '学生甲', studentId: 'S01' }, 2);
    assert.equal(updated.status, 'pending');
    assert.equal(updated.rejectionReason, undefined);
    await assert.rejects(h.model.reviewEnrollment(10, 1, 'approved', 2), /已更新/);
    const approvals = await Promise.allSettled([h.model.reviewEnrollment(10, 3, 'approved', 1), h.model.reviewEnrollment(10, 3, 'rejected', 2, '冲突操作')]);
    assert.equal(approvals.filter((result) => result.status === 'fulfilled').length, 1);
    const doc = await h.model.getEnrollment(10);
    assert.equal(doc.status, 'approved');
    assert.equal(doc.revision, 4);
    assert.equal(doc.history.length, 4);
    assert.equal((await h.userColl.findOne({ _id: 10 })).realname_flag, 1);
    await assert.rejects(h.model.submitEnrollment(10, 'system', { realName: '另一个人' }, 4), /不能自行修改/);
});

test('provision is batch-idempotent but never overwrites an existing identity', async () => {
    const h = harness();
    const input = { uid: 10, domainId: 'system', realName: '学生甲', batchId: 'batch-1', rosterKey: 'row-1',
        accountType: 'temporary', contestScopes: temp().contestScopes, validUntil: future(), requiresPasswordChange: true };
    const first = await h.model.provisionEnrollment(input, 1);
    const second = await h.model.provisionEnrollment(input, 1);
    assert.equal(second.revision, first.revision);
    assert.equal(h.collection('oi33_enrollment').docs.length, 1);
    assert.equal(h.logs.length, 1);
    await assert.rejects(h.model.provisionEnrollment({ ...input, realName: '其他人' }, 1), /不能通过导入覆盖/);
    await assert.rejects(h.model.provisionEnrollment({ ...input, uid: 11, validUntil: undefined }, 1), /必须指定/);
});

test('lifecycle disable/enable/extension/conversion keep UID, history and existing administrator flags', async () => {
    const h = harness();
    await h.userColl.insertOne({ _id: 10, realname_flag: 2 });
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '教练', accountType: 'temporary',
        contestScopes: temp().contestScopes, validUntil: future() }, 1);
    assert.equal((await h.userColl.findOne({ _id: 10 })).realname_flag, 2);
    await h.model.manageEnrollment(10, 1, 'disable', 1);
    assert.equal((await h.model.getEnrollment(10)).enabled, false);
    await assert.rejects(h.model.manageEnrollment(10, 1, 'enable', 1), /资料已更新/);
    await h.model.manageEnrollment(10, 2, 'enable', 1);
    await assert.rejects(h.model.manageEnrollment(10, 3, 'extend', 1, { validUntil: new Date(1) }));
    await h.model.manageEnrollment(10, 3, 'extend', 1, { validUntil: new Date(Date.now() + 7200000) });
    const converted = await h.model.manageEnrollment(10, 4, 'convert', 1);
    assert.equal(converted._id, 10);
    assert.equal(converted.accountType, 'regular');
    assert.equal(converted.validUntil, undefined);
    assert.deepEqual(converted.contestScopes, []);
    assert.equal(converted.history.length, 5);
});

test('HTTP hooks run after authentication and before prepare, rechecking existing sessions on every request', async () => {
    const h = harness(); const hooks = await h.hookMap();
    assert.equal(hooks.hooks['handler/create'], undefined);
    const req = h.handler('ProblemSubmit', 'post', { tid: cid });
    await assert.rejects(hooks.run('handler/before-prepare', req), h.ForbiddenError);
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', accountType: 'temporary', contestScopes: temp().contestScopes, validUntil: future() }, 1);
    await hooks.run('handler/before-prepare', req);
    await h.model.manageEnrollment(10, 1, 'disable', 1);
    await assert.rejects(hooks.run('handler/before-prepare', req), /已停用/);
    await assert.rejects(hooks.run('handler/before-operation', req), /已停用/);
    const core = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/framework/server.ts'), 'utf8');
    assert.ok(core.indexOf("'handler/before-prepare',") < core.indexOf("'log/__prepare', '__prepare'"));
    assert.ok(core.includes("await (this.ctx.parallel as any)('handler/create/http', h)"));
    assert.ok(core.includes("await this.ctx.serial(step, h)"));
});

test('temporary homepage redirects before data loading; forged domain/API/bulk record parameters are denied', async () => {
    const h = harness(); const hooks = await h.hookMap();
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', accountType: 'temporary', contestScopes: temp().contestScopes, validUntil: future() }, 1);
    const home = h.handler('Home', 'get');
    assert.equal(await hooks.run('handler/before-prepare', home), 'cleanup');
    assert.equal(home.response.redirect, '/oi33_enrollment');
    await assert.rejects(h.api.enforceEnrollment(h.handler('ProblemSubmit', 'post', { tid: cid, domainId: 'other' })), /不能通过参数/);
    await assert.rejects(h.api.enforceEnrollment(h.handler('Api', 'get', { tid: cid })), h.ForbiddenError);
    await assert.rejects(h.api.enforceEnrollment(h.handler('RecordList', 'get', { tid: cid, all: '1' })), h.ForbiddenError);
    const scoped = h.handler('RecordList', 'get', { tid: cid, uidOrName: 'someone_else' });
    await h.api.enforceEnrollment(scoped);
    assert.equal(scoped.args.uidOrName, '10');
});

test('record details and pretest mapping require current owner and contest scope', async () => {
    const h = harness(); const hooks = await h.hookMap();
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', accountType: 'temporary', contestScopes: temp().contestScopes, validUntil: future() }, 1);
    const rid = new FakeObjectId('a123456789abcdef01234567');
    await h.collection('record').insertOne({ _id: rid, domainId: 'system', uid: 10, contest: new FakeObjectId('000000000000000000000000') });
    const record = h.handler('RecordDetail', 'get', { rid: String(rid) });
    await assert.rejects(h.api.enforceEnrollment(record), h.ForbiddenError);
    const submitted = h.handler('ProblemSubmit', 'post', { tid: cid, pretest: true });
    submitted.response.body.rid = rid;
    await hooks.run('handler/after/ProblemSubmit#post', submitted);
    await h.api.enforceEnrollment(record);
    await h.collection('record').updateOne({ _id: rid }, { $set: { uid: 11 } });
    await assert.rejects(h.api.enforceEnrollment(record), h.ForbiddenError);
});

test('WS gates prepare, arbitrary messages, direct updates and subscriptions after revocation', async () => {
    const h = harness();
    const socket = h.handler('RecordMainConnection', 'get', { tid: cid, pretest: true });
    let messages = 0; let updates = 0;
    socket.prepare = async () => {};
    socket.message = async () => { messages++; };
    socket.onRecordChange = async () => { updates++; };
    socket.__subscribe = [{ name: 'record/change', target: socket.onRecordChange }];
    h.api.protectEnrollmentConnection(socket);
    await assert.rejects(socket.prepare(), h.ForbiddenError);
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', accountType: 'temporary', contestScopes: temp().contestScopes, validUntil: future() }, 1);
    await socket.prepare(); await socket.message({ rids: [] });
    assert.equal(messages, 1);
    const allowed = { _id: new FakeObjectId('a123456789abcdef01234567'), domainId: 'system', uid: 10, contest: new FakeObjectId(cid) };
    await socket.onRecordChange({ ...allowed, uid: 11 });
    assert.equal(updates, 0);
    await socket.onRecordChange(allowed);
    assert.equal(updates, 1);
    await h.model.manageEnrollment(10, 1, 'disable', 1);
    await assert.doesNotReject(socket.message({ rids: [] }));
    assert.equal(socket.closed, 4003);
    assert.equal(messages, 1);
    await socket.__subscribe[0].target.call(socket, allowed);
    assert.equal(socket.closed, 4003);
    assert.equal(updates, 1);
});

test('password requirement is removed only by successful core password-change after hook', async () => {
    const h = harness(); const hooks = await h.hookMap();
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', requiresPasswordChange: true }, 1);
    const security = h.handler('HomeSecurity', 'post', { operation: 'change_password' });
    security.response.redirect = '/user_sudo';
    await hooks.run('handler/after/HomeSecurity#post', security);
    assert.equal((await h.model.getEnrollment(10)).requiresPasswordChange, true);
    security.response.redirect = '/user_login';
    await hooks.run('handler/after/HomeSecurity#post', security);
    assert.equal((await h.model.getEnrollment(10)).requiresPasswordChange, false);
    assert.equal((await h.model.getEnrollment(10)).revision, 2);
});

test('anonymous gateway checks payload credentials instead of trusting its guest handshake identity', async () => {
    const h = harness();
    await h.collection('core_user').insertOne({ _id: 10 });
    await h.collection('session').insertOne({ _id: 'test-session-10', uid: 10 });
    const gateway = h.handler('WebsocketEventsConnectionManager', 'get', {}, 0);
    let accepted = 0;
    gateway.prepare = async () => {};
    gateway.message = async () => { accepted++; };
    gateway.send = () => {};
    h.api.protectEnrollmentConnection(gateway);
    await gateway.prepare();
    const payload = { operation: 'subscribe', credential: 'test-session-10', channels: ['message'] };
    await assert.doesNotReject(gateway.message(payload));
    assert.equal(gateway.closed, 4003);
    assert.equal(accepted, 0);
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲', accountType: 'temporary',
        contestScopes: temp().contestScopes, validUntil: future() }, 1);
    await assert.doesNotReject(gateway.message(payload));
    assert.equal(gateway.closed, 4003);
    assert.equal(accepted, 0);
    await h.model.manageEnrollment(10, 1, 'convert', 1);
    await gateway.message(payload);
    assert.equal(accepted, 1);
    assert.equal(gateway.user._id, 0, 'must not rewrite the core handshake user');
    await assert.doesNotReject(gateway.message({ ...payload, operation: 'resume' }));
    assert.equal(gateway.closed, 4003);
    assert.equal(accepted, 1);
});

test('dynamic gateway output checks pinned identity, session revocation and enrollment on every send', async () => {
    const h = harness();
    await h.collection('core_user').insertOne({ _id: 10 });
    await h.collection('core_user').insertOne({ _id: 11 });
    await h.collection('session').insertOne({ _id: 'test-session-10', uid: 10 });
    await h.collection('session').insertOne({ _id: 'test-session-11', uid: 11 });
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲' }, 1);
    await h.model.provisionEnrollment({ uid: 11, domainId: 'system', realName: '学生乙' }, 1);
    const gateway = h.handler('WebsocketEventsConnectionManager', 'get', {}, 0);
    const sent = [];
    gateway.prepare = async () => {};
    gateway.message = async () => {};
    gateway.send = (data) => { sent.push(data); };
    h.api.protectEnrollmentConnection(gateway);
    await gateway.prepare();
    await gateway.message({ operation: 'subscribe', credential: 'test-session-10', channels: ['message'] });
    await gateway.send({ privateMessage: 'allowed' });
    assert.equal(sent.length, 1);
    await assert.doesNotReject(gateway.message({ operation: 'subscribe', credential: 'test-session-11', channels: ['message'] }));
    assert.equal(gateway.closed, 4003);
    await h.model.manageEnrollment(10, 1, 'disable', 1);
    await gateway.send({ privateMessage: 'must not leave server' });
    assert.equal(sent.length, 1);
    assert.equal(gateway.closed, 4003);
    await h.model.manageEnrollment(10, 2, 'enable', 1);
    h.collection('session').docs = [];
    await gateway.send({ privateMessage: 'revoked session' });
    assert.equal(sent.length, 1);
});

test('gateway bypass is granted only after core secret validation and preserves internal multiplexing', async () => {
    const h = harness();
    const gateway = h.handler('WebsocketEventsConnectionManager', 'get', {}, 10);
    await h.model.submitEnrollment(10, 'system', { realName: '未核验' }, 0);
    let sent = 0; let received = 0;
    gateway.prepare = async function () { this.privileged = true; }; // core sets this only after secret verification
    gateway.message = async () => { received++; };
    gateway.send = () => { sent++; };
    h.api.protectEnrollmentConnection(gateway);
    await gateway.prepare();
    await gateway.message({ operation: 'resume', channels: ['message:10', 'message:11'] });
    await gateway.send({ internalTransport: true });
    assert.equal(received, 1);
    assert.equal(sent, 1);
    const forged = h.handler('WebsocketEventsConnectionManager', 'get', {}, 0);
    forged.request.headers = { 'x-hydro-websocket-gateway': 'invalid' };
    forged.prepare = async () => { throw new h.ForbiddenError('Invalid token'); };
    h.api.protectEnrollmentConnection(forged);
    await assert.rejects(forged.prepare(), /Invalid token/);
    const source = fs.readFileSync(path.join(root, 'node_modules/hydrooj/src/handler/connection.ts'), 'utf8');
    assert.ok(source.indexOf("token !== secret") < source.indexOf('this.privileged = true'));
});

test('non-gateway direct send callbacks cannot bypass a disabled account', async () => {
    const h = harness();
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '学生甲' }, 1);
    const socket = h.handler('AnyPrivateUpdatesConnection', 'get');
    let sent = 0;
    socket.send = () => { sent++; };
    h.api.protectEnrollmentConnection(socket);
    await socket.send({ content: 'allowed' });
    await h.model.manageEnrollment(10, 1, 'disable', 1);
    await socket.send({ content: 'blocked' });
    assert.equal(sent, 1);
    assert.equal(socket.closed, 4003);
});

test('review endpoint rejects ordinary students, cross-domain targets, self-management and active administrators', async () => {
    const h = harness();
    await h.model.submitEnrollment(10, 'other', { realName: '学生甲' }, 0);
    const req = h.handler('Oi33EnrollmentReview');
    req.user._id = 1;
    await assert.rejects(h.api.Oi33EnrollmentReviewHandler.prototype.post.call(req, 'system', 10, 1, 'approve'), /admin required/);
    req.user.role = 'root';
    const forged = h.handler('Oi33EnrollmentReview', 'get', { domainId: 'my-other-domain' });
    forged.user.role = 'root';
    await assert.rejects(h.api.enforceEnrollment(forged), /管理域与请求参数不一致/);
    const forgedBatch = h.handler('AccountBatchCreate', 'post', { domainId: 'my-other-domain' });
    forgedBatch.user.role = 'root';
    await assert.rejects(h.api.enforceEnrollment(forgedBatch), /管理域与请求参数不一致/);
    for (const name of ['HomeworkEdit', 'HomeworkFiles', 'HomeworkDetail', 'HomeworkFileDownload']) {
        const forgedHomework = h.handler(name, 'post', { domainId: 'my-other-domain' });
        forgedHomework.user.role = 'root';
        await assert.rejects(h.api.enforceEnrollment(forgedHomework), /管理域与请求参数不一致/);
    }
    await assert.rejects(h.api.Oi33EnrollmentReviewHandler.prototype.post.call(req, 'system', 10, 1, 'approve'), /其他域/);
    await h.collection('oi33_enrollment').updateOne({ _id: 10 }, { $set: { domainId: 'system' } });
    req.user._id = 10;
    await assert.rejects(h.api.Oi33EnrollmentReviewHandler.prototype.post.call(req, 'system', 10, 1, 'approve'), /自己的账号/);
    req.user._id = 1;
    await h.collection('core_user').insertOne({ _id: 10, role: 'root' });
    await assert.rejects(h.api.Oi33EnrollmentReviewHandler.prototype.post.call(req, 'system', 10, 1, 'disable'), /撤销管理员/);
});

test('private profile uses no-store and legacy request model cannot modify realname fields', async () => {
    const h = harness();
    const self = h.handler('Oi33Enrollment', 'get');
    await h.api.Oi33EnrollmentHandler.prototype.get.call(self);
    assert.equal(self.headers['Cache-Control'], 'private, no-store');
    const old = loadTs('model/request.ts', { hydrooj: { db: { collection: h.collection }, ObjectId: FakeObjectId },
        './log': { addLog: async () => {}, logColl: h.collection('oi33_log') }, './user': { userColl: h.userColl }, './cat-map': { removeCatMapPlayer: async () => {} } });
    await assert.rejects(old.applyRequestPayload(10, { realname_flag: 3, realname_name: 'fake' }), /独立 enrollment/);
    await assert.rejects(old.submitRequest(10, 'realname', 10, { realname_flag: 2 }), /enrollment/);
    assert.equal(h.userColl.docs.length, 0);
});

test('templates render empty, pending, rejected, approved, temporary and review states with escaping', () => {
    class Loader extends nunjucks.Loader {
        getSource(name) {
            return { src: name === 'layout/basic.html' ? '{% block content %}{% endblock %}' : fs.readFileSync(path.join(root, 'templates', name), 'utf8'), path: name };
        }
    }
    const env = new nunjucks.Environment(new Loader(), { autoescape: true });
    env.addGlobal('url', (name) => `/${name}`);
    env.addGlobal('datetimeSpan', (date) => `<span class="time relative" data-timestamp="${new Date(date).getTime() / 1000}">2026-09-08</span>`);
    const context = { handler: { csrfToken: 'csrf-token' }, legacyVerified: false, isAdmin: false };
    const empty = env.render('oi33_enrollment.html', context);
    assert.ok(empty.includes('name="csrfToken"'));
    assert.ok(empty.includes('name="realName" required'));
    assert.ok(!empty.includes('name="realname_flag"'));
    for (const status of ['pending', 'rejected', 'approved']) {
        const enrollment = { ...temp(), accountType: 'regular', status, realName: '<script>bad</script>', requestedGroups: ['班型'], revision: 1 };
        const html = env.render('oi33_enrollment.html', { ...context, enrollment });
        assert.ok(!html.includes('<script>bad</script>'));
        assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    }
    const temporary = env.render('oi33_enrollment.html', { ...context, enrollment: { ...temp(), realName: '学生甲', revision: 1 } });
    assert.ok(temporary.includes('进入比赛 1'));
    assert.ok(temporary.includes('<span class="time relative"'));
    assert.ok(!temporary.includes('&lt;span class='));
    const review = env.render('oi33_enrollment_review.html', { ...context, enrollments: [{ ...temp(), _id: 10, realName: '学生甲', revision: 1, history: [] }], page: 1, pages: 2, total: 1 });
    assert.ok(review.includes('转为日常账号'));
    assert.ok(review.includes('下一页'));
    assert.ok(review.includes('<span class="time relative"'));
});
