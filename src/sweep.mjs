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
 * THE TARGET (since 2026-10-28): the canary's own vugg checkout. A full run
 * first moves it to the newest main (config.follow), then, if it is going to
 * sweep, makes it runnable (npm ci when the lockfile changed, compile dist/);
 * see src/target.mjs. Manual partial runs (--scenario / --seeds) sweep the
 * checkout as it is.
 *
 * Usage:
 *   node src/sweep.mjs --now [--seeds N] [--scenario a,b] [--date YYYY-MM-DD] [--out DIR] [--no-follow]
 *   node src/sweep.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoMeta } from './repo-meta.mjs';
import { fingerprintScenario } from './fingerprint.mjs';
import { shouldShortCircuit, writeNoChangeNote, findLastDataBearingDay, listPublishableDayDirs } from './promote.mjs';
import { loadVersionFingerprint, diffFingerprints, summarizeAlarms } from './diff.mjs';
import { makeRunner } from './run.mjs';
import { runtimeIdentity, prepareOutDir, planReuse, adoptScenario, writeScenarioIdentity } from './resume.mjs';
import { followTarget, describeFollow, prepareTarget, writeTargetFailed, TARGET_FAILED } from './target.mjs';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'package.json'), 'utf8'));
const CANARY_VERSION = PKG.version;
const STEPS_MODE = 'defaultSteps??100 (matches gen-baseline)';
const SHAPE_MODE = 'scenario-authored';

