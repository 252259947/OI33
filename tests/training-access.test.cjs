const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { ObjectId } = require('mongodb');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(source, dependencies) {
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in dependencies)) throw Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
class ForbiddenError extends Error {}
class ValidationError extends Error { constructor(...parts) { super(parts.join(' ')); } }
const PERM = Object.fromEntries(['CREATE_TRAINING', 'EDIT_TRAINING', 'EDIT_TRAINING_SELF', 'PIN_TRAINING'].map((key, i) => [`PERM_${key}`, 1n << BigInt(i)]));
const PRIV = { PRIV_ALL: 1, PRIV_USER_PROFILE: 2 };
const hydro = { PERM, PRIV, ForbiddenError };
const auth = compile(read('model/education-auth.ts'), { hydrooj: hydro });
const policy = compile(read('handler/training-access.ts'), { hydrooj: hydro, '../model/education-auth': auth });
const { param } = compile(read('node_modules/@hydrooj/framework/decorators.ts'), { './error': { ValidationError } });
const { Types } = compile(read('node_modules/@hydrooj/framework/validator.ts'), Object.fromEntries(
  ['assert', '@mongodb-js/saslprep', 'emoji-regex', 'sanitize-filename', 'schemastery'].map(name => [name, require(name)]),
));
Types.ObjectId = [value => new ObjectId(value), ObjectId.isValid];
const coreSource = read('node_modules/hydrooj/src/handler/training.ts');
const parserSource = coreSource.slice(coreSource.indexOf('async function _parseDagJson'), coreSource.indexOf('class TrainingMainHandler'));
const editorSource = coreSource.slice(coreSource.indexOf('class TrainingEditHandler'), coreSource.indexOf('export class TrainingFilesHandler'));
const detailsSource = coreSource.slice(coreSource.indexOf('class TrainingDetailHandler'), coreSource.indexOf('class TrainingEditHandler'));

function harness() {
  const hooks = {}, docs = new Map(), writes = [], checks = [], enrolls = [];
  const training = {
    async get(domainId, tid) { const doc = docs.get(String(tid)); if (!doc || doc.domainId !== domainId) throw Error('missing training'); return { ...doc }; },
    getPids: dag => dag.flatMap(node => node.pids),
    async add(domainId, title, content, owner, dag, description, pin) {
      const docId = new ObjectId(); docs.set(String(docId), { docId, domainId, title, content, owner, dag, description, pin });
      writes.push('add'); return docId;
    },
    async edit(_, tid, data) { Object.assign(docs.get(String(tid)), data); writes.push('edit'); },
    async enroll(_, tid, uid) { enrolls.push({ tid: String(tid), uid }); },
    async del(_, tid) { docs.delete(String(tid)); writes.push('delete'); },
  };
  class Handler {}
  const dependencies = { Handler, param, Types, PERM, PRIV, assert, ValidationError, ProblemNotFoundError: Error, training,
    problem: { async get(_, pid) { checks.push(pid); return pid === 1 ? { docId: 1 } : null; } }, storage: { del: async () => {} } };
  const prefix = Object.keys(dependencies).map(key => `const ${key}=require('fixture').${key};`).join('\n');
  const { TrainingEditHandler, TrainingDetailHandler } = compile(`${prefix}\n${parserSource}\n${editorSource}\n${detailsSource}\nexport { TrainingEditHandler,TrainingDetailHandler };`, { fixture: dependencies });
  policy.apply({ on: (name, fn) => { hooks[name] = fn; } });
  function make({ role = 'default', flag = 1, uid = 42, superadmin = false, permissions = [PERM.PERM_CREATE_TRAINING, PERM.PERM_EDIT_TRAINING_SELF], domain = 'system', routeTid, args = {}, detail = false } = {}) {
    const h = new (detail ? TrainingDetailHandler : TrainingEditHandler)();
    const params = routeTid ? { tid: routeTid } : {};
    h.context = { params }; h.domain = { _id: domain };
    h.args = { domainId: domain, title: '训练', content: '练习计划', description: '计划介绍', pin: 0,
      dag: JSON.stringify([{ _id: 1, title: '第一节', pids: [1], requireNids: [] }]), ...args, ...params };
    h.request = { body: args, query: args, params };
    h.user = { _id: uid, role, realname_flag: flag, hasPriv: p => p === PRIV.PRIV_ALL ? superadmin : uid > 0,
      hasPerm: p => permissions.includes(p), own: d => d.owner === uid };
    h.checkPerm = p => { if (!h.user.hasPerm(p)) throw new ForbiddenError('native permission'); };
    h.checkPriv = p => { if (!h.user.hasPriv(p)) throw new ForbiddenError('native privilege'); };
    h.response = { body: {}, headers: {}, addHeader(name, value) { this.headers[name] = value; } };
    h.url = (_, args) => args ? `/training/${args.tid}` : '/training'; h.back = () => {};
    return h;
  }
  async function request(h, method = 'post') {
    // Match framework operation validation and hook/prepare/method ordering.
    if (h.args.operation && typeof h[`post${h.args.operation[0].toUpperCase()}${h.args.operation.slice(1)}`] !== 'function') throw Error('InvalidOperation');
    hooks['handler/before-prepare/TrainingEdit'](h);
    await h.prepare(h.args);
    if (method === 'post') hooks['handler/before/TrainingEdit#post'](h);
    return h[method](h.args);
  }
  function existing(owner = 42) {
    const tid = new ObjectId().toHexString();
    docs.set(tid, { domainId: 'system', docId: new ObjectId(tid), title: '原训练', owner, pin: 0, dag: [], files: [] });
    return tid;
  }
  return { hooks, docs, writes, checks, enrolls, make, request, existing, TrainingEditHandler };
}

