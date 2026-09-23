import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_FILE = 'agent-cloud.yml';
const DEFAULT_MAX_AGE_MS = 20 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function boundedJsonText(text, label) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`${label}_invalid`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

function runTimestamp(run) {
  const value = Date.parse(run?.created_at ?? '');
  return Number.isFinite(value) ? value : null;
}

export function cloudWorkerFreshness({ runs, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!Array.isArray(runs) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 5 * 60 * 1000 || maxAgeMs > 60 * 60 * 1000) {
    throw new Error('cloud_watchdog_input_invalid');
  }
  let latest = null;
  for (const run of runs) {
    const createdAt = runTimestamp(run);
    if (createdAt === null) continue;
    if (createdAt > now + 5 * 60 * 1000) throw new Error('cloud_watchdog_timestamp_invalid');
    if (latest === null || createdAt > latest) latest = createdAt;
  }
  if (latest === null) return { dispatch: true, latestRunAt: null, ageMs: null };
  const ageMs = Math.max(0, now - latest);
  return {
    dispatch: ageMs > maxAgeMs,
    latestRunAt: new Date(latest).toISOString(),
    ageMs
  };
}

async function requestText(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') {
    throw new Error(`${label}_invalid_response`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`${label}_failed:${response.status}`);
  return body;
}

export async function runCloudWatchdog({
  token,
  repository,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com'
} = {}) {
  if (typeof token !== 'string' || token.length < 1 || !REPOSITORY_PATTERN.test(repository ?? '') || typeof fetchImpl !== 'function') {
    throw new Error('cloud_watchdog_configuration_invalid');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const encodedWorkflow = encodeURIComponent(WORKFLOW_FILE);
  const listUrl = `${apiBase}/repos/${repository}/actions/workflows/${encodedWorkflow}/runs?per_page=20`;
  const listBody = await requestText(fetchImpl, listUrl, { headers }, 'cloud_watchdog_list');
  const payload = boundedJsonText(listBody, 'cloud_watchdog_list');
  const freshness = cloudWorkerFreshness({ runs: payload.workflow_runs, now, maxAgeMs });
  if (!freshness.dispatch) return { dispatched: false, reason: 'recent_cloud_worker', ...freshness };

  const dispatchUrl = `${apiBase}/repos/${repository}/actions/workflows/${encodedWorkflow}/dispatches`;
  const response = await fetchImpl(dispatchUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' })
  });
  if (!response || response.status !== 204) {
    throw new Error(`cloud_watchdog_dispatch_failed:${response?.status ?? 'invalid'}`);
  }
  return { dispatched: true, reason: 'stale_cloud_worker', ...freshness };
}

function configuredMaxAgeMs() {
  const raw = process.env.AGENT_WATCHDOG_MAX_AGE_MINUTES;
  if (!raw) return DEFAULT_MAX_AGE_MS;
  if (!/^[0-9]{1,2}$/.test(raw)) throw new Error('cloud_watchdog_max_age_invalid');
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 60) throw new Error('cloud_watchdog_max_age_invalid');
  return minutes * 60 * 1000;
}

async function main() {
  const result = await runCloudWatchdog({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    maxAgeMs: configuredMaxAgeMs()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
