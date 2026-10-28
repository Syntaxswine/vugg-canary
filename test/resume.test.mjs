// test/resume.test.mjs — a killed sweep resumes, and ONLY under the exact runtime.
//
// The asymmetry this suite guards: a false "can't resume" costs one recompute;
// a false "resume" silently splices another runtime's numbers into a stratum.
// So every negative case below must refuse, and the positive cases must take
// exactly the scenarios a matching killed run finished.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashTree, runtimeIdentity, prepareOutDir, planReuse, adoptScenario, writeScenarioIdentity,
  SWEEP_IDENTITY, SCENARIO_IDENTITY,
} from '../src/resume.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-resume');
const SHA = 'a'.repeat(40);
const fresh = () => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); };

function makeDist(files = { 'a.js': 'const A = 1;', 'sub/b.js': 'const B = 2;' }) {
  const dist = path.join(ROOT, 'dist');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), body);
  }
  return dist;
}

const idArgs = (distDir, extra = {}) => ({
  fullSha: SHA, engineDirty: false, distDir, simVersion: 285, canaryVersion: '0.1.0',
  nSeeds: 200, stepsMode: 'defaultSteps??100', shape: 'scenario-authored', node: 'v24.15.0', ...extra,
});

// a finished scenario as a sweep leaves it: frequency + seeds + (optionally) the sidecar
function finishScenario(vdir, name, key, { sidecar = true, seeds = true } = {}) {
  const s = path.join(vdir, name);
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, 'frequency.json'), JSON.stringify({ n_seeds: 200, species: {} }));
  if (seeds) fs.writeFileSync(path.join(s, 'seeds.json'), '{}');
  if (sidecar) fs.writeFileSync(path.join(s, SCENARIO_IDENTITY), JSON.stringify({ key }));
}

test('identity: same inputs ⇒ same key; dist bytes, Node, seeds, commit each change it', () => {
  fresh();
  const dist = makeDist();
  const a = runtimeIdentity(idArgs(dist));
  assert.match(a.key, /^[0-9a-f]{64}$/);
  assert.equal(runtimeIdentity(idArgs(dist)).key, a.key);
  assert.notEqual(runtimeIdentity(idArgs(dist, { node: 'v22.0.0' })).key, a.key);
  assert.notEqual(runtimeIdentity(idArgs(dist, { nSeeds: 50 })).key, a.key);
  assert.notEqual(runtimeIdentity(idArgs(dist, { fullSha: 'b'.repeat(40) })).key, a.key);
  fs.writeFileSync(path.join(dist, 'sub', 'b.js'), 'const B = 3;');
  assert.notEqual(runtimeIdentity(idArgs(dist)).key, a.key, 'a one-byte dist change must change the key');
});

test('identity: a renamed dist file changes the key (path is hashed, not just bytes)', () => {
  fresh();
  const k1 = hashTree(makeDist({ 'a.js': 'x' })).sha256;
  fresh();
  const k2 = hashTree(makeDist({ 'b.js': 'x' })).sha256;
  assert.notEqual(k1, k2);
});

test('identity: engine-dirty, unknown commit, or empty dist ⇒ no key (never resumes)', () => {
  fresh();
  const dist = makeDist();
  assert.equal(runtimeIdentity(idArgs(dist, { engineDirty: true })).key, null);
  assert.equal(runtimeIdentity(idArgs(dist, { fullSha: 'abc1234' })).key, null);
  assert.equal(runtimeIdentity(idArgs(dist, { fullSha: null })).key, null);
  const empty = path.join(ROOT, 'empty-dist');
  fs.mkdirSync(empty);
  assert.equal(runtimeIdentity(idArgs(empty)).key, null);
  assert.equal(runtimeIdentity(idArgs(path.join(ROOT, 'missing'))).key, null);
});

test('prepareOutDir: same key keeps the files and logs a second attempt', () => {
  fresh();
  const id = runtimeIdentity(idArgs(makeDist()));
  const out = path.join(ROOT, 'logs', '2026-10-28', 'v285');
  assert.equal(prepareOutDir(out, id, { planned: 41 }).attempt, 1);
  finishScenario(out, 'bisbee', id.key);
  const r = prepareOutDir(out, id, { planned: 41 });
  assert.equal(r.superseded, null);
  assert.equal(r.attempt, 2);
  assert.ok(fs.existsSync(path.join(out, 'bisbee', 'frequency.json')), 'finished scenario kept');
  const sid = JSON.parse(fs.readFileSync(path.join(out, SWEEP_IDENTITY), 'utf8'));
  assert.equal(sid.attempts.length, 2);
  assert.equal(sid.attempts[1].planned, 41);
});

