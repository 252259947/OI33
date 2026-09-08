const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const { transformSync } = require('esbuild');
const Koa = createRequire(require.resolve('@hydrooj/framework/package.json'))('koa');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'handler/mobile-access.ts');
class ForbiddenError extends Error { constructor(message) { super(message); this.status = 403; } }
const mod = { exports: {} };
new Function('module', 'exports', 'require', transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs',
}).code)(mod, mod.exports, (name) => {
    assert.equal(name, 'hydrooj');
    return { ForbiddenError };
});
const { isPhoneBrowser, enforceMobileAccess, apply } = mod.exports;
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

test('phone detection covers iPhone, Android, WeChat, QQ and common older phone browsers', () => {
    const phones = [iphone, android, `${iphone} MicroMessenger/8.0.50`, `${android} MQQBrowser/15.2 Mobile QQ/9.0`,
        'Mozilla/5.0 (iPod; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
        'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) IEMobile/11.0',
        'Mozilla/5.0 (BB10; Touch) AppleWebKit/537.35 Mobile Safari/537.35',
        'Opera/9.80 (J2ME/MIDP; Opera Mini/9.0) Presto/2.12.423',
        'Mozilla/5.0 (Mobile; rv:130.0) Gecko/130.0 Firefox/130.0'];
    for (const ua of phones) assert.equal(isPhoneBrowser({ 'user-agent': ua }), true, ua);
});

test('desktop computers, explicit tablets and non-browser service clients are not treated as phones', () => {
    const allowed = [windows,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Linux; Android 11; Tablet) AppleWebKit/537.36 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Kindle Fire) Silk/81.0 Mobile Safari/537.36', '', 'curl/8.0.1', 'node', 'HydroJudge/5.0'];
    for (const ua of allowed) assert.equal(isPhoneBrowser({ 'user-agent': ua }), false, ua);
    assert.equal(isPhoneBrowser(), false);
});

test('mobile client hints identify phones but a false hint cannot override a recognizably mobile UA', () => {
    assert.equal(isPhoneBrowser({ 'user-agent': windows, 'sec-ch-ua-mobile': '?1' }), true);
    assert.equal(isPhoneBrowser({ 'user-agent': android, 'sec-ch-ua-mobile': '?0' }), true);
    assert.equal(isPhoneBrowser({ 'user-agent': windows, 'sec-ch-ua-mobile': '?0' }), false);
    assert.equal(isPhoneBrowser({ 'User-Agent': [android], 'Sec-CH-UA-Mobile': ['?1'] }), true);
    assert.equal(isPhoneBrowser({ 'user-agent': windows, 'viewport-width': '320', 'sec-ch-viewport-width': '320' }), false);
});

