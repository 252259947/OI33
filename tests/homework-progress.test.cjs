const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
function load(file, dependencies = {}) {
  const code = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), {
    loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) => {
    if (!(name in dependencies)) throw new Error(`Unstubbed import: ${name}`);
    return dependencies[name];
  });
  return module.exports;
}
const catalog = load('model/homework-catalog.ts', { './education-policy': load('model/education-policy.ts') });
const now = new Date('2026-10-20T12:00:00Z');
const homework = (docId, overrides = {}) => ({
  docId, rule: 'homework', domainId: 'current', title: `作业 ${docId}`, pids: [1, 2], assign: ['基础班'],
  beginAt: new Date('2026-10-19T12:00:00Z'), endAt: new Date('2026-10-22T12:00:00Z'),
  penaltySince: new Date('2026-10-22T12:00:00Z'), ...overrides,
});
test('catalog progress uses only current homework detail and counts the latest verdict, not old AC', () => {
  const doc = homework('one');
  const status = { attend: 1, journal: [{ pid: 1, status: 1 }, { pid: 2, status: 1 }],
    detail: { 1: { status: 2, score: 100 }, 2: { status: 1, score: 100 }, 999: { status: 1 } } };
  const result = catalog.annotateHomeworkProgress(doc, status, now, 1);
  assert.deepEqual(result.educationProgress, { completed: 1, total: 2, complete: false, attempted: 2, percent: 50 });
  assert.equal(catalog.annotateHomeworkProgress(doc, { detail: { 1: { status: 1 }, 2: { status: 0 } } }, now).educationProgress.complete, false);
  assert.equal(catalog.annotateHomeworkProgress(doc, { detail: { 1: { status: 1 }, 2: { status: 1 } } }, now).educationProgress.complete, true);
  assert.equal(doc.educationProgress, undefined, 'Source document is not mutated');
});
test('zero problems never complete, removed problems do not count, and duplicate ids cannot inflate totals', () => {
  assert.deepEqual(catalog.annotateHomeworkProgress(homework('empty', { pids: [] }), undefined, now).educationProgress,
    { completed: 0, total: 0, complete: false, attempted: 0, percent: 0 });
  assert.equal(catalog.annotateHomeworkProgress(homework('dedupe', { pids: [1, 1] }),
    { detail: { 1: { status: 1 }, 2: { status: 1 } } }, now).educationProgress.total, 1);
  assert.equal(catalog.annotateHomeworkProgress(homework('new'), undefined, now).educationProgress.completed, 0);
});
test('filters apply to completion independently of time; unfinished and real upcoming deadlines sort first', () => {
  const docs = [
    homework('long', { endAt: new Date('2099-12-31T16:00:00Z'), penaltySince: new Date('2099-12-31T16:00:00Z') }),
    homework('closed', { endAt: new Date('2026-10-19T14:00:00Z'), penaltySince: new Date('2026-10-19T14:00:00Z') }),
    homework('later'), homework('done'),
    homework('soon', { endAt: new Date('2026-10-21T12:00:00Z'), penaltySince: new Date('2026-10-21T12:00:00Z') }),
  ].map((doc) => catalog.annotateHomeworkProgress(doc, doc.docId === 'done' ? { detail: { 1: { status: 1 }, 2: { status: 1 } } } : undefined, now));
  assert.deepEqual(catalog.selectStudentHomework(docs, 'all', now).map((doc) => doc.docId), ['soon', 'later', 'long', 'closed', 'done']);
  assert.deepEqual(catalog.selectStudentHomework(docs, 'completed', now).map((doc) => doc.docId), ['done']);
  assert.equal(catalog.selectStudentHomework(docs, 'unfinished', now).length, 4);
  assert.equal(docs[0].docId, 'long', 'Input array is not reordered');
  assert.equal(catalog.isLongTermHomework(docs[0]), true);
  assert.equal(catalog.homeworkDeadlineLabel(docs[0]), '2100/01/01 00:00（北京时间）');
  assert.equal(catalog.isLongTermHomework(homework('normal')), false);
});

