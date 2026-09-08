const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(source, mocks) {
  const code = transformSync(fs.readFileSync(path.join(root, source), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  return module.exports;
}
class ForbiddenError extends Error {}
class ValidationError extends Error { constructor(field, _a, message) { super(message || field); } }
const PRIV = { PRIV_ALL: 'all', PRIV_USER_PROFILE: 'profile' };
const auth = load('model/education-auth.ts', { hydrooj: { ForbiddenError, PRIV } });
const student = (extra = {}) => ({ _id: 42, role: 'default', realname_flag: 1, hasPriv: () => false, ...extra });

test('student identity verification and class labels never grant teaching authority', () => {
  for (const user of [
    null, undefined, { _id: 0 }, student(), student({ realname_flag: 0 }),
    student({ group: ['coach', 'root'], requestedGroups: ['管理员'], tags: ['教练'] }),
    student({ enrollment: { role: 'coach', status: 'approved' } }),
  ]) {
    assert.equal(auth.isEducationAdmin(user), false);
    assert.equal(auth.isEducationCoach(user), false);
    assert.throws(() => auth.assertEducationAdmin(user), ForbiddenError);
    assert.throws(() => auth.assertEducationCoach(user), ForbiddenError);
  }
});

test('explicit coach role grants teaching but never administrator-only operations', () => {
  const coach = student({ role: 'coach' });
  assert.equal(auth.isEducationCoach(coach), true);
  assert.equal(auth.isEducationAdmin(coach), false);
  assert.doesNotThrow(() => auth.assertEducationCoach(coach));
  assert.throws(() => auth.assertEducationAdmin(coach), ForbiddenError);
});

test('Hydro superadmin, domain root and legacy managers retain administrator access', () => {
  for (const user of [
    student({ role: 'root' }), student({ realname_flag: 2 }), student({ realname_flag: 3 }),
    student({ hasPriv: (priv) => priv === PRIV.PRIV_ALL }),
  ]) {
    assert.equal(auth.isEducationAdmin(user), true);
    assert.equal(auth.isEducationCoach(user), true);
    assert.doesNotThrow(() => auth.assertEducationAdmin(user));
  }
});

function handlers() {
  const state = { routes: new Map(), menus: [], events: [], roles: [], roleAdds: [], roleChanges: [], logs: [], previews: [], confirms: [], reads: [], users: new Map() };
  class Handler {
    constructor(user = student({ role: 'root' })) {
      this.user = user;
      this.headers = {};
      this.response = { addHeader: (name, value) => { this.headers[name] = value; } };
    }
    url(name, args) { return `${name}/${args.id}`; }
    back() { this.returned = true; }
  }
  const PERM = { PERM_DEFAULT: 1n, PERM_CREATE_HOMEWORK: 2n, PERM_EDIT_HOMEWORK_SELF: 4n };
  const module = load('handler/account-batch.ts', {
    hydrooj: {
      Handler, PRIV, PERM, ForbiddenError, ValidationError,
      param: () => () => {},
      Types: { String: {}, Content: {}, CommaSeperatedArray: {}, ObjectId: {}, Boolean: {}, PositiveInt: {} },
      DomainModel: {
        getRoles: async () => state.roles,
        addRole: async (...args) => { state.roleAdds.push(args); },
        setUserRole: async (...args) => { state.roleChanges.push(args); },
      },
      UserModel: {
        listGroup: async () => [{ name: '基础班' }, { name: '42' }],
        getById: async (_domainId, uid) => state.users.get(uid) || null,
      },
    },
    '../model/education-auth': auth,
    '../model/log': { addLog: async (entry) => { state.logs.push(entry); } },
    '../model/account-batch': {
      previewAccountBatch: async (...args) => { state.previews.push(args); return { _id: 'batch-one' }; },
      getAccountBatch: async (...args) => { state.reads.push(args); return { _id: 'batch-one', status: 'completed' }; },
      confirmAccountBatch: async (...args) => { state.confirms.push(args); return { batch: { _id: 'batch-one' }, credentials: [{ password: 'one-time-secret' }] }; },
      ensureAccountBatchIndexes: () => {},
    },
  });
  const context = {
    Route: (name, route, handler, privilege) => { state.routes.set(name, { route, handler, privilege }); },
    injectUI: (...args) => { state.menus.push(args); },
    on: (...args) => { state.events.push(args); },
  };
  return { state, module, context, PERM };
}

test('account batch routes require login plus server-side administrator checks', async () => {
  const { state, module, context } = handlers();
  await module.apply(context);
  assert.equal(state.routes.size, 3);
  for (const route of state.routes.values()) {
    assert.equal(route.privilege, PRIV.PRIV_USER_PROFILE);
    for (const user of [student(), student({ role: 'coach' })]) {
      await assert.rejects(new route.handler(user).prepare(), ForbiddenError);
    }
    const admin = new route.handler();
    await admin.prepare();
    assert.equal(admin.headers['Cache-Control'], 'private, no-store');
    assert.equal(admin.headers.Pragma, 'no-cache');
  }
  assert.deepEqual(state.roleAdds, []);
  assert.deepEqual(state.roleChanges, []);
});

test('batch preview handler only previews, excludes numeric pseudo-groups, and redirects without credentials', async () => {
  const { state, module, context } = handlers();
  await module.apply(context);
  const Handler = state.routes.get('oi33_account_batch').handler;
  const handler = new Handler();
  await handler.prepare();
  await handler.get('system');
  assert.deepEqual(handler.response.body.groups, [{ name: '基础班' }]);
  await handler.post('system', 'student_one,张三', 'regular', ['基础班'], [], '', '');
  assert.equal(state.previews.length, 1);
  assert.equal(state.confirms.length, 0);
  assert.equal(state.previews[0][1], handler.user._id);
  assert.equal(handler.response.redirect, 'oi33_account_batch_detail/batch-one');
  assert.doesNotMatch(handler.response.redirect, /password|secret/);
  await assert.rejects(new Handler(student()).post('system', 'student_one,张三', 'regular'), ForbiddenError);
});

test('batch detail GET never replays passwords and POST requires explicit confirmation', async () => {
  const { state, module, context } = handlers();
  await module.apply(context);
  const Handler = state.routes.get('oi33_account_batch_detail').handler;
  const handler = new Handler();
  await handler.prepare();
  await handler.get('system', 'batch-one');
  assert.deepEqual(handler.response.body.credentials, []);
  assert.deepEqual(state.reads[0], ['system', handler.user._id, 'batch-one']);
  await assert.rejects(handler.post('system', 'batch-one', false), /确认/);
  assert.equal(state.confirms.length, 0);
  await handler.post('system', 'batch-one', true);
  assert.deepEqual(state.confirms[0], ['system', handler.user._id, 'batch-one']);
  assert.equal(handler.response.body.credentials[0].password, 'one-time-secret');
  assert.equal(handler.headers['Cache-Control'], 'private, no-store');
  assert.equal(handler.response.redirect, undefined);
  assert.doesNotMatch(JSON.stringify(state.logs), /one-time-secret/);
});

test('coach role creation is explicit and never overwrites an existing role', async () => {
  const { state, module, context, PERM } = handlers();
  await module.apply(context);
  const Handler = state.routes.get('oi33_education_access').handler;
  const handler = new Handler();
  await handler.prepare();
  await assert.rejects(handler.postSetup('system', false), ValidationError);
  assert.deepEqual(state.roleAdds, []);
  await handler.postSetup('system', true);
  assert.deepEqual(state.roleAdds[0], ['system', 'coach', PERM.PERM_DEFAULT | PERM.PERM_CREATE_HOMEWORK | PERM.PERM_EDIT_HOMEWORK_SELF]);
  state.roles.push({ _id: 'coach', perm: 9999n });
  await assert.rejects(handler.postSetup('system', true), /不会覆盖/);
  assert.equal(state.roleAdds.length, 1);
});

test('coach assignment rejects protected/custom roles and never touches students until confirmed', async () => {
  const { state, module, context } = handlers();
  await module.apply(context);
  const Handler = state.routes.get('oi33_education_access').handler;
  const handler = new Handler();
  await handler.prepare();
  state.users.set(50, student({ _id: 50 }));
  await assert.rejects(handler.postCoach('system', 50, true), /先创建/);
  state.roles.push({ _id: 'coach' });
  await assert.rejects(handler.postCoach('system', 50, false), ValidationError);
  for (const user of [student({ role: 'root' }), student({ role: 'custom_admin' }), student({ realname_flag: 2 })]) {
    state.users.set(50, user);
    await assert.rejects(handler.postCoach('system', 50, true), /不能覆盖/);
  }
  assert.deepEqual(state.roleChanges, []);
  state.users.set(50, student({ _id: 50 }));
  await handler.postCoach('system', 50, true);
  assert.deepEqual(state.roleChanges, [['system', 50, 'coach', true]]);
});

test('teaching setup and account import dropdowns are administrator-only', async () => {
  const { state, module, context } = handlers();
  await module.apply(context);
  assert.equal(state.menus.length, 2);
  for (const menu of state.menus) {
    const checker = menu.at(-1);
    assert.equal(checker({ user: student() }), false);
    assert.equal(checker({ user: student({ role: 'coach' }) }), false);
    assert.equal(checker({ user: student({ role: 'root' }) }), true);
  }
});
