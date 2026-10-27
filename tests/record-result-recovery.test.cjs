const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: [path.join(__dirname, '../frontend/record-result-recovery.ts')],
    bundle: true, write: false, format: 'cjs' }).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { createRecordResultRecovery, isPendingRecord } = mod.exports;
const rid = '6a0000000000000000000001', formal = '6a0000000000000000000002';
function fixture(load) {
    let time = 0, serial = 0, active = true;
    const timers = new Map(), applied = [], stalled = [];
    const state = { pretest: { rid }, records: { rows: [], items: {} } };
    const recovery = createRecordResultRecovery({ getState: () => state, load, isActive: () => active,
        apply: record => { applied.push(record); state.records.items[record._id] = record; },
        onStalled: value => stalled.push(value), now: () => time,
        setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, due: time + delay }); return id; },
        clearTimer: id => timers.delete(id) });
    return { recovery, state, timers, applied, stalled, setActive: value => { active = value; },
        async tick() {
            const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
            assert.ok(next, 'A recovery timer must be scheduled');
            timers.delete(next[0]); time = next[1].due; next[1].callback();
            for (let i = 0; i < 8; i++) await Promise.resolve();
        } };
}

test('missed websocket final is recovered for the active pretest and formal submission', async () => {
    const counts = new Map();
    const f = fixture(async id => { const count = (counts.get(id) || 0) + 1; counts.set(id, count);
        return { _id: id, status: count === 1 ? 21 : 1, score: 100 }; });
    f.state.records.rows = [formal];
    f.state.records.items[formal] = { _id: formal, status: 0 };
    f.recovery.update();
    for (let i = 0; i < 4; i++) await f.tick();
    assert.equal(f.state.records.items[rid].status, 1);
    assert.equal(f.state.records.items[formal].status, 1);
    assert.deepEqual([...counts.values()], [2, 2]);
    assert.equal(f.timers.size, 0, 'Terminal results stop network refreshes');
    assert.equal(f.stalled.length, 0);
    for (const status of [0, 20, 21, 22]) assert.equal(isPendingRecord({ status }), true);
    for (const status of [1, 2, 7, 8, 9, 30]) assert.equal(isPendingRecord({ status }), false);
});

test('late HTTP cannot overwrite a websocket final or update a disposed page', async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    f.recovery.update(); await f.tick();
    f.state.records.items[rid] = { _id: rid, status: 1, score: 100 };
    f.recovery.update(); resolve({ _id: rid, status: 20 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(f.applied.length, 0);
    assert.equal(f.timers.size, 0);
    delete f.state.records.items[rid]; f.recovery.update(); await f.tick();
    f.recovery.dispose(); resolve({ _id: rid, status: 1 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(f.applied.length, 0);
    assert.equal(f.timers.size, 0);
});

test('network failures are bounded, show recovery state, and reconnect can recover without submitting', async () => {
    let requests = 0, offline = true;
    const f = fixture(async () => { requests++; if (offline) throw new Error('timeout'); return { _id: rid, status: 7 }; });
    f.recovery.update();
    for (let i = 0; f.timers.size && i < 30; i++) await f.tick();
    assert.ok(requests > 10 && requests <= 24);
    assert.equal(f.timers.size, 0);
    assert.equal(f.stalled.at(-1), true);
    offline = false; f.recovery.retry(); await f.tick();
    assert.equal(f.state.records.items[rid].status, 7);
    assert.equal(f.stalled.at(-1), false);
    assert.equal(f.timers.size, 0);
});

test('hidden workbench does not fetch, malformed/mismatched records are never applied', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return { _id: formal, status: 1 }; });
    f.setActive(false); f.recovery.update(); assert.equal(f.timers.size, 0);
    f.setActive(true); f.recovery.retry(); await f.tick();
    assert.equal(calls, 1); assert.equal(f.applied.length, 0);
    f.recovery.dispose();
    const invalid = fixture(async () => { throw new Error('must not load'); });
    invalid.state.pretest.rid = 'not-a-record-id'; invalid.recovery.update();
    assert.equal(invalid.timers.size, 0);
});
