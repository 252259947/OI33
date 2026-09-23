const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'frontend/education.css'), 'utf8');
const darkCss = css.slice(css.indexOf('/* Keep the light palette'));

test('teaching components keep their light palette and provide both supported dark theme overrides', () => {
  assert.match(css, /\.education-members span \{ background:#f4f4fb;/);
  assert.match(css, /\.education-class-picker label:has\(input:checked\) \{ border-color:#6960ef; background:#f2f0ff;/);
  for (const selector of ['.education-members span', '.education-stats div', '.education-notice',
    '.education-class-picker label:has(input:checked)', '.education-task:hover', '.education-task:focus-visible',
    '.education-overdue']) {
    assert.ok(darkCss.includes(`:is(.theme--dark, [data-mantine-color-scheme="dark"]) ${selector}`), selector);
  }
  assert.match(darkCss, /color:var\(--oi33-text,#eef1f8\); background:var\(--oi33-surface-2,#202636\)/);
  assert.match(darkCss, /color:var\(--oi33-text,#eef1f8\); background:var\(--oi33-brand-soft,#292b55\)/);
  assert.doesNotThrow(() => require('esbuild').transformSync(css, { loader: 'css', target: 'chrome105' }));
});

if (process.env.OI33_LAYOUT_TEST === '1') test('rendered teaching labels and related fills stay readable in both themes and CSS load orders', async () => {
  const { chromium } = require('playwright');
  class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
      if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
      return super.getSource(name);
    }
  }
  const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
  const members = env.render('oi33_education_classes.html', {
    groups: [{ name: '2026级', uids: [17, 18] }, { name: '测试', uids: [3] }],
    names: { 17: '测试学生甲', 18: '测试学生乙', 3: '测试账号' }, csrfToken: 'fixture-only',
  });
  const fixture = `${members}<section class="section oi33-education"><div class="section__body">
    <div class="education-stats"><div><strong>18</strong><span>应交</span></div></div>
    <p class="education-notice">请先确认学生名单。</p>
    <div class="education-class-picker"><label><input type="checkbox" checked>2026级</label><label><input type="checkbox">2025级</label></div>
    <a class="education-task" href="#task"><div><h2>示例作业</h2><p>截止时间 · 0 / 1 题</p></div><span>进行中 <span class="education-overdue">逾期</span></span></a>
    <table class="data-table education-progress-table"><tbody><tr><th>示例学生<small>UID 17</small></th><td class="education-complete">AC</td></tr></tbody></table>
    </div></section>`;
  const theme = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/theme-4.58.4.css'), 'utf8');
  const custom = fs.readFileSync(path.join(root, 'frontend/oi33-design-system.css'), 'utf8') + '\n' + css;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    for (const [order, sheet] of [['core-first', theme + custom], ['core-last', custom + theme]]) {
      for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
        await page.setContent(`<html ${mode}><head><style>${sheet}</style></head><body>${fixture}</body></html>`);
        const inspect = async (selector) => page.locator(selector).evaluateAll((elements) => {
          const color = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
          const luminance = (rgb) => rgb.map((channel) => channel / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
          return elements.map((element) => {
            const style = getComputedStyle(element);
            let parent = element;
            while (parent.parentElement && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
            const background = getComputedStyle(parent).backgroundColor;
            const values = [luminance(color(style.color)), luminance(color(background))].sort((a, b) => a - b);
            return { foreground: style.color, background, ratio: (values[1] + .05) / (values[0] + .05) };
          });
        });
        const chips = await inspect('.education-members span');
        assert.equal(chips.length, 3);
        for (const result of chips) {
          assert.ok(result.ratio >= 4.5, JSON.stringify({ mode, order, component: 'members', ...result }));
          assert.equal(result.background, mode ? 'rgb(32, 38, 54)' : 'rgb(244, 244, 251)');
        }
        // Dark theme regressions also affect adjacent teaching controls with fixed pale fills.
        if (mode) {
          for (const selector of ['.education-stats strong', '.education-stats span', '.education-notice',
            '.education-class-picker label:has(input:checked)', '.education-progress-table small', '.education-complete', '.education-overdue']) {
            for (const result of await inspect(selector)) assert.ok(result.ratio >= 4.5, JSON.stringify({ mode, order, selector, ...result }));
          }
          await page.locator('.education-task').hover();
          for (const selector of ['.education-task h2', '.education-task p']) {
            for (const result of await inspect(selector)) assert.ok(result.ratio >= 4.5, JSON.stringify({ mode, order, selector, state: 'hover', ...result }));
          }
          await page.mouse.move(0, 0);
          await page.locator('.education-task').focus();
          for (const result of await inspect('.education-task p')) assert.ok(result.ratio >= 4.5, JSON.stringify({ mode, order, state: 'focus', ...result }));
        }
        if (process.env.OI33_THEME_SCREENSHOT_DIR && order === 'core-last' && mode !== 'data-mantine-color-scheme="dark"') {
          fs.mkdirSync(process.env.OI33_THEME_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.OI33_THEME_SCREENSHOT_DIR, `education-${mode ? 'dark' : 'light'}.png`), fullPage: true });
        }
      }
    }
  } finally { await browser.close(); }
});
