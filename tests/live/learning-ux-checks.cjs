// Called only by hydro-smoke's isolated 8899 / 27019 synthetic fixture.
// No production URLs, credentials, database connections or service restarts.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

exports.checkLearningUx = async function ({ db, check, actors, fixtureData, session, login }) {
  const { coach, otherCoach, student, applicant, learningStudent } = actors;
  const { pid, otherPid, trainingId, acceptedStatus, wrongStatus } = fixtureData;
  const query = values => new URLSearchParams(values).toString();
  const ids = body => body.tdocs.map(doc => String(doc.docId));
  const group = 'QA学习体验班';
  const prefix = 'QA UX ';
  const recent = uid => db.collection('oi33_recent_learning').findOne({ domainId: 'system', uid });
  let result = await learningStudent('/oi33/learning/continue', null, { html: true });
  check('recent learning first use redirects to homework with a fixed empty-state hint',
    result.status < 400 && result.location === '/homework?resume=empty', JSON.stringify(result));
  result = await learningStudent(result.location, null, { html: true });
  check('recent learning first-use hint renders in the real homework template',
    result.status === 200 && (result.body.raw || '').includes('还没有最近练习记录'));
  result = await learningStudent('/', null, { html: true });
  check('homepage native continue link has the requested wording and safe endpoint',
    result.status === 200 && /href="\/oi33\/learning\/continue"[^>]*>继续练习/.test(result.body.raw || ''));
  result = await coach('/oi33/education/classes', { operation: 'update', name: group, uids: '4,6,10' });
  check('learning UX fixture creates a separate teaching class over the native route', result.status < 400);
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  async function createHomework(suffix, pids) {
    const created = await coach('/homework/create', { operation: 'update', title: prefix + suffix,
      content: '', pids, beginAtDate: day, beginAtTime: '00:00', penaltySinceDate: '2100-01-01',
      penaltySinceTime: '00:00', rated: 'false', classNames: group });
    check(`learning UX creates ${suffix} through core homework editor`, created.status < 400 && !!created.body.tid);
    return String(created.body.tid);
  }
  const partial = await createHomework('partial', `${pid},${otherPid}`);
  const complete = await createHomework('complete', String(pid));
  const empty = await createHomework('empty', '');
  const statuses = db.collection('document.status');
  for (const [tid, detail] of [
    [partial, { [pid]: { pid, status: acceptedStatus, score: 100 }, [otherPid]: { pid: otherPid, status: wrongStatus, score: 0 } }],
    [complete, { [pid]: { pid, status: acceptedStatus, score: 100 } }],
  ]) await statuses.updateOne({ domainId: 'system', docType: 30, docId: new ObjectId(tid), uid: 4 },
    { $set: { detail } }, { upsert: true });
  const rosterBefore = JSON.stringify(await db.collection('oi33_education_roster').find({ domainId: 'system',
    tid: { $in: [partial, complete, empty].map(id => new ObjectId(id)) } }).sort({ _id: 1 }).toArray());
  const statusBefore = JSON.stringify(await statuses.find({ domainId: 'system', uid: 4,
    docId: { $in: [partial, complete, empty].map(id => new ObjectId(id)) } }).sort({ _id: 1 }).toArray());
  result = await student(`/homework?${query({ q: prefix, group })}`);
  check('real student catalog exposes personal canonical homework progress', result.status === 200
    && result.body.tdocs.find(doc => String(doc.docId) === partial)?.educationProgress.completed === 1
    && result.body.tdocs.find(doc => String(doc.docId) === partial)?.educationProgress.total === 2
    && result.body.tdocs.find(doc => String(doc.docId) === complete)?.educationProgress.complete === true
    && result.body.tdocs.find(doc => String(doc.docId) === empty)?.educationProgress.complete === false,
    JSON.stringify(result.body.tdocs?.map(doc => ({ id: doc.docId, progress: doc.educationProgress }))));
  check('real student catalog places incomplete assignments ahead of completed ones', ids(result.body).at(-1) === complete);
  for (const [filter, expected] of [['unfinished', [empty, partial]], ['completed', [complete]]]) {
    result = await student(`/homework?${query({ q: prefix, group, progress: filter })}`);
    check(`real ${filter} filter includes exactly the expected homework`, result.status === 200
      && JSON.stringify(ids(result.body).sort()) === JSON.stringify(expected.sort()));
  }
  result = await student(`/homework?${query({ q: prefix, group, progress: 'completed', uid: '6' })}`);
  check('forged uid cannot replace the current students homework progress', result.status === 200
    && JSON.stringify(ids(result.body)) === JSON.stringify([complete]));
  result = await applicant(`/homework?${query({ q: prefix, group, progress: 'completed' })}`);
  check('another student sees their own incomplete status, not another students ACs',
    result.status === 200 && result.body.tdocs.length === 0);
  result = await student(`/homework?${query({ q: prefix, group })}`, null, { html: true });
  const html = result.body.raw || '';
  check('real catalog HTML renders progress, long-term deadline and fixed count semantics',
    result.status === 200 && html.includes('role="progressbar"') && html.includes('1/2')
      && html.includes('长期开放') && html.includes('待布置题目') && !html.includes('未领取'));
  result = await coach(`/homework?${query({ q: prefix, progress: 'completed' })}`);
  check('teacher catalog remains all-assignments view without inventing personal progress',
    result.status === 200 && result.body.educationIsCoach && result.body.progress === 'all'
      && ids(result.body).length === 3 && result.body.tdocs.every(doc => !doc.educationProgress));
  result = await student('/homework?progress=not-a-filter');
  check('unknown progress filter is rejected by the real handler', result.status >= 400 && result.status < 500);
  check('catalog rendering and filters leave score records and published roster snapshots unchanged',
    statusBefore === JSON.stringify(await statuses.find({ domainId: 'system', uid: 4,
      docId: { $in: [partial, complete, empty].map(id => new ObjectId(id)) } }).sort({ _id: 1 }).toArray())
    && rosterBefore === JSON.stringify(await db.collection('oi33_education_roster').find({ domainId: 'system',
      tid: { $in: [partial, complete, empty].map(id => new ObjectId(id)) } }).sort({ _id: 1 }).toArray()));

  // The genuine finish hook observes native full HTML and PJAX detail requests.
  result = await learningStudent(`/homework/${partial}`, null, { html: true });
  check('successful real homework detail persists the current students recent lesson',
    result.status === 200 && (await recent(10))?.tid === partial && (await recent(10))?.kind === 'homework');
  result = await learningStudent('/oi33/learning/continue', null, { html: true });
  check('continue learning routes back to the last successful homework, not a problem',
    result.status < 400 && result.location === `/homework/${partial}` && /no-store/.test(result.cache));
  result = await learningStudent(`/training/${trainingId}`, null, { html: true, headers: { 'X-PJAX': 'true' } });
  check('successful real training PJAX detail replaces the recent homework with the plan',
    result.status === 200 && (await recent(10))?.tid === trainingId && (await recent(10))?.kind === 'training',
    `status=${result.status}; ${JSON.stringify(result.body.error || {})}`);
  const secondDevice = session(); await login(secondDevice, 'qa_learning_student');
  result = await secondDevice('/oi33/learning/continue', null, { html: true });
  check('fresh login session on another device resumes the same server-side training plan',
    result.status < 400 && result.location === `/training/${trainingId}`);
  const beforeIrrelevant = JSON.stringify(await recent(10));
  await learningStudent(`/p/${pid}`);
  await learningStudent(`/contest/${fixtureData.tid}`);
  await learningStudent(`/homework/${partial}/edit`);
  check('problem contest and rejected editor routes do not replace the recent learning target',
    beforeIrrelevant === JSON.stringify(await recent(10)));
  result = await learningStudent('/oi33/learning/continue?domainId=qa_upload_other');
  check('recent learning refuses a borrowed domain argument', result.status >= 400 && result.status < 500);
  const unavailable = new ObjectId();
  await db.collection('oi33_recent_learning').updateOne({ domainId: 'system', uid: 10 }, { $set: { tid: String(unavailable) } });
  result = await learningStudent('/oi33/learning/continue', null, { html: true });
  check('deleted or absent training target safely returns the homework list', result.status < 400
    && result.location === '/homework?resume=unavailable');
  result = await learningStudent(result.location, null, { html: true });
  check('real unavailable lesson hint offers a new lesson choice', result.status === 200
    && (result.body.raw || '').includes('上次打开的作业或训练计划已不可访问'));
  await learningStudent(`/homework/${partial}`);
  const beforeRemoval = JSON.stringify(await recent(10));
  await coach('/oi33/education/classes', { operation: 'update', name: group, uids: '4,6' });
  result = await learningStudent('/oi33/learning/continue', null, { html: true });
  check('recent homework continuation rechecks changed class membership', result.status < 400
    && result.location === '/homework?resume=unavailable');
  result = await learningStudent(`/homework/${partial}`);
  check('failed homework detail does not overwrite the last successful history', result.status >= 400
    && result.status < 500 && beforeRemoval === JSON.stringify(await recent(10)));
  const continuedStudent = await student('/oi33/learning/continue?uid=10', null, { html: true });
  check('forged continuation uid never borrows another students stored target',
    continuedStudent.status < 400 && continuedStudent.location !== `/homework/${partial}`);
  await coach('/oi33/education/classes', { operation: 'update', name: group, uids: '4,6,10' });

  // Real-name searches are restricted to teachers and existing scope. All names
  // and accounts in this fixture are synthetic; requests never touch production.
  const search = values => `/oi33/education/students?${query(values)}`;
  for (const [label, actor] of [['student', student], ['anonymous', session()]]) {
    result = await actor(search({ q: 'QA' }));
    check(`${label} cannot query teaching student names`, result.status >= 400 && result.status < 500
      && !result.body.students);
  }
  result = await student(search({ q: 'QA', domainId: 'qa_upload_other' }));
  check('student picker refuses an actual coach role borrowed from another domain', result.status === 403
    && !result.body.students, JSON.stringify(result.body));
  result = await coach(search({ q: 'QA 4' }));
  check('coach searches legacy verified real names with username and uid disambiguation', result.status === 200
    && result.body.students?.some(entry => entry.uid === 4 && entry.name === 'QA 4' && entry.username === 'qa_student')
    && /no-store/.test(result.cache), JSON.stringify(result.body));
  result = await coach(search({ q: 'QA New Student' }));
  check('coach searches the approved enrollment real name', result.status === 200
    && result.body.students?.some(entry => entry.uid === 6 && entry.name === 'QA New Student'));
  result = await coach(search({ q: 'QA' }));
  check('teacher selector excludes coach and administrator accounts', result.status === 200
    && result.body.students?.every(entry => ![2, 3, 7, 9].includes(entry.uid)));
  result = await coach(search({ q: '.*' }));
  check('student name query escapes regexp metacharacters', result.status === 200
    && result.body.students?.length === 0);
  result = await coach(search({ q: 'a'.repeat(81) }));
  check('student selector bounds input length', result.status >= 400 && result.status < 500);
  result = await otherCoach(search({ q: 'QA', tid: partial, mode: 'exempt' }));
  check('another coach cannot query a private homework management roster', result.status === 403 && !result.body.students);
  result = await coach(search({ q: 'QA', tid: partial, mode: 'exempt' }));
  check('exemption selector includes only current non-exempt roster students', result.status === 200
    && JSON.stringify(result.body.students.map(entry => entry.uid).sort((a, b) => a - b)) === JSON.stringify([4, 6, 10]));
  result = await coach(search({ q: 'QA', tid: partial, mode: 'add' }));
  check('supplement selector includes only current homework class students', result.status === 200
    && result.body.students.every(entry => [4, 6, 10].includes(entry.uid)));
  await coach('/oi33/education/classes', { operation: 'update', name: group, uids: '4,5,6,10' });
  result = await coach(search({ q: 'QA 5', tid: partial, mode: 'add' }));
  check('newly assigned student appears in supplementary picker immediately', result.status === 200
    && result.body.students.some(entry => entry.uid === 5));
  result = await coach(search({ q: 'QA 5', tid: partial, mode: 'exempt' }));
  check('non-roster student does not appear in the exemption picker', result.status === 200
    && result.body.students.length === 0);
  // Exercise the existing preview and confirmation transaction with the UIDs
  // produced by the new selector, not a different mutation endpoint.
  result = await coach(`/oi33/education/homework/${partial}`, { operation: 'preview', mode: 'add', uids: '5', reason: '' });
  check('name-selected supplemental UID uses native roster preview', result.status === 200
    && result.body.preview?.added?.includes(5));
  result = await coach(`/oi33/education/homework/${partial}`, { operation: 'confirm', token: result.body.preview.token, confirmed: 'yes' });
  check('name-selected supplemental UID uses native roster confirmation', result.status < 400
    && (await db.collection('oi33_education_roster').findOne({ domainId: 'system', tid: new ObjectId(partial) }))
      .entries.some(entry => entry.uid === 5 && !entry.exemptAt));
  result = await coach(`/oi33/education/homework/${partial}`, { operation: 'preview', mode: 'exempt', uids: '5', reason: 'QA synthetic exemption' });
  check('name-selected exemption UID uses the existing preview', result.status === 200
    && result.body.preview?.exempted?.includes(5));
  result = await coach(`/oi33/education/homework/${partial}`, { operation: 'confirm', token: result.body.preview.token, confirmed: 'yes' });
  check('name-selected exemption UID uses the existing confirmation', result.status < 400
    && (await db.collection('oi33_education_roster').findOne({ domainId: 'system', tid: new ObjectId(partial) }))
      .entries.some(entry => entry.uid === 5 && !!entry.exemptAt));
  assert.ok(await db.collection('user').findOne({ _id: 5 }), 'Synthetic exemption preserves the account');
};
