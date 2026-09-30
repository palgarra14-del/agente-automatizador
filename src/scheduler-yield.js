import { homedir } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const LANE_PATTERN = /^[a-z][a-z0-9-]{0,79}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function stateRoot(explicit) {
  return resolve(explicit || process.env.AGENT_SCHEDULER_STATE_DIR ||
    resolve(homedir(), '.local', 'state', 'engineering-orchestrator', 'scheduler'));
}

function lanePath(lane, root) {
  if (!LANE_PATTERN.test(lane ?? '')) throw new Error('scheduler_yield_lane_invalid');
  return resolve(root, `yield-${lane}.json`);
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function requestSchedulerYield(lane, {
  reason = 'scheduler_priority',
  ttlMs = DEFAULT_TTL_MS,
  stateDir,
  now = () => Date.now()
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1000) {
    throw new Error('scheduler_yield_ttl_invalid');
  }
  const requestedAt = now();
  if (!Number.isFinite(requestedAt)) throw new Error('scheduler_yield_clock_invalid');
  const root = stateRoot(stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = lanePath(lane, root);
  const temporary = `${target}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    lane,
    reason: String(reason).slice(0, 240),
    requestedAt: new Date(requestedAt).toISOString(),
    expiresAt: new Date(requestedAt + ttlMs).toISOString()
  };
  await writeFile(temporary, JSON.stringify(payload) + '\n', {
    encoding: 'utf8',
    mode: 0o600
  });
  await rename(temporary, target);
  return payload;
}

export async function clearSchedulerYield(lane, { stateDir } = {}) {
  const target = lanePath(lane, stateRoot(stateDir));
  await removeIfPresent(target);
}

export async function schedulerYieldRequested(lane, {
  stateDir,
  now = () => Date.now()
} = {}) {
  const target = lanePath(lane, stateRoot(stateDir));
  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (raw.length > 4096) {
    await removeIfPresent(target);
    return false;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    await removeIfPresent(target);
    return false;
  }
  const expiresAt = Date.parse(value?.expiresAt ?? '');
  if (value?.version !== 1 || value?.lane !== lane || !Number.isFinite(expiresAt)) {
    await removeIfPresent(target);
    return false;
  }
  const current = now();
  if (!Number.isFinite(current)) throw new Error('scheduler_yield_clock_invalid');
  if (expiresAt <= current) {
    await removeIfPresent(target);
    return false;
  }
  return true;
}

export async function syncSchedulerYieldRequests(lanes, yieldCandidates = [], options = {}) {
  const requested = new Set((yieldCandidates ?? []).map((item) => item?.lane).filter(Boolean));
  for (const lane of lanes) {
    if (requested.has(lane)) {
      const candidate = yieldCandidates.find((item) => item?.lane === lane);
      await requestSchedulerYield(lane, { ...options, reason: candidate?.reason ?? 'scheduler_priority' });
    } else {
      await clearSchedulerYield(lane, options);
    }
  }
  return [...requested].sort();
}

export const SCHEDULER_YIELD_DEFAULTS = Object.freeze({
  ttlMs: DEFAULT_TTL_MS
});
