#!/usr/bin/env node
/**
 * src/status.mjs — surface the canary's latest state at a glance.
 *
 * Built for a session-start glance (the cheapest alarm-surfacing channel, per
 * the boss's pick): it reads the logs only — no sweep — and reports the last
 * run + the latest diff alarm, so a 04:00 regression doesn't sit unseen until
 * someone happens to open a JSON file. The vugg-session-start ritual runs it.
 *
 * It must also surface a canary that has quietly STOPPED. From 2026-08-16 to
 * 10-25 every nightly sweep was killed before it finished, and nobody noticed
 * for ten weeks because this glance was never wired into the ritual. So it
 * reports how old the last finished observation is, the killed runs since, a
 * sweep in progress, and whether the armed task still matches task-spec.mjs.
 *
 *   node src/status.mjs [logsDirOverride] [--no-task]
 *
 * Passive, like the rest: it only reports. Exit code is always 0 — a loud
 * console line is the signal, not a failed process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLastDataBearingDay } from './promote.mjs';
import { SWEEP_IDENTITY } from './resume.mjs';
import { readTask, taskDrift } from './task-spec.mjs';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VER_RE = /^v\d+$/;
// One missed night is normal: a full sweep can outlast 24 h, and the task skips
// a launch while one is still running. Two days without a finished observation
// (a sweep or a NO-CHANGE marker) means the canary has stopped.
const STALE_DAYS = 2;

// Never let a half-written or missing file crash the glance — a partial read
// just means "not ready", not "explode". Returns null on any read/parse failure.
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** What one dated day dir holds: a finished sweep, a NO-CHANGE marker, a partial run, or nothing. */
function dayState(logsRoot, date) {
  const dayDir = path.join(logsRoot, date);
  const nc = readJsonSafe(path.join(dayDir, 'NO-CHANGE.json'));
  if (nc) return { date, kind: 'nochange', nc };
  let vers = [];
  try {
    vers = fs.readdirSync(dayDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VER_RE.test(d.name)).map((d) => d.name).sort().reverse();
  } catch { /* unreadable day dir → treated as empty */ }
  for (const ver of vers) {
    const meta = readJsonSafe(path.join(dayDir, ver, 'meta.json'));
    if (meta) return { date, kind: 'sweep', ver, meta };
  }
  if (!vers.length) return { date, kind: 'empty' };
  // A v<N>/ dir with no readable meta.json = a sweep IN PROGRESS (meta is
  // written last) or one that was killed. sweep-identity.json (written at the
  // start of every attempt) tells them apart by its pid.
  const ver = vers[0];
  const vdir = path.join(dayDir, ver);
  let cored = 0;
  try {
    cored = fs.readdirSync(vdir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(vdir, d.name, 'frequency.json'))).length;
  } catch { /* count stays 0 */ }
  const attempts = readJsonSafe(path.join(vdir, SWEEP_IDENTITY))?.attempts || [];
  const last = attempts[attempts.length - 1] || null;
  return {
    date, kind: 'partial', ver, cored, attempts: attempts.length,
    planned: last?.planned ?? null, startedAt: last?.started_at ?? null,
    pid: last?.pid ?? null, alive: last ? pidAlive(last.pid) : null,
  };
}

const progress = (s) => `${s.cored}${s.planned ? `/${s.planned}` : ''} scenario(s) cored`;

function main() {
  const argv = process.argv.slice(2);
  const skipTask = argv.includes('--no-task');
  const logsArg = argv.find((a) => !a.startsWith('--'));
  const cfg = readJsonSafe(path.join(CANARY_ROOT, 'canary.config.json')) || {};
  const logsRoot = path.resolve(CANARY_ROOT, logsArg || cfg.logsDir || 'logs');
  const today = process.env.CANARY_STATUS_TODAY || new Date().toISOString().slice(0, 10);

  console.log('vugg-canary status');
  try { reportLogs(logsRoot, today); }
  catch (e) { console.log(`  (could not read the logs: ${e.message})`); }
  if (!skipTask && process.platform === 'win32') reportTask();
}

