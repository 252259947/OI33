const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(relative, dependencies = {}) {
    const code = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node18',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, name => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        if (name === 'crypto') return crypto;
        throw new Error(`Unexpected import ${relative}: ${name}`);
    });
    return module.exports;
}

// Keep the signed all-permissions mask in sync with the installed Hydro version.
const nativePermissions = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/common/permission.ts'), 'utf8');
const allMask = nativePermissions.match(/\bPRIV_ALL\s*:\s*(-?\d+)/);
assert.ok(allMask, 'installed Hydro exports PRIV_ALL');
const PRIV = { PRIV_ALL: Number(allMask[1]), PRIV_USER_PROFILE: 1 };
const policy = load('model/bio-policy.ts', { hydrooj: { PRIV } });
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function matches(doc, query) {
    return Object.entries(query).every(([key, value]) => {
        if (key === '$or') return value.some(q => matches(doc, q));
        if (key === '$and') return value.every(q => matches(doc, q));
        const actual = doc[key];
        if (value && typeof value === 'object') return Object.entries(value).every(([op, arg]) => {
            if (op === '$exists') return (actual !== undefined) === arg;
            if (op === '$in') return arg.includes(actual);
            if (op === '$ne') return actual !== arg;
            if (op === '$lt') return actual < arg;
            throw Error(`Unexpected query operator ${op}`);
        });
        return actual === value;
    });
}

function fixture() {
    const collections = new Map(), writes = [], messages = [], entries = [], batchStates = [], calls = [];
    function collection(name) {
        if (collections.has(name)) return collections.get(name);
        const docs = new Map();
        const coll = { docs,
            async findOne(query) { const doc = [...docs.values()].find(value => matches(value, query)); return doc ? clone(doc) : null; },
            async updateOne(query, update, options = {}) {
                writes.push({ name, query: clone(query), update: clone(update) });
                let doc = [...docs.values()].find(value => matches(value, query));
                if (!doc && options.upsert) { doc = { _id: query._id }; docs.set(doc._id, doc); }
                if (!doc) return { matchedCount: 0 };
                Object.assign(doc, clone(update.$set || {}));
                for (const key of Object.keys(update.$unset || {})) delete doc[key];
                return { matchedCount: 1 };
            },
        };
        collections.set(name, coll);
        return coll;
    }
    class Handler {}
    class ValidationError extends Error {}
    class ForbiddenError extends Error {}
    const core = collection('user');
    const identities = collection('oi33_user');
    const hydro = { PRIV, Handler, ValidationError, ForbiddenError, NotFoundError: Error,
        ObjectId: class {}, PERM: {}, Types: {}, param: () => () => {},
        db: { collection }, DiscussionModel: {}, DocumentModel: {},
        MessageModel: { async send(...args) { messages.push(args); } },
        UserModel: { coll: core, async getById(domain, uid) {
            const doc = await core.findOne({ _id: uid });
            return doc ? { ...doc, realname_flag: identities.docs.get(uid)?.realname_flag || 0 } : null;
        } },
    };
    const hashing = load('model/moderate.ts', { hydrooj: hydro });
    const userModel = load('model/user.ts', { hydrooj: hydro, './log': { addLog: async () => {} },
        './moderate': hashing, './bio-policy': policy });
    const oi33Model = { ...userModel,
        async getUserDataByUids(uids) { return Object.fromEntries(uids.map(uid => [uid, clone(identities.docs.get(uid))])); },
        async aiGetConfig() { return { moderation_enabled: '1' }; },
        async modAdd(entry) { entries.push(clone(entry)); },
        async aiBatchSaveStatus(state) { batchStates.push(clone(state)); },
        async modGet(id) { return entries.find(entry => entry._id === id); },
        async modSetStatus(id, status, operator) { Object.assign(entries.find(entry => entry._id === id), { status, operator }); },
    };
    const utils = { async checkOi33Admin(uid) {
        if (!policy.isBioModerationExempt(core.docs.get(uid), identities.docs.get(uid))) throw new ForbiddenError('admin required');
    }, async checkUserFlag(uid) { return identities.docs.get(uid)?.realname_flag || 0; } };
    let verdict = async () => ({ verdict: 'block', source: 'ai', category: '广告引流' });
    const bio = load('handler/bio.ts', { hydrooj: hydro, '../model': { oi33Model }, './utils': utils,
        '../model/bio-policy': policy, './moderate': { ...hashing,
            async runAiVerdict(...args) { calls.push(args); return verdict(...args); } } });
    const moderate = load('handler/moderate.ts', { hydrooj: hydro, '../model': { oi33Model },
        '../model/moderate': hashing, '../model/bio-policy': policy, './utils': utils,
        '../model/moderation-target': {}, './ai': {} });
    const hooks = new Map(), routes = new Map();
    const ctx = { on(name, fn) { hooks.set(name, fn); }, Route(name, url, klass) { routes.set(name, klass); } };
    function add(uid, flag = 1, extra = {}, bioText = 'profile text') {
        core.docs.set(uid, { _id: uid, priv: 0, role: 'default', bio: bioText, ...extra });
        identities.docs.set(uid, { _id: uid, realname_flag: flag, bio_status: 'pending', bio_hash: hashing.bioHashOf(bioText) });
    }
    async function init() { await bio.apply(ctx); await moderate.apply(ctx); }
    return { hydro, core, identities, userModel, hashing, oi33Model, bio, moderate, hooks, routes,
        writes, messages, entries, batchStates, calls, add, init, setVerdict(fn) { verdict = fn; } };
}

