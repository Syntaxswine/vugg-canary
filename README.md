# vugg-canary

A nightly, deterministic regression sweep for
[vugg-simulator](../vugg/vugg-simulator). It runs the canonical engine across
many chemistry seeds × every scenario, reduces each scenario to a per-species
**frequency table**, and (Phase 2) diffs that fingerprint version-over-version
to raise an alarm when a new build silently moves what the rocks produce.

> **Why it exists:** a *correct* physics fix (the v196 sphalerite/wurtzite
> redox gate) silently halved an abundant, geologically-correct phase in one
> scenario — supergene mottramite fell from 96% → 47% of seeds via RNG-cascade
> displacement. It was caught only because someone ran a 100-seed sweep *by
> hand*. The canary does that sweep automatically, for every scenario, every
> version. See [PROPOSAL.md](PROPOSAL.md) for the full design.

## Status

- **Phase 1 — the sweep engine** ✅ Runs N chem-seeds × all scenarios, emits
  per-scenario frequency tables + per-seed digests, self-tests its seed-42 row
  against the committed baseline.
- **Phase 2 — the version-diff alarm** ✅ `src/diff.mjs` compares two swept
  versions and flags spawn-% moves past threshold (the mottramite-detector).
  `npm test` covers the alarm logic; a two-identical-sweeps diff confirms zero
  false positives on real engine output.
- **Phase 3a — the no-change short-circuit** ✅ `src/promote.mjs`. A full run
  whose SHA + canary version match the last data-bearing day, on a clean tree,
  is deterministically identical — so it writes a one-file `NO-CHANGE.json`
  (pointing `identical_to` the last real day) and skips the 3–4h sweep. A dirty
  tree never short-circuits (re-core a disturbed layer). `--force` overrides;
  manual `--scenario`/`--seeds` runs bypass it.
- **The alarm wired into the sweep** ✅ a full `--now` run now auto-diffs against
  the last data-bearing day and writes `diff-vs-<ver>_<date>.json` — one run
  both cores AND alarms (the real nightly behavior).
- **Phase 4 — `regenerate`** ✅ `src/regenerate.mjs <date> <scenario> <seed>`
  rebuilds any single run on demand from `(SHA, seed)` — the heavy tier is a
  cache, not lost data. Reproduces & verifies against the stored digest when the
  code matches.
- **Phase 5 — the scheduler** ✅ armed (daily 04:00). `src/schedule.mjs` prints
  what it would arm by default and arms nothing; `--install` (a deliberate
  human step) registers it, `--status` reads the live task back against
  `src/task-spec.mjs`, `--uninstall` removes it. Since 2026-10-28 the task runs
  **headless** (`conhost.exe --headless`): the visible console it used to open
  got closed or Ctrl+C'd mid-sweep, and 67 nightly sweeps in a row (2026-08-16
  → 10-25) died before one finished.
