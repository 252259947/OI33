const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { AsyncLocalStorage } = require('node:async_hooks');
const { transformSync } = require('esbuild');
const moment = require('moment-timezone');
const { ObjectId } = require('mongodb');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
class ValidationError extends Error {}
class ForbiddenError extends Error {}
const PERM = Object.fromEntries(['CREATE_CONTEST', 'EDIT_CONTEST', 'EDIT_CONTEST_SELF', 'EDIT_PROBLEM', 'VIEW_PROBLEM_HIDDEN']
    .map(name => [`PERM_${name}`, name]));
const SOURCE_ID = '6ac34c25763c33ec05262ed0';
const SECOND_ID = '6ac34c25763c33ec05262ed1';
function compile(source, imports) {
    const module = { exports: {} };
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    new Function('require', 'module', 'exports', code)(name => name in imports ? imports[name] : require(name), module, module.exports);
    return module.exports;
}
const { param } = compile(read('node_modules/@hydrooj/framework/decorators.ts'), { './error': { ValidationError } });
const { Types } = compile(read('node_modules/@hydrooj/framework/validator.ts'), {});
Types.ObjectId = [value => new ObjectId(value), ObjectId.isValid];
const core = read('node_modules/hydrooj/src/handler/contest.ts');
const editorStart = core.indexOf('export class ContestEditHandler');
const nativeEditor = core.slice(editorStart, core.indexOf('\nexport class ', editorStart + 1));
function source(extra = {}) {
    return { domainId: 'school', docId: new ObjectId(SOURCE_ID), _id: new ObjectId(), owner: 7,
        title: '原比赛', content: '# 说明\nfile://private-attachment', rule: 'ioi', pids: [1, 2, 3],
        beginAt: new Date('2026-10-05T07:05:00Z'), endAt: new Date('2026-10-05T14:05:00Z'), duration: 2,
        lockAt: new Date('2026-10-05T13:35:00Z'), rated: false, assign: ['2026级'], _code: 'INVITE', maintainer: [8],
        allowViewCode: false, allowPrint: true, keepScoreboardHidden: true, langs: ['cc.cc14'], autoHide: false,
        score: { 1: 50, 2: 100, 3: 200 }, balloon: { 1: { color: 'red', name: '红色' }, 2: 'blue' },
        attend: 99, files: [{ _id: 'file-private', name: 'test.zip' }], unlocked: true,
        journal: [{ uid: 99, score: 100 }], stat: { ac: 10 }, ...extra };
}
function harness(sources = [source()]) {
    const hooks = {}, reads = [], writes = [], checked = [], scheduled = [], docs = new Map(sources.map(doc => [String(doc.docId), doc]));
    const contest = {
        RULES: { ioi: { TEXT: 'IOI' }, acm: { TEXT: 'ACM' }, oi: { TEXT: 'OI' }, oc: { TEXT: 'OC' }, homework: { hidden: true } },
        async get(domainId, tid) { reads.push([domainId, String(tid)]); const doc = docs.get(String(tid)); if (!doc) throw new Error('ContestNotFound'); return doc; },
        async add(domainId, title, content, owner, rule, beginAt, endAt, pids, rated, extra) {
            const data = { ...extra, domainId, title, content, owner, rule, beginAt, endAt, pids, rated, attend: 0 };
            await hooks['contest/before-add'](data);
            data.docId = new ObjectId(); docs.set(String(data.docId), data); writes.push(['add', data]); return data.docId;
        },
        async edit(_, tid, changes) { writes.push(['edit', String(tid), changes]); Object.assign(docs.get(String(tid)), changes); },
        async recalcStatus(_, tid) { writes.push(['recalc', String(tid)]); },
    };
    const plugin = compile(read('handler/contest-editor.ts'), {
        'node:async_hooks': { AsyncLocalStorage }, hydrooj: { ContestModel: contest, ForbiddenError, ValidationError, PERM, moment, ObjectId },
    });
    plugin.apply({ on: (name, callback) => { hooks[name] = callback; } });
    const dependencies = { Handler: class {}, param, Types, moment, Time: { minute: 60000 }, contest, PERM, ValidationError,
        ContestNotFoundError: Error, diffArray: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
        problem: { getList: async (_, pids) => { checked.push([...pids]); return {}; }, edit: async () => {} },
        ScheduleModel: { deleteMany: async value => scheduled.push(['delete', value]), add: async value => scheduled.push(['add', value]) },
    };
    const prefix = Object.keys(dependencies).map(key => `const ${key} = require('fixture').${key};`).join('\n');
    const { ContestEditHandler } = compile(prefix + '\n' + nativeEditor, { fixture: dependencies });
    function make(args = {}, { uid = 7, permissions = ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], timeZone = 'Asia/Shanghai', params = {} } = {}) {
        const h = new ContestEditHandler();
        const allowed = new Set(permissions);
        h.args = { domainId: 'school', ...args }; h.domain = { _id: 'school' }; h.context = { params };
        h.response = { body: {}, addHeader: (key, value) => { h.headers[key] = value; } }; h.headers = {};
        h.user = { _id: uid, timeZone, own: doc => doc.owner === uid || doc.maintainer?.includes(uid),
            hasPerm: permission => allowed.has(permission) };
        h.checkPerm = permission => { if (!allowed.has(permission)) throw new ForbiddenError(`permission ${permission}`); };
        h.url = (name, data) => `/${name}/${data.tid || ''}`;
        return h;
    }
    async function get(h) { plugin.guardContestEditor(h); await h.prepare(h.args); await h.get(h.args); await plugin.prepareContestForm(h); return h.response.body; }
    async function save(h) { plugin.guardContestEditor(h); await h.prepare(h.args); await plugin.prepareContestUpdate(h); await h.postUpdate(h.args); return docs.get(String(h.response.body.tid)); }
    return { plugin, hooks, docs, reads, writes, checked, scheduled, make, get, save };
}
function fields(extra = {}) {
    return { operation: 'update', title: '新比赛', content: '新说明', rule: 'ioi', pids: '3,1,9', rated: false,
        beginAtDate: '2026-10-05', beginAtTime: '15:05', duration: 7, autoHide: false,
        allowViewCode: false, allowPrint: false, keepScoreboardHidden: false, ...extra };
}

