// Runs only inside hydro-smoke's isolated 8899 / 27019 synthetic fixture.
// All account writes below are editor appearance preferences for fixture users.
const assert = require('node:assert/strict');
const vm = require('node:vm');

function editorSnapshot(html) {
  // Match only a JS string literal, never execute a script or webpage content.
  const literal = html.match(/window\.UiContext\s*=\s*('(?:\\.|[^'\\])*')\s*;/)?.[1];
  if (!literal) return null;
  return JSON.parse(vm.runInNewContext(literal, Object.create(null), { timeout: 1000 })).oi33EditorSettings;
}

exports.checkEditorSettings = async function ({ db, check, actors, fixtureData, session, login }) {
  const { student, outsider } = actors;
  const route = '/oi33/editor-settings';
  const collection = db.collection('oi33_editor_settings');
  const json = { json: true };
  const post = (actor, patch, uid = 4, options = {}) => actor(route, { expectedUid: uid, ...patch }, { ...json, ...options });
  const protectedState = async () => JSON.stringify({
    users: await db.collection('user').find({ _id: { $in: [4, 5] } }).project({ _id: 1, uname: 1, unameLower: 1,
      mail: 1, mailLower: 1, hash: 1, salt: 1, hashType: 1, priv: 1 }).sort({ _id: 1 }).toArray(),
    identities: await db.collection('oi33_user').find({ _id: { $in: [4, 5] } }).sort({ _id: 1 }).toArray(),
    enrollments: await db.collection('oi33_enrollment').find({ _id: { $in: [4, 5] } }).sort({ _id: 1 }).toArray(),
    memberships: await db.collection('domain.user').find({ uid: { $in: [4, 5] } }).sort({ _id: 1 }).toArray(),
    scores: await db.collection('document.status').find({ uid: { $in: [4, 5] } }).sort({ _id: 1 }).toArray(),
    records: await db.collection('record').find({ uid: { $in: [4, 5] } }).sort({ _id: 1 }).toArray(),
  });
  // Establish a genuinely independent authenticated session, then take the
  // baseline so normal login timestamps cannot masquerade as account mutation.
  const secondDevice = session();
  await login(secondDevice, 'qa_student');
  const beforeProtected = await protectedState();
  let result = await student(route);
  check('editor settings GET exposes own UID and null for a fresh account without writing',
    result.status === 200 && result.body.uid === 4 && result.body.settings === null
      && await collection.countDocuments() === 0 && /no-store/.test(result.cache), JSON.stringify(result.body));
  result = await session()(route);
  check('anonymous editor settings GET is refused by the real login guard',
    result.status >= 400 && result.status < 500 && !result.body.settings);
  result = await post(session(), { fontSize: 23 });
  check('anonymous editor settings POST creates no preference', result.status >= 400 && result.status < 500
    && await collection.countDocuments() === 0);

  const initialA = { fontSize: 23, tabSize: 4, theme: 'vs-dark' };
  const initialB = { fontSize: 12, tabSize: 2, theme: 'vs' };
  const initialResults = await Promise.all([
    post(student, { initialize: true, ...initialA }), post(secondDevice, { initialize: true, ...initialB }),
  ]);
  check('two simultaneous first-device initializations both complete over real Mongo and HTTP',
    initialResults.every(item => item.status === 200), JSON.stringify(initialResults.map(item => item.body)));
  const inserted = (await student(route)).body.settings;
  const exact = value => JSON.stringify(value);
  const equals = (left, right) => ['fontSize', 'tabSize', 'theme'].every(key => left?.[key] === right?.[key]);
  check('initialization race retains one whole winning preference without mixing or duplicate accounts',
    (equals(inserted, initialA) || equals(inserted, initialB)) && await collection.countDocuments() === 1
      && initialResults.every(item => equals(item.body.settings, inserted)));
  const beforeReinitialize = exact(await collection.findOne({ _id: 4 }));
  result = await post(secondDevice, { initialize: true, fontSize: 40, tabSize: 8, theme: 'nord' });
  check('later local migration cannot overwrite existing cloud appearance or modification time',
    result.status === 200 && beforeReinitialize === exact(await collection.findOne({ _id: 4 })));

  result = await post(student, { fontSize: 23, tabSize: 4, theme: 'vs-dark' });
  check('real same-origin JSON POST saves all three appearance preferences',
    result.status === 200 && equals(result.body.settings, initialA) && /no-store/.test(result.cache));
  result = await secondDevice(route);
  check('independent authenticated session restores the same account appearance',
    result.status === 200 && result.body.uid === 4 && equals(result.body.settings, initialA));
  result = await outsider(`${route}?uid=4&userId=4`);
  check('different account cannot read another UID through preference query parameters',
    result.status === 200 && result.body.uid === 5 && result.body.settings === null);
  result = await post(outsider, { fontSize: 11, tabSize: 2, theme: 'vs' }, 5);
  check('different account saves its own independent appearance', result.status === 200 && result.body.uid === 5
    && equals((await student(route)).body.settings, initialA));
  const beforeRejected = exact(await collection.find().sort({ _id: 1 }).toArray());
  for (const [label, actor, body] of [
    ['previous-account stale tab', student, { expectedUid: 5, fontSize: 30 }],
    ['forged UID body', student, { expectedUid: 4, uid: 5, fontSize: 30 }],
    ['missing expected account', student, { fontSize: 30 }],
    ['numeric string account', student, { expectedUid: '4', fontSize: 30 }],
    ['unknown appearance field', student, { expectedUid: 4, fontSize: 23, code: 'never store source code' }],
    ['invalid small size', student, { expectedUid: 4, fontSize: 9 }],
    ['invalid large size', student, { expectedUid: 4, fontSize: 41 }],
    ['invalid fractional size', student, { expectedUid: 4, fontSize: 23.5 }],
    ['invalid indentation', student, { expectedUid: 4, tabSize: 3 }],
    ['theme traversal', student, { expectedUid: 4, theme: '../private' }],
    ['theme prototype key', student, { expectedUid: 4, theme: 'constructor' }],
    ['invalid initialization mode', student, { expectedUid: 4, initialize: 'true', fontSize: 23 }],
  ]) {
    result = await actor(route, body, json);
    check(`real editor settings rejects ${label} without any preference mutation`,
      result.status >= 400 && result.status < 500
        && beforeRejected === exact(await collection.find().sort({ _id: 1 }).toArray()), JSON.stringify(result.body.error));
  }
  for (const [label, headers] of [
    ['cross-site origin', { Origin: 'https://untrusted.example.test' }],
    ['cross-site referer', { Referer: 'https://untrusted.example.test/' }],
    ['missing origin and referer', { Origin: '', Referer: '' }],
    ['opaque origin', { Origin: 'null' }],
  ]) {
    result = await post(student, { fontSize: 30 }, 4, { headers });
    check(`real editor settings rejects ${label} without writing`, result.status >= 400 && result.status < 500
      && beforeRejected === exact(await collection.find().sort({ _id: 1 }).toArray()));
  }

  const concurrent = await Promise.all([post(student, { fontSize: 27 }), post(secondDevice, { tabSize: 8 })]);
  result = await secondDevice(route);
  check('concurrent font and indentation updates retain both values and the existing theme',
    concurrent.every(item => item.status === 200) && equals(result.body.settings, { fontSize: 27, tabSize: 8, theme: 'vs-dark' }));
  for (const pid of [fixtureData.pid, fixtureData.otherPid]) {
    const detail = await student(`/p/${pid}`, null, { html: true });
    const embedded = editorSnapshot(detail.body.raw || '');
    check(`native problem ${pid} HTML embeds only the logged-in account settings`, detail.status === 200
      && embedded?.uid === 4 && equals(embedded?.settings, { fontSize: 27, tabSize: 8, theme: 'vs-dark' })
      && /no-store/.test(detail.cache), `status=${detail.status}; embedded=${JSON.stringify(embedded)}`);
  }
  const stored = await collection.find().sort({ _id: 1 }).toArray();
  check('preference documents contain only UID, appearance and update time', stored.every(doc => {
    const keys = Object.keys(doc).sort();
    return exact(keys) === exact(['_id', 'fontSize', 'tabSize', 'theme', 'updatedAt']);
  }));
  check('editor preference flow preserves account credentials email identity roles scores and submissions',
    beforeProtected === await protectedState());
  const logs = await db.collection('oi33_log').find({ action: { $in: ['editor_settings_update', 'editor_settings_initialize'] } }).toArray();
  check('appearance audit is present and contains no code or authentication fields', logs.length >= 5
    && logs.every(doc => ['fontSize', 'tabSize', 'theme'].includes(doc.reason?.split(',')[0])
      && !['code', 'password', 'hash', 'salt', 'mail', 'realName', 'realname_name'].some(key => key in doc)));
  assert.equal(await collection.countDocuments(), 2);
};
