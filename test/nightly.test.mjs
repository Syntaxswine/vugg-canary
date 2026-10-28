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
import { fileURLToPath } from 'node:url';

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

function night(date, ...extra) {
  const r = spawnSync(process.execPath, [path.join(CANARY, 'src', 'sweep.mjs'), '--now', '--date', date, ...extra],
    { cwd: CANARY, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
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
  assert.match(status('2026-01-05'),
    /⚑ seeds: {4}~200 fit 04:00–09:00 \(last sweep 0 h 00 min for 3 seeds, 0\.0 min\/seed\); 3 configured — go back up: seeds 200, absPts 15/);
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

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
