const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(relative, mocks = {}) {
    const code = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node18',
    }).code;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        if (name === 'crypto') return require(name);
        throw new Error(`Unexpected import ${relative}: ${name}`);
    });
    return module.exports;
}
const clone = (value) => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const at = (doc, key) => key.split('.').reduce((current, part) => current?.[part], doc);
function matches(doc, query) {
    return Object.entries(query).every(([key, condition]) => {
        if (key === '$or') return condition.some((item) => matches(doc, item));
        if (key === '$and') return condition.every((item) => matches(doc, item));
        const value = at(doc, key);
        if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
            return Object.entries(condition).every(([op, expected]) => {
                if (op === '$in') return expected.includes(value);
                if (op === '$nin') return !expected.includes(value);
                if (op === '$ne') return value !== expected;
                if (op === '$exists') return (value !== undefined) === expected;
                if (op === '$lte') return value != null && value <= expected;
                if (op === '$lt') return value != null && value < expected;
                if (op === '$gt') return value != null && value > expected;
                throw new Error(`Unsupported operator ${op}`);
            });
        }
        return value === condition;
    });
}
function setPath(doc, key, value, remove = false) {
    const parts = key.split('.');
    let target = doc;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    if (remove) delete target[parts.at(-1)];
    else target[parts.at(-1)] = clone(value);
}
function collection() {
    const docs = [];
    const apply = (doc, update) => {
        for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
        for (const [key, value] of Object.entries(update.$inc || {})) setPath(doc, key, (at(doc, key) || 0) + value);
        for (const [key, value] of Object.entries(update.$push || {})) setPath(doc, key, [...(at(doc, key) || []), value]);
        for (const key of Object.keys(update.$unset || {})) setPath(doc, key, null, true);
    };
    return { docs,
        async findOne(query) { return clone(docs.find((doc) => matches(doc, query)) || null); },
        async insertOne(doc) { docs.push(clone(doc)); return { insertedId: doc._id }; },
        async updateOne(query, update) {
            const doc = docs.find((doc) => matches(doc, query));
            if (!doc) return { matchedCount: 0 };
            apply(doc, update); return { matchedCount: 1 };
        },
        async findOneAndUpdate(query, update) {
            const doc = docs.find((doc) => matches(doc, query));
            if (!doc) return null;
            apply(doc, update); return clone(doc);
        },
        async updateMany(query, update) {
            const found = docs.filter((doc) => matches(doc, query));
            found.forEach((doc) => apply(doc, update)); return { matchedCount: found.length };
        },
        async createIndex() {},
    };
}
function harness() {
    const state = { collections: {}, users: new Map(), passwords: new Map(), hashes: new Map(), logs: [], writes: [], revocations: [],
        cacheDeleted: [], beforePassword: null, beforeCredentialCas: null, beforeRevoke: null };
    const db = { collection: (name) => state.collections[name] ||= collection() };
    const userColl = db.collection('oi33_user');
    const policy = load('model/enrollment-policy.ts');
    const enrollment = load('model/enrollment.ts', { hydrooj: { db }, './user': { userColl },
        './log': { addLog: async (entry) => state.logs.push(clone(entry)) }, './enrollment-policy': policy });
    const PRIV = { PRIV_ALL: 0x400, PRIV_DEFAULT: 7, PRIV_JUDGE: 0x100 };
    class ForbiddenError extends Error {}
    const credentials = db.collection('user');
    const credentialCas = credentials.findOneAndUpdate;
    credentials.findOneAndUpdate = async (query, update, options) => {
        if (state.beforeCredentialCas) await state.beforeCredentialCas(query, update);
        const changed = await credentialCas(query, update, options);
        if (changed) {
            const password = state.hashes.get(changed.hash);
            assert.equal(typeof password, 'string');
            state.writes.push({ uid: changed._id, password });
            state.passwords.set(changed._id, password);
        }
        return changed;
    };
    const service = load('model/account-password.ts', {
        hydrooj: { db, PRIV, ForbiddenError,
            pwsh: async (password, salt) => {
                if (state.beforePassword) await state.beforePassword(password, salt);
                const hash = `test-native-hash-${salt}`;
                state.hashes.set(hash, password);
                return hash;
            },
            UserModel: {
                getById: async (_domain, uid) => state.users.get(uid) || null,
                setPassword: async () => { throw new Error('Reset must use a fenced credential update, not unconditional native setPassword'); },
                _deleteUserCache: (user) => state.cacheDeleted.push(user._id),
            },
            TokenModel: { delByUid: async (uid) => {
                if (state.beforeRevoke) await state.beforeRevoke(uid);
                state.revocations.push(uid);
                const tokens = db.collection('token').docs;
                for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].uid === uid) tokens.splice(i, 1);
            } },
        }, './enrollment': enrollment, './enrollment-policy': policy, './user': { userColl },
        './log': { addLog: async (entry) => state.logs.push(clone(entry)) },
    });
    const admin = { _id: 1, role: 'default', hasPriv: (priv) => priv === PRIV.PRIV_ALL };
    const addStudent = async (uid = 45, changes = {}) => {
        state.users.set(uid, { _id: uid, role: 'default', realname_flag: 1, priv: PRIV.PRIV_DEFAULT, hasPriv: () => false,
            ...changes.user });
        state.passwords.set(uid, 'original-student-password');
        await credentials.insertOne({ _id: uid, uname: `student-${uid}`, mail: `student-${uid}@example.test`,
            salt: `original-salt-${uid}`, hash: `original-hash-${uid}`, hashType: 'hydro', priv: PRIV.PRIV_DEFAULT });
        await db.collection('oi33_enrollment').insertOne({ _id: uid, domainId: 'system', enabled: true, accountType: 'regular',
            status: 'approved', realName: '测试学生', revision: 3, history: [], contestScopes: [], ...changes.enrollment });
        await userColl.insertOne({ _id: uid, realname_flag: 1, ...changes.legacy });
        await db.collection('domain.user').insertOne({ _id: `system:${uid}`, domainId: 'system', uid, role: 'default' });
        return uid;
    };
    return { state, db, enrollment, service, admin, addStudent, PRIV, ForbiddenError };
}

