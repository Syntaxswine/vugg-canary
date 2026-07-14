// src/promote.mjs — Phase 3a: the no-change short-circuit.
//
// vugg's engine is a pure function of (code, chem seed, shape seed). So if the
// target's commit SHA (and the canary tool's own version) match the last
// data-bearing day, today's sweep would be byte-identical — there's nothing to
// learn by running it. We detect that, write a tiny NO-CHANGE.json pointing at
// the last real day, and skip the 3-4h sweep. Determinism makes the skip safe.
//
// THE DIRT CAVEAT (fresh-eyes fix #1, kept under the sediment-scanner framing):
// a SHA can't see uncommitted edits or a stale dist/. So a dirty tree NEVER
// short-circuits — when the layer is disturbed, we just re-core it. Gathering
// data is the default; cleverness about skipping only applies to a clean,
// SHA-vouched layer.

import fs from 'node:fs';
import path from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VER_RE = /^v\d+$/;

/**
 * Walk the logs dir newest-first and return the most recent DATA-BEARING day
 * (one that actually swept — has a v<N>/meta.json), skipping NO-CHANGE days so
 * `identical_to` never chains note→note. Excludes `excludeDate` (today's own
 * in-progress folder) so we compare against a PRIOR real sweep.
 *
 * @returns {{date, version, sha, canary_version}|null}
 */
export function findLastDataBearingDay(logsRoot, { excludeDate } = {}) {
  if (!fs.existsSync(logsRoot)) return null;
  const dates = fs.readdirSync(logsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
    .map((d) => d.name)
    .filter((d) => d !== excludeDate)
    .sort()
    .reverse();

  for (const date of dates) {
    const dayDir = path.join(logsRoot, date);
    const vdirs = fs.readdirSync(dayDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VER_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const v of vdirs) {
      const metaPath = path.join(dayDir, v, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return { date, version: v, sha: m.sha, canary_version: m.canary_version };
      } catch { /* unreadable meta → not data-bearing, keep looking */ }
    }
  }
  return null;
}

/**
 * Decide whether today's run can short-circuit. Returns { skip, reason, last }.
 * skip=true only when a prior data-bearing day exists with the SAME sha + canary
 * version AND the tree is clean.
 */
export function shouldShortCircuit(logsRoot, { date, sha, dirty, canaryVersion }) {
  const last = findLastDataBearingDay(logsRoot, { excludeDate: date });
  if (!last) return { skip: false, reason: 'no prior data-bearing day', last: null };
  if (last.sha !== sha) return { skip: false, reason: `sha changed (${last.sha} → ${sha})`, last };
  if (last.canary_version !== canaryVersion) return { skip: false, reason: `canary tool version changed (${last.canary_version} → ${canaryVersion})`, last };
  if (dirty) return { skip: false, reason: 'engine paths dirty (uncommitted js/data/harness) — re-core a disturbed layer', last };
  return { skip: true, reason: `unchanged since ${last.date} (sha ${sha})`, last };
}

/**
 * List every dated day dir that is PUBLISHABLE — i.e. represents a COMPLETED
 * canary observation: either a NO-CHANGE marker, or at least one v<N> dir whose
 * sweep finished (meta.json present). Partial v-dirs (killed mid-sweep, no
 * meta.json) and empty day dirs are NOT publishable — an aborted run is not a
 * stratum. Used by the publish step for catch-up staging, so a day whose
 * publish failed (offline night, or the pre-fix NO-CHANGE early-return) is
 * swept into the next successful publish instead of being orphaned forever
 * (hostile review 2026-07-14, Part A: 3 NO-CHANGE days existed locally,
 * 0 ever committed).
 *
 * @returns {string[]} day-dir names (YYYY-MM-DD), sorted ascending
 */
export function listPublishableDayDirs(logsRoot) {
  if (!fs.existsSync(logsRoot)) return [];
  const out = [];
  const dates = fs.readdirSync(logsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const date of dates) {
    const dayDir = path.join(logsRoot, date);
    if (fs.existsSync(path.join(dayDir, 'NO-CHANGE.json'))) { out.push(date); continue; }
    const complete = fs.readdirSync(dayDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VER_RE.test(d.name))
      .some((v) => fs.existsSync(path.join(dayDir, v.name, 'meta.json')));
    if (complete) out.push(date);
  }
  return out;
}

/** Write the one-file NO-CHANGE marker for a day whose version is unchanged. */
export function writeNoChangeNote(logsRoot, date, last, sha) {
  const note = {
    date,
    version: last.version,
    sha,
    identical_to: last.date,            // always a real day, never a note→note chain
    note: `target unchanged since last sweep (sha ${sha}); deterministic → output identical, not re-stored`,
  };
  const dayDir = path.join(logsRoot, date);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'NO-CHANGE.json'), JSON.stringify(note, null, 2) + '\n');
  return note;
}
