const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { ObjectId } = require('mongodb');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(file, dependencies) {
  const { code } = transformSync(read(file), { loader: 'ts', format: 'cjs', target: 'node18' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
class ForbiddenError extends Error {}
class NotFoundError extends Error {}
const PRIV = { PRIV_USER_PROFILE: 1, PRIV_ALL: 2 };
const PERM = { PERM_VIEW_HOMEWORK: 1n, PERM_VIEW_TRAINING: 2n };
const homeworkId = '111111111111111111111111';
const trainingId = '222222222222222222222222';

function harness() {
  const state = new Map(), docs = new Map(), hooks = new Map(), routes = [];
  const writes = [], reads = [], trainingChecks = [];
  let readError, writeError, trainingError;
  const coll = {
    async findOne(query) {
      if (readError) throw readError;
      reads.push(query);
      const value = state.get(query._id);
      return value && Object.entries(query).every(([key, val]) => value[key] === val) ? { ...value } : null;
    },
    async updateOne(query, update, options) {
      if (writeError) throw writeError;
      writes.push({ query, update, options });
      state.set(query._id, { ...state.get(query._id), _id: query._id, ...update.$set });
    },
  };
  const model = compile('model/recent-learning.ts', { hydrooj: { db: { collection(name) {
    assert.equal(name, 'oi33_recent_learning'); return coll;
  } } } });
  const auth = compile('model/education-auth.ts', { hydrooj: { ForbiddenError, PRIV } });
  async function getDoc(domainId, tid) {
    if (readError) throw readError;
    const doc = docs.get(`${domainId}:${tid}`);
    if (!doc) throw new NotFoundError();
    return { ...doc };
  }
  class Handler {}
  const handler = compile('handler/recent-learning.ts', {
    hydrooj: { Handler, ForbiddenError, NotFoundError, ObjectId, PRIV, PERM,
      ContestModel: { get: getDoc }, TrainingModel: { get: getDoc } },
    '../model/education-auth': auth,
    '../model/recent-learning': model,
    './homework-access': { homeworkGroups: async user => user.groups },
  });
  handler.apply({ Route: (...args) => routes.push(args), on: (name, fn) => hooks.set(name, fn) });
  const add = (kind, domain = 'system') => {
    const tid = kind === 'homework' ? homeworkId : trainingId;
    const doc = { domainId: domain, docId: new ObjectId(tid),
      ...(kind === 'homework' ? { rule: 'homework', assign: ['class-a'] } : {}), title: `${kind} fixture` };
    docs.set(`${domain}:${tid}`, doc);
    return doc;
  };
  add('homework'); add('training');
  function make({ uid = 42, domain = 'system', role = 'default', groups = ['class-a'],
    permissions = [PERM.PERM_VIEW_HOMEWORK, PERM.PERM_VIEW_TRAINING], args = {} } = {}) {
    const h = new handler.RecentLearningHandler();
    h.domain = { _id: domain }; h.args = { domainId: domain, ...args };
    h.user = { _id: uid, role, groups, hasPriv: privilege => privilege === PRIV.PRIV_USER_PROFILE && uid > 0,
      hasPerm: permission => permissions.includes(permission) };
    h.checkPriv = value => { if (!h.user.hasPriv(value)) throw new ForbiddenError(); };
    h.checkPerm = value => { if (!h.user.hasPerm(value)) throw new ForbiddenError(); };
    h.request = { method: 'get', query: {}, headers: {} };
    h.response = { body: {}, headers: {}, addHeader(name, value) { this.headers[name] = value; } };
    h.ctx = { parallel: async (event, doc, subject) => {
      trainingChecks.push({ event, doc, uid: subject.user._id });
      if (trainingError) throw trainingError;
    } };
    h.url = (name, ...options) => {
      const data = Object.assign({}, ...options);
      const prefix = domain === 'system' ? '' : `/d/${domain}`;
      const routes = { homework_main: '/homework', training_main: '/training',
        oi33_recent_learning: '/oi33/learning/continue', homework_detail: `/homework/${data.tid}`,
        training_detail: `/training/${data.tid}` };
      return `${prefix}${routes[name] || `/${name}`}${data.query ? `?${new URLSearchParams(data.query)}` : ''}`;
    };
    return h;
  }
  const visit = async (kind, options) => {
    const h = make(options);
    h.response.template = `${kind}_detail.html`;
    h.response.body = { tdoc: docs.get(`${h.domain._id}:${kind === 'homework' ? homeworkId : trainingId}`) };
    await hooks.get(`handler/finish/${kind === 'homework' ? 'Homework' : 'Training'}Detail#get`)(h);
    return h;
  };
  return { model, handler, state, docs, hooks, routes, writes, reads, trainingChecks, make, add, visit,
    setReadError(value) { readError = value; }, setWriteError(value) { writeError = value; },
    setTrainingError(value) { trainingError = value; } };
}

test('server preference is one minimal record per trusted account and domain, across both lesson types', async () => {
  const env = harness();
  await env.visit('homework');
  assert.equal((await env.model.getRecentLearning('system', 42)).tid, homeworkId);
  await env.visit('training');
  assert.equal((await env.model.getRecentLearning('system', 42)).tid, trainingId);
  assert.equal(env.state.size, 1, 'A lesson visit replaces the preference, not appends browsing history');
  await env.visit('homework', { uid: 43 });
  env.add('homework', 'second-school');
  await env.visit('homework', { domain: 'second-school' });
  assert.equal(env.state.size, 3);
  assert.equal((await env.model.getRecentLearning('system', 42)).kind, 'training');
  assert.equal((await env.model.getRecentLearning('system', 43)).kind, 'homework');
  assert.equal((await env.model.getRecentLearning('second-school', 42)).kind, 'homework');
  assert.equal(await env.model.getRecentLearning('other-school', 42), null);
  assert.deepEqual(Object.keys([...env.state.values()][0]).sort(), ['_id', 'domainId', 'kind', 'tid', 'uid', 'visitedAt']);
  assert.ok([...env.state.values()][0].visitedAt instanceof Date);
});

test('invalid or poisoned preferences cannot become arbitrary routes or another user/domain record', async () => {
  const env = harness();
  for (const entry of [
    { kind: 'contest', tid: homeworkId }, { kind: 'homework', tid: 'https://example.org/' },
    { kind: 'training', tid: '../../user/1' }, { kind: 'training', tid: { toString: () => trainingId } },
    { kind: 'training', tid: '2'.repeat(25) }, { kind: 'training', tid: '' },
  ]) {
    env.state.set('["system",42]', { _id: '["system",42]', domainId: 'system', uid: 42, ...entry });
    const h = env.make(); await h.get();
    assert.equal(h.response.redirect, '/homework?resume=empty');
    await assert.rejects(() => env.model.rememberLearning('system', 42, entry.kind, entry.tid), /Invalid recent learning target/);
  }
  env.state.set('["system",42]', { _id: '["system",42]', domainId: 'stolen', uid: 43, kind: 'training', tid: trainingId });
  assert.equal(await env.model.getRecentLearning('system', 42), null);
  for (const uid of [0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => env.model.getRecentLearning('system', uid), /Invalid recent learning identity/);
  }
  assert.deepEqual(env.writes, []);
});

test('only successful native homework/training detail GETs, including PJAX, record visits', async () => {
  const env = harness();
  assert.deepEqual([...env.hooks.keys()], [
    'handler/finish/HomeworkDetail#get', 'handler/finish/TrainingDetail#get', 'handler/after/HomeworkMain#get',
  ]);
  for (const variation of [
    h => { h.request.method = 'post'; }, h => { h.request.method = 'head'; },
    h => { h.response.template = 'homework_edit.html'; }, h => { h.response.template = 'problem_detail.html'; },
    h => { h.response.template = 'contest_detail.html'; }, h => { h.response.redirect = '/login'; },
    h => { h.response.status = 403; }, h => { h.response.body = {}; },
    h => { h.response.body.tdoc.rule = 'ioi'; }, h => { h.user._id = 0; },
    h => { h.response.body.tdoc.domainId = 'stolen'; },
  ]) {
    const h = env.make();
    h.response.template = 'homework_detail.html';
    h.response.body = { tdoc: { ...env.docs.get(`system:${homeworkId}`) } };
    variation(h);
    await env.handler.rememberLearningVisit(h, 'homework');
  }
  assert.equal(env.writes.length, 0);
  const h = await env.visit('homework', { args: { uid: 99, tid: trainingId, url: 'https://example.org/' } });
  assert.equal((await env.model.getRecentLearning('system', 42)).tid, homeworkId);
  assert.equal(await env.model.getRecentLearning('system', 99), null);
  h.request.headers['x-pjax'] = 'true';
  await env.handler.rememberLearningVisit(h, 'homework');
  assert.equal(env.writes.length, 2);
  assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
});

test('preference storage failure does not block opening a lesson; lookup errors are not hidden', async () => {
  const env = harness();
  env.setWriteError(new Error('fixture storage unavailable'));
  const warnings = [], original = console.warn;
  try {
    console.warn = (...args) => warnings.push(args);
    const h = await env.visit('training');
    assert.equal(h.response.template, 'training_detail.html');
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.equal(env.state.size, 0);
  env.setReadError(new Error('fixture database unavailable'));
  await assert.rejects(() => env.make().get(), /fixture database unavailable/);
});

test('new accounts safely open homework list; authentication and trusted domain are mandatory', async () => {
  const env = harness();
  const h = env.make(); await h.get();
  assert.equal(h.response.redirect, '/homework?resume=empty');
  assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(env.routes.map(args => [args[0], args[1], args[3]]),
    [['oi33_recent_learning', '/oi33/learning/continue', PRIV.PRIV_USER_PROFILE]]);
  await assert.rejects(() => env.make({ uid: 0 }).get(), ForbiddenError);
  await assert.rejects(() => env.make({ args: { domainId: 'stolen' } }).get(), ForbiddenError);
  await assert.rejects(() => env.visit('homework', { args: { domainId: 'stolen' } }), ForbiddenError);
  assert.equal(env.state.size, 0);
});

test('homework continuation rechecks present class and native permission without enrolling users', async () => {
  const env = harness(); await env.visit('homework');
  const h = env.make(); await h.get();
  assert.equal(h.response.redirect, `/homework/${homeworkId}`);
  for (const options of [{ groups: [] }, { permissions: [] }]) {
    const subject = env.make(options); await subject.get();
    assert.equal(subject.response.redirect, '/homework?resume=unavailable');
  }
  const coach = env.make({ role: 'coach', groups: [] }); await coach.get();
  assert.equal(coach.response.redirect, `/homework/${homeworkId}`);
  const coachWithoutPermission = env.make({ role: 'coach', groups: [], permissions: [] });
  await coachWithoutPermission.get();
  assert.equal(coachWithoutPermission.response.redirect, '/homework?resume=unavailable');
  assert.equal(env.writes.length, 1, 'Continuing never changes attendance, scores or lesson preference');
  env.docs.get(`system:${homeworkId}`).rule = 'ioi';
  const changed = env.make(); await changed.get();
  assert.equal(changed.response.redirect, '/homework?resume=unavailable');
});

test('training continuation retains native permission and extension gate without treating DB failures as expiry', async () => {
  const env = harness(); await env.visit('training');
  const h = env.make(); await h.get();
  assert.equal(h.response.redirect, `/training/${trainingId}`);
  assert.equal(env.trainingChecks.length, 1);
  assert.equal(env.trainingChecks[0].event, 'training/get');
  assert.equal(env.trainingChecks[0].uid, 42);
  const noPermission = env.make({ permissions: [] }); await noPermission.get();
  assert.equal(noPermission.response.redirect, '/homework?resume=unavailable');
  assert.equal(env.trainingChecks.length, 1);
  env.setTrainingError(new ForbiddenError());
  const rejected = env.make(); await rejected.get();
  assert.equal(rejected.response.redirect, '/homework?resume=unavailable');
  env.setTrainingError(new Error('fixture extension failure'));
  await assert.rejects(() => env.make().get(), /fixture extension failure/);
});

test('deleted targets safely fall back, another account cannot borrow history and URLs retain current domain', async () => {
  const env = harness();
  for (const kind of ['homework', 'training']) {
    env.add(kind, 'school-two');
    await env.visit(kind, { domain: 'school-two' });
    const own = env.make({ domain: 'school-two' }); await own.get();
    assert.equal(own.response.redirect, `/d/school-two/${kind}/${kind === 'homework' ? homeworkId : trainingId}`);
    const other = env.make({ uid: 43, domain: 'school-two', args: { uid: 42 } }); await other.get();
    assert.equal(other.response.redirect, '/d/school-two/homework?resume=empty');
    env.docs.delete(`school-two:${kind === 'homework' ? homeworkId : trainingId}`);
    const removed = env.make({ domain: 'school-two' }); await removed.get();
    assert.equal(removed.response.redirect, '/d/school-two/homework?resume=unavailable');
  }
});

test('fallback notices use only fixed server messages, never arbitrary query text', () => {
  const env = harness();
  for (const [value, expected] of [['empty', '还没有最近练习记录'], ['unavailable', '已不可访问']]) {
    const h = env.make(); h.response.template = 'homework_main.html'; h.request.query.resume = value;
    env.handler.addRecentLearningNotice(h);
    assert.ok(h.response.body.oi33RecentLearningNotice.includes(expected));
  }
  for (const value of ['<script>alert(1)</script>', ['empty'], 'https://example.org/']) {
    const h = env.make(); h.response.template = 'homework_main.html'; h.request.query.resume = value;
    env.handler.addRecentLearningNotice(h);
    assert.equal(h.response.body.oi33RecentLearningNotice, undefined);
  }
});

function renderHome(h) {
  class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
      if (name === 'layout/basic.html') return { src: '<!doctype html><html><body>{% block content %}{% endblock %}</body></html>', path: name };
      if (name.startsWith('components/')) return { src: '', path: name };
      return super.getSource(name);
    }
  }
  const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
  return env.render('main.html', { handler: h, PRIV, contents: [], url: h.url });
}

test('actual homepage has a native continuation link and explanation; anonymous homepage never borrows it', () => {
  const env = harness();
  assert.match(renderHome(env.make()), /href="\/oi33\/learning\/continue" title="返回上次打开的作业或训练计划；首次使用时打开作业列表。">继续练习/);
  assert.doesNotMatch(renderHome(env.make({ uid: 0 })), /learning\/continue|继续练习/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real Chrome follows lesson preference across devices, PJAX visits and accounts without browser storage', async () => {
  const { chromium } = require('playwright');
  const env = harness();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      const uid = Number(/fixtureUid=(\d+)/.exec(request.headers.cookie || '')?.[1] || 0);
      const h = env.make({ uid });
      let html;
      if (url.pathname === '/') html = renderHome(h);
      else if (url.pathname === '/oi33/learning/continue') await h.get();
      else if (/^\/(homework|training)\/[a-f\d]{24}$/.test(url.pathname)) {
        const [, kind, tid] = url.pathname.split('/');
        const doc = env.docs.get(`system:${tid}`);
        if (!doc) { response.writeHead(404); response.end('Not found'); return; }
        h.response.template = `${kind}_detail.html`; h.response.body = { tdoc: doc };
        h.request.headers = request.headers;
        await env.handler.rememberLearningVisit(h, kind);
        html = `<h1>${kind} fixture</h1><a href="/">首页</a>`;
      } else if (url.pathname === '/homework') {
        h.response.template = 'homework_main.html'; h.request.query = Object.fromEntries(url.searchParams);
        env.handler.addRecentLearningNotice(h);
        html = `<h1>作业</h1><p role="status">${h.response.body.oi33RecentLearningNotice || ''}</p>`;
      } else { response.writeHead(404); response.end('Not found'); return; }
      if (h.response.redirect) {
        response.writeHead(302, { Location: h.response.redirect, ...h.response.headers }); response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...h.response.headers });
      response.end(html);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'fixtureUid', value: '42', url: base }]);
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole('link', { name: '继续练习', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/homework');
    assert.match(await page.getByRole('status').textContent(), /还没有最近练习记录/);
    await page.goto(`${base}/homework/${homeworkId}`);
    await page.goto(base);
    await page.getByRole('link', { name: '继续练习', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, `/homework/${homeworkId}`);
    // Successful PJAX rendering issues the same native GET and finish hook.
    await page.evaluate(async tid => {
      const response = await fetch(`/training/${tid}`, { headers: { 'X-PJAX': 'true' } });
      document.body.innerHTML = await response.text();
      history.pushState({}, '', `/training/${tid}`);
    }, trainingId);
    assert.equal((await env.model.getRecentLearning('system', 42)).kind, 'training');
    const secondDevice = await browser.newContext();
    await secondDevice.addCookies([{ name: 'fixtureUid', value: '42', url: base }]);
    const secondPage = await secondDevice.newPage();
    await secondPage.goto(base);
    assert.deepEqual(await secondPage.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await secondPage.getByRole('link', { name: '继续练习', exact: true }).click();
    assert.equal(new URL(secondPage.url()).pathname, `/training/${trainingId}`);
    await context.addCookies([{ name: 'fixtureUid', value: '43', url: base }]);
    await page.goto(base);
    await page.getByRole('link', { name: '继续练习', exact: true }).click();
    assert.match(page.url(), /\/homework\?resume=empty$/);
    env.docs.delete(`system:${trainingId}`);
    await secondPage.goto(base);
    await secondPage.getByRole('link', { name: '继续练习', exact: true }).click();
    assert.match(secondPage.url(), /\/homework\?resume=unavailable$/);
    assert.match(await secondPage.getByRole('status').textContent(), /已不可访问/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