test('account administrator authority is global: ordinary, coach and domain root cannot manage passwords', () => {
    const { service, admin, PRIV } = harness();
    for (const user of [null, {}, { _id: 0, realname_flag: 3 }, { _id: 10 }, { _id: 10, role: 'coach' },
        { _id: 10, role: 'root' }, { _id: 10, realname_flag: 1 }, { _id: 10, hasPriv: (p) => p === PRIV.PRIV_JUDGE }]) {
        assert.equal(service.isAccountAdmin(user), false);
    }
    for (const user of [admin, { _id: 2, realname_flag: 2 }, { _id: 3, realname_flag: 3 }]) {
        assert.equal(service.isAccountAdmin(user), true);
    }
});

test('reset permits only another enabled same-domain regular student, independent of review status', async () => {
    for (const status of ['pending', 'approved', 'rejected']) {
        const h = harness(); await h.addStudent(45, { enrollment: { status } });
        assert.equal(await h.service.canResetStudentPassword('system', 45, h.admin), true);
    }
    for (const changes of [
        { enrollment: { domainId: 'other' } }, { enrollment: { enabled: false } }, { enrollment: { accountType: 'temporary' } },
        { user: { role: 'coach' } }, { user: { role: 'root' } }, { user: { role: 'custom-manager' } },
        { legacy: { realname_flag: 2 } }, { user: { realname_flag: 3 }, legacy: { realname_flag: 3 } },
        { user: { priv: 0x100 } }, { user: { priv: 0x400, hasPriv: () => true } }, { user: { priv: undefined } },
    ]) {
        const h = harness(); await h.addStudent(45, changes);
        assert.equal(await h.service.canResetStudentPassword('system', 45, h.admin), false, JSON.stringify(changes));
        await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), h.ForbiddenError);
        assert.equal(h.state.writes.length, 0);
        assert.equal(h.state.revocations.length, 0);
    }
    const h = harness(); await h.addStudent(45);
    for (const uid of [0, -1, NaN, '45', 46]) assert.equal(await h.service.canResetStudentPassword('system', uid, h.admin), false);
    assert.equal(await h.service.canResetStudentPassword('system', 45, { ...h.admin, _id: 45 }), false);
    assert.equal(await h.service.canResetStudentPassword('system', 45, { _id: 2, role: 'root' }), false);
    await h.db.collection('domain.user').insertOne({ uid: 45, domainId: 'other', role: 'coach' });
    assert.equal(await h.service.canResetStudentPassword('system', 45, h.admin), false, 'staff in another domain are not ordinary students');
});