async function withServer(run) {
    const app = new Koa();
    const reached = [];
    // As in Hydro, genuine cached public assets can be served before the gate.
    app.use(async (c, next) => {
        if (c.path === '/fixture-public.css') { c.type = 'text/css'; c.body = 'body{}'; return; }
        await next();
    });
    app.use(enforceMobileAccess);
    app.use((c) => {
        reached.push({ method: c.method, path: c.path });
        c.vary('Accept-Encoding');
        c.status = 200;
        c.body = { allowed: true };
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await run((route, options = {}) => fetch(`${base}${route}`, options), reached); }
    finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test('real Koa responses block phone GET and every mutation method before business code', async () => {
    await withServer(async (request, reached) => {
        for (const [method, route] of [['GET', '/'], ['GET', '/homework'], ['POST', '/p/P99/submit'],
            ['POST', '/login'], ['PUT', '/article/one'], ['PATCH', '/home/settings/account'], ['DELETE', '/article/one']]) {
            const response = await request(route, { method, headers: { 'user-agent': iphone } });
            assert.equal(response.status, 403, `${method} ${route}`);
            assert.match(response.headers.get('content-type'), /text\/html.*charset=utf-8/i);
            assert.match(response.headers.get('cache-control'), /no-store/);
            assert.match(response.headers.get('vary'), /User-Agent/i);
            assert.match(response.headers.get('vary'), /Sec-CH-UA-Mobile/i);
            const body = await response.text();
            assert.match(body, /请使用电脑访问/);
            assert.doesNotMatch(body, /<script\b|<link\b|<iframe\b|user-agent|p\/P99/);
        }
        assert.deepEqual(reached, []);
    });
});

test('API routes, AJAX, JSON accept and JSON bodies receive a structured 403 with no business side effects', async () => {
    await withServer(async (request, reached) => {
        const cases = [
            ['/api/user', {}], ['/d/school/api/user', {}],
            ['/homework?format=json', { headers: { accept: 'application/json' } }],
            ['/article/new', { headers: { 'x-requested-with': 'XMLHttpRequest' } }],
            ['/api/private.css', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":"delete"}' }],
        ];
        for (const [route, options] of cases) {
            const response = await request(route, { ...options, headers: { 'user-agent': android, ...options.headers } });
            assert.equal(response.status, 403);
            assert.match(response.headers.get('content-type'), /application\/json/);
            assert.deepEqual(await response.json(), { error: { name: 'MobileAccessDenied', code: 'PHONE_BROWSER_UNSUPPORTED', message: '请使用电脑访问 huaji OJ。' } });
        }
        assert.deepEqual(reached, []);
    });
});

test('desktop narrow windows, ordinary desktop requests and UA-less health/judge requests continue unchanged', async () => {
    await withServer(async (request, reached) => {
        const cases = [
            ['/', { 'user-agent': windows, 'viewport-width': '320' }],
            ['/api/health', { 'user-agent': '' }],
            ['/judge', { 'user-agent': 'HydroJudge/5.0' }],
            ['/homework', { 'user-agent': windows, 'sec-ch-ua-mobile': '?0' }],
        ];
        for (const [route, headers] of cases) {
            const response = await request(route, { headers });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { allowed: true });
            assert.equal(response.headers.get('cache-control'), null);
            for (const field of ['Accept-Encoding', 'User-Agent', 'Sec-CH-UA-Mobile']) assert.ok(response.headers.get('vary').includes(field));
        }
        assert.equal(reached.length, cases.length);
    });
});

test('only genuine earlier static middleware can bypass the phone gate; a filename suffix cannot', async () => {
    await withServer(async (request, reached) => {
        const css = await request('/fixture-public.css', { headers: { 'user-agent': iphone } });
        assert.equal(css.status, 200);
        assert.equal(await css.text(), 'body{}');
        for (const route of ['/private.css', '/home/settings/account.svg', '/does-not-exist']) {
            assert.equal((await request(route, { headers: { 'user-agent': iphone } })).status, 403);
        }
        assert.deepEqual(reached, []);
    });
});

test('registration uses the supported pre-router server layer and phone WebSockets are denied before prepare', () => {
    const events = {};
    const layers = [];
    apply({ inject(services, callback) {
        assert.deepEqual(services, ['server']);
        callback({ server: { addServerLayer: (name, fn) => layers.push({ name, fn }) },
            on: (name, fn) => { events[name] = fn; } });
    } });
    assert.deepEqual(layers, [{ name: 'oi33-mobile-access', fn: enforceMobileAccess }]);
    assert.throws(() => events['handler/create/ws']({ request: { headers: { 'user-agent': iphone } } }),
        (error) => error instanceof ForbiddenError && error.status === 403 && /请使用电脑访问/.test(error.message));
    for (const headers of [{ 'user-agent': windows }, {}, { 'user-agent': 'HydroJudge/5.0' }]) {
        assert.doesNotThrow(() => events['handler/create/ws']({ request: { headers } }));
    }
    const framework = fs.readFileSync(require.resolve('@hydrooj/framework/server.ts'), 'utf8');
    assert.match(framework, /\.\.\.this\.serverLayers,[^]*?name: 'routes', func: router\.routes\(\)/);
    const createEvent = framework.indexOf("'handler/create/ws', h");
    const prepareCall = framework.indexOf('if (h.prepare) await h.prepare(args);', createEvent);
    assert.ok(createEvent > 0 && prepareCall > createEvent);
});