test('prepareOutDir: a different key moves the old run aside (kept), starts clean', () => {
  fresh();
  const dist = makeDist();
  const id1 = runtimeIdentity(idArgs(dist));
  const id2 = runtimeIdentity(idArgs(dist, { nSeeds: 50 }));
  const out = path.join(ROOT, 'logs', '2026-10-28', 'v285');
  prepareOutDir(out, id1);
  finishScenario(out, 'bisbee', id1.key);
  const r = prepareOutDir(out, id2);
  assert.ok(r.superseded && /v285\.superseded-\d{8}T\d{6}Z(-\d+)?$/.test(r.superseded), r.superseded);
  assert.ok(fs.existsSync(path.join(r.superseded, 'bisbee', 'frequency.json')), 'old run preserved');
  assert.ok(!fs.existsSync(path.join(out, 'bisbee')), 'new run starts clean');
});

test('prepareOutDir: files with no sweep-identity (pre-resume run) or a keyless run ⇒ moved aside', () => {
  fresh();
  const id = runtimeIdentity(idArgs(makeDist()));
  const out = path.join(ROOT, 'logs', '2026-10-28', 'v285');
  finishScenario(out, 'bisbee', id.key, { sidecar: false });   // an old-code partial
  assert.ok(prepareOutDir(out, id).superseded);
  finishScenario(out, 'bisbee', id.key);
  const second = prepareOutDir(out, { key: null, fields: {} }).superseded;
  assert.ok(second, 'a dirty run never writes over a keyed one');
  assert.ok(fs.existsSync(path.join(second, 'bisbee')), 'a second supersede in the same second gets its own name');
});

test('planReuse: in place first, then the newest matching PARTIAL day; finished days never mined', () => {
  fresh();
  const id = runtimeIdentity(idArgs(makeDist()));
  const logs = path.join(ROOT, 'logs');
  const out = path.join(logs, '2026-10-28', 'v285');
  prepareOutDir(out, id);
  finishScenario(out, 'amethyst_geode', id.key);                         // in place
  const older = path.join(logs, '2026-10-25', 'v285');
  const newer = path.join(logs, '2026-10-26', 'v285');
  finishScenario(older, 'bisbee', id.key);
  finishScenario(newer, 'bisbee', id.key);                               // newest partial wins
  finishScenario(older, 'cooling', id.key);                              // only the older has it
  const done = path.join(logs, '2026-10-27', 'v285');                    // a FINISHED day
  finishScenario(done, 'mvt', id.key);
  fs.writeFileSync(path.join(done, 'meta.json'), '{}');
  const plan = planReuse(logs, out, ['amethyst_geode', 'bisbee', 'cooling', 'mvt', 'naica'], id);
  assert.equal(plan.get('amethyst_geode'), '');
  assert.equal(plan.get('bisbee'), newer);
  assert.equal(plan.get('cooling'), older);
  assert.equal(plan.has('mvt'), false, 'a finished day is never mined');
  assert.equal(plan.has('naica'), false);
});

test('planReuse: wrong key, no sidecar, missing seeds.json, or a keyless run ⇒ recompute', () => {
  fresh();
  const dist = makeDist();
  const id = runtimeIdentity(idArgs(dist));
  const other = runtimeIdentity(idArgs(dist, { node: 'v22.0.0' }));
  const logs = path.join(ROOT, 'logs');
  const out = path.join(logs, '2026-10-28', 'v285');
  prepareOutDir(out, id);
  const partial = path.join(logs, '2026-10-26', 'v285');
  finishScenario(partial, 'bisbee', other.key);                          // another runtime
  finishScenario(partial, 'cooling', id.key, { sidecar: false });        // killed before the stamp
  finishScenario(partial, 'mvt', id.key, { seeds: false });              // half-written
  const plan = planReuse(logs, out, ['bisbee', 'cooling', 'mvt'], id);
  assert.equal(plan.size, 0, [...plan.keys()].join(','));
  finishScenario(partial, 'naica', id.key);
  assert.equal(planReuse(logs, out, ['naica'], { key: null, fields: {} }).size, 0);
});

test('adoptScenario copies the three files and leaves the source untouched', () => {
  fresh();
  const id = runtimeIdentity(idArgs(makeDist()));
  const src = path.join(ROOT, 'logs', '2026-10-26', 'v285');
  const out = path.join(ROOT, 'logs', '2026-10-28', 'v285');
  finishScenario(src, 'bisbee', id.key);
  adoptScenario(src, out, 'bisbee');
  for (const f of ['frequency.json', 'seeds.json', SCENARIO_IDENTITY]) {
    assert.equal(fs.readFileSync(path.join(out, 'bisbee', f), 'utf8'), fs.readFileSync(path.join(src, 'bisbee', f), 'utf8'));
  }
  assert.ok(fs.existsSync(path.join(src, 'bisbee', 'frequency.json')), 'source still there');
});

test('writeScenarioIdentity: a keyless run stamps nothing', () => {
  fresh();
  const s = path.join(ROOT, 'x');
  fs.mkdirSync(s);
  writeScenarioIdentity(s, { key: null });
  assert.ok(!fs.existsSync(path.join(s, SCENARIO_IDENTITY)));
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
