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
  since, a sweep in progress, the last sweep's self-test and alarm, and any
  drift between the armed task and `src/task-spec.mjs`.

Deferred by choice: **3b** the two-folder `today/`/`tomorrow/` promote. The
canary sweeps the configured `vuggPath` (the live checkout) directly; the
no-change short-circuit already prevents redundant runs. The promote is a
*gate* (don't record half-finished work) worth adding only if that need
appears — its copy mechanics are machine-specific.

## Run it

```sh
node src/sweep.mjs --now                      # full sweep (config.seeds = 200)
node src/sweep.mjs --now --seeds 5 --scenario mvt,supergene_oxidation --no-publish   # smoke
node src/sweep.mjs --help

node src/diff.mjs <olderVersionDir> <newerVersionDir>   # standalone regression diff
node src/regenerate.mjs <date> <scenario> <seed>        # rebuild one run on demand
node src/status.mjs                                     # glance: freshness, killed runs, alarm, task drift (session-start)
node src/schedule.mjs                                   # print the 04:00 task cmd (arms nothing)
node src/schedule.mjs --install                         # arm it headless (deliberate, human-only step)
node src/schedule.mjs --status                          # read the live task back, report drift
npm test                                                # alarm, short-circuit, status, creep, resume (51 tests)
```

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

- **abs_move** — both versions present it, `|Δ spawn-%| ≥ 15 pts` (the blunt,
  reliable signal; supergene mottramite 96→47 is this).
- **rel_move** — a rare-but-present species (≥2%) whose spawn-% swung ≥2×, which
  the absolute gate would miss on low-frequency phases.
- **appeared / disappeared** — a phase crossed the present/absent line and the
  nonzero side clears the 2% floor (below it is sampling noise).

It writes `diff-vs-<olderVer>.json` and prints a summary. Like the sweep, it's
passive: it *records* alarms and never exits nonzero — surfacing the move is the
job; a human adjudicates expected-churn (e.g. an RNG-derivation rebake lights up
many alarms by design) vs a real regression.

No `npm install` needed — the canary has **zero dependencies**. It dynamically
imports the target repo's `tools/_harness.mjs`, which resolves jsdom and the
built `dist/` bundle from vugg's own `node_modules`. (The target must have been
built once: `npm run build` in the vugg repo.)

## What it is (and isn't)

It's a **passive sediment scanner**, not a CI gate. Each day it cores whatever
stratum is sitting in the target (`today/` once the promote lands) and accretes
a longitudinal record of what the rocks produce. It does **not** need to be the
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
| 3 | Diff alarm threshold | ±15 spawn-% points, **plus** a >2× relative gate for rare-but-present species |
| 4 | Commit the spine | yes — `frequency.json`/`meta.json`/diffs are committable; heavy tiers gitignored, regenerable |

## Output layout

```
logs/<date>/v<SIM>/
  meta.json                       # sha, dirty, sim_version, seed axis, self-test, runtime identity, resumed
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
