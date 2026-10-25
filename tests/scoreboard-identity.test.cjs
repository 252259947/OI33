const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { AsyncLocalStorage } = require('node:async_hooks');
const { transformSync } = require('esbuild');
const { stringify: toCSV } = require('csv-stringify/sync');
const root = path.resolve(__dirname, '..');
const privateInfo = 8n;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(source, imports) {
    const mod = { exports: {} };
    const requireMock = name => { if (!(name in imports)) throw Error(`Unexpected import: ${name}`); return imports[name]; };
    new Function('require', 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(requireMock, mod, mod.exports);
    return mod.exports;
}
function collection(docs, queries) {
    return { find(query) {
        const entry = { query }; queries.push(entry);
        return { project(projection) { entry.projection = projection; return this; }, async toArray() {
            return docs.filter(doc => Object.entries(query).every(([key, value]) => value?.$in ? value.$in.includes(doc[key]) : doc[key] === value))
                .map(doc => Object.fromEntries(Object.keys(entry.projection).filter(key => key in doc).map(key => [key, doc[key]])));
        } };
    } };
}
function fixture() {
    const enrollment = [
        { _id: 17, domainId: 'school', status: 'approved', realName: ' 学生甲 ', studentId: 'private-id', school: 'private-school', rejectionReason: 'private-reason' },
        { _id: 18, domainId: 'school', status: 'pending', realName: '待审姓名' },
        { _id: 19, domainId: 'school', status: 'rejected', realName: '拒绝姓名' },
        { _id: 20, domainId: 'foreign', status: 'approved', realName: '其他域姓名' },
        { _id: 21, domainId: 'school', status: 'approved', realName: '   ' },
        { _id: 22, domainId: 'school', status: 'approved', realName: '学生甲', enabled: false, accountType: 'temporary', validUntil: new Date(0) },
        { _id: 23, domainId: 'school', status: 'approved', realName: '=1+1' },
        { _id: 24, domainId: 'school', status: 'approved', realName: '<img src=x onerror=alert(1)>' },
        { _id: 25, domainId: 'school', status: 'approved', realName: '控制\n字符' },
        { _id: 26, domainId: 'school', status: 'approved', realName: '长'.repeat(81) },
    ];
    const legacy = Array.from({ length: 20 }, (_, i) => ({ _id: 17 + i, realname_flag: 1, realname_name: `旧姓名${17 + i}`, hash: 'private-hash' }));
    legacy.find(doc => doc._id === 29).realname_flag = 0;
    legacy.find(doc => doc._id === 30).realname_flag = 3;
    const members = [27, 29, 30].map(uid => ({ uid, domainId: 'school', join: true }));
    members.push({ uid: 28, domainId: 'foreign', join: true }, { uid: 31, domainId: 'school', join: false });
    const queries = { enrollment: [], legacy: [], members: [] };
    const model = compile(read('model/scoreboard-identity.ts'), {
        hydrooj: { DomainModel: { collUser: collection(members, queries.members) } },
        './enrollment': { enrollmentColl: collection(enrollment, queries.enrollment) },
        './user': { userColl: collection(legacy, queries.legacy) },
    });
    const handler = compile(read('handler/scoreboard-identity.ts'), {
        hydrooj: { PERM: { PERM_VIEW_USER_PRIVATE_INFO: privateInfo } }, 'node:async_hooks': { AsyncLocalStorage },
        'hydrooj/src/lib/avatar': value => `https://avatar.invalid/${require('node:crypto').createHash('md5').update(value).digest('hex')}`,
        '../model/education-auth': { isEducationCoach: user => user?.role === 'coach' || user?.role === 'root' },
        '../model/scoreboard-identity': model,
    });
    return { model, handler, queries, enrollment, legacy };
}
const users = ids => Object.fromEntries(ids.map(uid => [uid, Object.freeze({ _id: uid, uname: `user${uid}`, realname_flag: 1 })]));
const scoreboard = ids => [[{ type: 'rank', value: '排名' }, { type: 'user', value: '用户' }, { type: 'score', value: '得分' }],
    ...ids.map((uid, i) => [Object.freeze({ type: 'rank', value: i + 1 }), { type: 'user', raw: uid, value: `user${uid}` },
        Object.freeze({ type: 'record', raw: `record${uid}`, score: 100, value: '100\n00:10' })])];

test('approved same-domain enrollment is authoritative; pending/rejected/foreign never fall back', async () => {
    const { model } = fixture();
    const names = await model.getScoreboardRealNames('school', Array.from({ length: 15 }, (_, i) => 17 + i));
    assert.deepEqual(names, { 17: '学生甲', 22: '学生甲', 23: '=1+1', 24: '<img src=x onerror=alert(1)>', 27: '旧姓名27', 30: '旧姓名30' });
    assert.equal(names[17], names[22], 'Duplicate names must not merge user IDs');
    assert.equal(names[22], '学生甲', 'Expiry/disable does not revoke historical identity verification');
});

test('projected read-only queries expose no school/student ID/history or global User fields', async () => {
    const { model, queries, enrollment, legacy } = fixture();
    const before = JSON.stringify({ enrollment, legacy });
    const names = await model.getScoreboardRealNames('school', [17, 17, 18, 27, 28, NaN, 0, -1]);
    assert.deepEqual(names, { 17: '学生甲', 27: '旧姓名27' });
    assert.deepEqual(queries.enrollment[0].projection, { _id: 1, domainId: 1, status: 1, realName: 1 });
    assert.deepEqual(queries.legacy[0].query, { _id: { $in: [27] } });
    assert.equal(JSON.stringify(names).includes('private'), false);
    assert.equal(JSON.stringify({ enrollment, legacy }), before);
    await model.getScoreboardRealNames('school', []);
    await model.getScoreboardRealNames('', [17]);
    assert.equal(queries.enrollment.length, 1);
});

test('contest/homework scoreboards change approved name labels only, not user objects or score cells', async () => {
    const { handler } = fixture();
    for (const rule of ['homework', 'acm', 'oi', 'ioi', 'oc']) {
        const rows = scoreboard([17, 18, 22]), udict = Object.freeze(users([17, 18, 22]));
        const before = JSON.stringify(udict), scores = rows.slice(1).map(row => row[2]);
        await handler.applyScoreboardNames({ domainId: 'school', rule }, rows, udict);
        assert.equal(rows[1][1].value, '学生甲'); assert.equal(rows[1][1].oi33RealName, '学生甲');
        assert.equal(rows[2][1].value, 'user18'); assert.equal(rows[2][1].oi33RealName, undefined);
        assert.deepEqual(rows.slice(1).map(row => row[1].raw), [17, 18, 22]);
        assert.deepEqual(rows.slice(1).map(row => row[2]), scores);
        assert.equal(rows[0][1].value, '用户'); assert.equal(JSON.stringify(udict), before);
    }
});

test('training names are limited to the native visible member list and trusted document domain', async () => {
    const { handler, queries } = fixture();
    const body = { tdoc: { domainId: 'school' }, udict: users([17, 18]), udoc: { _id: 30, uname: '作者昵称' } };
    const headers = {};
    await handler.applyTrainingNames({ domain: { _id: 'school' }, args: { domainId: 'foreign', uid: 30 },
        response: { body, addHeader: (key, value) => { headers[key] = value; } } });
    assert.deepEqual(body.oi33TrainingNames, { 17: '学生甲' });
    assert.equal(body.udoc.uname, '作者昵称'); assert.equal(body.udict[17].uname, 'user17');
    assert.equal(headers['Cache-Control'], 'private, no-store');
    const foreign = { tdoc: { domainId: 'foreign' }, udict: users([17]) };
    await handler.applyTrainingNames({ domain: { _id: 'school' }, response: { body: foreign } });
    assert.equal(foreign.oi33TrainingNames, undefined);
    assert.equal(queries.enrollment.length, 1);
});

test('native CSV exporter stays intact, escapes formula names and isolates concurrent HTML requests', async () => {
    const { handler, enrollment } = fixture();
    for (const [i, name] of ['=1+1', '+CMD', '-CMD', '@SUM(1)', '姓名,带逗号', '姓名"引号', '＝1+1', '＋CMD', '－CMD', '＠SUM(1)'].entries()) {
        enrollment.push({ _id: 40 + i, domainId: 'school', status: 'approved', realName: name });
    }
    const ids = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49], udict = users(ids), hooks = {};
    const contestSource = read('node_modules/hydrooj/src/handler/contest.ts');
    const nativeCsv = contestSource.slice(contestSource.indexOf("scoreboard.addView('csv'"));
    const displaySource = nativeCsv.slice(nativeCsv.indexOf('async display'), nativeCsv.indexOf('supportedRules')).trim().replace(/,$/, '');
    const contest = { getScoreboard: async () => { const rows = scoreboard(ids); await hooks['contest/scoreboard']({ domainId: 'school' }, rows, udict); return [{}, rows]; } };
    // The native method's free identifiers are supplied without modifying its body.
    const csvModule = { exports: {} };
    new Function('contest', 'toCSV', 'PERM', 'module', 'exports', transformSync(`export const view = { ${displaySource} };`, { loader: 'ts', format: 'cjs' }).code)
        (contest, toCSV, { PERM_VIEW_USER_PRIVATE_INFO: privateInfo }, csvModule, csvModule.exports);
    const view = csvModule.exports.view, original = view.display;
    handler.apply({ on: (name, fn) => { hooks[name] = fn; } });
    let csv, limited = 0;
    const h = { args: { view: 'csv' }, get(args) { return view.display.call(this, args); },
        tdoc: { domainId: 'school', _id: 'tid', title: '作业' }, user: { hasPerm: () => false },
        limitRate: async (name, seconds, count) => { assert.deepEqual([name, seconds, count], ['scoreboard_download', 60, 3]); limited++; },
        binary: (content, filename) => { csv = content; assert.equal(filename, '作业.csv'); } };
    const htmlRows = scoreboard(ids);
    hooks['handler/before/ContestScoreboard#get'](h);
    const wrapped = h.get;
    hooks['handler/before/ContestScoreboard#get'](h);
    assert.equal(h.get, wrapped);
    await Promise.all([h.get({ tdoc: h.tdoc }), handler.applyScoreboardNames(h.tdoc, htmlRows, udict)]);
    assert.equal(limited, 1);
    for (const name of ['=1+1', '+CMD', '-CMD', '@SUM(1)', '＝1+1', '＋CMD', '－CMD', '＠SUM(1)']) assert.ok(csv.includes(`'${name}`));
    assert.ok(csv.includes('"姓名,带逗号"')); assert.ok(csv.includes('"姓名""引号"'));
    assert.equal(htmlRows[1][1].value, '=1+1');
    const expectedRows = scoreboard(ids);
    expectedRows.slice(1).forEach((row, i) => { const name = enrollment.find(doc => doc._id === ids[i]).realName;
        row[1].value = /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(name) ? `'${name}` : name; });
    assert.equal(csv, toCSV(expectedRows.map(row => row.map(cell => cell.value.toString())), { bom: true }));
    assert.ok(hooks['handler/after/ContestScoreboard#get']);
    assert.equal(Object.keys(hooks).some(key => /UserDetail|Record|Article/.test(key)), false);
    assert.equal(view.display, original, 'Global/native view is never modified');
    h.limitRate = async () => { throw Error('rate limited'); };
    await assert.rejects(() => h.get({ tdoc: h.tdoc }), /rate limited/);
});

