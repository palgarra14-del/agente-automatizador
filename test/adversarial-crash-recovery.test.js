import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/core.js';

test('adversarial: a stale state lock left by a dead process does not permanently block the orchestrator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-stale-lock-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file, { lockTimeoutMs: 150, lockPollMs: 10 });
  await store.save({ runs: {}, approvals: {}, events: [] });

  // Simulate a lock left behind by a process that died long ago.
  await writeFile(`${file}.lock`, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });

  await store.mutate((data) => {
    data.runs.recovered = { id: 'recovered', status: 'created' };
  });

  const final = await store.load();
  assert.ok(final.runs.recovered, 'stale lock prevented crash recovery');
});
