const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync, transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pureCode = buildSync({ entryPoints: [path.join(root, 'frontend/training-progress.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const pure = { exports: {} };
new Function('module', 'exports', pureCode)(pure, pure.exports);
const { calculateTrainingProgress, validateTrainingDependencies } = pure.exports;
const plan = [
  { _id: 7, title: 'A', pids: [1, 2], requireNids: [] },
  { _id: 3, title: 'B', pids: [3], requireNids: [7] },
  { _id: 9, title: 'C', pids: [4], requireNids: [7, 3] },
];
const ac = ids => Object.fromEntries(ids.map(id => [id, { status: 1 }]));

test('completion and unlocking are independent of display order, including shared prerequisites', () => {
  const reversed = [plan[2], plan[1], plan[0]];
  validateTrainingDependencies(reversed);
  const before = JSON.stringify(reversed);
  for (const ids of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
    const ordered = calculateTrainingProgress(plan, ac(ids));
    const changed = calculateTrainingProgress(reversed, ac(ids));
    assert.deepEqual(changed.nsdict, ordered.nsdict);
    assert.deepEqual([...changed.summary.doneNids].sort(), [...ordered.summary.doneNids].sort());
    assert.equal(changed.summary.done, ids.length === 4);
  }
  assert.equal(JSON.stringify(reversed), before, 'IDs, requirements, problem order and display order remain untouched');
  const firstOnly = calculateTrainingProgress(reversed, ac([1, 2]));
  assert.equal(firstOnly.nsdict[3].isOpen, true);
  assert.equal(firstOnly.nsdict[9].isInvalid, true);
});

test('cycles, missing prerequisites and invalid IDs are rejected on save; legacy cycles fail closed without recursion', () => {
  for (const chapters of [
    [{ ...plan[0], requireNids: [7] }],
    [{ ...plan[0], requireNids: [3] }, plan[1]],
    [{ ...plan[0], requireNids: [404] }],
    [{ ...plan[0], requireNids: ['7'] }],
    [{ ...plan[0], requireNids: null }],
    [plan[0], plan[0]], [{ ...plan[0], _id: 0 }], [],
  ]) assert.throws(() => validateTrainingDependencies(chapters), /先修|章节/);
  const legacy = [{ ...plan[0], requireNids: [3] }, plan[1], { ...plan[2], requireNids: [] }];
  const result = calculateTrainingProgress(legacy, ac([1, 2, 3, 4]));
  assert.equal(result.summary.done, false);
  assert.deepEqual(result.summary.doneNids, [9]);
  assert.equal(result.nsdict[7].isInvalid, true);
  assert.equal(result.nsdict[3].isInvalid, true);
});

test('only plan-local accepted problem status contributes to completion', () => {
  const result = calculateTrainingProgress(plan, { ...ac([1, 2, 3, 4, 999]), 2: { status: 2 } });
  assert.deepEqual(result.summary.donePids, [1, 3, 4]);
  assert.equal(result.nsdict[7].progress, 50);
  assert.equal(result.nsdict[7].isProgress, true);
  assert.equal(result.nsdict[3].isInvalid, true);
  assert.equal(result.summary.done, false);
});

function load(source, deps) {
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in deps)) throw Error(`unexpected import ${name}`);
    return deps[name];
  }, mod, mod.exports);
  return mod.exports;
}

