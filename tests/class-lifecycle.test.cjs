const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { ObjectId } = require('mongodb');
const root = path.resolve(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));
function compile(file, require) {
    const module = { exports: {} };
    const code = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), {
        loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code;
    vm.runInNewContext(code, { module, exports: module.exports, require, Date, Set, Object, Number, Error });
    return module.exports;
}
const policy = compile('model/education-policy.ts', () => { throw Error('unexpected import'); });
const same = (a, b) => a instanceof ObjectId ? a.equals(b) : a === b;
const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
        return Object.entries(expected).every(([op, value]) => {
            if (op === '$in') return (Array.isArray(actual) ? actual : [actual]).some((item) => value.some((entry) => same(item, entry)));
            if (op === '$all') return value.every((item) => actual?.includes(item));
            if (op === '$size') return Array.isArray(actual) && actual.length === value;
            if (op === '$gt') return actual > value;
            throw Error(op);
        });
    }
    return same(actual, expected);
};
const matches = (row, query) => Object.entries(query).every(([key, value]) => key === '$or'
    ? value.some((item) => matches(row, item)) : matchesValue(row[key], value));
function harness() {
    const id = new ObjectId();
    const collections = {
        'user.group': [{ _id: id, domainId: 'school', name: '周日班', uids: [17, 18] },
            { _id: new ObjectId(), domainId: 'other', name: '周日班', uids: [19] }],
        document: [], domain: [], oi33_education_preview: [], oi33_account_batch: [],
        oi33_education_roster: [{ domainId: 'school', groups: ['周日班'], entries: [{ uid: 17, score: 100 }], revision: 4 }],
    };
    const writes = [], logs = [], invalidations = [];
    const hooks = {};
    const coll = (name) => ({
        find(query) {
            return { project() { return this; }, async toArray() { return collections[name].filter((row) => matches(row, query)); } };
        },
        async findOne(query) { return collections[name].find((row) => matches(row, query)) || null; },
        async createIndex(key, options) { assert.equal(options.unique, true); return 'name'; },
        async updateOne(query, update, options) {
            await hooks.beforeUpdate?.();
            assert.equal(options?.upsert, undefined);
            const row = collections[name].find((entry) => matches(entry, query));
            if (!row) return { matchedCount: 0 };
            if (name === 'user.group' && update.$set?.name && collections[name].some((entry) => entry !== row
                && entry.domainId === row.domainId && entry.name === update.$set.name)) {
                throw Object.assign(new Error('duplicate key'), { code: 11000 });
            }
            Object.assign(row, update.$set);
            writes.push({ name, query, update });
            return { matchedCount: 1 };
        },
        async deleteOne(query) {
            await hooks.beforeDelete?.();
            const index = collections[name].findIndex((entry) => matches(entry, query));
            if (index < 0) return { deletedCount: 0 };
            collections[name].splice(index, 1); writes.push({ name, query, deleted: true }); return { deletedCount: 1 };
        },
    });
    class ValidationError extends Error { constructor(...parts) { super(parts.filter(Boolean).join(' ')); } }
    const hydro = {
        db: { collection: coll }, ObjectId, ValidationError, ForbiddenError: class extends Error {},
        Handler: class {}, Context: class {}, param: () => () => {}, Types: {}, PERM: {}, PRIV: { PRIV_ALL: -1 },
        DomainModel: { coll: coll('domain') },
        UserModel: { collGroup: coll('user.group'), _deleteUserCache: (domain) => invalidations.push(domain),
            listGroup: async (domain) => collections['user.group'].filter((row) => row.domainId === domain) },
    };
    const model = compile('model/education.ts', (name) => {
        if (name === 'crypto') return require('node:crypto');
        if (name === 'hydrooj') return hydro;
        if (name.endsWith('log')) return { addLog: async (entry) => logs.push(entry) };
        if (name.endsWith('education-policy')) return policy;
        if (name.endsWith('enrollment')) return { enrollmentColl: {} };
        throw Error(name);
    });
    const auth = compile('model/education-auth.ts', (name) => { if (name === 'hydrooj') return hydro; throw Error(name); });
    const handler = compile('handler/education.ts', (name) => {
        if (name === 'hydrooj') return hydro;
        if (name.endsWith('education-auth')) return auth;
        if (name.endsWith('education-policy')) return policy;
        if (name === '../model/education') return model;
        if (name.endsWith('enrollment')) return { enrollmentColl: {} };
        if (name.endsWith('user')) return { userColl: {} };
        throw Error(name);
    });
    return { model, handler, collections, writes, logs, invalidations, hooks, id, hydro };
}

