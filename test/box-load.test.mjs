// test/box-load.test.mjs — the load reading: its arithmetic, and what it refuses to print.
//
// A sweep's box_load block is read months later, beside a flag that asks for the
// seed count to change. So a figure in it must be the real share of the machine
// that was busy, and where the counters cannot say, the figure must be missing:
// not a zero, not a guess. The readings are plain objects, so the arithmetic is
// pinned on made-up ones here; test/nightly.test.mjs runs the real thing.

import assert from 'node:assert/strict';
import os from 'node:os';
import { tallyCpus, readBox, spanOf, boxLoadBlock, describeBoxLoad, MIN_WINDOW_MS } from '../src/box-load.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const cpu = (user, nice, sys, idle, irq) => ({ model: 'toy', speed: 1, times: { user, nice, sys, idle, irq } });
const reading = (at_ms, idle_ms, total_ms, own_cpu_us, cpus = 4) => ({ at_ms, cpus, idle_ms, total_ms, own_cpu_us });

test('tally: idle and total over every CPU; irq is inside sys on Windows and added elsewhere', () => {
  const cpus = [cpu(100, 0, 50, 850, 7), cpu(300, 5, 95, 600, 3)];
  assert.deepEqual(tallyCpus(cpus, 'win32'), { cpus: 2, idle_ms: 1450, total_ms: 2000 });
  assert.deepEqual(tallyCpus(cpus, 'linux'), { cpus: 2, idle_ms: 1450, total_ms: 2010 });
  assert.throws(() => tallyCpus([], 'win32'), /lists no CPUs/);
  assert.throws(() => tallyCpus(undefined, 'win32'), /lists no CPUs/);
});

test('span: the load is the share of the counted CPU time that was not idle', () => {
  // 4 CPUs for 10 s is 40 000 ms counted; 21 520 of them idle ⇒ 46.2% busy. The process used 9.5 s itself.
  const a = reading(5_000, 1_000_000, 3_000_000, 2_000_000);
  assert.deepEqual(spanOf(a, reading(15_000, 1_021_520, 3_040_000, 11_500_000)), { wall_s: 10, load_pct: 46.2, own_cpu_s: 9.5 });
  assert.equal(spanOf(a, reading(15_000, 1_040_000, 3_040_000, 2_000_000)).load_pct, 0);     // every counted ms idle
  assert.equal(spanOf(a, reading(15_000, 1_000_000, 3_040_000, 2_000_000)).load_pct, 100);   // none idle
});

test('span: a window under one second keeps its wall time and gets neither load_pct nor own_cpu_s', () => {
  assert.equal(MIN_WINDOW_MS, 1000);
  const a = reading(0, 0, 0, 0);
  assert.deepEqual(spanOf(a, reading(999, 1_000, 3_999, 500_000)), { wall_s: 0.999 });
  assert.deepEqual(spanOf(a, reading(1_000, 1_000, 4_000, 500_000)), { wall_s: 1, load_pct: 75, own_cpu_s: 0.5 });
  // each figure by its own counter: the load by the time the CPUs counted, own CPU by the wall clock
  assert.deepEqual(spanOf(a, reading(1_004, 1_000, 3_999, 500_000)), { wall_s: 1.004, own_cpu_s: 0.5 });
  assert.deepEqual(spanOf(a, reading(996, 1_000, 4_000, 500_000)), { wall_s: 0.996, load_pct: 75 });
  // a toy scenario: microseconds, in which no counter ticked. What a tick would have read is not written.
  assert.deepEqual(spanOf(a, reading(0.4, 0, 0, 0)), { wall_s: 0 });
  assert.deepEqual(spanOf(a, reading(0.4, 16, 16, 15_625)), { wall_s: 0 });
});

test('span: no guess from a failed reading, a clock that ran backwards, a changed CPU count or counters that went back', () => {
  const a = reading(0, 0, 0, 0);
  const b = reading(10_000, 20_000, 40_000, 9_000_000);
  assert.deepEqual(spanOf(a, b), { wall_s: 10, load_pct: 50, own_cpu_s: 9 });    // the control: these two do make a span
  assert.equal(spanOf({ error: 'x' }, b), null);
  assert.equal(spanOf(a, { error: 'x' }), null);
  assert.equal(spanOf(null, b), null);
  assert.equal(spanOf(a, undefined), null);
  assert.equal(spanOf(b, a), null);
  assert.equal(spanOf(a, { ...b, at_ms: NaN }), null);
  assert.equal(spanOf(a, { ...b, own_cpu_us: -1 }), null);
  const noLoad = { wall_s: 10, own_cpu_s: 9 };
  assert.deepEqual(spanOf(a, { ...b, cpus: 8 }), noLoad);            // CPUs came or went: the sums are not comparable
  assert.deepEqual(spanOf(a, { ...b, idle_ms: -1 }), noLoad);        // idle went backwards
  assert.deepEqual(spanOf(a, { ...b, idle_ms: 40_001 }), noLoad);    // more idle than time
  assert.deepEqual(spanOf(a, { ...b, idle_ms: NaN }), noLoad);
  assert.deepEqual(spanOf(a, { ...b, total_ms: NaN }), noLoad);
});

// 4 CPUs, half of their time idle, and this process on 0.9 of one CPU, s seconds after boot
const at = (s) => reading(s * 1000, s * 2000, s * 4000, s * 900_000);

