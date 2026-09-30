import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudPeekHasWork } from '../src/cloud-peek.js';

test('cloud peek reads and reports queue or autonomous work', async () => {
  const calls = [];
  const store = { async readSnapshot(options) { calls.push(options); return {}; } };
  const queue = { async hasWork() { return false; } };
  const autonomous = { async hasWork() { return true; } };

  assert.equal(await cloudPeekHasWork({ store, queue, autonomousSelfImprovement: autonomous }), true);
  assert.deepEqual(calls, [{ repair: true }]);
});

test('cloud execution peek uses execution-only queue work', async () => {
  let normalCalls = 0;
  let executionCalls = 0;
  const store = { async readSnapshot() { return {}; } };
  const queue = {
    async hasWork() { normalCalls += 1; return false; },
    async hasExecutionWork() { executionCalls += 1; return true; }
  };

  assert.equal(await cloudPeekHasWork({ store, queue, executionOnly: true }), true);
  assert.equal(normalCalls, 0);
  assert.equal(executionCalls, 1);
});

test('cloud peek conservatively reports work when governed repair collides with a concurrent writer', async () => {
  const store = { async readSnapshot() { throw new Error('cloud_state_conflict'); } };
  const queue = { async hasWork() { throw new Error('must not read queue after repair conflict'); } };

  assert.equal(await cloudPeekHasWork({ store, queue }), true);
});

test('cloud peek reports transient post-repair state races as work instead of failing', async () => {
  const store = { async readSnapshot() { return {}; } };
  const queue = { async hasWork() { throw new Error('cloud_state_rollback'); } };

  assert.equal(await cloudPeekHasWork({ store, queue }), true);
});

test('cloud peek remains fail closed for unproven or security-significant state errors', async () => {
  const store = { async readSnapshot() { throw new Error('cloud_state_history_fork'); } };
  const queue = { async hasWork() { return false; } };

  await assert.rejects(() => cloudPeekHasWork({ store, queue }), /cloud_state_history_fork/);
});