function adapterFixture() {
  const queries = []; const statusQueries = []; const hooks = {};
  const docs = [
    homework('done', { title: '课堂 已完成' }), homework('first', { title: '课堂 待做' }),
    homework('second', { title: '课堂 待做', endAt: new Date('2026-10-23T12:00:00Z'), penaltySince: new Date('2026-10-23T12:00:00Z') }),
    homework('other', { assign: ['其他班'] }), homework('wrong-domain', { domainId: 'other' }),
    homework('empty', { pids: [], title: '空作业' }),
  ];
  const statuses = [{ docId: 'done', uid: 17, domainId: 'current', detail: { 1: { status: 1 }, 2: { status: 1 } } },
    { docId: 'first', uid: 99, domainId: 'current', detail: { 1: { status: 1 }, 2: { status: 1 } } }];
  class ForbiddenError extends Error {}
  class ValidationError extends Error {}
  const cursor = (items, record) => ({
    project(fields) { record.projection = fields; return this; },
    sort(order) { record.order = order; return this; },
    toArray: async () => items,
  });
  const hydro = {
    Handler: class {}, ObjectId: class {}, Context: class {}, ContestAlreadyAttendedError: class extends Error {},
    ForbiddenError, ValidationError, param: () => () => {}, Types: {}, PERM: { PERM_VIEW_HOMEWORK: 1n },
    PRIV: {}, ProblemModel: {}, STATUS: { STATUS_ACCEPTED: 1 },
    ContestModel: {
      getMulti(domainId, query) {
        const record = { domainId, query }; queries.push(record);
        return cursor(docs.filter((doc) => doc.domainId === domainId && doc.rule === query.rule
          && (!query.assign || doc.assign.some((group) => query.assign.$in.includes(group)))
          && (!query.title || query.title.$regex.test(doc.title))
          && (!query.docId || query.docId.$in.includes(doc.docId))), record);
      },
      getMultiStatus(domainId, query) {
        const record = { domainId, query }; statusQueries.push(record);
        return cursor(statuses.filter((status) => status.domainId === domainId && status.uid === query.uid && query.docId.$in.includes(status.docId)), record);
      },
    },
  };
  const adapter = load('handler/homework-access.ts', { hydrooj: hydro,
    '../model/education-auth': { isEducationCoach: (user) => user.role === 'coach' },
    '../model/education': { listClassGroups: async () => [{ name: '基础班', uids: [17] }, { name: '其他班', uids: [18] }],
      educationRosterColl: { find: () => ({ toArray: async () => [] }) } },
    '../model/homework-catalog': catalog, './enrollment': { enforceEnrollment: async () => {} } });
  adapter.apply({ on: (event, fn) => { hooks[event] = fn; } });
  const handler = (role = 'default') => {
    const h = { constructor: { name: 'HomeworkMainHandler' }, user: { _id: 17, role }, domain: { _id: 'current' },
      response: { addHeader() {} }, checkPerm(value) { assert.equal(value, 1n); },
      ctx: { setting: { get: () => 1 } }, url: (_, args) => `/homework/${args.tid}`,
      paginate: async (queryCursor) => [(await queryCursor.toArray()).slice(0, 1), 6] };
    hooks['handler/before/HomeworkMain#get'](h);
    return h;
  };
  return { adapter, queries, statusQueries, handler, ForbiddenError, ValidationError, docs };
}
test('student catalog scopes both reads to current domain/classes and only the requesting student status', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = adapterFixture();
  const query = f.adapter.homeworkQuery({ _id: 17 }, ['基础班'], '', '课堂');
  const [docs, pages, count] = await f.adapter.studentHomeworkPage('current', 17, query, 1, 1, 'unfinished');
  assert.deepEqual(docs.map((doc) => doc.docId), ['first']);
  assert.equal(docs[0].educationProgress.completed, 0, 'Other student AC must not leak');
  assert.equal(pages, 2); assert.equal(count, 2);
  assert.equal(f.queries.length, 2);
  for (const item of f.queries) {
    assert.equal(item.domainId, 'current');
    assert.deepEqual(item.query.assign, { $in: ['基础班'] });
    assert.equal(item.query.title.$regex.source, '课堂');
  }
  assert.deepEqual(f.queries[0].projection, { docId: 1, pids: 1, beginAt: 1, endAt: 1, penaltySince: 1 });
  assert.equal(f.statusQueries.length, 1);
  assert.equal(f.statusQueries[0].domainId, 'current');
  assert.equal(f.statusQueries[0].query.uid, 17);
  assert.deepEqual(f.statusQueries[0].query.docId.$in, ['done', 'first', 'second']);
  assert.deepEqual(f.statusQueries[0].projection, { docId: 1, detail: 1 });
  const [page2] = await f.adapter.studentHomeworkPage('current', 17, query, 2, 1, 'unfinished');
  assert.deepEqual(page2.map((doc) => doc.docId), ['second']);
  const [completed, completedPages] = await f.adapter.studentHomeworkPage('current', 17, query, 1, 1, 'completed');
  assert.deepEqual(completed.map((doc) => doc.docId), ['done']);
  assert.equal(completedPages, 1);
});
test('student catalog ordering follows the controlled clock rather than the machine date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const [date, expected] of [
    ['2026-10-20T12:00:00Z', ['first', 'second']],
    ['2026-10-23T00:00:00Z', ['second', 'first']],
    ['2030-01-01T00:00:00Z', ['first', 'second']],
  ]) {
    t.mock.timers.setTime(new Date(date).getTime());
    const f = adapterFixture();
    const query = f.adapter.homeworkQuery({ _id: 17 }, ['基础班'], '', '课堂');
    const [docs, pages, count] = await f.adapter.studentHomeworkPage('current', 17, query, 1, 20, 'unfinished');
    assert.deepEqual(docs.map((doc) => doc.docId), expected, date);
    assert.equal(pages, 1); assert.equal(count, 2);
    assert.equal(docs.find((doc) => doc.docId === 'first').educationProgress.completed, 0,
      'Changing the clock must not expose another student\'s scores');
  }
});
test('empty/inaccessible student lists never read user scores and out-of-range pages are empty', async () => {
  const f = adapterFixture();
  const [empty, pages] = await f.adapter.studentHomeworkPage('current', 0,
    f.adapter.homeworkQuery({ _id: 0 }, []), 1, 20, 'all');
  assert.deepEqual(empty, []); assert.equal(pages, 0);
  assert.equal(f.statusQueries.length, 0);
  const [past] = await f.adapter.studentHomeworkPage('current', 17,
    f.adapter.homeworkQuery({ _id: 17 }, ['基础班']), 100, 20, 'all');
  assert.deepEqual(past, []);
});
test('teacher list keeps native pagination and never presents a personal completion filter', async () => {
  const f = adapterFixture(); const h = f.handler('coach');
  await h.get('current', '', 1, '', 'completed');
  assert.equal(f.statusQueries.length, 0);
  assert.deepEqual(f.queries[0].query, { rule: 'homework' });
  assert.equal(h.response.body.educationIsCoach, true);
  assert.equal(h.response.body.progress, 'all');
  assert.equal(h.response.body.tdocs[0].educationProgress, undefined);
  assert.equal(h.response.body.tpcount, 6);
  assert.equal(f.queries[0].projection, undefined);
});
test('handler rejects invalid filters and forbidden class scopes rather than expanding visibility', async () => {
  const f = adapterFixture();
  await assert.rejects(f.handler().get('current', '', 1, '', 'wrong'), f.ValidationError);
  await assert.rejects(f.handler().get('current', '其他班', 1, '', 'all'), f.ForbiddenError);
  assert.equal(f.queries.length, 0);
});