test('block: the run, the self-test, and an entry for each scenario that was timed', () => {
  const block = boxLoadBlock(at(0), at(100), {
    scenarios: { alpha: [at(1), at(41)], beta: [at(41), at(41.0004)], gamma: [at(42), { error: 'os.cpus is gone' }] },
    selftest: [at(90), at(99)],
  });
  assert.match(block._comment, /this sweep's own thread included/);
  assert.equal(block.logical_cpus, 4);
  assert.deepEqual(block.sweep, { wall_s: 100, load_pct: 50, own_cpu_s: 90, own_cpu_over_wall: 0.9 });
  assert.deepEqual(block.selftest, { wall_s: 9, load_pct: 50, own_cpu_s: 8.1 });
  assert.deepEqual(block.scenarios.alpha, { wall_s: 40, load_pct: 50, own_cpu_s: 36 });
  assert.deepEqual(block.scenarios.beta, { wall_s: 0 });                  // too short for either CPU counter
  assert.deepEqual(Object.keys(block.scenarios), ['alpha', 'beta']);      // gamma's reading failed: no entry, not zeros
  assert.deepEqual(JSON.parse(JSON.stringify(block)), block);             // what meta.json will hold is what was built
});

test('block: a skipped self-test and a sweep that timed no scenario leave those parts empty', () => {
  const block = boxLoadBlock(at(0), at(100));
  assert.ok(!('selftest' in block));
  assert.deepEqual(block.scenarios, {});
  assert.ok(!('selftest' in boxLoadBlock(at(0), at(100), { selftest: [at(90), { error: 'x' }] })));
});

test('block: a run under a second has its wall time, and no ratio made of ticks', () => {
  assert.deepEqual(boxLoadBlock(at(0), at(0.5)).sweep, { wall_s: 0.5 });
});

test('block: without a first and a last reading there is none, and the error says which', () => {
  assert.throws(() => boxLoadBlock({ error: 'os.cpus is gone' }, at(100)), /the first reading failed: os\.cpus is gone/);
  assert.throws(() => boxLoadBlock(at(0), { error: 'os.cpus is gone' }), /the last reading failed: os\.cpus is gone/);
  assert.throws(() => boxLoadBlock(undefined, at(100)), /the first reading failed: none was taken/);
  assert.throws(() => boxLoadBlock(at(100), at(0)), /ran backwards/);
});

test('readBox: a real reading is finite, counts this machine\'s CPUs, and its clocks do not go backwards', () => {
  const a = readBox();
  const b = readBox();
  assert.equal(a.error, undefined);
  assert.deepEqual(Object.keys(a), ['at_ms', 'cpus', 'idle_ms', 'total_ms', 'own_cpu_us']);
  assert.equal(a.cpus, os.cpus().length);
  for (const k of Object.keys(a)) assert.ok(Number.isFinite(a[k]) && Number.isFinite(b[k]), k);
  assert.ok(b.at_ms >= a.at_ms && b.own_cpu_us >= a.own_cpu_us);
  assert.ok(a.idle_ms > 0 && a.idle_ms < a.total_ms);
});

test('readBox: never throws; a reading that cannot be taken is { error }', () => {
  const real = os.cpus;
  const broken = (fn) => { os.cpus = fn; try { return readBox(); } finally { os.cpus = real; } };
  assert.deepEqual(broken(() => { throw new Error('boom'); }), { error: 'boom' });
  assert.deepEqual(broken(() => []), { error: 'os.cpus() lists no CPUs' });
  assert.deepEqual(broken(() => [cpu(1, 0, 1, undefined, 0)]), { error: 'idle_ms is not a finite number' });
  assert.equal(typeof broken(() => [{ model: 'no times' }]).error, 'string');
  assert.equal(readBox().error, undefined);                            // and the real one is back
});

test('readBox: own CPU is user plus system time, and a broken process.cpuUsage is an { error } too', () => {
  const real = process.cpuUsage;
  const withUsage = (fn) => { process.cpuUsage = fn; try { return readBox(); } finally { process.cpuUsage = real; } };
  assert.equal(withUsage(() => ({ user: 3_000_000, system: 2_000_000 })).own_cpu_us, 5_000_000);
  assert.deepEqual(withUsage(() => { throw new Error('no rusage'); }), { error: 'no rusage' });
  assert.deepEqual(withUsage(() => ({ user: 1 })), { error: 'own_cpu_us is not a finite number' });
  assert.equal(readBox().error, undefined);
});

test('the sweep\'s console line names what the percentage counts, and why a figure is missing', () => {
  assert.equal(describeBoxLoad({ logical_cpus: 16, sweep: { wall_s: 19581.52, load_pct: 46.2, own_cpu_s: 18812.4 } }),
    '46.2% of 16 logical CPUs busy, this sweep included; own CPU 18812.4 s over 19581.52 s of wall time');
  assert.equal(describeBoxLoad({ logical_cpus: 16, sweep: { wall_s: 0.42 } }),
    'no load figure: the run took 0.42 s, and the CPU counters need a second');
  assert.equal(describeBoxLoad({ logical_cpus: 16, sweep: { wall_s: 19581.52, own_cpu_s: 18812.4 } }),
    'no load figure: the CPU counters could not resolve one (box_load._comment in meta.json lists why); own CPU 18812.4 s over 19581.52 s of wall time');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
