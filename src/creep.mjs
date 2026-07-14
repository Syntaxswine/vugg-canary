#!/usr/bin/env node
/**
 * src/creep.mjs — the SUB-THRESHOLD CREEP census (hostile review follow-up,
 * 2026-07-14, blind-spot audit).
 *
 * The nightly diff alarms on PER-STEP moves (absPts / relMult per version
 * jump). That leaves one unaudited assumption in every "canary quiet = strata
 * healthy" reading: a species could walk a few points per version for many
 * versions — cumulative drift big enough to matter, invisible to the per-step
 * alarm. This tool walks the WHOLE committed record and asks, for every
 * (scenario, species) pair: how far did it move END-TO-END, how wide was its
 * total excursion, and was any part of that walk ever alarmed?
 *
 * A pair that moved ≥ the alarm thresholds cumulatively but NEVER alarmed is a
 * SILENT WALKER — unattributed drift the record has been carrying quietly.
 * A pair that moved big AND alarmed is fine: the record saw it.
 *
 * PASSIVE INSTRUMENT: reports and exits 0 regardless of findings. It annotates
 * the record; it never gates anything.
 *
 * Usage:
 *   node src/creep.mjs                 # census over config logsDir
 *   node src/creep.mjs --logs DIR      # explicit logs root
 *   node src/creep.mjs --all           # list every mover, not just walkers
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VER_RE = /^v\d+$/;

function parseArgs(argv) {
  const a = { logs: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--logs') a.logs = argv[++i];
    else if (argv[i] === '--all') a.all = true;
    else { console.error(`unknown arg ${argv[i]}`); process.exit(2); }
  }
  return a;
}

/**
 * Collect the data-bearing record: one entry per SIM version (the LATEST
 * data-bearing day of that version — deterministic sweeps make same-version
 * days identical unless the tree was disturbed; we keep the dirty label).
 * @returns [{version:'v214', vnum:214, date, dirty, scenarios: {name: {species}}}] ascending by vnum
 */
export function collectRecord(logsRoot) {
  const byVersion = new Map();
  if (!fs.existsSync(logsRoot)) return [];
  const dates = fs.readdirSync(logsRoot).filter((d) => DATE_RE.test(d)).sort();
  for (const date of dates) {
    const dayDir = path.join(logsRoot, date);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const v of fs.readdirSync(dayDir).filter((x) => VER_RE.test(x))) {
      const vdir = path.join(dayDir, v);
      const metaPath = path.join(vdir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;   // aborted run — not a stratum
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
      const scenarios = {};
      for (const s of fs.readdirSync(vdir, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const fqp = path.join(vdir, s.name, 'frequency.json');
        if (!fs.existsSync(fqp)) continue;
        try { scenarios[s.name] = JSON.parse(fs.readFileSync(fqp, 'utf8')).species; } catch { /* skip unreadable */ }
      }
      // latest day per version wins (dates ascend, so later overwrite is correct)
      byVersion.set(v, { version: v, vnum: parseInt(v.slice(1), 10), date, dirty: !!meta.engine_dirty, scenarios });
    }
  }
  return [...byVersion.values()].sort((a, b) => a.vnum - b.vnum);
}

/** Every alarmed (scenario|species) pair across all committed diff files. */
export function collectAlarmedPairs(logsRoot) {
  const alarmed = new Set();
  if (!fs.existsSync(logsRoot)) return alarmed;
  for (const date of fs.readdirSync(logsRoot).filter((d) => DATE_RE.test(d)).sort()) {
    const dayDir = path.join(logsRoot, date);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const v of fs.readdirSync(dayDir).filter((x) => VER_RE.test(x))) {
      const vdir = path.join(dayDir, v);
      if (!fs.existsSync(vdir) || !fs.statSync(vdir).isDirectory()) continue;
      for (const f of fs.readdirSync(vdir).filter((x) => x.startsWith('diff-') && x.endsWith('.json'))) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(vdir, f), 'utf8'));
          for (const al of rec.alarms || []) {
            if (al.species) alarmed.add(`${al.scenario}|${al.species}`);
            else alarmed.add(`${al.scenario}|*`);   // scenario-level (added/removed)
          }
        } catch { /* unreadable diff — skip */ }
      }
    }
  }
  return alarmed;
}

/**
 * The census. For each (scenario, species) pair: series of pct_present over the
 * record (0 when the species is absent from a stratum where the scenario ran;
 * strata before the scenario existed are skipped). Walker = never-alarmed pair
 * whose |net| or total excursion crosses absPts, or whose rel-ratio crosses
 * relMult from a base ≥ minPctForRel.
 */
