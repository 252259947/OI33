const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ObjectId } = require('mongodb');

const root = path.resolve(__dirname, '..');
// Reuse the in-memory enrollment fixture, without registering its independent suite.
const fixtureSource = fs.readFileSync(path.join(__dirname, 'enrollment.test.cjs'), 'utf8');
const harness = new Function('require', '__dirname', `${fixtureSource}\nreturn harness;`)(
    (name) => name === 'node:test' ? () => {} : require(name), __dirname);
const future = () => new Date(Date.now() + 3600000);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function studentFixture() {
    const h = harness();
    await h.model.provisionEnrollment({ uid: 10, domainId: 'system', realName: '合成测试学生' }, 1);
    await h.collection('core_user').insertOne({ _id: 10 });
    return h;
}

function loadCoreRecordConnection(recordDoc) {
    const passthrough = () => (_target, _key, descriptor) => descriptor;
    const dependencies = {
        lodash: { throttle: (fn) => function (...args) { return fn.apply(this, args); } },
        mongodb: { ObjectId },
        '../error': new Proxy({}, { get: () => Error }),
        '../model/builtin': { PERM: {}, PRIV: {}, STATUS: { STATUS_WAITING: 1 } },
        '../model/contest': {},
        '../model/problem': { default: { get: async () => ({ docId: 1 }), getStatus: async () => null, canViewBy: () => true } },
        '../model/record': { default: { get: async () => recordDoc } },
        '../model/setting': {}, '../model/storage': {}, '../model/system': {}, '../model/task': {}, '../model/user': {},
        '../service/server': { ConnectionHandler: class {}, param: passthrough, subscribe: passthrough, Types: {} },
        '../utils': {}, './contest': { ContestDetailBaseHandler: class {} }, './judge': {},
    };
    for (const value of Object.values(dependencies)) if (value.default) value.__esModule = true;
    const source = fs.readFileSync(path.join(root, 'node_modules/hydrooj/src/handler/record.ts'), 'utf8');
    const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', compiled)(mod, mod.exports, (name) => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
        return dependencies[name];
    });
    return mod.exports.RecordDetailConnectionHandler;
}

test('real Hydro record socket idle across reset and successful password change cannot push again with its deleted session', async () => {
    const h = await studentFixture();
    const recordDoc = { _id: new ObjectId(), uid: 10, domainId: 'system', pid: 1, status: 1, code: 'synthetic original code' };
    const CoreRecordConnection = loadCoreRecordConnection(recordDoc);
    const connect = (sid) => {
        const socket = new CoreRecordConnection();
        const fields = h.handler('RecordDetailConnection', 'get', { rid: String(recordDoc._id) });
        delete fields.constructor;
        Object.assign(socket, fields);
        socket.session = Object.create({ _id: sid, uid: 10 });
        socket.user.hasPriv = socket.user.hasPerm = () => false;
        socket.checkPerm = () => {};
        const received = [];
        socket.send = (payload) => received.push(payload);
        h.api.protectEnrollmentConnection(socket);
        return { socket, received };
    };
    await h.collection('session').insertOne({ _id: 'synthetic-old-session', uid: 10, expireAt: future() });
    const old = connect('synthetic-old-session');
    await old.socket.prepare('system', recordDoc._id, true);
    await tick();
    assert.equal(old.received.length, 1);
    h.collection('session').docs = [];
    await h.collection('oi33_enrollment').updateOne({ _id: 10 }, { $set: {
        requiresPasswordChange: true, revision: 2, passwordReset: { state: 'ready' },
        passwordOperation: { id: 'synthetic-successful-change' },
    } });
    await h.model.completeEnrollmentPasswordChange(10, 2, 'synthetic-successful-change');
    assert.equal((await h.model.getEnrollment(10)).requiresPasswordChange, false);
    await old.socket.onRecordChange({ ...recordDoc, code: 'synthetic later record update' });
    await tick();
    assert.equal(old.received.length, 1, 'the later private record must not reach the revoked connection');
    assert.equal(old.socket.closed, 4003);

    await h.collection('session').insertOne({ _id: 'synthetic-new-session', uid: 10, expireAt: future() });
    const fresh = connect('synthetic-new-session');
    await fresh.socket.prepare('system', recordDoc._id, true);
    await tick();
    await fresh.socket.onRecordChange({ ...recordDoc, code: 'synthetic fresh-login update' });
    await tick();
    assert.equal(fresh.received.length, 2, 'a fresh successful login retains live record updates');
    assert.equal(fresh.socket.closed, undefined);
});

