/* Run under Linux/WSL with the installed Hydro runtime, never a live database.
 * Example: node tests/live/hydro-smoke.cjs
 * Requires NODE_PATH to resolve the installed Hydro runtime's mongodb package.
 * Ports 27019 and 8899 must be unused. All users/passwords/data are synthetic.
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
const port = 27019;
const password = 'FixtureOnly!2026-NoRealAccount';
const secrets = [password];
const run = `oi33-qa-${Date.now()}-${process.pid}`;
const report = { run, tests: [], isolated: { mongoPort: port, httpPort: 8899 }, ok: false };
let fixture;
let profile;
let hydroProcess;
let mongoProcess;
let client;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (name, value) => fs.writeFileSync(name, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function check(name, condition, detail = '') {
  report.tests.push({ name, passed: !!condition, detail });
  assert.ok(condition, `${name}: ${detail}`);
  console.log(`PASS ${name}`);
}
function listeningSockets() {
  return execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }).split('\n')
    .filter((line) => /:(8888|27017|8899|27019)\s/.test(line))
    .map((line) => line.trim().replace(/\s+/g, ' ')).sort();
}
const existingSockets = () => listeningSockets().filter((line) => /:(8888|27017)\s/.test(line));
report.isolated.existingServicesBefore = existingSockets();
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Refusing to touch occupied fixture port ${port}`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function waitFor(predicate, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch {}
    await delay(250);
  }
  throw new Error(`Timeout: ${label}`);
}
function session() {
  const cookies = new Map();
  return async function request(route, form, options = {}) {
    const response = await fetch(`${base}${route}`, {
      method: form ? 'POST' : 'GET', redirect: 'manual',
      headers: { Accept: options.html ? 'text/html' : 'application/json', Referer: options.referer || `${base}${route}`, Origin: base,
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: response.status, body, location: response.headers.get('location'), cache: response.headers.get('cache-control') };
  };
}
async function login(request, uname, pwd = password) {
  await request('/login');
  const result = await request('/login', { uname, password: pwd, rememberme: 'false' });
  check(`login ${uname}`, result.status < 400, JSON.stringify(result.body));
}
async function checkHomepage(request, label, expectHomework = false) {
  const result = await request('/', null, { html: true });
  const html = result.body.raw || '';
  check(`real repository homepage HTML renders ${label}`, result.status === 200,
    `status ${result.status}; ${result.status === 200 ? '' : html.slice(-5000)}`);
  check(`repository main and navbar overrides are used ${label}`,
    html.includes('oi33-home__hero') && html.includes('oi33-nav__main'));
  check(`homework section appears exactly once ${label}`,
    (html.match(/id="oi33-homework-title"/g) || []).length === 1);
  check(`homework ${expectHomework ? 'content' : 'empty state'} renders ${label}`,
    html.includes(expectHomework ? 'QA homework' : '暂无可查看的作业'));
}
function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1];
}
function inputTag(html, name) {
  return (html.match(/<input\b[^>]*>/gi) || []).find((tag) => attribute(tag, 'name') === name) || '';
}
function dateText(value) {
  return String(value).split('-').map((part) => part.padStart(2, '0')).join('-');
}
function dateInZone(timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
async function homeworkDefaults(request, label, timeZone) {
  const before = dateInZone(timeZone);
  const result = await request('/homework/create', null, { html: true });
  const after = dateInZone(timeZone);
  const html = result.body.raw || '';
  check(`real create homework HTML renders for ${label}`, result.status === 200 && html.includes('<html'), `status ${result.status}`);
  const fields = Object.fromEntries(['beginAtDate', 'beginAtTime', 'penaltySinceDate', 'penaltySinceTime']
    .map((name) => [name, attribute(inputTag(html, name), 'value')]));
  check(`homework defaults start today at midnight in ${timeZone}`,
    [before, after].includes(dateText(fields.beginAtDate)) && /^0?0:00$/.test(fields.beginAtTime), JSON.stringify(fields));
  check(`homework default deadline is 2100-01-01 midnight for ${label}`,
    dateText(fields.penaltySinceDate) === '2100-01-01' && /^0?0:00$/.test(fields.penaltySinceTime), JSON.stringify(fields));
  const controls = html.match(/<(?:input|select|textarea)\b[^>]*>/gi) || [];
  check(`homework editor hides extension penalty and language controls for ${label}`,
    !controls.some((tag) => ['extensionDays', 'penaltyRules', 'langs'].includes(attribute(tag, 'name'))
      && attribute(tag, 'type') !== 'hidden'));
  check(`homework editor permits an empty problem list for ${label}`,
    !!inputTag(html, 'pids') && !/\srequired(?:\s|=|>)/i.test(inputTag(html, 'pids')));
  return fields;
}
async function checkEmptyHomeworkLifecycle(db, coach, student, defaults, pid) {
  const query = (tid) => ({ domainId: 'system', docType: 30, docId: new ObjectId(tid) });
  const load = (tid) => db.collection('document').findOne(query(tid));
  const rosterFor = (tid) => db.collection('oi33_education_roster').findOne({ domainId: 'system', tid: new ObjectId(tid) });
  const assertEmpty = (label, doc) => check(label,
    doc?.content === '' && Array.isArray(doc.pids) && doc.pids.length === 0);
  const assertNormalized = (label, doc) => check(label,
    !!doc && +doc.endAt === +doc.penaltySince && Object.keys(doc.penaltyRules || {}).length === 0
      && !doc.langs?.length);
  // Use the actual form defaults, not hand-written fallback dates. These are
  // deliberate stale/forged advanced values which the simplified form ignores.
  const form = { operation: 'update', ...defaults, rated: 'false', classNames: '基础班,提高班',
    extensionDays: '9', penaltyRules: '1: 0.25', langs: 'fixture-language-that-does-not-exist' };
  const ids = [];
  for (const [label, optional] of [['empty strings', { content: '', pids: '' }], ['omitted fields', {}]]) {
    const title = `QA empty homework ${label}`;
    const result = await coach('/homework/create', { ...form, title, ...optional });
    check(`coach creates homework with ${label} over real core route`, result.status < 400 && !!result.body.tid, JSON.stringify(result.body));
    const tid = String(result.body.tid);
    ids.push(tid);
    const doc = await load(tid);
    assertEmpty(`homework with ${label} persists exact empty content and problem array`, doc);
    assertNormalized(`homework with ${label} persists no extension penalty or language restriction`, doc);
    check(`homework with ${label} deadline respects coach timezone`,
      doc.penaltySince.toISOString() === '2100-01-01T10:00:00.000Z', doc.penaltySince.toISOString());
    const roster = await rosterFor(tid);
    check(`empty homework with ${label} still snapshots all assigned students`,
      roster?.entries.length === 3 && [4, 5, 6].every((uid) => roster.entries.some((entry) => entry.uid === uid)));
    const progress = await coach(`/oi33/education/homework/${tid}`);
    check(`empty homework with ${label} keeps all assigned students visible as not started`,
      progress.status === 200 && progress.body.summary?.total === 3 && progress.body.summary?.notStarted === 3
        && progress.body.summary?.complete === 0, JSON.stringify(progress.body.summary));
    for (const [actor, role] of [[coach, 'coach'], [student, 'student']]) {
      const detail = await actor(`/homework/${tid}`, null, { html: true });
      const html = detail.body.raw || '';
      check(`empty homework detail renders without introduction for ${role} (${label})`,
        detail.status === 200 && !html.includes('data-homework-introduction'), `status ${detail.status}`);
      check(`empty homework has friendly problem state for ${role} (${label})`,
        html.includes('oi33-homework-empty') && html.includes('题目待补充'));
      check(`homework sidebar has no extension row for ${role} (${label})`,
        !/<dt>\s*(?:Can be Extended For|允许延期|可以延期)[^<]*<\/dt>/i.test(html));
    }
  }
  const tid = ids[0];
  const snapshot = JSON.stringify(await rosterFor(tid));
  const edit = await coach(`/homework/${tid}/edit`, null, { html: true });
  check('existing homework editor preserves dates instead of applying new-create defaults', edit.status === 200
    && dateText(attribute(inputTag(edit.body.raw || '', 'beginAtDate'), 'value')) === dateText(defaults.beginAtDate)
    && dateText(attribute(inputTag(edit.body.raw || '', 'penaltySinceDate'), 'value')) === dateText(defaults.penaltySinceDate));
  let result = await coach(`/homework/${tid}/edit`, { ...form, title: 'QA empty homework now populated', content: 'QA added introduction', pids: String(pid) });
  check('coach can add a problem and introduction to an empty homework', result.status < 400, JSON.stringify(result.body));
  let doc = await load(tid);
  check('editing empty homework persists its added problem and introduction',
    doc.content === 'QA added introduction' && doc.pids.length === 1 && doc.pids[0] === pid);
  assertNormalized('editing populated homework still ignores extension penalty and language restriction', doc);
  check('adding a problem does not overwrite the published roster', JSON.stringify(await rosterFor(tid)) === snapshot);
  const detail = await coach(`/homework/${tid}`, null, { html: true });
  check('populated homework detail shows the added introduction and problem', detail.status === 200
    && (detail.body.raw || '').includes('QA added introduction') && (detail.body.raw || '').includes('QA problem'));
  for (const [label, optional] of [['empty strings', { content: '', pids: '' }], ['omitted fields', {}]]) {
    result = await coach(`/homework/${tid}/edit`, { ...form, title: `QA cleared homework ${label}`, ...optional });
    check(`coach can save an existing homework with ${label}`, result.status < 400, JSON.stringify(result.body));
    doc = await load(tid);
    assertEmpty(`editing with ${label} persists exact empty values`, doc);
    check(`editing with ${label} does not overwrite the published roster`, JSON.stringify(await rosterFor(tid)) === snapshot);
  }
  const savedDoc = JSON.stringify(await load(tid));
  const beforeCount = await db.collection('document').countDocuments({ domainId: 'system', docType: 30, rule: 'homework' });
  for (const [label, data] of [['missing title', { title: '' }], ['missing classes', { title: 'QA invalid no class', classNames: '' }]]) {
    result = await coach('/homework/create', { ...form, ...data });
    check(`empty homework still rejects ${label}`, result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  }
  check('invalid empty-homework creates leave no partial homework documents',
    await db.collection('document').countDocuments({ domainId: 'system', docType: 30, rule: 'homework' }) === beforeCount);
  for (const route of ['/homework/create', `/homework/${tid}/edit`]) {
    result = await student(route, null, { html: true });
    check(`student cannot open simplified editor ${route}`, result.status >= 400 && result.status < 500);
    result = await student(route, { ...form, title: 'QA forbidden empty update', content: '', pids: '' });
    check(`empty-field adapter preserves student write denial ${route}`, result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  }
  check('denied student updates do not change homework or roster',
    JSON.stringify(await load(tid)) === savedDoc && JSON.stringify(await rosterFor(tid)) === snapshot
      && await db.collection('document').countDocuments({ domainId: 'system', docType: 30, rule: 'homework' }) === beforeCount);
  for (const [actor, role] of [[coach, 'coach'], [student, 'student']]) {
    const result = await actor('/homework', null, { html: true });
    const html = result.body.raw || '';
    check(`real homework list uses the card-list template for ${role}`, result.status === 200
      && /<ol\b[^>]*class="[^"]*\boi33-homework-list\b/.test(html), `status ${result.status}`);
    const cards = [...html.matchAll(/<a\b(?=[^>]*class="[^"]*\boi33-homework-card\b)[^>]*>[\s\S]*?<\/a>/g)]
      .map(([card]) => card);
    check(`real homework list has one whole-card link for each empty homework for ${role}`,
      ids.every((id) => cards.filter((card) => attribute(card, 'href') === `/homework/${id}`).length === 1));
    check(`homework cards contain titles and metadata without nested interactive links for ${role}`,
      cards.length >= 3 && cards.every((card) => /<h2\b/.test(card) && card.includes('oi33-homework-card__meta')
        && (card.match(/<a\b/g) || []).length === 1 && !/<button\b/.test(card)));
  }
  return ids;
}
async function probeMessageSubscription(credential) {
  secrets.push(credential);
  return new Promise((resolve) => {
    // No Cookie or Authorization header: identity is supplied only in the
    // subscription payload, matching Hydro's browser gateway credential path.
    const socket = new WebSocket('ws://127.0.0.1:8899/websocket');
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'fixture subscription check complete');
      resolve(result);
    };
    const timer = setTimeout(() => done({ timedOut: true }), 6000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ operation: 'subscribe',
      channels: ['message'], credential, request_id: 'fixture-check', subscription_id: 'fixture-check' })));
    socket.addEventListener('message', ({ data }) => {
      if (data === 'ping') { socket.send('pong'); return; }
      try {
        const payload = JSON.parse(String(data));
        if (payload.operation === 'verify' || payload.error) done(payload);
      } catch {}
    });
    socket.addEventListener('close', ({ code }) => done({ closeCode: code }));
    socket.addEventListener('error', () => done({ connectionError: true }));
  });
}
function subscriptionDenied(result) {
  return !result.accept?.length && (!!result.error || result.closeCode >= 4000 || result.reject?.includes('message'));
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run this isolated runtime test under Linux/WSL.');
  await ensureFree(port);
  await ensureFree(8899);
  // Starting a WSL command can also start its existing boot services. Let that
  // settle before taking the baseline; no fixture processes exist yet.
  await delay(4000);
  report.isolated.existingServicesBefore = existingSockets();
  fixture = fs.mkdtempSync('/tmp/oi33-hydro-qa-');
  profile = path.join(os.homedir(), '.hydro', 'profiles', run);
  assert.ok(profile.endsWith(`/profiles/${run}`) && run.startsWith('oi33-qa-'));
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(profile, { recursive: false });
  for (const directory of ['db', 'store', 'tmp', 'addon', 'addon/templates']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  report.isolated.fixture = fixture;
  report.isolated.profile = profile;
  write(path.join(profile, 'config.json'), { host: '127.0.0.1', port: String(port), name: run.replaceAll('-', '_') });
  write(path.join(profile, 'addon.json'), [path.join(globalModules, '@hydrooj/ui-default'), path.join(fixture, 'addon')]);
  write(path.join(fixture, 'addon/package.json'), { name: 'oi33-qa-fixture', version: '1.0.0', main: 'index.js' });
  // Test the real repository template overlay, including main, layouts, shared
  // components and homepage partials, not just standalone teaching forms.
  fs.cpSync(path.join(root, 'templates'), path.join(fixture, 'addon/templates'), { recursive: true });
  const ready = path.join(fixture, 'ready.json');
  const seed = `
const fs = require('fs');
const { db, UserModel, DomainModel, ProblemModel, ContestModel, PRIV, PERM, SystemModel } = require('hydrooj');
exports.apply = async function(ctx) {
  const base = ${JSON.stringify(root)};
  for (const name of ['enrollment', 'education', 'account-batch', 'homepage']) await require(base + '/handler/' + name + '.ts').apply(ctx);
  if (!await DomainModel.get('system')) await DomainModel.add('system', 2, 'Isolated QA', 'Synthetic fixture only');
  const users = {};
  for (const [name, uid, priv] of [['nobody',0,PRIV.PRIV_DEFAULT],['qa_admin',2,PRIV.PRIV_ALL],['qa_coach',3,PRIV.PRIV_DEFAULT],['qa_student',4,PRIV.PRIV_DEFAULT],['qa_outsider',5,PRIV.PRIV_DEFAULT],['qa_new',6,PRIV.PRIV_DEFAULT]]) {
    users[name] = await UserModel.create(name + '@fixture.invalid', name, ${JSON.stringify(password)}, uid, '127.0.0.1', priv);
  }
  await DomainModel.addRole('system', 'coach', PERM.PERM_DEFAULT | PERM.PERM_CREATE_HOMEWORK | PERM.PERM_EDIT_HOMEWORK_SELF);
  await DomainModel.setUserRole('system', 3, 'coach', true);
  await UserModel.setById(2, { timeZone: 'Pacific/Kiritimati' });
  await UserModel.setById(3, { timeZone: 'Pacific/Honolulu' });
  for (const uid of [2,3,4,5]) await db.collection('oi33_user').insertOne({ _id: uid, realname_flag: uid === 2 ? 3 : 1, realname_name: 'QA ' + uid });
  await UserModel.updateGroup('system', '基础班', [4]);
  await UserModel.updateGroup('system', '提高班', [4]);
  await SystemModel.set('hydrooj.homepage', ${JSON.stringify('- width: 9\n  contest: 5\n  training: 10\n- width: 3\n  ranking: 10\n')});
  const pid = await ProblemModel.add('system', 'QA1', 'QA problem', 'Synthetic fixture only', 2);
  const now = Date.now();
  const tid = await ContestModel.add('system', 'QA Allowed Contest', 'Synthetic fixture', 2, 'acm', new Date(now - 60000), new Date(now + 3600000), [pid], false);
  const otherTid = await ContestModel.add('system', 'QA Other Contest', 'Synthetic fixture', 2, 'acm', new Date(now - 60000), new Date(now + 3600000), [pid], false);
  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({users,pid,tid:String(tid),otherTid:String(otherTid)}));
};
`;
  write(path.join(fixture, 'addon/index.js'), seed);
  const env = { ...process.env, NODE_PATH: globalModules, PATH: `/root/.nix-profile/bin:${process.env.PATH}`,
    HYDRO_PROFILE: run, DEFAULT_STORE_PATH: path.join(fixture, 'store'), TMPDIR: path.join(fixture, 'tmp'), NODE_APP_INSTANCE: 'qa-fixture' };
  delete env.CI;
  delete env.DEV;
  mongoProcess = spawn(mongod, ['--dbpath', path.join(fixture, 'db'), '--bind_ip', '127.0.0.1', '--port', String(port), '--quiet'], {
    env, stdio: ['ignore', fs.openSync(path.join(fixture, 'mongo.log'), 'a'), fs.openSync(path.join(fixture, 'mongo.log'), 'a')],
  });
  client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 500 });
  await waitFor(async () => { await client.connect(); return true; }, 'isolated Mongo');
  const db = client.db(run.replaceAll('-', '_'));
  await db.collection('system').insertMany([
    { _id: 'server.host', value: '127.0.0.1' }, { _id: 'server.port', value: 8899 },
    { _id: 'server.url', value: base }, { _id: 'server.login', value: true },
    { _id: 'session.keys', value: ['SyntheticFixtureKey2026'] },
  ]);
  hydroProcess = spawn(node, [path.join(globalModules, 'hydrooj/bin/hydrooj.js'), '--host', '127.0.0.1', '--port', '8899'], {
    cwd: fixture, env, stdio: ['pipe', fs.openSync(path.join(fixture, 'hydro.log'), 'a'), fs.openSync(path.join(fixture, 'hydro.log'), 'a')],
  });
  console.log(`Isolated runtime starting: ${fixture}`);
  await waitFor(() => fs.existsSync(ready), 'fixture addon seed', 55000);
  await waitFor(async () => (await fetch(`${base}/login`)).status < 500, 'Hydro HTTP', 30000);
  const fixtureData = JSON.parse(fs.readFileSync(ready, 'utf8'));
  await checkHomepage(session(), 'anonymous empty');
  const admin = session(); const coach = session(); const student = session(); const outsider = session(); const applicant = session();
  await login(admin, 'qa_admin'); await login(coach, 'qa_coach'); await login(student, 'qa_student');
  await login(outsider, 'qa_outsider'); await login(applicant, 'qa_new');
  await checkHomepage(student, 'verified empty');
  for (const [actor, route] of [[applicant, '/oi33/enrollment'], [admin, '/oi33/enrollment/review'],
    [admin, '/oi33/accounts/batch'], [admin, '/oi33/education/access'], [coach, '/oi33/education/classes']]) {
    const html = await actor(route, null, { html: true });
    check(`real HTML template renders ${route}`, html.status === 200 && /<html/.test(html.body.raw || ''), `status ${html.status}`);
    check(`private template no-store ${route}`, /no-store/.test(html.cache));
  }
  const beforeCsrf = await db.collection('oi33_account_batch').countDocuments();
  const crossSite = await admin('/oi33/accounts/batch', { users: 'qa_forged,QA Forged', accountType: 'regular' }, { referer: 'https://untrusted.example.test/' });
  check('real Hydro rejects cross-origin Referer before batch creation', crossSite.status >= 400 && crossSite.status < 500);
  check('rejected cross-origin request created no preview', await db.collection('oi33_account_batch').countDocuments() === beforeCsrf);
  let result = await applicant('/homework/create');
  check('unverified account cannot create homework', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  result = await applicant('/oi33/enrollment', { realName: 'QA New Student', school: 'QA School', studentId: 'QA06', requestedGroups: '基础班', revision: '0' });
  check('new applicant submits real enrollment over HTTP', result.status < 400, JSON.stringify(result.body));
  let doc = await db.collection('oi33_enrollment').findOne({ _id: 6 });
  check('enrollment persisted pending', doc?.status === 'pending' && doc.revision === 1);
  result = await admin('/oi33/enrollment/review', { uid: '6', revision: '1', action: 'approve' });
  check('administrator approves real application over HTTP', result.status < 400, JSON.stringify(result.body));
  doc = await db.collection('oi33_enrollment').findOne({ _id: 6 });
  check('enrollment persisted approved', doc?.status === 'approved' && doc.revision === 2);
  result = await coach('/oi33/education/classes', { operation: 'update', name: '基础班', uids: '4,6' });
  check('coach updates class membership over HTTP', result.status < 400, JSON.stringify(result.body));
  await homeworkDefaults(admin, 'administrator', 'Pacific/Kiritimati');
  const defaults = await homeworkDefaults(coach, 'coach', 'Pacific/Honolulu');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const homework = { operation: 'update', title: 'QA homework', content: 'Fixture homework', pids: String(fixtureData.pid),
    beginAtDate: yesterday, beginAtTime: '00:00', penaltySinceDate: tomorrow, penaltySinceTime: '23:59',
    extensionDays: '0', penaltyRules: '{}', rated: 'false', classNames: '基础班,提高班' };
  result = await student('/homework/create', homework);
  check('verified student cannot create homework', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  result = await coach('/homework/create', homework);
  check('coach creates homework over real core route', result.status < 400, JSON.stringify(result.body));
  const roster = await db.collection('oi33_education_roster').findOne({});
  check('homework snapshot includes class union once', roster?.entries.length === 2 && roster.entries.some((entry) => entry.uid === 4) && roster.entries.some((entry) => entry.uid === 6), JSON.stringify(roster));
  const homeworkId = String(roster.tid);
  const originalEditor = await coach(`/homework/${homeworkId}/edit`, null, { html: true });
  check('edit GET preserves existing custom start and deadline instead of resetting them', originalEditor.status === 200
    && dateText(attribute(inputTag(originalEditor.body.raw || '', 'beginAtDate'), 'value')) === yesterday
    && dateText(attribute(inputTag(originalEditor.body.raw || '', 'penaltySinceDate'), 'value')) === tomorrow
    && attribute(inputTag(originalEditor.body.raw || '', 'penaltySinceTime'), 'value') === '23:59');
  await checkHomepage(student, 'matching student with homework', true);
  await checkHomepage(outsider, 'outside-class empty');
  result = await outsider(`/homework/${homeworkId}`);
  check('student outside all classes denied homework detail', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  result = await student(`/homework/${homeworkId}`);
  check('matching class can view homework', result.status < 400, JSON.stringify(result.body));
  for (const [actor, role] of [[student, 'student'], [coach, 'coach']]) {
    const detail = await actor(`/homework/${homeworkId}`, null, { html: true });
    check(`real homework detail and sidebar HTML renders for ${role}`,
      detail.status === 200 && (detail.body.raw || '').includes('QA homework')
        && (detail.body.raw || '').includes('<html'),
      `status ${detail.status}; ${detail.status === 200 ? '' : (detail.body.raw || '').slice(-5000)}`);
  }
  result = await coach(`/oi33/education/homework/${homeworkId}`);
  check('coach progress includes never-started students', result.status < 400 && result.body.summary?.total === 2 && result.body.summary?.notStarted === 2, JSON.stringify(result.body));
  await coach('/oi33/education/classes', { operation: 'update', name: '基础班', uids: '4,5,6' });
  const unchanged = await db.collection('oi33_education_roster').findOne({ _id: roster._id });
  check('class change does not silently rewrite historical snapshot', unchanged.entries.length === 2);
  await checkEmptyHomeworkLifecycle(db, coach, student, defaults, fixtureData.pid);
  const multiple = new URLSearchParams({ users: 'qa_regular,QA Regular,R01', accountType: 'regular' });
  multiple.append('groups', '基础班'); multiple.append('groups', '提高班');
  result = await admin('/oi33/accounts/batch', multiple);
  check('native multi-select group fields accepted by Hydro decorators', result.status < 400, JSON.stringify(result.body));
  const regularBatch = await db.collection('oi33_account_batch').findOne({ 'rows.username': 'qa_regular' });
  check('native multi-select preview preserves both groups', regularBatch?.groups.length === 2);
  result = await admin('/oi33/accounts/batch', { users: 'qa_temporary,QA Temp,T01', accountType: 'temporary', groups: '', contestIds: fixtureData.tid,
    validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString() });
  check('temporary batch preview over HTTP', result.status < 400, JSON.stringify(result.body));
  const batch = await db.collection('oi33_account_batch').findOne({ owner: 2, accountType: 'temporary' });
  check('preview has no account yet', !await db.collection('user').findOne({ uname: 'qa_temporary' }));
  result = await admin(`/oi33/accounts/batch/${batch._id}`, { confirmed: 'true' });
  check('temporary batch confirmed over HTTP', result.status < 400 && result.body.credentials?.length === 1, JSON.stringify(result.body.batch));
  const credential = result.body.credentials[0];
  secrets.push(credential.password);
  const temp = session();
  await login(temp, 'qa_temporary', credential.password);
  const normalToken = await db.collection('token').findOne({ uid: 4, tokenType: 0 });
  const tempToken = await db.collection('token').findOne({ uid: credential.uid, tokenType: 0 });
  check('fixture login sessions exist for WebSocket credential tests', !!normalToken && !!tempToken);
  let subscription = await probeMessageSubscription(normalToken._id);
  check('anonymous WebSocket accepts verified regular user credential subscription', subscription.accept?.includes('message:4'), JSON.stringify(subscription));
  subscription = await probeMessageSubscription(tempToken._id);
  check('anonymous WebSocket rejects temporary credential message subscription', subscriptionDenied(subscription), JSON.stringify(subscription));
  result = await temp(`/contest/${fixtureData.tid}`);
  check('temporary account can open assigned contest', result.status < 400, JSON.stringify(result.body));
  result = await temp(`/contest/${fixtureData.otherTid}`);
  check('temporary account cannot open another contest', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  result = await temp('/p');
  check('temporary account cannot browse unrestricted problem bank', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  await db.collection('oi33_enrollment').updateOne({ _id: credential.uid }, { $set: { validUntil: new Date(Date.now() - 1000) } });
  result = await temp(`/contest/${fixtureData.tid}`);
  check('expiry enforced on existing logged-in session', result.status >= 400 && result.status < 500, JSON.stringify(result.body));
  check('expired account and history retained', !!await db.collection('user').findOne({ _id: credential.uid }));
  await db.collection('oi33_enrollment').updateOne({ _id: 6 }, { $set: { enabled: false } });
  const disabledToken = await db.collection('token').findOne({ uid: 6, tokenType: 0 });
  check('fixture disabled account still has an existing login session', !!disabledToken);
  subscription = await probeMessageSubscription(disabledToken._id);
  check('anonymous WebSocket rejects disabled credential message subscription', subscriptionDenied(subscription), JSON.stringify(subscription));
  report.ok = true;
}

main().catch((error) => { report.error = error.stack; console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await stop(hydroProcess);
  await client?.close();
  await stop(mongoProcess);
  report.isolated.existingServicesAfter = existingSockets();
  report.isolated.existingServicesUnchanged = JSON.stringify(report.isolated.existingServicesBefore)
    === JSON.stringify(report.isolated.existingServicesAfter);
  report.isolated.fixturePortsReleased = !listeningSockets().some((line) => /:(8899|27019)\s/.test(line));
  if (fixture && fs.existsSync(path.join(fixture, 'hydro.log'))) {
    const runtimeLog = fs.readFileSync(path.join(fixture, 'hydro.log'), 'utf8');
    report.isolated.runtimeLogContainsFixtureSecret = secrets.some((secret) => runtimeLog.includes(secret));
    report.isolated.runtimeLogContainsRawMessageEvent = runtimeLog.includes('MessageEvent');
  }
  if (!report.isolated.existingServicesUnchanged || !report.isolated.fixturePortsReleased
    || report.isolated.runtimeLogContainsFixtureSecret || report.isolated.runtimeLogContainsRawMessageEvent) {
    report.ok = false;
    process.exitCode = 1;
    console.error('Fixture cleanup, unchanged-service, or safe-log check failed; inspect the isolated report.');
  }
  report.finishedAt = new Date().toISOString();
  // Even a failed assertion must never retain a generated password in a report.
  let safe = JSON.stringify(report, null, 2);
  for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED FIXTURE SECRET]');
  if (fixture) write(path.join(fixture, 'report.json'), safe);
  const reports = path.join(__dirname, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  write(path.join(reports, `${run}.json`), safe);
  console.log(`Report: ${path.join(reports, `${run}.json`)}; fixture processes stopped. Fixture data retained only at ${fixture}.`);
});
