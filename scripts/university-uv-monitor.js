import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  academicHealthAttention,
  academicReportFailure,
  degradedAcademicMonitorState,
  healthyAcademicMonitorState
} from '../src/university-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stateDir = resolve(
  process.env.UNIVERSITY_STATE_DIR ??
  join(homedir(), '.local', 'state', 'engineering-orchestrator', 'university')
);
const healthFile = join(stateDir, 'uv-health.json');
const attentionFile = join(stateDir, 'uv-attention.json');
const reportFile = join(stateDir, 'uv-daily-report.json');
const dailyScript = join(root, 'scripts', 'university-uv-daily.js');
const notifyScript = join(root, 'scripts', 'university-uv-notify.js');

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

function runScript(script, { timeoutMs = 110_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk).slice(0, 2_000 - stderr.length);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error('academic_monitor_child_failed:' + (code ?? signal ?? 'unknown') + ':' + stderr.slice(0, 240)));
    });
  });
}

const capturedAt = new Date().toISOString();
const previousHealth = await readJson(healthFile);
let failed;

try {
  await runScript(dailyScript);
  const report = await readJson(reportFile);
  failed = academicReportFailure(report);
} catch (error) {
  failed = String(error?.message || 'academic_scan_failed').slice(0, 120);
}

if (failed) {
  const health = degradedAcademicMonitorState(previousHealth, capturedAt, failed);
  await writePrivateJson(healthFile, health);
  await writePrivateJson(attentionFile, academicHealthAttention(health));
} else {
  await writePrivateJson(healthFile, healthyAcademicMonitorState(capturedAt));
}

try {
  await runScript(notifyScript, { timeoutMs: 15_000 });
} catch {
  process.stderr.write('academic_notify_failed\n');
  if (!failed) process.exitCode = 1;
}

if (failed) {
  process.stderr.write('academic_monitor_degraded\n');
  process.exitCode = 1;
}
