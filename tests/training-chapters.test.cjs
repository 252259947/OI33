const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const built = buildSync({ entryPoints: [path.join(root, 'frontend/training-chapters.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
const mod = { exports: {} };
new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { changeTrainingChapter, validateTrainingPlan } = mod.exports;
const plan = [{ _id: 8, title: '基础', pids: [1, 'P2'], requireNids: [], extension: { rubric: ['保留', 3] } },
    { _id: 3, title: '进阶', pids: [9], requireNids: [8], label: 'existing' }];
const source = () => JSON.stringify(plan);

test('visual chapter operations preserve IDs, prerequisites, problem order and unknown fields', () => {
    let result = changeTrainingChapter(source(), { type: 'rename', id: 8, title: '  新基础  ' });
    assert.deepEqual(JSON.parse(result.source), [{ ...plan[0], title: '新基础' }, plan[1]]);
    result = changeTrainingChapter(result.source, { type: 'move', id: 8, direction: 1 });
    assert.deepEqual(JSON.parse(result.source), [plan[1], { ...plan[0], title: '新基础' }]);
    result = changeTrainingChapter(result.source, { type: 'add' });
    assert.equal(result.selectedId, 9);
    assert.deepEqual(JSON.parse(result.source)[2], { _id: 9, title: '新章节 3', pids: [], requireNids: [] });
    assert.throws(() => validateTrainingPlan(result.source), /新章节 3.*没有题目/);
    result = changeTrainingChapter(result.source, { type: 'remove', id: 9 });
    assert.deepEqual(JSON.parse(result.source).map((chapter) => chapter._id), [3, 8]);
    assert.equal(validateTrainingPlan(result.source).length, 2);
});

test('deleting prerequisites or the final chapter fails without rewriting any content', () => {
    const original = source();
    assert.throws(() => changeTrainingChapter(original, { type: 'remove', id: 8 }), /进阶.*先修/);
    assert.equal(source(), original);
    assert.throws(() => changeTrainingChapter(JSON.stringify([plan[0]]), { type: 'remove', id: 8 }), /至少保留/);
    for (const title of ['', ' ', 'a'.repeat(201)]) assert.throws(() => changeTrainingChapter(original, { type: 'rename', id: 8, title }), /名称/);
    assert.throws(() => changeTrainingChapter('{bad', { type: 'add' }), /JSON/);
});

if (process.env.OI33_LAYOUT_TEST === '1') test('Chrome chapter editing and native JSON/bulk imports stay synchronized through rename, reordering and races', async () => {
    const { chromium } = require('playwright');
    const bundle = buildSync({ stdin: { contents: "export * from './frontend/training-chapters.page'; export * from './frontend/bulk-problem-paste.page';", resolveDir: root },
        bundle: true, write: false, outfile: 'chapters.js', format: 'iife', globalName: 'TrainingUi', external: ['@hydrooj/ui-default'] });
    const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css')).text;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.setContent('<form><section data-training-chapters hidden><div class="oi33-training-chapters__header"><h2>训练章节</h2><button type="button" data-chapter-add>新增章节</button></div><div data-chapter-list></div><p data-chapter-status role="status"></p></section>'
            + '<div data-training-bulk-mount></div><details data-training-advanced open><summary>高级模式</summary><label>计划<textarea name="dag" data-json></textarea></label></details><button type="submit" id="save">保存训练</button></form>');
        await page.addStyleTag({ content: css });
        await page.evaluate((initial) => {
            const textarea = document.querySelector('[name=dag]'); textarea.value = initial;
            window.sourceValue = initial; window.submitCount = 0; window.lookups = [];
            window.mockEditor = { isValid: true, value(next) { if (typeof next === 'string') textarea.value = window.sourceValue = next; return window.sourceValue; } };
            window.UiContext = { domainId: 'system' };
            window.require = () => ({ $: () => ({ data: () => window.mockEditor, on() {} }), addPage() {}, NamedPage: function() {},
                request: { get: async (_, args) => { window.lookups.push(args.q); if (window.queryWait) await new Promise((resolve) => { window.releaseQuery = resolve; }); return { pdocs: [{ docId: Number(args.q), pid: args.q }] }; } } });
            document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); if (window.validPlan) window.submitCount++; });
        }, source());
        await page.addScriptTag({ content: script });
        await page.evaluate(() => { TrainingUi.installBulkProblemPaste(); TrainingUi.installTrainingChapters(); TrainingUi.installTrainingChapters(); });
        assert.equal(await page.locator('[data-chapter-list] > div').count(), 2);
        assert.equal(await page.locator('[data-training-advanced]').getAttribute('open'), null);
        await page.getByRole('textbox', { name: '第 1 章名称' }).fill('基础新名字');
        await page.getByRole('button', { name: '下移“基础”', exact: true }).click();
        let dag = await page.evaluate(() => JSON.parse(window.sourceValue));
        assert.deepEqual(dag, [plan[1], { ...plan[0], title: '基础新名字' }], 'Renaming on blur must not swallow the immediately clicked move button');
        await page.getByRole('button', { name: '新增章节', exact: true }).click();
        assert.equal(await page.locator('[aria-label="目标章节"]').inputValue(), '9');
        await page.getByRole('textbox', { name: '批量题号' }).fill('11, 12, 11');
        await page.getByRole('button', { name: '加入所选章节' }).click();
        await page.waitForFunction(() => JSON.parse(window.sourceValue).find((chapter) => chapter._id === 9).pids.length === 2);
        assert.equal(await page.locator('[data-chapter-id="9"] .oi33-training-chapter__count').innerText(), '2 道题');
        dag = await page.evaluate(() => JSON.parse(document.querySelector('[name=dag]').value));
        assert.deepEqual(dag[1].extension, plan[0].extension);
        assert.deepEqual(dag[0].requireNids, [8]);
        await page.evaluate(() => { window.confirm = () => false; });
        await page.getByRole('button', { name: '删除“新章节 3”', exact: true }).click();
        assert.equal(await page.locator('[data-chapter-list] > div').count(), 3);
        await page.evaluate(() => { window.confirm = () => true; });
        await page.getByRole('button', { name: '删除“基础新名字”', exact: true }).click();
        assert.match(await page.locator('[data-chapter-status]').innerText(), /先修/);
        await page.getByRole('button', { name: '删除“新章节 3”', exact: true }).click();
        assert.equal(await page.locator('[data-chapter-list] > div').count(), 2);
        await page.locator('[data-training-advanced] summary').click();
        await page.evaluate(() => { const dag = JSON.parse(window.sourceValue); dag[0].title = 'JSON 修改的名称'; window.mockEditor.value(JSON.stringify(dag)); });
        await page.locator('[data-training-advanced] summary').click();
        await page.waitForFunction(() => document.querySelector('[data-chapter-list] input').value === 'JSON 修改的名称');
        assert.equal(await page.getByRole('textbox', { name: '第 1 章名称' }).inputValue(), 'JSON 修改的名称');
        await page.getByRole('button', { name: '新增章节', exact: true }).click();
        await page.evaluate(() => { window.queryWait = true; });
        await page.getByRole('textbox', { name: '批量题号' }).fill('13');
        await page.getByRole('button', { name: '加入所选章节' }).click();
        await page.waitForFunction(() => !!window.releaseQuery);
        await page.getByRole('textbox', { name: '第 3 章名称' }).fill('查询中改名');
        await page.getByRole('textbox', { name: '第 3 章名称' }).press('Tab');
        await page.evaluate(() => window.releaseQuery());
        await page.waitForFunction(() => document.querySelector('.oi33-bulk-problem-status').textContent.includes('查询期间训练计划已被修改'));
        assert.deepEqual(await page.evaluate(() => JSON.parse(window.sourceValue).find((chapter) => chapter._id === 9).pids), []);
        await page.getByRole('button', { name: '保存训练', exact: true }).click();
        assert.match(await page.locator('[data-chapter-status]').innerText(), /没有题目/);
    } finally { await browser.close(); }
});
