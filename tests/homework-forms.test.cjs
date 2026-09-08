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