test('contest editor registers scoped lifecycle hooks only', () => {
    const { hooks } = harness();
    assert.deepEqual(Object.keys(hooks), ['handler/before-prepare/ContestEdit', 'handler/after/ContestEdit#get',
        'handler/before/ContestEdit#post', 'contest/before-add']);
});

test('copy draft uses an explicit settings allowlist without source identity, files or participant results', () => {
    const { plugin } = harness(), doc = source(), original = JSON.stringify(doc), draft = plugin.contestCopyDraft(doc);
    assert.deepEqual(Object.keys(draft).sort(), ['title', 'content', 'rule', 'pids', 'rated', 'assign', '_code', 'maintainer',
        'allowViewCode', 'allowPrint', 'keepScoreboardHidden', 'langs', 'autoHide', 'beginAt', 'endAt', 'duration', 'lockAt'].sort());
    for (const key of ['docId', '_id', 'domainId', 'owner', 'files', 'attend', 'unlocked', 'journal', 'stat', 'score', 'balloon']) assert.equal(draft[key], undefined);
    for (const key of ['pids', 'assign', 'maintainer', 'langs']) { assert.deepEqual(draft[key], doc[key]); assert.notEqual(draft[key], doc[key]); }
    draft.pids.push(100); assert.equal(JSON.stringify(doc), original);
});

test('copy GET is read-only and fills a fresh create form with every editable setting', async () => {
    const doc = source(), before = JSON.stringify(doc), f = harness([doc]);
    const h = f.make({ copyFrom: SOURCE_ID }); const body = await f.get(h);
    assert.equal(body.page_name, 'contest_create'); assert.equal(body.oi33CopyFrom, SOURCE_ID);
    assert.equal(body.pids, '1,2,3'); assert.equal(body.duration, 7); assert.equal(body.tdoc.duration, 2);
    assert.equal(body.beginAt.format('YYYY-MM-DD HH:mm'), '2026-10-05 15:05');
    assert.equal(body.oi33EndAtDate, '2026-10-05'); assert.equal(body.oi33EndAtTime, '22:05');
    assert.deepEqual(body.files, []); assert.equal(body.tdoc.docId, undefined);
    assert.equal(body.tdoc._code, 'INVITE'); assert.deepEqual(body.tdoc.assign, ['2026级']);
    assert.equal(body.tdoc.allowViewCode, false); assert.equal(body.tdoc.rated, false);
    assert.equal(h.headers['Cache-Control'], 'private, no-store');
    assert.equal(JSON.stringify(doc), before); assert.deepEqual(f.writes, []);
    assert.deepEqual(f.reads, [['school', SOURCE_ID]]);
});

