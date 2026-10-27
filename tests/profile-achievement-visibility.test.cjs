const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(relative, dependencies) {
  const source = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports, name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name === 'crypto') return require('node:crypto');
    throw new Error(`Unexpected import ${relative}: ${name}`);
  });
  return module.exports;
}
const allMask = Number(fs.readFileSync(path.join(root, 'node_modules/@hydrooj/common/permission.ts'), 'utf8')
  .match(/\bPRIV_ALL\s*:\s*(-?\d+)/)[1]);
const hydro = { PRIV: { PRIV_ALL: allMask }, db: { collection: () => ({}) } };
const bioPolicy = load('model/bio-policy.ts', { hydrooj: hydro });
const hashing = load('model/moderate.ts', { hydrooj: hydro });
const { mergeOi33Fields } = load('model/user.ts', { hydrooj: hydro, './bio-policy': bioPolicy,
  './moderate': hashing, './log': { addLog() {} } });
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    if (name === 'components/home.html') return { src: '{% macro render_sidebar() %}{% endmacro %}', path: name };
    if (name === 'components/problem.html') return { src: '{% macro render_problem_title(pdoc) %}<a href="/p/{{ pdoc.pid }}">{{ pdoc.title }}</a>{% endmacro %}', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new Loader([
  path.join(root, 'templates'), path.join(root, 'node_modules/@hydrooj/ui-default/templates'),
]), { autoescape: true });
env.addFilter('markdown', String);
env.addFilter('base64_encode', value => Buffer.from(value).toString('base64'));

function context(viewer, awards) {
  const achievementPanel = { isSelf: viewer === 'self', canManage: viewer === 'admin', awards, showcaseAwards: awards.slice(0, 16) };
  return {
    udoc: { _id: 42, uname: 'student42', realname_flag: 1, nAccept: 1,
      bio: 'Synthetic profile introduction', bio_visible: true, hasPriv: () => true, hasPerm: () => false },
    handler: { user: { _id: viewer === 'self' ? 42 : 9, realname_flag: viewer === 'admin' ? 2 : 1,
      hasPriv: () => false, hasPerm: () => false } },
    isSelfProfile: viewer === 'self', oi33AchievementPanel: achievementPanel,
    PRIV: {}, perm: {}, Math, UiContext: {}, tags: [],
    pdocs: [{ pid: 'P1', title: 'Accepted problem marker' }],
    tdocs: [{ docId: 'synthetic-homework', rule: 'homework', title: 'Activity homework marker' }],
    psdocs: [{ _id: 'synthetic-solution', parentId: 1 }], pdict: { 1: { title: 'Recent solution marker' } },
    model: { builtin: {}, contest: { RULES: { homework: { TEXT: 'Homework' } } } },
    findSubModule: () => ['partials/user_detail/activity.html', 'partials/user_detail/solution.html'],
    avatarUrl: () => '/avatar.svg', datetimeSpan: () => '-',
    url: (name, args) => `/${name}/${args?.uid || args?.tid || args?.sid || ''}`,
    set: (obj, key, value) => { obj[key] = value; return ''; },
    _: value => { const text = new String(value); text.format = (...args) => String(value)
      .replace(/\{(\d+)\}/g, (_, i) => args[i]); return text; },
  };
}

test('profiles hide achievement display and entry points for self, students and administrators while preserving study tabs', () => {
  const populated = Array.from({ length: 51 }, (_, index) => ({ achievement: {
    name: `Hidden achievement ${index}`, description: 'Hidden award detail', imageData: '/hidden-award.svg',
  } }));
  for (const viewer of ['self', 'student', 'admin']) {
    for (const awards of [[], populated]) {
      const data = context(viewer, awards), before = JSON.stringify(data.oi33AchievementPanel);
      const html = env.render('user_detail.html', data);
      assert.doesNotMatch(html, /成就展示柜|编辑展示柜|管理成就|去编辑|查看所有成就|oi33_achievement|oi33-achievement|oi33-showcase|Hidden achievement|hidden-award/);
      assert.deepEqual([...html.matchAll(/<h1 class="section__tab-title">([^<]+)<\/h1>/g)].map(match => match[1]),
        ['Bio', 'Recent Activities', 'Accepted Problems', 'Recent Solutions']);
      for (const text of ['Synthetic profile introduction', 'Activity homework marker', 'Accepted problem marker', 'Recent solution marker']) {
        assert.ok(html.includes(text), `${viewer}: missing ${text}`);
      }
      assert.match(html, /href="\/homework_detail\/synthetic-homework"/);
      assert.match(html, /href="\/p\/P1"/);
      assert.match(html, /href="\/problem_solution_detail\/synthetic-solution"/);
      assert.equal(JSON.stringify(data.oi33AchievementPanel), before, 'Rendering must not alter existing achievement data');
    }
  }
});

test('a global administrator without an OI33 identity displays only the trusted bio while hidden profile data stays hidden', () => {
  const data = context('student', []);
  Object.assign(data.udoc, { priv: allMask, realname_flag: 0, hasPriv: mask => mask === allMask });
  mergeOi33Fields(data.udoc, undefined);
  assert.equal(data.udoc.oi33_profile_hidden, true);
  assert.equal(data.udoc.bio_visible, true);
  const html = env.render('user_detail.html', data);
  assert.ok(html.includes('Synthetic profile introduction'));
  assert.match(html, /section__title">Bio<\/h2>/);
  assert.doesNotMatch(html, /student42|Activity homework marker|Accepted problem marker|Recent solution marker|sidebar-user-stat|注册信息/);
  assert.equal(data.udoc.oi33_profile_hidden, true, 'rendering must not change the identity visibility policy');
});

test('ordinary unverified or rejected profiles cannot use the isolated trusted-bio section', () => {
  for (const identity of [
    { realname_flag: 0, bio_status: 'approved', bio_hash: hashing.bioHashOf('Synthetic profile introduction') },
    { realname_flag: 1, bio_status: 'rejected', bio_hash: hashing.bioHashOf('Synthetic profile introduction') },
  ]) {
    const data = context('admin', []);
    Object.assign(data.udoc, { priv: 0, role: 'coach', hasPriv: () => false });
    mergeOi33Fields(data.udoc, identity);
    assert.equal(data.udoc.bio_visible, false);
    const html = env.render('user_detail.html', data);
    assert.doesNotMatch(html, /Synthetic profile introduction/);
  }
});