class TemplateLoader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new TemplateLoader(path.join(root, 'templates')), { autoescape: true });
const templateState = (extra = {}) => ({
  tdocs: [catalog.annotateHomeworkProgress(homework('one'), { detail: { 1: { status: 1 } } }, now)],
  q: '', group: '', groups: ['基础班'], progress: 'unfinished', page: 1, tpcount: 2, educationIsCoach: false,
  handler: { user: { hasPerm: () => false } }, perm: {}, model: { contest: { isDone: () => false, isNotStarted: () => false } },
  datetimeSpan: () => '<time>2026-10-22 20:00</time>', url: (name) => `/${name}`,
  utils: { buildQueryString: (args) => new URLSearchParams(Object.entries(args).filter(([key]) => key !== '__keywords')).toString() },
  paginator: { render: (_, __, args) => `pagination:${args.add_qs}` }, ...extra,
});
test('student cards separate timing and completion, preserve filters, and escape all user text', () => {
  const evil = '\"><script>alert(1)</script>';
  const html = env.render('homework_main.html', templateState({ q: evil, group: evil, groups: [evil],
    oi33RecentLearningNotice: evil, tdocs: [catalog.annotateHomeworkProgress(homework('one', { title: evil, assign: [evil] }),
      { detail: { 1: { status: 1 } } }, now)] }));
  assert.match(html, /个人完成情况/);
  assert.match(html, /已通过 <strong>1\/2<\/strong> 题/);
  assert.match(html, /aria-valuenow="1"/);
  assert.match(html, /width: 50%/);
  assert.match(html, /进行中/); assert.match(html, /未完成/);
  assert.match(html, /name="progress" value="unfinished"/);
  assert.match(html, /progress=unfinished/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  const coach = env.render('homework_main.html', templateState({ educationIsCoach: true }));
  assert.doesNotMatch(coach, /个人完成情况|按完成情况筛选|已通过/);
  assert.match(env.render('homework_main.html', templateState({ tdocs: [], progress: 'completed' })), /还没有已完成的作业/);
  assert.match(env.render('homework_main.html', templateState({ tdocs: [], progress: 'unfinished' })), /暂时没有未完成的作业/);
});
test('long-term cards display the accurate deadline on hover, and zero-problem cards are not completed', () => {
  const doc = catalog.annotateHomeworkProgress(homework('zero', { pids: [],
    endAt: new Date('2099-12-31T16:00:00Z'), penaltySince: new Date('2099-12-31T16:00:00Z') }), undefined, now);
  doc.educationDeadlineLabel = catalog.homeworkDeadlineLabel(doc);
  const html = env.render('homework_main.html', templateState({ tdocs: [doc] }));
  assert.match(html, /title="2100\/01\/01 00:00（北京时间）">长期开放/);
  assert.match(html, /待布置题目/);
  assert.match(html, /已通过 <strong>0\/0<\/strong> 题/);
  assert.doesNotMatch(html, /oi33-homework-progress is-complete/);
});
if (process.env.OI33_LAYOUT_TEST === '1') test('student progress and filters fit desktop layouts in light and dark themes with native navigation', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://homework.test/**', (route) => route.fulfill({ contentType: 'text/html', body: 'navigation' }));
    const nativeCss = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
    const customCss = ['frontend/oi33-design-system.css', 'frontend/training-contest.css', 'frontend/homework-main.css']
      .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    for (const dark of [false, true]) for (const width of [1024, 1440]) for (const css of [nativeCss + customCss, customCss + nativeCss]) {
      await page.setViewportSize({ width, height: 1000 });
      const html = env.render('homework_main.html', templateState({
        q: '课堂', group: '基础班', oi33RecentLearningNotice: '上次练习已不可访问，请重新选择。',
      }));
      await page.setContent(`<html class="page--homework_main${dark ? ' theme--dark' : ''}"><head><base href="https://homework.test/"><style>${css}</style></head><body>${html}</body></html>`);
      const geometry = await page.evaluate(() => {
        const bounds = (element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const color = (element) => ({ text: getComputedStyle(element).color, bg: getComputedStyle(element).backgroundColor });
        return {
          scroll: document.documentElement.scrollWidth, toolbar: bounds(document.querySelector('.oi33-homework-toolbar')),
          inputs: [...document.querySelectorAll('.oi33-homework-search input:not([type=hidden]), .oi33-homework-search select, .oi33-homework-search button')].map(bounds),
          tabs: [...document.querySelectorAll('.oi33-homework-progress-filter a')].map(bounds),
          card: bounds(document.querySelector('.oi33-homework-card')),
          track: bounds(document.querySelector('.oi33-homework-progress__track')),
          fill: bounds(document.querySelector('.oi33-homework-progress__track > span')),
          label: color(document.querySelector('.oi33-homework-progress__label')),
          cardColors: color(document.querySelector('.oi33-homework-card')),
        };
      });
      assert.ok(geometry.scroll <= width + 1);
      assert.ok(geometry.toolbar.height <= 80);
      assert.equal(geometry.inputs.length, 3);
      for (const control of geometry.inputs) {
        assert.ok(Math.abs(control.y - geometry.inputs[0].y) < 1);
        assert.ok(control.right <= width + 1 && control.x >= 0 && control.height >= 40);
      }
      for (const tab of geometry.tabs) assert.ok(tab.height >= 40 && tab.right <= width + 1);
      assert.ok(geometry.track.x >= geometry.card.x && geometry.track.right <= geometry.card.right);
      assert.ok(Math.abs(geometry.fill.width * 2 - geometry.track.width) < 2);
      assert.notEqual(geometry.label.text, geometry.cardColors.bg, 'Progress label must be readable');
      const selected = page.locator('.oi33-homework-progress-filter a[aria-current=page]');
      assert.equal(await selected.textContent(), '未完成');
      await selected.focus();
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
      const target = new URL(page.url());
      assert.equal(target.searchParams.get('q'), '课堂');
      assert.equal(target.searchParams.get('group'), '基础班');
      assert.equal(target.searchParams.get('progress'), 'unfinished');
      assert.equal(target.searchParams.has('page'), false, 'Switching filter resets pagination');
    }
  } finally { await browser.close(); }
});
