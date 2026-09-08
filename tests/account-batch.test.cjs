const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');
const { ObjectId } = require('mongodb');

const root = path.resolve(__dirname, '..');
function load(source, mocks) {
  const code = transformSync(fs.readFileSync(path.join(root, source), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === 'crypto') return require(id);
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  return module.exports;
}
const policy = load('model/account-batch-policy.ts', {});
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
function matches(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some((option) => matches(doc, option));
    const value = key.split('.').reduce((current, part) => current?.[part], doc);
    if (condition && typeof condition === 'object' && !(condition instanceof ObjectId) && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, expected]) => {
        if (operator === '$in') return expected.some((item) => equal(value, item));
        if (operator === '$lte') return value != null && value <= expected;
        if (operator === '$gt') return value != null && value > expected;
        throw new Error(`Unexpected query operator ${operator}`);
      });
    }
    return equal(value, condition);
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
    for (const key of Object.keys(update.$unset || {})) setPath(doc, key, null, true);
  };
  return {
    docs,
    async insertOne(doc) { docs.push(clone(doc)); },
    async findOne(query) { return clone(docs.find((doc) => matches(doc, query)) || null); },
    async updateOne(query, update) {
      const doc = docs.find((item) => matches(item, query));
      if (!doc) return { matchedCount: 0 };
      apply(doc, update);
      return { matchedCount: 1 };
    },
    async findOneAndUpdate(query, update) {
      const doc = docs.find((item) => matches(item, query));
      if (!doc) return null;
      apply(doc, update);
      return clone(doc);
    },
    async createIndex() {},
  };
}

function harness() {
  const state = {
    collections: {}, users: new Map(), enrollments: new Map(), contests: new Map(),
    groups: { system: ['基础班', '提高班'], other: ['其他班'] },
    created: [], provisioned: [], assigned: [], userUpdates: [], memberships: [], logs: [],
    createHook: null, provisionHook: null, assignHook: null,
  };
  const db = { collection: (name) => state.collections[name] ||= collection() };
  const user = (uid, uname, extra = {}) => ({
    _id: uid, uname, role: 'default', priv: 1, hasPriv: () => false, realname_flag: 1, ...extra,
  });
  const UserModel = {
    listGroup: async (domain) => (state.groups[domain] || []).map((name) => ({ name })),
    getById: async (_domain, uid) => state.users.get(uid) || null,
    getByUname: async (_domain, uname) => [...state.users.values()].find((item) => item.uname.toLowerCase() === uname.toLowerCase()) || null,
    create: async (mail, uname, password, _a, _ip, priv) => {
      if (state.createHook) await state.createHook({ mail, uname, password, priv });
      const uid = 100 + state.created.length;
      state.created.push({ uid, mail, uname, password, priv });
      state.users.set(uid, user(uid, uname, { priv }));
      db.collection('user').docs.push({ _id: uid, uname });
      return uid;
    },
    setById: async (uid, update) => {
      state.userUpdates.push({ uid, update });
      Object.assign(state.users.get(uid), update);
    },
    setPassword: async () => { throw new Error('Batch imports must never reset an existing password'); },
  };
  class ValidationError extends Error { constructor(field, _a, message) { super(message || field); this.field = field; } }
  const hydro = {
    db, ObjectId, UserModel, ValidationError, PRIV: { PRIV_ALL: 'all' },
    SystemModel: { get: () => 9 },
    Types: { Username: [String, (value) => /^[a-z][a-z0-9_]{1,63}$/i.test(value)] },
    ContestModel: { get: async (domainId, id) => state.contests.get(`${domainId}:${id}`) || null },
    DomainModel: { setUserInDomain: async (domainId, uid, update) => { state.memberships.push({ domainId, uid, update }); } },
  };
  const api = load('model/account-batch.ts', {
    hydrooj: hydro,
    './log': { addLog: async (entry) => { state.logs.push(clone(entry)); } },
    './account-batch-policy': policy,
    './education': { addStudentsToGroups: async (...args) => {
      if (state.assignHook) await state.assignHook(...args);
      state.assigned.push(args);
    } },
    './enrollment': {
      getEnrollment: async (uid) => clone(state.enrollments.get(uid) || null),
      provisionEnrollment: async (input) => {
        if (state.provisionHook) await state.provisionHook(input);
        state.provisioned.push(clone(input));
        const old = state.enrollments.get(input.uid);
        if (old && old.batchId !== input.batchId) throw new Error('Existing enrollment cannot be overwritten');
        state.enrollments.set(input.uid, { ...clone(input), status: 'approved', enabled: true });
      },
    },
  });
  state.addExisting = (uid, uname, realName, extra = {}) => {
    state.users.set(uid, user(uid, uname, extra.user));
    db.collection('user').docs.push({ _id: uid, uname });
    state.enrollments.set(uid, { domainId: 'system', accountType: 'regular', enabled: true, status: 'approved', realName, ...extra.enrollment });
    db.collection('domain.user').docs.push({ domainId: 'system', uid, join: true });
  };
  const input = (extra = {}) => ({ users: 'student_one,张三,S01', accountType: 'regular', groups: ['基础班'], contestIds: [], validFrom: '', validUntil: '', ...extra });
  return { state, api, input, db, hydro };
}