test('only OJ administrators bypass review; a domain coach or domain owner does not', () => {
    for (const user of [{ _id: 2, realname_flag: 2 }, { _id: 3, realname_flag: 3 },
        { _id: 4, priv: PRIV.PRIV_ALL }, { _id: 5, hasPriv: mask => mask === PRIV.PRIV_ALL }]) {
        assert.equal(policy.isBioModerationExempt(user), true);
    }
    for (const user of [null, {}, { _id: 0, realname_flag: 3 }, { _id: 1.5, realname_flag: 3 },
        { _id: 7, role: 'coach', realname_flag: 1 }, { _id: 8, role: 'root', realname_flag: 1 },
        { _id: 9, priv: 0 }, { _id: 10, priv: 7 }, { _id: 11, priv: 1024 }]) {
        assert.equal(policy.isBioModerationExempt(user), false);
    }
    assert.equal(policy.isBioModerationExempt({ _id: 9, realname_flag: 3 }, { realname_flag: 1 }), false,
        'fresh OI33 identity takes precedence over a stale object flag');
});

test('old rejected administrator bios are visible; ordinary users still require verification, approval and the current hash', () => {
    const f = fixture(), bio = 'profile with https://example.invalid';
    for (const [user, identity] of [
        [{ _id: 2, bio }, { realname_flag: 2, bio_status: 'rejected' }],
        [{ _id: 3, bio }, { realname_flag: 3, bio_status: 'pending' }],
        [{ _id: 4, bio, priv: PRIV.PRIV_ALL }, undefined],
    ]) {
        const before = clone(identity);
        f.userModel.mergeOi33Fields(user, identity);
        assert.equal(user.bio_visible, true);
        assert.equal(user.bio, bio);
        assert.deepEqual(identity, before, 'display recovery does not rewrite a stored review');
    }
    for (const identity of [
        { realname_flag: 1, bio_status: 'rejected', bio_hash: f.hashing.bioHashOf(bio) },
        { realname_flag: 1, bio_status: 'pending', bio_hash: f.hashing.bioHashOf(bio) },
        { realname_flag: 1, bio_status: 'approved', bio_hash: f.hashing.bioHashOf('old content') },
        { realname_flag: 0, bio_status: 'approved', bio_hash: f.hashing.bioHashOf(bio) },
    ]) {
        const user = { _id: 8, role: 'coach', bio };
        f.userModel.mergeOi33Fields(user, identity);
        assert.equal(user.bio_visible, false);
    }
    const approved = { _id: 8, bio };
    f.userModel.mergeOi33Fields(approved, { realname_flag: 1, bio_status: 'approved', bio_hash: f.hashing.bioHashOf(bio) });
    assert.equal(approved.bio_visible, true);
    const empty = { _id: 2, bio: '  ' };
    f.userModel.mergeOi33Fields(empty, { realname_flag: 2 });
    assert.equal(empty.bio_visible, false);
});

test('administrator settings saves bypass cooldown and never enter pending, AI or rejection messages', async () => {
    const f = fixture(); await f.init();
    for (const [uid, flag, extra] of [[2, 2, {}], [3, 3, {}], [4, 0, { priv: PRIV.PRIV_ALL }]]) {
        f.add(uid, flag, extra, 'old bio');
        Object.assign(f.identities.docs.get(uid), { bio_status: 'rejected', bio_edited_at: new Date() });
        const h = { user: { ...f.core.docs.get(uid), realname_flag: flag }, args: { category: 'account', bio: 'new admin bio' } };
        await f.hooks.get('handler/before/HomeSettings#post')(h);
        f.core.docs.get(uid).bio = h.args.bio;
        await f.hooks.get('handler/after/HomeSettings#post')(h);
        assert.equal(f.identities.docs.get(uid).bio_status, 'approved');
    }
    await tick();
    assert.equal(f.writes.some(write => write.update.$set?.bio_status === 'pending'), false);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []); assert.deepEqual(f.entries, []);
    for (const role of ['coach', 'root']) {
        f.add(9, 1, { role }); f.identities.docs.get(9).bio_edited_at = new Date();
        await assert.rejects(f.hooks.get('handler/before/HomeSettings#post')({ user: f.core.docs.get(9),
            args: { category: 'account', bio: 'changed' } }), /冷却/);
    }
});

