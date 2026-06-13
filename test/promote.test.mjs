// test/promote.test.mjs — asserts for the no-change short-circuit (Phase 3a).
// Builds a throwaway logs tree under the OS temp dir; no deps.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLastDataBearingDay, shouldShortCircuit, writeNoChangeNote } from '../src/promote.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// --- build a temp logs tree -------------------------------------------------
const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-promote');
fs.rmSync(ROOT, { recursive: true, force: true });
const mkmeta = (date, ver, sha, canary = '0.1.0') => {
  const d = path.join(ROOT, date, ver);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ sha, canary_version: canary, scenarios: ['mvt'] }));
};
const mknote = (date) => {
  const d = path.join(ROOT, date);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'NO-CHANGE.json'), JSON.stringify({ date, identical_to: 'x' }));
};

// 06-10 real sweep (sha aaa111); 06-11 a NO-CHANGE day (no data); 06-13 = today
mkmeta('2026-06-10', 'v195', 'aaa111');
mknote('2026-06-11');

test('findLastDataBearingDay skips NO-CHANGE days and returns the real one', () => {
  const last = findLastDataBearingDay(ROOT, { excludeDate: '2026-06-13' });
  assert.equal(last.date, '2026-06-10');   // 06-11 is a note-only day → skipped
  assert.equal(last.sha, 'aaa111');
  assert.equal(last.version, 'v195');
});

test('excludeDate ignores today\'s own in-progress folder', () => {
  mkmeta('2026-06-13', 'v195', 'ffffff');           // pretend today already wrote
  const last = findLastDataBearingDay(ROOT, { excludeDate: '2026-06-13' });
  assert.equal(last.date, '2026-06-10');             // not 06-13
  fs.rmSync(path.join(ROOT, '2026-06-13'), { recursive: true, force: true });
});

test('shouldShortCircuit: unchanged + clean ⇒ skip', () => {
  const r = shouldShortCircuit(ROOT, { date: '2026-06-13', sha: 'aaa111', dirty: false, canaryVersion: '0.1.0' });
  assert.equal(r.skip, true);
  assert.equal(r.last.date, '2026-06-10');
});

test('shouldShortCircuit: changed SHA ⇒ sweep', () => {
  const r = shouldShortCircuit(ROOT, { date: '2026-06-13', sha: 'bbb222', dirty: false, canaryVersion: '0.1.0' });
  assert.equal(r.skip, false);
  assert.match(r.reason, /sha changed/);
});

test('shouldShortCircuit: dirty tree ⇒ sweep even if SHA matches (fresh-eyes fix #1)', () => {
  const r = shouldShortCircuit(ROOT, { date: '2026-06-13', sha: 'aaa111', dirty: true, canaryVersion: '0.1.0' });
  assert.equal(r.skip, false);
  assert.match(r.reason, /dirty/);
});

test('shouldShortCircuit: canary tool version bump ⇒ sweep', () => {
  const r = shouldShortCircuit(ROOT, { date: '2026-06-13', sha: 'aaa111', dirty: false, canaryVersion: '0.2.0' });
  assert.equal(r.skip, false);
  assert.match(r.reason, /canary tool version/);
});

test('shouldShortCircuit: no prior day ⇒ sweep (first run)', () => {
  const empty = path.join(os.tmpdir(), 'vugg-canary-test-empty');
  fs.rmSync(empty, { recursive: true, force: true });
  const r = shouldShortCircuit(empty, { date: '2026-06-13', sha: 'aaa111', dirty: false, canaryVersion: '0.1.0' });
  assert.equal(r.skip, false);
  assert.match(r.reason, /no prior/);
});

test('writeNoChangeNote points identical_to at the real day, never a note', () => {
  const last = findLastDataBearingDay(ROOT, { excludeDate: '2026-06-13' });
  const note = writeNoChangeNote(ROOT, '2026-06-13', last, 'aaa111');
  assert.equal(note.identical_to, '2026-06-10');
  assert.equal(note.version, 'v195');
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, '2026-06-13', 'NO-CHANGE.json'), 'utf8'));
  assert.equal(onDisk.identical_to, '2026-06-10');
});

// cleanup
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(path.join(os.tmpdir(), 'vugg-canary-test-empty'), { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
