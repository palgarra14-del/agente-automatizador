import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudWorkerFreshness, runCloudWatchdog } from '../scripts/cloud-watchdog.js';

const NOW = Date.parse('2026-09-23T08:30:00Z');

function response(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body; }
  };
}

test('watchdog treats a recent cloud-worker run as healthy', () => {
  const result = cloudWorkerFreshness({
    runs: [{ created_at: '2026-09-23T08:15:01Z' }],
    now: NOW,
    maxAgeMs: 20 * 60 * 1000
  });
  assert.equal(result.dispatch, false);
  assert.equal(result.latestRunAt, '2026-09-23T08:15:01.000Z');
});

test('watchdog dispatches when cloud-worker history is stale or absent', () => {
  assert.equal(cloudWorkerFreshness({
    runs: [{ created_at: '2026-09-23T08:09:59Z' }],
    now: NOW,
    maxAgeMs: 20 * 60 * 1000
  }).dispatch, true);
  assert.equal(cloudWorkerFreshness({ runs: [], now: NOW }).dispatch, true);
});

test('watchdog rejects implausible future timestamps and invalid bounds', () => {
  assert.throws(() => cloudWorkerFreshness({
    runs: [{ created_at: '2026-09-23T08:40:01Z' }],
    now: NOW
  }), /cloud_watchdog_timestamp_invalid/);
  assert.throws(() => cloudWorkerFreshness({ runs: [], now: NOW, maxAgeMs: 60_000 }), /cloud_watchdog_input_invalid/);
});

test('watchdog skips dispatch when the cloud worker is fresh', async () => {
  const calls = [];
  const result = await runCloudWatchdog({
    token: 'token',
    repository: 'owner/repo',
    now: NOW,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return response(200, JSON.stringify({
        workflow_runs: [{ created_at: '2026-09-23T08:20:00Z' }]
      }));
    },
    apiBase: 'https://example.invalid'
  });
  assert.equal(result.dispatched, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /agent-cloud\.yml\/runs\?per_page=20$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
});

test('watchdog dispatches trusted main only after stale evidence', async () => {
  const calls = [];
  const result = await runCloudWatchdog({
    token: 'token',
    repository: 'owner/repo',
    now: NOW,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return response(200, JSON.stringify({
          workflow_runs: [{ created_at: '2026-09-23T07:00:00Z' }]
        }));
      }
      return response(204);
    },
    apiBase: 'https://example.invalid'
  });
  assert.equal(result.dispatched, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /agent-cloud\.yml\/dispatches$/);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'main' });
});

test('watchdog fails closed on list or dispatch API errors without leaking token', async () => {
  await assert.rejects(
    runCloudWatchdog({
      token: 'super-secret-token',
      repository: 'owner/repo',
      fetchImpl: async () => response(403, 'forbidden')
    }),
    (error) => {
      assert.match(error.message, /cloud_watchdog_list_failed:403/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      return true;
    }
  );
  let call = 0;
  await assert.rejects(
    runCloudWatchdog({
      token: 'token',
      repository: 'owner/repo',
      now: NOW,
      fetchImpl: async () => {
        call += 1;
        if (call === 1) return response(200, JSON.stringify({ workflow_runs: [] }));
        return response(403, 'forbidden');
      }
    }),
    /cloud_watchdog_dispatch_failed:403/
  );
});