function reportLogs(logsRoot, today) {
  let days = [];
  try {
    days = fs.readdirSync(logsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && DATE_RE.test(d.name)).map((d) => d.name).sort();
  } catch { /* no logs dir yet */ }
  if (!days.length) { console.log('  no sweeps yet — run `npm run sweep`.'); return; }

  const states = days.map((d) => dayState(logsRoot, d));
  let lastObsIdx = -1;
  states.forEach((s, i) => { if (s.kind === 'sweep' || s.kind === 'nochange') lastObsIdx = i; });
  const lastObs = lastObsIdx >= 0 ? states[lastObsIdx] : null;
  const since = states.slice(lastObsIdx + 1).filter((s) => s.kind === 'partial');
  const newest = states[states.length - 1];

  // 1. freshness: when did the canary last FINISH an observation?
  if (!lastObs) {
    console.log('  ⚑ no finished observation yet — no completed sweep and no NO-CHANGE day.');
  } else {
    const age = Math.round((Date.parse(today) - Date.parse(lastObs.date)) / 86400000);
    const what = lastObs.kind === 'nochange'
      ? `NO CHANGE (${lastObs.nc.version}, sha ${lastObs.nc.sha}) — identical to ${lastObs.nc.identical_to}`
      : `sweep ${lastObs.ver} (sha ${lastObs.meta.sha})`;
    console.log(`  ${age > STALE_DAYS ? '⚑ STALE — ' : ''}last observation: ${lastObs.date} ${what} · ${age} d ago`);
  }

  // 2. runs since then: live, unknown, or killed
  const killed = [];
  for (const s of since) {
    if (s.alive === true) {
      console.log(`  ${s.date} ${s.ver}:  sweep IN PROGRESS — ${progress(s)}, started ${s.startedAt} (pid ${s.pid})`);
    } else if (s.alive === null && s === newest) {
      console.log(`  ${s.date} ${s.ver}:  sweep IN PROGRESS or partial — ${progress(s)}, no live process recorded`);
    } else {
      killed.push(s);
    }
  }
  if (killed.length) {
    const k = killed[killed.length - 1];
    console.log(`  ⚑ ${killed.length} killed run(s) since ${lastObs ? lastObs.date : 'the first log'} — newest ${k.date} ${k.ver}: ${progress(k)}`);
  }

  // 3. the last COMPLETED sweep: self-test + alarm
  const lastSweep = findLastDataBearingDay(logsRoot);
  if (!lastSweep) {
    if (lastObs) console.log('  no completed sweep yet to report.');
    return;
  }
  if (newest.date !== lastSweep.date) console.log('  ── last completed ──');
  reportVersion(logsRoot, lastSweep.date, lastSweep.version);
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

/** Print the last-sweep / self-test / alarm lines for one day's version dir. */
function reportVersion(logsRoot, day, ver) {
  const verDir = path.join(logsRoot, day, ver);
  const meta = readJsonSafe(path.join(verDir, 'meta.json'));
  if (!meta) { console.log(`  ${day} ${ver}: meta.json unreadable.`); return; }
  const st = meta.selftest || {};
  const stStr = st.ok === true ? 'PASS'
    : st.ok === null ? `SKIPPED (${st.note})`
    : `⚑ DIVERGENCE (${(st.mismatches || []).length})`;
  const dirtNote = meta.engine_dirty ? ', ENGINE-dirty' : meta.dirty ? ', dirty (cosmetic)' : '';
  const nScenarios = (meta.scenarios || []).length;
  const nResumed = meta.resumed ? Object.keys(meta.resumed).length : 0;
  console.log(`  last sweep: ${day} ${ver} (sha ${meta.sha}${dirtNote}) — ${nScenarios} scenarios × ${meta.n_seeds} seeds${nResumed ? `, ${nResumed} resumed from a killed run` : ''}`);
  console.log(`  self-test:  ${stStr}`);

  let diffFile = null;
  try { diffFile = fs.readdirSync(verDir).find((f) => f.startsWith('diff-vs-') && f.endsWith('.json')); } catch { /* none */ }
  if (diffFile) printAlarmFromDiff(path.join(verDir, diffFile));
  else console.log(`  alarm:     none yet (first day for this logs dir; arms on the next version).`);
}

/** Does the armed task still match task-spec.mjs? (The July settings never reached it.) */
function reportTask() {
  const task = readTask();
  const drift = taskDrift(task, path.join(CANARY_ROOT, 'run-nightly.cmd'));
  if (!drift.length) console.log(`  task:       armed headless, catch-up on, battery-tolerant (${task.state})`);
  else console.log(`  ⚑ task:     ${drift.join('; ')} — re-arm: node src/schedule.mjs --install`);
}

main();
