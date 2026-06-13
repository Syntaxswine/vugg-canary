# PROPOSAL — vugg-canary: a nightly deterministic regression sweep for vugg-simulator

Status: DRAFT for review (2026-06-13). Not built yet.

## Why this exists (the origin)

On 2026-06-12/13 a correct physics fix (the sphalerite/wurtzite redox gate,
v196) silently halved an abundant, geologically-correct phase in one
scenario: supergene mottramite fell from **96% of seeds to 47%** via RNG
cascade displacement. It was caught only because someone ran a 100-seed
pre/post sweep *by hand*. A bot doing that sweep nightly, for every
scenario, version over version, turns "I happened to check" into "nothing
regresses unseen." That is the entire point of vugg-canary: an automated,
longitudinal, **determinism-backed** record of what the canonical vugg
produces — and an alarm when a new version moves it.

## What it is

A standalone tool (its own repo; publishable on GitHub but always run
LOCALLY) that, once a day at 04:00, sweeps a frozen copy of vugg-simulator
across 200 seed pairs × every scenario, reduces the runs to a compact
statistical fingerprint, diffs that fingerprint against the previous
version, and writes a dated log. It runs independently of Claude (Windows
Task Scheduler), needs only Node + a copy of the vugg repo, and never
phones home.

## Architecture

### Two-folder promote (staging)

```
vugg-canary/
  today/        ← the FROZEN version being swept (a copy of vugg-simulator)
  tomorrow/     ← staging: shipped updates are dropped here when ready
```

- As vugg-simulator is updated, the builder drops the ready version into
  `tomorrow/` (a working-tree copy, or a `git pull` of a chosen ref).
  This is the deliberate gate: not-yet-ready work doesn't get swept just
  because it was pushed.
- At 04:00 the bot promotes `tomorrow/` → `today/` (replace), then sweeps
  `today/`. If `tomorrow/` was never updated, `today/` is unchanged — see
  the no-change short-circuit below.

### The 04:00 run

1. Read `today/`'s git commit SHA + SIM_VERSION.
2. **No-change short-circuit:** if the SHA (and the canary tool version)
   match the last data-bearing day, the sweep output is *deterministically
   identical* — so skip the 3–4 h sweep entirely and write only a tiny
   note (below). Determinism makes this safe: no run needed to know the
   answer.
3. Otherwise: sweep 200 seed pairs × all scenarios, reduce, diff vs the
   previous version's fingerprint, write the day's log.

## The seed model (the "seed pairs")

Every vugg run is driven by **two independent PRNGs**:

- **chemistry seed** — the global Mulberry32 (`setSeed(n)`), drives the
  nucleation/chemistry cascade. This is what determines the *assemblage*
  (which species nucleate, how many) — the regression signal.
- **shape seed** — `wall.shape_seed`, a separate Mulberry32 for cavity
  geometry (bubble positions/radii). Affects the *vessel*, not the
  chemistry, except indirectly through substrate.

Canonically the pair is written `(42, 42)`, BUT — **decision needed** —
the existing seed-42 calibration baselines actually run
`(chem=42, shape=scenario-authored)`: each scenario's JSON carries its own
`shape_seed` (mvt=3, elmwood, …). Two readings of "canonical":

- **(A) `(42, scenario-shape)`** — matches the existing baselines exactly;
  the canary's seed-042 row equals `seed42_v*.json`. RECOMMENDED (keeps one
  source of truth for "canonical").
- **(B) `(42, 42)`** — the literal mental model, but forcing shape=42 would
  change every scenario's geometry away from its authored cavity and
  diverge from the calibration baselines.

The 200-run sweep dimension — **decision needed**, proposed default:
**vary the chemistry seed 1..200, hold shape at the canonical value**
(option A's scenario-shape, or B's 42). Rationale: assemblage robustness
(the thing we regression-test) is chemistry-driven; varying shape explores
geometry, which matters less for "did a species' spawn rate move." A shape
sweep can be added as a second axis later. Each `seed-NNN/` folder records
its exact `(chem, shape)` pair in its manifest regardless.

## Output layout

```
logs/
  2026-06-13/                         ← dated folder (ISO; sorts, survives gaps)
    fingerprint.json                  ← THE SPINE: per-scenario freq tables (kept forever)
    diff-vs-v195.json                 ← regression alarm: species whose % moved >±15 pts
    meta.json                         ← { sha, sim_version, canary_version, seed_axis }
    v196/                             ← version swept that day
      mvt/
        frequency.json                ← per-species: present-in-N/200, mean count, size dist
        seed-001/ … seed-200/         ← per-seed count digest (~1 KB each) + (chem,shape) pair
      supergene_oxidation/
      … (every scenario)
  2026-06-14/
    NO-CHANGE.json                    ← { date, version, sha, identical_to: "2026-06-13", note }
```

