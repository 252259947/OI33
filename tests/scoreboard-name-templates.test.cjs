const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const core = path.join(root, 'node_modules/@hydrooj/ui-default');
const css = read('frontend/scoreboard-names.css');
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    return super.getSource(name);
  }
}
const templates = new nunjucks.Environment(new Loader([path.join(root, 'templates'), path.join(core, 'templates')]), { autoescape: true });
templates.addFilter('markdown', String);
templates.addFilter('nl2br', value => String(value).replace(/\n/g, '<br>'));
function context(names = ['李若朔']) {
  const udict = {}, rows = [[{ type: 'rank', value: '排名' }, { type: 'user', value: '用户' },
    { type: 'total_score', value: '得分' }, { type: 'record', value: 'A' }]];
  names.forEach((name, i) => {
    const uid = i + 17;
    udict[uid] = { _id: uid, uname: `student${uid}`, realname_flag: 1, level: 0, avatar: '', hasPriv: () => false, hasPerm: () => false };
    rows.push([{ type: 'rank', value: i + 1 }, { type: 'user', raw: uid, value: name, oi33RealName: name },
      { type: 'total_score', value: 100 }, { type: 'record', raw: `record${uid}`, value: '100\n00:12', score: 100 }]);
  });
  return { rows, udict, udoc: udict[17], pids: [], pdict: {}, tsdoc: { enroll: true, donePids: [] },
    tdoc: { _id: 'training-fixture', docId: 'training-fixture', title: '成绩示例', dag: [], owner: 3, attend: names.length },
    groups: [], missing: [], oi33TrainingNames: Object.fromEntries(names.map((n, i) => [i + 17, n])),
    handler: { user: { _id: 3, realname_flag: 1, hasPriv: () => true, hasPerm: () => false, own: () => true }, request: { query: { uid: '17' } } },
    PRIV: {}, perm: {}, Object, UiContext: {}, sidemenu: { render_item: () => '' },
    model: { builtin: { LEVELS: [] }, contest: { isLocked: () => false, canShowRecord: function () { return true; } },
      system: { get: () => 'https://example.invalid/' } },
    utils: { status: { getScoreColor: () => '#00aa00' } }, avatarUrl: () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    url: (name, args) => `/${name}/${args?.uid || args?.rid || args?.tid || ''}`,
    _: value => {
      const translated = new String(value === 'page.training_detail.see_other_user_detail' ? '正在查看 {0} 的训练进度' : value);
      translated.format = (...args) => translated.toString().replace(/\{(\d+)\}/g, (_, n) => args[n]);
      return translated;
    } };
}
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const inline = (ctx, args = '') => templates.renderString(`{% import "components/oi33_user.html" as user with context %}{{ user.render_inline(udoc, badge=false${args}) }}`, ctx);

test('homework and contest scoreboard names retain profile URLs, numeric UID stars and scores', () => {
  for (const type of ['homework', 'contest']) {
    const ctx = { ...context(['李若朔', '阿卜杜热合曼·阿卜杜热依木']), type };
    const html = templates.render('partials/scoreboard.html', ctx);
    assert.match(html, /class="oi33-scoreboard"/);
    assert.match(html, /李若朔/); assert.match(html, /阿卜杜热合曼·阿卜杜热依木/);
    assert.doesNotMatch(html, /student17|student18/);
    assert.match(html, /href="\/user_detail\/17"/);
    assert.match(html, /class="star user--17" data-uid="17"/);
    assert.match(html, /href="\/record_detail\/record17"/);
    assert.match(html, /100<br>00:12/);
  }
});

test('missing approved name preserves ordinary nickname or anonymous UID, never a pending name', () => {
  const ctx = context();
  ctx.rows[1][1] = { type: 'user', raw: 17, value: 'UID 17' };
  ctx.udict[17].realname_name = '待审姓名';
  ctx.udict[17].oi33_profile_hidden = true;
  assert.match(visibleText(templates.render('partials/scoreboard.html', ctx)), /UID 17/);
  assert.doesNotMatch(templates.render('partials/scoreboard.html', ctx), /待审姓名|student17/);
  // The optional macro argument cannot bypass an existing hidden-identity marker.
  assert.doesNotMatch(inline(ctx, ", display_name='不应显示'"), /不应显示/);
  delete ctx.udict[17].oi33_profile_hidden; delete ctx.udict[17].realname_flag;
  assert.match(visibleText(inline(ctx, ", display_name='不应显示'")), /UID 17/);
  ctx.udict[17].realname_flag = 1;
  assert.match(visibleText(templates.render('partials/scoreboard.html', ctx)), /student17/);
});

test('non-scoreboard macro calls keep the original nickname/admin-name behavior', () => {
  const ctx = context(); ctx.udoc.realname_name = '已批准姓名';
  assert.match(visibleText(inline(ctx)), /student17/);
  assert.doesNotMatch(inline(ctx), /已批准姓名/);
  ctx.handler.user.realname_flag = 2;
  assert.match(visibleText(inline(ctx)), /\[已批准姓名\]student17/);
  const renamed = inline(ctx, ", display_name='李若朔'");
  assert.match(visibleText(renamed), /李若朔/);
  assert.doesNotMatch(renamed, /student17|已批准姓名/);
});

