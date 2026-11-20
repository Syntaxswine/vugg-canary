// src/box-load.mjs — how busy the machine was while a sweep ran.
//
// A sweep's wall time is the code's cost times the night's load: one commit
// has measured 4.6 to 7.2 min per seed, by the night. On 2026-11-16 a 55-seed
// sweep overran its night by 26 min because another agent ran builds, test
// gates and browser benchmarks on this machine from 04:00 to 09:00. Nothing in
// the canary's own record said so, and reading the overrun flag took an hour
// in other tools' logs. So every sweep now carries the load in meta.json
// (box_load), for the whole run and for each scenario, and status.mjs prints
// it beside the seed budget.
//
// THE READING. os.cpus() gives each logical CPU's user/nice/sys/idle/irq
// milliseconds since boot. Between two readings, summed over all logical CPUs:
//
//     load = 1 − Δidle / Δ(user + nice + sys + idle [+ irq, except on Windows])
//
// the share of the machine that was not idle. Windows calls it "% Processor
// Time", and the two agree: over one minute on this box on 2026-11-20, in
// thirty 2 s intervals, this reading averaged 20.45% and Get-Counter's 20.39%.
// Task Manager's CPU figure is another counter, "% Processor Utility", and
// reads higher: 68 where "% Processor Time" read 60, in one 12 s sample.
// The load INCLUDES this sweep's own thread: one busy thread is 100/N points,
// 6.25 on this 16-thread box, so a sweep alone on the machine does not read 0.
//
// On Windows `sys` already holds the interrupt time, so adding `irq` would count
// it twice. Checked on this box on 2026-11-20 over 10 s: user + sys + idle came
// to 1.0003 × the wall time on each of the 16 CPUs, and to 1.0078 × with irq
// added. Elsewhere libuv reports irq apart from sys, and there it is added.
//
// process.cpuUsage() gives this process's own CPU time (user + system, all its
// threads; the git, npm and tsc children are not in it). It is NOT a load-free
// cost: timed on 2026-11-18, the same 55 seeds of amethyst_geode took 159
// CPU-seconds with 34% of the box busy and 323 with 76%. What own CPU over wall
// time does say, in a sweep of hours, is whether the sweep was kept waiting for
// a CPU (well under 1) or ran whenever it wanted to and was slowed by its
// neighbours (about 1). A run of seconds reads low for another reason: most of
// it is the fetch and the compile, in children.
//
// Both CPU counters move in 15.6 ms ticks, so a window under one second (a toy
// sweep, a one-seed smoke) gets its wall time and neither load_pct nor
// own_cpu_s: a missing number, never a made-up one. The shortest real seed
// loop, tutorial_first_crystal at 55 seeds, runs for half a minute.
//
// PASSIVE INSTRUMENT: readBox() never throws; a reading that failed is
// { error }. boxLoadBlock() throws when the whole-run span cannot be formed, and
// its one caller (sweep.mjs) catches that and leaves the block out of
// meta.json. Nothing here can fail a sweep, and a reading costs 0.3 to 1.2 ms
// (timed at two loads): two per scenario, two for the self-test, two for the
// run.

import os from 'node:os';
import { performance } from 'node:perf_hooks';

/** A window shorter than this is too short to read against the CPU counters' 15.6 ms tick. */
export const MIN_WINDOW_MS = 1000;

const COMMENT = "load_pct: the share of all logical CPUs' time that was not idle (os.cpus() deltas), this sweep's own thread included: "
  + "one busy thread is 100/logical_cpus points. own_cpu_s: this process's own CPU time (process.cpuUsage(), user + system). "
  + 'sweep: from started_at to generated_at. A scenario reused from a killed run has no entry. '
  + 'A figure the CPU counters could not resolve is left out: a window under 1 s has neither, and load_pct also needs counters that moved forwards on an unchanged set of CPUs.';

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Idle and total milliseconds since boot, summed over os.cpus()'s list. Throws on an empty list. */
export function tallyCpus(cpus, platform = process.platform) {
  if (!Array.isArray(cpus) || !cpus.length) throw new Error('os.cpus() lists no CPUs');
  let idle = 0;
  let total = 0;
  for (const { times: t } of cpus) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + (platform === 'win32' ? 0 : t.irq);
  }
  return { cpus: cpus.length, idle_ms: idle, total_ms: total };
}