test('batch review skips all administrator variants, including already rejected bios, but still reviews a coach', async () => {
    const f = fixture();
    f.add(2, 2); f.add(3, 3); f.add(4, 0, { priv: PRIV.PRIV_ALL }); f.add(5, 1, { role: 'coach' });
    f.identities.docs.get(2).bio_status = 'rejected';
    const before = clone([...f.identities.docs.entries()].filter(([uid]) => uid !== 5));
    await f.bio.runBioReviewBatch([...f.core.docs.values()].map(({ _id, bio }) => ({ _id, bio })));
    assert.deepEqual(f.calls.map(args => args[0]), [5]);
    assert.deepEqual([...f.identities.docs.entries()].filter(([uid]) => uid !== 5), before);
    assert.equal(f.identities.docs.get(5).bio_status, 'rejected');
    assert.deepEqual(f.messages.map(args => args[1]), [5]);
    assert.equal(f.batchStates.findLast(state => state.done !== undefined).skipped, 3);
});

test('pre-existing and in-flight exemptions cannot reject or notify administrators, including AI failures', async () => {
    for (const outcome of ['block', 'throw']) {
        const f = fixture(), entered = deferred(), answer = deferred(); f.add(8);
        f.setVerdict(async () => { entered.resolve(); await answer.promise;
            if (outcome === 'throw') throw Error('synthetic AI transport failure');
            return { verdict: 'block', source: 'ai', category: '广告引流' };
        });
        const run = f.bio.moderateBioAsync(8, f.core.docs.get(8).bio, f.identities.docs.get(8).bio_hash);
        await entered.promise;
        f.identities.docs.get(8).realname_flag = 2;
        answer.resolve(); await run;
        assert.equal(f.identities.docs.get(8).bio_status, 'approved');
        assert.deepEqual(f.entries, []); assert.deepEqual(f.messages, []);
        const alreadyAdmin = fixture(); alreadyAdmin.add(2, 2);
        await alreadyAdmin.bio.moderateBioAsync(2, 'profile text', alreadyAdmin.identities.docs.get(2).bio_hash);
        assert.deepEqual(alreadyAdmin.calls, []);
    }
});

test('ordinary blocked and failed reviews remain hidden and notify; an obsolete hash cannot overwrite a newer edit', async () => {
    for (const kind of ['block', 'throw', 'stale']) {
        const f = fixture(); f.add(8);
        const oldBio = f.core.docs.get(8).bio, oldHash = f.identities.docs.get(8).bio_hash;
        if (kind === 'throw') f.setVerdict(async () => { throw Error('synthetic failure'); });
        if (kind === 'stale') f.setVerdict(async () => {
            f.core.docs.get(8).bio = 'new revision';
            await f.userModel.bioMarkEdited(8, f.hashing.bioHashOf('new revision'));
            return { verdict: 'review', source: 'ai', category: '其他' };
        });
        await f.bio.moderateBioAsync(8, oldBio, oldHash);
        if (kind === 'stale') {
            assert.equal(f.identities.docs.get(8).bio_status, 'pending');
            assert.equal(f.identities.docs.get(8).bio_hash, f.hashing.bioHashOf('new revision'));
            assert.deepEqual(f.messages, []);
            assert.equal(f.entries[0].status, 'done', 'a stale review never enters the actionable queue');
        } else {
            assert.equal(f.identities.docs.get(8).bio_status, 'rejected');
            assert.equal(f.messages.length, 1);
            assert.equal(f.entries[0].status, kind === 'throw' ? 'pending' : 'done');
        }
    }
});

test('manual bio rejection closes obsolete administrator queues without changing bio state or notifying; ordinary rejection still works', async () => {
    const f = fixture(); await f.init(); f.add(1, 3);
    for (const [uid, flag, extra] of [[2, 2, {}], [3, 3, {}], [4, 0, { priv: PRIV.PRIV_ALL }], [5, 1, { role: 'coach' }]]) {
        f.add(uid, flag, extra);
        f.entries.push({ _id: `q${uid}`, uid, kind: 'bio', status: 'pending', contentHash: f.identities.docs.get(uid).bio_hash });
        const handler = new (f.routes.get('oi33_ai_moderation'))();
        Object.assign(handler, { user: { _id: 1 }, response: {}, url: name => `/${name}` });
        await handler.post('system', 'reject', `q${uid}`);
        assert.equal(f.entries.find(entry => entry.uid === uid).status, uid === 5 ? 'rejected' : 'done');
        assert.equal(f.identities.docs.get(uid).bio_status, uid === 5 ? 'rejected' : 'pending');
        assert.equal(handler.response.redirect, '/oi33_ai_moderation');
    }
    assert.deepEqual(f.messages.map(args => args[1]), [5]);
    const handler = new (f.routes.get('oi33_ai_moderation'))();
    Object.assign(handler, { user: { _id: 5 }, response: {}, url: () => '/' });
    await assert.rejects(handler.post('system', 'reject', 'q2'), /admin required/);
});
