// src/diff.mjs — Phase 2: the version-over-version regression alarm.
//
// Compares two swept versions' frequency tables. For each (scenario, species)
// it flags a move in spawn-% that crosses a threshold — the alarm that would
// have fired on supergene mottramite 96%→47% at 04:00, unattended.
//
// Three alarm kinds, by design (boss decision 3 + fresh-eyes addendum):
//   - abs_move      : both versions present the species, |Δ spawn-%| ≥ absPts
//                     (default 15). The blunt, reliable signal — catches big
//                     swings on common phases (mottramite was this).
//   - rel_move      : a rare-but-present species (max side ≥ minPctForRel)
//                     whose spawn-% swung ≥ relMult-fold (default 2×). Catches
//                     proportional moves the absolute gate is blind to on
//                     low-frequency phases.
//   - appeared /    : a species crossed the present/absent line and the nonzero
//     disappeared     side clears the floor (≥ minPctForRel). Below the floor
//                     it's sampling noise on a rare phase, so we don't alarm.
//
// PASSIVE INSTRUMENT: this computes and records alarms. It does NOT exit
// nonzero or refuse — surfacing the move is the job; a human adjudicates
// expected-churn vs regression. (An RNG-derivation rebake, for instance, will
// light up many alarms BY DESIGN; the per-scenario breakdown is what lets a
// human confirm the churn is only intended re-sequencing.)

import fs from 'node:fs';
import path from 'node:path';

const round1 = (x) => Math.round(x * 10) / 10;

/** Load every scenario's frequency.json under a version dir → { scenario: {n_seeds, species} }. */
export function loadVersionFingerprint(versionDir) {
  const out = {};
  for (const name of fs.readdirSync(versionDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const fp = path.join(versionDir, name.name, 'frequency.json');
    if (fs.existsSync(fp)) out[name.name] = JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return out;
}

/**
 * @param {Object} fpA - older version fingerprint: { scenario: {species: {pct_present, mean_count, ...}} }
 * @param {Object} fpB - newer version fingerprint, same shape
 * @param {{absPts?:number, relMult?:number, minPctForRel?:number}} thresholds
 * @returns {Array} alarms
 */
export function diffFingerprints(fpA, fpB, thresholds = {}) {
  const { absPts = 15, relMult = 2.0, minPctForRel = 2.0 } = thresholds;
  const alarms = [];
  const scenarios = [...new Set([...Object.keys(fpA), ...Object.keys(fpB)])].sort();

  for (const scen of scenarios) {
    if (!fpA[scen]) { alarms.push({ scenario: scen, kind: 'scenario_added' }); continue; }
    if (!fpB[scen]) { alarms.push({ scenario: scen, kind: 'scenario_removed' }); continue; }

    const A = fpA[scen].species || {};
    const B = fpB[scen].species || {};
    const species = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();

    for (const sp of species) {
      const a = A[sp]?.pct_present ?? 0;
      const b = B[sp]?.pct_present ?? 0;
      const delta = round1(b - a);
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);

      let kind = null;
      if (a === 0 && b > 0) {
        if (b >= minPctForRel) kind = 'appeared';
      } else if (a > 0 && b === 0) {
        if (a >= minPctForRel) kind = 'disappeared';
      } else if (Math.abs(delta) >= absPts) {
        kind = 'abs_move';
      } else if (hi >= minPctForRel && lo > 0 && hi / lo >= relMult) {
        kind = 'rel_move';
      }

      if (kind) {
        alarms.push({
          scenario: scen, species: sp, kind,
          pct_from: a, pct_to: b, delta_pts: delta,
          mean_from: A[sp]?.mean_count ?? 0, mean_to: B[sp]?.mean_count ?? 0,
        });
      }
    }
  }
  return alarms;
}

/** Group alarms into a compact summary for the log header / console. */
export function summarizeAlarms(alarms) {
  const byKind = {};
  const byScenario = {};
  for (const al of alarms) {
    byKind[al.kind] = (byKind[al.kind] || 0) + 1;
    if (al.scenario) byScenario[al.scenario] = (byScenario[al.scenario] || 0) + 1;
  }
  return { total: alarms.length, by_kind: byKind, by_scenario: byScenario };
}

// ---------------------------------------------------------------------------
// CLI: node src/diff.mjs <versionDirA> <versionDirB> [--out FILE]
// Writes diff-vs-<verA>.json into B's dir (or --out) and prints a summary.
// ---------------------------------------------------------------------------
async function cli() {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv.includes('--help')) {
    console.log('usage: node src/diff.mjs <versionDirA(older)> <versionDirB(newer)> [--out FILE]');
    process.exit(argv.includes('--help') ? 0 : 2);
  }
  const dirA = argv[0];
  const dirB = argv[1];
  const outIdx = argv.indexOf('--out');
  const cfgPath = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'canary.config.json');
  let thresholds = {};
  try { thresholds = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).diffThreshold || {}; } catch { /* defaults */ }

  const fpA = loadVersionFingerprint(dirA);
  const fpB = loadVersionFingerprint(dirB);
  const alarms = diffFingerprints(fpA, fpB, thresholds);
  const summary = summarizeAlarms(alarms);

  const verA = path.basename(dirA);
  const verB = path.basename(dirB);
  const record = { from: verA, to: verB, thresholds, summary, alarms };
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : path.join(dirB, `diff-vs-${verA}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

  console.log(`\n[diff] ${verA} → ${verB}: ${summary.total} alarm(s)`);
  if (summary.total) {
    console.log(`       by kind: ${JSON.stringify(summary.by_kind)}`);
    for (const al of alarms.slice(0, 40)) {
      if (al.species) console.log(`       ⚑ ${al.scenario} / ${al.species}: ${al.kind} ${al.pct_from}% → ${al.pct_to}% (Δ${al.delta_pts >= 0 ? '+' : ''}${al.delta_pts})`);
      else console.log(`       ⚑ ${al.scenario}: ${al.kind}`);
    }
    if (alarms.length > 40) console.log(`       … and ${alarms.length - 40} more`);
  } else {
    console.log(`       (no moves past thresholds — the strata match)`);
  }
  console.log(`[diff] wrote ${outPath}`);
}

// Run as CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('diff.mjs')) cli();
