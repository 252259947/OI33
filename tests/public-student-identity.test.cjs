const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function load(file, imports = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', transformSync(read(file), { loader: 'ts', format: 'cjs' }).code)(
    name => { if (!(name in imports)) throw Error(`Unexpected import ${name}`); return imports[name]; }, module, module.exports);
  return module.exports;
}
const PRIV = { PRIV_ALL: 1, PRIV_USER_PROFILE: 2, PRIV_MOD_BADGE: 4 };
const education = load('model/education-auth.ts', { hydrooj: { PRIV } });
const serializer = load('node_modules/@hydrooj/framework/serializer.ts').default;
const identities = [
  { _id: 42, uname: ' student_name ', mail: 'private-parent@example.test' },
  { _id: 43, uname: '   ', mail: ' fallback@example.test ' },
  { _id: 44, uname: 'pending_name', mail: 'pending-parent@example.test' },
  { _id: 45, uname: '姓名本身是用户名', mail: 'private45@example.test' },
  { _id: 46, uname: '', mail: '' },
];
function fixture() {
  const queries = [];
  const collection = { find(query) {
    const captured = { query }; queries.push(captured);
    return { project(projection) { captured.projection = projection; return this; }, async toArray() {
      return identities.filter(row => query._id.$in.includes(row._id)).map(row => ({ ...row }));
    } };
  } };
  return { queries, ...load('handler/public-student-identity.ts', {
    hydrooj: { UserModel: { coll: collection } }, '../model/education-auth': education,
    'hydrooj/src/lib/avatar': () => '/hashed-avatar',
  }) };
}
function user(uid, extra = {}) {
  const u = { _id: uid, uname: `account_${uid}`, mail: `private-${uid}@example.test`,
    realname_flag: 1, realname_name: 'PRIVATE_REAL_NAME', displayName: 'PRIVATE_DISPLAY_NAME',
    avatar: `gravatar:private-${uid}@example.test`, role: 'default', bio: '',
    hasPriv: () => false, hasPerm: () => true,
    _publicFields: ['realname_flag', 'realname_name'], _privateFields: ['displayName'], ...extra };
  Object.defineProperty(u, 'serialize', { enumerable: false, value(h) {
    const fields = ['_id', 'uname', 'mail', 'avatar', ...this._publicFields,
      ...(h.user.hasPerm() ? this._privateFields : [])];
    return Object.fromEntries(fields.map(key => [key, this[key]]));
  } });
  return u;
}
function request(name = 'UserDetail', viewer = user(9), body = {}) {
  const headers = {};
  return { constructor: { name: `${name}Handler` }, request: { method: 'GET' }, user: viewer, UiContext: {},
    response: { body, addHeader: (key, value) => { headers[key] = value; } }, headers };
}
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    if (name === 'components/home.html') return { src: '{% macro render_sidebar() %}{% endmacro %}', path: name };
    if (name === 'components/problem.html') return { src: '', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
env.addFilter('base64_encode', value => Buffer.from(value).toString('base64'));
env.addFilter('markdown', String);
function context(h) {
  return { ...h.response.body, handler: h, PRIV, perm: {}, pdocs: [], tags: [], UiContext: h.UiContext,
    model: { builtin: { LEVELS: [] } }, avatarUrl: value => value || '/anonymous-avatar',
    findSubModule: () => [], datetimeSpan: () => '-', url: (name, args) => `/user/${args?.uid ?? ''}`,
    set: (obj, key, value) => { obj[key] = value; return ''; },
    _: value => { const s = new String(value); s.format = (...args) => String(value).replace(/\{(\d+)\}/g, (_, i) => args[i]); return s; } };
}
function macro(h, file, udoc) {
  return env.renderString(`{% import "${file}" as user with context %}{{ user.render_inline(udoc) }}`, { ...context(h), udoc });
}

test('public names use a nonblank original username, then registered email, then UID', () => {
  const { publicStudentName: name } = fixture();
  assert.equal(name(identities[0], 42), 'student_name');
  assert.equal(name(identities[1], 43), 'fallback@example.test');
  assert.equal(name({ uname: null, mail: 'missing@example.test' }, 48), 'missing@example.test');
  assert.equal(name(identities[4], 46), 'UID 46');
  assert.equal(name(undefined, 99), 'UID 99');
  assert.equal(name(identities[3], 45), '姓名本身是用户名');
});

test('all public identity routes sanitize request-owned HTML/JSON identities with one narrow read', async () => {
  for (const route of ['UserDetail', 'Home', 'DomainRank', 'RatingShow',
    'DiscussionMain', 'DiscussionNode', 'DiscussionDetail', 'ArticleMine']) {
    const api = fixture();
    const originals = [user(42), user(43), user(44, { uname: 'UID 44', avatar: '', oi33_profile_hidden: true }), user(45), user(46)];
    const originalViewer = user(42);
    const body = { udoc: originals[0], udocs: originals, udict: Object.fromEntries(originals.map(u => [u._id, u])) };
    const h = request(route, originalViewer, body);
    await api.applyPublicStudentIdentity(h);
    assert.equal(api.queries.length, 1);
    assert.deepEqual(api.queries[0].projection, { _id: 1, uname: 1, mail: 1 });
    assert.deepEqual(new Set(api.queries[0].query._id.$in), new Set([42, 43, 44, 45, 46]));
    assert.equal(body.udict[42].oi33_public_name, 'student_name');
    assert.equal(body.udict[43].oi33_public_name, 'fallback@example.test');
    assert.equal(body.udict[44].oi33_public_name, 'pending_name');
    assert.equal(body.udict[44].uname, 'UID 44', 'Do not globally undo pending-account anonymization');
    assert.equal(body.udict[44].oi33_profile_hidden, true);
    assert.equal(body.udict[44].avatar, '');
    assert.equal(body.udict[45].oi33_public_name, '姓名本身是用户名');
    assert.equal(body.udict[46].oi33_public_name, 'UID 46');
    assert.equal(body.udict[43].mail, '');
    assert.equal(body.udict[42].avatar, 'url:/hashed-avatar');
    const json = JSON.stringify(body, serializer(false, h));
    assert.doesNotMatch(json, /PRIVATE_REAL_NAME|PRIVATE_DISPLAY_NAME|private-43@example/);
    assert.match(json, /fallback@example.test/);
    assert.equal(h.user.oi33_public_name, 'student_name', 'Ranking pinned self row uses this request copy');
    assert.equal(originalViewer.displayName, 'PRIVATE_DISPLAY_NAME');
    assert.equal(originals[0].realname_name, 'PRIVATE_REAL_NAME');
    assert.notEqual(body.udocs, originals);
    assert.notEqual(h.user, originalViewer);
    assert.equal(h.headers['Cache-Control'], 'private, no-store');
    for (const file of ['components/user.html', 'components/oi33_user.html']) {
      assert.match(macro(h, file, body.udict[43]), /fallback@example.test/);
      const pending = macro(h, file, body.udict[44]);
      assert.match(pending, /pending_name/);
      assert.match(pending, /anonymous-avatar/);
      assert.doesNotMatch(pending, /PRIVATE_REAL_NAME|PRIVATE_DISPLAY_NAME/);
    }
  }
});

test('own and other profiles never append displayName; pending titles show login identity while profile remains hidden', async () => {
  for (const self of [false, true]) {
    for (const pending of [false, true]) {
      const api = fixture(), uid = pending ? 44 : 42;
      const udoc = user(uid, pending ? { uname: 'UID 44', oi33_profile_hidden: true, avatar: '', bio: '' } : {});
      const h = request('UserDetail', user(self ? uid : 9), { udoc, isSelfProfile: self,
        oi33CanViewProfilePrivateIdentity: self });
      await api.applyPublicStudentIdentity(h);
      const html = env.render('user_detail.html', context(h));
      assert.doesNotMatch(html, /PRIVATE_REAL_NAME|PRIVATE_DISPLAY_NAME/);
      assert.match(html, pending ? /pending_name/ : /student_name/);
      assert.equal(h.UiContext.extraTitleContent, pending ? 'pending_name' : 'student_name');
      if (pending) {
        assert.match(html, /anonymous-avatar/);
        assert.doesNotMatch(html, /class="profile-content"/);
        assert.equal(h.UiContext.udoc.uname, 'pending_name');
      }
    }
  }
});

test('staff, account settings, post operations and every teaching scoreboard remain untouched', async () => {
  const api = fixture();
  for (const viewer of [user(9, { role: 'coach' }), user(9, { role: 'root' }), user(9, { realname_flag: 2 }),
    user(9, { hasPriv: p => p === PRIV.PRIV_ALL })]) {
    const original = user(42), h = request('UserDetail', viewer, { udoc: original });
    await api.applyPublicStudentIdentity(h);
    assert.equal(h.response.body.udoc, original);
    assert.equal(h.user, viewer);
  }
  for (const name of ['ContestScoreboard', 'HomeworkScoreboard', 'TrainingDetail', 'HomeSettings', 'Oi33Enrollment']) {
    const original = user(42), h = request(name, user(9), { udoc: original });
    await api.applyPublicStudentIdentity(h);
    assert.equal(h.response.body.udoc, original);
    assert.equal(original.realname_name, 'PRIVATE_REAL_NAME');
  }
  const h = request('DiscussionDetail', user(9), { udict: { 42: user(42) } });
  h.request.method = 'POST';
  await api.applyPublicStudentIdentity(h);
  assert.equal(h.response.body.udict[42].oi33_public_name, undefined);
  assert.equal(api.queries.length, 0);
});

test('guest views use public labels and template escaping without exposing an extra identity', async () => {
  const api = fixture(), h = request('DomainRank', user(0), { udocs: [user(43)] });
  await api.applyPublicStudentIdentity(h);
  assert.equal(h.response.body.udocs[0].oi33_public_name, 'fallback@example.test');
  const unsafe = { ...h.response.body.udocs[0], oi33_public_name: '<img src=x onerror=alert(1)>' };
  for (const file of ['components/user.html', 'components/oi33_user.html']) {
    const html = macro(h, file, unsafe);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img src=x/);
  }
});

test('generic after hook runs after article rebuilding and is registered from applyPatches', () => {
  const api = fixture(), hooks = [];
  api.apply({ on: (...args) => hooks.push(args) });
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0], 'handler/after');
  assert.equal(hooks[0][1], api.applyPublicStudentIdentity);
  assert.match(read('handler/patches.ts'), /applyPublicStudentIdentity\(_ctx\)/);
  const framework = read('node_modules/@hydrooj/framework/server.ts');
  assert.match(framework, /`handler\/after\/\$\{name\}`, 'handler\/after'/);
});
