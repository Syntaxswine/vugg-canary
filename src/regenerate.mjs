#!/usr/bin/env node
/**
 * src/regenerate.mjs — Phase 4: rebuild any single run on demand.
 *
 * Determinism makes a discarded heavy-tier run a CACHE, not lost data:
 * (SHA, scenario, chem seed, scenario-authored shape) reconstructs it exactly.
 * This is what lets the canary throw away the full 200-seed raw runs and keep
 * only the spine — anything heavier is one command away.
 *
 *   node src/regenerate.mjs <date> <scenario> <seed> [--out DIR]
 *
 * It reads the logged day's meta.json for the SHA it was swept at. If the
 * target's CURRENT sha matches (and is clean), it re-runs, prints the digest,
 * and — if that day's seeds.json is still present — asserts the regenerated
 * digest matches the stored one (a determinism check). If the current sha
 * differs, it regenerates against today's code and says so loudly: faithfully
 * reproducing a HISTORICAL version needs that SHA checked out first (the
 * version-management piece deferred with the two-folder promote).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoMeta } from './repo-meta.mjs';
import { makeRunner } from './run.mjs';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function findVersionDir(dayDir) {
  const vs = fs.readdirSync(dayDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
    .map((d) => d.name).sort().reverse();
  return vs[0] || null;
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const [date, scenario, seedStr] = positional;
  const outIdx = process.argv.indexOf('--out');
  if (!date || !scenario || !seedStr) {
    console.log('usage: node src/regenerate.mjs <date> <scenario> <seed> [--out DIR]');
    process.exit(2);
  }
  const seed = parseInt(seedStr, 10);
  const cfg = JSON.parse(fs.readFileSync(path.join(CANARY_ROOT, 'canary.config.json'), 'utf8'));
  const vuggPath = path.resolve(CANARY_ROOT, cfg.vuggPath);
  const outRoot = path.resolve(CANARY_ROOT, outIdx >= 0 ? process.argv[outIdx + 1] : (cfg.logsDir || 'logs'));

  const dayDir = path.join(outRoot, date);
  if (!fs.existsSync(dayDir)) { console.error(`[regen] no logs for ${date} under ${outRoot}`); process.exit(1); }
  const ver = findVersionDir(dayDir);
  if (!ver) { console.error(`[regen] no v<N> sweep under ${dayDir} (a NO-CHANGE day? regenerate from the day it points at)`); process.exit(1); }
  const meta = JSON.parse(fs.readFileSync(path.join(dayDir, ver, 'meta.json'), 'utf8'));

  const cur = repoMeta(vuggPath);
  console.log(`[regen] ${date} / ${scenario} / seed ${seed} — logged at sha ${meta.sha} (${ver}); target now at ${cur.sha}${cur.dirty ? ' (dirty)' : ''}`);
  const sameSha = cur.sha === meta.sha;
  if (!sameSha) {
    console.warn(`[regen] ⚠️  target sha (${cur.sha}) ≠ logged sha (${meta.sha}) — regenerating against TODAY's engine.`);
    console.warn(`        Faithful historical regen needs \`git -C <vugg> checkout ${meta.sha}\` first (deferred`);
    console.warn(`        with the two-folder promote). The digest below reflects current code, not ${meta.sha}.`);
  } else if (cur.dirty) {
    console.warn(`[regen] note: sha matches but the tree is dirty (${cur.dirtyFiles.length} item(s)). If none touch`);
    console.warn(`        js/ or data/ the run still reproduces — the compare below is the real test.`);
  }

  const harnessUrl = pathToFileURL(path.join(vuggPath, 'tools', '_harness.mjs')).href;
  const { loadSimBundle } = await import(harnessUrl);
  const bundle = await loadSimBundle({ toolName: 'vugg-canary-regen' });
  if (!(scenario in bundle.SCENARIOS)) { console.error(`[regen] unknown scenario "${scenario}"`); process.exit(1); }

  const runOne = makeRunner(bundle);
  const digest = runOne(scenario, seed);
  console.log(`\n[regen] digest:\n${JSON.stringify(digest, null, 2)}`);

  // determinism check against the stored heavy tier, when it's the same code
  const seedsPath = path.join(dayDir, ver, scenario, 'seeds.json');
  if (sameCode && fs.existsSync(seedsPath)) {
    const stored = JSON.parse(fs.readFileSync(seedsPath, 'utf8'))[seed];
    if (stored) {
      const match = JSON.stringify(stored) === JSON.stringify(digest);
      console.log(`\n[regen] ${match ? '✅ reproduces' : '❌ DIFFERS from'} the stored seeds.json digest — determinism ${match ? 'holds' : 'BROKEN'}.`);
      if (!match) process.exitCode = 1;
    } else {
      console.log(`\n[regen] (seed ${seed} not in that day's stored heavy tier — nothing to compare, but the digest above is authoritative)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
