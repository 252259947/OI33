const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const transformed = esbuild.transformSync(fs.readFileSync(path.join(root, 'model/education-policy.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const exportsHolder = { exports: {} };
vm.runInNewContext(transformed, { module: exportsHolder, exports: exportsHolder.exports, Date, Set, Number, Error });
const policy = exportsHolder.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('class targeting is OR union, deduplicates students and rejects invalid UIDs', () => {
    assert.deepEqual(plain(policy.classUnion([{ uids: [1, 2] }, { uids: [2, 3, -1, 0, 2.5] }])), [1, 2, 3]);
});

test('teaching membership requires a joined domain row or same-domain enrollment, not a virtual guest', () => {
    const scope = policy.classifyTeachingStudents('school-a', [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5],
        [{ uid: 1, domainId: 'school-a', join: true }, { uid: 2, domainId: 'school-b', join: true },
            { uid: 4, domainId: 'school-a', join: true }, { uid: 5, domainId: 'school-a', join: false }],
        [{ _id: 2, domainId: 'school-b', accountType: 'regular' }, { _id: 3, domainId: 'school-a', accountType: 'regular' },
            { _id: 4, domainId: 'school-a', accountType: 'temporary' }]);
    assert.deepEqual(plain(scope.eligible), [1, 3]);
    assert.deepEqual(plain(scope.inDomain), [1, 3, 4]);
    assert.deepEqual(plain(scope.outside), [2, 5]);
    assert.deepEqual(plain(scope.temporary), [4]);
    assert.deepEqual(plain(scope.missing), [6]);
});

function scopedModelHarness() {
    const writes = [];
    const identityQueries = [];
    const users = [1, 2, 3, 4, 5].map((_id) => ({ _id, uname: `user${_id}` }));
    const memberships = [{ domainId: 'system', uid: 1, join: true }, { domainId: 'other', uid: 2, join: true },
        { domainId: 'system', uid: 4, join: true }, { domainId: 'system', uid: 5, join: false }];
    const enrollments = [{ _id: 2, domainId: 'other', accountType: 'regular', realName: 'REMOTE SECRET' },
        { _id: 3, domainId: 'system', accountType: 'regular', realName: '同域新生' },
        { _id: 4, domainId: 'system', accountType: 'temporary', realName: '临时选手' }];
    const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && '$in' in value
        ? value.$in.includes(doc[key]) : doc[key] === value);
    const cursor = (rows, filter) => ({ project() { return this; }, async toArray() { return rows.filter((row) => matches(row, filter)); } });
    const enrollmentColl = { find: (filter) => cursor(enrollments, filter) };
    const userColl = { find: (filter) => { identityQueries.push(filter); return cursor([
        { _id: 1, realname_name: '本域旧生' }, { _id: 2, realname_name: 'LEGACY REMOTE SECRET' }, { _id: 5, realname_name: 'NOT JOINED SECRET' },
    ], filter); } };
    const groups = [{ name: '正常班', uids: [1, 3] }, { name: '旧跨域班', uids: [1, 2] }, { name: '旧临时班', uids: [1, 4] }];
    const hydro = {
        db: { collection: () => ({}) }, ObjectId: class {}, ValidationError: class extends Error { constructor(...parts) { super(parts.filter(Boolean).join(' ')); } },
        Handler: class {}, Context: class {}, param: () => () => {}, Types: {}, STATUS: {}, PERM: {}, PRIV: {},
        DomainModel: { collUser: { find: (filter) => cursor(memberships, filter) } },
        UserModel: { coll: { find: (filter) => cursor(users, filter) }, listGroup: async () => groups,
            getById: async (_, uid) => users.find((user) => user._id === uid),
            getList: async (_, uids) => Object.fromEntries(users.filter((user) => uids.includes(user._id)).map((user) => [user._id, user])),
            updateGroup: async (...args) => writes.push(args), collGroup: { updateOne: async (...args) => writes.push(args) }, _deleteUserCache() {},
        },
    };
    const compile = (file, require) => {
        const module = { exports: {} };
        const js = esbuild.transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
        vm.runInNewContext(js, { module, exports: module.exports, require, Date, Set, Number, Error });
        return module.exports;
    };
    const model = compile('model/education.ts', (name) => {
        if (name === 'crypto') return require('node:crypto');
        if (name === 'hydrooj') return hydro;
        if (name.endsWith('log')) return { addLog: async () => {} };
        if (name.endsWith('education-policy')) return policy;
        if (name.endsWith('enrollment')) return { enrollmentColl };
        throw new Error(name);
    });
    const handler = compile('handler/education.ts', (name) => {
        if (name === 'hydrooj') return hydro;
        if (name.endsWith('education-auth')) return {};
        if (name.endsWith('education-policy')) return policy;
        if (name.endsWith('education')) return model;
        if (name.endsWith('enrollment')) return { enrollmentColl };
        if (name.endsWith('user')) return { userColl };
        throw new Error(name);
    });
    return { model, handler, writes, identityQueries };
}

test('class edits reject global-only/guest users and temporary students before any writes', async () => {
    const h = scopedModelHarness();
    await assert.rejects(h.model.setClassStudents('system', 'A', [2], 10), /不是本域/);
    await assert.rejects(h.model.setClassStudents('system', 'A', [5], 10), /不是本域/);
    await assert.rejects(h.model.setClassStudents('system', 'A', [4], 10), /临时比赛/);
    assert.equal(h.writes.length, 0);
    await h.model.setClassStudents('system', 'A', [1, 3], 10);
    assert.equal(h.writes.length, 1);
});

test('existing unsafe groups block homework targeting with explicit cleanup errors', async () => {
    const h = scopedModelHarness();
    assert.deepEqual(plain(await h.model.resolveClassStudents('system', ['正常班'])), [1, 3]);
    await assert.rejects(h.model.resolveClassStudents('system', ['旧跨域班']), /不是本域/);
    await assert.rejects(h.model.resolveClassStudents('system', ['旧临时班']), /临时比赛/);
});

test('temporary provisioning with no teaching groups is a true no-op', async () => {
    const h = scopedModelHarness();
    await h.model.addStudentsToGroups('system', [4], [], 10);
    assert.equal(h.writes.length, 0);
    await assert.rejects(h.model.addStudentsToGroups('system', [4], ['正常班'], 10), /临时比赛/);
});

test('legacy and enrolled real names never leak from arbitrary out-of-domain roster UIDs', async () => {
    const h = scopedModelHarness();
    const names = await h.handler.rosterNames('system', [1, 2, 3, 5]);
    assert.equal(names[1], '本域旧生');
    assert.equal(names[3], '同域新生');
    assert.match(names[2], /非本域成员/);
    assert.match(names[5], /非本域成员/);
    assert.ok(!JSON.stringify(names).includes('SECRET'));
    assert.deepEqual(plain(h.identityQueries[0]._id.$in), [1, 3]);
});

test('sync adds newcomers without removing transfers or reactivating exemptions', () => {
    const entries = [{ uid: 1, assignedAt: new Date(0) }, { uid: 2, assignedAt: new Date(0), exemptAt: new Date(1), exemptReason: '请假' }];
    const after = policy.extendRoster(entries, [2, 3], new Date(3));
    assert.deepEqual(plain(after.map((row) => row.uid)), [1, 2, 3]);
    assert.equal(+after[1].exemptAt, 1);
    assert.equal(entries.length, 2);
    assert.equal(+after[2].assignedAt, 3);
});

test('exemption requires an explanation and retains the historical roster row', () => {
    const original = [{ uid: 1, assignedAt: new Date(0) }];
    assert.throws(() => policy.exemptRoster(original, [1], ' '));
    const after = policy.exemptRoster(original, [1], ' 请假 ', new Date(9));
    assert.equal(after.length, 1);
    assert.equal(after[0].exemptReason, '请假');
    assert.equal(original[0].exemptAt, undefined);
});

test('an assigned student with no claim and no submissions remains not started', () => {
    const result = policy.homeworkProgress([1, 2], undefined, new Date(10), new Date(5));
    assert.equal(result.state, '未开始');
    assert.equal(result.claimed, false);
    assert.equal(result.attempted, 0);
    assert.equal(result.cells.length, 2);
    assert.equal(result.overdue, false);
});

test('an unclaimed student is overdue after the deadline', () => {
    const result = policy.homeworkProgress([1], undefined, new Date(10), new Date(11));
    assert.equal(result.overdue, true);
    assert.equal(result.complete, false);
});

test('completion is based on AC for every assigned problem, not numerical score or claim', () => {
    const partial = policy.homeworkProgress([1, 2], { journal: [{ pid: 1, status: 1, score: 100 }, { pid: 2, status: 2, score: 100 }, { pid: 9, status: 1 }] }, new Date(10), new Date(5));
    assert.equal(partial.completed, 1);
    assert.equal(partial.state, '进行中');
    const complete = policy.homeworkProgress([1, 2], { detail: { 1: { status: 1 }, 2: { status: 1 } } }, new Date(10), new Date(11));
    assert.equal(complete.complete, true);
    assert.equal(complete.overdue, false);
});

test('latest status and rejudged detail are respected; empty homework is not completed', () => {
    const result = policy.homeworkProgress([1], { journal: [{ pid: 1, status: 1 }], detail: { 1: { status: 2 } } }, new Date(10), new Date(5));
    assert.equal(result.complete, false);
    assert.equal(policy.homeworkProgress([], undefined, new Date(10)).complete, false);
});

test('education templates compile and every local POST form has a CSRF field', () => {
    const nunjucks = require('nunjucks');
    const files = fs.readdirSync(path.join(root, 'templates')).filter((name) => name.startsWith('oi33_education') || ['homework_edit.html', 'homework_main.html'].includes(name));
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, 'templates', file), 'utf8');
        nunjucks.compile(source, new nunjucks.Environment(), file, true);
        for (const form of source.matchAll(/<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/gi)) assert.match(form[1], /name="csrfToken"/);
    }
});