test('ordinary create/edit GET keeps native defaults and existing contest identity', async () => {
    const f = harness(), create = await f.get(f.make());
    assert.equal(create.tdoc, undefined); assert.equal(create.duration, 2); assert.equal(create.oi33CopyFrom, undefined);
    assert.equal(moment.tz(`${create.oi33EndAtDate} ${create.oi33EndAtTime}`, 'Asia/Shanghai').diff(create.beginAt, 'hours', true), 2);
    const edit = await f.get(f.make({ tid: SOURCE_ID }, { params: { tid: SOURCE_ID } }));
    assert.equal(String(edit.tdoc.docId), SOURCE_ID); assert.equal(edit.page_name, 'contest_edit');
    assert.equal(edit.oi33EndAtTime, '22:05'); assert.equal(edit.oi33CopyFrom, undefined); assert.equal(f.writes.length, 0);
});

test('copy permission matrix requires create plus native source-edit permission for owner, maintainer and others', async () => {
    const cases = [
        [7, ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], true], [8, ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], true],
        [9, ['CREATE_CONTEST', 'EDIT_CONTEST'], true], [7, ['CREATE_CONTEST'], false],
        [7, ['CREATE_CONTEST', 'EDIT_CONTEST'], false], [8, ['CREATE_CONTEST'], false],
        [9, ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], false], [9, ['CREATE_CONTEST'], false],
        [7, ['EDIT_CONTEST_SELF'], false], [9, ['EDIT_CONTEST'], false], [9, [], false],
    ];
    for (const [uid, permissions, permitted] of cases) {
        const f = harness(), h = f.make({ copyFrom: SOURCE_ID }, { uid, permissions });
        if (permitted) assert.equal((await f.get(h)).oi33CopyFrom, SOURCE_ID);
        else await assert.rejects(f.get(h), ForbiddenError);
        assert.equal(f.writes.length, 0);
    }
});

test('copy rejects foreign-domain documents, homework/hidden rules and invalid IDs before exposing settings', async () => {
    for (const extra of [{ domainId: 'foreign' }, { rule: 'homework' }, { rule: 'unknown' }]) {
        const f = harness([source(extra)]), h = f.make({ copyFrom: SOURCE_ID });
        await assert.rejects(f.get(h), ForbiddenError); assert.equal(h.response.body.oi33CopyFrom, undefined); assert.equal(f.writes.length, 0);
    }
    for (const copyFrom of ['', '123', 'g'.repeat(24), [SOURCE_ID], { $ne: null }, null]) {
        const f = harness(); await assert.rejects(f.get(f.make({ copyFrom })), ValidationError);
        assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
    }
    const f = harness(); await assert.rejects(f.get(f.make({ copyFrom: SECOND_ID })), /ContestNotFound/);
});

test('new editor rejects tid injection and mismatched domains; existing editors cannot receive copyFrom', async () => {
    for (const args of [{ tid: SOURCE_ID }, { domainId: 'foreign' }, { copyFrom: SOURCE_ID, tid: SOURCE_ID }]) {
        const f = harness(); await assert.rejects(f.get(f.make(args)), ForbiddenError); assert.equal(f.reads.length, 0);
    }
    const f = harness(); await assert.rejects(f.get(f.make({ tid: SOURCE_ID, copyFrom: SOURCE_ID }, { params: { tid: SOURCE_ID } })), ValidationError);
    assert.equal(f.writes.length, 0);
});

test('copy POST rechecks source edit permission instead of trusting a previously opened form', async () => {
    const f = harness(); await f.get(f.make({ copyFrom: SOURCE_ID }));
    await assert.rejects(f.save(f.make(fields({ copyFrom: SOURCE_ID }), { permissions: ['CREATE_CONTEST'] })), ForbiddenError);
    assert.equal(f.writes.length, 0);
});

