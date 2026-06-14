// test/repo-meta.test.mjs — asserts the two-flavor dirt reading.
//
// The short-circuit gate (engineDirty) must distinguish dirt that can move the
// fingerprint (js/, data/, tools/_harness.mjs) from cosmetic dirt (a stray tool,
// a doc, another session's WIP) that cannot. Whole-tree `dirty` must still see
// everything for the honest sample label. Builds a throwaway git repo under the
// OS temp dir; no deps beyond git itself.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoMeta, ENGINE_PATHSPEC } from '../src/repo-meta.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// --- build a throwaway git repo --------------------------------------------
const REPO = path.join(os.tmpdir(), 'vugg-canary-test-repometa');
fs.rmSync(REPO, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
const git = (...args) =>
  execFileSync('git', ['-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

git('init', '-q');
// a minimal mirror of the determinant layout + an irrelevant tool
fs.mkdirSync(path.join(REPO, 'js'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'data'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'tools'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'js', '15-version.ts'), 'export const SIM_VERSION = 195;\n');
fs.writeFileSync(path.join(REPO, 'data', 'scenarios.json5'), '{}\n');
fs.writeFileSync(path.join(REPO, 'tools', '_harness.mjs'), 'export const loadSimBundle = () => {};\n');
fs.writeFileSync(path.join(REPO, 'tools', 'some-other-tool.mjs'), '// committed tool\n');
git('add', '-A');
git('commit', '-q', '-m', 'baseline');

test('clean tree ⇒ neither dirty nor engineDirty', () => {
  const m = repoMeta(REPO);
  assert.equal(m.dirty, false);
  assert.equal(m.engineDirty, false);
  assert.equal(m.engineDirtyFiles.length, 0);
});

test('a stray untracked tool ⇒ dirty TRUE but engineDirty FALSE (the mottramite-WIP case)', () => {
  const stray = path.join(REPO, 'tools', 'strip-story-diff.mjs');
  fs.writeFileSync(stray, '// another session WIP\n');
  const m = repoMeta(REPO);
  assert.equal(m.dirty, true, 'whole-tree dirt must still SEE the stray file');
  assert.equal(m.engineDirty, false, 'a non-engine tool must NOT defeat the short-circuit');
  assert.ok(m.dirtyFiles.some((f) => f.includes('strip-story-diff.mjs')));
  assert.equal(m.engineDirtyFiles.length, 0);
  fs.rmSync(stray);
});

test('an uncommitted js/ edit ⇒ both dirty and engineDirty', () => {
  fs.appendFileSync(path.join(REPO, 'js', '15-version.ts'), '// tweak\n');
  const m = repoMeta(REPO);
  assert.equal(m.dirty, true);
  assert.equal(m.engineDirty, true, 'an engine-source edit MUST defeat the short-circuit');
  assert.ok(m.engineDirtyFiles.some((f) => f.includes('js/15-version.ts')));
  git('checkout', '--', 'js/15-version.ts');
});

test('an uncommitted data/ edit ⇒ engineDirty', () => {
  fs.writeFileSync(path.join(REPO, 'data', 'scenarios.json5'), '{ "x": 1 }\n');
  assert.equal(repoMeta(REPO).engineDirty, true);
  git('checkout', '--', 'data/scenarios.json5');
});

test('an uncommitted tools/_harness.mjs edit ⇒ engineDirty (the sweep entrypoint)', () => {
  fs.appendFileSync(path.join(REPO, 'tools', '_harness.mjs'), '// changed steps\n');
  assert.equal(repoMeta(REPO).engineDirty, true);
  git('checkout', '--', 'tools/_harness.mjs');
});

test('editing a different committed tool ⇒ dirty but NOT engineDirty', () => {
  fs.appendFileSync(path.join(REPO, 'tools', 'some-other-tool.mjs'), '// edit\n');
  const m = repoMeta(REPO);
  assert.equal(m.dirty, true);
  assert.equal(m.engineDirty, false);
  git('checkout', '--', 'tools/some-other-tool.mjs');
});

test('ENGINE_PATHSPEC is the documented small allowlist', () => {
  assert.deepEqual(ENGINE_PATHSPEC, ['js', 'data', 'tools/_harness.mjs']);
});

// cleanup
fs.rmSync(REPO, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
