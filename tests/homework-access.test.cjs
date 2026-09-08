const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const { ObjectId } = require('mongodb');

const root = path.resolve(__dirname, '..');
const PERM = Object.fromEntries(['VIEW_HOMEWORK', 'ATTEND_HOMEWORK', 'SUBMIT_PROBLEM', 'VIEW_HIDDEN_HOMEWORK',
  'VIEW_HIDDEN_CONTEST', 'EDIT_HOMEWORK', 'VIEW_HOMEWORK_HIDDEN_SCOREBOARD'].map((name, index) => [`PERM_${name}`, 1n << BigInt(index)]));
class ForbiddenError extends Error {}
class ContestAlreadyAttendedError extends Error {}
function load(file, dependencies) {
  const code = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), {
    loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    if (!(name in dependencies)) throw new Error(`Unstubbed import: ${name}`);
    return dependencies[name];
  });
  return module.exports;
}
function fixture() {
  const tid = new ObjectId(); const otherTid = new ObjectId();
  const tdoc = { docId: tid, domainId: 'system', rule: 'homework', assign: ['基础班'], pids: [1],
    beginAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 60000) };
  const groups = [{ name: '基础班', uids: [4] }, { name: '提高班', uids: [4, 5] }, { name: '其他班', uids: [6] }];
  const statuses = new Map(); const writes = []; const hooks = {};
  const hydro = {
    ObjectId, ForbiddenError, ContestAlreadyAttendedError, PERM, PRIV: { PRIV_USER_PROFILE: 1, PRIV_ALL: 2 },
    Handler: class {}, Context: class {}, param: () => () => {}, Types: {},
    ContestModel: {
      get: async (_, id) => String(id) === String(tid) ? tdoc : { ...tdoc, docId: otherTid, rule: 'acm' },
      getStatus: async (_, id, uid) => statuses.get(`${id}:${uid}`),
      isDone: (doc) => doc.endAt <= new Date(), isNotStarted: (doc) => doc.beginAt > new Date(),
      isOngoing: (doc) => doc.beginAt <= new Date() && doc.endAt > new Date(),
      attend: async (_, id, uid, payload) => {
        writes.push({ operation: 'attend', uid, payload });
        statuses.set(`${id}:${uid}`, { attend: 1, ...payload });
      },
      setStatus: async (_, id, uid, payload) => {
        writes.push({ operation: 'set', uid, payload });
        statuses.set(`${id}:${uid}`, { ...statuses.get(`${id}:${uid}`), ...payload });
      },
    },
    ProblemModel: { get: async (_, pid) => ({ docId: Number(pid) }) },
  };
  const auth = load('model/education-auth.ts', { hydrooj: hydro });
  const policy = load('handler/homework-access.ts', {
    hydrooj: hydro, '../model/education-auth': auth,
    '../model/education': { listClassGroups: async () => groups, educationRosterColl: {} },
    './enrollment': { enforceEnrollment: async (h) => { if (h.disabled) throw new ForbiddenError('disabled'); } },
  });
  const makeUser = (uid = 4, role = 'default', permission = PERM.PERM_VIEW_HOMEWORK | PERM.PERM_ATTEND_HOMEWORK | PERM.PERM_SUBMIT_PROBLEM) => ({
    _id: uid, role, perm: permission, realname_flag: 1,
    // Hydro hasPerm(...args) is OR. Combined bitmasks express AND.
    hasPerm(...values) { return values.some((value) => (this.perm & value) === value); },
    hasPriv(value) { return !!this._id && value === 1; }, own: () => false,
  });
  const handler = (name = 'ProblemDetailHandler', user = makeUser(), method = 'get') => ({
    constructor: { name }, user, domain: { _id: 'system' }, args: { domainId: 'system', pid: 1, tid: String(tid) },
    request: { method, path: '/p/1', params: { pid: '1' }, query: { tid: String(tid) }, body: {} },
    response: { addHeader() {} }, checkPriv(value) { if (!this.user.hasPriv(value)) throw new ForbiddenError('priv'); },
    checkPerm(value) { if (!this.user.hasPerm(value)) throw new ForbiddenError('perm'); },
    async __prepare() {
      assert.equal(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST), true);
      this.tdoc = tdoc; this.tsdoc = await hydro.ContestModel.getStatus('system', tid, this.user._id);
    },
  });
  return { policy, hydro, tdoc, tid, otherTid, groups, statuses, writes, makeUser, handler, hooks };
}

