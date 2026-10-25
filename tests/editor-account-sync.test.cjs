const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const bundle = buildSync({ entryPoints: [path.join(root, 'frontend/editor-account-settings.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const appearance = { fontSize: 23, tabSize: 4, theme: 'vs-dark' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(seed = {}) {
  const values = new Map(Object.entries(seed)), timers = new Map(), cloud = new Map(), calls = [], instances = [];
  let timerId = 0;
  const module = { exports: {} };
  new Function('module', 'exports', 'setTimeout', 'clearTimeout', bundle)(module, module.exports,
    fn => { timers.set(++timerId, fn); return timerId; }, id => timers.delete(id));
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  function make(uid = 42, extra = {}) {
    const changes = [], statuses = [];
    const options = {
      snapshot: { uid, settings: copy(cloud.get(uid) ?? null) }, storage, defaultTheme: 'vs',
      load: async () => ({ uid, settings: copy(cloud.get(uid) ?? null) }),
      save: async (patch, initialize) => {
        calls.push({ uid, patch: copy(patch), initialize });
        if (!initialize || !cloud.has(uid)) cloud.set(uid, { ...cloud.get(uid), ...copy(patch) });
        return { uid, settings: copy(cloud.get(uid)) };
      },
      onChange: value => changes.push(copy(value)), onStatus: value => statuses.push(value),
      ...extra,
    };
    const sync = module.exports.createEditorSettingsSync(options);
    instances.push(sync);
    return { sync, changes, statuses, options };
  }
  return { values, timers, cloud, calls, make, storage, dispose: () => instances.forEach(sync => sync.dispose()) };
}

test('cloud appearance wins over legacy browser values and restores on another device', async () => {
  const f = fixture({ 'editor.config': JSON.stringify({ fontSize: 38, tabSize: 8 }), 'oi33/editor-theme': 'nord' });
  f.cloud.set(42, appearance);
  const first = f.make();
  assert.deepEqual(first.sync.get(), appearance);
  await first.sync.flush();
  assert.equal(f.calls.length, 0);
  const secondDevice = fixture(); secondDevice.cloud.set(42, copy(f.cloud.get(42)));
  assert.deepEqual(secondDevice.make().sync.get(), appearance);
  f.dispose(); secondDevice.dispose();
});

test('legacy browser appearance migrates once and never becomes another account initial appearance', async () => {
  const f = fixture({ 'editor.config': JSON.stringify({ fontSize: 23, tabSize: 4, code: 'private source' }),
    'oi33/editor-theme': 'vs-dark' });
  const first = f.make(); assert.deepEqual(first.sync.get(), appearance);
  await first.sync.flush();
  assert.deepEqual(f.cloud.get(42), appearance);
  assert.equal(f.calls[0].initialize, true);
  assert.deepEqual(Object.keys(f.calls[0].patch).sort(), ['fontSize', 'tabSize', 'theme']);
  first.sync.dispose();
  const second = f.make(43); await second.sync.flush();
  assert.deepEqual(second.sync.get(), { fontSize: 14, tabSize: 4, theme: 'vs' });
  assert.deepEqual(f.cloud.get(42), appearance);
  f.dispose();
});

test('updates coalesce validated appearance fields without synchronizing code or arbitrary Monaco options', async () => {
  const f = fixture(); f.cloud.set(42, appearance); const { sync } = f.make();
  sync.update({ fontSize: 29, lineHeight: 99, code: 'secret' });
  sync.update({ tabSize: 2, theme: 'nord' });
  sync.update({ fontSize: 99, tabSize: 3, theme: '__proto__' });
  await sync.flush();
  assert.deepEqual(f.calls, [{ uid: 42, patch: { fontSize: 29, tabSize: 2, theme: 'nord' }, initialize: false }]);
  assert.deepEqual(sync.get(), f.cloud.get(42)); f.dispose();
});

test('a newer edit while saving is retained and submitted after the older request', async () => {
  const f = fixture(); f.cloud.set(42, appearance); const blocked = deferred(), calls = [];
  const { sync } = f.make(42, { save: async (patch, initialize) => {
    calls.push(copy(patch)); if (calls.length === 1) await blocked.promise;
    f.cloud.set(42, { ...f.cloud.get(42), ...patch });
    return { uid: 42, settings: copy(f.cloud.get(42)) };
  } });
  sync.update({ fontSize: 24 }); const running = sync.flush(); await Promise.resolve();
  sync.update({ fontSize: 27, tabSize: 8 }); blocked.resolve(); await running;
  assert.deepEqual(calls, [{ fontSize: 24 }, { fontSize: 27, tabSize: 8 }]);
  assert.deepEqual(sync.get(), { fontSize: 27, tabSize: 8, theme: 'vs-dark' }); f.dispose();
});

test('a failed save persists account-scoped pending changes for reload and retry without replacing unrelated cloud values', async () => {
  const f = fixture(); f.cloud.set(42, appearance);
  const failed = f.make(42, { save: async () => { throw Error('offline'); } });
  failed.sync.update({ fontSize: 26 }); await failed.sync.flush();
  assert.equal(failed.statuses.at(-1), 'failed');
  assert.deepEqual(JSON.parse(f.values.get('oi33/editor-settings/42')).pending, { fontSize: 26 });
  failed.sync.dispose(); f.cloud.set(42, { ...appearance, theme: 'nord' });
  const reloaded = f.make(); assert.deepEqual(reloaded.sync.get(), { fontSize: 26, tabSize: 4, theme: 'nord' });
  await reloaded.sync.flush();
  assert.deepEqual(f.calls[0].patch, { fontSize: 26 });
  assert.deepEqual(JSON.parse(f.values.get('oi33/editor-settings/42')).pending, {}); f.dispose();
});

test('an unavailable initial snapshot reads cloud state before attempting a write and preserves current edits', async () => {
  const f = fixture(); f.cloud.set(42, appearance); let loads = 0;
  const first = f.make(42, { snapshot: { uid: 42, settings: null, unavailable: true }, load: async () => {
    loads++; if (loads === 1) throw Error('offline');
    return { uid: 42, settings: copy(f.cloud.get(42)) };
  } });
  first.sync.update({ tabSize: 8 }); await first.sync.flush(); assert.equal(f.calls.length, 0);
  await first.sync.flush();
  assert.deepEqual(f.calls[0], { uid: 42, patch: { tabSize: 8 }, initialize: false });
  assert.deepEqual(first.sync.get(), { ...appearance, tabSize: 8 }); f.dispose();
});

test('initial cloud outage does not destroy first-time legacy appearance before safe migration', async () => {
  const f = fixture({ 'editor.config': JSON.stringify({ fontSize: 23, tabSize: 4 }), 'oi33/editor-theme': 'vs-dark' });
  const { sync } = f.make(42, { snapshot: { uid: 42, settings: null, unavailable: true } });
  await sync.flush();
  assert.deepEqual(f.cloud.get(42), appearance);
  assert.deepEqual(sync.get(), appearance); f.dispose();
});

test('blocked local storage does not stop account-based settings loading or saving', async () => {
  const f = fixture();
  const storage = { getItem() { throw Error('storage blocked'); }, setItem() { throw Error('quota or privacy setting'); } };
  const first = f.make(42, { storage });
  first.sync.update({ fontSize: 25 }); await first.sync.flush();
  assert.deepEqual(f.cloud.get(42), { fontSize: 25, tabSize: 4, theme: 'vs' });
  assert.equal(first.statuses.at(-1), 'saved'); f.dispose();
});

test('a response for another account is rejected while pending changes remain isolated', async () => {
  const f = fixture(); f.cloud.set(42, appearance);
  const item = f.make(42, { save: async () => ({ uid: 43, settings: { fontSize: 40, tabSize: 8, theme: 'nord' } }) });
  item.sync.update({ fontSize: 27 }); await item.sync.flush();
  assert.equal(item.statuses.at(-1), 'failed');
  assert.deepEqual(item.sync.get(), { ...appearance, fontSize: 27 });
  assert.deepEqual(item.changes, []);
  assert.equal(f.values.has('oi33/editor-settings/43'), false); f.dispose();
});

test('disposing an account stops stale callbacks and follow-up writes after an in-flight request', async () => {
  const f = fixture(); f.cloud.set(42, appearance); const blocked = deferred(), calls = [];
  const item = f.make(42, { save: async patch => {
    calls.push(copy(patch)); await blocked.promise;
    return { uid: 42, settings: { ...appearance, ...patch } };
  } });
  item.sync.update({ fontSize: 24 }); const running = item.sync.flush(); await Promise.resolve();
  item.sync.update({ tabSize: 8 }); item.sync.dispose();
  const statusCount = item.statuses.length; blocked.resolve(); await running;
  assert.equal(calls.length, 1);
  assert.equal(item.statuses.length, statusCount);
  assert.deepEqual(item.changes, []); f.dispose();
});

test('initialization races preserve an existing cloud snapshot plus only explicit user edits', async () => {
  const f = fixture({ 'editor.config': JSON.stringify({ fontSize: 18, tabSize: 2 }), 'oi33/editor-theme': 'vs' });
  const item = f.make(); item.sync.update({ fontSize: 26 });
  f.cloud.set(42, appearance); // Another device initializes before our first create-only save.
  await item.sync.flush();
  assert.deepEqual(item.sync.get(), { ...appearance, fontSize: 26 });
  assert.deepEqual(f.cloud.get(42), { ...appearance, fontSize: 26 });
  assert.equal(f.calls[0].initialize, true);
  assert.deepEqual(f.calls[1].patch, { fontSize: 26 }); f.dispose();
});

test('new-problem snapshots refresh cloud preferences while preserving unsaved edits for the same account', async () => {
  const f = fixture(); f.cloud.set(42, appearance); const item = f.make();
  item.sync.update({ fontSize: 28 });
  const remote = { fontSize: 20, tabSize: 2, theme: 'nord' };
  f.cloud.set(42, remote); item.sync.refresh({ uid: 42, settings: remote });
  assert.deepEqual(item.sync.get(), { ...remote, fontSize: 28 });
  assert.deepEqual(item.changes.at(-1), item.sync.get());
  item.sync.refresh({ uid: 43, settings: appearance });
  assert.deepEqual(item.sync.get(), { ...remote, fontSize: 28 });
  await item.sync.flush(); assert.deepEqual(f.cloud.get(42), { ...remote, fontSize: 28 }); f.dispose();
});