test('native HTML and CSV exports suppress only student private columns and restore request users', async () => {
    const { handler } = fixture();
    const source = read('node_modules/hydrooj/src/handler/contest.ts');
    const cases = [];
    for (const viewId of ['html', 'csv']) {
        const viewSource = source.slice(source.indexOf(`scoreboard.addView('${viewId}'`));
        const display = viewSource.slice(viewSource.indexOf('async display'), viewSource.indexOf('supportedRules')).trim().replace(/,$/, '');
        const native = compile(`const {contest,toCSV,PERM}=require('native'); export const view={${display}};`, {
            native: { toCSV, PERM: { PERM_VIEW_USER_PRIVATE_INFO: privateInfo }, contest: {
                async getScoreboard(_domain, _tid, config) {
                    const row = ['学生甲', ...(config.showDisplayName ? ['private@example.test', '学校', '别名', '学号'] : []), '73'];
                    return [{}, [row.map(value => ({ value }))]];
                },
            } },
        });
        for (const role of ['student', 'coach', 'root']) {
            const user = Object.freeze({ _id: 17, role, perm: 15n,
                hasPerm(...permissions) { return permissions.some(permission => (this.perm & permission) === permission); } });
            let output;
            const h = { args: { view: viewId }, tdoc: { domainId: 'school', _id: 'tid', title: 'Fixture' }, user,
                async get() {
                    await Promise.resolve(); // Exercise concurrent AsyncLocalStorage/request scopes.
                    assert.equal(this.user.hasPerm(2n), true);
                    assert.equal(this.user.hasPerm(privateInfo | 2n), role !== 'student');
                    assert.equal(this.user.hasPerm(privateInfo, 2n), true, 'native OR permission semantics remain intact');
                    return native.view.display.call(this, { tdoc: this.tdoc });
                },
                limitRate: async () => {}, renderHTML: async (_template, data) => JSON.stringify(data.rows),
                binary: content => { output = content; } };
            handler.wrapScoreboardRequest(h);
            cases.push((async () => {
                await h.get();
                assert.equal(output.includes('private@example.test'), role !== 'student');
                assert.equal(output.includes('学生甲'), true);
                assert.equal(output.includes('73'), true);
                assert.equal(h.user, user);
                assert.equal(user.hasPerm(privateInfo), true, 'cached user permissions remain unchanged');
                h.limitRate = async () => { throw Error('rate limited'); };
                await assert.rejects(() => h.get(), /rate limited/);
                assert.equal(h.user, user, 'failure restores the request user');
            })());
        }
    }
    await Promise.all(cases);
    for (const view of ['default', 'ghost']) {
        const user = { _id: 17, role: 'student', hasPerm: () => true };
        const h = { args: { view }, user, async get() { assert.equal(this.user, user); } };
        handler.wrapScoreboardRequest(h); await h.get();
    }
});

