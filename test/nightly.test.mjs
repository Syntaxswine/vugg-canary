// test/nightly.test.mjs — the nightly path end to end, on a toy vugg.
//
// Runs the REAL src/sweep.mjs and src/status.mjs (from a scratch copy of the
// canary) against a throwaway target: a bare "origin" whose main gets commits,
// the canary's own clone of it, a fake tools/_harness.mjs (two scenarios, a
// seeded toy engine) and a fake typescript/bin/tsc that compiles unless
// js/BREAK exists. Each "night" is one `sweep.mjs --now --date D`. A few
// seconds, no network, no vugg.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const CANARY_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-nightly');
const ORIGIN = path.join(ROOT, 'origin.git');
const WORK = path.join(ROOT, 'work');
const TARGET = path.join(ROOT, 'target');
const CANARY = path.join(ROOT, 'canary');
const LOGS = path.join(CANARY, 'logs');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
function pushMain(msg, files = {}) {
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(WORK, f);
    if (text === null) { git(WORK, 'rm', '-q', f); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', msg);
  git(WORK, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return head(WORK);
}

// --- the toy vugg ------------------------------------------------------------
const HARNESS = `// a toy vugg for the canary's nightly test: two scenarios, a seeded engine
let seed = 0;
export async function loadSimBundle() {
  const scenario = (minerals) => () => ({ conditions: { minerals }, events: [], defaultSteps: 3 });
  class VugSimulator {
    constructor(conditions) { this.minerals = conditions.minerals; this.crystals = []; this.t = 0; }
    run_step() {
      this.t += 1;
      if ((seed + this.t) % 2) this.crystals.push({ mineral: this.minerals[(seed + this.t) % this.minerals.length], dissolved: false, total_growth_um: seed + this.t });
    }
  }
  return { SIM_VERSION: 7, SCENARIOS: { alpha: scenario(['quartz', 'calcite']), beta: scenario(['barite']) }, VugSimulator, setSeed: (s) => { seed = s; } };
}
`;
const FAKE_TSC = `const fs = require('fs');
if (fs.existsSync('js/BREAK')) { console.error('js/BREAK(1,1): error TS1005: fake compile error'); process.exit(2); }
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/engine.js', '// toy bundle\\n');
`;
const LOCK = '{ "lockfileVersion": 3 }\n';   // npm ci never runs here: the stamp below matches it

execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', ORIGIN], { stdio: 'pipe' });
execFileSync('git', ['clone', '-q', ORIGIN, WORK], { stdio: 'pipe' });
const c1 = pushMain('c1', {
  'js/15-version.ts': 'export const SIM_VERSION = 7;\n',
  'tools/_harness.mjs': HARNESS,
  'package-lock.json': LOCK,
  'tsconfig.json': '{}\n',
  '.gitignore': 'node_modules/\ndist/\n',
});
execFileSync('git', ['clone', '-q', ORIGIN, TARGET], { stdio: 'pipe' });
git(TARGET, 'checkout', '-q', '--detach', c1);
// the target is installed already (stamp matches the lockfile), so no night runs npm ci.
// Hash the file as checked out: with core.autocrlf it holds CRLF, not the LF written above.
const tscDir = path.join(TARGET, 'node_modules', 'typescript');
fs.mkdirSync(path.join(tscDir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(tscDir, 'package.json'), '{ "name": "typescript", "type": "commonjs" }\n');
fs.writeFileSync(path.join(tscDir, 'bin', 'tsc'), FAKE_TSC);
fs.writeFileSync(path.join(TARGET, 'node_modules', '.canary-install.json'), JSON.stringify({
  lock_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(TARGET, 'package-lock.json'))).digest('hex'),
}));

// --- a scratch canary pointed at it -------------------------------------------
fs.cpSync(path.join(CANARY_SRC, 'src'), path.join(CANARY, 'src'), { recursive: true });
fs.copyFileSync(path.join(CANARY_SRC, 'package.json'), path.join(CANARY, 'package.json'));
fs.writeFileSync(path.join(CANARY, 'canary.config.json'), JSON.stringify({
  vuggPath: TARGET, follow: { remote: 'origin', branch: 'main' }, seeds: 3, logsDir: 'logs', autoPush: false,
  diffThreshold: { absPts: 39, relMult: 2.0, minPctForRel: 2.0, minSeedsForRel: 3 },
}, null, 2));

function nightNode(nodeArgs, date, ...extra) {
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(CANARY, 'src', 'sweep.mjs'), '--now', '--date', date, ...extra],
    { cwd: CANARY, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function night(date, ...extra) { return nightNode([], date, ...extra); }
function status(today) {
  return execFileSync(process.execPath, [path.join(CANARY, 'src', 'status.mjs'), '--no-task'],
    { cwd: CANARY, encoding: 'utf8', env: { ...process.env, CANARY_STATUS_TODAY: today } });
}

// main moves on before the first night: the canary's clone still sits at c1
const c2 = pushMain('c2', { 'js/engine.ts': '// engine v2\n' });

test('night 1: follows main c1 → c2, compiles, sweeps, and stamps the fetch + timing into meta', () => {
  const r = night('2026-01-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`follow: moved ${c1.slice(0, 8)} → ${c2.slice(0, 8)} \\(origin/main\\)`));
  assert.match(r.out, /target ready: dist\/ compiled from source/);
  const meta = readJson(LOGS, '2026-01-01', 'v7', 'meta.json');
  assert.equal(meta.follow.from, c1);
  assert.equal(meta.follow.to, c2);
  assert.equal(meta.follow.moved, true);
  assert.equal(meta.full_run, true);
  assert.deepEqual([meta.target_prep.installed, meta.target_prep.built], [false, true]);
  assert.ok(Date.parse(meta.started_at) <= Date.parse(meta.generated_at));
  assert.ok(c2.startsWith(meta.sha));
  assert.ok(fs.existsSync(path.join(LOGS, '2026-01-01', 'v7', 'beta', 'frequency.json')));
  // the sweep's load block is there (the tests further down read it). The toy has no seed-42
  // baseline yet, so the self-test ran nothing, and a pass that never ran is not timed.
  assert.equal(meta.selftest.ok, null);
  assert.deepEqual(Object.keys(meta.box_load.scenarios), ['alpha', 'beta'], r.out);
  assert.ok(!('selftest' in meta.box_load), JSON.stringify(meta.box_load.selftest));
});

test('night 2: main unchanged ⇒ NO-CHANGE, and the marker carries the fetch', () => {
  const r = night('2026-01-02');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /follow: origin\/main unchanged/);
  const nc = readJson(LOGS, '2026-01-02', 'NO-CHANGE.json');
  assert.equal(nc.identical_to, '2026-01-01');
  assert.equal(nc.follow.moved, false);
  assert.ok(!fs.existsSync(path.join(LOGS, '2026-01-02', 'v7')));
});

let c3;
test('night 3: main does not build ⇒ TARGET-FAILED, nothing swept, exit 1', () => {
  c3 = pushMain('c3 breaks the build', { 'js/BREAK': 'x\n' });
  const r = night('2026-01-03');
  assert.equal(r.code, 1, r.out);
  const tf = readJson(LOGS, '2026-01-03', 'TARGET-FAILED.json');
  assert.equal(tf.stage, 'build');
  assert.match(tf.error, /fake compile error/);
  assert.equal(tf.follow.to, c3);
  assert.ok(c3.startsWith(tf.sha));
  assert.ok(!fs.existsSync(path.join(LOGS, '2026-01-03', 'v7')));
});

test('status flags the night that was not swept, and says where the checkout came from', () => {
  const s = status('2026-01-03');
  assert.match(s, /⚑ 1 night\(s\) not swept since 2026-01-02 — newest 2026-01-03: the target's build failed at [0-9a-f]+ \(tsc -p tsconfig\.json: exit 2\)/);
  assert.match(s, new RegExp(`\\n  target: {5}2026-01-03: moved ${c2.slice(0, 8)} → ${c3.slice(0, 8)} \\(origin/main\\)`));
});

let c4;
test('re-run the same day after main is fixed ⇒ a real sweep, and the TARGET-FAILED marker is retired', () => {
  c4 = pushMain('c4 fixes it', { 'js/BREAK': null });
  const r = night('2026-01-03');
  assert.equal(r.code, 0, r.out);
  const day = fs.readdirSync(path.join(LOGS, '2026-01-03'));
  assert.ok(!day.includes('TARGET-FAILED.json'), day.join(', '));
  assert.ok(day.some((f) => /^TARGET-FAILED\.superseded-\d{8}T\d{6}Z\.json$/.test(f)), day.join(', '));
  assert.equal(readJson(LOGS, '2026-01-03', 'v7', 'meta.json').follow.to, c4);
  assert.ok(fs.readdirSync(path.join(LOGS, '2026-01-03', 'v7')).includes('diff-vs-v7_2026-01-01.json'));
});

test('a manual partial run never moves the checkout', () => {
  pushMain('c5', { 'js/engine.ts': '// engine v5\n' });
  const r = night('2026-01-04', '--scenario', 'alpha', '--seeds', '2');
  assert.equal(r.code, 0, r.out);
  assert.equal(head(TARGET), c4);
  assert.doesNotMatch(r.out, /follow:/);
  const meta = readJson(LOGS, '2026-01-04', 'v7', 'meta.json');
  assert.equal(meta.follow, undefined);
  assert.equal(meta.full_run, false);
});

test('--no-follow: a full run that sweeps the checkout where it is', () => {
  const r = night('2026-01-05', '--no-follow');
  assert.equal(r.code, 0, r.out);
  assert.equal(head(TARGET), c4);
  assert.doesNotMatch(r.out, /follow:/);
  const meta = readJson(LOGS, '2026-01-05', 'v7', 'meta.json');
  assert.equal(meta.full_run, true);
  assert.equal(meta.follow, undefined);
  assert.equal(meta.target_prep, undefined);
});

test('status times the last full sweep: toy sweeps take seconds, so the 200-seed cap fits — go back up', () => {
  // This toy sweep is usually over in under a second, too short for the CPU counters to tell a
  // load, so its line carries none. On a slow box it can run long enough to carry one.
  assert.match(status('2026-01-05'),
    /⚑ seeds: {4}~200 fit 04:00–09:00 \(last sweep 0 h 00 min for 3 seeds, 0\.0 min\/seed(, box \d+% busy)?\); 3 configured — go back up: seeds 200, absPts 15/);
});

test('a failed fetch: the night still runs on the checkout as it is, and status flags the fetch', () => {
  git(TARGET, 'remote', 'set-url', 'origin', path.join(ROOT, 'gone.git'));
  const r = night('2026-01-06');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚑ follow: fetch from origin failed/);
  assert.match(r.out, /no change — unchanged since 2026-01-05/);
  assert.ok(readJson(LOGS, '2026-01-06', 'NO-CHANGE.json').follow.fetch_error);
  assert.match(status('2026-01-06'), /\n  ⚑ target: {3}2026-01-06: fetch from origin failed/);
});

// --- the night's load (2026-11-20): every sweep says how busy the box was ----------------------
//
// A toy sweep is over in milliseconds and the CPU counters tick every 15.6 ms: too short to read a
// load from. So main gets an engine whose alpha spins 140 ms a step (3 steps × 3 seeds: its seed
// loop takes 1.26 s at least, while beta still takes microseconds) and a seed-42 baseline, so that
// the self-test has something to run.
const SPIN_MS = 140;
const SLOW_HARNESS = HARNESS.replace('this.t += 1;',
  `this.t += 1;\n      if (this.minerals.length > 1) { const until = performance.now() + ${SPIN_MS}; while (performance.now() < until); }`);
const toyHarness = path.join(ROOT, 'toy-harness.mjs');
fs.writeFileSync(toyHarness, HARNESS);
const { makeRunner } = await import(pathToFileURL(path.join(CANARY_SRC, 'src', 'run.mjs')).href);
const runToy = makeRunner(await (await import(pathToFileURL(toyHarness).href)).loadSimBundle());
const BASELINE = JSON.stringify({ alpha: runToy('alpha', 42), beta: runToy('beta', 42) }, null, 2) + '\n';
const isPct = (v) => typeof v === 'number' && v >= 0 && v <= 100;

let c6;
test('a sweep records how busy the box was: over the run, around the self-test, and around each seed loop', () => {
  assert.ok(SLOW_HARNESS.includes(`performance.now() + ${SPIN_MS}`), 'the slow engine was not written');
  git(TARGET, 'remote', 'set-url', 'origin', ORIGIN);          // the failed-fetch night above pointed it at nothing
  c6 = pushMain('c6: alpha takes over a second, and there is a seed-42 baseline', {
    'tools/_harness.mjs': SLOW_HARNESS, 'tests-js/baselines/seed42_v7.json': BASELINE,
  });
  const r = night('2026-01-07');
  assert.equal(r.code, 0, r.out);
  const meta = readJson(LOGS, '2026-01-07', 'v7', 'meta.json');
  assert.ok(c6.startsWith(meta.sha), r.out);
  assert.deepEqual([meta.selftest.ok, meta.selftest.checked], [true, 2], r.out);
  const box = meta.box_load;
  assert.ok(box, `no box_load block:\n${r.out}`);
  assert.match(box._comment, /this sweep's own thread included/);
  assert.equal(box.logical_cpus, os.cpus().length);

  // each scenario's entry is its own seed loop: alpha spun for 9 steps, beta did not
  assert.deepEqual(Object.keys(box.scenarios), ['alpha', 'beta']);
  const { alpha, beta } = box.scenarios;
  assert.ok(alpha.wall_s >= 9 * SPIN_MS / 1000, `alpha's seed loop: ${alpha.wall_s} s`);
  assert.ok(beta.wall_s < alpha.wall_s, `beta's seed loop: ${beta.wall_s} s`);
  // a second or more is long enough for the CPU counters, and a spinning thread is load and CPU time
  assert.ok(isPct(alpha.load_pct) && alpha.load_pct > 0, `alpha's load: ${alpha.load_pct}`);
  assert.ok(alpha.own_cpu_s > 0, `alpha's own CPU: ${alpha.own_cpu_s} s`);
  // under a second they cannot say: the entry is its wall time and nothing else
  if (beta.wall_s < 0.9) assert.deepEqual(Object.keys(beta), ['wall_s'], `beta ran ${beta.wall_s} s and claims ${JSON.stringify(beta)}`);

  // the self-test ran alpha once more, at seed 42: 3 steps
  assert.ok(box.selftest.wall_s >= 3 * SPIN_MS / 1000, `the self-test: ${box.selftest.wall_s} s`);

  // the run is the stretch status times: started_at to generated_at
  const timed = (Date.parse(meta.generated_at) - Date.parse(meta.started_at)) / 1000;
  assert.ok(Math.abs(box.sweep.wall_s - timed) < 0.25, `the run: ${box.sweep.wall_s} s, and status times ${timed} s`);
  assert.ok(box.sweep.wall_s >= alpha.wall_s + beta.wall_s + box.selftest.wall_s);
  assert.ok(isPct(box.sweep.load_pct) && box.sweep.load_pct > 0, `the run's load: ${box.sweep.load_pct}`);
  assert.ok(box.sweep.own_cpu_s > 0 && box.sweep.own_cpu_over_wall > 0);
  assert.match(r.out, /\[canary\] box load: [\d.]+% of \d+ logical CPUs busy, this sweep included; own CPU /);
});

test('status prints that sweep\'s load on the seed line', () => {
  const pct = Math.round(readJson(LOGS, '2026-01-07', 'v7', 'meta.json').box_load.sweep.load_pct);
  assert.match(status('2026-01-07'), new RegExp(
    `⚑ seeds: {4}~200 fit 04:00–09:00 \\(last sweep 0 h 00 min for 3 seeds, 0\\.0 min/seed, box ${pct}% busy\\); 3 configured — go back up: seeds 200, absPts 15`));
});

test('a scenario reused from a killed run has no timing: it gets no entry, never zeros', () => {
  // the night above as a kill would have left it: no meta.json, and beta not yet stamped as finished
  const vdir = path.join(LOGS, '2026-01-07', 'v7');
  fs.rmSync(path.join(vdir, 'meta.json'));
  fs.rmSync(path.join(vdir, 'beta', 'identity.json'));
  const r = night('2026-01-07');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /resuming: 1\/2 scenario\(s\) already finished by a killed run/);
  const meta = readJson(vdir, 'meta.json');
  assert.deepEqual(meta.resumed, { alpha: 'in place' });
  assert.deepEqual(Object.keys(meta.box_load.scenarios), ['beta']);
  assert.ok(meta.box_load.sweep.wall_s > 0 && meta.box_load.selftest.wall_s >= 3 * SPIN_MS / 1000);
});

test('a load reading that fails leaves the block out of meta.json, and the sweep goes on', () => {
  const preload = path.join(ROOT, 'break-os-cpus.cjs');
  fs.writeFileSync(preload, "require('node:os').cpus = () => { throw new Error('os.cpus is broken (test)'); };\n");
  const r = nightNode(['--require', preload], '2026-01-08', '--scenario', 'beta', '--seeds', '2');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /box load not recorded \(the first reading failed: os\.cpus is broken \(test\)\) — the sweep is kept regardless/);
  const meta = readJson(LOGS, '2026-01-08', 'v7', 'meta.json');
  assert.ok(!('box_load' in meta), JSON.stringify(meta.box_load));
  assert.deepEqual(meta.scenarios, ['beta']);
  assert.equal(meta.selftest.ok, true);
  assert.ok(fs.existsSync(path.join(LOGS, '2026-01-08', 'v7', 'beta', 'frequency.json')));
  // the control: the same run with nothing broken does carry the block
  const ok = night('2026-01-09', '--scenario', 'beta', '--seeds', '2');
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(Object.keys(readJson(LOGS, '2026-01-09', 'v7', 'meta.json').box_load.scenarios), ['beta'], ok.out);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