### Storage tiers (kept vs regenerable)

| Tier | Per run | Per year (dedup'd) | Keep? |
|------|---------|--------------------|-------|
| **Spine** — freq tables + version-diff | — | **~20 MB** | forever (git-friendly) |
| **Per-seed count digests** — browse any run | ~1 KB | **~120 MB gz** | yes (the 200 folders) |
| **Sampled full strips** — a few canonical seeds/version | ~80 KB | **~1–2 GB** | yes (continues the strip-story archive) |
| Full strips, all 200 seeds | ~80 KB | ~75 GB | NO — regenerate on demand |

Everything heavier than the kept tiers is **reproducible from
`(SHA, chem, shape)`** — determinism means the raw 200×33 runs are a cache,
not an archive. The canary ships a `regenerate <date> <scenario> <seed>`
command that reconstructs any full run on demand.

### The no-change note (boss refinement, 2026-06-13)

A day whose version is unchanged writes one trivial file and stores no
data — the note carries the same information as a duplicate dataset:

```json
{ "date": "2026-06-14", "version": "v196", "sha": "12833b9",
  "identical_to": "2026-06-13",
  "note": "today/ unchanged since last sweep; deterministic → output identical, not re-stored" }
```

`identical_to` always points at the last **data-bearing** day (never a
note→note chain), so a two-week quiet stretch is 14 notes all referencing
one real dataset. The regenerator follows `identical_to` to the bytes.

## The analysis spine (the actual value)

The raw runs are substrate; the **fingerprint** is the product. Per
`(version, scenario)`:

- **frequency table** — for each species: % of the 200 seeds it appears in,
  mean crystal count, size distribution (min/median/max µm). This is the
  generalization of the mottramite-frequency-sweep that caught the bug.
- **version diff** — when a new version lands, auto-compare every species'
  spawn-% against the previous version and flag any move beyond a threshold
  (default ±15 points). THIS is the alarm. The mottramite 96→47% would
  have tripped it at 04:00 with no one watching.

## Determinism & traceability

Vugg has no `Math.random`/`Date.now` in the engine (enforced) — every run
is a pure function of `(code, chem seed, shape seed)`. The canary stamps
each day's `meta.json` with the exact commit SHA, so any log ties to exact
code and any run is regenerable. (The canary tool's own version is also
stamped, so a change to the sweep/format triggers a fresh run even when
vugg is unchanged.)

## Repo & publishing

- Own repo, `vugg-canary`. CODE may be published (GitHub, Syntaxswine) —
  it's a clean reusable harness — but it always RUNS locally.
- **Logs stay local** (gitignored data dir). The spine (~20 MB/yr) could
  optionally be committed for shareable longitudinal history; the
  count-digest and strip tiers stay out of git. Decision: commit the spine
  or keep all logs local?

## Consolidation (what this subsumes)

- `tools/gen-strip-archive.mjs` (seed-42, all scenarios) becomes one slice
  of the canary's sampled-strip tier.
- `tools/mottramite-frequency-sweep.mjs` and the redox-census/probe family
  generalize into the canary's per-scenario frequency engine.
- `tools/strip-archive-diff.mjs` is the interactive companion to the
  canary's automated version-diff.

Net: the manual, one-off sweep tools built this week become the canary's
nightly automatic spine.

## Build phases (proposed)

1. **Sweep engine** — run N seed pairs × all scenarios over a `today/`
   copy; emit per-scenario frequency tables + per-seed count digests.
2. **Spine + diff** — fingerprint.json + version-diff alarm.
3. **Promote + dedup** — two-folder promote; no-change short-circuit + note.
4. **Sampled strips + regenerate** — canonical-seed strip archival; the
   `regenerate` command.
5. **Scheduler** — Windows Task Scheduler registration for 04:00; a
   one-shot `--now` for manual runs.

## Open decisions (need boss input)

1. **Canonical shape seed:** (A) `(42, scenario-authored)` [matches
   existing baselines — recommended] or (B) `(42, 42)` [literal, diverges].
2. **Sweep axis:** vary chemistry 1..200 at fixed shape [recommended], or
   vary both, or a grid.
3. **Diff threshold:** ±15 spawn-% points to raise an alarm? (tunable)
4. **Commit the spine to git** for shareable history, or keep all logs
   local?
