// src/repo-meta.mjs — read the target repo's git identity for the day's stamp.
//
// The no-change short-circuit (Phase 3) trusts the commit SHA: if today's SHA
// matches the last data-bearing day's, the deterministic engine produces
// identical output and the 3-4h sweep can be skipped. But a SHA stamp LIES if
// the working tree is dirty — uncommitted edits are invisible to it. So we also
// capture dirt, and the caller treats a disturbed layer as ALWAYS-CHANGED.
//
// TWO dirt readings, because they answer two different questions:
//   • `dirty` / `dirtyFiles`  — the WHOLE tree, for the honest sample LABEL in
//     meta.json. A reader should always see exactly what state was cored.
//   • `engineDirty` / `engineDirtyFiles` — only the paths that can move the
//     numeric fingerprint, the SHORT-CIRCUIT gate. The fingerprint is a pure
//     function of the engine source (js/ → dist/), the runtime data it reads
//     (data/), and the harness that drives the sweep (tools/_harness.mjs).
//     A stray untracked tool, a doc edit, or another session's WIP cannot shift
//     a single spawn-% — so it must NOT force a needless nightly re-sweep.
// The scope is an ALLOWLIST kept deliberately small and fail-safe: if a real
// determinant ever moves outside it, widen ENGINE_PATHSPEC. Whole-tree dirt is
// still always recorded, so a mis-scope is auditable after the fact.

import { execFileSync } from 'node:child_process';

// The committed inputs the swept fingerprint depends on. dist/ is gitignored
// (rebuilt from js/), so js/ is the source of truth for the engine; data/ holds
// every runtime-read file (scenarios, minerals, thermo); _harness.mjs is the
// sweep entrypoint (jsdom + dist eval + fetch mock + defaultSteps).
export const ENGINE_PATHSPEC = ['js', 'data', 'tools/_harness.mjs'];

const toLines = (porcelain) =>
  porcelain ? porcelain.split('\n').map((l) => l.trim()).filter(Boolean) : [];

export function repoMeta(repoPath) {
  const git = (args) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();

  let sha = 'UNKNOWN';
  let branch = 'UNKNOWN';

  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirtyFiles = toLines(git(['status', '--porcelain']));
    const engineDirtyFiles = toLines(git(['status', '--porcelain', '--', ...ENGINE_PATHSPEC]));
    return {
      sha, branch,
      dirty: dirtyFiles.length > 0, dirtyFiles,
      engineDirty: engineDirtyFiles.length > 0, engineDirtyFiles,
    };
  } catch (e) {
    // Not a git repo, or git unavailable: leave both dirty=true so the caller
    // re-sweeps rather than trusting a SHA we couldn't verify.
    return {
      sha, branch,
      dirty: true, dirtyFiles: [],
      engineDirty: true, engineDirtyFiles: [],
      gitError: String(e.message || e),
    };
  }
}