test('CSV/TSV parser handles headers and rejects duplicate usernames and UIDs', () => {
  assert.deepEqual(policy.parseAccountBatch('\uFEFF用户名\t姓名\t学号\t已有UID\r\nstudent_one\t张三\tS01\t42'), [
    { username: 'student_one', realName: '张三', studentId: 'S01', existingUid: 42 },
  ]);
  assert.equal(policy.parseAccountBatch('student_one,"张,三",S01')[0].realName, '张,三');
  assert.throws(() => policy.parseAccountBatch('student_one,张三\nSTUDENT_ONE,李四'), /重复/);
  assert.throws(() => policy.parseAccountBatch('student_one,张三,,42\nstudent_two,李四,,42'), /重复/);
  for (const value of ['', 'student_one,', 'student_one,张三,,0', 'student_one,张三,,2e3', 'student_one,张三,S01,42,secret']) {
    assert.throws(() => policy.parseAccountBatch(value));
  }
});

test('temporary windows require valid future expiry and valid contest scopes', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  const scope = 'a'.repeat(24);
  assert.deepEqual(policy.validateBatchWindow('regular', '', '', [], now), {});
  assert.equal(policy.validateBatchWindow('temporary', '2026-09-08T01:00:00Z', '2026-09-08T02:00:00Z', [scope], now).validUntil.toISOString(), '2026-09-08T02:00:00.000Z');
  for (const [kind, from, until, scopes] of [
    ['admin', '', '', []], ['temporary', '', '', [scope]],
    ['temporary', '2026-09-08T02:00:00Z', '2026-09-08T01:00:00Z', [scope]],
    ['temporary', '2026-09-07T00:00:00Z', '2026-09-08T00:00:00Z', [scope]],
    ['temporary', '2026-09-08T01:00:00Z', '2026-09-08T02:00:00Z', []],
    ['temporary', '2026-09-08T01:00:00Z', '2026-09-08T02:00:00Z', ['invalid']],
  ]) assert.throws(() => policy.validateBatchWindow(kind, from, until, scopes, now));
});

test('preview creates no users, enrollments or memberships and persists no passwords', async () => {
  const { api, state, input } = harness();
  const doc = await api.previewAccountBatch('system', 2, input({ groups: ['基础班', '基础班'] }));
  assert.equal(doc.status, 'preview');
  assert.deepEqual(doc.groups, ['基础班']);
  assert.equal(state.created.length, 0);
  assert.equal(state.provisioned.length, 0);
  assert.equal(state.assigned.length, 0);
  assert.equal(state.memberships.length, 0);
  assert.doesNotMatch(JSON.stringify([doc, state.logs]), /password|密码/);
  assert.equal(state.logs[0].action, 'batch_preview');
  assert.doesNotMatch(JSON.stringify(state.logs), /张三|S01/);
});

test('preview rejects existing usernames without explicit matching verified UID', async () => {
  const { api, state, input } = harness();
  state.addExisting(42, 'student_one', '张三');
  await assert.rejects(api.previewAccountBatch('system', 2, input()), /已存在/);
  await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_two,张三,S01,42' })), /不匹配/);
  await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_one,李四,S01,42' })), /姓名一致/);
  state.enrollments.get(42).status = 'pending';
  await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,S01,42' })), /已核验/);
  assert.equal(state.created.length, 0);
});

