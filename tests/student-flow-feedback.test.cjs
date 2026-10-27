const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
function load(name) {
    const mod = { exports: {} };
    const code = esbuild.transformSync(fs.readFileSync(path.join(__dirname, '../handler', name), 'utf8'), {loader:'ts',format:'cjs'}).code;
    new Function('module','exports', code)(mod, mod.exports);
    return mod.exports;
}
const { installRecordQueueDelivery } = load('record-delivery.ts');
const { installLoginFeedback } = load('login-feedback.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('record queue retains same-rid final updates arriving during asynchronous sends and serializes concurrent drains', async () => {
    const received = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = {constructor:{name:'RecordMainConnectionHandler'},queue:new Map(),send:async value => {
        if(value.status === 21) await gate;
        received.push(value);
    }};
    installRecordQueueDelivery(h);
    h.queue.set('r1', async()=>({rid:'r1',status:21}));
    const first = h.queueClear();
    await tick();
    h.queue.set('r1', async()=>({rid:'r1',status:1}));
    h.queue.set('r2', async()=>({rid:'r2',status:2}));
    const second = h.queueClear();
    release();
    await Promise.all([first,second]);
    assert.deepEqual(received,[{rid:'r1',status:21},{rid:'r1',status:1},{rid:'r2',status:2}]);
    assert.equal(h.queue.size,0);
    h.queue.set('r3', async()=>({rid:'r3',status:7}));
    await h.queueClear();
    assert.equal(received.at(-1).rid,'r3');
});

test('record delivery keeps the current permission-checked send and does not patch other connection types', async () => {
    const old = () => {};
    const other = {constructor:{name:'RecordDetailConnectionHandler'},queue:new Map(),queueClear:old};
    installRecordQueueDelivery(other);
    assert.equal(other.queueClear,old);
    const h = {constructor:{name:'RecordMainConnectionHandler'},queue:new Map()};
    installRecordQueueDelivery(h);
    const wrapped = h.queueClear;
    installRecordQueueDelivery(h);
    assert.equal(h.queueClear,wrapped);
    h.send = async()=>{ throw Error('session revoked'); };
    h.queue.set('r',async()=>({status:1}));
    await assert.rejects(h.queueClear(),/session revoked/);
});

test('queue drain catches a terminal update arriving between completion and finalization', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const received = [];
    const h = {constructor:{name:'RecordMainConnectionHandler'},queue:new Map(),send:async value => {
        received.push(value); if(value === 21) await gate;
    }};
    installRecordQueueDelivery(h);
    h.queue.set('old',async()=>21);
    const done = h.queueClear();
    await tick();
    const arrival = gate.then(()=>{}).then(()=>{
        h.queue.set('new',async()=>1); return h.queueClear();
    });
    release();
    await Promise.all([done,arrival]);
    assert.deepEqual(received,[21,1]);
    assert.equal(h.queue.size,0);
});

test('failed payload preserves unsent records and newer versions without automatic retry loops', async () => {
    const received = [];
    const h = {constructor:{name:'RecordMainConnectionHandler'},queue:new Map(),send:async value=>received.push(value)};
    installRecordQueueDelivery(h);
    h.queue.set('a',async()=>{ h.queue.set('a',async()=>1); throw Error('render failed'); });
    h.queue.set('b',async()=>2);
    await assert.rejects(h.queueClear(),/render failed/);
    assert.equal(h.queue.size,2);
    assert.deepEqual(received,[]);
    await h.queueClear();
    assert.deepEqual(received,[1,2]);
    assert.equal(h.queue.size,0);
});

function loginHandler(extra = {}) {
    return {constructor:{name:'UserLoginHandler'}, request:{method:'POST',headers:{accept:'text/html'}},
        args:{uname:'student-name',password:'never-render-this-password',rememberme:'true',redirect:'/homework'},
        loginMethods:[], response:{addHeader(){}}, async onerror(error) {
            this.nativeErrors = (this.nativeErrors || 0) + 1;
            this.response.status = 403;
            this.response.template = 'error.html';
            this.response.body = {error};
        },...extra};
}
test('HTML password failure returns a retryable form without credentials or technical errors', async () => {
    for(const name of ['LoginError','UserNotFoundError','InvalidTokenError']) {
        const h=loginHandler(); installLoginFeedback(h);
        await h.onerror({name,message:'private stack',params:['private token']});
        assert.equal(h.nativeErrors,1);
        assert.equal(h.response.template,'user_login.html');
        assert.equal(h.response.status,403);
        assert.equal(h.response.body.loginUsername,'student-name');
        assert.equal(h.response.body.redirect,'/homework');
        assert.equal(h.response.body.loginRemember,true);
        assert.doesNotMatch(JSON.stringify(h.response.body),/never-render|private|LoginError/);
    }
});
test('API errors, unexpected failures, GETs and unrelated handlers keep native behavior', async () => {
    for(const extra of [
        {request:{method:'POST',json:true,headers:{accept:'text/html'}}},
        {request:{method:'POST',headers:{accept:'application/json'}}},
        {request:{method:'GET',headers:{accept:'text/html'}}},
        {constructor:{name:'UserSudoHandler'}},
    ]) {
        const h=loginHandler(extra); installLoginFeedback(h); await h.onerror({name:'LoginError'});
        assert.equal(h.response.template,'error.html');
    }
    const h=loginHandler(); installLoginFeedback(h); await h.onerror({name:'InternalError'});
    assert.equal(h.response.template,'error.html');
});

