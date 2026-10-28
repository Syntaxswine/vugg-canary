// test/status.test.mjs — the glance must NEVER crash, whatever the logs hold.
//
// status.mjs is the surfacing tool: a 04:00 regression that crashes the reader
// is worse than no reader. The nasty case is a v<N>/ dir with no meta.json yet
// (sweep in progress — meta is written last — or a crashed partial run). Spawn
// the real script against throwaway logs trees and assert exit 0 + sane output.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const STATUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'status.mjs');
const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-status');

// run status against a given logs dir; returns { out, code } and never throws.
// --no-task: these cases are about the logs, not this machine's scheduler.
function runStatus(logsDir, today = '2026-06-14', env = {}) {
  try {
    const out = execFileSync('node', [STATUS, logsDir, '--no-task'],
      { encoding: 'utf8', env: { ...process.env, CANARY_STATUS_TODAY: today, ...env } });
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 };
  }
}

const writeMeta = (dir, extra = {}) => fs.writeFileSync(path.join(dir, 'meta.json'),
  JSON.stringify({ sha: 'aaa111', dirty: false, scenarios: ['mvt'], n_seeds: 200,
    selftest: { ok: true, checked: 1 }, ...extra }));

test('empty logs dir ⇒ exit 0, "no sweeps yet"', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const r = runStatus(ROOT);
  assert.equal(r.code, 0);
  assert.match(r.out, /no sweeps yet/);
});