function parseArgs(argv) {
  const a = { now: false, help: false, build: false, force: false, noPublish: false, noFollow: false, seeds: null, scenario: null, date: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--now') a.now = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--build') a.build = true;
    else if (t === '--force') a.force = true;
    else if (t === '--no-publish') a.noPublish = true;
    else if (t === '--no-follow') a.noFollow = true;
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

const HELP = `vugg-canary sweep (Phase 1)

  node src/sweep.mjs --now [options]

  --now                 run a sweep immediately (the only mode in Phase 1)
  --build               compile the target's dist/ from source first (clean dist/, tsc), as a
                        full run on a followed target always does; never touches node_modules
  --no-follow           a full run that sweeps the target where it is, without fetching main
  --force               sweep even if the SHA is unchanged (skip the no-change short-circuit),
                        and recompute every scenario (no resume)
  --seeds N             chemistry seeds 1..N to sweep (default: config.seeds=200)
  --scenario a,b        restrict to a comma-separated subset (default: all)
  --date YYYY-MM-DD     override the log date folder (default: today)
  --out DIR             override the logs dir (default: config.logsDir)
  --no-publish          never commit or push the spine (manual and test runs)
  --help                this text

Output: <out>/<date>/v<SIM>/<scenario>/{frequency.json, seeds.json} + meta.json
The seed-42 self-test runs every time and is recorded in meta.json.
Resume: a scenario a killed run already finished, under this exact runtime
(commit, clean engine, dist/ bytes, canary version, seeds, Node), is reused
instead of recomputed; see src/resume.mjs.`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }
  if (!args.now) { console.error('Phase 1 requires --now (see --help)'); process.exit(2); }

  const startedAt = new Date().toISOString();
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

  // --- follow: a full run first moves the canary's own checkout to the newest main ---
  const fullRun = !args.scenario && args.seeds == null;
  const following = Boolean(cfg.follow) && fullRun && !args.noFollow;
  let follow;
  if (following) {
    follow = followTarget(vuggPath, cfg.follow);
    console.log(`[canary] ${follow.error || follow.fetch_error ? '⚑ ' : ''}follow: ${describeFollow(follow)}`);
  }

  // --- Phase 3a: no-change short-circuit (cheap git check, BEFORE any build/load) ---
  // A full scheduled run with an unchanged, clean tree is deterministically
  // identical to the last sweep — skip it and write a NO-CHANGE note. Manual
  // runs (--scenario / explicit --seeds) and --force always proceed.
  const meta0 = repoMeta(vuggPath);
  if (fullRun && !args.force) {
    // Gate on ENGINE dirt, not whole-tree dirt: a stray untracked tool or a doc
    // edit can't change the fingerprint, so it must not force a 2.5h re-sweep.
    // (Whole-tree dirt is still recorded in meta for the honest sample label.)
    const sc = shouldShortCircuit(outRoot, { date, sha: meta0.sha, dirty: meta0.engineDirty, canaryVersion: CANARY_VERSION, nSeeds: seeds });
    if (sc.skip) {
      const note = writeNoChangeNote(outRoot, date, sc.last, meta0.sha, { follow });
      console.log(`[canary] no change — ${sc.reason} — deterministic, sweep skipped.`);
      console.log(`[canary] wrote ${path.relative(CANARY_ROOT, path.join(outRoot, date, 'NO-CHANGE.json'))} → identical_to ${note.identical_to}`);
      // Publish the quiet stratum too. Pre-fix, this branch returned before
      // publishSpine ever ran, so NO quiet day was ever committed — the public
      // record had silent holes where honest "nothing changed" markers sat
      // locally (hostile review 2026-07-14, Part A finding #1).
      if (cfg.autoPush !== false && !args.noPublish) {
        publishSpine(CANARY_ROOT, outRoot, date, `canary: ${date} NO-CHANGE — identical to ${note.identical_to} (${note.version}, sha ${meta0.sha})`);
      }
      return;
    }
    if (sc.last) console.log(`[canary] proceeding (${sc.reason})`);
  }

  // --- make the target runnable: npm ci when its lockfile changed, then compile dist/ from source ---
  let prep;
  if (following || args.build) {
    prep = prepareTarget(vuggPath, { install: following });
    if (!prep.ok) {
      writeTargetFailed(outRoot, date, { stage: prep.stage, error: prep.error, sha: meta0.sha, follow });
      console.error(`[canary] ⚑ the target's ${prep.stage} failed at ${meta0.sha}; nothing swept. Wrote ${path.relative(CANARY_ROOT, path.join(outRoot, date, TARGET_FAILED))}.`);
      if (cfg.autoPush !== false && !args.noPublish) {
        publishSpine(CANARY_ROOT, outRoot, date, `canary: ${date} TARGET FAILED — ${prep.stage} failed at ${meta0.sha}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`[canary] target ready: ${prep.installed ? `npm ci (${prep.install_s} s), ` : ''}dist/ compiled from source (${prep.build_s} s)`);
  }

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

  // Two flavors of dirt in the banner: engine dirt defeats the short-circuit;
  // cosmetic dirt (stray tools/docs/WIP) is noted but harmless to the fingerprint.
  const dirtNote = meta0.engineDirty
    ? ' (ENGINE-DIRTY — will never short-circuit)'
    : meta0.dirty
      ? ` (tree dirty in ${meta0.dirtyFiles.length} non-engine path(s) — short-circuit still allowed)`
      : '';
  console.log(`[canary] SIM_VERSION=${SIM_VERSION}  sha=${meta0.sha}${dirtNote}`);
  console.log(`[canary] sweeping ${names.length}/${allNames.length} scenarios × ${seeds} chem-seeds (shape: scenario-authored), steps=defaultSteps??100\n`);

  const runOne = makeRunner({ SCENARIOS, VugSimulator, setSeed });

  const outDir = path.join(outRoot, date, `v${SIM_VERSION}`);

  // A real sweep for a date retires that date's NO-CHANGE or TARGET-FAILED
  // marker, whose claim ("nothing re-stored", "nothing swept") is now false. It
  // happened on 2026-10-28: a test trigger wrote a NO-CHANGE at 01:42, then the
  // 200 → 30 seed change made the 04:00 run a real sweep into the same folder.
  // Kept locally (gitignored); git history keeps the published one.
  for (const marker of ['NO-CHANGE.json', TARGET_FAILED]) {
    const from = path.join(outRoot, date, marker);
    if (!fs.existsSync(from)) continue;
    try {
      const to = path.join(outRoot, date, marker.replace(/\.json$/, `.superseded-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.json`));
      fs.renameSync(from, to);
      console.log(`[canary] ${date} gets a real sweep — moved its ${marker} aside to ${path.basename(to)}`);
    } catch (e) {
      console.warn(`[canary] could not move ${date}/${marker} aside (${e.message}).`);
    }
  }

  // --- resume: reuse what a killed run already finished, under this exact runtime ---
  const identity = runtimeIdentity({
    fullSha: meta0.fullSha, engineDirty: meta0.engineDirty, distDir: path.join(vuggPath, 'dist'),
    simVersion: SIM_VERSION, canaryVersion: CANARY_VERSION, nSeeds: seeds,
    stepsMode: STEPS_MODE, shape: SHAPE_MODE,
  });
  let reuse = new Map();
  try {
    const prep = prepareOutDir(outDir, identity, { planned: names.length });
    if (prep.superseded) console.log(`[canary] another run's files sat in ${path.relative(CANARY_ROOT, outDir)} — moved aside to ${path.basename(prep.superseded)}`);
    if (!args.force) reuse = planReuse(outRoot, outDir, names, identity);
  } catch (e) {
    console.warn(`[canary] resume bookkeeping failed (${e.message}) — sweeping every scenario.`);
    fs.mkdirSync(outDir, { recursive: true });
  }
  if (!identity.key) console.log(`[canary] no resume: ${identity.reason}.`);
  else if (reuse.size) console.log(`[canary] resuming: ${reuse.size}/${names.length} scenario(s) already finished by a killed run under this exact runtime.`);

  // --- sweep ---
  const reusedFrom = {};
  for (const name of names) {
    const sdir = path.join(outDir, name);
    let fp = null;
    let note = '';
    if (reuse.has(name)) {
      const src = reuse.get(name);
      try {
        if (src) adoptScenario(src, outDir, name);
        fp = JSON.parse(fs.readFileSync(path.join(sdir, 'frequency.json'), 'utf8'));
        reusedFrom[name] = src ? path.relative(outRoot, src).split(path.sep).join('/') : 'in place';
        note = `  (reused ${reusedFrom[name]})`;
      } catch (e) {
        fp = null;
        console.warn(`[canary] could not reuse ${name} (${e.message}) — recomputing it.`);
      }
    }
    if (!fp) {
      const perSeedMap = {};      // seed -> digest (heavy tier, gitignored)
      const perSeedArr = [];
      for (let s = 1; s <= seeds; s++) {
        const d = runOne(name, s);
        perSeedMap[s] = d;
        perSeedArr.push(d);
      }
      fp = fingerprintScenario(perSeedArr);
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, 'frequency.json'), JSON.stringify(fp, null, 2) + '\n');
      fs.writeFileSync(path.join(sdir, 'seeds.json'), JSON.stringify(perSeedMap) + '\n');
      // The sidecar goes last: a kill between the writes leaves no sidecar, so a
      // half-written scenario is recomputed, never reused.
      try { writeScenarioIdentity(sdir, identity); }
      catch (e) { console.warn(`[canary] could not stamp ${name} for resume (${e.message}).`); }
    }

    // one-line console summary: the 3 most-frequent species
    const top = Object.entries(fp.species)
      .sort((a, b) => b[1].pct_present - a[1].pct_present)
      .slice(0, 3)
      .map(([m, v]) => `${m} ${v.pct_present}%`)
      .join(', ');
    console.log(`  ${name.padEnd(28)} ${String(Object.keys(fp.species).length).padStart(2)} species  | ${top}${note}`);
  }

  // --- guard 2: seed-42 self-test against the committed baseline ---
  const selftest = runSelfTest(vuggPath, SIM_VERSION, names, runOne);

  const meta = {
    date,
    sha: meta0.sha,
    branch: meta0.branch,
    dirty: meta0.dirty,
    dirty_files: meta0.dirtyFiles,
    engine_dirty: meta0.engineDirty,           // the short-circuit gate (js/data/_harness)
    engine_dirty_files: meta0.engineDirtyFiles, // empty ⇒ cosmetic dirt only
    sim_version: SIM_VERSION,
    source_sim_version: srcVer,
    dist_matches_source: distMatchesSource,
    canary_version: CANARY_VERSION,
    seed_axis: { vary: 'chem', range: [1, seeds], shape: SHAPE_MODE },
    n_seeds: seeds,
    steps_mode: STEPS_MODE,
    scenarios: names,
    selftest: selftest.summary,
    runtime_identity: identity.key
      ? { key: identity.key, sha_full: identity.fields.sha, dist_sha256: identity.fields.dist_sha256, node: identity.fields.node }
      : { key: null, reason: identity.reason },
    resumed: Object.keys(reusedFrom).length ? reusedFrom : undefined,  // scenario → where it was reused from
    full_run: fullRun,                   // every scenario at config seeds: the only runs status times for the seed budget
    follow,                              // where tonight's checkout came from (src/target.mjs); absent on manual runs
    target_prep: prep ? { installed: prep.installed, install_s: prep.install_s, built: prep.built, build_s: prep.build_s } : undefined,
    started_at: startedAt,
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
  let alarmTotal = null;
  const prev = findLastDataBearingDay(outRoot, { excludeDate: date });
  if (prev) {
    const thresholds = cfg.diffThreshold || {};
    const fpPrev = loadVersionFingerprint(path.join(outRoot, prev.date, prev.version));
    const fpNow = loadVersionFingerprint(outDir);
    const alarms = diffFingerprints(fpPrev, fpNow, thresholds);
    const summary = summarizeAlarms(alarms);
    alarmTotal = summary.total;
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

  // Publish the spine to origin (Syntaxswine) in its dated folder. The .gitignore
  // keeps the heavy tiers (seeds.json / seed-*/ / strips/) local, so this commits
  // only the shareable spine (frequency.json, meta.json, diff-*.json, NO-CHANGE).
  // Off by setting "autoPush": false in canary.config.json. PASSIVE-INSTRUMENT
  // RULE: a publish failure must NEVER fail the sweep — the gathering is the point.
  if (cfg.autoPush !== false && !args.noPublish) {
    const stOk = selftest.ok === true ? 'PASS' : selftest.ok === false ? 'FAIL' : 'n/a';
    const nReused = Object.keys(reusedFrom).length;
    const note = `${names.length} scenarios${nReused ? ` (${nReused} resumed)` : ''}${alarmTotal != null ? `, ${alarmTotal} alarm(s)` : ''}, self-test ${stOk}`;
    publishSpine(CANARY_ROOT, outRoot, date, `canary: ${date} v${SIM_VERSION} spine — ${note}`);
  }
}

/**
 * Commit + push the spine to origin. Stages every PUBLISHABLE day dir under
 * outRoot (today's plus any prior day whose publish failed — offline night,
 * killed process, or the pre-fix NO-CHANGE early-return), so orphans heal on
 * the next successful publish instead of vanishing from the public record.
 * Already-committed days no-op under `git add`; partial v-dirs (no meta.json)
 * are never staged — an aborted run is not a stratum. .gitignore filters the
 * heavy regenerable tiers, so just the spine lands. Every git step is wrapped:
 * a failed add/commit/push logs a non-fatal note and returns, never throwing,
 * so the sweep (the actual product) always completes. Unattended: relies on
 * the cached credential helper, same as every other origin push here.
 */
function publishSpine(canaryRoot, outRoot, date, title) {
  const run = (args) => execFileSync('git', args, { cwd: canaryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const days = listPublishableDayDirs(outRoot);
    if (!days.length) { console.log('[canary] publish: no publishable day dirs.'); return; }
    for (const d of days) run(['add', path.relative(canaryRoot, path.join(outRoot, d))]);
    // Nothing staged (e.g. a NO-CHANGE short-circuit re-run) → skip cleanly.
    try {
      run(['diff', '--cached', '--quiet']);
      console.log('[canary] publish: nothing new to commit.');
      return;
    } catch { /* non-zero = staged changes exist → proceed to commit */ }
    // Name any prior days riding along, so the commit is honest about backfill.
    const staged = run(['diff', '--cached', '--name-only']).toString();
    const stagedDays = [...new Set([...staged.matchAll(/(\d{4}-\d{2}-\d{2})\//g)].map((m) => m[1]))];
    const backfilled = stagedDays.filter((d) => d !== date);
    const msg = backfilled.length ? `${title} (+ backfilled ${backfilled.join(', ')})` : title;
    run(['commit', '-m', msg]);
    run(['push', 'origin', 'HEAD']);
    console.log(`[canary] published ${date} spine → origin (Syntaxswine)${backfilled.length ? ` + backfill: ${backfilled.join(', ')}` : ''}.`);
  } catch (e) {
    const msg = (e && (e.stderr?.toString() || e.message)) || String(e);
    console.error(`[canary] publish FAILED (non-fatal, sweep already saved locally): ${msg.trim()}`);
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
