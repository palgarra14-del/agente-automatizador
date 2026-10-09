#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { githubRateLimitWaitFromDrain, saveLocalGithubCooldown } from '../src/local-github-cooldown.js';

const laneIndex = process.argv.indexOf('--lane');
const lane = laneIndex >= 0 ? process.argv[laneIndex + 1] : '';
if (!/^[a-z0-9-]{1,80}$/.test(lane)) throw new Error('local_cloud_lane_invalid');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let token = String(process.env.GITHUB_TOKEN ?? '').trim();
if (!token) {
  try {
    token = execFileSync('gh', ['auth', 'token'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw new Error('local_cloud_github_token_unavailable');
  }
}
if (token.length < 20 || /[\s\0\r\n]/.test(token)) throw new Error('local_cloud_github_token_invalid');

const child = spawn(process.execPath, ['src/cli.js', 'inbox', 'cloud-drain', '--lane', lane], {
  cwd: root,
  env: {
    ...process.env,
    GITHUB_TOKEN: token,
    AGENT_GITHUB_TOKEN: process.env.AGENT_GITHUB_TOKEN || token
  },
  stdio: ['inherit', 'pipe', 'inherit']
});

// Preserve existing stdout and capture only bounded structured drain results.
const captured = [];
let capturedBytes = 0;
let oversized = false;
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (oversized) return;
  capturedBytes += chunk.length;
  if (capturedBytes > 256 * 1024) {
    oversized = true;
    captured.length = 0;
  } else {
    captured.push(chunk);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', () => {
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  if (!oversized) {
    const waitMs = githubRateLimitWaitFromDrain(Buffer.concat(captured).toString('utf8'));
    if (waitMs !== null) {
      try {
        saveLocalGithubCooldown(waitMs);
        console.error(`local_github_rate_limit_cooldown_ms=${waitMs}`);
      } catch (error) {
        console.error(`local_github_cooldown_persist_failed: ${error.message}`);
      }
    }
  }
  process.exitCode = signal ? 1 : (code ?? 1);
});
