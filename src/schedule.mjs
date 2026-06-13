#!/usr/bin/env node
/**
 * src/schedule.mjs — Phase 5: register (or just PRINT) the nightly Windows task.
 *
 *   node src/schedule.mjs              # print the schtasks command — ARMS NOTHING (default)
 *   node src/schedule.mjs --install    # actually create the daily 04:00 task
 *   node src/schedule.mjs --status     # query the task
 *   node src/schedule.mjs --uninstall  # remove it
 *
 * Registering a scheduled task is persistent system config — a deliberate,
 * explicit step. So the DEFAULT does nothing but show you the exact command;
 * nothing gets armed unless you (a human) run --install on purpose.
 *
 * Note: a 04:00 daily task only fires if the machine is awake then. If the box
 * sleeps, add /RL or a wake timer via Task Scheduler, or run --now by hand —
 * the no-change short-circuit makes catch-up runs cheap.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TASK = 'vugg-canary-nightly';
const TIME = '04:00';

const nodeExe = process.execPath;
const sweep = path.join(CANARY_ROOT, 'src', 'sweep.mjs');
const logFile = path.join(CANARY_ROOT, 'logs', '_nightly.log');
// /TR must be a single string; cd into the repo so config-relative paths resolve.
const tr = `cmd /c cd /d "${CANARY_ROOT}" && "${nodeExe}" "${sweep}" --now >> "${logFile}" 2>&1`;
const createArgs = ['/create', '/tn', TASK, '/sc', 'DAILY', '/st', TIME, '/tr', tr, '/f'];

const mode = process.argv[2] || '--print';

if (mode === '--print' || mode === '--help' || mode === '-h') {
  console.log(`vugg-canary scheduler (Phase 5) — nothing armed.\n`);
  console.log(`A daily ${TIME} task "${TASK}" would run:`);
  console.log(`  ${tr}\n`);
  console.log(`Arm it:     node src/schedule.mjs --install`);
  console.log(`  (equiv:   schtasks ${createArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')})`);
  console.log(`Check:      node src/schedule.mjs --status`);
  console.log(`Remove:     node src/schedule.mjs --uninstall`);
} else if (mode === '--install') {
  fs.mkdirSync(path.join(CANARY_ROOT, 'logs'), { recursive: true });
  execFileSync('schtasks', createArgs, { stdio: 'inherit' });
  console.log(`[schedule] armed "${TASK}" daily at ${TIME}. (--status to verify, --uninstall to remove)`);
} else if (mode === '--status') {
  try { execFileSync('schtasks', ['/query', '/tn', TASK, '/v', '/fo', 'LIST'], { stdio: 'inherit' }); }
  catch { console.log(`[schedule] task "${TASK}" not found — not armed.`); }
} else if (mode === '--uninstall') {
  try { execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'], { stdio: 'inherit' }); console.log(`[schedule] removed "${TASK}".`); }
  catch { console.log(`[schedule] task "${TASK}" not found — nothing to remove.`); }
} else {
  console.error(`unknown mode "${mode}" — use --print | --install | --status | --uninstall`);
  process.exit(2);
}