test('every authenticated connection entry point rejects a deleted session independently of the enrollment flag', async () => {
    for (const method of ['_prepare', 'prepare', 'message', 'onRecordChange', 'queueClear', 'sendUpdate', 'send', 'subscription']) {
        const h = await studentFixture();
        const socket = h.handler('SyntheticPrivateConnection', 'get');
        let calls = 0;
        const callback = () => { calls++; };
        if (method === 'subscription') socket.__subscribe = [{ name: 'synthetic/update', target: callback }];
        else socket[method] = callback;
        h.api.protectEnrollmentConnection(socket);
        const invoke = () => method === 'subscription' ? socket.__subscribe[0].target.call(socket, {}) : socket[method]({});
        await invoke();
        assert.equal(calls, 1, method);
        h.collection('session').docs = [];
        if (['_prepare', 'prepare'].includes(method)) await assert.rejects(invoke(), h.ForbiddenError);
        else await assert.doesNotReject(invoke());
        assert.equal(calls, 1, `${method} must not invoke a revoked callback`);
        assert.equal(socket.closed, 4003, method);
        await h.collection('session').insertOne({ _id: 'handshake-10', uid: 10, expireAt: future() });
        if (['_prepare', 'prepare'].includes(method)) await assert.rejects(invoke(), h.ForbiddenError);
        else await assert.doesNotReject(invoke());
        assert.equal(calls, 1, `${method} is permanently closed, even if state is later restored`);
    }
});

test('authenticated sockets fail closed for absent, expired, invalid or mismatched credentials and ignore request-supplied identities', async () => {
    for (const fault of ['missing-session', 'missing-id', 'missing-session-uid', 'mismatched-session-uid', 'expired', 'invalid-expiry', 'missing-expiry', 'wrong-token-uid', 'deleted', 'forged-user', 'replaced-session']) {
        const h = await studentFixture();
        const socket = h.handler('SyntheticPrivateConnection', 'get', { sid: 'forged', uid: 10, credential: 'forged' });
        socket.request.headers.authorization = 'Bearer forged';
        const token = h.collection('session').docs.find((doc) => doc._id === 'handshake-10');
        if (fault === 'missing-session') delete socket.session;
        if (fault === 'missing-id') socket.session = { uid: 10 };
        if (fault === 'missing-session-uid') socket.session = { _id: token._id };
        if (fault === 'mismatched-session-uid') socket.session = { _id: token._id, uid: 11 };
        if (fault === 'expired') token.expireAt = new Date(Date.now() - 1);
        if (fault === 'invalid-expiry') token.expireAt = 'not-a-date';
        if (fault === 'missing-expiry') delete token.expireAt;
        if (fault === 'deleted') h.collection('session').docs = [];
        let sent = 0;
        socket.send = () => { sent++; };
        h.api.protectEnrollmentConnection(socket);
        if (fault === 'wrong-token-uid') token.uid = 11;
        if (fault === 'forged-user') socket.user._id = 0;
        if (fault === 'replaced-session') {
            h.collection('session').docs = [{ _id: 'new-valid-session', uid: 10, expireAt: future() }];
            socket.session = { _id: 'new-valid-session', uid: 10 };
        }
        await socket.send({ private: true });
        assert.equal(sent, 0, fault);
        assert.equal(socket.closed, 4003, fault);
    }
});

