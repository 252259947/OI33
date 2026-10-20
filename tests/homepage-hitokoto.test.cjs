const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'node_modules/@hydrooj/ui-default');
const labels = {
  Contest: '比赛', Homework: '作业', Training: '训练', Discussion: '讨论',
  'Daily Fortune': '今日运势', Ranking: '排名', Hitokoto: '一言',
  'Login to draw': '登录后抽取', 'Draw Today Fortune': '抽取今日运势',
};
const hitokotoTemplate = 'partials/homepage/hitokoto.html';
const part = (name, data) => [name, data];
const contest = part('contest', [[{
  docId: 'contest-fixture', title: '比赛 fixture', rule: 'ioi',
  beginAt: '2026-10-20 09:00', endAt: '2026-10-20 10:00', attend: 1,
}], {}]);
const homework = part('homework', [[], {}]);
const training = part('training', [[{
  docId: 'training-fixture', title: '训练 fixture', content: '练习说明', dag: [],
}], { 'training-fixture': {} }]);
const discussion = part('discussion', [[{ title: '讨论 fixture' }], {}]);
const fortune = part('checkin', { oi33_checkin_flag: 1 });
const ranking = part('ranking', [42]);

// Exercise the actual homepage and section templates. Only the outer layout,
// reusable display macros and discussion-list data rendering are fixture seams.
function fixture({ loggedIn = true, hitokotoPresent = true } = {}) {
  const loaded = [];
  const checked = [];
  class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
      loaded.push(name);
      if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
      if (name === 'components/user.html') return {
        src: '{% macro render_inline(user) %}<a href="/user/{{ user._id }}">{{ user.uname }}</a>{% endmacro %}', path: name,
      };
      if (name === 'components/contest.html') return {
        src: '{% macro render_time(time) %}{{ time }}{% endmacro %}{% macro render_duration(doc) %}1{% endmacro %}', path: name,
      };
      if (name === 'components/problem.html') return { src: '', path: name };
      if (name === 'partials/discussion_list.html') return { src: '<p>讨论 fixture</p>', path: name };
      if (name === hitokotoTemplate && !hitokotoPresent) throw new Error('Removed hitokoto must not be loaded');
      return super.getSource(name);
    }
  }
  const env = new nunjucks.Environment(new Loader([path.join(root, 'templates'), path.join(ui, 'templates')]), { autoescape: true });
  env.addFilter('markdownInline', (text) => text);
  const state = {
    handler: { csrfToken: 'fixture-csrf', user: {
      _id: loggedIn ? 42 : 0, uname: 'fixture-student',
      hasPriv: () => loggedIn, hasPerm: (permission) => (1n & permission) === permission,
    } },
    UserContext: { _id: loggedIn ? 42 : 0 },
    PRIV: { PRIV_USER_PROFILE: 'profile' }, perm: { PERM_VIEW_HOMEWORK: 1n },
    udict: { 42: { _id: 42, uname: 'fixture-student', rp: 100, bio_visible: false } },
    model: {
      contest: { isOngoing: () => false, isDone: () => true, RULES: { ioi: { TEXT: 'IOI' } } },
      training: { getPids: () => [] },
    },
    _: (name) => name.includes('{0}') ? { format: (value) => name.replace('{0}', String(value)) } : labels[name] || name,
    url: (name, args = {}) => `/${name}${args.tid ? `/${args.tid}` : ''}`,
    templateExists: (name) => {
      checked.push(name);
      return (name !== hitokotoTemplate || hitokotoPresent)
        && [path.join(root, 'templates'), path.join(ui, 'templates')].some((dir) => fs.existsSync(path.join(dir, name)));
    },
    contents: [],
  };
  return { env, state, loaded, checked, render: (contents) => env.render('main.html', { ...state, contents }) };
}

function titles(html) {
  return [...html.matchAll(/<h1 class="section__title"[^>]*>([^<]+)<\/h1>/g)].map((match) => match[1].trim());
}

for (const loggedIn of [false, true]) {
  for (const enabled of [false, true]) {
    test(`legacy hitokoto=${enabled} is absent for ${loggedIn ? 'student' : 'anonymous'} while other sections keep their order`, () => {
      const f = fixture({ loggedIn });
      const html = f.render([
        { width: 9, sections: [contest, homework, training, discussion] },
        { width: 3, sections: [fortune, part('hitokoto', enabled), ranking] },
      ]);
      assert.deepEqual(titles(html), ['比赛', '作业', '训练', '讨论', '今日运势', '排名']);
      assert.doesNotMatch(html, /hitokoto|一言|Template .* not found/);
      assert.equal(f.loaded.includes(hitokotoTemplate), false, 'The unused card template must not be loaded');
      assert.equal(f.checked.includes(hitokotoTemplate), false, 'The hidden section must not enter missing-template handling');
      assert.match(html, /class="large-9 columns oi33-home__column"/);
      assert.match(html, /class="large-3 columns oi33-home__column"/);
      assert.match(html, /href="\/ranking"/);
      if (loggedIn) {
        assert.match(html, /action="\/oi33\/checkin"/);
        assert.match(html, /name="csrfToken" value="fixture-csrf"/);
      } else {
        assert.match(html, /登录后抽取/);
        assert.doesNotMatch(html, /action="\/oi33\/checkin"/);
      }
    });
  }
}