test('homework hooks guard native creation and require explicit class targets', () => {
    const handler = fs.readFileSync(path.join(root, 'handler/education.ts'), 'utf8');
    assert.match(handler, /handler\/before\/HomeworkEdit#post/);
    assert.match(handler, /assertEducationCoach\(h\.user\)/);
    assert.match(handler, /resolveClassStudents\(h\.domain\._id, names\)/);
    assert.match(handler, /handler\/after\/HomeworkEdit#post/);
    assert.match(handler, /oi33EducationDraft\?\.creating/);
    const model = fs.readFileSync(path.join(root, 'model/education.ts'), 'utf8');
    assert.match(model, /revision: preview\.baseRevision/);
    assert.match(model, /domainId, tid, operator, token, expiresAt/);
    assert.match(model, /expireAfterSeconds: 0/);
});

function hookHarness(options = {}) {
    const hooks = {};
    const routes = {};
    const snapshots = [];
    const tdoc = { docId: 'test-tid', rule: 'homework', owner: 2, maintainer: [3] };
    class ObjectId { constructor(value) { this.value = value; } toString() { return this.value; } }
    const hydro = {
        Handler: class {}, ObjectId, ForbiddenError: Error, ValidationError: Error,
        Context: class {}, param: () => () => {}, Types: {}, STATUS: { STATUS_ACCEPTED: 1 },
        PERM: { PERM_EDIT_HOMEWORK_SELF: 'self', PERM_EDIT_HOMEWORK: 'all', PERM_VIEW_HOMEWORK: 'view' },
        PRIV: { PRIV_USER_PROFILE: 1 }, ContestModel: { get: async () => tdoc },
    };
    const auth = {
        isEducationAdmin: (user) => user.role === 'root',
        isEducationCoach: (user) => ['root', 'coach'].includes(user.role),
        assertEducationCoach: (user) => { if (!['root', 'coach'].includes(user.role)) throw new Error('not coach'); },
    };
    const education = {
        ensureEducationIndexes: async () => {}, listClassGroups: async () => [{ name: 'A', uids: [5, 6] }],
        normalizeClassNames: (value) => Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean),
        resolveClassStudents: async (_, names) => { if (!names.length || names.some((name) => name !== 'A')) throw new Error('invalid groups'); return [5, 6]; },
        createHomeworkRoster: async (...args) => { if (options.failSnapshot) throw new Error('database unavailable'); snapshots.push(args); },
    };
    const js = esbuild.transformSync(fs.readFileSync(path.join(root, 'handler/education.ts'), 'utf8'), {
        loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code;
    const module = { exports: {} };
    vm.runInNewContext(js, { module, exports: module.exports, Date, Set, Number, Error, require: (name) => {
        if (name === 'hydrooj') return hydro;
        if (name.endsWith('education-auth')) return auth;
        if (name.endsWith('education-policy')) return policy;
        if (name.endsWith('education')) return education;
        if (name.endsWith('user')) return { userColl: {} };
        if (name.endsWith('enrollment')) return { enrollmentColl: {} };
        throw new Error(name);
    } });
    const ctx = { on: (name, fn) => { hooks[name] = fn; }, Route: (name, _, Klass) => { routes[name] = Klass; }, injectUI: () => {} };
    const h = (role, uid, args) => ({ args, domain: { _id: 'test' }, request: { body: {} }, response: { body: {}, headers: {}, addHeader(name, value) { this.headers[name] = value; } },
        user: { role, _id: uid, own: (doc) => doc.owner === uid || doc.maintainer.includes(uid) }, checkPerm() {} });
    return { initialize: () => module.exports.apply(ctx), hooks, routes, snapshots, h };
}

test('native homework hook actually blocks students and unrelated coaches', async () => {
    const env = hookHarness(); await env.initialize();
    await assert.rejects(env.hooks['handler/before/HomeworkEdit#post'](env.h('default', 2, { operation: 'update', classNames: ['A'] })), /not coach/);
    await assert.rejects(env.hooks['handler/before/HomeworkEdit#post'](env.h('coach', 8, { tid: 'test-tid', operation: 'update', classNames: ['A'] })), /创建者/);
    await env.hooks['handler/before/HomeworkEdit#post'](env.h('coach', 3, { tid: 'test-tid', operation: 'update', classNames: ['A'] }));
});

test('new homework requires class targets and snapshots only after a successful create', async () => {
    const env = hookHarness(); await env.initialize();
    await assert.rejects(env.hooks['handler/before/HomeworkEdit#post'](env.h('coach', 2, { operation: 'update' })), /invalid groups/);
    const h = env.h('coach', 2, { operation: 'update', classNames: ['A'] });
    await env.hooks['handler/before/HomeworkEdit#post'](h);
    assert.equal(h.args.assign, 'A');
    await env.hooks['handler/after/HomeworkEdit#post'](h);
    assert.equal(env.snapshots.length, 0);
    h.response.body.tid = 'created';
    await env.hooks['handler/after/HomeworkEdit#post'](h);
    assert.equal(env.snapshots.length, 1);
    assert.deepEqual(plain(env.snapshots[0][3]), [5, 6]);
});

test('editing a legacy homework never silently initializes or resets its roster', async () => {
    const env = hookHarness(); await env.initialize();
    const h = env.h('coach', 2, { tid: 'test-tid', operation: 'update', classNames: ['A'] });
    h.response.body.tid = 'test-tid';
    await env.hooks['handler/before/HomeworkEdit#post'](h);
    await env.hooks['handler/after/HomeworkEdit#post'](h);
    assert.equal(env.snapshots.length, 0);
});

test('snapshot failure has an explicit recovery page, not success or a duplicate create retry', async () => {
    const env = hookHarness({ failSnapshot: true }); await env.initialize();
    const h = env.h('coach', 2, { operation: 'update', classNames: ['A'] });
    await env.hooks['handler/before/HomeworkEdit#post'](h);
    h.response.body.tid = 'saved-homework'; h.response.redirect = '/homework/saved-homework';
    await env.hooks['handler/after/HomeworkEdit#post'](h);
    assert.equal(h.response.status, 503);
    assert.equal(h.response.redirect, undefined);
    assert.equal(h.response.template, 'oi33_education_recovery.html');
    assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
});

test('homework file GET and POST operations share the teacher/owner guard', async () => {
    const env = hookHarness(); await env.initialize();
    const student = env.h('default', 2, {}); student.tdoc = { owner: 2, maintainer: [], rule: 'homework' };
    await assert.rejects(env.hooks['handler/before/HomeworkFiles'](student), /not coach/);
    const otherCoach = env.h('coach', 8, {}); otherCoach.tdoc = student.tdoc;
    await assert.rejects(env.hooks['handler/before/HomeworkFiles'](otherCoach), /创建者/);
});
