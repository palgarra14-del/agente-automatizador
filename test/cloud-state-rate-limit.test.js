import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubStateStore } from '../src/cloud-state.js';

const SHA = 'a'.repeat(40);

function response(status, payload = null, { headers = {}, body = null } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null },
    clone() { return { text: async () => body ?? JSON.stringify(payload) }; },
    async json() { return payload; }
  };
}

function store(fetchImpl, sleep, { now = () => Date.now() } = {}) {
  return new GitHubStateStore({
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    token: 'test-token-not-a-real-secret',
    fetchImpl,
    sleep,
    now
  });
}
test('cloud-state retries transient GET network failures but preserves fail-closed mutations', async () => {
  let readCalls = 0;
  const waits = [];
  const subject = store(async () => {
    readCalls += 1;
    if (readCalls === 1) throw new TypeError('fetch failed');
    return response(200, { object: { sha: SHA } });
  }, async (ms) => waits.push(ms));

  assert.equal(await subject.refSha('tags/test'), SHA);
  assert.equal(readCalls, 2);
  assert.deepEqual(waits, [1_000]);

  let writeCalls = 0;
  const writer = store(async () => {
    writeCalls += 1;
    throw new TypeError('fetch failed');
  }, async () => { throw new Error('mutation_must_not_sleep'); });

  await assert.rejects(
    () => writer.request('/git/refs', { method: 'POST', body: { ref: 'refs/tags/test', sha: SHA } }),
    /cloud_state_github_request_failed/
  );
  assert.equal(writeCalls, 1);
});

test('cloud-state exhausts bounded GET network retries before failing closed', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }, async (ms) => waits.push(ms));

  await assert.rejects(() => subject.refSha('tags/test'), /cloud_state_github_request_failed/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 3_000]);
});

test('cloud-state yields a GET when GitHub reports a long secondary rate limit', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async () => {
    calls += 1;
    return response(403, null, { body: 'You have exceeded a secondary rate limit.' });
  }, async (ms) => waits.push(ms));

  await assert.rejects(
    () => subject.refSha('tags/test'),
    (error) => error?.message === 'cloud_state_github_rate_limited:403' && error?.retryAfterMs === 60_000
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('cloud-state honors the primary rate-limit reset timestamp when the window is exhausted', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async () => {
    calls += 1;
    if (calls === 1) {
      return response(403, null, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1005'
        }
      });
    }
    return response(200, { object: { sha: SHA } });
  }, async (ms) => waits.push(ms), { now: () => 1_000_000 });

  assert.equal(await subject.refSha('tags/test'), SHA);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [6_000]);
});

test('cloud-state does not retry a permission 403 that is not rate limited', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async () => {
    calls += 1;
    return response(403, null, { body: 'Resource not accessible by integration' });
  }, async (ms) => waits.push(ms));

  await assert.rejects(() => subject.refSha('tags/test'), /cloud_state_github_request_failed:403/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});
test('cloud-state never retries mutating requests after a rate-limit response', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async () => {
    calls += 1;
    return response(429, null, { headers: { 'retry-after': '1' } });
  }, async (ms) => waits.push(ms));

  await assert.rejects(
    () => subject.request('/git/refs', { method: 'POST', body: { ref: 'refs/tags/test', sha: SHA } }),
    /cloud_state_github_request_failed:429/
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('cloud-state exact GraphQL status reads yield on long secondary rate limits', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async (url) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/graphql');
    return response(403, null, { body: 'You have exceeded a secondary rate limit.' });
  }, async (ms) => waits.push(ms));

  await assert.rejects(
    () => subject.readStatusContext(SHA, 'agent-cloud-state-v2/test'),
    (error) => error?.message === 'cloud_state_github_rate_limited:403' && error?.retryAfterMs === 60_000
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('exact GraphQL status reads honor the primary rate-limit reset timestamp', async () => {
  let calls = 0;
  const waits = [];
  const subject = store(async (url) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/graphql');
    if (calls === 1) {
      return response(403, null, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1005'
        }
      });
    }
    return response(200, {
      data: {
        repository: {
          object: {
            status: {
              context: {
                context: 'agent-cloud-state-v2/test',
                state: 'SUCCESS',
                description: 'r=' + SHA,
                targetUrl: null
              }
            }
          }
        }
      }
    });
  }, async (ms) => waits.push(ms), { now: () => 1_000_000 });

  const status = await subject.readStatusContext(SHA, 'agent-cloud-state-v2/test');

  assert.equal(status.state, 'success');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [6_000]);
});
