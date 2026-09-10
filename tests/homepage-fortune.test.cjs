const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');

function fixture(users = {}) {
  const requests = [];
  const module = { exports: {} };
  const code = transformSync(fs.readFileSync(path.join(root, 'handler/homepage-fortune.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const dependencies = {
    hydrooj: { moment: () => ({ format: () => '2026-09-10' }) },
    '../model/user': { getCheckinUser: async (uid) => { requests.push(uid); return users[uid]; } },
  };
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  });
  return { ...module.exports, requests };
}

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(root, 'templates')), { autoescape: true });
function render(payload, uid = 4) {
  return env.render('partials/homepage/checkin.html', { payload, UserContext: { _id: uid }, _: (s) => s, handler: { csrfToken: 'csrf' } });
}

test('checkin:true produces a verified payload and draw button, not a false unverified warning', async () => {
  const f = fixture({ 4: { realname_flag: 1 } });
  const payload = await f.getHomepageFortune(4, true);
  assert.equal(typeof payload, 'object');
  assert.equal(payload.oi33_checkin_flag, 1);
  assert.match(render(payload), /action="\/oi33\/checkin"/);
  assert.doesNotMatch(render(payload), /Verify realname to draw/);
  assert.equal(payload.luck_type.length, 7);
});

test('legacy administrator verification works without an enrollment migration', async () => {
  const payload = await fixture({ 3: { realname_flag: 3 } }).getHomepageFortune(3, true);
  assert.match(render(payload, 3), /Draw Today Fortune/);
});

test('fresh per-viewer payload prevents shared configuration and checkin data contamination', async () => {
  const f = fixture({ 4: { realname_flag: 1, checkin_time: '2026-09-10', checkin_luck: 6 } });
  const config = Object.freeze({ luck_type: Object.freeze([{ text: '自定义吉', color: '#123456' }]), luck_vip: Object.freeze([4]),
    oi33_checkin_flag: 3, oi33_checkin: { time: '2026-09-10', luck: 0 } });
  const [verified, anonymous] = await Promise.all([f.getHomepageFortune(4, config), f.getHomepageFortune(0, config)]);
  assert.equal(verified.luck_type[0].text, '自定义吉');
  assert.equal(anonymous.oi33_checkin_flag, 0);
  assert.equal(anonymous.oi33_checkin, null);
  assert.deepEqual(f.requests, [4]);
  assert.notEqual(verified, anonymous);
  assert.notEqual(verified.luck_type, config.luck_type);
  assert.notEqual(verified.luck_vip, config.luck_vip);
  assert.match(render(anonymous, 0), /Login to draw/);
});

test('all seven stored fortune outcomes have text even when config only enables the widget', async () => {
  for (let luck = 0; luck < 7; luck++) {
    const payload = await fixture({ 4: { realname_flag: 1, checkin_time: '2026-09-10', checkin_luck: luck, checkin_cnt_all: 2 } }).getHomepageFortune(4, true);
    assert.match(render(payload), new RegExp(payload.luck_type[luck].text));
    assert.doesNotMatch(render(payload), /Draw Today Fortune|Verify realname to draw/);
  }
});

test('missing/primitive configuration and invalid fortune indexes cannot break homepage rendering', async () => {
  const f = fixture({ 4: { realname_flag: 1, checkin_time: '2026-09-10', checkin_luck: 999 } });
  for (const config of [null, undefined, 1, true, [], 'enabled', { luck_type: [] }]) {
    const payload = await f.getHomepageFortune(4, config);
    assert.equal(payload.oi33_checkin.luck, 6);
    assert.match(render(payload), /大凶/);
  }
});

test('unverified readers receive a genuine verification warning, and reads never perform a checkin', async () => {
  const f = fixture({ 4: { realname_flag: 0 } });
  assert.match(render(await f.getHomepageFortune(4, true)), /Verify realname to draw/);
  assert.deepEqual(f.requests, [4]);
});

test('Home request owns its hook and marks user-dependent output private', async () => {
  const f = fixture({ 4: { realname_flag: 1 } });
  const hooks = {};
  f.apply({ on: (name, fn) => { hooks[name] = fn; } });
  const headers = {};
  const home = { constructor: { name: 'HomeHandler' }, user: { _id: 4 }, response: { addHeader: (k, v) => { headers[k] = v; } } };
  const other = { constructor: { name: 'HomeworkDetailHandler' } };
  hooks['handler/create'](home); hooks['handler/create'](other);
  assert.equal(other.getCheckin, undefined);
  assert.equal((await home.getCheckin('system', true)).oi33_checkin_flag, 1);
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.match(fs.readFileSync(path.join(root, 'handler/patches.ts'), 'utf8'), /applyHomepageFortune\(_ctx\)/);
});

class EnrollmentLoader extends nunjucks.FileSystemLoader {
  getSource(name) { return name === 'layout/basic.html' ? { src: '{% block content %}{% endblock %}', path: name } : super.getSource(name); }
}
const enrollmentEnv = new nunjucks.Environment(new EnrollmentLoader(path.join(root, 'templates')), { autoescape: true });
enrollmentEnv.addGlobal('url', (name) => `/${name}`);
test('approved means completed realname, independently of disabled usage status', () => {
  const html = enrollmentEnv.render('oi33_enrollment.html', { enrollment: { status: 'approved', enabled: false, realName: '测试', accountType: 'regular' },
    handler: {}, active: { allowed: false, reason: '账号已停用，请联系教练。' } });
  assert.match(html, /已完成实名认证/);
  assert.match(html, /账号已停用/);
  assert.doesNotMatch(html, /name="realName"/);
});
test('an unverified administrator does not receive a misleading form that always rejects submission', () => {
  const html = enrollmentEnv.render('oi33_enrollment.html', { isAdmin: true, legacyVerified: false, handler: {} });
  assert.match(html, /管理员权限不等于实名认证/);
  assert.doesNotMatch(html, /name="realName"/);
  assert.match(html, /审核与账号管理/);
});
