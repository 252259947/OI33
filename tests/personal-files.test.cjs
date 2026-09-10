const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const PRIV = { PRIV_ALL: 1, PRIV_CREATE_FILE: 2 };
class ForbiddenError extends Error {}
function load(file, dependencies) {
  const code = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    if (!(name in dependencies)) throw new Error(`Unstubbed import ${name}`);
    return dependencies[name];
  });
  return module.exports;
}
const hydro = { PRIV, ForbiddenError };
const auth = load('model/education-auth.ts', { hydrooj: hydro });
const policy = load('handler/personal-files.ts', { hydrooj: hydro, '../model/education-auth': auth });
const user = (role = 'default', privileges = [PRIV.PRIV_CREATE_FILE], flag = 1, uid = 4) => ({
  _id: uid, role, realname_flag: flag, hasPriv: (privilege) => privileges.includes(privilege),
});
const handler = (subject = user()) => ({ user: subject, domain: { _id: 'system' }, args: { domainId: 'system' } });

test('personal uploads require a teaching role AND native upload privilege, not class membership or verified student status', () => {
  for (const subject of [user(), user('default', [2], 0), { ...user(), groups: ['coach'] }, user('coach', [2], 1, 0)]) {
    assert.equal(policy.canUploadPersonalFiles(handler(subject)), false);
  }
  for (const subject of [user('coach'), user('root'), user('default', [2], 2), user('default', [1, 2])]) {
    assert.equal(policy.canUploadPersonalFiles(handler(subject)), true);
  }
  for (const subject of [user('coach', []), user('root', []), user('default', [1])]) {
    assert.equal(policy.canUploadPersonalFiles(handler(subject)), false);
  }
});
test('a coach role loaded from a forged domain parameter does not grant personal storage access', () => {
  const h = handler(user('coach'));
  h.args.domainId = 'other';
  assert.equal(policy.canUploadPersonalFiles(h), false);
  h.args.domainId = 'system';
  assert.equal(policy.canUploadPersonalFiles(h), true);
});
test('server wraps only this request upload operation before prepare and rejects students before native parsing or storage', () => {
  const hooks = {};
  policy.apply({ on: (event, callback) => { hooks[event] = callback; } });
  assert.deepEqual(Object.keys(hooks), ['handler/before-prepare/Files', 'handler/after/Files#get']);
  let writes = 0;
  const nativeUpload = function (...args) { writes++; return { subject: this.user._id, args }; };
  const nativeDelete = () => 'delete';
  const prototype = { postUploadFile: nativeUpload, postDeleteFiles: nativeDelete };
  const h = Object.assign(Object.create(prototype), handler());
  hooks['handler/before-prepare/Files'](h);
  for (const args of [[], [{ operation: 'upload_file', role: 'coach', uid: 1 }], ['system', 'test.txt']]) {
    assert.throws(() => h.postUploadFile(...args), { name: 'Error', message: '没有权限' });
  }
  assert.equal(writes, 0);
  assert.equal(prototype.postUploadFile, nativeUpload);
  assert.equal(h.postDeleteFiles, nativeDelete);
  h.user = user('coach');
  assert.deepEqual(h.postUploadFile('native-validation-input'), { subject: 4, args: ['native-validation-input'] });
  assert.equal(writes, 1);
  h.user = user('coach', []);
  assert.throws(() => h.postUploadFile(), ForbiddenError);
  assert.equal(writes, 1);
});
test('server provides authoritative per-request UI capability and private no-store response', () => {
  const hooks = {};
  policy.apply({ on: (event, callback) => { hooks[event] = callback; } });
  for (const role of ['default', 'coach']) {
    const h = handler(user(role)); const headers = {};
    h.response = { body: { files: [] }, addHeader: (name, value) => { headers[name] = value; } };
    hooks['handler/after/Files#get'](h);
    assert.equal(h.response.body.oi33CanUploadPersonalFiles, role === 'coach');
    assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(h.response.body.files, []);
  }
});

class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/home_base.html') return { src: '{% block home_content %}{% endblock %}', path: name };
    if (name === 'partials/files.html') return { src: '<div id="native-file-list"></div>', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
const render = (allowed) => env.render('home_files.html', {
  oi33CanUploadPersonalFiles: allowed, _: (text) => text, noscript_note: { render: () => '' },
});
test('student upload is natively disabled, has an outer hover hint and no core upload click selector', () => {
  for (const allowed of [false, undefined]) {
    const html = render(allowed);
    assert.match(html, /<span class="oi33-personal-upload-disabled" title="没有权限" tabindex="0"/);
    assert.match(html, /<button[^>]*\sdisabled\s[^>]*aria-disabled="true"/);
    assert.doesNotMatch(html, /name="upload_file"|href=|onclick=/);
    assert.match(html, /id="native-file-list"/);
    assert.match(html, /name="remove_selected"/);
  }
  const css = fs.readFileSync(path.join(root, 'frontend/personal-files.css'), 'utf8');
  assert.match(css, /\.oi33-personal-upload-disabled\s*\{[^}]*cursor: not-allowed/s);
  assert.match(css, /button\.button:disabled\s*\{[^}]*pointer-events: none/s);
  assert.match(fs.readFileSync(path.join(root, 'frontend/personal-files.page.ts'), 'utf8'), /import '\.\/personal-files\.css'/);
});
test('authorized teacher keeps native upload trigger, and module is registered', () => {
  const html = render(true);
  assert.match(html, /name="upload_file"/);
  assert.doesNotMatch(html, /disabled|没有权限/);
  const index = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
  assert.match(index, /import \{ apply as applyPersonalFiles \} from '\.\/handler\/personal-files'/);
  assert.match(index, /applyPersonalFiles\(ctx\)/);
});
