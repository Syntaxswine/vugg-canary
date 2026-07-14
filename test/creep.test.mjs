// test/creep.test.mjs — asserts for the sub-threshold creep census.
// Builds a throwaway logs tree under the OS temp dir; no deps.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectRecord, collectAlarmedPairs, creepCensus } from '../src/creep.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-creep');
fs.rmSync(ROOT, { recursive: true, force: true });

// Three strata: v200, v201, v202. One scenario "s".
//  - walker: 100 → 92 → 85 (net -15, biggest step 8 — cumulative trips, never alarmed)
//  - jumper: 100 → 80 → 80 (single -20 step; we record it as alarmed in a diff file)
//  - steady: 50 all the way
//  - vanisher-in-record: present v200 at 4, absent v201+ (→ 0; rel-trip from base<min? base=min(4,0)=0 → no rel; abs |net|=4 → quiet)
function stratum(date, v, species) {
  const d = path.join(ROOT, date, v, 's');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'frequency.json'), JSON.stringify({ n_seeds: 200, species }));
  fs.writeFileSync(path.join(ROOT, date, v, 'meta.json'), JSON.stringify({ sha: v, engine_dirty: false }));
}
const sp = (pct) => ({ seeds_present: pct * 2, pct_present: pct, mean_count: 1, mean_count_when_present: 1, size_um: { min: 1, median: 2, max: 3 } });

stratum('2026-06-01', 'v200', { walker: sp(100), jumper: sp(100), steady: sp(50), vanisher: sp(4) });
stratum('2026-06-02', 'v201', { walker: sp(92), jumper: sp(80), steady: sp(50) });
stratum('2026-06-03', 'v202', { walker: sp(85), jumper: sp(80), steady: sp(50) });
// the jumper's -20 step WAS alarmed by the nightly diff:
fs.writeFileSync(path.join(ROOT, '2026-06-02', 'v201', 'diff-vs-v200_2026-06-01.json'),
  JSON.stringify({ alarms: [{ scenario: 's', species: 'jumper', kind: 'abs_move', pct_from: 100, pct_to: 80 }] }));

const record = collectRecord(ROOT);
const alarmed = collectAlarmedPairs(ROOT);
const rows = creepCensus(record, alarmed, { absPts: 15, relMult: 2.0, minPctForRel: 2.0 });
const byKey = Object.fromEntries(rows.map((r) => [`${r.scenario}|${r.species}`, r]));

test('record collects one stratum per version, ascending', () => {
  assert.deepEqual(record.map((r) => r.version), ['v200', 'v201', 'v202']);
});

test('alarmed pairs read from committed diff files', () => {
  assert.ok(alarmed.has('s|jumper'));
  assert.equal(alarmed.size, 1);
});

test('the walker trips cumulatively and is NOT alarmed → silent walker', () => {
  const w = byKey['s|walker'];
  assert.equal(w.net, -15);
  assert.ok(w.trips);
  assert.equal(w.wasAlarmed, false);
});

test('the jumper trips but WAS alarmed → the record saw it', () => {
  const j = byKey['s|jumper'];
  assert.ok(j.trips);
  assert.equal(j.wasAlarmed, true);
});

test('steady and sub-threshold pairs stay quiet', () => {
  assert.equal(byKey['s|steady'].trips, false);
  assert.equal(byKey['s|vanisher'].trips, false);
});

test('a species absent from a later stratum reads as 0, not a gap', () => {
  const v = byKey['s|vanisher'];
  assert.deepEqual(v.series.map((x) => x.pct), [4, 0, 0]);
});

// cleanup
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
