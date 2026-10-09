import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Match Cloud State's bounded one-hour-plus rate-limit reset window.
const MAX_WAIT_MS = 75 * 60 * 1000;
const DEFAULT_WAIT_MS = 60_000;

export function localGithubCooldownPath(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(stateHome, 'engineering-orchestrator', 'github-rate-limit.json');
}

export function githubRateLimitWaitFromDrain(output) {
  let result;
  try { result = JSON.parse(String(output || '').trim()); } catch { return null; }
  if (result?.stopReason !== 'rate_limited' ||
      !Array.isArray(result.recovery) ||
      !result.recovery.some((item) => /^cloud_state_github_rate_limited:(403|429)$/.test(String(item?.error ?? '')))) {
    return null;
  }
  const raw = result.limits?.retryAfterMs;
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(2_000, Math.ceil(raw) + 2_000));
}

export function localGithubCooldownRemainingMs(path = localGithubCooldownPath(), now = Date.now()) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.version !== 1 || !Number.isSafeInteger(data.untilMs)) return 0;
    return Math.min(MAX_WAIT_MS, Math.max(0, data.untilMs - now));
  } catch {
    return 0;
  }
}

export function saveLocalGithubCooldown(waitMs, path = localGithubCooldownPath(), now = Date.now()) {
  if (!Number.isFinite(waitMs) || waitMs < 0) return false;
  const previous = localGithubCooldownRemainingMs(path, now);
  const untilMs = now + Math.min(MAX_WAIT_MS, Math.max(previous, Math.ceil(waitMs)));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, untilMs }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already completed or failed before writing */ }
  }
  return true;
}
