const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');
const moment = require('moment-timezone');
const { ObjectId } = require('mongodb');

const root = path.resolve(__dirname, '..');
class ValidationError extends Error { constructor(...parts) { super(parts.join(' ')); } }
function compile(source, dependencies) {
    const code = transformSync(source, {
        loader: 'ts', format: 'cjs', target: 'node18', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)((name) => name in dependencies ? dependencies[name] : require(name), module, module.exports);
    return module.exports;
}
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
// Exercise the real framework decorators: an empty Content is rejected before
// core postUpdate runs, and its supported positional path is what we adapt.
const { param } = compile(read('node_modules/@hydrooj/framework/decorators.ts'), { './error': { ValidationError } });
const { Types } = compile(read('node_modules/@hydrooj/framework/validator.ts'), {});
Types.ObjectId = [(value) => new ObjectId(value), ObjectId.isValid];
const PERM = Object.fromEntries([
    'CREATE_HOMEWORK', 'EDIT_HOMEWORK_SELF', 'EDIT_HOMEWORK', 'VIEW_PROBLEM_HIDDEN', 'VIEW_HOMEWORK',
].map((key) => [`PERM_${key}`, key]));
const coreSource = read('node_modules/hydrooj/src/handler/homework.ts');
const penaltySource = coreSource.slice(coreSource.indexOf('const validatePenaltyRules'), coreSource.indexOf('class HomeworkMainHandler'));
const editorSource = coreSource.slice(coreSource.indexOf('class HomeworkEditHandler'), coreSource.indexOf('export class HomeworkFilesHandler'));

async function harness() {
    const hooks = {}, docs = new Map(), snapshots = [], checkedProblems = [], recalculated = [];
    const contest = {
        async get(_, tid) { const doc = docs.get(String(tid)); if (!doc) throw new Error('missing homework'); return { ...doc, pids: [...doc.pids] }; },
        async add(domainId, title, content, owner, rule, beginAt, endAt, pids, rated, extra) {
            const docId = new ObjectId();
            docs.set(String(docId), { domainId, docId, title, content, owner, rule, beginAt, endAt, pids, rated, ...extra });
            return docId;
        },
        async edit(_, tid, update) { Object.assign(docs.get(String(tid)), update); },
        async recalcStatus(_, tid) { recalculated.push(String(tid)); },
    };
    const problem = { async getList(_, pids) { checkedProblems.push([...pids]); if (pids.some((pid) => pid !== 1)) throw new Error('invalid problem'); return {}; } };
    class Handler {}
    const nativeDependencies = { Handler, param, Types, moment, Time: { day: 86400000 }, yaml: require('js-yaml'),
        contest, problem, PERM, ValidationError, record: {}, storage: {} };
    const nativePrefix = Object.keys(nativeDependencies).map((name) => `const ${name} = require('fixture').${name};`).join('\n');
    const { HomeworkEditHandler } = compile(`${nativePrefix}\n${penaltySource}\n${editorSource}\nexport { HomeworkEditHandler };`, { fixture: nativeDependencies });
    const education = {
        ensureEducationIndexes: async () => {},
        listClassGroups: async () => [{ name: 'A', uids: [4, 5] }, { name: 'Empty', uids: [] }],
        normalizeClassNames(value) { return Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean); },
        async resolveClassStudents(_, names) {
            if (!names.length || names.some((name) => !['A', 'Empty'].includes(name))) throw new ValidationError('班型');
            return names.includes('A') ? [4, 5] : [];
        },
        async createHomeworkRoster(...args) { snapshots.push(args); },
    };
    const auth = {
        assertEducationCoach(user) { if (!['root', 'coach'].includes(user.role)) throw new Error('not coach'); },
        isEducationCoach: (user) => ['root', 'coach'].includes(user.role),
        isEducationAdmin: (user) => user.role === 'root',
    };
    const plugin = compile(read('handler/education.ts'), {
        hydrooj: { Handler, param, Types, moment, ObjectId, PERM, ValidationError, ForbiddenError: Error, ContestModel: contest,
            PRIV: { PRIV_USER_PROFILE: 1 }, STATUS: {}, UserModel: {}, ProblemModel: problem },
        '../model/education-auth': auth, '../model/education': education, '../model/education-policy': {},
        '../model/user': { userColl: {} }, '../model/enrollment': { enrollmentColl: {} },
    });
    await plugin.apply({ on: (name, callback) => { hooks[name] = callback; }, Route() {}, injectUI() {} });
    function make(args = {}, options = {}) {
        const h = new HomeworkEditHandler();
        const permissions = new Set(options.permissions || ['CREATE_HOMEWORK', 'EDIT_HOMEWORK_SELF']);
        h.args = { domainId: 'school', ...args };
        h.domain = { _id: 'school' }; h.request = { body: { ...args } };
        h.response = { body: {}, addHeader() {} };
        h.user = { _id: options.uid || 2, role: options.role || 'coach', timeZone: options.timeZone || 'Asia/Shanghai',
            own: (doc) => doc.owner === h.user._id || doc.maintainer?.includes(h.user._id), hasPerm: (perm) => permissions.has(perm) };
        h.checkPerm = (perm) => { if (!permissions.has(perm)) throw new Error(`permission ${perm}`); };
        h.url = (_, data) => `/homework/${data.tid}`;
        return h;
    }
    async function save(h) {
        await hooks['handler/before/HomeworkEdit#post'](h);
        await h.postUpdate(h.args);
        await hooks['handler/after/HomeworkEdit#post'](h);
        return docs.get(String(h.response.body.tid));
    }
    return { hooks, plugin, docs, snapshots, checkedProblems, recalculated, make, save, HomeworkEditHandler };
}
function fields(extra = {}) {
    return { operation: 'update', title: '作业', classNames: ['A'],
        beginAtDate: '2026-9-8', beginAtTime: '0:00', penaltySinceDate: '2100-1-1', penaltySinceTime: '0:00', ...extra };
}