test('fresh-login ordinary-student classification rejects extra global powers and staff membership in any domain', async () => {
    const h = harness(); await h.addStudent();
    assert.equal(await h.service.isOrdinaryStudentAccount('system', 45), true);
    assert.equal(await h.service.isOrdinaryStudentAccount('system', 999), false);
    for (const priv of [h.PRIV.PRIV_JUDGE, h.PRIV.PRIV_DEFAULT | h.PRIV.PRIV_JUDGE, h.PRIV.PRIV_ALL, undefined, -1]) {
        h.state.users.get(45).priv = priv;
        assert.equal(await h.service.isOrdinaryStudentAccount('system', 45), false);
    }
    h.state.users.get(45).priv = h.PRIV.PRIV_DEFAULT;
    for (const role of ['coach', 'root', 'custom-staff']) {
        const membership = { uid: 45, domainId: 'another-domain', role };
        await h.db.collection('domain.user').insertOne(membership);
        assert.equal(await h.service.isOrdinaryStudentAccount('system', 45), false);
        h.db.collection('domain.user').docs.pop();
    }
    await h.db.collection('oi33_user').updateOne({ _id: 45 }, { $set: { realname_flag: 2 } });
    assert.equal(await h.service.isOrdinaryStudentAccount('system', 45), false);
});

test('password reset gates access before writing, revokes core and addon credentials, and preserves identity and teaching data', async () => {
    const h = harness(); await h.addStudent(45); await h.addStudent(46);
    const before = await h.enrollment.getEnrollment(45);
    for (const collectionName of ['oi33_token', 'oi33_oauth_token', 'oi33_oauth_refresh']) {
        await h.db.collection(collectionName).insertOne({ uid: 45, isActive: true });
        await h.db.collection(collectionName).insertOne({ uid: 46, isActive: true });
    }
    await h.db.collection('oi33_oauth_code').insertOne({ uid: 45, consumed: false });
    await h.db.collection('oi33_oauth_code').insertOne({ uid: 46, consumed: false });
    for (const type of ['session', 'lost-password', 'sudo', 'api']) await h.db.collection('token').insertOne({ uid: 45, type });
    await h.db.collection('token').insertOne({ uid: 46, type: 'session' });
    const memberships = clone(h.db.collection('domain.user').docs);
    h.state.beforePassword = async () => {
        const current = await h.enrollment.getEnrollment(45);
        assert.equal(current.requiresPasswordChange, true);
        assert.equal(current.passwordReset.state, 'working');
        assert.equal(h.state.revocations.length, 1);
    };
    const result = await h.service.resetStudentPassword('system', 45, 3, h.admin);
    assert.equal(h.state.passwords.get(45), '123456');
    assert.equal(h.state.passwords.get(46), 'original-student-password');
    assert.equal(result.requiresPasswordChange, true);
    assert.equal(result.revision, 4);
    assert.equal(result.passwordReset.state, 'ready');
    assert.equal(result.passwordReset.operator, 1);
    for (const key of ['_id', 'domainId', 'realName', 'status', 'accountType', 'enabled', 'contestScopes']) assert.deepEqual(result[key], before[key]);
    assert.deepEqual(h.db.collection('domain.user').docs, memberships);
    assert.deepEqual(h.state.revocations, [45, 45]);
    assert.deepEqual(h.state.cacheDeleted, [45]);
    const credentials = await h.db.collection('user').findOne({ _id: 45 });
    assert.equal(credentials.hashType, 'hydro');
    assert.match(credentials.salt, /^[a-f\d]{64}$/);
    assert.equal(h.state.hashes.get(credentials.hash), '123456');
    assert.deepEqual(h.db.collection('token').docs, [{ uid: 46, type: 'session' }]);
    for (const name of ['oi33_token', 'oi33_oauth_token', 'oi33_oauth_refresh']) {
        assert.equal((await h.db.collection(name).findOne({ uid: 45 })).isActive, false);
        assert.equal((await h.db.collection(name).findOne({ uid: 46 })).isActive, true);
    }
    assert.equal((await h.db.collection('oi33_oauth_code').findOne({ uid: 45 })).consumed, true);
    assert.equal((await h.db.collection('oi33_oauth_code').findOne({ uid: 46 })).consumed, false);
    assert.ok(h.state.logs.some((entry) => entry.action === 'enrollment_password_reset' && entry.operator === 1 && entry.userId === 45));
    assert.doesNotMatch(JSON.stringify({ result, logs: h.state.logs }), /123456|original-student-password/);
});

test('stale and racing reset requests never write a password twice', async () => {
    const h = harness(); await h.addStudent();
    await assert.rejects(h.service.resetStudentPassword('system', 45, 2, h.admin), /已更新/);
    assert.equal(h.state.writes.length, 0);
    const results = await Promise.allSettled([
        h.service.resetStudentPassword('system', 45, 3, h.admin), h.service.resetStudentPassword('system', 45, 3, h.admin),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(h.state.writes.length, 1);
    assert.equal((await h.enrollment.getEnrollment(45)).revision, 4);
    await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), /已更新/);
});

