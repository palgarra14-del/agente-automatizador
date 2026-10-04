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
  assert.equal(queue.calls.tick, 0);
});

test('cloud drain passes its absolute deadline into governed queue work', async () => {
  let observed = null;
  const queue = {
    async ingestAdmissionIntents() { return null; },
    async tick(options) {
      observed = options;
      return null;
    },
    async hasWork() { return false; }
  };

  const result = await runCloudDrain({
    queue,
    maxDurationMs: 5_000,
    now: () => 1_000
  });

  assert.deepEqual(observed, { deadlineCapAt: 6_000 });
  assert.equal(result.stopReason, 'idle');
  assert.equal(result.remainingWork, false);
});

test('cloud drain turns a governed queue deadline exhaustion into continuation', async () => {
  const queue = {
    async ingestAdmissionIntents() { return null; },
    async tick() { throw new Error('workflow_deadline_cap_exceeded'); },
    async hasWork() { return true; }
  };

  const result = await runCloudDrain({
    queue,
    maxDurationMs: 5_000,
    now: () => 1_000
  });

  assert.equal(result.stopReason, 'duration_limit');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].queueResult, null);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, true);
});

test('cloud drain keeps iterating after a failed autonomous cycle when intelligence has recovery work', async () => {
  const queue = scriptedQueue([null, null]);
  let autonomousCalls = 0;
  const autonomousSelfImprovement = {
    async tick() {
      autonomousCalls += 1;
      if (autonomousCalls === 1) {
        return {
          status: 'failed',
          error: 'workflow_budget_deadline_exceeded',
          workflowId: 'workflow-deadline'
        };
      }
      return {
        status: 'completed',
        error: null,
        workflowId: 'workflow-recovery'
      };
    },
    async hasWork() {
      return autonomousCalls < 2;
    }
  };

  const result = await runCloudDrain({ queue, autonomousSelfImprovement });

  assert.equal(result.stopReason, 'idle');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].autonomousResult.status, 'failed');
  assert.equal(result.iterations[1].autonomousResult.status, 'completed');
  assert.equal(result.remainingWork, false);
  assert.equal(result.continuationRecommended, false);
  assert.equal(autonomousCalls, 2);
});

test('cloud drain passes its absolute deadline into autonomous maintenance', async () => {
  const queue = scriptedQueue([null]);
  let observed = null;
  const autonomousSelfImprovement = {
    async tick(options) {
      observed = options;
      return { status: 'idle', workflowId: null };
    },
    async hasWork() {
      return false;
    }
  };

  const result = await runCloudDrain({
    queue,
    autonomousSelfImprovement,
    maxDurationMs: 5_000,
    now: () => 1_000
  });

  assert.deepEqual(observed, { deadlineCapAt: 6_000 });
  assert.equal(result.stopReason, 'idle');
  assert.equal(result.remainingWork, false);
});

test('cloud drain turns an exhausted inherited workflow deadline into continuation', async () => {
  const queue = scriptedQueue([null]);
  const autonomousSelfImprovement = {
    async tick() {
      throw new Error('workflow_deadline_cap_exceeded');
    },
    async hasWork() {
      return true;
    }
  };

  const result = await runCloudDrain({
    queue,
    autonomousSelfImprovement,
    maxDurationMs: 5_000,
    now: () => 1_000
  });

  assert.equal(result.stopReason, 'duration_limit');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].autonomousResult, null);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, true);
});


test('cloud drain surfaces an autonomous failure after bounded recovery is exhausted', async () => {
  const queue = scriptedQueue([null]);
  const autonomousSelfImprovement = {
    async tick() {
      return {
        status: 'failed',
        error: 'workflow_budget_deadline_exceeded',
        workflowId: 'workflow-terminal-failure'
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
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
});


test('cloud drain yields only at an iteration boundary and preserves pending work', async () => {
  const queue = scriptedQueue([
    { status: 'running', issueNumber: 21 },
    { status: 'completed', issueNumber: 21 }
  ]);
  let checks = 0;
  const result = await runCloudDrain({
    queue,
    shouldYield: async () => {
      checks += 1;
      return checks >= 2;
    }
  });

  assert.equal(result.stopReason, 'scheduler_yield');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].queueResult.status, 'running');
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(queue.calls.tick, 1);
  assert.equal(queue.calls.ingest, 1);
});

test('cloud drain can yield before any work starts when higher-priority capacity is waiting', async () => {
  const queue = scriptedQueue([{ status: 'running', issueNumber: 22 }]);
  const result = await runCloudDrain({
    queue,
    shouldYield: async () => true
  });

  assert.equal(result.stopReason, 'scheduler_yield');
  assert.equal(result.iterations.length, 0);
  assert.equal(result.remainingWork, true);
  assert.equal(result.continuationRecommended, false);
  assert.equal(queue.calls.tick, 0);
  assert.equal(queue.calls.ingest, 0);
});
