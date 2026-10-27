const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');

if (process.env.OI33_LAYOUT_TEST === '1') test('real Markdown editor preserves drafts, isolates accounts and disables only student local uploads', async () => {
  const { chromium } = require('playwright');
  const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
  const main = fs.readFileSync(path.join(publicRoot, 'hydro-4.58.4.js'), 'utf8');
  const script = buildSync({ entryPoints: [path.join(root, 'frontend/article-compose.page.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'ArticleCompose', external: ['@hydrooj/ui-default', 'jquery'],
    loader: { '.css': 'empty' } }).outputFiles[0].text;
  const origin = 'http://127.0.0.1:18765';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await context.route(`${origin}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') {
      const uid = url.searchParams.get('uid') || '4';
      const upload = url.searchParams.get('upload') || '0';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><form data-article-compose
        data-article-owner="system:${uid}" data-article-id="new" data-article-upload="${upload}">
        <div data-article-draft-notice hidden><p data-draft-description></p><button type="button" data-draft-restore>恢复草稿</button><button type="button" data-draft-discard>舍弃草稿</button></div>
        <p data-article-draft-status></p><input name="title"><textarea name="content" style="height:260px"></textarea>
        <input name="problemId"><input type="radio" name="visibility" value="public" checked><input type="radio" name="visibility" value="private">
        <button type="submit">发布文章</button></form></body></html>` });
    }
    const file = path.resolve(publicRoot, '.' + url.pathname);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
  });
  async function mount(uid = 4, upload = 0, tab = page) {
    await tab.goto(`${origin}/fixture?uid=${uid}&upload=${upload}`);
    await tab.evaluate(({ uid, origin }) => {
      window.UiContext = JSON.stringify({ cdn_prefix: origin + '/' });
      window.UserContext = JSON.stringify({ _id: uid, viewLang: 'zh', preferredEditorType: 'sv' });
      window.UiContextNew = '{}'; window.UserContextNew = '{}';
    }, { uid, origin });
    await tab.addScriptTag({ content: main });
    await tab.evaluate(async () => {
      window.webpackChunk_hydrooj_ui_default.push([[987654], {}, require => { window.hydroRequire = require; }]);
      await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
      window.$ = window.hydroRequire(91688);
      window.nativeEditor = window.hydroRequire(22077).default.getOrConstruct(window.$('textarea[name=content]'), { language: 'markdown' });
      window.require = name => name === 'jquery' ? window.$ : { addPage() {}, NamedPage: class {} };
      document.querySelector('.page-loader')?.remove();
      document.querySelector('form').addEventListener('submit', e => e.preventDefault());
    });
    await tab.addScriptTag({ content: script });
    await tab.evaluate(() => window.ArticleCompose.mountArticleCompose());
    await tab.waitForFunction(() => window.nativeEditor.isValid && document.querySelector('.cm-content'));
  }
  const key = 'oi33:article-draft:v1:system%3A4:new';
  try {
    await mount();
    await page.locator('[name=title]').fill('Unsubmitted title');
    await page.locator('.cm-content').fill('Private draft body');
    await page.locator('[name=problemId]').fill('J0001');
    await page.locator('[name=visibility][value=private]').check();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || 'null')?.fields.content === 'Private draft body', key);
    await page.getByRole('button', { name: '发布文章', exact: true }).click();
    assert.ok(await page.evaluate(key => !!localStorage.getItem(key), key), 'An unsuccessful submit must keep the draft');
    await mount();
    assert.equal(await page.locator('[data-article-draft-notice]').isVisible(), true);
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await page.waitForFunction(() => window.nativeEditor.value() === 'Private draft body');
    assert.equal(await page.locator('[name=title]').inputValue(), 'Unsubmitted title');
    assert.equal(await page.locator('[name=problemId]').inputValue(), 'J0001');
    assert.equal(await page.locator('[name=visibility][value=private]').isChecked(), true);
    await page.getByRole('button', { name: '图片', exact: true }).click();
    const items = page.locator('.md-editor-menu-item-image');
    await items.nth(1).waitFor();
    assert.equal(await items.nth(0).getAttribute('aria-disabled'), null, 'Image link insertion stays available');
    assert.equal(await items.nth(1).getAttribute('aria-disabled'), 'true');
    assert.equal(await items.nth(2).getAttribute('aria-disabled'), 'true');
    assert.ok((await items.nth(1).getAttribute('title')).includes('没有上传权限'));
    await items.nth(1).click({ force: true });
    assert.ok(await page.locator('input[type=file]').evaluateAll(inputs => inputs.every(input => input.disabled)));
    const fields = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).fields, key);
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    await page.evaluate(({ fingerprint, key }) => {
      const marker = document.createElement('div');
      Object.assign(marker.dataset, { articleDraftOwner: 'system:4', articleSavedId: 'new', articleSavedFingerprint: fingerprint });
      document.body.append(marker);
      const newer = JSON.parse(localStorage.getItem(key)); newer.fields.content += ' newer tab'; localStorage.setItem(key, JSON.stringify(newer));
    }, { fingerprint, key });
    await page.evaluate(() => window.ArticleCompose.clearPublishedArticleDraft());
    assert.ok(await page.evaluate(key => !!localStorage.getItem(key), key), 'Successful old submission must not delete another tab edit');
    await page.evaluate(({ key, fields }) => { const draft = JSON.parse(localStorage.getItem(key)); draft.fields = fields; localStorage.setItem(key, JSON.stringify(draft)); }, { key, fields });
    await page.evaluate(() => window.ArticleCompose.clearPublishedArticleDraft());
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, 'Exact submitted draft clears with the server receipt');
    await mount();
    const other = await context.newPage();
    other.on('dialog', dialog => dialog.accept());
    await mount(4, 0, other);
    await page.locator('[name=title]').fill('First tab saved version');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || 'null')?.fields.title === 'First tab saved version', key);
    await other.locator('[name=title]').fill('Second tab conflicting version');
    assert.match(await other.locator('[data-article-draft-status]').textContent(), /另一页面已更新草稿/);
    await other.locator('[name=title]').fill('');
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).fields.title, key), 'First tab saved version',
      'An older tab returning to its initial state must not erase another tab draft');
    await other.close();
    await mount(5);
    assert.equal(await page.locator('[data-article-draft-notice]').isVisible(), false);
    assert.equal(await page.evaluate(() => window.nativeEditor.value()), '');
    await mount(3, 1);
    await page.getByRole('button', { name: '图片', exact: true }).click();
    assert.equal(await page.locator('.md-editor-menu-item-image').nth(1).getAttribute('aria-disabled'), null);
    assert.ok(await page.locator('input[type=file]').evaluateAll(inputs => inputs.every(input => !input.disabled)));
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Article browser diagnostics:', await page.locator('input[type=file]').evaluateAll(inputs => inputs.map(input => ({ html: input.outerHTML, parent: input.parentElement.className }))), errors);
    throw error;
  } finally { await browser.close(); }
});