test('scoreboard and HTML download escape user names without changing record rendering', () => {
  const payload = '<img src=x onerror="alert(1)">张&李';
  const ctx = context([payload]);
  for (const file of ['partials/scoreboard.html', 'contest_scoreboard_download_html.html']) {
    const html = templates.render(file, ctx);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;张&amp;李/);
    assert.doesNotMatch(html, /<img src=x|<script/);
    assert.match(html, /100<br>00:12/);
    assert.match(html, /record_detail\/record17/);
  }
  ctx.rows[1][1] = { type: 'user', raw: 17, value: '<script>legacy</script>' };
  assert.match(templates.render('contest_scoreboard_download_html.html', ctx), /&lt;script&gt;legacy&lt;\/script&gt;/);
});

test('HTML export retains native multi-record score markup and record links', () => {
  const ctx = context();
  ctx.rows[1][3] = { type: 'records', raw: [
    { raw: 'first-result', value: '80\n01:02', score: 80 },
    { raw: null, value: '20\n02:03' },
  ] };
  const native = templates.renderString(fs.readFileSync(path.join(core, 'templates/contest_scoreboard_download_html.html'), 'utf8'), ctx);
  const actual = templates.render('contest_scoreboard_download_html.html', ctx);
  const recordCell = html => html.match(/<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/)[1].match(/<td(?:\s[^>]*)?>[\s\S]*?<\/td>/g)[3];
  assert.equal(recordCell(actual), recordCell(native));
  assert.match(recordCell(actual), /first-result/);
  assert.match(recordCell(actual), /20<br>02:03/);
});

test('training member display, native name filter and comparison message use the same approved name', () => {
  const ctx = context(['李若朔', '阿卜杜热合曼·阿卜杜热依木']);
  const html = templates.render('training_detail.html', ctx);
  assert.match(html, /data-uid="17" data-uname="student17" data-displayname="李若朔"/);
  assert.match(html, /href="\.\/training-fixture\?uid=17"/);
  assert.match(html, /<span>李若朔<\/span>/);
  assert.match(html, /正在查看 李若朔 的训练进度/);
  assert.doesNotMatch(html, /<span>student17<\/span>/);
  const partial = templates.render('partials/training_detail.html', ctx);
  assert.match(partial, /正在查看 李若朔 的训练进度/);
  const exported = templates.render('contest_scoreboard_download_html.html', ctx);
  assert.match(exported, /李若朔/);
});

test('training names and search attributes are escaped, absent names preserve native anonymous fallback', () => {
  const payload = '"><img src=x onerror=alert(1)>张&李';
  const ctx = context([payload]);
  let html = templates.render('training_detail.html', ctx);
  assert.match(html, /data-displayname="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;张&amp;李"/);
  assert.match(html, /正在查看 &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;张&amp;李 的训练进度/);
  assert.doesNotMatch(html, /<img src=x/);
  ctx.oi33TrainingNames = {}; ctx.udict[17].uname = 'UID 17'; ctx.udict[17].oi33_profile_hidden = true;
  html = templates.render('training_detail.html', ctx);
  assert.match(html, /<span>UID 17<\/span>/); assert.match(html, /正在查看 UID 17 的训练进度/);
  assert.doesNotMatch(html, /data-displayname=/);
  delete ctx.oi33TrainingNames;
  assert.match(templates.render('training_detail.html', ctx), /正在查看 UID 17 的训练进度/);
});

test('full-name CSS is limited to scoreboards and training member lists', () => {
  assert.match(read('frontend/training-contest.page.ts'), /import '\.\/scoreboard-names\.css'/);
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*\}/g)) {
    for (const selector of rule[1].split(',')) assert.match(selector.trim(), /^\.oi33-(scoreboard|training-member-list) /);
  }
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /text-overflow: clip/);
  assert.doesNotThrow(() => require('esbuild').transformSync(css, { loader: 'css' }));
});

if (process.env.OI33_LAYOUT_TEST === '1') test('Chrome keeps long names readable in light/dark scoreboards and training lists', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const ctx = context(['李若朔', '阿卜杜热合曼·阿卜杜热依木·额外长姓名测试']);
    const theme = fs.readFileSync(path.join(core, 'public/theme-4.58.4.css'), 'utf8');
    const design = read('frontend/oi33-design-system.css') + read('frontend/training-contest.css');
    const board = templates.render('partials/scoreboard.html', ctx);
    const training = templates.render('training_detail.html', ctx);
    for (const type of ['contest_scoreboard', 'homework_scoreboard', 'training_detail']) {
      for (const dark of [false, true]) {
        for (const sheet of [theme + design + css, css + design + theme]) {
          await page.setContent(`<html class="page--${type} ${dark ? 'theme--dark' : ''}"><head><style>${sheet}</style></head><body><div class="main">${type === 'training_detail' ? training : board}</div></body></html>`);
          const selector = type === 'training_detail' ? '.oi33-training-member-list a > span' : '.oi33-scoreboard td.col--user .user-profile-name';
          const states = await page.locator(selector).evaluateAll(els => els.map(el => {
            const s = getComputedStyle(el), p = el.closest('td') || el.parentElement;
            return { text: el.textContent.trim(), wrap: s.whiteSpace, ellipsis: s.textOverflow,
              available: p.clientWidth, content: p.scrollWidth, height: el.getBoundingClientRect().height };
          }));
          assert.equal(states.length, 2);
          assert.ok(states[1].text.endsWith('额外长姓名测试'));
          for (const state of states) {
            assert.equal(state.wrap, 'normal'); assert.notEqual(state.ellipsis, 'ellipsis');
            assert.ok(state.content <= state.available + 2, JSON.stringify(state));
            assert.ok(state.height > 0);
          }
        }
      }
    }
  } finally { await browser.close(); }
});
