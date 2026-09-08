const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
const encode = (value) => nunjucks.runtime.suppressValue(value, true);
function state(options = {}) {
  const now = Date.now();
  const defaults = {
    tdocs: [{ docId: 'one', title: '基础练习', pids: [1, 2], assign: ['基础班'], beginAt: now - 1000, penaltySince: now + 100000, endAt: now + 100000, attend: 3 },
      { docId: 'two', title: '下一次作业', pids: [], assign: [], beginAt: now + 100000, penaltySince: now + 200000, endAt: now + 200000 },
      { docId: 'three', title: '已结束作业', pids: [1], assign: ['提高班'], beginAt: now - 200000, penaltySince: now - 100000, endAt: now - 100000 }],
    q: '', group: '', groups: ['基础班', '提高班'], page: 1, tpcount: 1, educationIsCoach: false,
    handler: { user: { hasPriv: (value) => value === 1, hasPerm: (value) => (1n & value) === value } },
    PRIV: { PRIV_USER_PROFILE: 1 }, perm: { PERM_CREATE_HOMEWORK: 1n },
    model: { contest: { isDone: (doc) => doc.endAt < now, isNotStarted: (doc) => doc.beginAt > now,
      statusText: (doc) => doc.endAt < now ? '已结束' : doc.beginAt > now ? '未开始' : '进行中' } },
    _: (value) => value,
    datetimeSpan: (value, relative, format) => {
      assert.equal(relative, false); assert.equal(format, 'YYYY-MM-DD HH:mm');
      return `<time>${new Date(value).toISOString().slice(0, 16).replace('T', ' ')}</time>`;
    },
    url: (name, args = {}) => name === 'homework_detail' ? `/homework/${encode(args.tid)}` : `/${name}`,
    utils: { buildQueryString: (args) => new URLSearchParams(Object.entries(args).filter(([name]) => name !== '__keywords')).toString() },
    paginator: { render: (page, count, args) => new nunjucks.runtime.SafeString(`<a class="pager-test" href="?page=2&amp;${encode(args.add_qs)}">2 / ${count}</a>`) },
  };
  return { ...defaults, ...options };
}
const render = (options) => env.render('homework_main.html', state(options));
test('cards expose one complete native link per homework, metadata and states', () => {
  const html = render();
  const cards = [...html.matchAll(/<a class="oi33-homework-card[^]*?<\/a>/g)].map((item) => item[0]);
  assert.equal(cards.length, 3);
  for (const card of cards) {
    assert.equal((card.match(/<a\b/g) || []).length, 1);
    assert.doesNotMatch(card, /<button\b/);
    assert.match(card, /<h2 id="oi33-homework-name-/);
    assert.match(card, /oi33-homework-card__meta/);
  }
  assert.match(html, /href="\/homework\/one"/);
  for (const value of ['2 道题', '0 道题', '基础班', '不限班型', '开始', '截止', '3 人已领取', 'is-active', 'is-upcoming', 'is-done']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /未领取|延期期限|oi33-homework-card__claimed/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'templates/homework_main.html'), 'utf8'), /\btsdict\b/);
});
test('coach creation requires both teaching identity and real bigint permission', () => {
  assert.doesNotMatch(render(), /href="\/homework_create"|href="\/oi33_education_classes"/);
  assert.match(render({ educationIsCoach: true }), /href="\/homework_create"/);
  const noPermission = state().handler;
  noPermission.user.hasPerm = (permission) => (0n & permission) === permission;
  const coach = render({ educationIsCoach: true, handler: noPermission });
  assert.doesNotMatch(coach, /href="\/homework_create"/);
  assert.match(coach, /href="\/oi33_education_classes"/);
  const guest = state().handler; guest.user.hasPriv = () => false;
  assert.doesNotMatch(render({ handler: guest }), /href="\/oi33_education_tasks"/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'templates/homework_main.html'), 'utf8'), /\bPERM\./);
});
test('filter state, pagination, title and class names are safely escaped', () => {
  const evil = '\"><script>alert(1)</script>';
  const doc = state().tdocs[0];
  const html = render({ q: evil, group: '基础 & A', groups: ['基础 & A', evil], tpcount: 3,
    tdocs: [{ ...doc, title: evil, assign: [evil] }] });
  assert.doesNotMatch(html, /<script>|<img\b/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /value="基础 &amp; A" selected/);
  assert.match(html, /aria-label="作业分页"/);
  assert.ok(html.includes(new URLSearchParams({ q: evil, group: '基础 & A' }).toString().replaceAll('&', '&amp;')));
});
test('unfiltered, filtered and coach empty states stay useful and single-page lists hide pagination', () => {
  assert.match(render({ tdocs: [] }), /暂时没有可查看的作业/);
  assert.match(render({ tdocs: [], q: '不存在' }), /没有找到匹配的作业/);
  assert.match(render({ tdocs: [], group: '基础班' }), /清除筛选/);
  assert.match(render({ tdocs: [], educationIsCoach: true }), /href="\/homework_create"/);
  assert.doesNotMatch(render(), /aria-label="作业分页"/);
});
test('stylesheet is eagerly imported with the shared training styles, independent of page/PJAX callbacks', () => {
  const entry = fs.readFileSync(path.join(root, 'frontend/training-contest.page.ts'), 'utf8');
  assert.match(entry, /import '\.\/training-contest\.css'/);
  assert.match(entry, /import '\.\/homework-main\.css'/);
});
if (process.env.OI33_LAYOUT_TEST === '1') test('one-column cards, controls and full-card hit area fit desktop and narrow mobile widths', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const css = ['node_modules/@hydrooj/ui-default/public/theme-4.58.4.css', 'frontend/oi33-design-system.css', 'frontend/training-contest.css', 'frontend/homework-main.css']
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
    const docs = state().tdocs; docs[0].title = '长标题与连续字符的换行验证' + 'VeryLongHomeworkTitle'.repeat(15); docs[0].assign = ['基础班', 'LongClassName'.repeat(15)];
    for (const width of [1920, 1280, 1060, 900, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(`<html><head><style>${css}</style></head><body>${render({ tdocs: docs, educationIsCoach: true, tpcount: 3 })}</body></html>`);
      const bounds = await page.evaluate(() => {
        const box = (element) => Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom'].map((name) => [name, element.getBoundingClientRect()[name]]));
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          cards: [...document.querySelectorAll('a.oi33-homework-card')].map(box),
          controls: [...document.querySelectorAll('.oi33-homework-search input, .oi33-homework-search select, .oi33-homework-search button, .oi33-homework-actions a')].map(box) };
      });
      assert.ok(bounds.scrollWidth <= width + 1, JSON.stringify({ width, bounds }));
      for (let i = 0; i < bounds.cards.length; i++) {
        const card = bounds.cards[i];
        assert.ok(card.x >= -1 && card.right <= width + 1);
        assert.equal(card.width, bounds.cards[0].width);
        if (i) assert.ok(card.y >= bounds.cards[i - 1].bottom, 'Cards must never share a row');
      }
      for (const control of bounds.controls) assert.ok(control.x >= -1 && control.right <= width + 1 && control.height >= 40, JSON.stringify({ width, control }));
      await page.locator('a.oi33-homework-card').first().scrollIntoViewIfNeeded();
      assert.equal(await page.locator('a.oi33-homework-card').first().evaluate((card) => {
        const rect = card.getBoundingClientRect();
        return document.elementFromPoint(rect.right - 12, Math.min(innerHeight - 12, rect.bottom - 12))?.closest('a') === card;
      }), true, `Blank card area is a native link at width ${width}`);
    }
  } finally { await browser.close(); }
});