test('privileged existing accounts cannot be adopted as students', async () => {
  for (const user of [{ role: 'coach' }, { role: 'root' }, { realname_flag: 2 }, { hasPriv: () => true }]) {
    const { api, state, input } = harness();
    state.addExisting(42, 'student_one', '张三', { user });
    await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,S01,42' })), /不能作为学生/);
  }
});

test('unknown groups, cross-domain contests and homework IDs are rejected', async () => {
  const { api, state, input } = harness();
  await assert.rejects(api.previewAccountBatch('system', 2, input({ groups: ['其他班'] })), /班型不存在/);
  const id = 'a'.repeat(24);
  const temporary = input({ accountType: 'temporary', groups: [], validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), contestIds: [id] });
  state.contests.set(`other:${id}`, { rule: 'acm' });
  await assert.rejects(api.previewAccountBatch('system', 2, temporary), /当前域内的比赛/);
  state.contests.set(`system:${id}`, { rule: 'homework' });
  await assert.rejects(api.previewAccountBatch('system', 2, temporary), /当前域内的比赛/);
  assert.equal(state.created.length, 0);
});

test('batch access and confirmation reject another owner or domain', async () => {
  const { api, state, input } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  for (const [domainId, owner] of [['other', 2], ['system', 3]]) {
    await assert.rejects(api.getAccountBatch(domainId, owner, doc._id), /不属于/);
    await assert.rejects(api.confirmAccountBatch(domainId, owner, doc._id), /不属于/);
  }
  assert.equal(state.created.length, 0);
});

test('confirmation creates once, requires regular password change, and never stores generated passwords', async () => {
  const { api, state, input, db } = harness();
  const doc = await api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,S01\nstudent_two,李四,S02' }));
  const first = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(first.batch.status, 'completed');
  assert.equal(first.credentials.length, 2);
  assert.notEqual(first.credentials[0].password, first.credentials[1].password);
  assert.ok(first.credentials.every((credential) => credential.password.length >= 20));
  assert.ok(state.created.every((entry) => entry.priv === 0));
  assert.ok(state.provisioned.every((entry) => entry.requiresPasswordChange === true));
  const persisted = JSON.stringify([db.collection('oi33_account_batch').docs, state.logs]);
  for (const credential of first.credentials) assert.ok(!persisted.includes(credential.password));
  const second = await api.confirmAccountBatch('system', 2, doc._id);
  assert.deepEqual(second.credentials, []);
  assert.equal(state.created.length, 2);
  assert.equal(state.provisioned.length, 2);
});

test('temporary provision carries exact contest scopes and account validity', async () => {
  const { api, state, input } = harness();
  const id = 'a'.repeat(24);
  state.contests.set(`system:${id}`, { rule: 'acm' });
  const from = new Date(Date.now() - 1000).toISOString();
  const until = new Date(Date.now() + 3600000).toISOString();
  const doc = await api.previewAccountBatch('system', 2, input({ accountType: 'temporary', groups: [], validFrom: from, validUntil: until, contestIds: [id] }));
  await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(state.provisioned[0].accountType, 'temporary');
  assert.deepEqual(state.provisioned[0].contestScopes, [{ domainId: 'system', contestId: id }]);
  assert.equal(state.provisioned[0].validFrom.toISOString(), from);
  assert.equal(state.provisioned[0].validUntil.toISOString(), until);
});

test('temporary batches cannot adopt regular accounts or enroll teaching classes', async () => {
  const { api, state, input } = harness();
  const id = 'a'.repeat(24);
  state.contests.set(`system:${id}`, { rule: 'acm' });
  state.addExisting(42, 'student_one', '张三');
  const temporary = input({ accountType: 'temporary', groups: [], users: 'temp_student,李四',
    validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), contestIds: [id] });
  await assert.rejects(api.previewAccountBatch('system', 2, { ...temporary, groups: ['基础班'] }), /只能新建专用账号/);
  await assert.rejects(api.previewAccountBatch('system', 2, { ...temporary, users: 'student_one,张三,,42' }), /只能新建专用账号/);
  assert.equal(state.created.length, 0);
});

