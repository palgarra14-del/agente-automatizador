import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedRateLimitRetrySeconds,
  cloudRetryUnitName,
  laneRateLimitRetrySeconds,
  rateLimitRetryStaggerSeconds,
  scheduleCloudRateLimitRetry
} from '../scripts/schedule-cloud-retry.js';

test('rate-limit retry delay adds reset padding and stays bounded', () => {
  assert.equal(boundedRateLimitRetrySeconds(0), 30);
  assert.equal(boundedRateLimitRetrySeconds(61_234), 67);
  assert.equal(boundedRateLimitRetrySeconds(720_000), 725);
  assert.equal(boundedRateLimitRetrySeconds(10 * 60 * 60 * 1000), 7_200);
  assert.throws(() => boundedRateLimitRetrySeconds(-1), /cloud_retry_delay_invalid/);
  assert.throws(() => boundedRateLimitRetrySeconds('nope'), /cloud_retry_delay_invalid/);
});

test('rate-limit retries are staggered by lane with business ahead of self', () => {
  assert.equal(rateLimitRetryStaggerSeconds('callflow'), 0);
  assert.equal(rateLimitRetryStaggerSeconds('leadfinder'), 15);
  assert.equal(rateLimitRetryStaggerSeconds('website-pilot'), 30);
  assert.equal(rateLimitRetryStaggerSeconds('self'), 60);
  assert.equal(laneRateLimitRetrySeconds(159_933, 'callflow'), 165);
  assert.equal(laneRateLimitRetrySeconds(159_933, 'leadfinder'), 180);
  assert.equal(laneRateLimitRetrySeconds(159_933, 'website-pilot'), 195);
  assert.equal(laneRateLimitRetrySeconds(159_933, 'self'), 225);
});

test('lane staggering remains bounded at the global retry cap', () => {
  assert.equal(laneRateLimitRetrySeconds(10 * 60 * 60 * 1000, 'self'), 7_200);
  assert.equal(rateLimitRetryStaggerSeconds('safe-extra-lane'), 45);
  assert.throws(() => rateLimitRetryStaggerSeconds('../escape'), /cloud_retry_lane_invalid/);
});

test('rate-limit retry unit is lane-scoped and rejects unsafe lane names', () => {
  assert.equal(cloudRetryUnitName('website-pilot'), 'agent-cloud-retry-website-pilot');
  assert.throws(() => cloudRetryUnitName('../escape'), /cloud_retry_lane_invalid/);
});

test('existing lane timer deduplicates another delayed dispatch', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'systemctl') return { stdout: 'active\n', stderr: '' };
    throw new Error('systemd-run must not be called');
  };
  const result = await scheduleCloudRateLimitRetry({
    lane: 'website-pilot',
    retryAfterMs: 61_000,
    exec,
    home: '/home/tester'
  });
  assert.equal(result.scheduled, false);
  assert.equal(result.alreadyPending, true);
  assert.equal(calls.length, 1);
});

test('rate-limit retry schedules one allowlisted gh workflow dispatch without embedding credentials', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'systemctl') throw new Error('inactive');
    if (command === 'systemd-run') return { stdout: '', stderr: '' };
    throw new Error('unexpected command');
  };
  const result = await scheduleCloudRateLimitRetry({
    lane: 'website-pilot',
    retryAfterMs: 61_000,
    exec,
    home: '/home/tester',
    ghBin: '/usr/bin/gh'
  });
  assert.equal(result.scheduled, true);
  assert.equal(result.delaySeconds, 96);
  const run = calls.find(([command]) => command === 'systemd-run');
  assert.ok(run);
  const serialized = run[1].join(' ');
  assert.match(serialized, /--unit=agent-cloud-retry-website-pilot/);
  assert.match(serialized, /--on-active=96s/);
  assert.match(serialized, /\/usr\/bin\/gh workflow run agent-cloud\.yml --repo palgarra14-del\/agente-automatizador -f lane=website-pilot/);
  assert.doesNotMatch(serialized, /token|secret|authorization/i);
});

test('local timer failure falls back to the existing scheduled heartbeat without failing the lane', async () => {
  const exec = async (command) => {
    if (command === 'systemctl') throw new Error('inactive');
    throw new Error('systemd unavailable');
  };
  const result = await scheduleCloudRateLimitRetry({
    lane: 'callflow',
    retryAfterMs: 30_000,
    exec,
    home: '/home/tester'
  });
  assert.deepEqual(result, {
    version: 1,
    lane: 'callflow',
    scheduled: false,
    alreadyPending: false,
    delaySeconds: 35,
    fallback: 'scheduled_heartbeat'
  });
});

test('rate-limit retry cannot target another repository or workflow', async () => {
  await assert.rejects(
    () => scheduleCloudRateLimitRetry({
      lane: 'leadfinder',
      retryAfterMs: 1_000,
      repository: 'other/repo',
      exec: async () => ({ stdout: '', stderr: '' })
    }),
    /cloud_retry_repository_invalid/
  );
  await assert.rejects(
    () => scheduleCloudRateLimitRetry({
      lane: 'leadfinder',
      retryAfterMs: 1_000,
      workflow: 'other.yml',
      exec: async () => ({ stdout: '', stderr: '' })
    }),
    /cloud_retry_workflow_invalid/
  );
});