test('ordinary, verified and tagged accounts cannot create, even with native create permission', async () => {
  const env = harness();
  for (const options of [{}, { flag: 0 }, { role: 'coach', uid: 0 }]) {
    for (const method of ['get', 'post']) {
      const h = env.make(options); h.user.groups = ['coach', 'root'];
      assert.equal(policy.canCreateTraining(h), false);
      await assert.rejects(() => env.request(h, method), ForbiddenError);
    }
  }
  assert.deepEqual(env.writes, []); assert.deepEqual(env.checks, []);
});

test('query/body tid, role, uid and visibility flags cannot bypass the actual create route', async () => {
  const env = harness(), tid = env.existing();
  for (const args of [{ tid }, { tid, role: 'coach', realname_flag: 3, uid: 3, oi33CanCreateTraining: true }, { tid: 'invalid' }]) {
    for (const method of ['get', 'post']) await assert.rejects(() => env.request(env.make({ args }), method), ForbiddenError);
  }
  assert.deepEqual(env.writes, []); assert.deepEqual(env.checks, []);
});

test('borrowed cross-domain coach roles are rejected; trusted domain routes still work', async () => {
  const env = harness();
  for (const role of ['coach', 'root']) {
    await assert.rejects(() => env.request(env.make({ role, args: { domainId: 'another-school' } })), ForbiddenError);
  }
  await env.request(env.make({ role: 'coach', domain: 'another-school' }));
  assert.deepEqual(env.writes, ['add']);
});

test('coaches and administrator forms retain native problem checks and create exactly once', async () => {
  const env = harness();
  for (const options of [{ role: 'coach' }, { role: 'root' }, { flag: 2 }, { flag: 3 }, { superadmin: true }]) {
    const h = env.make(options);
    assert.equal(policy.canCreateTraining(h), true);
    await env.request(h, 'get'); assert.equal(h.response.body.page_name, 'training_create');
    await env.request(h); assert.ok(env.docs.has(String(h.response.body.tid)));
  }
  assert.equal(env.writes.length, 5); assert.equal(env.checks.length, 5);
  await assert.rejects(() => env.request(env.make({ role: 'coach', args: { dag: '[]' } })), ValidationError);
  assert.equal(env.writes.length, 5);
});

test('teaching identity never grants missing Hydro create or pin permissions', async () => {
  const env = harness();
  for (const role of ['coach', 'root']) {
    const h = env.make({ role, permissions: [] });
    assert.equal(policy.canCreateTraining(h), false);
    await assert.rejects(() => env.request(h), ForbiddenError);
  }
  await assert.rejects(() => env.request(env.make({ role: 'coach', args: { pin: 1 } })), /native permission/);
  assert.deepEqual(env.writes, []);
});

test('existing owners may still edit, enroll and delete under unchanged native checks', async () => {
  const env = harness(), tid = env.existing();
  await env.request(env.make({ routeTid: tid, permissions: [PERM.PERM_EDIT_TRAINING_SELF] }));
  assert.deepEqual(env.writes, ['edit']);
  await assert.rejects(() => env.request(env.make({ routeTid: tid, uid: 43, permissions: [] })), /native permission/);
  const detail = env.make({ detail: true, routeTid: tid, permissions: [] });
  await detail.postEnroll(detail.args); assert.equal(env.enrolls.length, 1);
  await detail.postDelete(detail.args); assert.deepEqual(env.writes, ['edit', 'delete']);
  assert.equal(Object.keys(env.hooks).some(key => /TrainingDetail|TrainingFiles|Problem/.test(key)), false);
});

test('forged copy/import operations never create and handlers are not monkey-patched', async () => {
  const env = harness(), native = env.TrainingEditHandler.prototype.post;
  for (const operation of ['copy', 'clone', 'import', 'update', 'create']) {
    await assert.rejects(() => env.request(env.make({ args: { operation } })), /InvalidOperation/);
  }
  assert.equal(env.TrainingEditHandler.prototype.post, native); assert.deepEqual(env.writes, []);
});

test('existing edit routes keep their trusted target and reject foreign domain arguments', async () => {
  const env = harness(), target = env.existing(), other = env.existing();
  await env.request(env.make({ routeTid: target, args: { tid: other, title: '只修改路由中的训练' } }));
  assert.equal(env.docs.get(target).title, '只修改路由中的训练');
  assert.equal(env.docs.get(other).title, '原训练');
  await assert.rejects(() => env.request(env.make({ routeTid: target, role: 'coach', args: { domainId: 'another-school' } })), ForbiddenError);
  assert.deepEqual(env.writes, ['edit']);
});

test('list capability is server-owned and private; top and empty-list creation links fail closed', () => {
  const env = harness();
  class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
      if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
      return super.getSource(name);
    }
  }
  const templates = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
  for (const role of ['default', 'coach']) {
    const h = env.make({ role }); h.response.body = { q: '', tdocs: [] };
    env.hooks['handler/after/TrainingMain#get'](h);
    assert.equal(h.response.body.oi33CanCreateTraining, role === 'coach');
    assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
    for (const allowed of [h.response.body.oi33CanCreateTraining, undefined]) {
      const html = templates.render('training_main.html', { ...h.response.body, oi33CanCreateTraining: allowed,
        handler: h, perm: PERM, _: s => s, url: name => `/${name}` });
      assert.equal((html.match(/href="\/training_create"/g) || []).length, allowed ? 2 : 0);
      if (!allowed) assert.ok(html.includes('去题库练习'));
    }
  }
  const index = read('index.ts');
  assert.ok(index.includes("from './handler/training-access'")); assert.ok(index.includes('applyTrainingAccess(ctx)'));
});