- **Resume** ✅ `src/resume.mjs`. A killed sweep's finished scenarios are reused
  by the next run instead of recomputed, but only under the exact same runtime
  (see [Resume](#resume-a-killed-sweep)).
- **Status glance** ✅ `src/status.mjs`, run by the vugg session-start ritual:
  the last finished observation and its age (⚑ STALE past 2 days), killed runs
  since, a sweep in progress, where the target came from and nights it could
  not be built, the last sweep's self-test and alarm, how many seeds fit one
  night, and any drift between the armed task and `src/task-spec.mjs`.
- **Follows main** ✅ `src/target.mjs` (2026-10-28). The canary sweeps its own
  vugg checkout and moves it to the newest `origin/main` before every full run,
  then installs and compiles it before sweeping (see
  [The target](#the-target-its-own-checkout-that-follows-main)). Until then it
  swept the checkout people work in, which sat on a September branch 94
  commits behind main, so it would have reported NO-CHANGE every night.

**3b**, the two-folder `today/`/`tomorrow/` promote, is now covered by the
canary's own checkout: main plays `tomorrow/`, and the canary's worktree is the
frozen `today/` that moves only at 04:00.

## Run it

```sh
node src/sweep.mjs --now                      # full sweep (config.seeds = 30): follow main, compile, sweep
node src/sweep.mjs --now --no-follow          # full sweep of the target where it is
node src/sweep.mjs --now --seeds 5 --scenario mvt,supergene_oxidation --no-publish   # smoke (never moves the target)
node src/sweep.mjs --help

node src/diff.mjs <olderVersionDir> <newerVersionDir>   # standalone regression diff
node src/regenerate.mjs <date> <scenario> <seed>        # rebuild one run on demand
node src/status.mjs                                     # glance: freshness, killed runs, alarm, task drift (session-start)
node src/schedule.mjs                                   # print the 04:00 task cmd (arms nothing)
node src/schedule.mjs --install                         # arm it headless (deliberate, human-only step)
node src/schedule.mjs --status                          # read the live task back, report drift
npm test                                                # alarm, short-circuit, status, creep, resume, target, nightly (92 tests)
```

### The target: its own checkout that follows main

`vuggPath` is `../vugg/vugg-canary-target`, a detached worktree of the vugg
repo that belongs to the canary. Nobody works in it. A full run (the nightly)
does this before anything else:

1. **Follow.** `git fetch origin main`, then check the fetched tip out
   (detached). `meta.json`, `NO-CHANGE.json` and `TARGET-FAILED.json` record
   the move as `follow: {from, to, moved, fast_forward}`. A failed fetch keeps
   the old commit and the night goes on with it. A tracked edit in the checkout
   means someone worked in it: the canary leaves it where it is and records
   why, rather than discard the edit. An untracked file doesn't block the move.
2. **Short-circuit.** Same commit, canary version and seed count as the last
   sweep, on a clean engine: NO-CHANGE, and nothing is installed or built.
3. **Prepare.** `npm ci --ignore-scripts` when `package-lock.json` changed
   since the canary's last install (stamped in
   `node_modules/.canary-install.json`), then the compile step of vugg's
   `tools/build-all.mjs`: clean `dist/`, `tsc -p tsconfig.json`. Not all of
   `npm run build`: that also regenerates the narrative manifest and
   re-splices `index.html`, both tracked, and the harness reads only `dist/`.
   So the canary never edits its own checkout. If the install or the compile
   fails, the day gets a `TARGET-FAILED.json` (stage, commit, the output's
   tail), it is published like a NO-CHANGE day, and status flags it. The next
   night tries again.

Manual runs with `--scenario` or `--seeds` sweep the checkout as it is.
`--no-follow` does a full run without fetching. To recreate the checkout:

```sh
git -C ../vugg/vugg-simulator fetch origin main
git -C ../vugg/vugg-simulator worktree add --detach ../vugg-canary-target FETCH_HEAD
```

The next nightly installs and compiles it.

### Resume a killed sweep

A sweep writes each scenario's `frequency.json` + `seeds.json` the moment it
finishes and `meta.json` only at the end, so a killed sweep leaves its finished
scenarios behind. The next run reuses them instead of starting from scenario
one, first from an earlier attempt into the same day folder, then from the
newest killed run of another day (copied, never moved).

Reuse requires the **same runtime**: target commit, a clean engine tree, the
built `dist/` bytes, canary version, seed count, step rule, shape mode and Node
version hash into one key, stamped beside every finished scenario as a local
`identity.json`. A scenario is reused only when its stamp matches the key the
new run computes; an engine-dirty tree never resumes. The stamp is written last,
so a scenario killed mid-write is recomputed. Leftovers of a different runtime
in today's folder are moved aside to `v<N>.superseded-<UTC stamp>/`, not deleted.
`meta.json` records `runtime_identity` and which scenarios were `resumed`, and
from where. `--force` recomputes everything.

### The alarm (Phase 2)

`diff.mjs` compares two swept versions' frequency tables and flags, per
`(scenario, species)`:

- **abs_move** — both versions present it, `|Δ spawn-%| ≥ absPts` (39 at 30
  seeds; 15 at 200). The blunt, reliable signal; supergene mottramite 96→47 is
  this, and it still alarms at 30 seeds.
- **rel_move** — a rare-but-present species whose spawn-% swung ≥2×, with its
  high side at or above the floor, which the absolute gate would miss on
  low-frequency phases.
- **appeared / disappeared** — a phase crossed the present/absent line and the
  nonzero side clears the floor (below it is sampling noise).

The floor is 3 seeds' worth of the smaller of the two sweeps, never below 2%:
10% at 30 seeds, 2% at 200 (`minSeedsForRel`, `minPctForRel`).

### Seed budget

Since 2026-10-28 the nightly sweeps **30 seeds**, down from 200. At v285 a seed
costs 9.3 min across the 41 scenarios (supergene_oxidation, tn457_barite_pulses,
reactive_wall and bisbee are 74% of it), so 200 seeds took 31 h and could not
finish in a night; 30 seeds is about 4.8 h. `absPts` moves with the seed count:
it is three standard errors of a spawn-% difference at the noisiest frequency,
`300·√(0.5/N)` points, so 15 at 200 seeds and 39 at 30. `status.mjs` flags a
config where the two don't fit.

| seeds | sweep at v285 costs | absPts |
|---|---|---|
| 200 | ~31 h | 15 |
| 50 | ~7.9 h | 30 |
| 40 | ~6.4 h | 34 |
| 30 | ~4.8 h | 39 |

Checked on the 10-26 sweep's own per-seed digests (one engine, so every alarm
is false): disjoint 30-seed blocks raise 0.8 false alarms per pair at 39 pts /
3 seeds (mostly rel_move; 0.33 with relMult 3), against 4.4 at 15 pts / 2%.

**Go back up** once the wall-dissolution proxy fix is in main (vugg PR #41,
branch `perf/surface-raw-reads`; the slow four spend most of their time in a
read-only Proxy around the cavity mesh). The canary follows main, so its first
sweep with the fix times the faster engine. `status.mjs` divides each full,
unresumed sweep's wall time by its seeds plus the seed-42 self-test pass, and
when at least a quarter more seeds fit 04:00–09:00 than are configured it
prints `⚑ seeds: ~N fit 04:00–09:00 … go back up: seeds N, absPts M`. Take
them, and move `absPts` with them. It also flags a sweep that overruns the
night. Contention during the sweep only makes the estimate low. The no-change
short-circuit compares seed counts, so the first night after a change always
sweeps.

It writes `diff-vs-<olderVer>.json` and prints a summary. Like the sweep, it's
passive: it *records* alarms and never exits nonzero — surfacing the move is the
job; a human adjudicates expected-churn (e.g. an RNG-derivation rebake lights up
many alarms by design) vs a real regression.

No `npm install` needed — the canary has **zero dependencies**. It dynamically
imports the target repo's `tools/_harness.mjs`, which resolves jsdom and the
built `dist/` bundle from vugg's own `node_modules`. (The target must have been
built once: `npm run build` in the vugg repo.)

## What it is (and isn't)

It's a **passive sediment scanner**, not a CI gate. Each night it cores the
stratum main has laid down (its own checkout, moved to main at 04:00) and
accretes a longitudinal record of what the rocks produce. It does **not** need to be the
newest version, and it never *halts* the gathering when something looks off — it
**annotates the sample honestly and keeps coring**. The value is the accreted
record over time, not catching the latest commit.

That principle shapes the guards below: they're honest *labels on a passive
sample*, not gatekeeping.

- **Same entrypoint as the baselines.** The sweep reuses vugg's
  `tools/_harness.mjs` verbatim and runs `defaultSteps ?? 100` — exactly what
  `gen-js-baseline.mjs` does. So a canary run is the same pure function of
  `(code, chem seed, shape seed)` the calibration tests rely on.
- **Seed-42 calibration note (every run).** Because the canonical shape is held
  at each scenario's authored `shape_seed` (decision A), the canary's `seed-42`
  row *equals* `tests-js/baselines/seed42_v<N>.json` by construction. The sweep
  records whether that equality held — a margin note on the core (did the drill
  read true depth?). A divergence is logged, not fatal.
- **Honest version + dirt labels.** `meta.json` stamps `{sha, dirty,
  dirty_files, dist_matches_source}`. A SHA can't see uncommitted edits or a
  stale `dist/`, so the scan records the disturbed-layer condition rather than
  trusting the SHA blindly. (Phase 3's no-change short-circuit will simply
  re-scan a dirty tree instead of skipping — when in doubt, gather the data.)

## Decisions taken (from the proposal's open list)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Canonical shape seed | **(A)** `(chem=42, shape=scenario-authored)` — one source of truth with the baselines |
| 2 | Sweep axis | vary chemistry 1..N, hold shape (assemblage robustness is chem-driven) |
| 3 | Diff alarm threshold | ±15 spawn-% points, **plus** a >2× relative gate for rare-but-present species; at 30 seeds (2026-10-28) ±39 points and a 3-seed rare-species floor |
| 4 | Commit the spine | yes — `frequency.json`/`meta.json`/diffs are committable; heavy tiers gitignored, regenerable |
| 5 | Seeds per night | 30 (2026-10-28), so a sweep finishes in a night; back up once the wall-dissolution proxy fix is in main (status says when) |
| 6 | What it sweeps | its own vugg worktree, moved to `origin/main` before every full run and compiled before sweeping (2026-10-28) |

## Output layout

```
logs/<date>/
  NO-CHANGE.json                  # instead of v<SIM>/: main unchanged since the last sweep (with the night's fetch)
  TARGET-FAILED.json              # instead of v<SIM>/: the target could not be installed or compiled
logs/<date>/v<SIM>/
  meta.json                       # sha, dirty, sim_version, seed axis, self-test, runtime identity, resumed,
                                  #   follow (where the checkout came from), target_prep, started_at, full_run
  sweep-identity.json             # local: the runtime key + every attempt (pid, start, planned scenarios)
  <scenario>/
    frequency.json                # SPINE: per-species pct_present, mean_count, size dist (committable)
    seeds.json                    # heavy tier: every seed's digest (gitignored, regenerable)
    identity.json                 # local: the runtime key that produced this scenario (resume)
```

Phase 1 stores all per-seed digests in one compact `seeds.json` per scenario
rather than the proposal's `seed-NNN/` folders (6600 folders is filesystem-heavy
on Windows); the data is identical and still per-seed browsable. The folder
explosion can be added later if a use case needs it.