export function creepCensus(record, alarmed, thresholds) {
  const { absPts = 15, relMult = 2.0, minPctForRel = 2.0 } = thresholds || {};
  const pairs = new Map();   // 'scenario|species' -> [{vnum, version, date, pct, dirty}]
  for (const stratum of record) {
    for (const [scn, species] of Object.entries(stratum.scenarios)) {
      const names = new Set(Object.keys(species));
      // include every species this pair-key has already seen, so vanishing → 0
      for (const key of pairs.keys()) {
        if (key.startsWith(scn + '|')) names.add(key.slice(scn.length + 1));
      }
      for (const sp of names) {
        const key = `${scn}|${sp}`;
        if (!pairs.has(key)) pairs.set(key, []);
        const pct = species[sp] ? species[sp].pct_present : 0;
        pairs.get(key).push({ vnum: stratum.vnum, version: stratum.version, date: stratum.date, pct, dirty: stratum.dirty });
      }
    }
  }

  const rows = [];
  for (const [key, series] of pairs) {
    if (series.length < 2) continue;
    const [scn, sp] = key.split('|');
    const pcts = series.map((s) => s.pct);
    const first = pcts[0], last = pcts[pcts.length - 1];
    const min = Math.min(...pcts), max = Math.max(...pcts);
    const net = last - first;
    const excursion = max - min;
    // largest single-step move — if this alone crosses absPts the per-step alarm had its chance
    let maxStep = 0;
    for (let i = 1; i < pcts.length; i++) maxStep = Math.max(maxStep, Math.abs(pcts[i] - pcts[i - 1]));
    const wasAlarmed = alarmed.has(key) || alarmed.has(`${scn}|*`);
    const absTrip = Math.abs(net) >= absPts || excursion >= absPts;
    const base = Math.min(first, last);
    const relTrip = base >= minPctForRel && (Math.max(first, last) / Math.max(base, 0.0001)) >= relMult;
    rows.push({ scenario: scn, species: sp, first, last, net, excursion, maxStep, steps: series.length, wasAlarmed, trips: absTrip || relTrip, series });
  }
  rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.excursion - a.excursion);
  return rows;
}

function fmtSeries(series) {
  return series.map((s) => `${s.version}${s.dirty ? '~' : ''}:${s.pct}`).join(' → ');
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'canary.config.json'), 'utf8'));
  const logsRoot = path.resolve(CANARY_ROOT, args.logs ?? cfg.logsDir ?? 'logs');
  const thresholds = cfg.diffThreshold || {};

  const record = collectRecord(logsRoot);
  const alarmed = collectAlarmedPairs(logsRoot);
  console.log(`[creep] record: ${record.length} strata (${record[0]?.version}@${record[0]?.date} → ${record.at(-1)?.version}@${record.at(-1)?.date}), ${alarmed.size} alarmed pair(s) on file`);
  console.log(`[creep] thresholds: absPts=${thresholds.absPts ?? 15}, relMult=${thresholds.relMult ?? 2.0} (same gates as the nightly alarm)  [~ = engine-dirty stratum]`);

  const rows = creepCensus(record, alarmed, thresholds);
  const walkers = rows.filter((r) => r.trips && !r.wasAlarmed);
  const seen = rows.filter((r) => r.trips && r.wasAlarmed);

  console.log(`\n[creep] ${rows.length} (scenario, species) pairs traced; ${seen.length} big movers were ALARMED at some step (the record saw them).`);
  if (!walkers.length) {
    console.log('[creep] SILENT WALKERS: none — no pair crossed the alarm thresholds cumulatively without tripping a per-step alarm. The "quiet = healthy" reading holds.');
  } else {
    console.log(`[creep] ⚑ SILENT WALKERS (${walkers.length}) — cumulative drift past the alarm gates, never alarmed:`);
    for (const w of walkers) {
      console.log(`\n  ${w.scenario} / ${w.species}: net ${w.net > 0 ? '+' : ''}${w.net} pts (excursion ${w.excursion}, biggest single step ${w.maxStep})`);
      console.log(`    ${fmtSeries(w.series)}`);
    }
    console.log('\n[creep] passive note: attribute each walker to its commits (strip-archive-diff between the bracketing versions) — creep is only rot if it is UNEXPLAINED.');
  }
  if (args.all) {
    console.log('\n[creep] full mover table (|net| desc):');
    for (const r of rows.slice(0, 40)) {
      console.log(`  ${r.wasAlarmed ? 'ALARMED ' : (r.trips ? 'WALKER  ' : 'quiet   ')} ${r.scenario} / ${r.species}: ${r.first} → ${r.last} (net ${r.net > 0 ? '+' : ''}${r.net}, exc ${r.excursion})`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