test('failed credential reset stays gated, does not leak an upstream error, and is retryable with the current revision', async () => {
    for (const stage of ['revoke', 'password']) {
        const h = harness(); await h.addStudent();
        h.state[stage === 'revoke' ? 'beforeRevoke' : 'beforePassword'] = async () => { throw new Error('RAW-PASSWORD-SECRET'); };
        await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), (error) => !error.message.includes('RAW-PASSWORD-SECRET'));
        const failed = await h.enrollment.getEnrollment(45);
        assert.equal(failed.requiresPasswordChange, true);
        assert.equal(failed.passwordReset.state, 'failed');
        assert.equal(failed.revision, 4);
        assert.doesNotMatch(JSON.stringify({ failed, logs: h.state.logs }), /RAW-PASSWORD-SECRET|123456/);
        h.state.beforeRevoke = null; h.state.beforePassword = null;
        const retried = await h.service.resetStudentPassword('system', 45, 4, h.admin);
        assert.equal(retried.requiresPasswordChange, true);
        assert.equal(retried.passwordReset.state, 'ready');
        assert.equal(retried.revision, 5);
    }
});

test('password completion requires the pre-change revision and cannot clear a newer reset or an unfinished reset', async () => {
    const h = harness(); await h.addStudent(45, { enrollment: { requiresPasswordChange: true } });
    await h.enrollment.completeEnrollmentPasswordChange(45);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    await h.enrollment.completeEnrollmentPasswordChange(45, 2);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    await h.db.collection('oi33_enrollment').updateOne({ _id: 45 }, { $set: { passwordReset: { state: 'working' } } });
    await h.enrollment.completeEnrollmentPasswordChange(45, 3);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    await h.db.collection('oi33_enrollment').updateOne({ _id: 45 }, { $set: { passwordReset: { state: 'ready' }, revision: 4 } });
    await h.enrollment.completeEnrollmentPasswordChange(45, 3);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    await h.enrollment.completeEnrollmentPasswordChange(45, 4);
    const completed = await h.enrollment.getEnrollment(45);
    assert.equal(completed.requiresPasswordChange, false);
    assert.equal(completed.revision, 5);
    assert.equal(completed.history.at(-1).action, 'password_changed');
    await h.enrollment.completeEnrollmentPasswordChange(45, 4);
    assert.equal((await h.enrollment.getEnrollment(45)).revision, 5);
});

test('password changes and administrator resets share one lease; wrong-owner release or completion cannot bypass it', async () => {
    const h = harness(); await h.addStudent(45, { enrollment: { requiresPasswordChange: true } });
    assert.equal(await h.service.acquirePasswordChange(999), null);
    const lease = await h.service.acquirePasswordChange(45);
    assert.equal(lease.revision, 3);
    assert.equal(lease.requiresPasswordChange, true);
    assert.match(lease.id, /^[0-9a-f]{32}$/);
    await assert.rejects(h.service.acquirePasswordChange(45), /正在更新|已改变/);
    await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), /已更新|正在重置/);
    assert.equal(h.state.writes.length, 0);
    await h.service.releasePasswordChange(45, 'not-the-current-lock');
    assert.equal((await h.enrollment.getEnrollment(45)).passwordOperation.id, lease.id);
    await h.enrollment.completeEnrollmentPasswordChange(45, 3, 'not-the-current-lock');
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    await h.enrollment.completeEnrollmentPasswordChange(45, 3, lease.id);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, false);
    await h.service.releasePasswordChange(45, lease.id);
    assert.equal((await h.enrollment.getEnrollment(45)).passwordOperation, undefined);
    await h.service.resetStudentPassword('system', 45, 4, h.admin);
    assert.equal(h.state.writes.length, 1);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
});

test('unfinished administrator resets block student changes and recover only with a fresh revision after lease expiry', async () => {
    const h = harness(); await h.addStudent(45, { enrollment: { requiresPasswordChange: true,
        passwordReset: { id: 'old-reset', state: 'working', leaseUntil: new Date(Date.now() + 60000) },
        passwordOperation: { id: 'old-reset', kind: 'reset', leaseUntil: new Date(Date.now() + 60000) } } });
    await assert.rejects(h.service.acquirePasswordChange(45), /正在重置/);
    await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), /已更新|正在重置/);
    assert.equal(h.state.writes.length, 0);
    await h.db.collection('oi33_enrollment').updateOne({ _id: 45 }, { $set: {
        'passwordReset.leaseUntil': new Date(Date.now() - 1000), 'passwordOperation.leaseUntil': new Date(Date.now() - 1000),
    } });
    const recovered = await h.service.resetStudentPassword('system', 45, 3, h.admin);
    assert.equal(recovered.revision, 4);
    assert.equal(recovered.passwordReset.state, 'ready');
    assert.notEqual(recovered.passwordReset.id, 'old-reset');
    await h.service.releasePasswordChange(45, 'old-reset');
    assert.equal((await h.enrollment.getEnrollment(45)).passwordReset.id, recovered.passwordReset.id);
});