/**
 * One reading of the machine and of this process. Never throws: a reading that
 * could not be taken is { error }, and every span it bounds is left out.
 * (os.cpus is called through the module object, so a test can break it.)
 */
export function readBox() {
  try {
    const at = performance.now();
    const tally = tallyCpus(os.cpus());
    const own = process.cpuUsage();
    const reading = { at_ms: at, ...tally, own_cpu_us: own.user + own.system };
    for (const [k, v] of Object.entries(reading)) {
      if (!Number.isFinite(v)) return { error: `${k} is not a finite number` };
    }
    return reading;
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

/**
 * What happened between two readings: { wall_s, load_pct?, own_cpu_s? }, or
 * null when either reading failed or a clock ran backwards. A figure the CPU
 * counters cannot resolve is left out. load_pct needs MIN_WINDOW_MS of counted
 * time on every logical CPU, the same CPUs at both ends, and counters that
 * moved forwards; own_cpu_s needs MIN_WINDOW_MS of wall time.
 */
export function spanOf(a, b) {
  if (!a || !b || a.error || b.error) return null;
  const wallMs = b.at_ms - a.at_ms;
  const own = (b.own_cpu_us - a.own_cpu_us) / 1e6;
  if (!(wallMs >= 0) || !(own >= 0)) return null;      // NaN lands here too
  const span = { wall_s: round(wallMs / 1000, 3) };
  const idle = b.idle_ms - a.idle_ms;
  const total = b.total_ms - a.total_ms;
  if (a.cpus === b.cpus && idle >= 0 && idle <= total && total >= a.cpus * MIN_WINDOW_MS) {
    span.load_pct = round(100 * (1 - idle / total), 1);
  }
  if (wallMs >= MIN_WINDOW_MS) span.own_cpu_s = round(own, 3);
  return span;
}

/**
 * meta.json's box_load block. `start` and `end` bound the whole run;
 * `scenarios` maps a name to the [before, after] readings of its seed loop, and
 * holds only the scenarios this run computed; `selftest` is the same pair for
 * the seed-42 pass, or null. A pair that cannot make a span gets no entry.
 * Throws when the whole-run span cannot be formed: the caller leaves the block out.
 */
export function boxLoadBlock(start, end, { scenarios = {}, selftest = null } = {}) {
  for (const [which, r] of [['first', start], ['last', end]]) {
    if (!r || r.error) throw new Error(`the ${which} reading failed: ${r ? r.error : 'none was taken'}`);
  }
  const sweep = spanOf(start, end);
  if (!sweep) throw new Error('a clock ran backwards between the first and the last reading');
  if (sweep.own_cpu_s !== undefined) sweep.own_cpu_over_wall = round(sweep.own_cpu_s / sweep.wall_s, 3);
  const block = { _comment: COMMENT, logical_cpus: end.cpus, sweep };
  const st = selftest ? spanOf(selftest[0], selftest[1]) : null;
  if (st) block.selftest = st;
  block.scenarios = {};
  for (const [name, pair] of Object.entries(scenarios)) {
    const span = spanOf(pair[0], pair[1]);
    if (span) block.scenarios[name] = span;
  }
  return block;
}

/** The sweep's one console line about the block. */
export function describeBoxLoad(block) {
  const s = block.sweep;
  const parts = [];
  if (s.load_pct !== undefined) parts.push(`${s.load_pct}% of ${block.logical_cpus} logical CPUs busy, this sweep included`);
  else if (s.own_cpu_s === undefined) parts.push(`no load figure: the run took ${s.wall_s} s, and the CPU counters need a second`);
  else parts.push('no load figure: the CPU counters could not resolve one (box_load._comment in meta.json lists why)');
  if (s.own_cpu_s !== undefined) parts.push(`own CPU ${s.own_cpu_s} s over ${s.wall_s} s of wall time`);
  return parts.join('; ');
}
