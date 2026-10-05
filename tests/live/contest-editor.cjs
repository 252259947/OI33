/* Linux-only real Hydro/Mongo integration test. All data and accounts are
 * synthetic. Never connects to production HTTP/Mongo or reads its config.
 * Uses unused loopback ports 8899/27019, a random profile and /tmp directory.
 * NODE_PATH=/usr/local/share/.config/yarn/global/node_modules node this-file
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongodb');

const root = path.resolve(__dirname, '../..');
const globalModules = process.env.OI33_QA_GLOBAL_MODULES || '/usr/local/share/.config/yarn/global/node_modules';
const node = process.env.OI33_QA_NODE || '/root/.nix-profile/bin/node';
const mongod = process.env.OI33_QA_MONGOD || '/root/.nix-profile/bin/mongod';
const base = 'http://127.0.0.1:8899';
const mongoPort = 27019;
const password = 'SyntheticContestEditor!2026';
const inviteCode = 'SyntheticContestInviteOnly';
const run = `oi33-contest-editor-qa-${Date.now()}-${process.pid}`;
const report = { run, tests: [], isolated: { mongoPort, httpPort: 8899 }, ok: false };
let fixture, profile, hydroProcess, mongoProcess, client;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (name, value) => fs.writeFileSync(name, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function check(name, condition, detail = '') {
  report.tests.push({ name, passed: !!condition, detail });
  assert.ok(condition, `${name}: ${detail}`);
  console.log(`PASS ${name}`);
}
function sockets() {
  return execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }).split('\n')
    .filter((line) => /:(8888|27017|8899|27019)\s/.test(line))
    .map((line) => line.trim().replace(/\s+/g, ' ')).sort();
}
const originalSockets = () => sockets().filter((line) => /:(8888|27017)\s/.test(line));
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Refusing occupied fixture port ${port}`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function waitFor(predicate, label, ms = 55000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await delay(250);
  }
  throw new Error(`Timeout: ${label}`);
}
function session() {
  const cookies = new Map();
  return async (route, form, html = false) => {
    const response = await fetch(`${base}${route}`, {
      method: form ? 'POST' : 'GET', redirect: 'manual',
      headers: { Accept: html ? 'text/html' : 'application/json', Referer: `${base}${route}`, Origin: base,
        Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: response.status, body, location: response.headers.get('location'), cache: response.headers.get('cache-control') };
  };
}
async function login(actor, name) {
  await actor('/login');
  const result = await actor('/login', { uname: name, password });
  check(`fixture login ${name}`, result.status < 400, `HTTP ${result.status}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejected = (result) => result.status >= 400 && result.status < 500;
function attr(tag, name) { return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1]; }
function input(html, name) { return (html.match(/<input\b[^>]*>/gi) || []).find((tag) => attr(tag, 'name') === name) || ''; }

async function verify(db, data) {
  const actors = Object.fromEntries(['admin', 'owner', 'creator', 'editor', 'maintainer', 'student'].map((name) => [name, session()]));
  for (const [name, actor] of Object.entries(actors)) await login(actor, `qa_${name}`);
  const load = (id) => db.collection('document').findOne({ domainId: 'system', docType: 30, docId: new ObjectId(id) });
  const count = () => db.collection('document').countDocuments({ docType: 30 });
  const source = await load(data.tid);
  const beforeStatuses = await db.collection('document.status').find({ docId: source.docId }).toArray();
  const beforeRecords = await db.collection('record').find({ contest: source.docId }).toArray();
  const beforeCount = await count();
  let result = await actors.owner(`/contest/create?copyFrom=${data.tid}`, null, true);
  check('owner opens real prefilled create HTML', result.status === 200 && /data-page="contest_create"/.test(result.body.raw || ''), `HTTP ${result.status}`);
  const html = result.body.raw;
  check('copy HTML includes source title description and ordered problem IDs',
    attr(input(html, 'title'), 'value') === source.title && html.includes(source.content)
    && attr(input(html, 'pids'), 'value') === source.pids.join(','));
  check('copy form retains source reference but no destructive edit button',
    attr(input(html, 'copyFrom'), 'value') === data.tid && !/value="delete"/.test(html));
  check('copy end date and time are editable',
    !!input(html, 'oi33EndAtDate') && !!input(html, 'oi33EndAtTime')
    && !/\sdisabled\b/.test(input(html, 'oi33EndAtDate') + input(html, 'oi33EndAtTime')));
  check('copy preserves source local schedule pending user adjustment',
    /^2035-0?6-0?1$/.test(attr(input(html, 'beginAtDate'), 'value'))
    && /^0?9:00$/.test(attr(input(html, 'beginAtTime'), 'value'))
    && attr(input(html, 'oi33EndAtDate'), 'value') === '2035-06-01'
    && attr(input(html, 'oi33EndAtTime'), 'value') === '12:00');
  check('source attachment upload controls are absent from copy form', !/name="upload_file"/.test(html));
  check('copy form is private no-store', /no-store/.test(result.cache));
  const jsonCopy = await actors.owner(`/contest/create?copyFrom=${data.tid}`);
  check('copy response preserves permissions and contest options', jsonCopy.status === 200
    && attr(input(html, 'code'), 'value') === source._code && same(jsonCopy.body.tdoc?.assign, source.assign)
    && same(jsonCopy.body.tdoc?.maintainer, source.maintainer) && same(jsonCopy.body.tdoc?.langs, source.langs)
    && jsonCopy.body.tdoc?.rated === source.rated && jsonCopy.body.tdoc?.allowPrint === true);
  check('GET copy leaves source contest, status and total count unchanged', beforeCount === await count()
    && same(source, await load(data.tid)) && same(beforeStatuses, await db.collection('document.status').find({ docId: source.docId }).toArray()));
  result = await actors.maintainer(`/contest/create?copyFrom=${data.tid}`);
  check('authorized source maintainer can prefill copy', result.status === 200, `HTTP ${result.status}`);
  for (const [name, id] of [['creator', data.tid], ['editor', data.tid], ['student', data.tid], ['owner', data.foreignTid], ['admin', data.homeworkTid]]) {
    result = await actors[name](`/contest/create?copyFrom=${id}`);
    check(`GET copy rejects ${name} ${id === data.foreignTid ? 'foreign domain' : id === data.homeworkTid ? 'homework' : 'missing permission'}`,
      rejected(result), `HTTP ${result.status}`);
  }
  result = await session()(`/contest/create?copyFrom=${data.tid}`);
  // Hydro serializes redirects for JSON clients as HTTP 200 { url: '/login?...' }.
  // Only that exact login-only body is accepted, never an arbitrary HTTP 200.
  const anonymousKeys = Object.keys(result.body || {});
  let anonymousRedirectPath = '';
  try { anonymousRedirectPath = new URL(result.body.url || result.location || '', base).pathname; } catch {}
  const anonymousLoginOnly = result.status === 200 && same(anonymousKeys, ['url'])
    && anonymousRedirectPath === '/login';
  const anonymousPayload = JSON.stringify(result.body);
  const anonymousNoSettings = !['tdoc', 'pids', 'rules', 'beginAt', 'oi33CopyFrom'].some((key) => key in result.body)
    && !anonymousPayload.includes(source.title) && !anonymousPayload.includes(source.content)
    && !anonymousPayload.includes(source._code);
  check('anonymous cannot access copy settings', anonymousNoSettings
    && (rejected(result) || result.status === 302 && anonymousRedirectPath === '/login' || anonymousLoginOnly),
  `HTTP ${result.status}; body keys ${anonymousKeys.join(',')}; redirect path ${anonymousRedirectPath}; no settings ${anonymousNoSettings}`);
  result = await actors.owner('/contest/create?copyFrom=invalid');
  check('malformed source ID is rejected', rejected(result), `HTTP ${result.status}`);
  const form = (extra = {}) => ({ operation: 'update', title: source.title, content: source.content, rule: source.rule,
    beginAtDate: '2035-06-01', beginAtTime: '09:00', duration: '999', oi33EndAtDate: '2035-06-01', oi33EndAtTime: '12:30',
    pids: source.pids.join(','), rated: 'true', autoHide: 'false', allowViewCode: 'false', allowPrint: 'true',
    keepScoreboardHidden: 'false', code: source._code, assign: source.assign.join(','), maintainer: source.maintainer.join(','),
    lock: '30', langs: source.langs.join(','), ...extra });
  for (const name of ['creator', 'editor', 'student']) {
    result = await actors[name]('/contest/create', form({ copyFrom: data.tid }));
    check(`POST copy rejects ${name} without both permissions`, rejected(result), `HTTP ${result.status}`);
  }
  for (const [name, sourceId] of [['foreign-domain source', data.foreignTid], ['homework source', data.homeworkTid], ['malformed source', 'invalid']]) {
    result = await actors.admin('/contest/create', form({ copyFrom: sourceId }));
    check(`POST copy rejects ${name}`, rejected(result), `HTTP ${result.status}`);
  }
  result = await actors.editor('/contest/create', form({ tid: data.tid, copyFrom: data.tid }));
  check('forged existing tid cannot turn create into authorized editing', rejected(result), `HTTP ${result.status}`);
  check('rejected copy requests created no contest', await count() === beforeCount);
  const [copied, ordinary] = await Promise.all([
    actors.owner('/contest/create', form({ copyFrom: data.tid })),
    actors.creator('/contest/create', form({ title: 'QA ordinary concurrent contest', code: '', assign: '', maintainer: '', rated: 'false' })),
  ]);
  check('copy and ordinary create succeed concurrently', copied.status < 400 && ordinary.status < 400,
    `copy HTTP ${copied.status}; ordinary HTTP ${ordinary.status}`);
  const copiedId = String(copied.body.tid || copied.location?.split('/').pop());
  const ordinaryId = String(ordinary.body.tid || ordinary.location?.split('/').pop());
  check('copy creates a new independent contest ID', ObjectId.isValid(copiedId) && copiedId !== data.tid && copiedId !== ordinaryId);
  const copy = await load(copiedId);
  const normal = await load(ordinaryId);
  check('copy preserves settings and requested local times', copy.owner === 3 && same(copy.pids, source.pids)
    && copy.title === source.title && copy.content === source.content && copy._code === source._code
    && same(copy.assign, source.assign) && same(copy.maintainer, source.maintainer) && same(copy.langs, source.langs)
    && copy.rated === true && copy.allowViewCode === false && copy.allowPrint === true
    && copy.beginAt.toISOString() === '2035-06-01T01:00:00.000Z' && copy.endAt.toISOString() === '2035-06-01T04:30:00.000Z'
    && copy.lockAt.toISOString() === '2035-06-01T04:00:00.000Z');
  check('copy inherits problem score and balloon configuration only', same(copy.score, source.score) && same(copy.balloon, source.balloon));
  check('ordinary concurrent create has no copied source configuration', !normal.score && !normal.balloon && normal.owner === 4);
  check('copy does not inherit files participants or unlocked state', !copy.files?.length && !copy.privateFiles?.length
    && copy.attend === 0 && !copy.unlocked
    && await db.collection('document.status').countDocuments({ docId: copy.docId }) === 0
    && await db.collection('record').countDocuments({ contest: copy.docId }) === 0);
  check('copy does not modify source or its records and status', same(source, await load(data.tid))
    && same(beforeStatuses, await db.collection('document.status').find({ docId: source.docId }).toArray())
    && same(beforeRecords, await db.collection('record').find({ contest: source.docId }).toArray()));
  result = await actors.owner(`/contest/${copiedId}/edit`, form({ oi33EndAtTime: '14:15' }));
  let updated = await load(copiedId);
  check('editing explicit end time overrides stale duration', result.status < 400 && updated.endAt.toISOString() === '2035-06-01T06:15:00.000Z', `HTTP ${result.status}`);
  check('native scoreboard lock recalculates relative to new end', updated.lockAt.toISOString() === '2035-06-01T05:45:00.000Z');
  for (const [name, extra] of [
    ['equal begin/end', { oi33EndAtTime: '09:00' }],
    ['end before begin', { oi33EndAtTime: '08:59' }],
    ['invalid calendar date', { oi33EndAtDate: '2035-02-30' }],
    ['invalid time', { oi33EndAtTime: '25:00' }],
    ['partial explicit end', { oi33EndAtTime: '' }],
  ]) {
    const previous = await load(copiedId);
    result = await actors.owner(`/contest/${copiedId}/edit`, form(extra));
    check(`invalid end rejected: ${name}`, rejected(result) && same(previous, await load(copiedId)), `HTTP ${result.status}`);
  }
  const legacy = form({ duration: '2.5' });
  delete legacy.oi33EndAtDate; delete legacy.oi33EndAtTime;
  result = await actors.owner(`/contest/${copiedId}/edit`, legacy);
  updated = await load(copiedId);
  check('legacy duration-only update remains compatible', result.status < 400 && updated.endAt.toISOString() === '2035-06-01T03:30:00.000Z', `HTTP ${result.status}`);
  result = await actors.student(`/contest/${copiedId}/edit`, form());
  check('ordinary student cannot bypass native edit permissions', rejected(result) && same(updated, await load(copiedId)), `HTTP ${result.status}`);
  const homeworkBefore = await load(data.homeworkTid);
  result = await actors.admin(`/homework/${data.homeworkTid}/edit`, { operation: 'update', title: homeworkBefore.title,
    content: homeworkBefore.content, pids: source.pids.join(','), beginAtDate: '2035-06-01', beginAtTime: '09:00',
    penaltySinceDate: '2035-06-02', penaltySinceTime: '10:00', extensionDays: '0', penaltyRules: '{}',
    rated: 'false', maintainer: '', assign: '', langs: '', oi33EndAtDate: '1900-01-01', oi33EndAtTime: '00:00', copyFrom: data.tid });
  const homeworkAfter = await load(data.homeworkTid);
  check('contest adapter leaves native homework ending fields untouched', result.status < 400
    && homeworkAfter.endAt.toISOString() === '2035-06-02T02:00:00.000Z' && !homeworkAfter.score && !homeworkAfter.balloon,
  `HTTP ${result.status}`);
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run this isolated runtime test under Linux/WSL.');
  await ensureFree(mongoPort); await ensureFree(8899);
  report.isolated.existingServicesBefore = originalSockets();
  fixture = fs.mkdtempSync('/tmp/oi33-contest-editor-qa-');
  profile = path.join(os.homedir(), '.hydro', 'profiles', run);
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(profile, { recursive: false });
  for (const name of ['db', 'store', 'tmp', 'addon/templates/partials']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
  report.isolated.fixture = fixture; report.isolated.profile = profile;
  write(path.join(profile, 'config.json'), { host: '127.0.0.1', port: String(mongoPort), name: run.replaceAll('-', '_') });
  write(path.join(profile, 'addon.json'), [path.join(globalModules, '@hydrooj/ui-default'), path.join(fixture, 'addon')]);
  write(path.join(fixture, 'addon/package.json'), { name: 'oi33-contest-editor-qa', version: '1.0.0', main: 'index.js' });
  for (const name of ['contest_edit.html', 'partials/contest_sidebar.html', 'partials/contest_sidebar_management.html']) {
    const source = path.join(root, 'templates', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(fixture, 'addon/templates', name));
  }
  const ready = path.join(fixture, 'ready.json');
  write(path.join(fixture, 'addon/index.js'), `
const fs = require('fs');
const { db, UserModel, DomainModel, ProblemModel, ContestModel, PRIV, PERM } = require('hydrooj');
exports.apply = async function(ctx) {
  await require(${JSON.stringify(path.join(root, 'handler/contest-editor.ts'))}).apply(ctx);
  if (!await DomainModel.get('system')) await DomainModel.add('system', 2, 'Isolated contest editor QA', 'Synthetic fixture only');
  const ids = { admin: 2, owner: 3, creator: 4, editor: 5, maintainer: 6, student: 7 };
  await UserModel.create('nobody@fixture.invalid', 'nobody', ${JSON.stringify(password)}, 0, '127.0.0.1', PRIV.PRIV_DEFAULT);
  const base = PERM.PERM_DEFAULT & ~PERM.PERM_CREATE_CONTEST & ~PERM.PERM_EDIT_CONTEST & ~PERM.PERM_EDIT_CONTEST_SELF;
  const roles = { owner: base | PERM.PERM_CREATE_CONTEST | PERM.PERM_EDIT_CONTEST_SELF,
    creator: base | PERM.PERM_CREATE_CONTEST, editor: base | PERM.PERM_EDIT_CONTEST,
    maintainer: base | PERM.PERM_CREATE_CONTEST | PERM.PERM_EDIT_CONTEST_SELF, student: base };
  for (const [role, uid] of Object.entries(ids)) {
    await UserModel.create('qa_' + role + '@fixture.invalid', 'qa_' + role, ${JSON.stringify(password)}, uid, '127.0.0.1', role === 'admin' ? PRIV.PRIV_ALL : PRIV.PRIV_DEFAULT);
    await UserModel.setById(uid, { timeZone: 'Asia/Shanghai' });
    if (roles[role] !== undefined) {
      await DomainModel.addRole('system', 'qa_' + role, roles[role]);
      await DomainModel.setUserRole('system', uid, 'qa_' + role, true);
    }
  }
  await UserModel.updateGroup('system', 'QA assigned class', [3,6]);
  const pid = await ProblemModel.add('system', 'QA1', 'QA first problem', 'Synthetic fixture only', 3);
  const pid2 = await ProblemModel.add('system', 'QA2', 'QA second problem', 'Synthetic fixture only', 3);
  const start = new Date('2035-06-01T01:00:00Z'), end = new Date('2035-06-01T04:00:00Z');
  const tid = await ContestModel.add('system', 'QA source contest', 'QA source description', 3, 'acm', start, end, [pid2,pid], true);
  await ContestModel.edit('system', tid, { assign: ['QA assigned class'], _code: ${JSON.stringify(inviteCode)}, maintainer: [6],
    autoHide: false, allowViewCode: false, allowPrint: true, keepScoreboardHidden: false, langs: ['cc'],
    lockAt: new Date('2035-06-01T03:30:00Z'), score: { [pid]: 80, [pid2]: 120 }, balloon: { [pid]: 'red', [pid2]: { color: 'blue', name: 'QA Blue' } },
    unlocked: true, files: [{ _id: 'public.txt', name: 'public.txt', size: 1 }], privateFiles: [{ _id: 'private.txt', name: 'private.txt', size: 1 }] });
  await ContestModel.attend('system', tid, 7);
  await db.collection('record').insertOne({ _id: new (require('hydrooj').ObjectId)(), domainId: 'system', contest: tid, uid: 7, pid, code: 'Synthetic fixture, not judged' });
  const homeworkTid = await ContestModel.add('system', 'QA unaffected homework', 'QA homework description', 2, 'homework', start, end, [pid], false,
    { penaltySince: end, penaltyRules: {} });
  await DomainModel.add('qa_contest_other', 2, 'Other isolated domain', 'Synthetic fixture only');
  const foreignTid = await ContestModel.add('qa_contest_other', 'QA foreign contest', 'No cross-domain copy', 3, 'ioi', start, end, [], false);
  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ tid: String(tid), homeworkTid: String(homeworkTid), foreignTid: String(foreignTid) }));
};
`);
  const env = { ...process.env, NODE_PATH: globalModules, PATH: `/root/.nix-profile/bin:${process.env.PATH}`,
    HYDRO_PROFILE: run, DEFAULT_STORE_PATH: path.join(fixture, 'store'), TMPDIR: path.join(fixture, 'tmp'), NODE_APP_INSTANCE: 'qa-fixture' };
  delete env.CI; delete env.DEV;
  mongoProcess = spawn(mongod, ['--dbpath', path.join(fixture, 'db'), '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--quiet'], {
    env, stdio: ['ignore', fs.openSync(path.join(fixture, 'mongo.log'), 'a'), fs.openSync(path.join(fixture, 'mongo.log'), 'a')],
  });
  client = new MongoClient(`mongodb://127.0.0.1:${mongoPort}`, { serverSelectionTimeoutMS: 500 });
  await waitFor(async () => { await client.connect(); return true; }, 'isolated Mongo');
  const db = client.db(run.replaceAll('-', '_'));
  await db.collection('system').insertMany([
    { _id: 'server.host', value: '127.0.0.1' }, { _id: 'server.port', value: 8899 },
    { _id: 'server.url', value: base }, { _id: 'server.login', value: true },
    { _id: 'session.keys', value: ['SyntheticContestEditorKey2026'] },
  ]);
  await db.collection('document').createIndex({ domainId: 1, docType: 1, docId: 1 }, { name: 'basic', unique: true });
  await db.collection('document.status').createIndex({ domainId: 1, docType: 1, docId: 1, uid: 1 }, { name: 'basic', unique: true });
  hydroProcess = spawn(node, [path.join(globalModules, 'hydrooj/bin/hydrooj.js'), '--host', '127.0.0.1', '--port', '8899'], {
    cwd: fixture, env, stdio: ['pipe', fs.openSync(path.join(fixture, 'hydro.log'), 'a'), fs.openSync(path.join(fixture, 'hydro.log'), 'a')],
  });
  console.log(`Isolated contest-editor fixture: ${fixture}`);
  await waitFor(() => fs.existsSync(ready), 'fixture seed');
  await waitFor(async () => (await fetch(`${base}/login`)).status < 500, 'fixture HTTP');
  await verify(db, JSON.parse(fs.readFileSync(ready, 'utf8')));
  report.ok = true;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  }
}
main().catch((error) => { report.error = error.stack; console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await stop(hydroProcess); await client?.close(); await stop(mongoProcess);
  if (process.platform === 'linux' && report.isolated.existingServicesBefore) {
    report.isolated.existingServicesAfter = originalSockets();
    report.isolated.existingServicesUnchanged = same(report.isolated.existingServicesBefore, report.isolated.existingServicesAfter);
    report.isolated.fixturePortsReleased = !sockets().some((line) => /:(8899|27019)\s/.test(line));
    if (!report.isolated.existingServicesUnchanged || !report.isolated.fixturePortsReleased) {
      report.ok = false; process.exitCode = 1;
    }
  }
  if (fixture && fs.existsSync(path.join(fixture, 'hydro.log'))) {
    report.isolated.runtimeLogContainsFixturePassword = fs.readFileSync(path.join(fixture, 'hydro.log'), 'utf8').includes(password);
    if (report.isolated.runtimeLogContainsFixturePassword) { report.ok = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  const safe = JSON.stringify(report, null, 2).replaceAll(password, '[REDACTED]').replaceAll(inviteCode, '[REDACTED]');
  if (fixture) write(path.join(fixture, 'report.json'), safe);
  const reports = path.join(__dirname, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const target = path.join(reports, `${run}.json`);
  write(target, safe);
  console.log(`Report: ${target}; only fixture processes stopped, fixture data retained.`);
});
