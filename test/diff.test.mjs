// test/diff.test.mjs — assert-based tests for the version-diff alarm.
// No test framework (the canary has zero deps): plain asserts, exit 1 on fail.
//
//   node test/diff.test.mjs   (also wired as `npm test`)

import assert from 'node:assert/strict';
import { diffFingerprints, summarizeAlarms } from '../src/diff.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// Helper to build a fingerprint with given per-species pct_present.
const fp = (scenarios) => {
  const out = {};
  for (const [scen, species] of Object.entries(scenarios)) {
    out[scen] = { n_seeds: 200, species: {} };
    for (const [sp, pct] of Object.entries(species)) {
      out[scen].species[sp] = { pct_present: pct, mean_count: pct / 50, mean_count_when_present: 1, size_um: { min: 1, median: 2, max: 3 } };
    }
  }
  return out;
};

const TH = { absPts: 15, relMult: 2.0, minPctForRel: 2.0 };

// --- The origin story: mottramite 96 → 47 must fire as abs_move ---
test('abs_move fires on the mottramite 96→47 drop', () => {
  const A = fp({ supergene_oxidation: { mottramite: 96, calcite: 100 } });
  const B = fp({ supergene_oxidation: { mottramite: 47, calcite: 100 } });
  const alarms = diffFingerprints(A, B, TH);
  const mott = alarms.find((x) => x.species === 'mottramite');
  assert.ok(mott, 'mottramite should alarm');
  assert.equal(mott.kind, 'abs_move');
  assert.equal(mott.delta_pts, -49);
  assert.ok(!alarms.find((x) => x.species === 'calcite'), 'stable calcite must not alarm');
});

// --- Rare-but-present relative swing the absolute gate would miss ---
test('rel_move fires on a rare 4→10 (2.5×) swing under 15pts', () => {
  const A = fp({ mvt: { anhydrite: 4 } });
  const B = fp({ mvt: { anhydrite: 10 } });
  const alarms = diffFingerprints(A, B, TH);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, 'rel_move');  // |Δ|=6 < 15 but 10/4 = 2.5× ≥ 2×
});

test('a small rare wobble below thresholds does NOT alarm', () => {
  const A = fp({ mvt: { anhydrite: 4 } });
  const B = fp({ mvt: { anhydrite: 6 } });   // Δ2 < 15, 6/4=1.5× < 2× → noise
  assert.equal(diffFingerprints(A, B, TH).length, 0);
});

// --- Appeared / disappeared above the floor ---
test('appeared fires when a phase crosses 0 → ≥floor', () => {
  const A = fp({ mvt: { x: 0 } });           // (0 stored = absent here; use absence)
  const B = fp({ mvt: { newphase: 30 } });
  const alarms = diffFingerprints({ mvt: { n_seeds: 200, species: {} } }, B, TH);
  const ap = alarms.find((x) => x.species === 'newphase');
  assert.equal(ap.kind, 'appeared');
});

test('a phase appearing BELOW the floor (0→1) is treated as noise', () => {
  const B = fp({ mvt: { trace: 1 } });
  assert.equal(diffFingerprints({ mvt: { n_seeds: 200, species: {} } }, B, TH).length, 0);
});

test('disappeared fires when a present phase (≥floor) drops to 0', () => {
  const A = fp({ mvt: { gone: 40 } });
  const alarms = diffFingerprints(A, { mvt: { n_seeds: 200, species: {} } }, TH);
  assert.equal(alarms.find((x) => x.species === 'gone').kind, 'disappeared');
});

// --- Whole-scenario add/remove ---
test('scenario add/remove is flagged', () => {
  const added = diffFingerprints({}, fp({ brand_new: { q: 100 } }), TH);
  assert.equal(added[0].kind, 'scenario_added');
  const removed = diffFingerprints(fp({ retired: { q: 100 } }), {}, TH);
  assert.equal(removed[0].kind, 'scenario_removed');
});

// --- THE false-positive guard: identical input ⇒ zero alarms ---
test('self-diff (A vs A) raises ZERO alarms — no false positives', () => {
  const A = fp({
    supergene_oxidation: { mottramite: 96, adamite: 100, anglesite: 100, rare: 3 },
    mvt: { calcite: 100, barite: 100, anhydrite: 4 },
  });
  assert.equal(diffFingerprints(A, A, TH).length, 0);
});

test('summarizeAlarms groups by kind and scenario', () => {
  const A = fp({ s1: { a: 96, b: 4 }, s2: { c: 50 } });
  const B = fp({ s1: { a: 47, b: 10 }, s2: { c: 50 } });
  const s = summarizeAlarms(diffFingerprints(A, B, TH));
  assert.equal(s.total, 2);
  assert.equal(s.by_kind.abs_move, 1);
  assert.equal(s.by_kind.rel_move, 1);
  assert.equal(s.by_scenario.s1, 2);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
