// test/target.test.mjs — the canary's own checkout (src/target.mjs).
//
// followTarget must move the checkout to the newest main and never discard
// anything: a tracked edit means someone else worked there, so it stays put and
// says why; a failed fetch keeps the old commit. prepareTarget must run npm ci
// only when the lockfile changed and always compile from a clean dist/.
// Real git under the OS temp dir (a bare "origin", a clone that pushes main,
// the canary's clone); the npm/tsc runner is faked.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { followTarget, describeFollow, prepareTarget, INSTALL_STAMP } from '../src/target.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(os.tmpdir(), 'vugg-canary-test-target');
const ORIGIN = path.join(ROOT, 'origin.git');   // stands in for Syntaxswine
const WORK = path.join(ROOT, 'work');           // where main gets its new commits
const TARGET = path.join(ROOT, 'target');       // the canary's checkout
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
function commitToMain(msg, file = 'js/engine.ts') {
  fs.mkdirSync(path.dirname(path.join(WORK, file)), { recursive: true });
  fs.writeFileSync(path.join(WORK, file), `${msg}\n`);
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', msg);
  git(WORK, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/main');
  return head(WORK);
}

execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', ORIGIN], { stdio: 'pipe' });
execFileSync('git', ['clone', '-q', ORIGIN, WORK], { stdio: 'pipe' });
const c1 = commitToMain('one');
execFileSync('git', ['clone', '-q', ORIGIN, TARGET], { stdio: 'pipe' });
git(TARGET, 'checkout', '-q', '--detach', c1);
const SPEC = { remote: 'origin', branch: 'main' };

test('main moved ⇒ the checkout moves to the new tip, as a fast-forward', () => {
  const c2 = commitToMain('two');
  const r = followTarget(TARGET, SPEC);
  assert.equal(r.error, undefined);
  assert.equal(r.fetch_error, undefined);
  assert.equal(r.moved, true);
  assert.equal(r.fast_forward, true);
  assert.equal(r.from, c1);
  assert.equal(r.to, c2);
  assert.equal(head(TARGET), c2);
  assert.equal(describeFollow(r), `moved ${c1.slice(0, 8)} → ${c2.slice(0, 8)} (origin/main)`);
});

test('main unchanged ⇒ the checkout stays, and says so', () => {
  const before = head(TARGET);
  const r = followTarget(TARGET, SPEC);
  assert.equal(r.moved, false);
  assert.equal(r.to, before);
  assert.equal(r.error, undefined);
  assert.equal(describeFollow(r), `origin/main unchanged at ${before.slice(0, 8)}`);
});

test('a tracked edit in the checkout is never discarded: not moved, and the record says why', () => {
  const before = head(TARGET);
  commitToMain('three');
  const f = path.join(TARGET, 'js', 'engine.ts');
  fs.appendFileSync(f, 'someone else was here\n');
  const r = followTarget(TARGET, SPEC);
  assert.equal(r.moved, false);
  assert.match(r.error, /local edits in the canary's checkout, not moved to [0-9a-f]{8}: M js\/engine\.ts/);
  assert.equal(head(TARGET), before);
  assert.match(fs.readFileSync(f, 'utf8'), /someone else was here/);
  git(TARGET, 'checkout', '--', 'js/engine.ts');   // the owner tidies up
});

test('an untracked file does not block the move, and survives it', () => {
  fs.writeFileSync(path.join(TARGET, 'notes.txt'), 'scratch\n');
  const r = followTarget(TARGET, SPEC);
  assert.equal(r.moved, true);
  assert.equal(head(TARGET), head(WORK));
  assert.ok(fs.existsSync(path.join(TARGET, 'notes.txt')));
});

test('main rewritten (force-push) ⇒ still moves, flagged as not a fast-forward', () => {
  git(WORK, 'reset', '-q', '--hard', 'HEAD~1');
  const rewritten = commitToMain('three, rewritten');
  const r = followTarget(TARGET, SPEC);
  assert.equal(r.moved, true);
  assert.equal(r.fast_forward, false);
  assert.equal(head(TARGET), rewritten);
  assert.match(describeFollow(r), /NOT a fast-forward: history was rewritten/);
});

test('a failed fetch keeps the checkout where it is and records why', () => {
  const before = head(TARGET);
  commitToMain('four');
  git(TARGET, 'remote', 'set-url', 'origin', path.join(ROOT, 'no-such-remote.git'));
  try {
    const r = followTarget(TARGET, SPEC);
    assert.equal(r.moved, false);
    assert.ok(r.fetch_error, 'fetch_error must be set');
    assert.equal(r.to, before);
    assert.equal(head(TARGET), before);
    assert.match(describeFollow(r), new RegExp(`^fetch from origin failed \\(.+\\); swept the checkout as it was, ${before.slice(0, 8)}$`));
  } finally {
    git(TARGET, 'remote', 'set-url', 'origin', ORIGIN);
  }
});

test('not a git checkout ⇒ an error in the record, no throw', () => {
  const r = followTarget(path.join(ROOT, 'nowhere'), SPEC);
  assert.equal(r.moved, false);
  assert.match(r.error, /^not a git checkout/);
});

// --- prepareTarget: npm ci only when the lockfile changed; always a clean compile ---
const PREP = path.join(ROOT, 'prep');
const TSC = path.join(PREP, 'node_modules', 'typescript', 'bin', 'tsc');
const STAMP = path.join(PREP, INSTALL_STAMP);
fs.mkdirSync(path.dirname(TSC), { recursive: true });
fs.writeFileSync(TSC, '// stand-in\n');
fs.writeFileSync(path.join(PREP, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
const lockSha = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(PREP, 'package-lock.json'))).digest('hex');

function fakeRunner(fail = {}) {
  const calls = [];
  const run = (cmd) => {
    const what = /^npm ci\b/.test(cmd) ? 'install' : 'build';
    calls.push({ what, distBefore: fs.existsSync(path.join(PREP, 'dist')) });
    if (fail[what]) return { ok: false, error: `exit 2\n${what} broke` };
    if (what === 'build') {
      fs.mkdirSync(path.join(PREP, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(PREP, 'dist', 'engine.js'), '');
    }
    return { ok: true };
  };
  return { run, calls, whats: () => calls.map((c) => c.what).join(',') };
}

test('no install stamp ⇒ npm ci, then a compile; the stamp records the lockfile', () => {
  const f = fakeRunner();
  const r = prepareTarget(PREP, { install: true }, { run: f.run });
  assert.equal(r.ok, true);
  assert.equal(f.whats(), 'install,build');
  assert.equal(r.installed, true);
  assert.equal(r.built, true);
  assert.equal(JSON.parse(fs.readFileSync(STAMP, 'utf8')).lock_sha256, lockSha());
});

test('the stamp matches the lockfile ⇒ no npm ci, still a compile', () => {
  const f = fakeRunner();
  const r = prepareTarget(PREP, { install: true }, { run: f.run });
  assert.equal(r.ok, true);
  assert.equal(f.whats(), 'build');
  assert.equal(r.installed, false);
});

test('the lockfile changed ⇒ npm ci again', () => {
  fs.writeFileSync(path.join(PREP, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const f = fakeRunner();
  prepareTarget(PREP, { install: true }, { run: f.run });
  assert.equal(f.whats(), 'install,build');
  assert.equal(JSON.parse(fs.readFileSync(STAMP, 'utf8')).lock_sha256, lockSha());
});

test('npm ci fails ⇒ stage install, no compile, stamp untouched so the next night retries', () => {
  const old = fs.readFileSync(STAMP, 'utf8');
  fs.writeFileSync(path.join(PREP, 'package-lock.json'), '{ "lockfileVersion": 3, "changed": true }\n');
  const f = fakeRunner({ install: true });
  const r = prepareTarget(PREP, { install: true }, { run: f.run });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'install');
  assert.match(r.error, /^npm ci --ignore-scripts --no-audit --no-fund: exit 2\ninstall broke$/);
  assert.equal(f.whats(), 'install');
  assert.equal(fs.readFileSync(STAMP, 'utf8'), old);
});

test('the compile fails ⇒ stage build, with the tail of its output', () => {
  const f = fakeRunner({ build: true });
  const r = prepareTarget(PREP, { install: false }, { run: f.run });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'build');
  assert.match(r.error, /^tsc -p tsconfig\.json: exit 2\nbuild broke$/);
});

test('dist/ is removed before every compile, exactly like build-all', () => {
  fs.mkdirSync(path.join(PREP, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(PREP, 'dist', 'stale.js'), '// from an older commit\n');
  const f = fakeRunner();
  prepareTarget(PREP, { install: false }, { run: f.run });
  assert.equal(f.calls.at(-1).distBefore, false);
  assert.ok(!fs.existsSync(path.join(PREP, 'dist', 'stale.js')));
});

test('install:false (--build on any checkout) never runs npm ci', () => {
  fs.rmSync(STAMP, { force: true });
  const f = fakeRunner();
  const r = prepareTarget(PREP, { install: false }, { run: f.run });
  assert.equal(r.ok, true);
  assert.equal(f.whats(), 'build');
  assert.ok(!fs.existsSync(STAMP));
});

test('tsc missing ⇒ stage build with a clear error, nothing run', () => {
  fs.renameSync(TSC, `${TSC}.away`);
  try {
    const f = fakeRunner();
    const r = prepareTarget(PREP, { install: false }, { run: f.run });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'build');
    assert.match(r.error, /typescript\/bin\/tsc is missing/);
    assert.equal(f.calls.length, 0);
  } finally {
    fs.renameSync(`${TSC}.away`, TSC);
  }
});

test('no package-lock.json ⇒ stage install, nothing run', () => {
  fs.rmSync(path.join(PREP, 'package-lock.json'));
  const f = fakeRunner();
  const r = prepareTarget(PREP, { install: true }, { run: f.run });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'install');
  assert.equal(f.calls.length, 0);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
