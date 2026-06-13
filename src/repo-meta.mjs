// src/repo-meta.mjs — read the target repo's git identity for the day's stamp.
//
// The no-change short-circuit (Phase 3) trusts the commit SHA: if today's SHA
// matches the last data-bearing day's, the deterministic engine produces
// identical output and the 3-4h sweep can be skipped. But a SHA stamp LIES if
// the working tree is dirty — uncommitted edits are invisible to it. So we also
// capture `dirty`, and the caller treats a dirty tree as ALWAYS-CHANGED (never
// short-circuits). One `git status --porcelain` closes that silent-skip hole.

import { execFileSync } from 'node:child_process';

export function repoMeta(repoPath) {
  const git = (args) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();

  let sha = 'UNKNOWN';
  let branch = 'UNKNOWN';
  let dirty = true;          // fail safe: if we can't read git, assume changed
  let dirtyFiles = [];

  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = git(['status', '--porcelain']);
    dirtyFiles = porcelain ? porcelain.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    dirty = dirtyFiles.length > 0;
  } catch (e) {
    // Not a git repo, or git unavailable: leave dirty=true so the caller
    // re-sweeps rather than trusting a SHA we couldn't verify.
    return { sha, branch, dirty: true, dirtyFiles: [], gitError: String(e.message || e) };
  }

  return { sha, branch, dirty, dirtyFiles };
}