test('rename preserves group identity and members, historical roster and other domains', async () => {
    const h = harness(), history = plain(h.collections.oi33_education_roster);
    await h.model.renameClassGroup('school', h.id, ' 周日班 ', ' 周日提高班 ', 2, [18, 17]);
    const row = h.collections['user.group'][0];
    assert.equal(row._id.toHexString(), h.id.toHexString());
    assert.equal(row.name, '周日提高班'); assert.deepEqual(row.uids, [17, 18]);
    assert.equal(h.collections['user.group'][1].name, '周日班');
    assert.deepEqual(plain(h.collections.oi33_education_roster), history);
    assert.deepEqual(h.invalidations, ['school']);
    assert.equal(h.logs[0].action, 'class_rename');
});

test('rename rejects illegal or duplicate names and does not overwrite a same-name group', async () => {
    const h = harness();
    for (const name of ['', '123', 'a,b', 'a，b', '<script>', 'x'.repeat(81)]) {
        await assert.rejects(h.model.renameClassGroup('school', h.id, '周日班', name, 2, [17, 18]));
    }
    h.collections['user.group'].push({ _id: new ObjectId(), domainId: 'school', name: '提高班', uids: [30] });
    await assert.rejects(h.model.renameClassGroup('school', h.id, '周日班', '提高班', 2, [17, 18]), /同名班型/);
    assert.equal(h.collections['user.group'][0].name, '周日班');
    assert.deepEqual(h.collections['user.group'][2].uids, [30]);
    assert.equal(h.writes.length, 0);
});

test('delete requires explicit server confirmation and leaves students, documents and history untouched', async () => {
    const h = harness(), history = plain(h.collections.oi33_education_roster);
    for (const confirmation of [undefined, false, 'true', 1]) {
        await assert.rejects(h.model.deleteClassGroup('school', h.id, '周日班', 2, [17, 18], confirmation), /确认删除/);
    }
    await h.model.deleteClassGroup('school', h.id, '周日班', 2, [17, 18], true);
    assert.equal(h.collections['user.group'].length, 1);
    assert.equal(h.collections['user.group'][0].domainId, 'other');
    assert.deepEqual(plain(h.collections.oi33_education_roster), history);
    assert.deepEqual(h.writes.map((entry) => entry.name), ['user.group']);
    assert.equal(h.logs[0].action, 'class_delete');
});

test('rename and delete reject stale identity, missing snapshot, foreign domain and concurrent membership changes', async () => {
    for (const operation of ['rename', 'delete']) {
        const h = harness();
        const run = (domain = 'school', id = h.id, snapshot = [17, 18]) => operation === 'rename'
            ? h.model.renameClassGroup(domain, id, '周日班', '新班型', 2, snapshot)
            : h.model.deleteClassGroup(domain, id, '周日班', 2, snapshot, true);
        await assert.rejects(run('other'));
        await assert.rejects(run('school', new ObjectId()));
        await assert.rejects(run('school', h.id, [17]));
        await assert.rejects(operation === 'rename' ? h.model.renameClassGroup('school', h.id, '周日班', '新班型', 2)
            : h.model.deleteClassGroup('school', h.id, '周日班', 2, undefined, true));
        h.hooks[operation === 'rename' ? 'beforeUpdate' : 'beforeDelete'] = () => { h.collections['user.group'][0].uids = [17]; };
        await assert.rejects(run(), /名单已变化/);
        assert.equal(h.writes.length, 0);
        assert.equal(h.collections['user.group'][0].name, '周日班');
    }
});

test('a concurrently recreated same-name roster cannot be renamed or deleted by the old form', async () => {
    for (const operation of ['rename', 'delete']) {
        const h = harness(), replacementId = new ObjectId();
        h.hooks[operation === 'rename' ? 'beforeUpdate' : 'beforeDelete'] = () => {
            h.collections['user.group'][0] = { _id: replacementId, domainId: 'school', name: '周日班', uids: [17, 18] };
        };
        await assert.rejects(operation === 'rename'
            ? h.model.renameClassGroup('school', h.id, '周日班', '新班型', 2, [17, 18])
            : h.model.deleteClassGroup('school', h.id, '周日班', 2, [17, 18], true), /班型已删除、改名或名单已变化/);
        assert.equal(h.collections['user.group'][0]._id.toHexString(), replacementId.toHexString());
        assert.equal(h.collections['user.group'][0].name, '周日班');
        assert.equal(h.writes.length, 0);
    }
});

