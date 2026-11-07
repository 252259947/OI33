const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');

class TemplateLoader extends nunjucks.FileSystemLoader {
    getSource(name) {
        if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
        return super.getSource(name);
    }
}
function render(groups, classReferences = {}) {
    const env = new nunjucks.Environment(new TemplateLoader(path.join(root, 'templates')), { autoescape: true });
    env.addGlobal('url', () => '/oi33/education/students');
    return env.render('oi33_education_classes.html', { groups, classReferences, names: { 17: '测试学生' }, csrfToken: 'fixture-csrf' });
}
function forms(html) {
    return Array.from(html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g), ([, attrs, body]) => ({ attrs, body,
        operation: body.match(/name="operation" value="([^"]+)"/)?.[1] }));
}

test('rename and delete forms retain independent CSRF, stable class identity and original roster snapshots', () => {
    const group = { _id: '000000000000000000000017', name: '周日 "<班>"', uids: [17, 18] };
    const html = render([group]);
    const all = forms(html);
    assert.deepEqual(all.map(form => form.operation), ['create', 'update', 'rename', 'delete']);
    for (const form of all) {
        assert.match(form.attrs, /method="post"/);
        assert.equal((form.body.match(/name="csrfToken" value="fixture-csrf"/g) || []).length, 1);
    }
    for (const operation of ['rename', 'delete']) {
        const form = all.find(form => form.operation === operation);
        assert.match(form.body, /name="groupId" value="000000000000000000000017"/);
        assert.match(form.body, /name="name" value="周日 &quot;&lt;班&gt;&quot;"/);
        assert.match(form.body, /name="originalUids" value="17,18"/);
        assert.doesNotMatch(form.body, /data-student-picker|name="uids"|name="operator"|name="domainId"/);
    }
    assert.match(all.find(form => form.operation === 'rename').body, /name="newName"[^>]* required maxlength="80"/);
    assert.match(all.find(form => form.operation === 'delete').body, /name="confirmDelete" value="false"/);
    assert.match(html, /data-class-name="周日 &quot;&lt;班&gt;&quot;"/);
    assert.doesNotMatch(html, /<班>/);
    const empty = forms(render([{ ...group, uids: [] }])).filter(form => ['rename', 'delete'].includes(form.operation));
    assert.equal(empty.length, 2);
    for (const form of empty) assert.match(form.body, /name="originalUids" value=""/);
});

test('active class references explain the restriction and disable rename and delete while retaining member editing', () => {
    const group = { _id: '000000000000000000000017', name: '已关联班型', uids: [17] };
    const html = render([group], { [group.name]: { total: 5, documents: 2, joinSettings: 1, previews: 1, batches: 1 } });
    const all = forms(html);
    assert.ok(all.some(form => form.operation === 'update'));
    assert.ok(!all.some(form => form.operation === 'rename'));
    assert.match(html, /<button[^>]* disabled>修改名称<\/button>/);
    assert.match(all.find(form => form.operation === 'delete').body, /<button[^>]* disabled>删除班型<\/button>/);
    for (const text of ['5 处引用', '学习任务/讨论 2 处', '入域设置 1 处', '名单预览 1 处', '账号导入 1 处', '请先调整关联内容']) assert.ok(html.includes(text));
});

class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.textContent = ''; this.className = ''; }
    append(...nodes) { this.children.push(...nodes); }
    set innerHTML(_) { throw Error('Untrusted class names must never be parsed as markup'); }
}
function actionHarness({ disabled = false, name = '周六 <img src=x onerror=alert(1)>', count = '4' } = {}) {
    const dialogs = [];
    const alerts = [];
    const button = { disabled };
    const confirmation = { value: 'false' };
    const status = { textContent: '' };
    const listeners = [];
    const submitted = [];
    const form = {
        isConnected: true, dataset: { className: name, classCount: count },
        querySelector(selector) {
            if (selector === 'button[type="submit"]') return button;
            if (selector === '[name="confirmDelete"]') return confirmation;
            if (selector === '[data-class-delete-status]') return status;
            return null;
        },
        addEventListener(type, listener) { assert.equal(type, 'submit'); listeners.push(listener); },
        requestSubmit(submitter) { assert.equal(submitter, button); fire(); },
    };
    function fire() {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        const promises = listeners.map(listener => listener(event));
        if (!event.defaultPrevented) submitted.push({ confirmation: confirmation.value });
        return { event, settled: Promise.all(promises) };
    }
    class ActionDialog {
        constructor(options) { this.options = options; }
        open() { return new Promise((resolve, reject) => dialogs.push({ options: this.options, resolve, reject })); }
    }
    const module = { exports: {} };
    const js = transformSync(fs.readFileSync(path.join(root, 'frontend/class-management.page.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    vm.runInNewContext(js, { module, exports: module.exports, console,
        document: { querySelectorAll: () => [form], createElement: tag => new Element(tag) },
        window: { alert: value => alerts.push(value) },
        require(name) {
            if (name === '@hydrooj/ui-default') return { ActionDialog, addPage() {}, NamedPage: class {} };
            throw Error(name);
        },
    });
    return { install: module.exports.installClassActions, fire, form, button, confirmation, status, dialogs, submitted, alerts, listeners };
}

test('deletion requires its explicit modal confirmation, ignores repeated submits and escapes the displayed class name', async () => {
    const h = actionHarness();
    h.install(); h.install();
    assert.equal(h.listeners.length, 1, 'PJAX installation cannot add duplicate submission handlers');
    const first = h.fire();
    assert.equal(first.event.defaultPrevented, true);
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.submitted.length, 0);
    const body = h.dialogs[0].options.$body;
    assert.equal(body.children[0].textContent, '删除班型？');
    assert.ok(body.children[1].textContent.includes('周六 <img src=x onerror=alert(1)>'));
    assert.ok(body.children[1].textContent.includes('4 名成员'));
    assert.match(body.children[2].textContent, /学生账号、其他班型和历史成绩会保留/);
    assert.doesNotMatch(h.dialogs[0].options.$action, /img|onerror/);
    await h.fire().settled;
    assert.equal(h.dialogs.length, 1, 'A pending dialog cannot open twice');
    h.dialogs[0].resolve('cancel'); await first.settled;
    assert.equal(h.submitted.length, 0);
    assert.equal(h.confirmation.value, 'false');
    const second = h.fire();
    h.dialogs[1].resolve('ok'); await second.settled;
    assert.deepEqual(h.submitted, [{ confirmation: 'true' }], 'Exactly one explicit confirmed POST is permitted');
    assert.equal(h.confirmation.value, 'false', 'A completed attempt cannot leave a reusable confirmed flag');
    const third = h.fire();
    assert.equal(third.event.defaultPrevented, true);
    assert.equal(h.dialogs.length, 3, 'A later attempt requires its own confirmation');
    h.dialogs[2].resolve('cancel'); await third.settled;
    assert.equal(h.submitted.length, 1);
});

test('stale page dialogs and failed modal creation cannot submit a deletion or retain prior approval', async () => {
    const h = actionHarness(); h.install();
    const stale = h.fire(); h.form.isConnected = false;
    h.dialogs[0].resolve('ok'); await stale.settled;
    assert.equal(h.submitted.length, 0);
    assert.equal(h.confirmation.value, 'false');
    h.form.isConnected = true;
    const failed = h.fire(); h.dialogs[1].reject(Error('synthetic modal failure'));
    await failed.settled;
    assert.equal(h.submitted.length, 0);
    assert.equal(h.confirmation.value, 'false');
    assert.ok(h.status.textContent, 'A failed modal provides visible retry feedback');
    const retry = h.fire();
    assert.equal(h.status.textContent, '', 'Retry clears stale failure feedback');
    h.dialogs[2].resolve('cancel'); await retry.settled;
    assert.equal(h.dialogs.length, 3, 'A failure releases the pending guard for retry');
});

test('a referenced class with a disabled delete button is not wired for confirmation or automatic submission', () => {
    const h = actionHarness({ disabled: true }); h.install();
    assert.equal(h.listeners.length, 0);
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.confirmation.value, 'false');
});