test('copy POST uses native creation, takes submitted edits and copies only retained problem configuration', async () => {
    const doc = source(), before = JSON.stringify(doc), f = harness([doc]);
    const created = await f.save(f.make(fields({ copyFrom: SOURCE_ID, oi33EndAtDate: '2026-10-06', oi33EndAtTime: '01:06', duration: 999,
        assign: ['新班'], code: 'NEW-CODE', maintainer: [10], langs: ['cc.cc20'], contestDuration: 1.5,
        allowPrint: true, keepScoreboardHidden: true }), { uid: 9, permissions: ['CREATE_CONTEST', 'EDIT_CONTEST'] }));
    assert.notEqual(String(created.docId), SOURCE_ID); assert.equal(created.owner, 9); assert.equal(created.attend, 0);
    assert.equal(created.title, '新比赛'); assert.equal(created.content, '新说明'); assert.deepEqual(created.pids, [3, 1, 9]);
    assert.equal(created.endAt.toISOString(), '2026-10-05T17:06:00.000Z'); assert.equal(created.duration, 1.5);
    assert.deepEqual(created.score, { 1: 50, 3: 200 }); assert.deepEqual(created.balloon, { 1: { color: 'red', name: '红色' } });
    assert.deepEqual(created.assign, ['新班']); assert.equal(created._code, 'NEW-CODE'); assert.deepEqual(created.maintainer, [10]);
    assert.deepEqual(created.langs, ['cc.cc20']); assert.equal(created.allowPrint, true); assert.equal(created.keepScoreboardHidden, true);
    for (const key of ['files', 'journal', 'stat', 'unlocked', 'copyFrom']) assert.equal(created[key], undefined);
    assert.equal(JSON.stringify(doc), before); assert.deepEqual(f.checked, [[3, 1, 9]]);
});

test('score/balloon copying filters removed PIDs, malformed settings and extra metadata without mutating source', async () => {
    const doc = source({ pids: [1, 2, 3, 4, 5, 6], score: { 1: 20, 2: -1, 3: 0, 4: 1.5, 5: NaN, 6: 30, 99: 99 },
        balloon: { 1: { color: 'red', name: '红色', private: 'do-not-copy' }, 2: 'blue', 3: { color: 'red' }, 4: 1, 5: null, 6: 'green', 99: 'black' } });
    const f = harness([doc]), h = f.make(fields({ copyFrom: SOURCE_ID }));
    h.postUpdate = () => { const data = { pids: [1, 2, 3, 4, 5, 99] }; f.plugin.copyProblemSettings(data); return data; };
    await f.plugin.prepareContestUpdate(h); const result = await h.postUpdate();
    assert.deepEqual(result.score, { 1: 20 }); assert.deepEqual(result.balloon, { 1: { color: 'red', name: '红色' }, 2: 'blue' });
    assert.equal(doc.balloon[1].private, 'do-not-copy'); assert.notEqual(result.balloon[1], doc.balloon[1]);
});

test('AsyncLocalStorage keeps overlapping copies isolated and never affects unrelated creation or later requests', async () => {
    const f = harness([source(), source({ docId: new ObjectId(SECOND_ID), score: { 1: 777 }, balloon: { 1: 'second' } })]);
    let release; const gate = new Promise(resolve => { release = resolve; });
    function prepare(copyFrom) {
        const h = f.make(fields({ copyFrom }));
        h.postUpdate = async function () { await gate; await Promise.resolve(); const data = { pids: [1] }; f.plugin.copyProblemSettings(data); return data; };
        return h;
    }
    const first = prepare(SOURCE_ID), second = prepare(SECOND_ID), plain = prepare(undefined);
    await Promise.all([first, second, plain].map(h => f.plugin.prepareContestUpdate(h)));
    const pending = [first.postUpdate(), second.postUpdate(), plain.postUpdate()]; release();
    const [a, b, c] = await Promise.all(pending);
    assert.deepEqual(a.score, { 1: 50 }); assert.deepEqual(b.score, { 1: 777 }); assert.equal(c.score, undefined);
    assert.deepEqual(b.balloon, { 1: 'second' });
    const later = { pids: [1] }; f.plugin.copyProblemSettings(later); assert.deepEqual(later, { pids: [1] });
});

test('failed copied creation clears its async context without changing the source', async () => {
    const doc = source(), before = JSON.stringify(doc), f = harness([doc]), h = f.make(fields({ copyFrom: SOURCE_ID }));
    h.postUpdate = async () => { await Promise.resolve(); throw new Error('native validation failure'); };
    await f.plugin.prepareContestUpdate(h); await assert.rejects(h.postUpdate(), /native validation failure/);
    const later = { pids: [1] }; f.plugin.copyProblemSettings(later);
    assert.deepEqual(later, { pids: [1] }); assert.equal(JSON.stringify(doc), before); assert.equal(f.writes.length, 0);
});

