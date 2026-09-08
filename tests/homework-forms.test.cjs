const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
class TemplateLoader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% import "components/form.html" as form with context %}{% block content %}{% endblock %}', path: name };
    if (['components/record.html', 'components/problem.html', 'components/md_hint.html', 'partials/homework_sidebar.html'].includes(name)) return { src: '', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new TemplateLoader([
  path.join(root, 'templates'), path.join(root, 'node_modules/@hydrooj/ui-default/templates'),
]), { autoescape: true });
env.addFilter('assign', (value, extra) => Object.assign(value, extra));
env.addFilter('markdown', (value) => `RENDERED: ${value}`);
function state(tdoc = null) {
  return {
    tdoc, csrfToken: 'fixture-token', UiContext: {}, set: () => '',
    _: (s) => s, url: (name) => `/${name}`,
    educationGroups: [{ name: '基础班', uids: [4] }],
    dateBeginText: '2026-09-08', timeBeginText: '0:00', datePenaltyText: '2100-01-01', timePenaltyText: '0:00',
    pids: '', tsdoc: {}, pdict: {},
    handler: { user: { hasPriv: () => false } }, PRIV: { PRIV_USER_PROFILE: 1 },
  };
}
function input(html, name) {
  return [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes(`name="${name}"`));
}

test('homework form keeps required title and class controls but allows empty problems/content', () => {
  const html = env.render('homework_edit.html', state());
  assert.match(input(html, 'title'), /\brequired\b/);
  assert.doesNotMatch(input(html, 'pids'), /\brequired\b/);
  assert.doesNotMatch(html.match(/<textarea\b[^>]*name="content"[^>]*>/)[0], /\brequired\b/);
  assert.match(html, /name="classNames"/);
  assert.match(input(html, 'csrfToken'), /value="fixture-token"/);
  assert.match(input(html, 'penaltySinceDate'), /value="2100-01-01"/);
  assert.match(input(html, 'penaltySinceTime'), /value="0:00"/);
});

test('extension, penalty and languages have only fixed hidden controls, including editing legacy tasks', () => {
  for (const tdoc of [null, { title: '旧作业', langs: ['cc'], content: '', assign: [] }]) {
    const html = env.render('homework_edit.html', state(tdoc));
    for (const [name, value] of [['extensionDays', '0'], ['penaltyRules', '{}'], ['langs', '']]) {
      const tag = input(html, name);
      assert.match(tag, /type="hidden"/);
      assert.ok(tag.includes(`value="${value}"`));
      assert.equal((html.match(new RegExp(`name="${name}"`, 'g')) || []).length, 1);
    }
    assert.doesNotMatch(html, /Extension Score Penalty|Extension \(days\)|Submission language limit|data-yaml/);
  }
});

test('fixed controls share a hidden ancestor so language enhancement cannot create an unlabeled visible input', () => {
  for (const tdoc of [null, { title: '旧作业', langs: ['cc'], content: '', assign: [] }]) {
    const html = env.render('homework_edit.html', state(tdoc));
    const wrapper = html.match(/<div\b([^>]*\bclass="[^"]*\boi33-homework-fixed-options\b[^"]*"[^>]*)>([\s\S]*?)<\/div>/);
    assert.ok(wrapper, 'Fixed options must remain together inside their own wrapper');
    assert.match(wrapper[1], /\bhidden(?:\s|=|$)/);
    for (const name of ['extensionDays', 'penaltyRules', 'langs']) {
      assert.ok(input(wrapper[2], name), `${name} must be inside the hidden ancestor`);
    }
  }
  const css = fs.readFileSync(path.join(root, 'frontend/education.css'), 'utf8');
  assert.match(css, /\.oi33-homework-fixed-options\s*\{[^}]*display\s*:\s*none\s*!important\s*;?[^}]*\}/);
});

test('empty introduction is omitted without hiding the homework title or problem empty state', () => {
  for (const content of [undefined, null, '', ' \n\t ']) {
    const html = env.render('homework_detail.html', state({ title: '保留标题', pids: [], content }));
    assert.match(html, /保留标题/);
    assert.doesNotMatch(html, /data-homework-introduction|Homework Introduction/);
    assert.match(html, /oi33-homework-empty/);
    assert.match(html, /题目待补充/);
    assert.doesNotMatch(html, /class="data-table"/);
    assert.doesNotMatch(html, /添加题目<\/a>/);
  }
});

test('nonempty introduction renders and only authorized managers see the add-problems link', () => {
  const context = state({ title: '<script>title</script>', pids: [], content: '作业说明' });
  context.educationCanManage = true;
  const html = env.render('homework_detail.html', context);
  assert.match(html, /data-homework-introduction/);
  assert.match(html, /RENDERED: 作业说明/);
  assert.match(html, /&lt;script&gt;title&lt;\/script&gt;/);
  assert.match(html, /href="\/homework_edit">添加题目/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'templates/partials/homework_sidebar.html'), 'utf8'), /Can be Extended For|render_extension/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('language enhancer after-inserted UI remains invisible while fixed form fields still submit', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const css = ['node_modules/@hydrooj/ui-default/public/theme-4.58.4.css', 'frontend/education.css']
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
    for (const tdoc of [null, { title: '旧作业', langs: ['cc'], content: '', assign: [] }]) {
      await page.setContent(`<html><head><style>${css}</style></head><body>${env.render('homework_edit.html', state(tdoc))}</body></html>`);
      const result = await page.evaluate(() => {
        const langs = document.querySelector('input[name="langs"]');
        // Hydro's enhancer inserts its visible container after this hidden
        // input. Retain that exact DOM relationship, not another hidden input.
        const enhanced = document.createElement('div');
        enhanced.className = 'fixture-language-enhancer';
        enhanced.style.cssText = 'display:block;width:300px;height:44px';
        const textbox = document.createElement('input');
        textbox.type = 'text'; textbox.className = 'textbox';
        enhanced.append(textbox);
        langs.after(enhanced);
        const fields = new FormData(langs.closest('form'));
        const wrapper = enhanced.closest('.oi33-homework-fixed-options');
        return {
          hasOriginalInput: !!langs, originalValue: langs.value,
          insideHiddenWrapper: wrapper?.hasAttribute('hidden'),
          wrapperDisplay: wrapper && getComputedStyle(wrapper).display,
          enhancedRects: enhanced.getClientRects().length, inputRects: textbox.getClientRects().length,
          values: Object.fromEntries(['extensionDays', 'penaltyRules', 'langs'].map((name) => [name, fields.getAll(name)])),
        };
      });
      assert.equal(result.hasOriginalInput, true);
      assert.equal(result.originalValue, '');
      assert.equal(result.insideHiddenWrapper, true);
      assert.equal(result.wrapperDisplay, 'none');
      assert.equal(result.enhancedRects, 0);
      assert.equal(result.inputRects, 0);
      assert.deepEqual(result.values, { extensionDays: ['0'], penaltyRules: ['{}'], langs: [''] });
    }
  } finally { await browser.close(); }
});
