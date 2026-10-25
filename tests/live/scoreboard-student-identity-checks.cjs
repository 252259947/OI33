// Only the hydro-smoke isolated database may construct these synthetic fixtures.
// After fixture setup, every HTTP request is GET. No account or identity is edited.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const text = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const userCells = html => [...html.matchAll(/<td\b[^>]*class="[^"]*\bcol--user\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g)]
  .map(match => match[1]);
const memberCells = html => [...html.matchAll(/<li\b[^>]*class="enroll_user_menu_item"[^>]*data-uid="(\d+)"[^>]*>([\s\S]*?)<\/li>/g)]
  .map(match => ({ uid: +match[1], html: match[2] }));

exports.checkStudentScoreboardIdentity = async function ({ db, check, actors, fixtureData }) {
  assert.match(db.databaseName, /^oi33_qa_\d+_\d+$/, 'This helper must never use a production database');
  const { student, applicant, admin } = actors;
  assert.equal(typeof admin, 'function', 'Administrator session is required to verify staff export permissions');
  const documents = db.collection('document');
  const statuses = db.collection('document.status');
  const accounts = await db.collection('user').find({ _id: { $in: [4, 6] } }).toArray();
  assert.equal(accounts.length, 2);
  const names = { 4: 'QA 4', 6: 'QA New Student' };
  const scores = { 4: 73, 6: 42 };
  const group = await db.collection('user.group').findOne({ domainId: 'system', uids: { $all: [4, 6] } });
  assert.ok(group, 'Synthetic students must share a class before scoreboard checks');
  const contestSource = await documents.findOne({ domainId: 'system', docType: 30, docId: new ObjectId(fixtureData.tid) });
  const trainingSource = await documents.findOne({ domainId: 'system', docType: 40, docId: new ObjectId(fixtureData.trainingId) });
  assert.ok(contestSource && trainingSource);
  const ids = { contest: new ObjectId(), homework: new ObjectId(), training: new ObjectId() };
  const beginAt = new Date(Date.now() - 7200000);
  const endAt = new Date(Date.now() - 3600000);
  for (const kind of ['contest', 'homework']) {
    const fixture = { ...contestSource, _id: ids[kind], docId: ids[kind],
      title: `QA student identity ${kind}`, rule: kind === 'homework' ? 'homework' : 'ioi',
      beginAt, endAt, penaltySince: endAt, penaltyRules: {}, assign: kind === 'homework' ? [group.name] : [],
      pids: [fixtureData.pid], attend: 2, keepScoreboardHidden: false, unlocked: true };
    delete fixture.lockAt;
    await documents.insertOne(fixture);
    await statuses.insertMany([4, 6].map(uid => ({ _id: new ObjectId(), domainId: 'system', docType: 30,
      docId: ids[kind], uid, attend: 1, startAt: beginAt, score: scores[uid], penaltyScore: scores[uid],
      time: uid, journal: [], detail: {}, display: {} })));
  }
  await documents.insertOne({ ...trainingSource, _id: ids.training, docId: ids.training,
    title: 'QA student identity training', attend: 2 });
  await statuses.insertMany([4, 6].map(uid => ({ _id: new ObjectId(), domainId: 'system', docType: 40,
    docId: ids.training, uid, enroll: 1, doneNids: [], donePids: [], done: false })));

  const protectedState = async () => JSON.stringify({
    users: await db.collection('user').find({ _id: { $in: [4, 6] } }).project({ _id: 1, uname: 1, unameLower: 1,
      mail: 1, mailLower: 1, hash: 1, salt: 1, hashType: 1, priv: 1 }).sort({ _id: 1 }).toArray(),
    identities: await db.collection('oi33_user').find({ _id: { $in: [4, 6] } }).sort({ _id: 1 }).toArray(),
    enrollments: await db.collection('oi33_enrollment').find({ _id: { $in: [4, 6] } }).sort({ _id: 1 }).toArray(),
    groups: await db.collection('user.group').find({ domainId: 'system' }).sort({ _id: 1 }).toArray(),
    scores: await statuses.find({ domainId: 'system', docType: 30 }).sort({ _id: 1 }).toArray(),
    records: await db.collection('record').find({ domainId: 'system' }).sort({ _id: 1 }).toArray(),
  });
  const before = await protectedState();
  for (const kind of ['contest', 'homework']) {
    const route = `/${kind}/${ids[kind]}/scoreboard`;
    let result = await student(route);
    const cells = (result.body.rows || []).slice(1).flat().filter(cell => cell.type === 'user');
    check(`student ${kind} scoreboard JSON retains verified names and stable UID identity`,
      result.status === 200 && cells.length === 2 && cells.every(cell => names[cell.raw]
        && cell.value === names[cell.raw] && cell.oi33RealName === names[cell.raw])
        && accounts.every(account => result.body.udict?.[account._id]?.uname === account.uname),
      `status=${result.status}; rows=${JSON.stringify(cells)}`);
    check(`student ${kind} scoreboard retains scores while replacing only user labels`,
      result.body.rows.slice(1).every(row => String(row[2].value) === String(scores[row.find(cell => cell.type === 'user').raw])));
    check(`student ${kind} scoreboard JSON excludes private profile fields and raw avatar email`,
      Object.values(result.body.udict).every(user => !user.mail && !user.school && !user.studentId
        && !user.displayName && !user.realname_name && !String(user.avatar || '').startsWith('gravatar:'))
      && accounts.every(account => !JSON.stringify(result.body.udict).includes(account.mail)));
    for (const [view, options] of [['HTML', { html: true }], ['PJAX', { html: true, headers: { 'X-PJAX': 'true' } }]]) {
      result = await student(route, null, options);
      const cells = userCells(result.body.raw || '');
      check(`student ${kind} real ${view} renders real names in linked user cells`, result.status === 200
        && cells.length === 2 && accounts.every(account => cells.some(cell => cell.includes(`/user/${account._id}`)
          && text(cell) === names[account._id] && !text(cell).includes(account.uname)))
        && /no-store/.test(result.cache), `status=${result.status}; cells=${JSON.stringify(cells.map(text))}`);
    }
    // The native export limit is 3 per minute per account, shared by all boards.
    // Two ordinary student accounts exercise four exports without weakening it.
    const exporter = kind === 'contest' ? student : applicant;
    for (const view of ['html', 'csv']) {
      result = await exporter(`${route}/${view}`, null, { html: true });
      const output = result.body.raw || '';
      const diagnostics = { status: result.status, length: output.length,
        missingNames: Object.values(names).filter(name => !output.includes(name)),
        missingScores: Object.values(scores).filter(score => !output.includes(String(score))),
        exposedUsernames: accounts.filter(account => output.includes(account.uname)).map(account => account._id),
        exposedEmails: accounts.filter(account => output.includes(account.mail)).map(account => account._id),
        // Every name/email here is synthetic; preserve enough actual output to
        // distinguish a native template/filter mismatch from an identity bug.
        rendered: output.slice(0, 5000) };
      check(`student ${kind} native ${view.toUpperCase()} export retains real names without private account columns`,
        result.status === 200 && Object.values(names).every(name => output.includes(name))
        && Object.values(scores).every(score => output.includes(String(score)))
        && accounts.every(account => !output.includes(account.uname) && !output.includes(account.mail)),
        JSON.stringify(diagnostics));
    }
  }

  for (const view of ['html', 'csv']) {
    const result = await admin(`/contest/${ids.contest}/scoreboard/${view}`, null, { html: true });
    const output = result.body.raw || '';
    check(`administrator native ${view.toUpperCase()} export keeps existing private-info permission`,
      result.status === 200 && accounts.every(account => output.includes(account.mail))
      && Object.values(names).every(name => output.includes(name)), `status=${result.status}; output length=${output.length}`);
  }

  let result = await student(`/training/${ids.training}`);
  check('student training JSON retains verified member names and original account usernames', result.status === 200
    && accounts.every(account => result.body.oi33TrainingNames?.[account._id] === names[account._id]
      && result.body.udict?.[account._id]?.uname === account.uname), `status=${result.status}`);
  const trainingUsers = [...Object.values(result.body.udict || {}), result.body.udoc].filter(Boolean);
  check('student training JSON excludes private member and author fields and raw avatar emails',
    trainingUsers.length >= 2 && trainingUsers.every(user => !user.mail && !user.school && !user.studentId
      && !user.displayName && !user.realname_name && !String(user.avatar || '').startsWith('gravatar:'))
    && accounts.every(account => !JSON.stringify(trainingUsers).includes(account.mail)));
  result = await student(`/training/${ids.training}`, null, { html: true });
  const members = memberCells(result.body.raw || '');
  check('student training real HTML retains real names in member links', result.status === 200 && members.length === 2
    && accounts.every(account => members.some(member => member.uid === account._id
      && member.html.includes(`?uid=${account._id}`) && text(member.html) === names[account._id]))
    && /no-store/.test(result.cache), `status=${result.status}; members=${JSON.stringify(members.map(member => [member.uid, text(member.html)]))}`);
  result = await student(`/training/${ids.training}?uid=6`, null, { html: true, headers: { 'X-PJAX': 'true' } });
  const notice = (result.body.raw || '').match(/<blockquote\b[^>]*class="typo note"[^>]*>([\s\S]*?)<\/blockquote>/)?.[1] || '';
  check('student training comparison PJAX identifies the selected learner by real name', result.status === 200
    && text(notice).includes(names[6]) && !text(notice).includes(accounts.find(account => account._id === 6).uname),
    `status=${result.status}; notice=${text(notice)}`);
  check('scoreboard reads preserve account credentials, identities, classes, contest scores and submitted records',
    before === await protectedState());
  // Core TrainingDetail GET updates its derived progress cache; it is deliberately
  // excluded from the immutable score snapshot. No submission or identity changes.
};