test('new homework defaults use the user timezone, including opposite sides of midnight', async () => {
    const env = await harness();
    const now = new Date('2026-09-08T00:30:00Z');
    assert.deepEqual(env.plugin.homeworkDefaults('Asia/Shanghai', now), {
        dateBeginText: '2026-9-8', timeBeginText: '0:00', datePenaltyText: '2100-1-1', timePenaltyText: '0:00',
    });
    assert.equal(env.plugin.homeworkDefaults('America/Los_Angeles', now).dateBeginText, '2026-9-7');
    const h = env.make();
    await h.get(h.args);
    await env.hooks['handler/after/HomeworkEdit#get'](h);
    assert.equal(h.response.body.dateBeginText, moment().tz(h.user.timeZone).format('YYYY-M-D'));
    assert.equal(h.response.body.timeBeginText, '0:00');
    assert.equal(h.response.body.datePenaltyText, '2100-1-1');
    assert.equal(h.response.body.timePenaltyText, '0:00');
    assert.equal(h.response.body.extensionDays, 0);
});

test('core rejects empty Content, while the adapter saves truly empty fields without placeholder data', async () => {
    const env = await harness();
    const native = env.make(fields({ content: '', pids: '', extensionDays: '0', penaltyRules: '{}' }));
    assert.throws(() => native.postUpdate(native.args), /content/);
    assert.equal(env.docs.size, 0);
    const doc = await env.save(native);
    assert.equal(doc.content, ''); assert.deepEqual(doc.pids, []);
    assert.equal(+doc.endAt, +doc.penaltySince); assert.deepEqual(doc.penaltyRules, {});
    assert.equal((doc.langs || []).length, 0);
    assert.equal(env.snapshots.length, 1); assert.deepEqual(env.snapshots[0][3], [4, 5]);
});

test('missing or whitespace-only content and problems are valid, and forced settings ignore tampering', async () => {
    const env = await harness();
    for (const extra of [{}, { content: ' \n\t ', pids: ' \n ' }]) {
        const doc = await env.save(env.make(fields({ ...extra, extensionDays: '1000', penaltyRules: 'malformed yaml', langs: 'python' })));
        assert.equal(doc.content, ''); assert.deepEqual(doc.pids, []);
        assert.equal(+doc.endAt, +doc.penaltySince); assert.deepEqual(doc.penaltyRules, {});
        assert.equal((doc.langs || []).length, 0);
    }
    assert.equal(env.docs.size, 2);
});

test('nonempty text and problem checks still use the native workflow', async () => {
    const env = await harness();
    const doc = await env.save(env.make(fields({ content: ' # 正文 ', pids: '1', maintainer: '3' })));
    assert.equal(doc.content, '# 正文'); assert.deepEqual(doc.pids, [1]);
    assert.deepEqual(env.checkedProblems, [[1]]);
    await assert.rejects(() => env.save(env.make(fields({ pids: '999' }))), /invalid problem/);
    assert.equal(env.docs.size, 1); assert.equal(env.snapshots.length, 1);
});

