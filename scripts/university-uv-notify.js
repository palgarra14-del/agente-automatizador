import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  decideAcademicNotification,
  notifiedAcademicState
} from '../src/university-attention-notifier.js';

const run = promisify(execFile);
const stateDir = resolve(
  process.env.UNIVERSITY_STATE_DIR ??
  join(homedir(), '.local', 'state', 'engineering-orchestrator', 'university')
);
const attentionFile = join(stateDir, 'uv-attention.json');
const notifyStateFile = join(stateDir, 'uv-notify-state.json');
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

if (process.env.UNIVERSITY_NOTIFY_DISABLED === '1') process.exit(0);

const attention = await readJson(attentionFile);
if (!attention) process.exit(0);
const previous = await readJson(notifyStateFile);
const decision = decideAcademicNotification(attention, previous);
if (!decision.notify) process.exit(0);

const healthAlert = Array.isArray(attention.reasons) && attention.reasons.includes('academic_monitor_degraded');
const balloonText = healthAlert
  ? 'La vigilancia académica necesita que revises la sesión de la UV.'
  : 'Hay una novedad académica relevante. Revisa el informe cuando te venga bien.';

const ps = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.BalloonTipTitle = "Universidad"',
  '$n.BalloonTipText = "' + balloonText + '"',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(5000)',
  'Start-Sleep -Seconds 6',
  '$n.Dispose()'
].join('; ');

await run(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
  timeout: 12_000,
  maxBuffer: 50_000
});

await writePrivateJson(
  notifyStateFile,
  notifiedAcademicState(decision, new Date().toISOString())
);
