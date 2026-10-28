// src/resume.mjs — pick up a killed sweep instead of starting it over.
//
// A sweep writes each scenario's frequency.json + seeds.json the moment that
// scenario finishes, and meta.json only at the very end. So a sweep killed
// mid-run leaves a v-dir of finished scenarios and no meta. From 2026-08-16 to
// 10-25 every nightly died that way (^C in a visible console) and every next
// night started from scenario one: in ten weeks not one sweep finished.
//
// Reuse is only sound when the reused scenario came out of the SAME pure
// function: the same target commit on a clean engine tree, the same built dist/
// bytes, the same canary version, seed count, step rule and shape mode, and the
// same Node (vugg's own docs record seed-42 counts flipping across Node majors).
// Those fields hash into one runtime-identity key. Every finished scenario gets
// a small local identity.json sidecar carrying the key, and a later run reuses
// a scenario only when the sidecar matches the key it computes for itself. An
// engine-dirty tree gets no key: uncommitted edits can't be vouched for.
//
// PASSIVE INSTRUMENT: the caller wraps every call here. A resume failure means
// recomputing a scenario, never a halted sweep.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SWEEP_IDENTITY = 'sweep-identity.json';
export const SCENARIO_IDENTITY = 'identity.json';

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
};

/**
 * sha256 over EVERY file under dir (relative path + bytes, sorted by path). The
 * harness only evals dist/**\/*.js, so this is a superset: a change it catches
 * that the harness ignores costs one needless recompute, never a false reuse.
 */
export function hashTree(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(dir);
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
  const sorted = files.map((p) => [rel(p), p]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [r, p] of sorted) {
    h.update(r); h.update('\0');
    h.update(fs.readFileSync(p)); h.update('\0');
  }
  return { sha256: h.digest('hex'), files: sorted.length };
}

/**
 * The runtime identity of a sweep: { key, fields, reason? }. key is null when
 * reuse can't be vouched for (engine-dirty tree, unknown commit, no dist/).
 */
export function runtimeIdentity({ fullSha, engineDirty, distDir, simVersion, canaryVersion, nSeeds, stepsMode, shape, node = process.version }) {
  const fields = {
    sha: fullSha, sim_version: simVersion, canary_version: canaryVersion,
    n_seeds: nSeeds, steps_mode: stepsMode, shape, node,
    dist_sha256: null, dist_files: 0,
  };
  if (engineDirty) return { key: null, fields, reason: 'engine paths dirty — uncommitted edits cannot be vouched for' };
  if (!/^[0-9a-f]{40}$/.test(fullSha || '')) return { key: null, fields, reason: 'target commit unknown' };
  try {
    const t = hashTree(distDir);
    if (!t.files) return { key: null, fields, reason: 'dist/ is empty' };
    fields.dist_sha256 = t.sha256;
    fields.dist_files = t.files;
  } catch (e) {
    return { key: null, fields, reason: `dist/ unreadable (${e.code || e.message})` };
  }
  const key = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  return { key, fields };
}

/**
 * Make outDir safe to (re)use for this identity, and log this attempt in its
 * sweep-identity.json. A non-empty outDir whose sweep-identity.json holds a
 * different key (or none, or this run has none) belongs to another run: move it
 * aside to <outDir>.superseded-<UTC stamp> (kept, never deleted; the name is not
 * a v<N> dir, so every reader skips it) and start clean.
 * @returns {{ superseded: string|null, attempt: number }}
 */
export function prepareOutDir(outDir, identity, { now = new Date(), pid = process.pid, planned = null } = {}) {
  let superseded = null;
  let prior = null;
  const idPath = path.join(outDir, SWEEP_IDENTITY);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    prior = readJson(idPath);
    if (!identity.key || !prior || prior.key !== identity.key) {
      // Second resolution plus a counter: two supersedes in one second must not
      // collide (Windows refuses to rename onto an existing folder).
      const base = `${outDir}.superseded-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
      superseded = base;
      for (let n = 2; fs.existsSync(superseded); n++) superseded = `${base}-${n}`;
      fs.renameSync(outDir, superseded);
      prior = null;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const attempts = [...(prior?.attempts || []), { started_at: now.toISOString(), pid, planned }];
  fs.writeFileSync(idPath, JSON.stringify({ key: identity.key, fields: identity.fields, attempts }, null, 2) + '\n');
  return { superseded, attempt: attempts.length };
}

/** Stamp a finished scenario with the identity that produced it (local sidecar). */
export function writeScenarioIdentity(scenarioDir, identity) {
  if (!identity.key) return;
  fs.writeFileSync(path.join(scenarioDir, SCENARIO_IDENTITY), JSON.stringify({ key: identity.key }) + '\n');
}

function reusable(scenarioDir, key) {
  return fs.existsSync(path.join(scenarioDir, 'frequency.json'))
    && fs.existsSync(path.join(scenarioDir, 'seeds.json'))
    && readJson(path.join(scenarioDir, SCENARIO_IDENTITY))?.key === key;
}

/**
 * Which scenarios a sweep can take from a killed run instead of recomputing:
 * in place first (an earlier attempt into this same outDir), then the newest
 * PARTIAL v-dir of another day (no meta.json — killed before the end) whose
 * sidecar matches. Finished days are never mined: an unchanged target already
 * short-circuits to NO-CHANGE before any sweep starts.
 * @returns {Map<string, string>} scenario → source v-dir ('' = in place)
 */
export function planReuse(outRoot, outDir, names, identity) {
  const plan = new Map();
  if (!identity.key) return plan;
  const vname = path.basename(outDir);
  const partials = [];
  if (fs.existsSync(outRoot)) {
    const dates = fs.readdirSync(outRoot).filter((d) => DATE_RE.test(d)).sort().reverse();
    for (const date of dates) {
      const v = path.join(outRoot, date, vname);
      if (path.resolve(v) === path.resolve(outDir)) continue;
      if (!fs.existsSync(v) || fs.existsSync(path.join(v, 'meta.json'))) continue;
      partials.push(v);
    }
  }
  for (const name of names) {
    if (reusable(path.join(outDir, name), identity.key)) { plan.set(name, ''); continue; }
    const src = partials.find((v) => reusable(path.join(v, name), identity.key));
    if (src) plan.set(name, src);
  }
  return plan;
}

/** Copy a reusable scenario from another day's partial v-dir into outDir. The source is left untouched. */
export function adoptScenario(srcVdir, outDir, name) {
  const from = path.join(srcVdir, name);
  const to = path.join(outDir, name);
  fs.mkdirSync(to, { recursive: true });
  for (const f of ['frequency.json', 'seeds.json', SCENARIO_IDENTITY]) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
}