test('v-dir with NO meta.json (sweep in progress) ⇒ exit 0, not a crash', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const vdir = path.join(ROOT, '2026-06-14', 'v195', 'bisbee');
  fs.mkdirSync(vdir, { recursive: true });          // a cored scenario, but no meta yet
  const r = runStatus(ROOT);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.out}`);
  assert.match(r.out, /IN PROGRESS or partial/);
  assert.doesNotMatch(r.out, /ENOENT|Error:/);
});

test('in-progress today ⇒ falls back to last COMPLETED day', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // a complete prior day
  const doneVer = path.join(ROOT, '2026-06-12', 'v194');
  fs.mkdirSync(path.join(doneVer, 'mvt'), { recursive: true });
  writeMeta(doneVer, { sha: 'old999' });
  // today: a v-dir with no meta (in progress)
  fs.mkdirSync(path.join(ROOT, '2026-06-14', 'v195', 'bisbee'), { recursive: true });
  const r = runStatus(ROOT);
  assert.equal(r.code, 0);
  assert.match(r.out, /IN PROGRESS/);
  assert.match(r.out, /last completed/);
  assert.match(r.out, /v194/);                       // the fallback found the real day
});

test('NO-CHANGE day ⇒ exit 0, reports the pointer', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const day = path.join(ROOT, '2026-06-14');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'NO-CHANGE.json'),
    JSON.stringify({ date: '2026-06-14', version: 'v195', sha: 'aaa111', identical_to: '2026-06-10' }));
  const r = runStatus(ROOT);
  assert.equal(r.code, 0);
  assert.match(r.out, /NO CHANGE/);
  assert.match(r.out, /2026-06-10/);
});

test('complete sweep with engine-dirty meta ⇒ reports it cleanly', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-14', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver, { dirty: true, engine_dirty: true });
  const r = runStatus(ROOT);
  assert.equal(r.code, 0);
  assert.match(r.out, /last sweep/);
  assert.match(r.out, /ENGINE-dirty/);
  assert.match(r.out, /self-test:\s+PASS/);
});

// --- a canary that quietly STOPPED must be loud (2026-08-16 → 10-25: 67 killed sweeps, unseen) ---

const partialRun = (date, ver, scenarios, attempt = null) => {
  const vdir = path.join(ROOT, date, ver);
  for (const s of scenarios) {
    fs.mkdirSync(path.join(vdir, s), { recursive: true });
    fs.writeFileSync(path.join(vdir, s, 'frequency.json'), '{}');
  }
  fs.mkdirSync(vdir, { recursive: true });
  if (attempt) fs.writeFileSync(path.join(vdir, 'sweep-identity.json'), JSON.stringify({ key: 'k', attempts: [attempt] }));
};

test('last finished observation older than 2 days ⇒ ⚑ STALE; a fresh one is quiet', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-01', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver);
  assert.match(runStatus(ROOT, '2026-06-14').out, /⚑ STALE — last observation: 2026-06-01 .* 13 d ago/);
  assert.doesNotMatch(runStatus(ROOT, '2026-06-02').out, /STALE/);
});

test('killed runs since the last observation are counted, newest named with its progress', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-10', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver);
  partialRun('2026-06-11', 'v195', ['amethyst_geode']);                       // old code: no identity
  partialRun('2026-06-12', 'v196', ['amethyst_geode', 'bisbee'],
    { started_at: '2026-06-12T08:00:00.000Z', pid: 2 ** 30, planned: 41 });    // a pid that isn't running
  const r = runStatus(ROOT, '2026-06-13');
  assert.equal(r.code, 0);
  assert.match(r.out, /⚑ 2 killed run\(s\) since 2026-06-10 — newest 2026-06-12 v196: 2\/41 scenario\(s\) cored/);
  assert.match(r.out, /last completed/);
});

test('a partial whose recorded pid is alive ⇒ IN PROGRESS with its pid, not killed', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  partialRun('2026-06-14', 'v195', ['amethyst_geode'],
    { started_at: '2026-06-14T08:00:00.000Z', pid: process.pid, planned: 41 });
  const r = runStatus(ROOT);
  assert.match(r.out, new RegExp(`sweep IN PROGRESS — 1/41 scenario\\(s\\) cored, started 2026-06-14T08:00:00.000Z \\(pid ${process.pid}\\)`));
  assert.doesNotMatch(r.out, /killed/);
});

test('a day with a NO-CHANGE marker AND a finished sweep reports the sweep', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-14', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver, { n_seeds: 30 });
  fs.writeFileSync(path.join(ROOT, '2026-06-14', 'NO-CHANGE.json'),
    JSON.stringify({ date: '2026-06-14', version: 'v195', sha: 'aaa111', identical_to: '2026-06-10' }));
  const r = runStatus(ROOT);
  assert.match(r.out, /last observation: 2026-06-14 sweep v195/);
  assert.doesNotMatch(r.out, /NO CHANGE/);
});

test('a resumed sweep says how many scenarios came from a killed run', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-14', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver, { scenarios: ['mvt', 'bisbee'], resumed: { bisbee: '2026-06-13/v195' } });
  assert.match(runStatus(ROOT).out, /2 scenarios × 200 seeds, 1 resumed from a killed run/);
});

// --- the canary's own checkout (2026-10-28): failed nights, the seed budget, a missing target ---

const CFG = path.join(os.tmpdir(), 'vugg-canary-test-status-config.json');
fs.writeFileSync(CFG, JSON.stringify({ seeds: 30, diffThreshold: { absPts: 39 } }));
const withCfg = { CANARY_STATUS_CONFIG: CFG };

test('a TARGET-FAILED night is flagged with its stage, and is not an observation', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-10', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  writeMeta(ver);
  fs.mkdirSync(path.join(ROOT, '2026-06-14'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '2026-06-14', 'TARGET-FAILED.json'), JSON.stringify({
    date: '2026-06-14', stage: 'install', sha: 'bbb222', error: 'npm ci --ignore-scripts --no-audit --no-fund: exit 1\nnpm ERR! network',
    follow: { remote: 'origin', branch: 'main', from: 'aaa111aa', to: 'bbb222bb', moved: true, fast_forward: true },
  }));
  const r = runStatus(ROOT, '2026-06-14', withCfg);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚑ STALE — last observation: 2026-06-10 /);
  assert.match(r.out, /⚑ 1 night\(s\) not swept since 2026-06-10 — newest 2026-06-14: the target's install failed at bbb222 \(npm ci --ignore-scripts --no-audit --no-fund: exit 1\)/);
  assert.match(r.out, /\n  target: {5}2026-06-14: moved aaa111aa → bbb222bb \(origin\/main\)/);
});

const timedSweep = (minutes, extra = {}) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ver = path.join(ROOT, '2026-06-14', 'v195');
  fs.mkdirSync(path.join(ver, 'mvt'), { recursive: true });
  const start = Date.parse('2026-06-14T08:00:00.000Z');
  writeMeta(ver, { n_seeds: 30, full_run: true, started_at: new Date(start).toISOString(),
    generated_at: new Date(start + minutes * 60000).toISOString(), ...extra });
  return runStatus(ROOT, '2026-06-14', withCfg).out;
};

test('seed budget: the 10-28 sweep (288 min for 30 seeds) fits, quietly', () => {
  assert.match(timedSweep(288.43), /\n  seeds: {6}30 a night \(last sweep 4 h 48 min for 30 seeds, 9\.3 min\/seed\) → ~31 fit 04:00–09:00/);
});

test('seed budget: a faster engine (160 min) says go back up, with the matching absPts', () => {
  assert.match(timedSweep(160), /⚑ seeds: {4}~57 fit 04:00–09:00 \(last sweep 2 h 40 min for 30 seeds, 5\.2 min\/seed\); 30 configured — go back up: seeds 57, absPts 28/);
});

test('seed budget: a sweep that overruns 04:00–09:00 is flagged', () => {
  assert.match(timedSweep(400), /⚑ seeds: {4}only ~22 fit 04:00–09:00 \(last sweep 6 h 40 min for 30 seeds, 12\.9 min\/seed\); 30 configured — the sweep overruns its night/);
});

test('seed budget: a resumed, manual or untimed sweep is not timed', () => {
  assert.doesNotMatch(timedSweep(160, { resumed: { mvt: 'in place' } }), /seeds:/);
  assert.doesNotMatch(timedSweep(160, { full_run: false }), /seeds:/);
  assert.doesNotMatch(timedSweep(160, { started_at: undefined }), /seeds:/);
});

test('a configured target with no harness ⇒ ⚑ before tonight finds out', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cfg = path.join(os.tmpdir(), 'vugg-canary-test-status-config-missing.json');
  fs.writeFileSync(cfg, JSON.stringify({ vuggPath: './no-such-vugg-checkout', seeds: 30, diffThreshold: { absPts: 39 } }));
  const r = runStatus(ROOT, '2026-06-14', { CANARY_STATUS_CONFIG: cfg });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚑ target: {3}.*no-such-vugg-checkout has no tools\/_harness\.mjs — the next run will stop before sweeping/);
  fs.rmSync(cfg, { force: true });
});

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(CFG, { force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
