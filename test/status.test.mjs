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
function runStatus(logsDir) {
  try {
    const out = execFileSync('node', [STATUS, logsDir], { encoding: 'utf8' });
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

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