test('revocation during an outstanding token check closes and latches queued sends without leaking a cached valid result', async () => {
    const h = await studentFixture();
    const socket = h.handler('SyntheticPrivateConnection', 'get');
    const sent = [];
    socket.send = (payload) => sent.push(payload);
    socket.message = () => { throw new Error('revoked input must never run'); };
    h.api.protectEnrollmentConnection(socket);
    const sessions = h.collection('session');
    const findOne = sessions.findOne.bind(sessions);
    let release; let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { started = resolve; });
    let first = true;
    sessions.findOne = async (...args) => {
        const result = await findOne(...args);
        if (first) { first = false; started(); await gate; }
        return result;
    };
    const firstSend = socket.send({ private: 'delayed' });
    await waiting;
    const secondSend = socket.send({ private: 'queued' });
    sessions.docs = [];
    await socket.message({});
    assert.equal(socket.closed, 4003);
    release();
    await Promise.all([firstSend, secondSend]);
    assert.deepEqual(sent, []);
});

test('anonymous public connections and authenticated judge infrastructure keep working, with no unauthenticated judge exemption', async () => {
    const h = harness();
    const anonymous = h.handler('RecordMainConnection', 'get', {}, 0);
    let publicSent = 0;
    anonymous.send = () => { publicSent++; };
    h.api.protectEnrollmentConnection(anonymous);
    await anonymous.prepare();
    await anonymous.send({ public: true });
    assert.equal(publicSent, 1);
    assert.equal(anonymous.closed, undefined);

    const judge = h.handler('JudgeConnection', 'get', {}, 20);
    judge.user.hasPriv = (priv) => priv === 2;
    let judgeSent = 0;
    judge.send = () => { judgeSent++; };
    judge.message = () => {};
    h.api.protectEnrollmentConnection(judge);
    await judge.prepare();
    await judge.message({ key: 'start' });
    await judge.send({ task: 'synthetic' });
    assert.equal(judgeSent, 1);
    assert.equal(judge.closed, undefined);
    h.collection('session').docs = [];
    await judge.send({ task: 'revoked' });
    assert.equal(judgeSent, 1);
    assert.equal(judge.closed, 4003);
    const missingSession = h.handler('JudgeConnection', 'get', {}, 20);
    missingSession.user.hasPriv = (priv) => priv === 2;
    missingSession.session = {};
    h.api.protectEnrollmentConnection(missingSession);
    await assert.rejects(missingSession.prepare(), h.ForbiddenError);
    assert.equal(missingSession.closed, 4003);
});

test('gateway cannot replace a pinned token or race two users onto one connection', async () => {
    const h = await studentFixture();
    await h.model.provisionEnrollment({ uid: 11, domainId: 'system', realName: '合成另一学生' }, 1);
    await h.collection('core_user').insertOne({ _id: 11 });
    await h.collection('session').insertOne({ _id: 'session-a', uid: 10, expireAt: future() });
    await h.collection('session').insertOne({ _id: 'session-b', uid: 11, expireAt: future() });
    await h.collection('session').insertOne({ _id: 'session-c', uid: 10, expireAt: future() });
    for (const credentials of [['session-a', 'session-b'], ['session-a', 'session-c']]) {
        const socket = h.handler('WebsocketEventsConnectionManager', 'get', {}, 0);
        let accepted = 0; let sent = 0;
        socket.message = () => { accepted++; };
        socket.send = () => { sent++; };
        h.api.protectEnrollmentConnection(socket);
        await socket.prepare();
        await Promise.all(credentials.map((credential) => socket.message({ operation: 'subscribe', credential })));
        assert.ok(accepted <= 1);
        assert.equal(socket.closed, 4003);
        await socket.send({ private: true });
        assert.equal(sent, 0);
    }
});
