#!/usr/bin/env node
/**
 * src/status.mjs — surface the canary's latest state at a glance.
 *
 * Built for a session-start glance (the cheapest alarm-surfacing channel, per
 * the boss's pick): it reads the logs only — no sweep — and reports the last
 * run + the latest diff alarm, so a 04:00 regression doesn't sit unseen until
 * someone happens to open a JSON file. Add it to the vugg-session-start ritual
 * (`node ../vugg-canary/src/status.mjs`) and the morning surfaces itself.
 *
 *   node src/status.mjs [logsDirOverride]
 *
 * Passive, like the rest: it only reports. Exit code is always 0 — a loud
 * console line is the signal, not a failed process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLastDataBearingDay } from './promote.mjs';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VER_RE = /^v\d+$/;

// Never let a half-written or missing file crash the glance — a partial read
// just means "not ready", not "explode". Returns null on any read/parse failure.
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function newestDay(logsRoot) {
  if (!fs.existsSync(logsRoot)) return null;
  const days = fs.readdirSync(logsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
    .map((d) => d.name).sort().reverse();
  return days[0] || null;
}

function printAlarmFromDiff(diffPath) {
  const d = readJsonSafe(diffPath);
  if (!d || !d.summary) { console.log(`  alarm:     (diff file unreadable — ${path.basename(diffPath)})`); return; }
  if (d.summary.total === 0) {
    console.log(`  alarm:     none — strata match ${d.from}.`);
  } else {
    console.log(`  ⚑ ALARM:   ${d.summary.total} vs ${d.from}  ${JSON.stringify(d.summary.by_kind)}`);
    for (const a of d.alarms.slice(0, 8)) {
      if (a.species) console.log(`             ${a.scenario} / ${a.species}: ${a.kind} ${a.pct_from}% → ${a.pct_to}%`);
      else console.log(`             ${a.scenario}: ${a.kind}`);
    }
    if (d.alarms.length > 8) console.log(`             … +${d.alarms.length - 8} more — see ${path.basename(diffPath)}`);
  }
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'canary.config.json'), 'utf8'));
  const logsRoot = path.resolve(CANARY_ROOT, process.argv[2] || cfg.logsDir || 'logs');

  console.log('vugg-canary status');
  const day = newestDay(logsRoot);
  if (!day) { console.log('  no sweeps yet — run `npm run sweep`.'); return; }

  const dayDir = path.join(logsRoot, day);
  const vers = fs.readdirSync(dayDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && VER_RE.test(d.name)).map((d) => d.name).sort().reverse();

  // a NO-CHANGE day has no v<N>/ — report it and the day it points at
  if (vers.length === 0) {
    const ncPath = path.join(dayDir, 'NO-CHANGE.json');
    if (fs.existsSync(ncPath)) {
      const nc = JSON.parse(fs.readFileSync(ncPath, 'utf8'));
      console.log(`  ${day}:  NO CHANGE (${nc.version}, sha ${nc.sha}) — identical to ${nc.identical_to}.`);
      console.log(`             (last real data + any alarm are in ${nc.identical_to}/)`);
    } else {
      console.log(`  ${day}:  no sweep and no NO-CHANGE marker — incomplete day.`);
    }
    return;
  }

  const ver = vers[0];
  const meta = readJsonSafe(path.join(dayDir, ver, 'meta.json'));

  // A v<N>/ dir with no readable meta.json = a sweep IN PROGRESS (meta is
  // written last) or a crashed partial run. Don't crash the glance: say so,
  // then fall back to the last COMPLETED day so the morning still surfaces the
  // most recent real status + alarm.
  if (!meta) {
    const cored = fs.readdirSync(path.join(dayDir, ver), { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
    console.log(`  ${day} ${ver}:  sweep IN PROGRESS or partial — ${cored} scenario(s) cored, no meta.json yet.`);
    const last = findLastDataBearingDay(logsRoot, { excludeDate: day });
    if (!last) { console.log('  no completed sweep yet to report.'); return; }
    console.log(`  ── last completed ──`);
    reportVersion(logsRoot, last.date, last.version);
    return;
  }

  reportVersion(logsRoot, day, ver, meta);
}

/** Print the last-sweep / self-test / alarm lines for one day's version dir. */
function reportVersion(logsRoot, day, ver, meta = null) {
  const verDir = path.join(logsRoot, day, ver);
  meta = meta || readJsonSafe(path.join(verDir, 'meta.json'));
  if (!meta) { console.log(`  ${day} ${ver}: meta.json unreadable.`); return; }
  const st = meta.selftest || {};
  const stStr = st.ok === true ? 'PASS'
    : st.ok === null ? `SKIPPED (${st.note})`
    : `⚑ DIVERGENCE (${(st.mismatches || []).length})`;
  const dirtNote = meta.engine_dirty ? ', ENGINE-dirty' : meta.dirty ? ', dirty (cosmetic)' : '';
  const nScenarios = (meta.scenarios || []).length;
  console.log(`  last sweep: ${day} ${ver} (sha ${meta.sha}${dirtNote}) — ${nScenarios} scenarios × ${meta.n_seeds} seeds`);
  console.log(`  self-test:  ${stStr}`);

  const diffFile = fs.readdirSync(verDir).find((f) => f.startsWith('diff-vs-') && f.endsWith('.json'));
  if (diffFile) printAlarmFromDiff(path.join(verDir, diffFile));
  else console.log(`  alarm:     none yet (first day for this logs dir; arms on the next version).`);
}

main();
