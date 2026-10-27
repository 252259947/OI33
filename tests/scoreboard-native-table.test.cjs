const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('actual Hydro StyledTable and sticky-kit keep frozen score columns aligned during vertical and horizontal scrolling',
    { skip: process.env.OI33_LAYOUT_TEST !== '1' }, async () => {
        const { chromium } = require('playwright');
        const publicRoot = path.join(root, 'node_modules/@hydrooj/ui-default/public');
        const nativeMain = read('node_modules/@hydrooj/ui-default/public/hydro-4.58.4.js');
        const nativeTables = read('node_modules/@hydrooj/ui-default/public/604.7371fa.chunk.js');
        assert.match(nativeTables, /59455\(/, 'Recheck the actual native module after a Hydro upgrade');
        const bundle = require('esbuild').buildSync({ entryPoints: [path.join(root, 'frontend/scoreboard-usability.ts')],
            bundle: true, format: 'iife', globalName: 'ScoreboardUX', write: false }).outputFiles[0].text;
        const css = ['node_modules/@hydrooj/ui-default/public/theme-4.58.4.css', 'frontend/oi33-design-system.css',
            'frontend/scoreboard-names.css', 'frontend/scoreboard-usability.css'].map(read).join('\n');
        const colgroup = '<colgroup><col class="col--rank"><col class="col--user"><col class="col--total_score">'
            + Array.from({ length: 25 }, () => '<col class="col--problem">').join('') + '</colgroup>';
        const table = () => '<div class="oi33-scoreboard" data-fragment-id="scoreboard"><div class="section__body no-padding overflow-hidden-horizontal">'
            + '<table class="data-table">' + colgroup + '<thead><tr><th class="col--rank">排名</th><th class="col--user">用户</th>'
            + '<th class="col--total_score">得分</th>' + Array.from({ length: 25 }, (_, i) => `<th class="col--problem">${String.fromCharCode(65 + i)}</th>`).join('')
            + '</tr></thead><tbody>' + Array.from({ length: 70 }, (_, i) => `<tr><td class="col--rank"><span class="rank--normal">${i + 1}</span></td>`
                + `<td class="col--user"><button class="star user--${i + 17}" data-uid="${i + 17}">☆</button><a class="user-profile-name" href="/user/${i + 17}">测试学生${i + 1}</a></td>`
                + `<td class="col--total_score">${700 - i}</td>`
                + Array.from({ length: 25 }, () => '<td class="col--record"><a href="/record/fixture">100</a></td>').join('') + '</tr>').join('')
            + '</tbody></table></div></div>';
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            for (const width of [1366, 1920]) for (const dark of [false, true]) {
                const page = await browser.newPage({ viewport: { width, height: 900 } });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.route('http://native-scoreboard.fixture.invalid/**', async route => {
                    const pathname = new URL(route.request().url()).pathname;
                    if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>'
                        + `<html class="page--contest_scoreboard ${dark ? 'theme--dark' : ''}"><head><meta charset="utf-8"></head><body>`
                        + '<nav class="nav" style="height:60px;position:fixed;top:0;left:0;width:100%;z-index:100">原生导航栏占位</nav>'
                        + '<div style="height:280px"></div><section class="section" style="margin:24px">'
                        + '<div class="section__header"><select class="select filter"><option value="all">全部</option><option value="star">星标</option>'
                        + '<option value="rank">计入排名</option><option value="17,18">测试分组</option></select></div>'
                        + '<div class="oi33-scoreboard-tools"><label for="oi33-scoreboard-query">查找学生</label><input id="oi33-scoreboard-query" type="search">'
                        + '<button data-scoreboard-clear>清除</button><span data-scoreboard-count></span></div>' + table()
                        + '<p data-scoreboard-empty hidden>无匹配</p></section><div style="height:800px"></div></body></html>' });
                    const file = path.resolve(publicRoot, '.' + pathname);
                    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                        return route.fulfill({ status: 404, body: '' });
                    }
                    return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript'
                        : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
                });
                await page.goto('http://native-scoreboard.fixture.invalid/fixture');
                await page.addStyleTag({ content: css });
                await page.evaluate(() => {
                    window.UiContext = JSON.stringify({ cdn_prefix: 'http://native-scoreboard.fixture.invalid/',
                        tdoc: { domainId: 'system', docId: 'fixture', beginAt: '2100-01-01T00:00:00Z', endAt: '2100-01-02T00:00:00Z' } });
                    window.UserContext = JSON.stringify({ _id: 17, viewLang: 'en' });
                    window.UiContextNew = '{}'; window.UserContextNew = '{}';
                });
                await page.addScriptTag({ content: nativeMain });
                await page.evaluate(async () => {
                    window.webpackChunk_hydrooj_ui_default.push([[987657], {}, require => { window.hydroRequire = require; }]);
                    await Promise.all([694, 343, 939, 127, 406, 163, 4, 504, 810, 181, 604].map(window.hydroRequire.e));
                    window.NativeHydro = window.hydroRequire(51604);
                    document.querySelector('.page-loader')?.remove();
                    window.hydroRequire(59455).default.afterLoading();
                    await window.hydroRequire(12003).default.afterLoading();
                });
                await page.addScriptTag({ content: bundle + ';window.cleanupScoreboard = ScoreboardUX.installScoreboardUsability();' });
                await page.waitForFunction(() => document.querySelector('[data-scoreboard-count]').textContent === '显示 70 / 70 人');
                assert.equal(await page.locator('.oi33-scoreboard .data-table').count(), 2, 'Native StyledTable splits the header');
                assert.equal(await page.evaluate(() => !!window.NativeHydro.$('.oi33-scoreboard .data-table').last().data('vjStyledTableInstance')), true);
                assert.equal(await page.evaluate(() => !!window.NativeHydro.$('.section__table-header').data('sticky_kit')), true,
                    'Execute real sticky-kit, not a simulated detached header');
                const geometry = () => page.evaluate(() => {
                    const head = document.querySelector('.section__table-header');
                    const row = document.querySelector('.oi33-scoreboard tbody tr:nth-child(12)');
                    const box = el => { const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; };
                    const cells = selector => ({ header: box(head.querySelector(selector)), body: box(row.querySelector(selector)) });
                    return { scrollX, scrollY, containerScroll: document.querySelector('.section__table-container').scrollLeft,
                        position: getComputedStyle(head).position, head: box(head), rank: cells('.col--rank'),
                        user: cells('.col--user'), score: cells('.col--total_score') };
                });
                const checkAligned = async label => {
                    const result = await geometry();
                    for (const name of ['rank', 'user', 'score']) {
                        assert.ok(Math.abs(result[name].header.x - result[name].body.x) < 2,
                            `${width} ${dark ? 'dark' : 'light'} ${label} ${name}: ${JSON.stringify(result)}`);
                    }
                    return result;
                };
                const initial = await checkAligned('initial');
                await page.evaluate(() => window.scrollTo(0, 650));
                await page.waitForFunction(() => getComputedStyle(document.querySelector('.section__table-header')).position === 'fixed');
                const vertical = await checkAligned('vertical sticky');
                assert.ok(Math.abs(vertical.head.y - 60) < 2, JSON.stringify(vertical));
                await page.locator('.section__table-container').evaluate(el => { el.scrollLeft = 650; });
                await page.waitForFunction(() => document.querySelector('.section__table-container').scrollLeft === 650);
                const horizontal = await checkAligned('sticky then horizontal');
                assert.ok(Math.abs(initial.user.body.x - horizontal.user.body.x) < 2, JSON.stringify({ initial, horizontal }));
                // Native group/star filters must intersect, not replace, search.
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.selectOption('.select.filter', '17,18');
                await page.waitForFunction(() => document.querySelector('[data-scoreboard-count]').textContent === '显示 2 / 70 人');
                await page.locator('#oi33-scoreboard-query').fill('测试学生2');
                await page.waitForFunction(() => document.querySelector('[data-scoreboard-count]').textContent === '显示 1 / 70 人');
                assert.equal(await page.locator('tbody tr:visible .user-profile-name').innerText(), '测试学生2');
                await page.selectOption('.select.filter', 'all');
                await page.waitForFunction(() => document.querySelector('[data-scoreboard-count]').textContent === '显示 11 / 70 人');
                await page.locator('.star.user--18').click();
                await page.waitForFunction(() => document.querySelector('.star.user--18').classList.contains('activated'));
                await page.selectOption('.select.filter', 'star');
                await page.waitForFunction(() => document.querySelector('[data-scoreboard-count]').textContent === '显示 1 / 70 人');
                assert.equal(await page.locator('tbody tr:visible .user-profile-name').innerText(), '测试学生2');
                assert.deepEqual(errors, []);
                await page.close();
            }
        } finally {
            await browser.close();
        }
    });