test('homework list and group filters use class membership rather than historical hidden privileges', async () => {
  const f = fixture();
  assert.deepEqual(await f.policy.homeworkGroups(f.makeUser(), 'system'), ['基础班', '提高班']);
  const elevated = f.makeUser(6, 'default', 127n);
  assert.deepEqual(await f.policy.homeworkGroups(elevated, 'system'), ['其他班']);
  assert.deepEqual(f.policy.homeworkQuery(elevated, ['其他班']), { rule: 'homework', assign: { $in: ['其他班'] } });
  assert.deepEqual(f.policy.homeworkQuery(f.makeUser(0), []), { rule: 'homework', assign: { $in: [] } });
  assert.throws(() => f.policy.homeworkQuery(f.makeUser(), ['基础班'], '其他班'), ForbiddenError);
  assert.equal(f.policy.homeworkQuery(f.makeUser(), ['基础班'], '', 'a.*').title.$regex.source, 'a\\.\\*');
});
test('coach defaults to all homework without tags but only valid class filters are accepted', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach');
  assert.deepEqual(await f.policy.homeworkGroups(teacher, 'system'), ['基础班', '提高班', '其他班']);
  assert.deepEqual(f.policy.homeworkQuery(teacher, ['基础班']), { rule: 'homework' });
  assert.deepEqual(f.policy.homeworkQuery(teacher, ['基础班'], '基础班'), { rule: 'homework', assign: { $in: ['基础班'] } });
});
test('unassigned students, old owners, empty assignments and disabled users cannot auto-enroll', async () => {
  const f = fixture(); const outsider = f.makeUser(6, 'default', 127n); outsider.own = () => true;
  await assert.rejects(f.policy.enforceHomeworkAccess(f.handler('ProblemDetailHandler', outsider)), ForbiddenError);
  f.tdoc.assign = [];
  await assert.rejects(f.policy.enforceHomeworkAccess(f.handler()), ForbiddenError);
  f.tdoc.assign = ['基础班'];
  await assert.rejects(f.policy.enforceHomeworkAccess({ ...f.handler(), disabled: true }), ForbiddenError);
  assert.equal(f.writes.length, 0);
});
test('matching students auto-enroll once and never reset a recorded start time', async () => {
  const f = fixture();
  await f.policy.enforceHomeworkAccess(f.handler());
  const startAt = f.statuses.get(`${f.tid}:4`).startAt;
  assert.ok(startAt instanceof Date);
  await f.policy.enforceHomeworkAccess(f.handler());
  assert.equal(f.writes.length, 1);
  assert.equal(f.statuses.get(`${f.tid}:4`).startAt, startAt);
});
test('only a confirmed concurrent attendance is swallowed; database errors propagate', async () => {
  const f = fixture(); const h = f.handler();
  f.hydro.ContestModel.attend = async (_, id, uid) => {
    f.statuses.set(`${id}:${uid}`, { attend: 1, startAt: new Date() });
    throw new ContestAlreadyAttendedError();
  };
  await f.policy.ensureHomeworkAttendance(h, f.tdoc);
  f.statuses.clear();
  f.hydro.ContestModel.attend = async (_, id, uid) => {
    f.statuses.set(`${id}:${uid}`, { attend: 1, startAt: new Date() });
    throw new Error('database unavailable');
  };
  await assert.rejects(f.policy.ensureHomeworkAttendance(h, f.tdoc), /database unavailable/);
});
test('teacher preview privileges are request-local and do not grant write permissions or ownership', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach'); const h = f.handler('ProblemDetailHandler', teacher);
  await f.policy.enforceHomeworkAccess(h);
  assert.notEqual(h.user, teacher);
  assert.equal(teacher.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST), false);
  assert.equal(h.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK), true);
  assert.equal(h.user.hasPerm(PERM.PERM_EDIT_HOMEWORK), false);
  assert.equal(h.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK | PERM.PERM_EDIT_HOMEWORK), false);
  assert.equal(h.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD), false);
  assert.equal(h.user.own(f.tdoc), false);
  await h.__prepare();
  assert.equal(h.tsdoc.attend, 1);
  assert.equal(f.writes.length, 0);
});
test('unrelated contests and handlers never receive homework read proxies or attendance writes', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach'); const h = f.handler('ProblemDetailHandler', teacher);
  h.args.tid = String(f.otherTid); h.request.query.tid = String(f.otherTid);
  await f.policy.enforceHomeworkAccess(h);
  assert.equal(h.user, teacher);
  await f.policy.enforceHomeworkAccess(f.handler('UserDetailHandler', teacher));
  assert.equal(f.writes.length, 0);
});
test('a forged homework tid cannot grant hidden-contest access to either list handler', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach');
  for (const name of ['ContestListHandler', 'ContestMainHandler', 'HomeworkMainHandler']) {
    const h = f.handler(name, teacher); h.request.path = '/contest';
    await f.policy.enforceHomeworkAccess(h);
    assert.equal(h.user, teacher);
    assert.equal(h.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST), false);
  }
  assert.equal(f.writes.length, 0);
});
test('teacher statement-file previews retain read-only scope and do not enroll the teacher', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach'); const h = f.handler('ProblemFileDownloadHandler', teacher);
  await f.policy.enforceHomeworkAccess(h); await h.__prepare();
  assert.equal(h.tsdoc.attend, 1);
  assert.equal(h.user.hasPerm(PERM.PERM_EDIT_HOMEWORK), false);
  assert.equal(f.writes.length, 0);
  h.request.params.pid = '99'; h.args.pid = 99;
  await assert.rejects(f.policy.enforceHomeworkAccess(h), ForbiddenError);
});
test('teacher historical attendance without startAt is previewed without rewriting stored history', async () => {
  const f = fixture(); const teacher = f.makeUser(7, 'coach');
  const historical = { attend: 1, journal: [{ pid: 1 }] };
  f.statuses.set(`${f.tid}:7`, historical);
  const h = f.handler('ProblemDetailHandler', teacher);
  await f.policy.enforceHomeworkAccess(h); await h.__prepare();
  assert.equal(h.tsdoc.attend, 1);
  assert.equal(h.tsdoc.startAt, f.tdoc.beginAt);
  assert.equal(historical.startAt, undefined);
  assert.equal(f.statuses.get(`${f.tid}:7`), historical);
  assert.equal(f.writes.length, 0);
  const oldStart = new Date(Date.now() - 10000);
  f.statuses.set(`${f.tid}:7`, { attend: 1, startAt: oldStart });
  const existing = f.handler('ProblemDetailHandler', teacher);
  await f.policy.enforceHomeworkAccess(existing); await existing.__prepare();
  assert.equal(existing.tsdoc.startAt, oldStart);
  assert.equal(f.writes.length, 0);
});
test('future/ended problem access and wrong problem membership do not create attendance', async () => {
  const f = fixture();
  f.tdoc.beginAt = new Date(Date.now() + 60000);
  await f.policy.enforceHomeworkAccess(f.handler());
  f.tdoc.beginAt = new Date(Date.now() - 120000); f.tdoc.endAt = new Date(Date.now() - 60000);
  await f.policy.enforceHomeworkAccess(f.handler('ProblemSubmitHandler', f.makeUser(), 'post'));
  f.tdoc.endAt = new Date(Date.now() + 60000);
  const h = f.handler(); h.args.pid = 99; h.request.params.pid = '99';
  await assert.rejects(f.policy.enforceHomeworkAccess(h), ForbiddenError);
  assert.equal(f.writes.length, 0);
});
test('future homework detail can auto-enroll without pretending work has started', async () => {
  const f = fixture(); f.tdoc.beginAt = new Date(Date.now() + 60000);
  await f.policy.enforceHomeworkAccess(f.handler('HomeworkDetailHandler'));
  assert.equal(f.statuses.get(`${f.tid}:4`).attend, 1);
  assert.equal(f.statuses.get(`${f.tid}:4`).startAt, undefined);
});
test('homework binding rejects conflicting sources and domain changes before any state write', async () => {
  const f = fixture(); const h = f.handler('ProblemSubmitHandler', f.makeUser(), 'post');
  h.request.body.tid = String(f.otherTid);
  await assert.rejects(f.policy.enforceHomeworkAccess(h), ForbiddenError);
  const otherDomain = f.handler(); otherDomain.args.domainId = 'other';
  await assert.rejects(f.policy.enforceHomeworkAccess(otherDomain), ForbiddenError);
  assert.equal(f.writes.length, 0);
});
test('verified body-only homework ID is normalized for the native query-only problem guard', async () => {
  const f = fixture(); const h = f.handler('ProblemSubmitHandler', f.makeUser(), 'post');
  h.request.query = {}; h.request.body.tid = String(f.tid);
  await f.policy.enforceHomeworkAccess(h);
  assert.equal(String(h.request.query.tid), String(f.tid));
  assert.equal(f.writes.length, 1);
});
