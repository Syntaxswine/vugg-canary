// src/target.mjs — the canary's own vugg checkout: follow main, keep it runnable.
//
// Until 2026-10-28 the canary swept the vugg checkout people work in. That one
// sat on render/r6-specimen at 409820bb (2026-09-06) while main moved 94
// commits on, so the canary kept re-coring September and would have written
// NO-CHANGE every night from then on. The boss's fix: the canary gets its own
// checkout (a detached worktree of the vugg repo), moves it to the newest main
// before each full run, and builds it before sweeping, so it cores every new main.
//
//   followTarget   fetch <remote> <branch>, then check the fetched tip out
//                  (detached). It never discards anything: a tracked edit in
//                  the checkout means someone else worked in it, so the checkout
//                  stays where it is and the record says why. A failed fetch
//                  keeps the old commit; the sweep then cores it as it is.
//   prepareTarget  make the checkout runnable: `npm ci` when package-lock.json
//                  changed since the canary last installed, then exactly the
//                  compile step of vugg's tools/build-all-lib.mjs (clean dist/,
//                  tsc -p tsconfig.json). Not all of `npm run build`: that also
//                  regenerates the narrative manifest and re-splices index.html,
//                  both tracked files, and the harness reads only dist/. So the
//                  canary never edits its own checkout, and any edit there is
//                  someone else's.
//
// Both return records instead of throwing (passive instrument): the sweep stamps
// them into meta.json / NO-CHANGE.json, and a failed prepare becomes a
// TARGET-FAILED.json marker for the day, which status.mjs flags.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const TARGET_FAILED = 'TARGET-FAILED.json';
export const INSTALL_STAMP = path.join('node_modules', '.canary-install.json');
const NPM_CI = 'npm ci --ignore-scripts --no-audit --no-fund';

const short = (sha) => (sha ? sha.slice(0, 8) : '?');
const firstLine = (e) =>
  String((e && (e.stderr?.toString() || e.message)) || e).trim().split(/\r?\n/)[0];
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

/**
 * Move the checkout to the newest <remote>/<branch>. Returns
 * { remote, branch, from, to, moved, fast_forward?, fetch_error?, error?, at }.
 */
export function followTarget(vuggPath, { remote = 'origin', branch = 'main' } = {}) {
  const git = (args) => execFileSync('git', ['-C', vuggPath, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const rec = { remote, branch, from: null, to: null, moved: false, at: new Date().toISOString() };

  try { rec.from = rec.to = git(['rev-parse', 'HEAD']); }
  catch (e) { rec.error = `not a git checkout: ${firstLine(e)}`; return rec; }

  let tip;
  try {
    git(['fetch', '--quiet', remote, branch]);
    tip = git(['rev-parse', 'FETCH_HEAD']);   // per-worktree, so other checkouts' refs stay as they are
  } catch (e) { rec.fetch_error = firstLine(e); return rec; }
  if (tip === rec.from) return rec;

  const edits = git(['status', '--porcelain', '--untracked-files=no'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (edits.length) {
    rec.error = `local edits in the canary's checkout, not moved to ${short(tip)}: `
      + `${edits.slice(0, 3).join(', ')}${edits.length > 3 ? ` (+${edits.length - 3} more)` : ''}`;
    return rec;
  }

  try { git(['merge-base', '--is-ancestor', rec.from, tip]); rec.fast_forward = true; }
  catch { rec.fast_forward = false; }
  try { git(['checkout', '--quiet', '--detach', tip]); }
  catch (e) { rec.error = `checkout of ${short(tip)} failed: ${firstLine(e)}`; return rec; }
  rec.to = tip;
  rec.moved = true;
  return rec;
}

/** One line for the nightly log and the status glance (no ⚑: callers add it). */
export function describeFollow(rec) {
  const src = `${rec.remote}/${rec.branch}`;
  if (rec.error) return rec.error;
  if (rec.fetch_error) return `fetch from ${rec.remote} failed (${rec.fetch_error}); swept the checkout as it was, ${short(rec.to)}`;
  if (!rec.moved) return `${src} unchanged at ${short(rec.to)}`;
  return `moved ${short(rec.from)} → ${short(rec.to)} (${src}${rec.fast_forward ? '' : ', NOT a fast-forward: history was rewritten'})`;
}

/** Spawn quietly, echo the output into the nightly log, keep the tail for a failure marker. */
function runCmd(cmd, args, { cwd, shell = false }) {
  const r = spawnSync(cmd, args, { cwd, shell, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-8);
    // cmd.exe hands back a negative code as unsigned 32-bit (ENOENT -4058 reads 4294963238)
    const code = r.status > 0x7fffffff ? r.status - 0x100000000 : r.status;
    return { ok: false, error: [`exit ${code}`, ...tail].join('\n') };
  }
  return { ok: true };
}

/**
 * Make the checkout runnable. install=true (the nightly's own checkout) runs
 * `npm ci` when package-lock.json differs from the last install's stamp;
 * install=false (`--build` on any checkout) never touches node_modules.
 * Returns { ok, installed, built, install_s?, build_s?, stage?, error? }.
 */
export function prepareTarget(vuggPath, { install = true } = {}, { run = runCmd } = {}) {
  const rec = { ok: true, installed: false, built: false };
  if (install) {
    let lockSha;
    try { lockSha = sha256(fs.readFileSync(path.join(vuggPath, 'package-lock.json'))); }
    catch { return { ...rec, ok: false, stage: 'install', error: 'no package-lock.json in the target' }; }
    const stampPath = path.join(vuggPath, INSTALL_STAMP);
    if (readJsonSafe(stampPath)?.lock_sha256 !== lockSha) {
      const t0 = Date.now();
      const r = run(NPM_CI, [], { cwd: vuggPath, shell: true });
      rec.install_s = Math.round((Date.now() - t0) / 1000);
      if (!r.ok) return { ...rec, ok: false, stage: 'install', error: `${NPM_CI}: ${r.error}` };
      fs.writeFileSync(stampPath, JSON.stringify({ lock_sha256: lockSha, node: process.version, at: new Date().toISOString() }, null, 2) + '\n');
      rec.installed = true;
    }
  }
  // build-all's compile step and nothing else: clean dist/, then tsc.
  const tsc = path.join(vuggPath, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) return { ...rec, ok: false, stage: 'build', error: 'node_modules/typescript/bin/tsc is missing: dependencies not installed' };
  fs.rmSync(path.join(vuggPath, 'dist'), { recursive: true, force: true });
  const t1 = Date.now();
  const r = run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: vuggPath });
  rec.build_s = Math.round((Date.now() - t1) / 1000);
  if (!r.ok) return { ...rec, ok: false, stage: 'build', error: `tsc -p tsconfig.json: ${r.error}` };
  rec.built = true;
  return rec;
}

/** The day's marker when the target could not be made runnable: nothing was swept. */
export function writeTargetFailed(logsRoot, date, { stage, error, sha, follow }) {
  const note = {
    date, stage, sha, error,
    follow: follow || undefined,
    note: `the target could not be ${stage === 'install' ? 'installed' : 'built'} at ${sha}; nothing was swept`,
  };
  const dayDir = path.join(logsRoot, date);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, TARGET_FAILED), JSON.stringify(note, null, 2) + '\n');
  return note;
}
