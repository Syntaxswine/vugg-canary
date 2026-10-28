// src/task-spec.mjs — what the armed nightly task SHOULD look like, in one place.
//
// schedule.mjs arms the task from this spec; status.mjs reads the live task back
// and reports drift against it. Both exist because the armed task drifted for
// months unseen: the 2026-07-14 hardening (catch-up + battery tolerance) landed
// in schedule.mjs but the task was never re-armed, and its console window was
// VISIBLE, so a ^C or a closed window killed 67 straight nightly sweeps
// (2026-08-16 → 10-25) before any finished. The task now launches through
// `conhost.exe --headless`: no window exists to close or to type Ctrl+C into.

import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TASK = 'vugg-canary-nightly';
export const TIME = '04:00';
export const CONHOST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');

/** conhost arguments that run the wrapper with no window at all. */
export function headlessArguments(wrapper) {
  return `--headless cmd.exe /d /c "${wrapper}"`;
}

/** PowerShell that sets the headless action and the hardened settings on an existing task. */
export function armPowerShell(wrapper) {
  return `$a = New-ScheduledTaskAction -Execute '${CONHOST}' -Argument '${headlessArguments(wrapper)}'; `
    + `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; `
    + `Set-ScheduledTask -TaskName '${TASK}' -Action $a -Settings $s | Out-Null`;
}

/**
 * Read the live task. Returns { armed: false } when it doesn't exist, { error }
 * when it can't be queried, else its action and the settings we care about.
 * Never throws.
 */
export function readTask({ timeoutMs = 20000 } = {}) {
  const ps = `$t = Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; `
    + `if (-not $t) { '{"armed":false}' } else { $a = $t.Actions[0]; $s = $t.Settings; `
    + `[pscustomobject]@{ armed = $true; state = "$($t.State)"; execute = $a.Execute; arguments = $a.Arguments; `
    + `startWhenAvailable = $s.StartWhenAvailable; disallowOnBatteries = $s.DisallowStartIfOnBatteries; `
    + `stopOnBatteries = $s.StopIfGoingOnBatteries } | ConvertTo-Json -Compress }`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}

/** Ways the live task differs from the spec (empty array = as intended). */
export function taskDrift(task, wrapper) {
  if (!task || task.error) return [`could not query the task${task && task.error ? ` (${task.error})` : ''}`];
  if (!task.armed) return ['not armed'];
  const drift = [];
  if (!/conhost(\.exe)?$/i.test(task.execute || '') || !/--headless/.test(task.arguments || '')) {
    drift.push(`not headless: runs ${task.execute}${task.arguments ? ` ${task.arguments}` : ''} in a visible console`);
  } else if (wrapper && !(task.arguments || '').includes(wrapper)) {
    drift.push(`headless, but not this repo's wrapper (${task.arguments})`);
  }
  if (task.startWhenAvailable !== true) drift.push('no catch-up after a missed 04:00 (StartWhenAvailable off)');
  if (task.disallowOnBatteries !== false) drift.push('refuses to start on battery');
  if (task.stopOnBatteries !== false) drift.push('stops a sweep on battery');
  return drift;
}