function harness() {
  const calls = [], writes = [], hooks = {};
  let problemStatuses = {}, visibleProblems = ac([1, 2, 3, 4]);
  const hydro = { PERM: { PERM_VIEW_PROBLEM_HIDDEN: 1, PERM_EDIT_DOMAIN: 2 }, PRIV: { PRIV_USER_PROFILE: 1 }, STATUS: { STATUS_ACCEPTED: 1 },
    ValidationError: class extends Error { constructor(...args) { super(args.join(' ')); } },
    ProblemModel: {
      getList: async (...args) => { calls.push(['problems', ...args]); return Object.fromEntries(Object.keys(visibleProblems).filter(id => args[1].includes(+id)).map(id => [id, { docId: +id }])); },
      getListStatus: async (...args) => { calls.push(['statuses', ...args]); return Object.fromEntries(args[2].filter(id => problemStatuses[id]).map(id => [id, problemStatuses[id]])); },
    },
    TrainingModel: { setStatus: async (...args) => { writes.push(args); return { uid: args[2], ...args[3] }; } },
  };
  const plugin = load(read('handler/training-progress.ts'), { hydrooj: hydro, '../frontend/training-progress': pure.exports });
  plugin.apply({ on: (name, fn) => { hooks[name] = fn; } });
  const h = { domain: { _id: 'system' }, user: { _id: 42, hasPriv: () => true, hasPerm: () => false },
    response: { body: {}, addHeader(name, value) { this[name] = value; } } };
  return { plugin, hydro, h, hooks, calls, writes,
    setStatuses(value) { problemStatuses = value; }, hideProblem(id) { delete visibleProblems[id]; } };
}

test('list and homepage recalculate visible plans with one batched formal-status query and no account writes', async () => {
  const env = harness(), { h, hooks, calls, writes } = env;
  const docs = Array.from({ length: 15 }, (_, i) => ({ domainId: 'system', docId: String(i), dag: [...plan].reverse() }));
  const statuses = Object.fromEntries(docs.map(doc => [doc.docId, { enroll: 1, donePids: [1, 2], done: false, uid: 42 }]));
  env.setStatuses(ac([1, 2, 3, 4]));
  h.response.body = { tdocs: docs, tsdict: statuses, tdict: { unrelated: { domainId: 'system', docId: 'secret', dag: [{ ...plan[0], pids: [999] }] } } };
  await hooks['handler/after/TrainingMain#get'](h);
  assert.equal(calls.filter(row => row[0] === 'statuses').length, 1);
  assert.deepEqual(calls.find(row => row[0] === 'statuses')[3].sort(), [1, 2, 3, 4]);
  assert.equal(Object.values(statuses).every(status => status.done && status.donePids.length === 4 && status.enroll === 1), true);
  assert.deepEqual(writes, []);
  assert.equal(h.response['Cache-Control'], 'private, no-store');
  calls.length = 0;
  env.setStatuses(ac([1, 2]));
  h.response.body = { contents: [{ sections: [['training', [docs, statuses]]] }] };
  await hooks['handler/after/Home#get'](h);
  assert.equal(statuses[0].done, false);
  assert.deepEqual(statuses[0].donePids, [1, 2]);
  assert.equal(calls.filter(row => row[0] === 'statuses').length, 1);
  assert.deepEqual(writes, []);
});

test('summary refresh respects guest, domain, hidden-problem and no-status boundaries', async () => {
  const env = harness(), { h, plugin, calls } = env;
  env.setStatuses(ac([1, 2, 3, 4, 999]));
  const docs = [{ domainId: 'system', docId: 'a', dag: plan }, { domainId: 'foreign', docId: 'b', dag: plan }];
  const statuses = { a: { uid: 42, enroll: 1 }, b: { uid: 42, enroll: 1, done: false } };
  h.user.hasPriv = () => false;
  await plugin.refreshTrainingSummaries(h, docs, statuses);
  assert.deepEqual(calls, []);
  h.user.hasPriv = () => true;
  env.hideProblem(2);
  await plugin.refreshTrainingSummaries(h, docs, statuses);
  assert.equal(statuses.a.done, false);
  assert.deepEqual(statuses.a.donePids, [1, 3, 4]);
  assert.deepEqual(statuses.b, { uid: 42, enroll: 1, done: false });
  assert.equal(calls[0][3], 42, 'ordinary users see hidden problems only through the native owner/maintainer policy');
  assert.equal(calls[0][4], false);
});