test('title, dates, time ordering and optional-field size/type remain validated', async () => {
    const env = await harness();
    for (const extra of [{ title: '' }, { title: '   ' }, { beginAtDate: 'invalid' }, { beginAtTime: 'invalid' },
        { penaltySinceDate: '2020-1-1' }, { content: 'a'.repeat(65536) }, { pids: 'a'.repeat(65536) }, { content: { html: 'bad' } }]) {
        await assert.rejects(() => env.save(env.make(fields(extra))));
    }
    assert.equal(env.docs.size, 0); assert.equal(env.snapshots.length, 0);
});

test('coach access, original Hydro permissions and nonempty valid class rosters stay mandatory', async () => {
    const env = await harness();
    await assert.rejects(() => env.save(env.make(fields(), { role: 'default' })), /not coach/);
    await assert.rejects(() => env.save(env.make(fields(), { permissions: [] })), /permission CREATE_HOMEWORK/);
    await assert.rejects(() => env.save(env.make(fields({ classNames: [] }))), /班型/);
    await assert.rejects(() => env.save(env.make(fields({ classNames: ['unknown'] }))), /班型/);
    await assert.rejects(() => env.save(env.make(fields({ classNames: ['Empty'] }))), /空名单/);
    assert.equal(env.docs.size, 0); assert.equal(env.snapshots.length, 0);
});

test('edit clears old restrictions only on save, preserves entered times and never resets the roster', async () => {
    const env = await harness();
    const doc = await env.save(env.make(fields({ content: '旧内容', pids: '1', beginAtTime: '9:35', penaltySinceTime: '14:25' })));
    doc.penaltyRules = { 86400: 0.8 }; doc.endAt = new Date(+doc.penaltySince + 86400000); doc.langs = ['cc.cc14'];
    const before = JSON.stringify(doc);
    const h = env.make({ tid: String(doc.docId) });
    await env.hooks['handler/before/HomeworkEdit#get'](h);
    await h.get(h.args); await env.hooks['handler/after/HomeworkEdit#get'](h);
    assert.equal(h.response.body.timeBeginText, '9:35'); assert.equal(h.response.body.timePenaltyText, '14:25');
    assert.equal(JSON.stringify(doc), before, 'GET must not migrate old homework data');
    const saved = await env.save(env.make(fields({ tid: String(doc.docId), beginAtTime: '9:35', penaltySinceTime: '14:25' })));
    assert.equal(saved.content, ''); assert.deepEqual(saved.pids, []); assert.deepEqual(saved.langs, []);
    assert.equal(+saved.beginAt, +new Date('2026-09-08T01:35:00Z'));
    assert.equal(+saved.penaltySince, +new Date('2100-01-01T06:25:00Z'));
    assert.equal(+saved.endAt, +saved.penaltySince); assert.deepEqual(saved.penaltyRules, {});
    assert.equal(env.snapshots.length, 1); assert.equal(env.recalculated.length, 1);
});

test('cloning preserves the submitted source schedule but creates an independent roster', async () => {
    const env = await harness();
    const original = await env.save(env.make(fields({ beginAtDate: '2025-1-2', beginAtTime: '11:22', penaltySinceDate: '2099-2-3', penaltySinceTime: '4:55' })));
    const cloned = await env.save(env.make(fields({ beginAtDate: '2025-1-2', beginAtTime: '11:22', penaltySinceDate: '2099-2-3', penaltySinceTime: '4:55' })));
    assert.notEqual(String(cloned.docId), String(original.docId));
    assert.equal(+cloned.beginAt, +original.beginAt); assert.equal(+cloned.penaltySince, +original.penaltySince);
    assert.equal(env.snapshots.length, 2);
});

test('adapters are request-local and cannot relax another core handler instance', async () => {
    const env = await harness();
    const native = env.HomeworkEditHandler.prototype.postUpdate;
    await env.save(env.make(fields()));
    assert.equal(env.HomeworkEditHandler.prototype.postUpdate, native);
    const h = env.make(fields({ content: '', pids: '', extensionDays: '0', penaltyRules: '{}' }));
    assert.equal(h.postUpdate, native);
    assert.throws(() => h.postUpdate(h.args), /content/);
});
