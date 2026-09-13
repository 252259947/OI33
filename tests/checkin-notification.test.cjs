const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
const today = '2026-09-13';
const rules = ['checkin_streak', 'checkin_total', 'cat_food_balance'];
class ForbiddenError extends Error {}

async function fixture(options = {}) {
  const calls = { flags: [], checkins: [], achievements: [], urls: [], errors: [] };
  const result = Object.freeze({ checkedIn: true, cat_food_reward: 100, checkin_luck: 2,
    checkin_cnt_now: 1, checkin_cnt_all: 2, ...options.result });
  const hydro = {
    Handler: class {}, PRIV: { PRIV_USER_PROFILE: 'profile' }, Types: {},
    param: () => () => {}, query: () => () => {}, ForbiddenError,
    moment: () => ({ format: (format) => { assert.equal(format, 'YYYY-MM-DD'); return today; } }),
  };
  const dependencies = {
    hydrooj: hydro,
    '../model': { oi33Model: {
      async doCheckin(...args) { calls.checkins.push(args); return result; },
      async achievementEvaluateUser(...args) {
        calls.achievements.push(args);
        if (options.achievementError) throw options.achievementError;
      },
      formatCatFood: (amount) => `${amount} g`,
    } },
    './utils': { async checkUserFlag(uid) { calls.flags.push(uid); return options.flag ?? 1; } },
  };
  const code = transformSync(fs.readFileSync(path.join(root, 'handler/user.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'console', code)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, { error: (...args) => calls.errors.push(args) });
  const routes = new Map();
  await module.exports.apply({ Route: (name, pathname, Handler, privilege) => {
    routes.set(name, { pathname, Handler, privilege });
  } });
  const route = routes.get('oi33_checkin');
  assert.equal(route.pathname, '/oi33/checkin');
  assert.equal(route.privilege, hydro.PRIV.PRIV_USER_PROFILE);
  const handler = new route.Handler();
  handler.user = { _id: 4 };
  handler.response = {};
  handler.translate = (text) => text;
  handler.url = (...args) => {
    calls.urls.push(args);
    assert.equal(args[0], 'homepage');
    const query = new URLSearchParams(args[1]?.query || {}).toString();
    return query ? `/?${query}` : '/';
  };
  return { handler, calls, result };
}

for (const reward of [100, 0]) {
  test(`a new checkin with reward ${reward} redirects silently and still evaluates achievements`, async () => {
    const f = await fixture({ result: { cat_food_reward: reward } });
    await f.handler.post();
    assert.deepEqual(f.calls.flags, [4]);
    assert.deepEqual(f.calls.checkins, [[4, today]]);
    assert.deepEqual(f.calls.achievements, [[4, { ruleTypes: rules }]]);
    assert.deepEqual(f.calls.urls, [['homepage']]);
    assert.equal(f.handler.response.redirect, '/');
    assert.deepEqual(f.handler.response, { redirect: '/' });
    assert.deepEqual(f.result, { checkedIn: true, cat_food_reward: reward, checkin_luck: 2,
      checkin_cnt_now: 1, checkin_cnt_all: 2 });
    assert.deepEqual(f.calls.errors, []);
  });
}

test('an already completed checkin remains silent without a second achievement evaluation', async () => {
  const f = await fixture({ result: { checkedIn: false, cat_food_reward: 0 } });
  await f.handler.post();
  assert.deepEqual(f.calls.checkins, [[4, today]]);
  assert.deepEqual(f.calls.achievements, []);
  assert.deepEqual(f.calls.urls, [['homepage']]);
  assert.deepEqual(f.handler.response, { redirect: '/' });
});

test('unverified users are still rejected before checkin or achievement writes', async () => {
  const f = await fixture({ flag: 0 });
  await assert.rejects(() => f.handler.post(), { name: 'Error', message: '完成实名认证后才能签到。' });
  assert.deepEqual(f.calls.flags, [4]);
  assert.deepEqual(f.calls.checkins, []);
  assert.deepEqual(f.calls.achievements, []);
  assert.deepEqual(f.calls.urls, []);
  assert.deepEqual(f.handler.response, {});
});

test('achievement evaluation failures are logged but do not prevent the silent homepage redirect', async () => {
  const error = new Error('achievement evaluation unavailable');
  const f = await fixture({ achievementError: error });
  await f.handler.post();
  assert.deepEqual(f.calls.checkins, [[4, today]]);
  assert.deepEqual(f.calls.achievements, [[4, { ruleTypes: rules }]]);
  assert.deepEqual(f.calls.errors, [['[oi33] checkin achievement evaluation failed:', error]]);
  assert.deepEqual(f.calls.urls, [['homepage']]);
  assert.deepEqual(f.handler.response, { redirect: '/' });
});

test('the fortune widget still renders its stored outcome and consecutive/total day counts', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(root, 'templates')), { autoescape: true });
  const html = env.render('partials/homepage/checkin.html', {
    UserContext: { _id: 4 }, _: (text) => text,
    payload: { oi33_checkin_flag: 1, luck_today: today, luck_type: [{ text: '吉', color: '#123456' }],
      oi33_checkin: { time: today, luck: 0, cnt_now: 1, cnt_all: 2 } },
  });
  assert.match(html, /§ 吉 §/);
  assert.match(html, /Consecutive days 1 days, total 2 days/);
  assert.doesNotMatch(html, /<form|Draw Today Fortune|Check-in succeeded|notification/);
});
