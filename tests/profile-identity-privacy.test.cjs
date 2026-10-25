const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function load(name, deps = {}, globals = global) {
  const module = { exports: {} };
  const code = transformSync(read(name), { loader: 'ts', format: 'cjs' }).code;
  new Function('require', 'module', 'exports', 'global', code)((key) => {
    if (Object.hasOwn(deps, key)) return deps[key];
    if (['crypto', 'fs', 'path'].includes(key)) return require(key);
    throw Error(`Unexpected import: ${key}`);
  }, module, module.exports, globals);
  return module.exports;
}
const PRIV = { PRIV_ALL: 1, PRIV_USER_PROFILE: 2, PRIV_MOD_BADGE: 4 };
const education = load('model/education-auth.ts', { hydrooj: { PRIV } });
const avatar = load('node_modules/hydrooj/src/lib/avatar.ts', {
  '@hydrooj/framework/validator': { Types: {} },
  '../utils': { md5: text => createHash('md5').update(text).digest('hex') },
}, { Hydro: { model: { system: { get: () => 'https://avatar.example/' } } } }).default;
const { protectProfileIdentity } = load('handler/patches.ts', {
  hydrooj: {}, 'hydrooj/src/handler/home': {}, 'hydrooj/src/handler/record': {},
  'hydrooj/src/lib/avatar': avatar, '../model': {},
  '../model/education-auth': education, './homepage-fortune': {},
});
const serializer = load('node_modules/@hydrooj/framework/serializer.ts').default;
const viewer = (_id = 9, extra = {}) => ({ _id, role: 'default', realname_flag: 1,
  hasPriv: () => false, hasPerm: () => true, ...extra });
function profile(extra = {}) {
  const udoc = { _id: 42, uname: 'student_42', mail: 'parent@example.test', displayName: '私密显示姓名',
    realname_name: '私密实名', realname_flag: 1, avatar: 'gravatar:parent@example.test',
    _udoc: { mail: 'parent@example.test' }, _publicFields: ['displayName'],
    nAccept: 8, hasPriv: () => false, hasPerm: () => false, ...extra };
  Object.defineProperty(udoc, 'serialize', { enumerable: false, value() {
    return Object.fromEntries(['_id', 'uname', 'mail', 'displayName', 'realname_name', 'avatar', 'nAccept']
      .map(key => [key, this[key]]));
  } });
  Object.defineProperty(udoc, 'oi33_original_uname', { enumerable: false, value: udoc.uname });
  return udoc;
}
function request(user, udoc = profile()) {
  const headers = {};
  return { user, headers, response: { body: { udoc, isSelfProfile: user._id === udoc._id },
    addHeader: (key, value) => { headers[key] = value; } } };
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
function render(h) {
  const context = { ...h.response.body, handler: h, PRIV, perm: {}, pdocs: [], tags: [], UiContext: {},
    model: { builtin: {} }, avatarUrl: avatar, findSubModule: () => [], datetimeSpan: () => '-',
    url: () => '#', set: (obj, key, value) => { obj[key] = value; return ''; },
    _: value => { const text = new String(value); text.format = (...args) => String(value)
      .replace(/\{(\d+)\}/g, (_, i) => args[i]); return text; } };
  return { html: env.render('user_detail.html', context), ui: context.UiContext };
}

test('students and guests see usernames without other users email or extra real-name fields in HTML and JSON', () => {
  for (const user of [viewer(), viewer(0)]) {
    const h = request(user); protectProfileIdentity(h);
    const { html, ui } = render(h);
    assert.match(html, /student_42/);
    assert.doesNotMatch(html, /私密显示姓名|私密实名|parent@example\.test|Copy Email|注册信息/);
    const json = JSON.stringify({ body: h.response.body, ui }, serializer(false, h));
    assert.doesNotMatch(json, /私密显示姓名|私密实名|parent@example\.test/);
    assert.equal(h.response.body.udoc.nAccept, 8);
    assert.equal(h.response.body.udoc.avatar, `url:${avatar('gravatar:parent@example.test', 128)}`);
    assert.equal(h.headers['Cache-Control'], 'private, no-store');
  }
});

test('self, coaches and administrators retain their permitted profile information', () => {
  for (const user of [viewer(42), viewer(9, { role: 'coach' }), viewer(9, { realname_flag: 2 }),
    viewer(9, { role: 'root' }), viewer(9, { hasPriv: value => value === PRIV.PRIV_ALL })]) {
    const original = profile(), h = request(user, original); protectProfileIdentity(h);
    assert.equal(h.response.body.udoc, original);
    assert.equal(h.response.body.oi33CanViewProfilePrivateIdentity, true);
    assert.match(render(h).html, /Copy Email/);
    assert.match(JSON.stringify(h.response.body, serializer(false, h)), /parent@example\.test/);
  }
});

test('filtering does not mutate cached identities, account settings or another simultaneous viewer', () => {
  const original = profile();
  const student = request(viewer(), original), teacher = request(viewer(7, { role: 'coach' }), original);
  protectProfileIdentity(student); protectProfileIdentity(teacher);
  assert.notEqual(student.response.body.udoc, original);
  assert.equal(original.mail, 'parent@example.test');
  assert.equal(original.displayName, '私密显示姓名');
  assert.equal(original.realname_name, '私密实名');
  assert.equal(teacher.response.body.udoc, original);
  assert.equal(student.response.body.udoc.oi33_original_uname, original.oi33_original_uname);
  assert.equal(Object.getOwnPropertyDescriptor(student.response.body.udoc, 'oi33_original_uname').enumerable, false);
});

test('an account username is preserved even when the user chose the same text as their email or real name', () => {
  for (const uname of ['parent@example.test', '私密实名']) {
    const h = request(viewer(), profile({ uname })); protectProfileIdentity(h);
    assert.equal(h.response.body.udoc.uname, uname);
    assert.equal(JSON.parse(JSON.stringify(h.response.body.udoc, serializer(false, h))).uname, uname);
    assert.equal(h.response.body.udoc.mail, '');
    assert.equal(h.response.body.udoc.realname_name, '');
  }
});

test('template independently hides extra display names and the email action without a permitted-viewer flag', () => {
  const h = request(viewer());
  // Prevent a missing/late hook from restoring visible private fields.
  assert.doesNotMatch(render(h).html, /私密显示姓名|Copy Email/);
});
