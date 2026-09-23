const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'frontend/oi33-design-system.css'), 'utf8');
const start = css.indexOf('/* Sudo keeps');
const end = css.indexOf('.page--user_login body', start);
const fix = css.slice(start, end);

test('sudo color overrides are scoped, preserve native credential controls and cover focus/autofill', () => {
  assert.ok(start > 0 && end > start);
  for (const rule of fix.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*\}/g)) {
    for (const selector of rule[1].split(/,(?![^()]*\))/)) assert.ok(selector.trim().startsWith('.page--user_sudo '), selector);
  }
  assert.ok(fix.includes('label.textbox.material.inverse.focus'));
  assert.ok(fix.includes(':focus-within'));
  assert.ok(fix.includes('input:is(:autofill, :-webkit-autofill)'));
  assert.ok(fix.includes('-webkit-text-fill-color: var(--oi33-text)'));
  assert.ok(!fs.existsSync(path.join(root, 'templates/user_sudo.html')), 'Native security template is retained');
  assert.doesNotThrow(() => require('esbuild').transformSync(css, { loader: 'css', target: 'chrome105' }));
});

if (process.env.OI33_LAYOUT_TEST === '1') test('native sudo password and TFA remain readable when empty, filled, focused, blurred and autofilled', async () => {
  const { chromium } = require('playwright');
  const core = path.join(root, 'node_modules/@hydrooj/ui-default');
  class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
      if (name === 'layout/immersive.html') return { src: '<div id="panel" style="min-height:100vh"><div class="main">{% block content %}{% endblock %}</div></div>', path: name };
      return super.getSource(name);
    }
  }
  const env = new nunjucks.Environment(new Loader(path.join(core, 'templates')), { autoescape: true });
  env.addGlobal('_', s => ({ 'Confirm Access': '确认授权', Password: '密码', 'Two Factor Authentication Code': '两步验证码', Confirm: '确认',
    'Tip: You are entering sudo mode.': '提示：您正在进行身份验证。',
    "After you've performed a sudo-protected action, you'll only be asked to re-authenticate again after a few hours of inactivity.": '在您执行受保护的操作后，只有账户连续数小时不活动时，系统才会再次要求您重新验证身份。',
  }[s] || s));
  const form = env.render('user_sudo.html', { UserContext: { tfa: true, authn: true } });
  const theme = fs.readFileSync(path.join(core, 'public/theme-4.58.4.css'), 'utf8');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const inspect = async selector => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element), parent = getComputedStyle(element.closest('label'));
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = value => rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const ratio = (fg, bg) => { const [lo, hi] = [luminance(fg), luminance(bg)].sort((a, b) => a - b); return (hi + .05) / (lo + .05); };
      return { label: ratio(parent.color, parent.backgroundColor), input: ratio(style.webkitTextFillColor, parent.backgroundColor),
        caret: ratio(style.caretColor, parent.backgroundColor), fill: style.webkitTextFillColor,
        background: parent.backgroundColor, shadow: style.boxShadow, type: element.type };
    });
    const oldCss = css.slice(0, start) + css.slice(end);
    await page.setContent(`<html class="page--user_sudo layout--immersive"><head><style>${theme + oldCss}</style></head><body>${form}</body></html>`);
    assert.ok((await inspect('input[name="password"]')).input < 1.1, 'Original white-on-white bug is reproduced');
    for (const pageName of ['user_login', 'user_lostpass']) {
      const samples = [];
      for (const sheet of [oldCss, css]) {
        await page.setContent(`<html class="page--${pageName}"><head><style>${theme + sheet}</style></head><body>${form}</body></html>`);
        samples.push(await inspect('input[name="password"]'));
      }
      assert.deepEqual(samples[0], samples[1], 'Other authentication page styles are unchanged');
    }
    for (const [order, sheet] of [['core-first', theme + css], ['core-last', css + theme]]) {
      for (const mode of ['light', 'class', 'attribute']) {
        const classes = `page--user_sudo layout--immersive ${mode === 'class' ? 'theme--dark' : ''}`;
        await page.setContent(`<html class="${classes}" ${mode === 'attribute' ? 'data-mantine-color-scheme="dark"' : ''}><head><style>${sheet}</style></head><body>${form}</body></html>`);
        // Reproduce Hydro's material-label focus class; never submit credentials.
        await page.evaluate(() => {
          document.addEventListener('focusin', e => e.target.closest('label.material')?.classList.add('focus'));
          document.addEventListener('focusout', e => e.target.closest('label.material')?.classList.remove('focus'));
        });
        for (const name of ['password', 'tfa']) {
          const selector = `input[name="${name}"]`, input = page.locator(selector);
          if (name === 'tfa') await page.locator('.sudo-div[data-sudo="tfa"]').evaluate(el => { el.style.display = ''; });
          const check = async state => {
            const result = await inspect(selector);
            for (const key of ['label', 'input', 'caret']) assert.ok(result[key] >= 4.5, JSON.stringify({ mode, order, name, state, ...result }));
            assert.equal(result.type, name === 'password' ? 'password' : 'number');
          };
          await check('empty');
          await input.fill(name === 'password' ? 'fixture-not-a-real-password' : '123456');
          await check('focused');
          await input.evaluate(el => el.blur());
          await check('filled-unselected');
          const { root: document } = await cdp.send('DOM.getDocument');
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector });
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['autofill'] });
          assert.equal(await input.evaluate(el => el.matches(':autofill')), true);
          await check('autofilled');
          assert.notEqual((await inspect(selector)).shadow, 'none');
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        }
        if (process.env.OI33_THEME_SCREENSHOT_DIR && order === 'core-last' && mode !== 'attribute') {
          await page.locator('.sudo-div[data-sudo="tfa"]').evaluate(el => { el.style.display = 'none'; });
          await page.locator('.sudo-div[data-sudo="authn"]').evaluate(el => { el.style.display = 'none'; });
          fs.mkdirSync(process.env.OI33_THEME_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.OI33_THEME_SCREENSHOT_DIR, `sudo-${mode}.png`), fullPage: true });
        }
      }
    }
  } finally { await browser.close(); }
});
