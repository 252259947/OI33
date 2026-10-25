// Invoked exclusively by hydro-smoke's isolated 8899 / 27019 synthetic fixture.
const assert = require('node:assert/strict');

exports.checkAccountUsername = async function ({ db, check, session, login, password }) {
  assert.match(db.databaseName, /^oi33_qa_\d+_\d+$/);
  const uid = 11;
  const route = '/oi33/account/username';
  // Keep the generated email within Hydro's native login-field length limit.
  const oldUsername = 'qa_name_student';
  const newUsername = 'qa_username_updated';
  const redirectOf = result => result.location || result.body.url || '';
  const routeMatches = (value, expected) => [expected, `/d/system${expected}`].includes(value);
  const snapshot = async () => ({
    user: await db.collection('user').findOne({ _id: uid }, { projection: {
      _id: 1, mail: 1, mailLower: 1, hash: 1, salt: 1, hashType: 1, priv: 1,
    } }),
    identity: await db.collection('oi33_user').findOne({ _id: uid }),
    enrollment: await db.collection('oi33_enrollment').findOne({ _id: uid }),
    scores: await db.collection('document.status').find({ uid }).sort({ _id: 1 }).toArray(),
    records: await db.collection('record').find({ uid }).sort({ _id: 1 }).toArray(),
  });
  const actor = session();
  await login(actor, oldUsername);
  const before = JSON.stringify(await snapshot());
  const adminBefore = await db.collection('user').findOne({ _id: 2 }, { projection: { uname: 1 } });
  let result = await actor(route, null, { html: true });
  check('username form renders the current login name, a self-only form and real-name distinction', result.status === 200
    && (result.body.raw || '').includes(oldUsername)
    && (result.body.raw || '').includes('不是实名认证姓名')
    && /name="csrfToken"/.test(result.body.raw || '')
    && /name="expectedUid" value="11"/.test(result.body.raw || '')
    && !/name="(?:uid|mail|password|realName)"/.test(result.body.raw || '')
    && /no-store/.test(result.cache));
  const csrf = /name="csrfToken"\s+value="([^"]*)"/.exec(result.body.raw || '')?.[1] || '';
  const form = extra => ({ username: newUsername, csrfToken: csrf, expectedUid: String(uid), ...extra });
  result = await actor('/home/settings/account', null, { html: true });
  check('real account settings sidebar exposes the username entry', result.status === 200
    && /href="\/oi33\/account\/username"/.test(result.body.raw || ''));
  result = await actor(route, form(), { headers: { Origin: 'https://foreign.invalid' } });
  check('cross-site username submission is rejected before sudo or writes', result.status >= 400 && result.status < 500
    && (await db.collection('user').findOne({ _id: uid })).uname === oldUsername);
  result = await actor(route, form({ expectedUid: '2' }));
  check('stale username form for another account is rejected before native sudo', result.status >= 400 && result.status < 500
    && (await db.collection('user').findOne({ _id: uid })).uname === oldUsername);
  result = await actor(route, { username: newUsername, csrfToken: csrf });
  check('username submission without a bound account cannot start a rename', result.status >= 400 && result.status < 500);
  result = await actor(route, form());
  check('real username mutation requires recent native sudo authentication', result.status < 400 && routeMatches(redirectOf(result), '/user/sudo')
    && (await db.collection('user').findOne({ _id: uid })).uname === oldUsername,
    JSON.stringify({ status: result.status, redirect: redirectOf(result), error: result.body.error?.name }));
  const sudoRoute = redirectOf(result);
  result = await actor(sudoRoute, null, { html: true });
  check('native authorization page is reachable for the retained rename request', result.status === 200
    && /name="password"/.test(result.body.raw || ''));
  result = await actor(sudoRoute, { password });
  check('native sudo verifies the original password for username changes', result.status < 400
    && routeMatches(result.body.redirect, route) && result.body.args?.username === newUsername
    && String(result.body.args?.expectedUid) === String(uid));
  result = await actor(route, form({ uid: '2', mail: 'forged@fixture.invalid',
    password: 'SyntheticForgedPassword', realName: 'SyntheticForgedRealName' }));
  check('real rename targets only the current UID even with forged account fields', result.status < 400
    && redirectOf(result).startsWith(route)
    && (await db.collection('user').findOne({ _id: uid })).uname === newUsername
    && (await db.collection('user').findOne({ _id: 2 })).uname === adminBefore.uname);
  check('username change keeps password hash, original mail, UID, privileges, identity and all scores/records unchanged',
    before === JSON.stringify(await snapshot()));
  result = await actor(route, form({ username: 'QA_ADMIN' }));
  check('real rename rejects another accounts username case-insensitively', result.status >= 400 && result.status < 500
    && (await db.collection('user').findOne({ _id: uid })).uname === newUsername);
  result = await actor(route, form({ username: '11' }));
  check('real rename rejects bare UID names rather than introducing a second login identity', result.status >= 400 && result.status < 500);
  result = await actor(route, form({ username: 'parent@fixture.invalid' }));
  check('real rename rejects email-shaped usernames', result.status >= 400 && result.status < 500);
  result = await actor(`/user/${uid}`);
  check('native user cache resolves the newly saved username immediately', result.status === 200 && result.body.udoc?.uname === newUsername);
  const freshUsernameSession = session();
  await login(freshUsernameSession, newUsername);
  result = await freshUsernameSession(route);
  check('new username and the unchanged password log in to the same account', result.status === 200 && result.body.currentUsername === newUsername);
  const freshEmailSession = session();
  await login(freshEmailSession, `${oldUsername}@fixture.invalid`);
  result = await freshEmailSession(route);
  check('original parent email and unchanged password remain valid after renaming', result.status === 200 && result.body.currentUsername === newUsername);
  const oldSession = session();
  await oldSession('/login');
  result = await oldSession('/login', { uname: oldUsername, password, rememberme: 'false' });
  check('old username cannot log in after the native cache is invalidated', result.status >= 400 && result.status < 500);
  const peerBefore = await db.collection('user').findOne({ _id: 5 }, { projection: { uname: 1 } });
  await login(actor, 'qa_outsider');
  result = await actor(route, form({ username: 'qa_stale_tab_attempt' }));
  check('a previously rendered form cannot rename another account after the same browser logs in again',
    result.status >= 400 && result.status < 500
    && (await db.collection('user').findOne({ _id: 5 })).uname === peerBefore.uname
    && (await db.collection('user').findOne({ _id: uid })).uname === newUsername);
  const logs = await db.collection('oi33_log').find({ action: 'change_username', userId: uid }).toArray();
  check('rename emits one self-service audit entry without retaining an old name or credentials', logs.length === 1
    && logs[0].sender === uid && !JSON.stringify(logs).includes(oldUsername) && !JSON.stringify(logs).includes(password));
  check('real login follow-ups still preserve credentials, real name and historical results', before === JSON.stringify(await snapshot()));
};
