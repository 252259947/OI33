const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync, transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const compiled = transformSync(fs.readFileSync(path.join(root, 'frontend/contest-time.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { contestClock, contestDurationMinutes, contestDurationHours } = mod.exports;

test('contest wall-clock fields use the account timezone and round-trip across days', () => {
    const clock = contestClock('Asia/Shanghai');
    const begin = clock.parse('2026-10-5', '23:45');
    assert.equal(begin, Date.UTC(2026, 9, 5, 15, 45));
    assert.deepEqual(clock.format(begin + 90 * 60000), { date: '2026-10-06', time: '01:15' });
    assert.equal(contestClock('Pacific/Kiritimati').parse('2026-10-05', '0:00'), Date.UTC(2026, 9, 4, 10));
    assert.equal(contestClock('America/Los_Angeles').parse('2026-10-05', '0:00'), Date.UTC(2026, 9, 5, 7));
});

test('invalid and missing dates/times do not normalize silently', () => {
    const clock = contestClock('Asia/Shanghai');
    for (const [date, time] of [['', '12:00'], ['2026-02-29', '12:00'], ['2026-02-31', '12:00'],
        ['2026-13-01', '12:00'], ['2026-00-01', '12:00'], ['2026-01-00', '12:00'], ['2026-01-01', '24:00'],
        ['2026-01-01', '12:60'], ['2026-01-01', '12:1'], ['2026-01-01', ''], ['2026/01/01', '12:00']]) {
        assert.equal(clock.parse(date, time), null, `${date} ${time}`);
    }
    assert.equal(clock.parse('2028-02-29', '12:00'), Date.UTC(2028, 1, 29, 4));
    assert.throws(() => contestClock('Not/A_TimeZone'), RangeError);
});

test('DST spring gaps are rejected and elapsed durations cross DST correctly', () => {
    const clock = contestClock('America/New_York');
    assert.equal(clock.parse('2026-03-08', '02:30'), null);
    const begin = clock.parse('2026-03-08', '01:30');
    const end = clock.parse('2026-03-08', '03:30');
    assert.equal(end - begin, 3600000);
    assert.deepEqual(clock.format(begin + 3600000), { date: '2026-03-08', time: '03:30' });
    assert.equal(contestClock('Pacific/Apia').parse('2011-12-30', '12:00'), null);
});

test('DST repeated times choose the same earlier occurrence as native moment-timezone', () => {
    const clock = contestClock('America/New_York');
    const timestamp = clock.parse('2026-11-01', '01:30');
    assert.equal(timestamp, Date.UTC(2026, 10, 1, 5, 30));
    const moment = require('moment-timezone');
    for (const [zone, date, time] of [['America/New_York', '2026-11-01', '01:30'], ['Australia/Lord_Howe', '2026-04-05', '01:45'],
        ['Asia/Shanghai', '2026-10-05', '23:00'], ['Europe/Berlin', '2026-10-25', '02:30']]) {
        assert.equal(contestClock(zone).parse(date, time), moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', zone).valueOf());
    }
});

test('minute-exact decimal durations do not accumulate rounding drift', () => {
    for (const minutes of [1, 2, 20, 59, 61, 1439, 1441, 12345678]) {
        assert.equal(contestDurationMinutes(contestDurationHours(minutes)), minutes);
    }
    assert.equal(contestDurationMinutes('1.333333333333'), 80);
    assert.equal(contestDurationMinutes(' .5 '), 30);
    for (const value of ['', '0', '-1', 'NaN', 'Infinity', '7 hours', '1,5', '1e100', '0.00001']) {
        assert.equal(contestDurationMinutes(value), null, value);
    }
});

test('page registration is restricted to contest editors and uses the account timezone', () => {
    const source = fs.readFileSync(path.join(root, 'frontend/contest-time.page.ts'), 'utf8');
    assert.match(source, /NamedPage\(\['contest_create', 'contest_edit'\]/);
    assert.match(source, /UserContext.timeZone/);
    assert.match(source, /change\.oi33ContestTime/);
    assert.match(source, /setCustomValidity/);
    assert.doesNotMatch(source, /request\.post|new Date\(/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('real browser and shipped jQuery: bidirectional edits, picker changes, validation and resets', async () => {
    const { chromium } = require('playwright');
    const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/contest-time.page.ts')], bundle: true, write: false,
        format: 'iife', globalName: 'ContestTime', external: ['@hydrooj/ui-default'] }).outputFiles[0].text;
    // Use the exact jQuery bundled by the installed Hydro UI, not an event-system mock.
    const hydro = transformSync(fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/public/hydro-4.58.4.js'), 'utf8'), { minify: false }).code;
    const marker = '91688(c, x) {';
    assert.ok(hydro.includes(marker), 'Recheck the shipped jQuery module when upgrading Hydro UI');
    const tail = hydro.slice(hydro.indexOf(marker) + marker.length);
    const boundary = /\n    }, \d+\(/.exec(tail);
    assert.ok(boundary, 'jQuery module boundary');
    const jquery = `(() => { const c = { exports: {} }; const x = c.exports; ${tail.slice(0, boundary.index)}; window.$ = c.exports; })();`;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
        await page.setContent('<form id="contest">'
            + '<input name="beginAtDate" value="2026-10-05"><input name="beginAtTime" value="15:00">'
            + '<input name="duration" value="7"><input name="oi33EndAtDate" value="2026-10-05">'
            + '<input name="oi33EndAtTime" value="22:00"><button type="submit">保存</button><button type="reset">重置</button></form>');
        await page.addScriptTag({ content: jquery });
        await page.evaluate(() => {
            window.UserContext = { timeZone: 'Asia/Shanghai' };
            window.registeredPages = [];
            window.require = () => ({ $: window.$, NamedPage: function (names, callback) { this.names = names; this.callback = callback; },
                addPage: (value) => window.registeredPages.push(value) });
            window.submitCount = 0;
            document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.submitCount++; });
            window.pickerDates = [];
            document.querySelector('[name=oi33EndAtDate]')._flatpickr = { setDate: (value, emit) => { window.pickerDates.push([value, emit]); } };
            // Native core still attempts to update its old disabled field; it no longer exists.
            window.$('[name=duration],[name=beginAtDate],[name=beginAtTime]').on('input change', () => {
                window.$('[name=endAt]').val('core legacy preview');
            });
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => window.registeredPages[0].callback());
        const val = (name) => page.inputValue(`[name=${name}]`);
        const change = (name, value) => page.evaluate(({ name, value }) => window.$(`[name=${name}]`).val(value).trigger('change'), { name, value });
        assert.equal(await val('duration'), '7');
        await change('oi33EndAtTime', '23:30');
        assert.equal(await val('duration'), '8.5');
        await page.fill('[name=beginAtTime]', '23:00');
        assert.equal(await val('oi33EndAtDate'), '2026-10-06');
        assert.equal(await val('oi33EndAtTime'), '07:30');
        assert.deepEqual((await page.evaluate(() => window.pickerDates)).at(-1), ['2026-10-06', false]);
        await page.fill('[name=duration]', '0.016666666667');
        assert.equal(await val('oi33EndAtTime'), '23:01');
        assert.equal(await val('oi33EndAtDate'), '2026-10-05');
        await page.evaluate(() => document.querySelector('form').requestSubmit());
        assert.equal(await page.evaluate(() => window.submitCount), 1);
        assert.equal(contestDurationMinutes(await val('duration')), 1);
        await change('oi33EndAtTime', '22:59');
        assert.equal(await page.evaluate(() => document.querySelector('form').checkValidity()), false);
        await page.evaluate(() => document.querySelector('form').requestSubmit());
        assert.equal(await page.evaluate(() => window.submitCount), 1);
        assert.equal(await page.evaluate(() => document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))), false);
        assert.equal(await page.evaluate(() => window.submitCount), 1);
        await change('oi33EndAtTime', '23:30');
        await page.fill('[name=duration]', '10000000000');
        assert.equal(await page.evaluate(() => document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))), false);
        assert.equal(await page.evaluate(() => window.submitCount), 1);
        await page.evaluate(() => document.querySelector('form').reset());
        await page.waitForFunction(() => document.querySelector('[name=duration]').value === '7');
        assert.equal(await page.evaluate(() => document.querySelector('form').checkValidity()), true);
        await change('beginAtDate', '2026-02-31');
        assert.equal(await page.evaluate(() => document.querySelector('form').checkValidity()), false);
        const jqueryInvalid = await page.evaluate(() => { const event = window.$.Event('submit'); window.$('form').trigger(event); return event.isDefaultPrevented(); });
        assert.equal(jqueryInvalid, true);
        // Account timezone, not the browser's, controls a DST transition.
        await page.setContent('<form><input name="beginAtDate" value="2026-03-08"><input name="beginAtTime" value="01:30">'
            + '<input name="duration" value="1"><input name="oi33EndAtDate" value="2026-03-08"><input name="oi33EndAtTime" value="03:30"></form>');
        await page.evaluate(() => window.ContestTime.attachContestTime(document.querySelector('form'), 'America/New_York'));
        assert.equal(await val('duration'), '1');
        await change('oi33EndAtTime', '02:30');
        assert.equal(await page.evaluate(() => document.querySelector('form').checkValidity()), false);
        await change('oi33EndAtTime', '04:30');
        assert.equal(await val('duration'), '2');
        await change('beginAtDate', '2026-11-01');
        await change('beginAtTime', '00:30');
        await change('duration', '2');
        assert.equal(await page.evaluate(() => document.querySelector('[name=duration]').validity.valid), false, 'Second repeated wall-clock time must not silently shorten duration on save');
        await change('oi33EndAtTime', '01:30');
        assert.equal(await val('duration'), '1');
        assert.equal(await page.evaluate(() => document.querySelector('form').checkValidity()), true);
    } finally { await browser.close(); }
});