test('strict dates retain local timezone and minute precision, including leap days and the year 2100', () => {
    const { plugin } = harness();
    assert.equal(plugin.parseContestTime('2028-2-29', '1:01', 'Asia/Shanghai').toISOString(), '2028-02-28T17:01:00.000Z');
    assert.equal(plugin.parseContestTime('2100-01-01', '00:00', 'Asia/Shanghai').toISOString(), '2099-12-31T16:00:00.000Z');
    const h = { args: fields({ oi33EndAtDate: '2026-10-05', oi33EndAtTime: '15:06' }), user: { timeZone: 'Asia/Shanghai' } };
    plugin.syncContestEndTime(h); assert.equal(h.args.duration, 1 / 60);
});

test('invalid dates, times, partial ending fields and zero/backwards intervals fail closed', () => {
    const { plugin } = harness();
    for (const [date, time, zone = 'Asia/Shanghai'] of [
        ['2026-02-29', '12:00'], ['2100-02-29', '12:00'], ['2026-04-31', '12:00'], ['2026-00-01', '12:00'],
        ['2026-13-01', '12:00'], ['2026-10-05', '24:00'], ['2026-10-05', '23:60'], ['2026-10-05', '15:05:30'],
        ['2026-10-05', '15:5'], ['2026/10/05', '15:05'], [' 2026-10-05', '15:05'], [null, '15:05'],
        ['2026-10-05', null], ['2026-10-05', '15:05', 'Not/AZone'],
    ]) assert.throws(() => plugin.parseContestTime(date, time, zone), ValidationError, `${date} ${time} ${zone}`);
    for (const ending of [{ oi33EndAtDate: '2026-10-05' }, { oi33EndAtTime: '15:06' },
        { oi33EndAtDate: '2026-10-05', oi33EndAtTime: '15:05' }, { oi33EndAtDate: '2026-10-04', oi33EndAtTime: '15:06' }]) {
        assert.throws(() => plugin.syncContestEndTime({ args: fields(ending), user: { timeZone: 'Asia/Shanghai' } }), ValidationError);
    }
});

test('DST nonexistent local times reject while forward/backward transitions use elapsed hours', () => {
    const { plugin } = harness();
    assert.throws(() => plugin.parseContestTime('2026-03-08', '02:30', 'America/New_York'), ValidationError);
    for (const [date, begin, end, hours] of [['2026-03-08', '01:30', '03:30', 1], ['2026-11-01', '00:30', '02:30', 3]]) {
        const h = { args: fields({ beginAtDate: date, beginAtTime: begin, oi33EndAtDate: date, oi33EndAtTime: end }), user: { timeZone: 'America/New_York' } };
        plugin.syncContestEndTime(h); assert.equal(h.args.duration, hours);
    }
});

test('legacy duration-based clients and non-update operations retain native behavior', async () => {
    const f = harness(), legacy = f.make(fields({ duration: 1.25 }));
    const created = await f.save(legacy); assert.equal(created.endAt.toISOString(), '2026-10-05T08:20:00.000Z');
    const h = f.make({ operation: 'delete', copyFrom: 'invalid', oi33EndAtDate: 'invalid' });
    const before = h.postUpdate; await f.plugin.prepareContestUpdate(h); assert.equal(h.postUpdate, before);
    assert.equal(h.args.duration, undefined);
});

test('editing an ended contest changes its end instant through native edit and status recalculation', async () => {
    const f = harness([source({ beginAt: new Date('2020-01-01T00:00:00Z'), endAt: new Date('2020-01-01T02:00:00Z') })]);
    const updated = await f.save(f.make(fields({ tid: SOURCE_ID, oi33EndAtDate: '2100-01-01', oi33EndAtTime: '00:00' }), { params: { tid: SOURCE_ID } }));
    assert.equal(String(updated.docId), SOURCE_ID); assert.equal(updated.endAt.toISOString(), '2099-12-31T16:00:00.000Z');
    assert.equal(f.writes.filter(([operation]) => operation === 'add').length, 0);
    assert.equal(f.writes.filter(([operation]) => operation === 'recalc').length, 1);
    assert.equal(f.scheduled[0][0], 'delete');
});