test('installed native login and native error handler retain password, MFA, rate limits and successful redirects', async () => {
    const read = name => fs.readFileSync(path.join(__dirname, '../node_modules/hydrooj/src', name), 'utf8');
    const userSource = read('handler/user.ts'), serverSource = read('service/server.ts');
    const loginSource = userSource.slice(userSource.indexOf('class UserLoginHandler'), userSource.indexOf('class UserSudoHandler'));
    const errorSource = serverSource.slice(serverSource.indexOf('server.httpHandlerMixin({') + 'server.httpHandlerMixin('.length,
        serverSource.indexOf('server.wsHandlerMixin({')).trim().replace(/;$/, '');
    class UserFacingError extends Error { constructor(name) { super(name); this.name = name; this.code = 403; this.params = []; } }
    class LoginError extends UserFacingError { constructor() { super('LoginError'); } }
    class InvalidTokenError extends UserFacingError { constructor() { super('InvalidTokenError'); } }
    const limits = [], passwords = [];
    const student = { _id: 42, tfa: false, authn: false, _tfa: 'secret', hasPriv: () => true,
        async checkPassword(password) { passwords.push(password); if (password !== 'correct-secret') throw new LoginError(); } };
    const deps = { Handler: class {}, param: () => () => {}, Types: {}, PRIV: {},
        system: { get: name => name === 'server.login' }, user: { getByEmail: async () => null, getByUname: async () => student },
        oplog: { log: async () => {} }, verifyTFA: (_, code) => code === '654321', InvalidTokenError,
        successfulAuth: async function (user) { this.user = user; }, UserFacingError,
        NotFoundError: class extends Error {}, PermissionError: class extends Error {}, PrivilegeError: class extends Error {},
        logger: { error() {} }, errorMessage: value => value };
    const names = Object.keys(deps).join(',');
    const source = `const {${names}} = deps;\n${loginSource}\nconst mixin = ${errorSource.slice(0, -1)};\nmodule.exports = { UserLoginHandler, mixin };`;
    const mod = { exports: {} };
    const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }).code;
    new Function('deps', 'module', code)(deps, mod);
    const h = new mod.exports.UserLoginHandler();
    Object.assign(h, { args: { uname: 'student-name', password: 'wrong-secret', redirect: '/homework' },
        user: { _id: 0, uname: 'Guest', _dudoc: { join: true } }, domain: { _id: 'system' }, session: {}, loginMethods: [],
        request: { method: 'POST', headers: { accept: 'text/html' }, path: '/login', referer: '/login' },
        response: { addHeader() {} }, url: () => '/', limitRate: async (...args) => limits.push(args), onerror: mod.exports.mixin.onerror });
    installLoginFeedback(h);
    let failure;
    try { await h.post('system', 'student-name', 'wrong-secret', false, '/homework'); } catch (error) { failure = error; }
    await h.onerror(failure);
    assert.equal(h.response.status, 403);
    assert.equal(h.response.template, 'user_login.html');
    assert.deepEqual(limits.map(row => row[0]), ['user_login', 'user_login_id']);
    assert.doesNotMatch(JSON.stringify(h.response.body), /wrong-secret|correct-secret/);
    student.tfa = true;
    await assert.rejects(h.post('system', 'student-name', 'correct-secret', false, '/homework', 'bad'), InvalidTokenError);
    assert.deepEqual(passwords, ['wrong-secret'], 'MFA is checked before password authentication');
    await h.post('system', 'student-name', 'correct-secret', true, '/homework', '654321');
    assert.equal(h.user._id, 42);
    assert.equal(h.session.save, true);
    assert.equal(h.response.redirect, '/homework');
});