test('student scoreboard and training JSON use private-field-free copies without losing verified score labels', () => {
    const { handler } = fixture();
    const original = { _id: 17, uname: 'student_login', mail: 'private@example.test', school: '学校', studentId: '学号',
        displayName: '别名', realname_name: '学生甲', avatar: 'gravatar:private@example.test', realname_flag: 1 };
    const before = JSON.stringify(original);
    const rows = scoreboard([17]); rows[1][1].oi33RealName = '学生甲';
    const names = { 17: '学生甲' };
    const body = { tdoc: { domainId: 'school' }, udict: { 17: original }, udoc: original, rows, oi33TrainingNames: names };
    handler.sanitizeStudentScoreboardUsers({ user: { _id: 18, role: 'student' }, domain: { _id: 'school' }, response: { body } });
    for (const user of [body.udict[17], body.udoc]) {
        assert.notEqual(user, original);
        assert.equal(user.uname, 'student_login'); assert.equal(user._id, 17); assert.equal(user.realname_flag, 1);
        for (const key of ['mail', 'school', 'studentId', 'displayName', 'realname_name']) assert.equal(user[key], '');
        assert.equal(JSON.stringify(user).includes('private@example.test'), false);
        assert.match(user.avatar, /^url:https:\/\/avatar.invalid\//);
    }
    assert.equal(body.rows, rows); assert.equal(rows[1][1].oi33RealName, '学生甲'); assert.equal(body.oi33TrainingNames, names);
    assert.equal(JSON.stringify(original), before);
    for (const role of ['coach', 'root']) {
        const body = { tdoc: { domainId: 'school' }, udict: { 17: original } };
        handler.sanitizeStudentScoreboardUsers({ user: { _id: 18, role }, domain: { _id: 'school' }, response: { body } });
        assert.equal(body.udict[17], original); assert.equal(body.udict[17].mail, 'private@example.test');
    }
});

test('native hidden-scoreboard check still rejects before the name lookup event', async () => {
    const { handler, queries } = fixture();
    const source = read('node_modules/hydrooj/src/model/contest.ts');
    const method = source.slice(source.indexOf('export async function getScoreboard('), source.indexOf('export function addClarification('));
    let allowed = false, emitted = 0;
    const tdoc = { domainId: 'school', _id: 'tid', rule: 'homework', pids: [1] };
    const imports = { get: async () => tdoc, canShowScoreboard: () => allowed,
        ContestScoreboardHiddenError: Error, getMultiStatus: () => ({ sort: () => ({}) }),
        problem: { getList: async () => ({}) }, RULES: { homework: { statusSort: {}, scoreboard: async () => [scoreboard([17]), users([17])] } },
        bus: { parallel: async (event, ...args) => { assert.equal(event, 'contest/scoreboard'); emitted++; await handler.applyScoreboardNames(...args); } } };
    const prefix = Object.keys(imports).map(key => `const ${key}=require('native').${key};`).join('\n');
    const native = compile(prefix + '\n' + method, { native: imports });
    const h = { translate: text => text };
    await assert.rejects(() => native.getScoreboard.call(h, 'school', 'tid', {}));
    assert.equal(emitted, 0); assert.equal(queries.enrollment.length, 0);
    allowed = true;
    const result = await native.getScoreboard.call(h, 'school', 'tid', {});
    assert.equal(result[1][1][1].value, '学生甲'); assert.equal(emitted, 1);
    assert.ok(read('index.ts').includes('applyScoreboardIdentity(ctx)'));
});