test('all duplicate hitokoto entries are skipped across columns even when its template is unavailable', () => {
  for (const loggedIn of [false, true]) {
    const f = fixture({ loggedIn, hitokotoPresent: false });
    const contents = [
      { width: 6, sections: [part('hitokoto', true), contest, part('hitokoto', false), homework, training] },
      { width: 3, sections: [fortune, part('hitokoto', {}), ranking, part('hitokoto', true)] },
      { width: 3, sections: [part('hitokoto', true), discussion, part('hitokoto', false)] },
    ];
    const snapshot = JSON.stringify(contents);
    const html = f.render(contents);
    assert.deepEqual(titles(html), ['比赛', '作业', '训练', '今日运势', '排名', '讨论']);
    assert.doesNotMatch(html, /hitokoto|一言|Template .* not found/);
    assert.equal(f.loaded.includes(hitokotoTemplate), false);
    assert.equal(f.checked.includes(hitokotoTemplate), false);
    assert.equal(JSON.stringify(contents), snapshot, 'Rendering must not mutate stored legacy configuration');
  }
});

test('the fixture actually supports the original hitokoto card as a positive control', () => {
  const f = fixture();
  const html = f.env.render(hitokotoTemplate, f.state);
  assert.deepEqual(titles(html), ['一言']);
  assert.match(html, /name="hitokoto"/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real Chrome and shipped hitokoto script issue no request without a container', async () => {
  const { chromium } = require('playwright');
  // Exact jQuery shipped in Hydro UI, extracted identically to contest-time.test.
  // This preserves real selector/collection behaviour: an empty jQuery object
  // is truthy, but .get().forEach still performs zero requests.
  const hydro = transformSync(fs.readFileSync(path.join(ui, 'public/hydro-4.58.4.js'), 'utf8'), { minify: false }).code;
  const marker = '91688(c, x) {';
  assert.ok(hydro.includes(marker), 'Recheck the shipped jQuery module when upgrading Hydro UI');
  const tail = hydro.slice(hydro.indexOf(marker) + marker.length);
  const boundary = /\n    }, \d+\(/.exec(tail);
  assert.ok(boundary, 'jQuery module boundary');
  const jquery = `(() => { const c = { exports: {} }; const x = c.exports; ${tail.slice(0, boundary.index)}; window.$ = c.exports; })();`;
  const script = transformSync(fs.readFileSync(path.join(ui, 'components/hitokoto/index.page.js'), 'utf8'), {
    loader: 'js', format: 'cjs', target: 'es2020',
  }).code;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const unexpectedNetwork = [];
    await page.route('**/*', (route) => { unexpectedNetwork.push(route.request().url()); return route.abort(); });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: jquery });
    await page.evaluate(() => {
      window.hitokotoRequests = [];
      window.hitokotoPages = [];
      window.module = { exports: {} };
      window.exports = window.module.exports;
      window.require = (name) => {
        if (name === 'jquery') return window.$;
        if (name === 'vj/misc/Page') return { NamedPage: function (name, callback) {
          window.hitokotoPages.push({ name, callback });
        } };
        if (name === 'vj/utils') return {
          request: { get: async (url) => { window.hitokotoRequests.push(url); return { hitokoto: 'fixture quote' }; } },
          i18n: (text) => text,
          tpl: (strings, ...values) => strings.reduce((result, text, index) => result + text + (values[index] ?? ''), ''),
        };
        throw new Error(`Unexpected dependency: ${name}`);
      };
    });
    await page.addScriptTag({ content: script });
    assert.deepEqual(await page.evaluate(() => window.hitokotoPages.map((entry) => entry.name)), ['homepage']);
    for (const loggedIn of [false, true]) {
      const f = fixture({ loggedIn });
      const html = f.render([{ width: 12, sections: [fortune, part('hitokoto', true), ranking, part('hitokoto', false)] }]);
      await page.evaluate((html) => {
        document.body.innerHTML = html;
        window.hitokotoPages[0].callback();
      }, html);
      assert.equal(await page.locator('[name="hitokoto"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.hitokotoRequests), []);
      assert.equal(await page.getByRole('heading', { name: '今日运势', exact: true }).count(), 1);
      assert.equal(await page.getByRole('heading', { name: '排名', exact: true }).count(), 1);
    }
    const control = fixture();
    await page.evaluate((html) => {
      document.body.innerHTML = html;
      window.hitokotoPages[0].callback();
    }, control.env.render(hitokotoTemplate, control.state));
    assert.deepEqual(await page.evaluate(() => window.hitokotoRequests), ['https://v1.hitokoto.cn?c=a&c=b&c=c&c=d&c=e&c=f']);
    assert.equal(await page.locator('[name="hitokoto"] p').textContent(), 'fixture quote');
    assert.deepEqual(unexpectedNetwork, [], 'No external service may be accessed during this test');
  } finally {
    await browser.close();
  }
});