test('actual native detail handler followed by the plugin fixes reordered completion and preserves native gates', async () => {
  const env = harness(), { h, hydro, plugin, writes } = env;
  const native = read('node_modules/hydrooj/src/handler/training.ts');
  const source = native.slice(native.indexOf('class TrainingDetailHandler'), native.indexOf('class TrainingEditHandler'));
  const tdoc = { domainId: 'system', docId: 'a', owner: 2, dag: [...plan].reverse(), description: '' };
  const donePids = new Set([1, 2, 3, 4]);
  const training = { get: async () => tdoc, getPids: dag => dag.flatMap(n => n.pids),
    getMultiStatus: () => ({ project: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    isDone: (node, nids, pids) => node.requireNids.every(id => nids.has(id)) && node.pids.every(id => pids.has(id)),
    isInvalid: (node, nids) => node.requireNids.some(id => !nids.has(id)),
    isProgress: () => false, isOpen: () => false,
    setStatus: async (_, __, uid, data) => ({ uid, enroll: 1, ...data }),
  };
  const deps = { Handler: class {}, param: () => () => {}, Types: { ObjectId: {}, PositiveInt: {} }, PERM: hydro.PERM, PRIV: hydro.PRIV, STATUS: hydro.STATUS,
    training, user: { getById: async () => ({}), getListForRender: async () => ({}), listGroup: async () => [] },
    problem: { getList: async () => Object.fromEntries([...donePids].map(id => [id, { docId: id }])), getListStatus: async () => ac([...donePids]) } };
  const prefix = Object.keys(deps).map(key => `const ${key}=require('deps').${key};`).join('\n');
  const { TrainingDetailHandler } = load(`${prefix}\n${source}\nexport {TrainingDetailHandler}`, { deps });
  Object.setPrototypeOf(h, TrainingDetailHandler.prototype);
  const gates = [];
  h.ctx = { parallel: async (event, doc) => { gates.push([event, doc.docId]); }, setting: { get: () => true } };
  await h.get('system', 'a', 42);
  assert.deepEqual(gates, [['training/get', 'a']]);
  assert.equal(h.response.body.tsdoc.done, false, 'baseline installed native loop still shows the old defect');
  await plugin.refreshTrainingDetail(h);
  assert.equal(h.response.body.tsdoc.done, true);
  assert.equal(Object.values(h.response.body.nsdict).every(status => status.isDone && !status.isInvalid), true);
  assert.deepEqual(h.response.body.tdoc.dag.map(n => n._id), [9, 3, 7]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2], 42);
  h.response.body.tsdoc.uid = 43;
  await plugin.refreshTrainingDetail(h);
  assert.equal(writes.length, 1, 'comparison view adds no writes to the other student');
});

test('server-side save guard rejects advanced JSON cycles and missing prerequisites without changing submitted DAG', () => {
  const { plugin, h } = harness();
  h.args = { dag: JSON.stringify([...plan].reverse()) };
  const original = h.args.dag;
  plugin.validateTrainingSubmission(h);
  assert.equal(h.args.dag, original);
  for (const dag of ['{broken', '{}', JSON.stringify([{ ...plan[0], requireNids: [7] }]), JSON.stringify([{ ...plan[0], requireNids: [404] }])]) {
    h.args.dag = dag;
    assert.throws(() => plugin.validateTrainingSubmission(h), /dag/);
  }
});

test('homework scoring notice is visible and explicit on detail and homework scoreboard only', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(root, 'templates')), { autoescape: true });
  const notice = env.render('partials/oi33_homework_scoring.html');
  assert.match(notice, /最后一次正式提交/);
  assert.match(notice, /不保留历史最高分/);
  assert.match(notice, /已通过后提交错误答案也会扣分/);
  assert.match(notice, /自测不计分/);
  assert.match(read('templates/homework_detail.html'), /include "partials\/oi33_homework_scoring.html"/);
  assert.match(read('templates/contest_scoreboard.html'), /if tdoc\.rule == 'homework'.*include "partials\/oi33_homework_scoring.html"/);
});
