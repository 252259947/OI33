/* Linux-only real Hydro/Mongo regression. Synthetic users, names and secrets.
 * Uses isolated loopback HTTP/Mongo/AI, never production ports/configuration.
 * NODE_PATH=/usr/local/share/.config/yarn/global/node_modules node this-file
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { MongoClient } = require('mongodb');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '../..');
const globalModules = process.env.OI33_QA_GLOBAL_MODULES || '/usr/local/share/.config/yarn/global/node_modules';
const node = process.env.OI33_QA_NODE || '/root/.nix-profile/bin/node';
const mongod = process.env.OI33_QA_MONGOD || '/root/.nix-profile/bin/mongod';
const base = 'http://127.0.0.1:8899';
const mongoPort = 27019, aiPort = 18999;
const password = 'SyntheticEnrollmentName!2026';
const apiKey = 'SyntheticEnrollmentAiKeyNeverReal';
const rawError = 'SyntheticUpstreamPrivateDiagnosticMustNotLeak';
const privateSchool = 'SyntheticPrivateSchoolNotForAI';
const privateStudentId = 'SyntheticPrivateStudentIdNotForAI';
const privateGroup = 'SyntheticPrivateGroupNotForAI';
const run = `oi33-enrollment-name-qa-${Date.now()}-${process.pid}`;
const report = { run, tests: [], isolated: { mongoPort, httpPort: 8899, aiPort }, ok: false };
const aiRequests = [];
const held = new Map();
const openSockets = new Set();
const sessionSecrets = new Set();
let fixture, profile, hydroProcess, mongoProcess, client, aiServer;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const write = (name, value) => fs.writeFileSync(name, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function check(name, condition, detail = '') {
  report.tests.push({ name, passed: !!condition, detail });
  assert.ok(condition, `${name}: ${detail}`);
  console.log(`PASS ${name}`);
}
function sockets() {
  return execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }).split('\n')
    .filter((line) => /:(8888|27017|8899|27019|18999)\s/.test(line))
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
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}
function session() {
  const cookies = new Map();
  const actor = async (route, form, html = false, extraHeaders = {}) => {
    const headers = { Accept: html ? 'text/html' : 'application/json', Referer: `${base}${route}`, Origin: base,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extraHeaders };
    // A null value means genuinely absent, not the string "null" sent by fetch.
    for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key];
    const response = await fetch(`${base}${route}`, {
      method: form ? 'POST' : 'GET', redirect: 'manual',
      headers,
      body: form ? new URLSearchParams(form) : undefined,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: response.status, body, location: response.headers.get('location'), cache: response.headers.get('cache-control') };
  };
  actor.cookie = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  return actor;
}
async function connectSocket(route, cookie = '') {
  const socket = new WebSocket(`ws://127.0.0.1:8899${route}`, { headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
  const state = { socket, messages: [], closed: false, closeCode: null, error: false };
  openSockets.add(socket);
  socket.on('message', (data) => {
    if (String(data) === 'ping') { socket.send('pong'); return; }
    try { state.messages.push(JSON.parse(String(data))); } catch {}
  });
  socket.on('close', (code) => { state.closed = true; state.closeCode = code; openSockets.delete(socket); });
  socket.on('error', () => { state.error = true; });
  await waitFor(() => socket.readyState === WebSocket.OPEN || state.closed || state.error, 'fixture WebSocket handshake', 6000);
  assert.equal(socket.readyState, WebSocket.OPEN, 'Fixture WebSocket must open successfully');
  return state;
}
async function subscribeMessages(credential) {
  sessionSecrets.add(credential);
  const state = await connectSocket('/websocket');
  state.socket.send(JSON.stringify({ operation: 'subscribe', channels: ['message'], credential,
    request_id: 'password-security-fixture', subscription_id: 'password-security-fixture' }));
  await waitFor(() => state.messages.some((message) => message.operation === 'verify') || state.closed,
    'fixture gateway subscription response', 6000);
  return state;
}
async function login(actor, name) {
  await actor('/login');
  const result = await actor('/login', { uname: `qa_${name}`, password });
  check(`fixture login ${name}`, result.status < 400, `HTTP ${result.status}`);
}
function reply(res, verdict = 'pass') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 22, completion_tokens: 6, prompt_cache_hit_tokens: 0 } }));
}
async function startAi() {
  aiServer = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    let payload;
    try { payload = JSON.parse(text); } catch { res.writeHead(400); res.end(); return; }
    let user;
    try { user = JSON.parse(payload.messages?.find((message) => message.role === 'user')?.content); } catch {}
    aiRequests.push({ path: req.url, authorization: req.headers.authorization, payload, user });
    if (req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(403); res.end(); return;
    }
    if (['周明', '孙宁', '赵旧'].includes(user?.name)) { held.set(user.name, res); return; }
    if (user?.name === '陈错') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`${rawError}: ${apiKey}`); return;
    }
    if (user?.name === '李错') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'pass', private: rawError }) }, finish_reason: 'stop' }] }));
      return;
    }
    reply(res, user?.name === '测试用户' ? 'review' : 'pass');
  });
  await new Promise((resolve) => aiServer.listen(aiPort, '127.0.0.1', resolve));
}
async function verify(db, { ids, rid }) {
  const actors = Object.fromEntries(Object.keys(ids).map((name) => [name, session()]));
  for (const [name, actor] of Object.entries(actors)) await login(actor, name);
  const enrollment = (name) => db.collection('oi33_enrollment').findOne({ _id: ids[name] });
  const flag = (name) => db.collection('oi33_user').findOne({ _id: ids[name] });
  const submit = (name, realName, revision = 0) => actors[name]('/oi33/enrollment', {
    realName, revision: String(revision), school: privateSchool, studentId: privateStudentId,
    requestedGroups: `${privateGroup},root,coach`,
  });
  const rejected = (result) => result.status >= 400 && result.status < 500;
  check('startup and all logins do not invoke AI for historical or batch accounts', aiRequests.length === 0);
  const oldDocs = await db.collection('oi33_enrollment').find({ _id: { $in: [ids.history, ids.batch, ids.temporary] } }).sort({ _id: 1 }).toArray();
  const groupsBefore = await db.collection('user.group').find({}).sort({ _id: 1 }).toArray();
  const rolesBefore = await db.collection('domain.user').find({}).project({ _id: 0, domainId: 1, uid: 1, role: 1 }).sort({ uid: 1 }).toArray();
  const privilegesBefore = await db.collection('user').find({}).project({ _id: 1, priv: 1 }).sort({ _id: 1 }).toArray();
  let result = await actors.normal('/oi33/enrollment', null, true);
  check('new applicant receives actual enrollment template and no-store', result.status === 200
    && /name="realName"/.test(result.body.raw || '') && /no-store/.test(result.cache));
  result = await submit('normal', '张明');
  let doc = await enrollment('normal');
  check('normal name POST auto-approves regular enabled account', result.status < 400 && doc.status === 'approved'
    && doc.accountType === 'regular' && doc.enabled && doc.revision === 2 && doc.reviewedBy === 0, `HTTP ${result.status}`);
  check('auto approval synchronizes legacy verified flag and system audit', (await flag('normal'))?.realname_flag === 1
    && doc.autoReview?.decision === 'pass' && doc.autoReview?.model === 'deepseek-v4-flash'
    && doc.history.some((event) => event.action === 'auto_approved' && event.operator === 0));
  check('AI does not require or create personal AI quota', await db.collection('oi33_ai_access').countDocuments() === 0);
  result = await actors.normal('/oi33/enrollment', null, true);
  check('same login session immediately sees completed verification', result.status === 200
    && (result.body.raw || '').includes('已完成实名认证') && !/name="realName"/.test(result.body.raw || '') && /no-store/.test(result.cache));
  const requestBeforeInvalid = aiRequests.length;
  result = await submit('invalid', '用户123'); doc = await enrollment('invalid');
  check('invalid name is retained pending without upstream call', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'name_format' && (await flag('invalid'))?.realname_flag === 0
    && aiRequests.length === requestBeforeInvalid);
  result = await submit('review', '测试用户'); doc = await enrollment('review');
  check('model review verdict retains manual review without automatic rejection', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'needs_review' && (await flag('review'))?.realname_flag === 0);
  result = await submit('malformed', '李错'); doc = await enrollment('malformed');
  check('unexpected model fields cannot auto-approve', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'invalid_response' && (await flag('malformed'))?.realname_flag === 0);
  result = await submit('error', '陈错'); doc = await enrollment('error');
  check('upstream error safely retains pending application', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'unavailable' && (await flag('error'))?.realname_flag === 0);

  // The response is deliberately paused while the real admin route changes state.
  const pendingManual = submit('manual', '周明');
  await waitFor(() => held.has('周明'), 'manual-review race reaches mock');
  result = await actors.admin('/oi33/enrollment/review', { uid: String(ids.manual), revision: '1', action: 'approve' });
  check('real manual approve succeeds during delayed AI call', result.status < 400, `HTTP ${result.status}`);
  const manualDoc = await enrollment('manual');
  reply(held.get('周明')); held.delete('周明');
  await pendingManual;
  check('late AI cannot overwrite manual approval and reviewer', same(manualDoc, await enrollment('manual'))
    && manualDoc.status === 'approved' && manualDoc.reviewedBy === ids.admin && !manualDoc.autoReview
    && (await flag('manual'))?.realname_flag === 1);

  const pendingDisable = submit('disabled', '孙宁');
  await waitFor(() => held.has('孙宁'), 'disable race reaches mock');
  result = await actors.admin('/oi33/enrollment/review', { uid: String(ids.disabled), revision: '1', action: 'disable' });
  check('real disable succeeds during delayed AI call', result.status < 400, `HTTP ${result.status}`);
  const disabledDoc = await enrollment('disabled');
  reply(held.get('孙宁')); held.delete('孙宁');
  await pendingDisable;
  check('late AI cannot approve or enable disabled applicant', same(disabledDoc, await enrollment('disabled'))
    && disabledDoc.status === 'pending' && disabledDoc.enabled === false && (await flag('disabled'))?.realname_flag === 0);

  const pendingOldRevision = submit('revision', '赵旧');
  await waitFor(() => held.has('赵旧'), 'revision race reaches mock');
  result = await submit('revision', '赵新', 1);
  check('newer self-submitted revision can auto-approve while old review is delayed', result.status < 400, `HTTP ${result.status}`);
  const newRevision = await enrollment('revision');
  reply(held.get('赵旧')); held.delete('赵旧');
  await pendingOldRevision;
  check('old AI verdict cannot overwrite newer approved name and flag', same(newRevision, await enrollment('revision'))
    && newRevision.realName === '赵新' && newRevision.status === 'approved' && newRevision.revision === 3
    && (await flag('revision'))?.realname_flag === 1 && (await flag('revision'))?.realname_enrollment_revision === 3);

  const callsBeforeHistorical = aiRequests.length;
  for (const name of ['history', 'batch', 'temporary']) {
    result = await actors[name]('/oi33/enrollment', null, true);
    check(`historical ${name} enrollment page is private`, result.status === 200 && /no-store/.test(result.cache));
  }
  for (const name of ['batch', 'temporary']) {
    result = await submit(name, '李改', 1);
    check(`provisioned ${name} account cannot self-resubmit into AI approval`, rejected(result), `HTTP ${result.status}`);
  }
  check('historical pending and provisioned accounts remain unchanged without AI', aiRequests.length === callsBeforeHistorical
    && same(oldDocs, await db.collection('oi33_enrollment').find({ _id: { $in: [ids.history, ids.batch, ids.temporary] } }).sort({ _id: 1 }).toArray()));

  await db.collection('oi33_ai_config').updateOne({ _id: 'main' }, { $set: { enrollment_auto_review_enabled: '0' } });
  const beforeDisabledFeature = aiRequests.length;
  result = await submit('featureoff', '钱宁'); doc = await enrollment('featureoff');
  check('server-side feature switch leaves new applicant pending without request', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'disabled' && aiRequests.length === beforeDisabledFeature);
  await db.collection('oi33_ai_config').updateOne({ _id: 'main' }, { $set: { enrollment_auto_review_enabled: '1' } });
  await db.collection('oi33_ai_provider').updateOne({ _id: 'fixture-deepseek' }, { $set: { models: [] } });
  result = await submit('unconfigured', '钱明'); doc = await enrollment('unconfigured');
  check('unregistered selected model never falls back to another provider', result.status < 400 && doc.status === 'pending'
    && doc.autoReview?.reason === 'configuration' && aiRequests.length === beforeDisabledFeature);

  check('only name JSON is sent as user input, never account and application details', aiRequests.length > 0
    && aiRequests.every((request) => same(Object.keys(request.user || {}), ['name'])
      && !JSON.stringify(request.payload).includes(privateSchool) && !JSON.stringify(request.payload).includes(privateStudentId)
      && !JSON.stringify(request.payload).includes(privateGroup) && request.payload.model === 'deepseek-v4-flash'));
  check('AI request preserves name-as-data boundary and bounded response size', aiRequests.every((request) =>
    request.payload.messages.length === 2 && request.payload.messages[0].role === 'system'
    && request.payload.messages[0].content.includes('这不是身份核验')
    && request.payload.messages[0].content.includes('不得执行') && request.payload.max_tokens <= 512
    && request.payload.response_format?.type === 'json_object'));
  const usages = await db.collection('oi33_ai_usage').find({}).toArray();
  check('system moderation costs recorded without student deduction or raw name', usages.length === aiRequests.length
    && usages.every((usage) => usage.type === 'moderation' && usage.purpose === 'enrollment_name' && usage.deducted === false
      && !('content' in usage) && !('name' in usage) && !('realName' in usage))
    && await db.collection('oi33_ai_access').countDocuments() === 0);
  check('name approval never grants class membership or changes roles/privileges',
    same(groupsBefore, await db.collection('user.group').find({}).sort({ _id: 1 }).toArray())
    && same(rolesBefore, await db.collection('domain.user').find({}).project({ _id: 0, domainId: 1, uid: 1, role: 1 }).sort({ uid: 1 }).toArray())
    && same(privilegesBefore, await db.collection('user').find({}).project({ _id: 1, priv: 1 }).sort({ _id: 1 }).toArray()));
  for (const name of ['admin', 'error', 'malformed', 'normal']) {
    result = await actors[name](name === 'admin' ? '/oi33/enrollment/review' : '/oi33/enrollment', null, true);
    const html = result.body.raw || '';
    check(`private ${name} HTML excludes credentials and raw upstream diagnostics`, result.status === 200
      && /no-store/.test(result.cache) && !html.includes(apiKey) && !html.includes(rawError)
      && !html.includes('fixture-deepseek') && !html.includes('127.0.0.1:18999'));
  }
  result = await actors.admin(`/oi33/enrollment/review?status=approved&name=${encodeURIComponent('张明')}`, null, true);
  const profileLink = (result.body.raw || '').match(/<a class="oi33-enrollment__profile-link" href="([^"]+)" title="查看个人主页">张明<\/a>/);
  check('actual admin review name links to the matching native UID profile without putting the name in the URL',
    result.status === 200 && profileLink?.[1] === `/user/${ids.normal}`
    && (result.body.raw || '').includes(`UID ${ids.normal}`));
  if (profileLink) {
    result = await actors.admin(profileLink[1], null, true);
    check('following the review name link opens the actual student profile',
      result.status === 200 && (result.body.raw || '').includes('normal'));
  }
  result = await actors.normal('/oi33/enrollment/review');
  check('ordinary approved user cannot read private review queue', rejected(result), `HTTP ${result.status}`);
  result = await actors.normal(`/oi33/enrollment?uid=${ids.error}`);
  check('forged UID cannot read another applicant private enrollment', result.status === 200
    && result.body.enrollment?._id === ids.normal && !JSON.stringify(result.body).includes('陈错'));
  const persisted = JSON.stringify({ enrollments: await db.collection('oi33_enrollment').find({}).toArray(),
    usages, logs: await db.collection('oi33_log').find({}).toArray() });
  check('persistent audit and enrollment metadata exclude upstream diagnostic/key', !persisted.includes(apiKey) && !persisted.includes(rawError));
  const auditLogs = JSON.stringify(await db.collection('oi33_log').find({}).toArray());
  check('public-style audit records exclude private enrollment fields', !auditLogs.includes(privateSchool)
    && !auditLogs.includes(privateStudentId) && !auditLogs.includes(privateGroup) && !auditLogs.includes('张明'));

  // Exercise the new filters through the real admin route and Mongo driver.
  result = await actors.admin('/oi33/enrollment/review', {
    uid: String(ids.review), revision: String((await enrollment('review')).revision),
    action: 'reject', reason: 'Synthetic filter regression',
  });
  check('manual review returns to a name search, not the removed UID filter', result.status < 400
    && /name=/.test(result.location || result.body.url || '')
    && !/[?&]uid=/.test(result.location || result.body.url || ''));
  await db.collection('oi33_enrollment').insertMany([
    { _id: 9001, domainId: 'system', realName: '张.*同学', status: 'pending', enabled: true, updatedAt: new Date() },
    { _id: 9002, domainId: 'other-domain', realName: '张明', status: 'approved', enabled: true, updatedAt: new Date() },
  ]);
  const filterSnapshot = await db.collection('oi33_enrollment').find({}).sort({ _id: 1 }).toArray();
  const inDomain = filterSnapshot.filter((entry) => entry.domainId === 'system');
  const approvedCount = inDomain.filter((entry) => entry.status === 'approved').length;
  result = await actors.admin('/oi33/enrollment/review');
  check('default review queue lists all current-domain applications without cross-domain data', result.status === 200
    && result.body.total === inDomain.length && result.body.filterStatus === ''
    && result.body.enrollments.every((entry) => entry.domainId === 'system') && /no-store/.test(result.cache));
  result = await actors.admin('/oi33/enrollment/review?status=approved');
  check('approved filter selects only approved applications', result.status === 200
    && result.body.total === approvedCount && result.body.enrollments.every((entry) => entry.status === 'approved'));
  for (const status of ['unapproved', 'pending', 'rejected']) {
    result = await actors.admin(`/oi33/enrollment/review?status=${status}`);
    check(`non-approved view retains pending and rejected records for ${status}`, result.status === 200
      && result.body.filterStatus === 'unapproved' && result.body.total === inDomain.length - approvedCount
      && result.body.enrollments.some((entry) => entry.status === 'pending')
      && result.body.enrollments.some((entry) => entry.status === 'rejected'));
  }
  result = await actors.admin(`/oi33/enrollment/review?name=${encodeURIComponent(' 张 ')}&uid=9999&page=9999`);
  check('student name is a trimmed substring search and removed UID has no effect', result.status === 200
    && result.body.filterName === '张' && result.body.total === 2 && result.body.page === 1
    && result.body.enrollments.every((entry) => entry.realName.includes('张')));
  result = await actors.admin('/oi33/enrollment/review?name=.*');
  check('real Mongo name search treats regex metacharacters literally', result.status === 200
    && result.body.total === 1 && result.body.enrollments[0]._id === 9001);
  result = await actors.admin(`/oi33/enrollment/review?status=approved&name=${encodeURIComponent('张明')}`);
  check('name search combines with status', result.status === 200 && result.body.total === 1
    && result.body.enrollments[0]._id === ids.normal);
  result = await actors.admin('/oi33/enrollment/review?name=%00');
  check('malformed name filter is rejected', rejected(result));
  result = await actors.admin('/oi33/enrollment/review?status=unapproved', null, true);
  const filterHtml = result.body.raw || '';
  check('actual review template has separate immediate status and text-name forms', result.status === 200
    && filterHtml.includes('data-enrollment-status-filter') && filterHtml.includes('data-enrollment-name-filter')
    && filterHtml.includes('type="text" name="name"') && !filterHtml.includes('type="number" name="uid"')
    && !filterHtml.includes('<option value="pending"') && filterHtml.includes('审核未通过'));
  check('review GET filters never change enrollment decisions or revisions',
    same(filterSnapshot, await db.collection('oi33_enrollment').find({}).sort({ _id: 1 }).toArray()));

  const resetForm = { action: 'reset_password', uid: String(ids.normal), revision: String((await enrollment('normal')).revision) };
  const credentialsBefore = await db.collection('user').findOne({ _id: ids.normal }, { projection: { hash: 1, salt: 1 } });
  for (const name of ['domainroot', 'coach']) {
    check(`${name} cannot read global account management`, rejected(await actors[name]('/oi33/enrollment/review')));
    check(`${name} cannot forge student password reset`, rejected(await actors[name]('/oi33/enrollment/review', resetForm)));
  }
  result = await actors.admin('/oi33/enrollment/review', resetForm, false, {
    Origin: 'https://foreign.invalid', Referer: 'https://foreign.invalid/reset',
  });
  check('foreign-origin reset is rejected without changing credentials', rejected(result)
    && same(credentialsBefore, await db.collection('user').findOne({ _id: ids.normal }, { projection: { hash: 1, salt: 1 } })));
  result = await actors.admin('/oi33/enrollment/review', resetForm);
  check('administrator reset requires recent native authorization before changing credentials', result.status < 400
    && /sudo/.test(result.location || result.body.url || '')
    && same(credentialsBefore, await db.collection('user').findOne({ _id: ids.normal }, { projection: { hash: 1, salt: 1 } })));
  const sudoUrl = result.location || result.body.url;
  await actors.admin(sudoUrl);
  result = await actors.admin(sudoUrl, { password });
  check('administrator completes native sudo with current credential', result.status < 400);
  for (const name of ['oi33_token', 'oi33_oauth_token', 'oi33_oauth_refresh']) {
    await db.collection(name).insertOne({ _id: 'reset-synthetic-token', uid: ids.normal, isActive: true });
  }
  await db.collection('oi33_oauth_code').insertOne({ _id: 'reset-synthetic-code', uid: ids.normal, consumed: false });
  const credentialState = async () => ({
    user: await db.collection('user').findOne({ _id: ids.normal }, { projection: { hash: 1, salt: 1 } }),
    enrollment: await enrollment('normal'),
    tokens: await Promise.all(['token', 'oi33_token', 'oi33_oauth_token', 'oi33_oauth_refresh', 'oi33_oauth_code']
      .map(async (collection) => [collection, await db.collection(collection).find({ uid: ids.normal }).sort({ _id: 1 }).toArray()])),
  });
  const deniedOrigins = [
    ['foreign Origin with omitted Referer', { Origin: 'https://foreign.invalid', Referer: null }],
    ['foreign Origin with empty Referer', { Origin: 'https://foreign.invalid', Referer: '' }],
    ['both source headers omitted', { Origin: null, Referer: null }],
    ['null Origin with same-site Referer', { Origin: 'null' }],
    ['malformed Origin with same-site Referer', { Origin: 'not-a-url' }],
    ['malformed Referer with same-site Origin', { Referer: 'not-a-url' }],
    ['foreign Origin conflicts with same-site Referer', { Origin: 'https://foreign.invalid' }],
    ['foreign Referer conflicts with same-site Origin', { Referer: 'https://foreign.invalid/reset' }],
    ['same host but different scheme', { Origin: base.replace('http:', 'https:'), Referer: null }],
    ['same host but different port', { Origin: 'http://127.0.0.1:8898', Referer: null }],
    ['cross-site Fetch Metadata despite forged source', { 'Sec-Fetch-Site': 'cross-site' }],
  ];
  for (const [label, headers] of deniedOrigins) {
    const before = await credentialState();
    result = await actors.admin('/oi33/enrollment/review', resetForm, false, headers);
    const unchanged = same(before, await credentialState());
    check(`sudo-authorized reset rejects ${label} without any credential/enrollment/token mutation`, rejected(result)
      && unchanged, JSON.stringify({ status: result.status, unchanged, url: result.location || result.body.url,
      error: result.body.error?.name || result.body.error }));
  }
  // The allowed Referer-only path mutates a separate synthetic account so both
  // valid browser source combinations are tested through a real successful reset.
  const batchBefore = await enrollment('batch');
  result = await actors.admin('/oi33/enrollment/review', {
    action: 'reset_password', uid: String(ids.batch), revision: String(batchBefore.revision),
  }, false, { Origin: null });
  check('same-origin Referer without Origin permits authorized reset', result.status < 400
    && (await enrollment('batch')).requiresPasswordChange
    && (await enrollment('batch')).revision === batchBefore.revision + 1);
  const oldRecord = await connectSocket(`/record-detail-conn?rid=${rid}&noTemplate=1`, actors.normal.cookie());
  await waitFor(() => oldRecord.messages.some((message) => message.rdoc?._id === rid), 'initial core record update', 6000);
  check('real core record-detail socket receives initial authenticated update before reset', !oldRecord.closed
    && oldRecord.messages.some((message) => message.rdoc?._id === rid));
  const normalToken = await db.collection('token').findOne({ uid: ids.normal, tokenType: 0 });
  assert.ok(normalToken?._id, 'Synthetic student login must have a persisted session');
  const oldGateway = await subscribeMessages(normalToken._id);
  check('browser gateway accepts normal current student credential before reset',
    oldGateway.messages.some((message) => message.accept?.includes(`message:${ids.normal}`)));
  const oldRecordMessageCount = oldRecord.messages.length;
  const oldGatewayMessageCount = oldGateway.messages.length;
  const identityBeforeReset = await enrollment('normal');
  result = await actors.admin('/oi33/enrollment/review', resetForm, false, { Referer: null });
  doc = await enrollment('normal');
  check('same-origin Origin without Referer permits authorized reset', result.status < 400 && doc.requiresPasswordChange);
  check('admin reset marks force-change and saves safe history while retaining verification and identity', result.status < 400
    && doc.requiresPasswordChange && doc.passwordReset.state === 'ready' && !doc.passwordOperation
    && doc.revision === identityBeforeReset.revision + 1 && doc.status === 'approved'
    && doc.realName === identityBeforeReset.realName && doc.enabled === identityBeforeReset.enabled
    && same(doc.requestedGroups, identityBeforeReset.requestedGroups)
    && doc.history.at(-1).action === 'password_reset');
  check('reset revokes core sessions and private API/OAuth credentials', await db.collection('token').countDocuments({ uid: ids.normal }) === 0
    && await db.collection('oi33_token').countDocuments({ uid: ids.normal, isActive: true }) === 0
    && await db.collection('oi33_oauth_token').countDocuments({ uid: ids.normal, isActive: true }) === 0
    && await db.collection('oi33_oauth_refresh').countDocuments({ uid: ids.normal, isActive: true }) === 0
    && await db.collection('oi33_oauth_code').countDocuments({ uid: ids.normal, consumed: false }) === 0);
  result = await actors.normal('/oi33/enrollment');
  check('previous student login is no longer authenticated after reset', result.status >= 400
    || /login/.test(result.location || result.body.url || '')
    || (result.status === 200 && result.body.enrollment === null && !result.body.legacyVerified && !result.body.canManageAccounts),
    JSON.stringify({ status: result.status, enrollmentUid: result.body.enrollment?._id, location: result.location, url: result.body.url }));
  const student = session();
  await student('/login');
  result = await student('/login', { uname: 'qa_normal', password });
  check('old password no longer authenticates after reset', rejected(result));
  result = await student('/login', { uname: 'qa_normal', password: '123456' });
  const changeUrl = result.location || result.body.url;
  check('temporary password authenticates and redirects immediately to native password page', result.status < 400
    && changeUrl === '/home/security');
  result = await student(changeUrl, null, true);
  check('fresh password login directly displays change form without another sudo prompt', result.status === 200
    && (result.body.raw || '').includes('name="current"') && (result.body.raw || '').includes('name="verifyPassword"')
    && (result.body.raw || '').includes('请先修改密码') && /no-store/.test(result.cache));
  result = await student('/', null, true);
  check('forced student cannot navigate away to normal HTML pages', (result.location || result.body.url) === changeUrl);
  result = await student('/oi33/enrollment');
  check('forced student cannot use unrelated JSON APIs', rejected(result));
  result = await student('/home/security', { operation: 'change_mail', mail: 'unauthorized@fixture.invalid', password: '123456' });
  check('forced student cannot switch to another account-security operation', rejected(result));
  result = await student('/home/security', { operation: 'change_password', current: '123456', password: '123456', verifyPassword: '123456' });
  check('unchanged default password cannot unlock the account', rejected(result) && (await enrollment('normal')).requiresPasswordChange);
  result = await student('/home/security', { operation: 'change_password', current: 'WrongFixturePassword', password, verifyPassword: password });
  check('wrong current password retains force-change and releases operation lock', rejected(result)
    && (await enrollment('normal')).requiresPasswordChange && !(await enrollment('normal')).passwordOperation);
  for (const [label, headers] of deniedOrigins) {
    const before = await credentialState();
    result = await student('/home/security', { operation: 'change_password', current: '123456', password, verifyPassword: password }, false, headers);
    check(`forced native password change rejects ${label} without credential/enrollment/token mutation`, rejected(result)
      && same(before, await credentialState()), `HTTP ${result.status}`);
  }
  result = await student('/home/security', { operation: 'change_password', current: '123456', password, verifyPassword: password }, false, { Origin: null });
  check('successful native password change clears the matching requirement and logs out', result.status < 400
    && (result.location || result.body.url) === '/login' && !(await enrollment('normal')).requiresPasswordChange
    && !(await enrollment('normal')).passwordOperation);
  const finalStudent = session();
  await finalStudent('/login');
  result = await finalStudent('/login', { uname: 'qa_normal', password: '123456' });
  check('temporary password stops working after student changes it', rejected(result));
  result = await finalStudent('/login', { uname: 'qa_normal', password });
  check('new password permits normal login again', result.status < 400 && (result.location || result.body.url) !== '/home/security');
  result = await finalStudent('/oi33/enrollment');
  check('student regains ordinary access without losing verification', result.status === 200 && result.body.enrollment.status === 'approved');
  for (const [label, headers] of deniedOrigins) {
    const before = await credentialState();
    result = await finalStudent('/home/security', { operation: 'change_password', current: password,
      password: 'SyntheticNeverSavedPassword!2026', verifyPassword: 'SyntheticNeverSavedPassword!2026' }, false, headers);
    check(`ordinary native password change rejects ${label} without credential/enrollment/token mutation`, rejected(result)
      && same(before, await credentialState()), `HTTP ${result.status}`);
  }
  // Crucially, no inbound traffic or fixture events were sent to the old
  // sockets during reset/forced change: enrollment is approved again now.
  const newRecord = await connectSocket(`/record-detail-conn?rid=${rid}&noTemplate=1`, finalStudent.cookie());
  await waitFor(() => newRecord.messages.some((message) => message.rdoc?._id === rid), 'new core record connection', 6000);
  const currentToken = await db.collection('token').findOne({ uid: ids.normal, tokenType: 0 });
  const newGateway = await subscribeMessages(currentToken._id);
  check('new browser gateway accepts fresh credential after password change',
    newGateway.messages.some((message) => message.accept?.includes(`message:${ids.normal}`)));
  result = await actors.admin('/qa/password-security-event', {});
  check('synthetic event broadcaster runs only inside isolated fixture', result.status === 200);
  await waitFor(() => oldRecord.closed && oldGateway.closed
    && newRecord.messages.some((message) => message.rdoc?.score === 17)
    && newGateway.messages.some((message) => JSON.stringify(message).includes('synthetic-password-security-event')),
  'old sockets revoked and fresh sockets updated after reset/change', 10000);
  check('idle pre-reset core record socket closes after password recovery without any new record push',
    oldRecord.closeCode === 4003 && oldRecord.messages.length === oldRecordMessageCount);
  check('idle pre-reset browser gateway closes without leaking later messages', oldGateway.closeCode === 4003
    && oldGateway.messages.length === oldGatewayMessageCount);
  check('new authenticated core record socket receives later normal updates', !newRecord.closed
    && newRecord.messages.some((message) => message.rdoc?.score === 17));
  check('new browser gateway receives normal messages with refreshed session', !newGateway.closed
    && newGateway.messages.some((message) => JSON.stringify(message).includes('synthetic-password-security-event')));
  result = await finalStudent('/oi33/enrollment/review', { ...resetForm, uid: String(ids.invalid) });
  check('student cannot forge an administrator password reset', rejected(result));
  result = await actors.admin('/oi33/enrollment/review', resetForm);
  check('replaying stale administrator reset fails without changing the new password', rejected(result)
    && !(await enrollment('normal')).requiresPasswordChange);
  check('reset and password changes never alter class membership, roles or privileges',
    same(groupsBefore, await db.collection('user.group').find({}).sort({ _id: 1 }).toArray())
    && same(rolesBefore, await db.collection('domain.user').find({}).project({ _id: 0, domainId: 1, uid: 1, role: 1 }).sort({ uid: 1 }).toArray())
    && same(privilegesBefore, await db.collection('user').find({}).project({ _id: 1, priv: 1 }).sort({ _id: 1 }).toArray()));
  const privateLogs = JSON.stringify(await db.collection('oplog').find({}).toArray());
  check('operation logs never contain current or new credential values', !privateLogs.includes(password)
    && !privateLogs.includes('WrongFixturePassword') && !privateLogs.includes('"current":'));
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run this isolated runtime test under Linux/WSL.');
  for (const port of [mongoPort, 8899, aiPort]) await ensureFree(port);
  // WSL may start its existing boot services with this invocation. Capture
  // their identities only after boot settles, before creating our fixture.
  await delay(4000);
  report.isolated.existingServicesBefore = originalSockets();
  fixture = fs.mkdtempSync('/tmp/oi33-enrollment-name-qa-');
  profile = path.join(os.homedir(), '.hydro', 'profiles', run);
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(profile, { recursive: false });
  for (const name of ['db', 'store', 'tmp', 'addon/templates']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
  report.isolated.fixture = fixture; report.isolated.profile = profile;
  write(path.join(profile, 'config.json'), { host: '127.0.0.1', port: String(mongoPort), name: run.replaceAll('-', '_') });
  write(path.join(profile, 'addon.json'), [path.join(globalModules, '@hydrooj/ui-default'), path.join(fixture, 'addon')]);
  write(path.join(fixture, 'addon/package.json'), { name: 'oi33-enrollment-name-qa', version: '1.0.0', main: 'index.js' });
  for (const name of ['oi33_enrollment.html', 'oi33_enrollment_review.html', 'oi33_password_change.html', 'partials/enrollment_review_return.html']) {
    fs.mkdirSync(path.dirname(path.join(fixture, 'addon/templates', name)), { recursive: true });
    fs.copyFileSync(path.join(root, 'templates', name), path.join(fixture, 'addon/templates', name));
  }
  const ready = path.join(fixture, 'ready.json');
  write(path.join(fixture, 'addon/index.js'), `
const fs = require('fs');
const { db, UserModel, DomainModel, ProblemModel, RecordModel, Handler, PRIV } = require('hydrooj');
exports.apply = async function(ctx) {
  await require(${JSON.stringify(path.join(root, 'handler/enrollment.ts'))}).apply(ctx);
  const { submitEnrollment, provisionEnrollment } = require(${JSON.stringify(path.join(root, 'model/enrollment.ts'))});
  if (!await DomainModel.get('system')) await DomainModel.add('system', 2, 'Isolated name review QA', 'Synthetic fixture only');
  const ids = { admin: 2, normal: 3, invalid: 4, review: 5, malformed: 6, error: 7,
    manual: 8, disabled: 9, revision: 10, history: 11, batch: 12, temporary: 13, featureoff: 14, unconfigured: 15,
    domainroot: 16, coach: 17 };
  await UserModel.create('nobody@fixture.invalid', 'nobody', ${JSON.stringify(password)}, 0, '127.0.0.1', PRIV.PRIV_DEFAULT);
  for (const [name, uid] of Object.entries(ids)) {
    await UserModel.create('qa_' + name + '@fixture.invalid', 'qa_' + name, ${JSON.stringify(password)}, uid, '127.0.0.1', name === 'admin' ? PRIV.PRIV_ALL : PRIV.PRIV_DEFAULT);
    await UserModel.setById(uid, { timeZone: 'Asia/Shanghai' });
    if (name !== 'admin') await DomainModel.setUserRole('system', uid, 'default', true);
  }
  await DomainModel.setUserRole('system', ids.domainroot, 'root', true);
  await DomainModel.setUserRole('system', ids.coach, 'coach', true);
  await UserModel.updateGroup('system', ${JSON.stringify(privateGroup)}, []);
  await submitEnrollment(ids.history, 'system', { realName: '旧待审' }, 0);
  await provisionEnrollment({ uid: ids.batch, domainId: 'system', realName: '批量学生', batchId: 'synthetic-batch', rosterKey: 'row-one' }, ids.admin);
  await provisionEnrollment({ uid: ids.temporary, domainId: 'system', realName: '临时选手', accountType: 'temporary',
    validFrom: new Date(Date.now() - 60000), validUntil: new Date(Date.now() + 86400000),
    contestScopes: [{ domainId: 'system', contestId: '000000000000000000000099' }] }, ids.admin);
  await db.collection('oi33_ai_provider').insertOne({ _id: 'fixture-deepseek', baseUrl: 'http://127.0.0.1:${aiPort}',
    apiKey: ${JSON.stringify(apiKey)}, models: [{ name: 'deepseek-v4-flash', input: 1, inputCached: 0.1, output: 2 }] });
  await db.collection('oi33_ai_config').insertOne({ _id: 'main', student_model: 'deepseek-v4-flash',
    moderation_model: 'deepseek-v4-flash', enrollment_auto_review_enabled: '1' });
  const pid = await ProblemModel.add('system', 'QA_PASSWORD_WS', 'Synthetic password socket problem', 'Isolated fixture only', ids.admin);
  const rid = await RecordModel.add('system', pid, ids.normal, 'cc', '// synthetic fixture only', false);
  class QaPasswordSecurityEventHandler extends Handler {
    async post() {
      this.checkPriv(PRIV.PRIV_ALL);
      const rdoc = await RecordModel.update('system', rid, { score: 17 });
      ctx.broadcast('record/change', rdoc);
      ctx.broadcast('user/message', [ids.normal], { from: ids.admin, to: ids.normal,
        content: 'synthetic-password-security-event', _id: 'synthetic-event-only-no-message-write' });
      this.response.body = { ok: true };
    }
  }
  ctx.Route('qa_password_security_event', '/qa/password-security-event', QaPasswordSecurityEventHandler);
  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ ids, rid: String(rid) }));
};
`);
  const env = { ...process.env, NODE_PATH: globalModules, PATH: `/root/.nix-profile/bin:${process.env.PATH}`,
    HYDRO_PROFILE: run, DEFAULT_STORE_PATH: path.join(fixture, 'store'), TMPDIR: path.join(fixture, 'tmp'), NODE_APP_INSTANCE: 'qa-fixture' };
  delete env.CI; delete env.DEV; delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL;
  await startAi();
  mongoProcess = spawn(mongod, ['--dbpath', path.join(fixture, 'db'), '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--quiet'], {
    env, stdio: ['ignore', fs.openSync(path.join(fixture, 'mongo.log'), 'a'), fs.openSync(path.join(fixture, 'mongo.log'), 'a')],
  });
  client = new MongoClient(`mongodb://127.0.0.1:${mongoPort}`, { serverSelectionTimeoutMS: 500 });
  await waitFor(async () => { await client.connect(); return true; }, 'isolated Mongo');
  const db = client.db(run.replaceAll('-', '_'));
  await db.collection('system').insertMany([
    { _id: 'server.host', value: '127.0.0.1' }, { _id: 'server.port', value: 8899 },
    { _id: 'server.url', value: base }, { _id: 'server.login', value: true },
    { _id: 'limit.by_user', value: true }, { _id: 'session.keys', value: ['SyntheticEnrollmentNameSession2026'] },
  ]);
  await db.collection('document').createIndex({ domainId: 1, docType: 1, docId: 1 }, { name: 'basic', unique: true });
  await db.collection('document.status').createIndex({ domainId: 1, docType: 1, docId: 1, uid: 1 }, { name: 'basic', unique: true });
  hydroProcess = spawn(node, [path.join(globalModules, 'hydrooj/bin/hydrooj.js'), '--host', '127.0.0.1', '--port', '8899'], {
    cwd: fixture, env, stdio: ['pipe', fs.openSync(path.join(fixture, 'hydro.log'), 'a'), fs.openSync(path.join(fixture, 'hydro.log'), 'a')],
  });
  console.log(`Isolated enrollment-name fixture: ${fixture}`);
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
  for (const res of held.values()) res.destroy();
  held.clear();
  for (const socket of openSockets) socket.terminate();
  openSockets.clear();
  await stop(hydroProcess); await client?.close(); await stop(mongoProcess);
  if (aiServer) { aiServer.closeAllConnections(); await new Promise((resolve) => aiServer.close(resolve)); }
  if (process.platform === 'linux' && report.isolated.existingServicesBefore) {
    report.isolated.existingServicesAfter = originalSockets();
    report.isolated.existingServicesUnchanged = same(report.isolated.existingServicesBefore, report.isolated.existingServicesAfter);
    report.isolated.fixturePortsReleased = !sockets().some((line) => /:(8899|27019|18999)\s/.test(line));
    if (!report.isolated.existingServicesUnchanged || !report.isolated.fixturePortsReleased) { report.ok = false; process.exitCode = 1; }
  }
  if (fixture && fs.existsSync(path.join(fixture, 'hydro.log'))) {
    const log = fs.readFileSync(path.join(fixture, 'hydro.log'), 'utf8');
    report.isolated.runtimeLogContainsSecret = [password, apiKey, rawError, 'SyntheticNeverSavedPassword!2026', ...sessionSecrets].some((secret) => log.includes(secret));
    report.isolated.runtimeLogContainsRawMessageEvent = /MessageEvent\s*\{/.test(log);
    if (report.isolated.runtimeLogContainsSecret) { report.ok = false; process.exitCode = 1; }
    if (report.isolated.runtimeLogContainsRawMessageEvent) { report.ok = false; process.exitCode = 1; }
  }
  report.mockRequests = aiRequests.length;
  report.finishedAt = new Date().toISOString();
  const safe = [password, apiKey, rawError, ...sessionSecrets].reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), JSON.stringify(report, null, 2));
  if (fixture) write(path.join(fixture, 'report.json'), safe);
  const reports = path.join(__dirname, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const target = path.join(reports, `${run}.json`);
  write(target, safe);
  console.log(`Report: ${target}; only fixture processes stopped, fixture data retained.`);
});
