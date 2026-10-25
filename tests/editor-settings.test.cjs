const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(source, dependencies = {}) {
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18' });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
        assert.ok(name in dependencies, `Unexpected dependency ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports;
}
const policy = compile(read('model/editor-settings-policy.ts'));
class ForbiddenError extends Error {}
class ValidationError extends Error {
    constructor(field, unused, message) { super(message); this.field = field; }
}
const PRIV = { PRIV_USER_PROFILE: 1 };
const enrollment = read('handler/enrollment.ts');
const originSource = enrollment.slice(enrollment.indexOf('export function requireAccountMutationOrigin('),
    enrollment.indexOf('\nfunction assertAccountAdmin('));
assert.ok(originSource.includes('export function requireAccountMutationOrigin'));
// The extracted function refers to the original module's import.
const { requireAccountMutationOrigin } = compile(`import { ForbiddenError } from 'hydrooj';\n${originSource}`,
    { hydrooj: { ForbiddenError } });

function harness() {
    const docs = new Map(), writes = [], logs = [], routes = [], hooks = new Map();
    let writeFailure, readFailure, duplicateFirst = false;
    const collection = {
        async findOne({ _id }) {
            if (readFailure) throw readFailure;
            return docs.has(_id) ? { ...docs.get(_id) } : null;
        },
        async updateOne(query, update, options) {
            if (writeFailure) throw writeFailure;
            writes.push({ query, update, options });
            if (docs.has(query._id)) return { upsertedCount: 0 };
            docs.set(query._id, { _id: query._id, ...update.$setOnInsert });
            return { upsertedCount: 1 };
        },
        async findOneAndUpdate(query, update, options) {
            if (writeFailure) throw writeFailure;
            writes.push({ query, update, options });
            if (duplicateFirst && options.upsert) {
                duplicateFirst = false;
                docs.set(query._id, { _id: query._id, tabSize: 8 });
                throw Object.assign(new Error('duplicate'), { code: 11000 });
            }
            if (!docs.has(query._id) && !options.upsert) return null;
            const doc = { ...docs.get(query._id), _id: query._id, ...update.$set };
            docs.set(query._id, doc);
            return { ...doc };
        },
    };
    const model = compile(read('model/editor-settings.ts'), {
        hydrooj: { db: { collection(name) { assert.equal(name, 'oi33_editor_settings'); return collection; } } },
        './editor-settings-policy': policy,
        './log': { addLog: async log => logs.push(log) },
    });
    class Handler {}
    const handler = compile(read('handler/editor-settings.ts'), {
        hydrooj: { Handler, ForbiddenError, ValidationError, PRIV },
        '../model/editor-settings': model,
        '../model/editor-settings-policy': policy,
        './enrollment': { requireAccountMutationOrigin },
    });
    handler.apply({ Route: (...args) => routes.push(args), on: (event, callback) => hooks.set(event, callback) });
    const make = ({ uid = 42, body = {}, query = {}, headers = { origin: 'https://oj.example' } } = {}) => {
        const h = new handler.EditorSettingsHandler();
        h.user = { _id: uid, hasPriv: () => typeof uid === 'number' && uid > 0 };
        h.checkPriv = priv => { assert.equal(priv, PRIV.PRIV_USER_PROFILE); if (!(uid > 0)) throw new ForbiddenError(); };
        h.request = { body: { expectedUid: uid, ...body }, query, headers, method: 'get' };
        h.args = { domainId: 'system', ...query, ...body };
        h.context = { request: { protocol: 'https', host: 'oj.example' } };
        h.UiContext = {};
        h.response = { headers: {}, addHeader(key, value) { this.headers[key] = value; } };
        return h;
    };
    return { docs, writes, logs, routes, hooks, model, make,
        setWriteFailure(error) { writeFailure = error; }, setReadFailure(error) { readFailure = error; },
        raceFirst() { duplicateFirst = true; } };
}

test('appearance schema accepts all advertised themes and only bounded font/tab values', () => {
    const themes = [...policy.EDITOR_BUILTIN_THEMES.map(([key]) => key), ...Object.keys(policy.EDITOR_CUSTOM_THEMES)];
    assert.equal(new Set(themes).size, themes.length);
    for (const theme of themes) assert.deepEqual(policy.validateEditorSettingsPatch({ theme }), { theme });
    for (const fontSize of [10, 23, 40]) for (const tabSize of [2, 4, 8]) {
        assert.deepEqual(policy.validateEditorSettingsPatch({ fontSize, tabSize }), { fontSize, tabSize });
    }
    for (const invalid of [null, [], '23', {}, { fontSize: '23' }, { fontSize: 9 }, { fontSize: 41 },
        { fontSize: 23.5 }, { fontSize: NaN }, { fontSize: Infinity }, { tabSize: 3 }, { tabSize: '4' },
        { theme: 'constructor' }, { theme: '__proto__' }, { theme: '../secret' }, { theme: 'https://evil/theme' },
        { theme: null }, { fontSize: undefined }, { fontSize: 23, uid: 43 }, { code: 'private source' },
        Object.assign(Object.create({ fontSize: 23 }), { theme: 'vs' }),
        JSON.parse('{"__proto__":{"admin":true},"fontSize":23}')]) {
        assert.throws(() => policy.validateEditorSettingsPatch(invalid));
    }
});

test('stored appearance is projected to a safe allowlist and malformed fields fall back independently', () => {
    assert.deepEqual(policy.readEditorSettings({ _id: 42, fontSize: 23, tabSize: 4, theme: 'vs-dark',
        code: 'private source', password: 'secret', updatedAt: new Date() }), { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
    assert.deepEqual(policy.readEditorSettings({ fontSize: 100, tabSize: 8, theme: '../evil' }), { tabSize: 8 });
    assert.equal(policy.readEditorSettings({ theme: 'constructor' }), null);
    assert.equal(policy.readEditorSettings(null), null);
});

test('new accounts have no cloud preference and subsequent sessions retrieve only their account appearance', async () => {
    const env = harness();
    assert.equal(await env.model.getEditorSettings(42), null);
    assert.deepEqual(env.writes, []);
    await env.model.saveEditorSettings(42, { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
    const anotherSession = env.make({ uid: 42 });
    await anotherSession.prepare(); await anotherSession.get();
    assert.deepEqual(anotherSession.response.body, { uid: 42, settings: { fontSize: 23, tabSize: 4, theme: 'vs-dark' } });
    const otherUser = env.make({ uid: 43 });
    await otherUser.prepare(); await otherUser.get();
    assert.deepEqual(otherUser.response.body, { uid: 43, settings: null });
    assert.equal(anotherSession.response.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(Object.keys(env.docs.get(42)).sort(), ['_id', 'fontSize', 'tabSize', 'theme', 'updatedAt']);
});

test('partial concurrent updates retain independent settings and cannot change another account', async () => {
    const env = harness();
    await env.model.saveEditorSettings(42, { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
    await env.model.saveEditorSettings(43, { fontSize: 12, theme: 'vs' });
    await Promise.all([env.model.saveEditorSettings(42, { fontSize: 30 }), env.model.saveEditorSettings(42, { theme: 'nord' })]);
    assert.deepEqual(await env.model.getEditorSettings(42), { fontSize: 30, tabSize: 4, theme: 'nord' });
    assert.deepEqual(await env.model.getEditorSettings(43), { fontSize: 12, theme: 'vs' });
    assert.deepEqual(env.writes.at(-2).update.$set.fontSize, 30);
    assert.equal('theme' in env.writes.at(-2).update.$set, false);
    assert.equal('fontSize' in env.writes.at(-1).update.$set, false);
});

test('racing first save retries the UID constraint without replacing the competing preference', async () => {
    const env = harness(); env.raceFirst();
    assert.deepEqual(await env.model.saveEditorSettings(42, { fontSize: 23 }), { fontSize: 23, tabSize: 8 });
    assert.equal(env.writes.length, 2);
    assert.equal(env.writes[1].options.upsert, undefined);
    assert.equal(env.logs.length, 1);
});

test('initial migration is insert-only, so a second browser cannot overwrite cloud preferences', async () => {
    const env = harness();
    await Promise.all([
        env.model.saveEditorSettings(42, { fontSize: 23, tabSize: 4, theme: 'vs-dark' }, true),
        env.model.saveEditorSettings(42, { fontSize: 12, tabSize: 2, theme: 'vs' }, true),
    ]);
    assert.deepEqual(await env.model.getEditorSettings(42), { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
    assert.equal(env.logs.length, 1);
    assert.equal(env.logs[0].action, 'editor_settings_initialize');
    const updatedAt = env.docs.get(42).updatedAt;
    const h = env.make({ body: { initialize: true, fontSize: 40 } });
    await h.prepare(); await h.post();
    assert.equal(h.response.body.settings.fontSize, 23);
    assert.equal(env.docs.get(42).updatedAt, updatedAt);
    assert.equal(env.logs.length, 1);
    await env.model.saveEditorSettings(42, { fontSize: 30 });
    assert.equal((await env.model.getEditorSettings(42)).fontSize, 30);
});

test('invalid identity, schema, and storage errors never produce success or audit a nonexistent save', async () => {
    const env = harness();
    for (const uid of [0, -1, '42', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(env.model.getEditorSettings(uid));
        await assert.rejects(env.model.saveEditorSettings(uid, { fontSize: 23 }));
    }
    await assert.rejects(env.model.saveEditorSettings(42, { fontSize: 23, uid: 43 }));
    assert.deepEqual(env.writes, []);
    env.setWriteFailure(new Error('database unavailable'));
    await assert.rejects(env.model.saveEditorSettings(42, { fontSize: 23 }), /database unavailable/);
    assert.deepEqual(env.logs, []);
});

test('route requires login, errors remain private, and supplied UID never selects another account', async () => {
    const env = harness();
    assert.deepEqual(env.routes[0].slice(0, 2), ['oi33_editor_settings', '/oi33/editor-settings']);
    assert.equal(env.routes[0][3], PRIV.PRIV_USER_PROFILE);
    for (const uid of [0, -1, '42', 1.5]) {
        const h = env.make({ uid });
        await assert.rejects(h.prepare(), ForbiddenError);
        assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
    }
    await env.model.saveEditorSettings(43, { fontSize: 40 });
    const reader = env.make({ query: { uid: 43, userId: 43, domainId: 'other' } });
    await reader.prepare(); await reader.get();
    assert.deepEqual(reader.response.body, { uid: 42, settings: null });
    const writer = env.make({ body: { fontSize: 23, uid: 43 } });
    await writer.prepare(); await assert.rejects(writer.post(), ValidationError);
    assert.equal(await env.model.getEditorSettings(42), null);
    assert.deepEqual(await env.model.getEditorSettings(43), { fontSize: 40 });
});

test('same-origin JSON saves only appearance and audit contains neither code nor account secrets', async () => {
    const env = harness();
    const h = env.make({ body: { fontSize: 23, theme: 'vs-dark' }, query: { uid: 43 } });
    await h.prepare(); await h.post();
    assert.deepEqual(h.response.body, { uid: 42, settings: { fontSize: 23, theme: 'vs-dark' } });
    assert.deepEqual(env.logs, [{ type: 'education', action: 'editor_settings_update', userId: 42,
        operator: 42, reason: 'fontSize,theme' }]);
    assert.equal(await env.model.getEditorSettings(43), null);
});

test('a tab belonging to a previous login cannot write preferences to the current account', async () => {
    const env = harness();
    for (const expectedUid of [41, 43, '42', 0, undefined, null]) {
        const h = env.make({ body: { expectedUid, fontSize: 23 } });
        await h.prepare(); await assert.rejects(h.post(), ForbiddenError);
    }
    for (const initialize of [false, 'true', 1, null]) {
        const h = env.make({ body: { initialize, fontSize: 23 } });
        await h.prepare(); await assert.rejects(h.post(), ValidationError);
    }
    assert.deepEqual(env.writes, []);
});

test('successful problem details receive only the authenticated account preferences without database writes', async () => {
    const env = harness();
    await env.model.saveEditorSettings(42, { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
    env.writes.length = 0;
    const inject = env.hooks.get('handler/after/ProblemDetail#get');
    assert.equal(typeof inject, 'function');
    const h = env.make({ query: { uid: 43 } });
    h.response.template = 'problem_detail.html';
    await inject(h);
    assert.deepEqual(h.UiContext.oi33EditorSettings, { uid: 42, settings: { fontSize: 23, tabSize: 4, theme: 'vs-dark' } });
    assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
    for (const variant of [{ uid: 0 }, { template: 'problem_edit.html' }, { method: 'post' },
        { redirect: '/login' }, { status: 403 }]) {
        const other = env.make({ uid: variant.uid ?? 42 });
        other.request.method = variant.method || 'get';
        Object.assign(other.response, { template: 'problem_detail.html', ...variant });
        await inject(other);
        assert.deepEqual(other.UiContext, {});
    }
    assert.deepEqual(env.writes, []);
    env.setReadFailure(new Error('database unavailable'));
    const unavailable = env.make(); unavailable.response.template = 'problem_detail.html';
    await inject(unavailable);
    assert.deepEqual(unavailable.UiContext.oi33EditorSettings, { uid: 42, settings: null, unavailable: true });
});

test('cross-site, malformed, missing and conflicting origin headers reject all changes', async () => {
    const env = harness();
    for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.example' },
        { referer: 'https://evil.example/' }, { origin: 'https://oj.example', referer: 'https://evil.example/' },
        { origin: 'http://oj.example' }, { origin: 'https://oj.example:444' },
        { origin: 'https://oj.example', 'sec-fetch-site': 'cross-site' },
        { origin: 'https://oj.example/path' }, { origin: 'https://oj.example@evil.example' },
        { origin: 'https://oj.example\\@evil.example' }]) {
        const h = env.make({ body: { fontSize: 23 }, headers });
        await h.prepare(); await assert.rejects(h.post(), ForbiddenError);
    }
    assert.deepEqual(env.writes, []);
    assert.deepEqual(env.logs, []);
    const refererOnly = env.make({ body: { tabSize: 8 }, headers: { referer: 'https://oj.example/p/J0030' } });
    await refererOnly.prepare(); await refererOnly.post();
    assert.deepEqual(refererOnly.response.body.settings, { tabSize: 8 });
});
