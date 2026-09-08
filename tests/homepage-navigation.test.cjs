const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const compiled = transformSync(fs.readFileSync(path.join(root, 'handler/homepage.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node18',
}).code;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { withHomeworkSection, addHomepageHomework, apply } = loaded.exports;

const order = ['homepage', 'problem_main', 'homework_main', 'training_main', 'contest_main', 'discussion_main', 'record_main', 'ranking'];
const labels = ['首页', '题库', '作业', '训练', '比赛', '讨论', '测评记录', '排名'];
const names = Object.fromEntries(order.map((name, i) => [name, labels[i]]));
const nodes = order.map((name) => ({
  name, checker: () => true, args: { prefix: name.split('_')[0] },
}));

class FixtureLoader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    if (name.startsWith('components/')) return { src: '', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new FixtureLoader(path.join(root, 'templates')), { autoescape: true });
function context({ loggedIn = true, hidden = false, denied = [], canViewHomework = true } = {}) {
  const navNodes = [...nodes].reverse().map((item) => ({ ...item, checker: () => !denied.includes(item.name) }));
  navNodes.push({ name: 'oi33_admin_accounts', checker: () => loggedIn, args: {} });
  return {
    page_name: 'homework_main',
    handler: { user: {
      _id: 42, uname: 'student', avatar: '', oi33_profile_hidden: hidden,
      hasPriv: (priv) => loggedIn && priv === 'profile',
      hasPerm: () => canViewHomework,
    } },
    PRIV: { PRIV_USER_PROFILE: 'profile' },
    PERM: { PERM_VIEW_HOMEWORK: 'homework' },
    ui: { getNodes: (kind) => kind === 'Nav' ? navNodes : [] },
    model: {
      system: { get: () => true },
      setting: { SETTINGS_BY_KEY: { viewLang: { range: { zh: '中文' } } } },
      contest: { statusText: () => '进行中', isExtended: () => false, isDone: () => false },
    },
    _: (name) => names[name] || ({ Homework: '作业' }[name]) || name,
    typeof: (value) => typeof value,
    avatarUrl: () => '/avatar.png',
    datetimeSpan: (value) => String(value),
    url: (name, ...args) => {
      const keywords = args.find((arg) => arg && arg.__keywords) || {};
      const query = keywords.query || {};
      return `/${name}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
    },
    contents: [],
  };
}

function primaryLinks(html) {
  const main = html.match(/<ol class="nav__list oi33-nav__main clearfix">([\s\S]*?)<\/ol>/)[1];
  return [...main.matchAll(/<a\s+href="([^"?]+)(?:[^"\n]*)"[^>]*>\s*([^<]+)\s*<\/a>/g)]
    .map((match) => [match[1].slice(1), match[2].trim()]);
}

test('navigation stays in requested order despite reversed node registration', () => {
  const html = env.render('partials/nav.html', context());
  assert.deepEqual(primaryLinks(html), order.map((name, i) => [name, labels[i]]));
  assert.doesNotMatch(html, /class="[^"]*nav__list--main/);
  assert.doesNotMatch(html, /id="menu-nav-more"/);
  assert.match(html, /href="\/record_main\?uidOrName=student"/);
  assert.match(html, /href="\/oi33_admin_accounts"/);
  assert.match(html, /aria-current="page"/);
});

test('permission checkers and anonymous personal-record filtering survive', () => {
  const hidden = env.render('partials/nav.html', context({ hidden: true, denied: ['ranking'] }));
  assert.deepEqual(primaryLinks(hidden).map(([name]) => name), order.filter((name) => name !== 'ranking'));
  assert.match(hidden, /href="\/record_main\?uidOrName=42"/);
  const guest = env.render('partials/nav.html', context({ loggedIn: false, denied: ['record_main'] }));
  assert.deepEqual(primaryLinks(guest).map(([name]) => name), order.filter((name) => name !== 'record_main'));
  assert.doesNotMatch(guest, /uidOrName=/);
  assert.match(guest, /name="nav_login"/);
});

test('only the quick training entry changes; hero keeps its training action', () => {
  const html = env.render('main.html', context());
  const quick = html.match(/<nav class="oi33-home__quick"[\s\S]*?<\/nav>/)[0];
  assert.equal((quick.match(/class="oi33-quick-card"/g) || []).length, 4);
  assert.match(quick, /href="\/homework_main"/);
  assert.match(quick, /icon-calendar/);
  assert.doesNotMatch(quick, /training_main/);
  assert.match(html, /href="\/training_main">继续训练/);
});

test('homework inserts between contest and training without changing original contents', () => {
  const original = [
    { width: 9, sections: [['contest', []], ['training', []], ['discussion', []]] },
    { width: 3, sections: [['ranking', []]] },
  ];
  const snapshot = JSON.stringify(original);
  const payload = [[{ title: 'Homework' }], {}];
  const next = withHomeworkSection(original, payload);
  assert.deepEqual(next[0].sections.map(([name]) => name), ['contest', 'homework', 'training', 'discussion']);
  assert.equal(next[0].sections[1][1], payload);
  assert.deepEqual(next.map((column) => column.width), [9, 3]);
  assert.equal(JSON.stringify(original), snapshot);
});

test('existing homework sections are moved and deduplicated across columns', () => {
  const original = [
    { width: 9, sections: [['homework', 1], ['contest', []], ['training', []]] },
    { width: 3, sections: [['homework', 2], ['ranking', []]] },
  ];
  const next = withHomeworkSection(original, 3);
  assert.deepEqual(next[0].sections.map(([name]) => name), ['contest', 'homework', 'training']);
  assert.deepEqual(next[1].sections.map(([name]) => name), ['ranking']);
  assert.equal(next[0].sections[1][1], 3);
});

test('layouts without contest or without any columns still get one homework section', () => {
  const next = withHomeworkSection([{ width: 12, sections: [['training', []]] }], [[], {}]);
  assert.deepEqual(next[0].sections.map(([name]) => name), ['homework', 'training']);
  assert.deepEqual(withHomeworkSection([], [[], {}]), [{ width: 12, sections: [['homework', [[], {}]]] }]);
});

test('homepage hook fetches permission-filtered data once and reuses existing data', async () => {
  let calls = 0;
  const handler = {
    args: { domainId: 'classroom' },
    response: { template: 'main.html', body: { contents: [{ width: 9, sections: [['contest', []], ['training', []]] }] } },
    getHomework: async (domainId) => { calls++; assert.equal(domainId, 'classroom'); return [[], {}]; },
  };
  await addHomepageHomework(handler);
  await addHomepageHomework(handler);
  assert.equal(calls, 1);
  assert.deepEqual(handler.response.body.contents[0].sections.map(([name]) => name), ['contest', 'homework', 'training']);
  handler.response.template = 'other.html';
  await addHomepageHomework(handler);
  assert.equal(calls, 1);
  let event;
  apply({ on: (name, callback) => { event = name; assert.equal(callback, addHomepageHomework); } });
  assert.equal(event, 'handler/after/Home#get');
});

test('homework data failure does not break the rest of the homepage', async () => {
  const handler = {
    args: { domainId: 'system' },
    response: { template: 'main.html', body: { contents: [{ width: 12, sections: [['training', []]] }] } },
    getHomework: async () => { throw new Error('private database error'); },
  };
  await addHomepageHomework(handler);
  const payload = handler.response.body.contents[0].sections[0][1];
  const html = env.render('partials/homepage/homework.html', { ...context(), payload });
  assert.match(html, /作业暂时加载失败/);
  assert.doesNotMatch(html, /private database error/);
});

test('homework section renders empty, denied, populated and escaped states', () => {
  const empty = env.render('partials/homepage/homework.html', { ...context(), payload: [[], {}] });
  assert.match(empty, /oi33-homework-title/);
  assert.match(empty, /暂无可查看的作业/);
  assert.match(empty, /查看全部作业/);
  const denied = env.render('partials/homepage/homework.html', { ...context({ canViewHomework: false }), payload: [[], {}] });
  assert.doesNotMatch(denied, /href="\/homework_main"/);
  const populated = env.render('partials/homepage/homework.html', {
    ...context(), payload: [[{ docId: 'one', title: '<script>alert(1)</script>', beginAt: 'begin', penaltySince: 'deadline' }], {}],
  });
  assert.match(populated, /class="homework__title"/);
  assert.match(populated, /href="\/homework_detail"/);
  assert.doesNotMatch(populated, /<script>/);
  assert.match(populated, /&lt;script&gt;/);
});

// Optional real-browser geometry check. Supply Playwright through normal Node
// resolution and OI33_LAYOUT_TEST=1; no live service or account is touched.
if (process.env.OI33_LAYOUT_TEST === '1') {
  test('desktop navigation and mobile drawer stay within their available space', async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const css = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8')
        + '\n' + fs.readFileSync(path.join(root, 'frontend/oi33-design-system.css'), 'utf8');
      for (const loggedIn of [true, false]) {
        for (const width of [1920, 1280, 1060, 900, 850, 720, 640, 601, 600, 390]) {
          await page.setViewportSize({ width, height: 960 });
          await page.setContent(`<html class="hasjs${width <= 600 ? ' slideout-open' : ''}"><head><style>${css}</style></head><body>${env.render('partials/nav.html', context({ loggedIn }))}</body></html>`);
          const geometry = await page.evaluate(() => {
            const nav = document.querySelector('.oi33-nav');
            const bounds = nav.getBoundingClientRect();
            const elements = [...document.querySelector('.oi33-nav__inner').children]
              .filter((el) => getComputedStyle(el).display !== 'none')
              .map((el) => ({ name: el.className, ...Object.fromEntries(['left', 'right', 'top', 'bottom', 'width'].map((key) => [key, el.getBoundingClientRect()[key]])) }));
            const links = [...document.querySelectorAll('.oi33-nav__main > li > a')]
              .map((el) => ({ text: el.textContent.trim(), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
            return { nav: { left: bounds.left, right: bounds.right, width: bounds.width }, elements, links };
          });
          const label = `width=${width}, loggedIn=${loggedIn}, geometry=${JSON.stringify(geometry)}`;
          assert.equal(geometry.links.length, 8, label);
          for (const link of geometry.links) {
            assert.ok(link.left >= geometry.nav.left - 1 && link.right <= geometry.nav.right + 1, label);
          }
          if (width > 600) {
            for (let i = 1; i < geometry.elements.length; i++) {
              assert.ok(geometry.elements[i].left >= geometry.elements[i - 1].right - 1, label);
            }
            assert.ok(geometry.elements.at(-1).right <= width + 1, label);
          } else {
            assert.equal(geometry.nav.width, 200, label);
            for (const element of geometry.elements) {
              assert.ok(element.left >= geometry.nav.left - 1 && element.right <= geometry.nav.right + 1, label);
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  });
}
