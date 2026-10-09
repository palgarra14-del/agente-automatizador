import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  githubRateLimitWaitFromDrain,
  localGithubCooldownPath,
  localGithubCooldownRemainingMs,
  saveLocalGithubCooldown
} from '../src/local-github-cooldown.js';

function drainResult(stopReason, error, retryAfterMs) {
  return JSON.stringify({
    stopReason,
    limits: { retryAfterMs },
    recovery: error ? [{ error }] : [],
    iterations: []
  });
}

test('local drain cooldown only accepts explicit GitHub 403 or 429 rate limits', () => {
  assert.equal(githubRateLimitWaitFromDrain(drainResult(
    'rate_limited', 'cloud_state_github_rate_limited:403', 101665
  )), 103665);
  assert.equal(githubRateLimitWaitFromDrain(drainResult(
    'rate_limited', 'cloud_state_github_rate_limited:429', 0
  )), 2000);
  assert.equal(githubRateLimitWaitFromDrain(drainResult(
    'rate_limited', 'cloud_state_github_rate_limited:403', null
  )), 60000);
  assert.equal(githubRateLimitWaitFromDrain(drainResult(
    'rate_limited', 'cloud_state_github_rate_limited:403', 50 * 60 * 1000
  )), 50 * 60 * 1000 + 2_000);
  assert.equal(githubRateLimitWaitFromDrain(drainResult(
    'rate_limited', 'cloud_state_github_rate_limited:403', 3 * 60 * 60 * 1000
  )), 75 * 60 * 1000);
  assert.equal(githubRateLimitWaitFromDrain(drainResult('duration_limit', 'cloud_state_github_rate_limited:403', 10000)), null);
  assert.equal(githubRateLimitWaitFromDrain(drainResult('rate_limited', 'cloud_state_github_request_failed:503', 10000)), null);
  assert.equal(githubRateLimitWaitFromDrain('not json'), null);
});

test('cooldown survives independently of worker processes and never shortens an active wait', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-cooldown-'));
  const file = join(dir, 'state', 'github.json');
  try {
    assert.equal(localGithubCooldownRemainingMs(file, 5000), 0);
    assert.equal(saveLocalGithubCooldown(10000, file, 5000), true);
    assert.equal(localGithubCooldownRemainingMs(file, 5000), 10000);
    assert.equal(localGithubCooldownRemainingMs(file, 9000), 6000);
    assert.equal(saveLocalGithubCooldown(3000, file, 6000), true);
    assert.equal(localGithubCooldownRemainingMs(file, 6000), 9000);
    assert.equal(saveLocalGithubCooldown(11000, file, 6000), true);
    assert.equal(localGithubCooldownRemainingMs(file, 6000), 11000);
    assert.equal(localGithubCooldownRemainingMs(file, 17000), 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
    writeFileSync(file, 'broken json');
    assert.equal(localGithubCooldownRemainingMs(file, 17000), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local state follows XDG and does not embed credentials', () => {
  assert.equal(localGithubCooldownPath({HOME:'/tmp/home'}), '/tmp/home/.local/state/engineering-orchestrator/github-rate-limit.json');
  assert.equal(localGithubCooldownPath({HOME:'/tmp/home',XDG_STATE_HOME:'/tmp/state'}), '/tmp/state/engineering-orchestrator/github-rate-limit.json');
});