test('copy links use GET create URLs; copied form has CSRF and no original file/delete controls', () => {
    const file = read('templates/contest_edit.html'), sidebar = read('templates/partials/contest_sidebar.html');
    for (const template of [file, sidebar]) {
        assert.match(template, /<a[^>]+href="\{\{ url\('contest_create', query=\{copyFrom:tdoc\.docId\}\) \}\}"[^>]*>[\s\S]*?复制比赛[\s\S]*?<\/a>/);
        assert.doesNotMatch(template, /name="operation"\s+value="copy"/);
    }
    class Loader extends nunjucks.FileSystemLoader {
        getSource(name) {
            if (name === 'layout/basic.html') return { src: '{% import "components/form.html" as form with context %}{% block content %}{% endblock %}', path: name };
            if (name === 'components/md_hint.html') return { src: '', path: name };
            return super.getSource(name);
        }
    }
    const env = new nunjucks.Environment(new Loader([path.join(root, 'templates'), path.join(root, 'node_modules/@hydrooj/ui-default/templates')]), { autoescape: true });
    env.addFilter('json', JSON.stringify);
    env.addFilter('assign', (value, extra) => Object.assign({}, value, extra));
    const draft = harness().plugin.contestCopyDraft(source());
    const html = env.render('contest_edit.html', { tdoc: draft, beginAt: moment(draft.beginAt), duration: 7, rules: { ioi: 'IOI' }, pids: '1,2,3',
        oi33CopyFrom: SOURCE_ID, oi33EndAtDate: '2026-10-05', oi33EndAtTime: '22:05', page_name: 'contest_create', csrfToken: 'safe-csrf',
        handler: { user: { hasPerm: () => true, own: () => true } }, perm: PERM,
        _: value => Object.assign(new String(value), { format: () => value }), url: () => '/contest/create' });
    assert.match(html, /name="csrfToken" value="safe-csrf"/); assert.match(html, /name="copyFrom" value="6ac34c25763c33ec05262ed0"/);
    assert.doesNotMatch(html, /value="delete"|name="upload_file"|file-private/);
    for (const name of ['oi33EndAtDate', 'oi33EndAtTime']) {
        const input = html.match(new RegExp(`<input[^>]+name="${name}"[^>]*>`));
        assert.ok(input, `${name} input rendered`); assert.doesNotMatch(input[0], /readonly|disabled/);
    }
});

test('sidebar copy action matches create/source-edit permission combinations and remains a plain GET link', () => {
    class Loader extends nunjucks.FileSystemLoader {
        getSource(name) {
            if (name === 'components/user.html') return { src: '{% macro render_inline(user, badge=false) %}owner{% endmacro %}', path: name };
            if (name === 'components/contest.html') return { src: '{% macro render_time(value) %}time{% endmacro %}{% macro render_duration(doc) %}7{% endmacro %}', path: name };
            return super.getSource(name);
        }
    }
    const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
    const cases = [
        [true, ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], true], [false, ['CREATE_CONTEST', 'EDIT_CONTEST'], true],
        [true, ['CREATE_CONTEST'], false], [true, ['CREATE_CONTEST', 'EDIT_CONTEST'], false],
        [false, ['CREATE_CONTEST', 'EDIT_CONTEST_SELF'], false], [true, ['EDIT_CONTEST_SELF'], false],
        [false, ['EDIT_CONTEST'], false], [false, [], false],
    ];
    for (const [owns, permissions, visible] of cases) {
        const html = env.render('partials/contest_sidebar.html', { page_name: 'contest_detail', tdoc: source(), tsdoc: { attend: true },
            handler: { user: { own: () => owns, hasPerm: permission => permissions.includes(permission), hasPriv: () => false } },
            perm: PERM, PRIV: {}, _: value => value,
            model: { contest: { isDone: () => true, isOngoing: () => false, canShowScoreboard: { call: () => true },
                canShowRecord: { call: () => false }, canShowSelfRecord: { call: () => false }, statusText: () => 'Ended', RULES: { ioi: { TEXT: 'IOI' } } } },
            url: (name, values) => name === 'contest_create' ? `/contest/create?copyFrom=${values.query.copyFrom}` : `/${name}` });
        assert.equal(html.includes('复制比赛'), visible, `own=${owns}; perms=${permissions.join(',')}`);
        if (visible) assert.match(html, /<a class="menu__link" href="\/contest\/create\?copyFrom=6ac34c25763c33ec05262ed0">/);
        assert.doesNotMatch(html, /value="copy"/);
    }
});