test('a slow reset hash or delayed credential CAS cannot overwrite a newer reset and successful student password change', async () => {
    for (const stage of ['hash', 'credential-cas']) {
    const h = harness(); await h.addStudent();
    let signalEntered, signalResume;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const resume = new Promise((resolve) => { signalResume = resolve; });
    let attempts = 0;
    h.state[stage === 'hash' ? 'beforePassword' : 'beforeCredentialCas'] = async () => {
        if (++attempts === 1) { signalEntered(); await resume; }
    };
    const stale = h.service.resetStudentPassword('system', 45, 3, h.admin);
    await entered;
    await h.db.collection('oi33_enrollment').updateOne({ _id: 45 }, { $set: {
        'passwordReset.leaseUntil': new Date(Date.now() - 1000), 'passwordOperation.leaseUntil': new Date(Date.now() - 1000),
    } });
    const newer = await h.service.resetStudentPassword('system', 45, 4, h.admin);
    assert.equal(newer.revision, 5);
    const change = await h.service.acquirePasswordChange(45);
    h.state.passwords.set(45, 'new-user-password');
    await h.db.collection('user').updateOne({ _id: 45 }, { $set: { salt: 'new-student-salt', hash: 'new-student-hash' } });
    await h.enrollment.completeEnrollmentPasswordChange(45, change.revision, change.id);
    await h.service.releasePasswordChange(45, change.id);
    assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, false);
    signalResume();
    await assert.rejects(stale, /未完成/);
    const final = await h.enrollment.getEnrollment(45);
    assert.equal(h.state.passwords.get(45), 'new-user-password');
    assert.equal((await h.db.collection('user').findOne({ _id: 45 })).hash, 'new-student-hash');
    assert.equal(final.requiresPasswordChange, false, 'a failed stale CAS must not undo the completed student change');
    assert.equal(final.revision, 6);
    assert.equal(final.passwordReset.id, newer.passwordReset.id, 'stale failure does not overwrite the current reset metadata');
    assert.equal(final.passwordOperation, undefined);
    assert.equal(h.state.writes.length, 1, 'only the newer reset writes credentials; the stale writer loses CAS');
    assert.equal(h.state.cacheDeleted.length, 1);
    assert.doesNotMatch(JSON.stringify(h.state.logs), /123456|new-user-password/);
    }
});

test('credential CAS refuses concurrent password or privilege changes without overwriting them', async () => {
    for (const update of [{ hash: 'newer-external-password-hash' }, { salt: 'newer-external-password-salt' },
        { hashType: 'other-authentication-scheme' }, { priv: 0x100 }]) {
        const h = harness(); await h.addStudent();
        h.state.beforePassword = async () => { await h.db.collection('user').updateOne({ _id: 45 }, { $set: update }); };
        await assert.rejects(h.service.resetStudentPassword('system', 45, 3, h.admin), /未完成/);
        const credentials = await h.db.collection('user').findOne({ _id: 45 });
        for (const [key, value] of Object.entries(update)) assert.equal(credentials[key], value);
        assert.equal(h.state.writes.length, 0);
        assert.equal(h.state.cacheDeleted.length, 0);
        assert.equal((await h.enrollment.getEnrollment(45)).requiresPasswordChange, true);
    }
});

test('legacy core credentials without hashType can reset but missing credentials fail before gating or revoking', async () => {
    const h = harness(); await h.addStudent();
    await h.db.collection('user').updateOne({ _id: 45 }, { $unset: { hashType: '' } });
    await h.service.resetStudentPassword('system', 45, 3, h.admin);
    assert.equal((await h.db.collection('user').findOne({ _id: 45 })).hashType, 'hydro');
    const missing = harness(); await missing.addStudent();
    await missing.db.collection('user').updateOne({ _id: 45 }, { $unset: { hash: '' } });
    await assert.rejects(missing.service.resetStudentPassword('system', 45, 3, missing.admin), /未进行密码重置/);
    assert.equal((await missing.enrollment.getEnrollment(45)).revision, 3);
    assert.equal(missing.state.revocations.length, 0);
    assert.equal(missing.state.writes.length, 0);
});