test('reference counts cover native document access, domain join settings and actionable drafts only, scoped by domain', async () => {
    const h = harness(), future = new Date(Date.now() + 60000), past = new Date(0);
    h.collections.document.push({ domainId: 'school', docType: 30, assign: ['周日班', '周日班'] },
        { domainId: 'school', docType: 20, assign: ['周日班'] }, { domainId: 'other', assign: ['周日班'] });
    h.collections.domain.push({ _id: 'school', _join: { group: '周日班' } }, { _id: 'other', _join: { group: '周日班' } });
    h.collections.oi33_education_preview.push({ domainId: 'school', groups: ['周日班'], expiresAt: future },
        { domainId: 'school', groups: ['周日班'], expiresAt: past }, { domainId: 'other', groups: ['周日班'], expiresAt: future });
    h.collections.oi33_account_batch.push(...[
        ['preview', future], ['preview', past], ['completed', future], ['partial', past], ['processing', past],
    ].map(([status, expiresAt]) => ({ domainId: 'school', status, expiresAt, groups: ['周日班'] })));
    const refs = plain(await h.model.getClassReferenceSummaries('school', ['周日班', '__proto__', 'undefined']));
    assert.deepEqual(refs['周日班'], { documents: 2, joinSettings: 1, previews: 1, batches: 3, total: 7 });
    assert.equal(refs.__proto__.total, 0);
    assert.equal(refs.undefined.total, 0, 'Missing domain configuration must not become a literal class-name match');
    assert.equal(h.writes.length, 0);
    await assert.rejects(h.model.renameClassGroup('school', h.id, '周日班', '新班型', 2, [17, 18]), /作业、比赛或讨论 2 项.*入域设置 1 项.*作业名单预览 1 项.*账号导入批次 3 项/);
    await assert.rejects(h.model.deleteClassGroup('school', h.id, '周日班', 2, [17, 18], true), /仍被引用/);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.collections.document[0].assign, ['周日班', '周日班'], 'Never pull access keys into an empty/public assignment');
});

test('rename rejects a destination name with dangling access or actionable import references', async () => {
    for (const [collection, row] of [
        ['document', { domainId: 'school', assign: ['历史已删班型'] }],
        ['domain', { _id: 'school', _join: { group: '历史已删班型' } }],
        ['oi33_education_preview', { domainId: 'school', groups: ['历史已删班型'], expiresAt: new Date(Date.now() + 60000) }],
        ['oi33_account_batch', { domainId: 'school', groups: ['历史已删班型'], status: 'processing', expiresAt: new Date(0) }],
    ]) {
        const h = harness(); h.collections[collection].push(row);
        assert.equal(h.collections['user.group'].some((group) => group.name === '历史已删班型'), false);
        await assert.rejects(h.model.renameClassGroup('school', h.id, '周日班', '历史已删班型', 2, [17, 18]), /新班型名称仍被引用/);
        assert.equal(h.collections['user.group'][0].name, '周日班');
        assert.equal(h.writes.length, 0);
    }
});

test('each individual reference category blocks both operations, while expired drafts and history do not', async () => {
    const future = new Date(Date.now() + 60000);
    const cases = [
        ['document', { domainId: 'school', assign: ['周日班'] }],
        ['domain', { _id: 'school', joinSettings: { group: '周日班' } }],
        ['oi33_education_preview', { domainId: 'school', groups: ['周日班'], expiresAt: future }],
        ['oi33_account_batch', { domainId: 'school', groups: ['周日班'], status: 'partial', expiresAt: new Date(0) }],
    ];
    for (const [collection, row] of cases) {
        const h = harness(); h.collections[collection].push(row);
        await assert.rejects(h.model.renameClassGroup('school', h.id, '周日班', '新班型', 2, [17, 18]), /仍被引用/);
        await assert.rejects(h.model.deleteClassGroup('school', h.id, '周日班', 2, [17, 18], true), /仍被引用/);
        assert.equal(h.writes.length, 0);
    }
    const h = harness();
    h.collections.oi33_education_preview.push({ domainId: 'school', groups: ['周日班'], expiresAt: new Date(0) });
    h.collections.oi33_account_batch.push({ domainId: 'school', groups: ['周日班'], status: 'preview', expiresAt: new Date(0) });
    await h.model.renameClassGroup('school', h.id, '周日班', '新班型', 2, [17, 18]);
    assert.equal(h.collections['user.group'][0].name, '新班型');
});

test('class lifecycle handlers use existing teacher/admin prepare guard and preserve empty roster snapshots', async () => {
    const h = harness(), Handler = h.handler.EducationClassesHandler;
    const instance = new Handler();
    Object.assign(instance, { user: { _id: 17, role: 'default' }, response: { addHeader() {} },
        request: { body: { originalUids: '' } }, url: () => '/oi33/education/classes' });
    await assert.rejects(instance.prepare(), h.hydro.ForbiddenError);
    for (const user of [{ _id: 3, role: 'coach' }, { _id: 2, realname_flag: 3 }]) {
        instance.user = user; await instance.prepare();
    }
    h.collections['user.group'][0].uids = [];
    await instance.postRename('school', h.id, '周日班', '空班型', undefined);
    assert.equal(instance.response.redirect, '/oi33/education/classes');
    assert.equal(h.collections['user.group'][0].name, '空班型');
    await assert.rejects(instance.postDelete('school', h.id, '空班型', undefined, false), /确认删除/);
    await instance.postDelete('school', h.id, '空班型', undefined, true);
    assert.equal(h.collections['user.group'].length, 1);
});
