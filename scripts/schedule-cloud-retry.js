#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = 'palgarra14-del/agente-automatizador';
const DEFAULT_WORKFLOW = 'agent-cloud.yml';
const DEFAULT_GH_BIN = '/usr/bin/gh';
const MIN_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 2 * 60 * 60;
const RETRY_PADDING_MS = 5_000;
const LANE_RETRY_STAGGER_SECONDS = Object.freeze({
  callflow: 0,
  leadfinder: 15,
  'website-pilot': 30,
  self: 60
});
const UNKNOWN_LANE_STAGGER_SECONDS = 45;

function assertLane(lane) {
  const value = String(lane ?? '').trim();
  if (!/^[a-z0-9-]{1,80}$/.test(value)) throw new Error('cloud_retry_lane_invalid');
  return value;
}

export function boundedRateLimitRetrySeconds(retryAfterMs) {
  const raw = Number(retryAfterMs);
  if (!Number.isFinite(raw) || raw < 0) throw new Error('cloud_retry_delay_invalid');
  const paddedMs = raw + RETRY_PADDING_MS;
  return Math.max(
    MIN_RETRY_SECONDS,
    Math.min(MAX_RETRY_SECONDS, Math.ceil(paddedMs / 1000))
  );
}

export function rateLimitRetryStaggerSeconds(lane) {
  const safeLane = assertLane(lane);
  return LANE_RETRY_STAGGER_SECONDS[safeLane] ?? UNKNOWN_LANE_STAGGER_SECONDS;
}

export function laneRateLimitRetrySeconds(retryAfterMs, lane) {
  return Math.min(
    MAX_RETRY_SECONDS,
    boundedRateLimitRetrySeconds(retryAfterMs) + rateLimitRetryStaggerSeconds(lane)
  );
}

export function cloudRetryUnitName(lane) {
  return `agent-cloud-retry-${assertLane(lane)}`;
}

async function timerActive(exec, timerUnit) {
  try {
    const { stdout = '' } = await exec(
      'systemctl',
      ['--user', 'is-active', timerUnit],
      { timeout: 3_000, maxBuffer: 64_000 }
    );
    return ['active', 'activating'].includes(stdout.trim());
  } catch {
    return false;
  }
}

export async function scheduleCloudRateLimitRetry({
  lane,
  retryAfterMs,
  repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
  workflow = DEFAULT_WORKFLOW,
  ghBin = process.env.AGENT_GH_BIN || DEFAULT_GH_BIN,
  home = homedir(),
  exec = execFileAsync
} = {}) {
  const safeLane = assertLane(lane);
  if (repository !== DEFAULT_REPOSITORY) throw new Error('cloud_retry_repository_invalid');
  if (workflow !== DEFAULT_WORKFLOW) throw new Error('cloud_retry_workflow_invalid');
  if (!/^\/[A-Za-z0-9_./-]{1,240}$/.test(String(ghBin || ''))) throw new Error('cloud_retry_gh_bin_invalid');
  if (!/^\/[A-Za-z0-9_./-]{1,500}$/.test(String(home || ''))) throw new Error('cloud_retry_home_invalid');
  if (typeof exec !== 'function') throw new Error('cloud_retry_exec_invalid');

  const delaySeconds = laneRateLimitRetrySeconds(retryAfterMs, safeLane);
  const unit = cloudRetryUnitName(safeLane);
  const timerUnit = `${unit}.timer`;

  const alreadyPending = await timerActive(exec, timerUnit);
  if (alreadyPending) {
    try {
      await exec(
        'systemctl',
        ['--user', 'stop', timerUnit, `${unit}.service`],
        { timeout: 3_000, maxBuffer: 64_000 }
      );
      // Transient units created with --collect disappear asynchronously once
      // stopped. Give systemd a bounded moment to release the stable lane name.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    } catch {
      return {
        version: 1,
        lane: safeLane,
        scheduled: false,
        alreadyPending: true,
        delaySeconds,
        fallback: 'existing_timer'
      };
    }
  }

  const args = [
    '--user',
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    `--on-active=${delaySeconds}s`,
    `--setenv=HOME=${home}`,
    '--setenv=GH_HOST=github.com',
    ghBin,
    'workflow',
    'run',
    workflow,
    '--repo',
    repository,
    '-f',
    `lane=${safeLane}`
  ];

  try {
    await exec('systemd-run', args, { timeout: 5_000, maxBuffer: 128_000 });
    return {
      version: 1,
      lane: safeLane,
      scheduled: true,
      alreadyPending,
      delaySeconds,
      fallback: null
    };
  } catch {
    return {
      version: 1,
      lane: safeLane,
      scheduled: false,
      alreadyPending: false,
      delaySeconds,
      fallback: 'scheduled_heartbeat'
    };
  }
}

async function main() {
  const result = await scheduleCloudRateLimitRetry({
    lane: process.env.AGENT_CLOUD_LANE,
    retryAfterMs: process.env.AGENT_RATE_LIMIT_RETRY_MS,
    repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