test('existing identity must belong to the current domain, including legacy fallback', async () => {
  const { api, state, input, db } = harness();
  state.addExisting(42, 'student_one', '张三', { enrollment: { domainId: 'other' } });
  await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,,42' })), /当前域/);
  state.enrollments.delete(42);
  db.collection('oi33_user').docs.push({ _id: 42, realname_flag: 1, realname_name: '张三' });
  db.collection('domain.user').docs.length = 0;
  await assert.rejects(api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,,42' })), /当前域/);
  db.collection('domain.user').docs.push({ domainId: 'system', uid: 42, join: true });
  const doc = await api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,,42' }));
  assert.equal(doc.rows[0].existingUid, 42);
});

test('interrupted batch lease can be resumed without replacing a created account', async () => {
  const { api, state, input, db } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  const saved = db.collection('oi33_account_batch').docs[0];
  saved.status = 'processing';
  saved.lease = 'interrupted';
  saved.leaseUntil = new Date(Date.now() - 1);
  const result = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(result.batch.status, 'completed');
  assert.equal(state.created.length, 1);
  assert.equal(result.credentials.length, 1);
});

test('expired preview or temporary validity cannot create accounts', async () => {
  const { api, state, input, db } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  const saved = db.collection('oi33_account_batch').docs[0];
  saved.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(api.confirmAccountBatch('system', 2, doc._id), /过期/);
  saved.expiresAt = new Date(Date.now() + 60000);
  saved.accountType = 'temporary';
  saved.validUntil = new Date(Date.now() - 1);
  await assert.rejects(api.confirmAccountBatch('system', 2, doc._id), /有效期已经结束/);
  assert.equal(state.created.length, 0);
});

test('simultaneous confirmations are serialized by the batch lease', async () => {
  const { api, state, input } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  let release;
  let notify;
  const entered = new Promise((resolve) => { notify = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  state.createHook = async () => { notify(); await gate; };
  const first = api.confirmAccountBatch('system', 2, doc._id);
  await entered;
  try {
    await assert.rejects(api.confirmAccountBatch('system', 2, doc._id), /正在处理/);
  } finally { release(); }
  const result = await first;
  assert.equal(result.batch.status, 'completed');
  assert.equal(state.created.length, 1);
});

test('partial failure retries keep the created UID/password and skip already completed rows', async () => {
  const { api, state, input } = harness();
  const doc = await api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,S01\nstudent_two,李四,S02' }));
  let fail = true;
  state.assignHook = async (_domain, uids) => { if (uids[0] === 100 && fail) { fail = false; throw new Error('transient group failure'); } };
  const first = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(first.batch.status, 'partial');
  assert.deepEqual(first.batch.rows.map((row) => row.state), ['failed', 'done']);
  assert.equal(state.users.get(100).priv, 0);
  const passwords = state.created.map((entry) => entry.password);
  const second = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(second.batch.status, 'completed');
  assert.deepEqual(second.credentials, []);
  assert.equal(state.created.length, 2);
  assert.deepEqual(state.created.map((entry) => entry.password), passwords);
  assert.equal(state.provisioned.filter((entry) => entry.uid === 101).length, 1);
  assert.equal(second.batch.rows[0].uid, 100);
});

test('existing regular UID is reused without resetting password, identity or privileges', async () => {
  const { api, state, input } = harness();
  state.addExisting(42, 'student_one', '张三');
  const doc = await api.previewAccountBatch('system', 2, input({ users: 'student_one,张三,S01,42' }));
  const result = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(result.batch.rows[0].uid, 42);
  assert.equal(state.created.length, 0);
  assert.equal(state.provisioned.length, 0);
  assert.equal(state.userUpdates.length, 0);
  assert.deepEqual(result.credentials, []);
});

test('a username created after preview is never adopted by the batch', async () => {
  const { api, state, input } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  state.addExisting(42, 'student_one', '张三');
  const result = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(result.batch.status, 'partial');
  assert.equal(result.batch.rows[0].uid, undefined);
  assert.equal(state.created.length, 0);
  assert.equal(state.provisioned.length, 0);
});

test('generated passwords cannot leak through persisted row error messages', async () => {
  const { api, state, input, db } = harness();
  const doc = await api.previewAccountBatch('system', 2, input());
  let generated;
  state.createHook = async ({ password }) => { generated = password; throw new Error(`create failed with password ${password}`); };
  const result = await api.confirmAccountBatch('system', 2, doc._id);
  assert.equal(result.batch.status, 'partial');
  assert.ok(generated);
  assert.ok(!JSON.stringify([db.collection('oi33_account_batch').docs, state.logs]).includes(generated));
});
