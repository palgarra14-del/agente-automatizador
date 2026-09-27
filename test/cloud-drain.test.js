import assert from 'node:assert/strict';
import test from 'node:test';
import { runCloudDrain } from '../src/cloud-drain.js';

function scriptedQueue(results, { admissions = [] } = {}) {
  let tickIndex = 0;
  let admissionIndex = 0;
  const calls = { tick: 0, hasWork: 0, ingest: 0 };
  return {
    calls,
    async ingestAdmissionIntents() {
      calls.ingest += 1;
      return admissions[admissionIndex++] ?? null;
    },
    async tick() {
      calls.tick += 1;
      return tickIndex < results.length ? results[tickIndex++] : null;
    },
    async hasWork() {
      calls.hasWork += 1;
      return tickIndex < results.length;
    }
  };
}

test('cloud drain keeps advancing governed queue work until the lane is idle', async () => {
  const queue = scriptedQueue([
    { status: 'running', issueNumber: 1 },
    { status: 'completed', issueNumber: 1 },
    { status: null, issueNumber: null }
  ], { admissions: [{ issueNumber: 1 }, null, null] });
  let clock = 1_000;
  const result = await runCloudDrain({
    queue,
    now: () => clock += 10
  });

  assert.equal(result.stopReason, 'idle');
  assert.equal(result.iterations.length, 3);
  assert.equal(result.remainingWork, false);
  assert.equal(result.continuationRecommended, false);
  assert.deepEqual(result.iterations.map((item) => item.queueResult?.status ?? null), ['running', 'completed', null]);
  assert.deepEqual(result.iterations.map((item) => item.admitted), [true, false, false]);
  assert.equal(queue.calls.tick, 3);
  assert.equal(queue.calls.ingest, 3);
});

test('cloud drain stops immediately at a human queue gate instead of spinning', async () => {
  const queue = scriptedQueue([{ status: 'awaiting_workflow_approval', issueNumber: 9 }]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      return { status: 'idle' };
    },
    async hasWork() {
      return false;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'human_gate');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(autonomousCalls, 1);
  assert.equal(queue.calls.hasWork, 0);
});

test('parked human approvals do not stall independent autonomous maintenance', async () => {
  const queue = scriptedQueue([
    { status: 'awaiting_workflow_approval', issueNumber: 9 },
    { status: 'awaiting_workflow_approval', issueNumber: 9 }
  ]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      return { status: autonomousCalls < 2 ? 'running' : 'completed' };
    },
    async hasWork() {
      return autonomousCalls < 2;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'human_gate');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(autonomousCalls, 2);
  assert.equal(queue.calls.tick, 2);
  assert.equal(queue.calls.hasWork, 0);
});

test('operator update pending parks governed work but keeps autonomous maintenance productive', async () => {
  const queue = scriptedQueue([
    { status: 'operator_update_pending', issueNumber: 290 },
    { status: 'operator_update_pending', issueNumber: 290 }
  ]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      return { status: autonomousCalls < 2 ? 'running' : 'completed' };
    },
    async hasWork() {
      return autonomousCalls < 2;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'human_gate');
  assert.equal(result.iterations.length, 2);
  assert.deepEqual(
    result.iterations.map((item) => item.queueResult.status),
    ['operator_update_pending', 'operator_update_pending']
  );
  assert.equal(autonomousCalls, 2);
  assert.equal(queue.calls.tick, 2);
  assert.equal(queue.calls.hasWork, 0);
});

test('operator update pending still stops when no independent autonomous work exists', async () => {
  const queue = scriptedQueue([{ status: 'operator_update_pending', issueNumber: 290 }]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      return { status: 'idle' };
    },
    async hasWork() {
      return false;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'human_gate');
  assert.equal(result.iterations.length, 1);
  assert.equal(autonomousCalls, 1);
  assert.equal(queue.calls.tick, 1);
  assert.equal(queue.calls.hasWork, 0);
});

test('operator safety gates remain fail closed even when autonomous maintenance is available', async () => {
  const queue = scriptedQueue([{ status: 'operator_revision_check_failed', issueNumber: 11 }]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      return { status: 'running' };
    },
    async hasWork() {
      return true;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'human_gate');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(autonomousCalls, 0);
  assert.equal(queue.calls.tick, 1);
});

test('cloud drain obeys its hard iteration budget even when work remains', async () => {
  const queue = scriptedQueue([
    { status: 'running', issueNumber: 1 },
    { status: 'running', issueNumber: 1 },
    { status: 'running', issueNumber: 1 }
  ]);
  const result = await runCloudDrain({
    queue,
    maxIterations: 2
  });

  assert.equal(result.stopReason, 'iteration_limit');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, true);
  assert.equal(queue.calls.tick, 2);
});

test('cloud drain stops before starting another iteration after the duration guard is reached', async () => {
  const queue = scriptedQueue([
    { status: 'running', issueNumber: 1 },
    { status: 'running', issueNumber: 1 }
  ]);
  const times = [0, 0, 1_200, 1_200, 1_200];
  const result = await runCloudDrain({
    queue,
    maxDurationMs: 1_000,
    now: () => times.shift() ?? 1_200
  });

  assert.equal(result.stopReason, 'duration_limit');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, true);
  assert.equal(queue.calls.tick, 1);
});

test('cloud drain never converts a failed autonomous iteration into idle success', async () => {
  const queue = scriptedQueue([null]);
  const autonomousSelfImprovement = {
    async tick() {
      return {
        status: 'failed',
        error: 'workflow_budget_deadline_exceeded',
        workflowId: 'workflow-deadline'
      };
    },
    async hasWork() {
      return false;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'autonomous_failure');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].autonomousResult.status, 'failed');
  assert.equal(result.iterations[0].autonomousResult.error, 'workflow_budget_deadline_exceeded');
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(queue.calls.hasWork, 0);
});
