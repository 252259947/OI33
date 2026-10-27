const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

if (process.env.OI33_LAYOUT_TEST === '1') test('actual typography has readable dark statement headings with either theme marker and unchanged light/editor colors', async () => {
    const { chromium } = require('playwright');
    const native = read('node_modules/@hydrooj/ui-default/public/theme-4.58.4.css');
    const design = read('frontend/oi33-design-system.css');
    const content = read('frontend/content-enhancements.css');
    const workbench = read('frontend/problem-workbench.css');
    const fixture = '<div id="scratchpad" class="oi33-scratchpad-ready"><section class="section"><div class="problem-content typo">'
        + [1, 2, 3, 4, 5, 6].map(level => `<h${level}>题目描述 ${level}</h${level}>`).join('')
        + '<div class="oi33-sample-block"><h2>输入样例</h2><pre>1 2</pre></div></div></section>'
        + '<div class="monaco-editor" style="color:rgb(212,212,212);background:rgb(30,30,30)"><span class="view-line">int main() {}</span></div></div>';
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const render = (mode, css) => page.setContent(`<html ${mode}><head><style>${css}</style></head><body class="mode--scratchpad">${fixture}</body></html>`);
        const inspect = () => page.locator('.problem-content :is(h1,h2,h3,h4,h5,h6)').evaluateAll(elements => {
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = value => rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            return elements.map(element => {
                const style = getComputedStyle(element);
                let parent = element;
                while (parent.parentElement && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
                const background = getComputedStyle(parent).backgroundColor;
                const values = [luminance(style.color), luminance(background)].sort((a, b) => a - b);
                return { foreground: style.color, background, ratio: (values[1] + .05) / (values[0] + .05) };
            });
        });
        await render('data-mantine-color-scheme="dark"', native + design + content);
        assert.ok((await inspect())[1].ratio < 2, 'Reproduces the legacy deep-green heading in the attribute-based dark theme');
        await render('', native + design + content);
        const lightBefore = (await inspect()).slice(0, 6).map(item => item.foreground);
        for (const [order, css] of [['core-first', native + design + content + workbench],
            ['core-last', design + workbench + content + native]]) {
            for (const mode of ['', 'class="theme--dark"', 'data-mantine-color-scheme="dark"']) {
                await render(mode, css);
                const colors = await inspect();
                for (const result of colors) assert.ok(result.ratio >= 4.5, JSON.stringify({ order, mode, ...result }));
                if (!mode) assert.deepEqual(colors.slice(0, 6).map(item => item.foreground), lightBefore);
                else for (const result of colors) assert.equal(result.foreground, 'rgb(238, 241, 248)');
                assert.deepEqual(await page.locator('.monaco-editor').evaluate(element => {
                    const style = getComputedStyle(element); return { foreground: style.color, background: style.backgroundColor };
                }), { foreground: 'rgb(212, 212, 212)', background: 'rgb(30, 30, 30)' });
            }
        }
    } finally { await browser.close(); }
});
