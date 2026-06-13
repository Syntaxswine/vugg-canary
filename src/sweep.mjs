#!/usr/bin/env node
/**
 * src/sweep.mjs — vugg-canary Phase 1: the sweep engine.
 *
 * Runs a frozen vugg-simulator copy across N chemistry seeds × every scenario,
 * reduces each scenario to a per-species frequency table, and writes a dated
 * log. The frequency table is the regression spine; the per-version diff
 * (Phase 2) is the alarm.
 *
 * HOW IT STAYS HONEST (two guards):
 *   1. It reuses the TARGET repo's tools/_harness.mjs verbatim — same jsdom +
 *      dist/ eval + fetch mock that gen-baseline and the tests use. So a run
 *      here is the SAME pure function of (code, chem seed, shape seed).
 *   2. defaultSteps ?? 100 matches gen-baseline EXACTLY (not the sweeps' 200),
 *      so the canary's seed-42 row equals tests-js/baselines/seed42_v<N>.json —
 *      which the self-test asserts on every run. Divergence = entrypoint drift
 *      or a stale baseline, surfaced loudly.
 *
 * Usage:
 *   node src/sweep.mjs --now [--seeds N] [--scenario a,b] [--date YYYY-MM-DD] [--out DIR]
 *   node src/sweep.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoMeta } from './repo-meta.mjs';
import { fingerprintScenario } from './fingerprint.mjs';
import { shouldShortCircuit, writeNoChangeNote, findLastDataBearingDay } from './promote.mjs';
import { loadVersionFingerprint, diffFingerprints, summarizeAlarms } from './diff.mjs';
import { makeRunner } from './run.mjs';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'package.json'), 'utf8'));
const CANARY_VERSION = PKG.version;

function parseArgs(argv) {
  const a = { now: false, help: false, build: false, force: false, seeds: null, scenario: null, date: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--now') a.now = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--build') a.build = true;
    else if (t === '--force') a.force = true;
    else if (t === '--seeds') a.seeds = parseInt(argv[++i], 10);
    else if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--date') a.date = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else { console.error(`unknown arg: ${t}`); process.exit(2); }
  }
  return a;
}

// The harness evals dist/ (the BUILT bundle); the SHA we stamp comes from git
// (the SOURCE tree). These can disagree — e.g. a leftover experimental build of
// a different version. The canary is a passive sediment scanner, not a gate: it
// doesn't REFUSE to scan a mismatched layer, it just LABELS the sample honestly
// (dist_matches_source in meta) so a future reader knows which stratum this
// core actually sampled. We read the source SIM_VERSION to make that label.
// (Found on 2026-06-13: a v196 gate-experiment dist sat over v195 source.)
function sourceSimVersion(vuggPath) {
  try {
    const txt = fs.readFileSync(path.join(vuggPath, 'js', '15-version.ts'), 'utf8');
    const m = txt.match(/SIM_VERSION\s*=\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function buildTarget(vuggPath) {
  console.log(`[canary] --build: running \`npm run build\` in target so dist/ matches source…`);
  // shell:true so Windows resolves npm.cmd; inherit stdio for visibility.
  execFileSync('npm', ['run', 'build'], { cwd: vuggPath, stdio: 'inherit', shell: true });
}

const HELP = `vugg-canary sweep (Phase 1)

  node src/sweep.mjs --now [options]

  --now                 run a sweep immediately (the only mode in Phase 1)
  --build               run \`npm run build\` in the target first, so dist/ matches source
  --force               sweep even if the SHA is unchanged (skip the no-change short-circuit)
  --seeds N             chemistry seeds 1..N to sweep (default: config.seeds=200)
  --scenario a,b        restrict to a comma-separated subset (default: all)
  --date YYYY-MM-DD     override the log date folder (default: today)
  --out DIR             override the logs dir (default: config.logsDir)
  --help                this text

Output: <out>/<date>/v<SIM>/<scenario>/{frequency.json, seeds.json} + meta.json
The seed-42 self-test runs every time and is recorded in meta.json.`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }
  if (!args.now) { console.error('Phase 1 requires --now (see --help)'); process.exit(2); }

  const cfg = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'canary.config.json'), 'utf8'));
  const vuggPath = path.resolve(CANARY_ROOT, cfg.vuggPath);
  const seeds = args.seeds ?? cfg.seeds ?? 200;
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const outRoot = path.resolve(CANARY_ROOT, args.out ?? cfg.logsDir ?? 'logs');

  if (!fs.existsSync(path.join(vuggPath, 'tools', '_harness.mjs'))) {
    console.error(`[canary] no tools/_harness.mjs under ${vuggPath} — is vuggPath correct?`);
    process.exit(1);
  }

  console.log(`[canary] target: ${vuggPath}`);

  // --- Phase 3a: no-change short-circuit (cheap git check, BEFORE any build/load) ---
  // A full scheduled run with an unchanged, clean tree is deterministically
  // identical to the last sweep — skip it and write a NO-CHANGE note. Manual
  // runs (--scenario / explicit --seeds) and --force always proceed.
  const meta0 = repoMeta(vuggPath);
  const fullRun = !args.scenario && args.seeds == null;
  if (fullRun && !args.force) {
    const sc = shouldShortCircuit(outRoot, { date, sha: meta0.sha, dirty: meta0.dirty, canaryVersion: CANARY_VERSION });
    if (sc.skip) {
      const note = writeNoChangeNote(outRoot, date, sc.last, meta0.sha);
      console.log(`[canary] no change — ${sc.reason} — deterministic, sweep skipped.`);
      console.log(`[canary] wrote ${path.relative(CANARY_ROOT, path.join(outRoot, date, 'NO-CHANGE.json'))} → identical_to ${note.identical_to}`);
      return;
    }
    if (sc.last) console.log(`[canary] proceeding (${sc.reason})`);
  }

  // --- optionally build the target so dist/ is guaranteed consistent with source ---
  if (args.build) buildTarget(vuggPath);

  // --- load the target repo's bundle through ITS OWN harness ---
  const harnessUrl = pathToFileURL(path.join(vuggPath, 'tools', '_harness.mjs')).href;
  const { loadSimBundle } = await import(harnessUrl);
  const { SIM_VERSION, SCENARIOS, VugSimulator, setSeed } =
    await loadSimBundle({ toolName: 'vugg-canary' });

  // --- pre-flight: is the built bundle consistent with the source we'll stamp? ---
  const srcVer = sourceSimVersion(vuggPath);
  const distMatchesSource = srcVer === null ? null : srcVer === SIM_VERSION;
  if (distMatchesSource === false) {
    console.warn(`[canary] ⚑ dist/ SIM_VERSION=${SIM_VERSION} ≠ js source SIM_VERSION=${srcVer} —`);
    console.warn(`         the scanned bundle is a different build than the committed source. Recorded as`);
    console.warn(`         dist_matches_source:false so this sample is labeled honestly. (--build for a source-fresh scan.)`);
  }

  const allNames = Object.keys(SCENARIOS).sort();
  let names = allNames;
  if (args.scenario) {
    const want = args.scenario.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = want.filter((n) => !allNames.includes(n));
    if (unknown.length) console.warn(`[canary] ignoring unknown scenarios: ${unknown.join(', ')}`);
    names = want.filter((n) => allNames.includes(n));
    if (!names.length) { console.error('[canary] no valid scenarios selected'); process.exit(1); }
  }

  console.log(`[canary] SIM_VERSION=${SIM_VERSION}  sha=${meta0.sha}${meta0.dirty ? ' (DIRTY — will never short-circuit)' : ''}`);
  console.log(`[canary] sweeping ${names.length}/${allNames.length} scenarios × ${seeds} chem-seeds (shape: scenario-authored), steps=defaultSteps??100\n`);

  const runOne = makeRunner({ SCENARIOS, VugSimulator, setSeed });

  const outDir = path.join(outRoot, date, `v${SIM_VERSION}`);
  fs.mkdirSync(outDir, { recursive: true });

  // --- sweep ---
  for (const name of names) {
    const perSeedMap = {};      // seed -> digest (heavy tier, gitignored)
    const perSeedArr = [];
    for (let s = 1; s <= seeds; s++) {
      const d = runOne(name, s);
      perSeedMap[s] = d;
      perSeedArr.push(d);
    }
    const fp = fingerprintScenario(perSeedArr);
    const sdir = path.join(outDir, name);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'frequency.json'), JSON.stringify(fp, null, 2) + '\n');
    fs.writeFileSync(path.join(sdir, 'seeds.json'), JSON.stringify(perSeedMap) + '\n');

    // one-line console summary: the 3 most-frequent species
    const top = Object.entries(fp.species)
      .sort((a, b) => b[1].pct_present - a[1].pct_present)
      .slice(0, 3)
      .map(([m, v]) => `${m} ${v.pct_present}%`)
      .join(', ');
    console.log(`  ${name.padEnd(28)} ${String(Object.keys(fp.species).length).padStart(2)} species  | ${top}`);
  }

  // --- guard 2: seed-42 self-test against the committed baseline ---
  const selftest = runSelfTest(vuggPath, SIM_VERSION, names, runOne);

  const meta = {
    date,
    sha: meta0.sha,
    branch: meta0.branch,
    dirty: meta0.dirty,
    dirty_files: meta0.dirtyFiles,
    sim_version: SIM_VERSION,
    source_sim_version: srcVer,
    dist_matches_source: distMatchesSource,
    canary_version: CANARY_VERSION,
    seed_axis: { vary: 'chem', range: [1, seeds], shape: 'scenario-authored' },
    n_seeds: seeds,
    steps_mode: 'defaultSteps??100 (matches gen-baseline)',
    scenarios: names,
    selftest: selftest.summary,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log(`\n[canary] wrote ${path.relative(CANARY_ROOT, outDir)} (${names.length} scenarios, ${seeds} seeds)`);
  if (selftest.ok === true) {
    console.log(`[canary] ✅ self-test PASS — seed-42 row matches seed42_v${SIM_VERSION}.json for all ${selftest.checked} swept scenarios`);
  } else if (selftest.ok === null) {
    console.log(`[canary] ⚠️  self-test SKIPPED — ${selftest.note}`);
  } else {
    console.log(`[canary] ⚑ self-test divergence — ${selftest.mismatches.length} scenario(s) differ from seed42_v${SIM_VERSION}.json (recorded in meta.json):`);
    for (const m of selftest.mismatches) console.log(`         - ${m.scenario}: ${m.reason}`);
    console.log(`         (passive note: the scanned layer doesn't reproduce the committed baseline — entrypoint drift or a stale baseline. The sweep is kept regardless.)`);
  }

  // --- the alarm: auto-diff against the last data-bearing day (completes the
  // nightly loop — one run both cores AND alarms). Passive: records, never throws. ---
  const prev = findLastDataBearingDay(outRoot, { excludeDate: date });
  if (prev) {
    const thresholds = cfg.diffThreshold || {};
    const fpPrev = loadVersionFingerprint(path.join(outRoot, prev.date, prev.version));
    const fpNow = loadVersionFingerprint(outDir);
    const alarms = diffFingerprints(fpPrev, fpNow, thresholds);
    const summary = summarizeAlarms(alarms);
    const record = { from: `${prev.version}@${prev.date}`, to: `v${SIM_VERSION}@${date}`, thresholds, summary, alarms };
    const diffPath = path.join(outDir, `diff-vs-${prev.version}_${prev.date}.json`);
    fs.writeFileSync(diffPath, JSON.stringify(record, null, 2) + '\n');
    if (summary.total === 0) {
      console.log(`[canary] diff vs ${prev.version}@${prev.date}: no moves past thresholds — the strata match.`);
    } else {
      console.log(`[canary] ⚑ diff vs ${prev.version}@${prev.date}: ${summary.total} alarm(s) ${JSON.stringify(summary.by_kind)} — see ${path.basename(diffPath)}`);
      for (const al of alarms.slice(0, 12)) {
        if (al.species) console.log(`         ${al.scenario} / ${al.species}: ${al.kind} ${al.pct_from}% → ${al.pct_to}%`);
        else console.log(`         ${al.scenario}: ${al.kind}`);
      }
      if (alarms.length > 12) console.log(`         … and ${alarms.length - 12} more (full list in the diff file)`);
    }
  } else {
    console.log(`[canary] first data-bearing day for this logs dir — no prior to diff against (the alarm arms on the next version).`);
  }
}

/**
 * Guard 2: run seed 42 explicitly (regardless of the sweep range) and assert
 * each scenario's digest byte-matches the committed seed42_v<SIM>.json. Because
 * decision (A) holds shape at scenario-authored and steps match gen-baseline,
 * equality is expected by construction; a mismatch is a real integrity signal.
 */
function runSelfTest(vuggPath, simV, names, runOne) {
  const blPath = path.join(vuggPath, 'tests-js', 'baselines', `seed42_v${simV}.json`);
  if (!fs.existsSync(blPath)) {
    return { ok: null, note: `no baseline seed42_v${simV}.json`, summary: { ok: null, note: `no baseline seed42_v${simV}.json` } };
  }
  const bl = JSON.parse(fs.readFileSync(blPath, 'utf8'));
  const mismatches = [];
  let checked = 0;
  for (const name of names) {
    if (!(name in bl)) { mismatches.push({ scenario: name, reason: 'scenario absent from baseline' }); continue; }
    checked++;
    const got = JSON.stringify(runOne(name, 42));
    const exp = JSON.stringify(bl[name]);
    if (got !== exp) mismatches.push({ scenario: name, reason: 'seed-42 digest mismatch' });
  }
  const ok = mismatches.length === 0;
  return {
    ok, checked, mismatches,
    summary: { ok, checked, baseline: `seed42_v${simV}.json`, mismatches: mismatches.map((m) => `${m.scenario}: ${m.reason}`) },
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
