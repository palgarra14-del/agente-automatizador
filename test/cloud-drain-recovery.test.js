import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recoverableCloudControlError,
  runCloudDrainWithRecovery
} from '../src/cloud-drain-recovery.js';

function result(stopReason = 'idle') {
  return {
    version: 1,
    iterations: [],
    stopReason,
    remainingWork: false,
    continuationRecommended: false,
    elapsedMs: 1,
    limits: { maxIterations: 8, maxDurationMs: 1_000 }
  };
}

test('recoverable control error classifier is narrow and excludes safety failures', () => {
  assert.equal(recoverableCloudControlError(new Error('cloud_state_generation_election_failed')), true);
  assert.equal(recoverableCloudControlError(new Error('cloud_state_partial_publication')), true);
  assert.equal(recoverableCloudControlError(new Error('cloud_global_lease_busy')), true);
  assert.equal(recoverableCloudControlError(new Error('cloud_state_history_fork')), false);
  assert.equal(recoverableCloudControlError(new Error('cloud_state_snapshot_untrusted')), false);
});

test('drain recovers transient state publication failure and resumes work in-process', async () => {
  let leaseAttempts = 0;
  let repairs = 0;
  const sleeps = [];
  const store = {
    async withGlobalLease(fn) {
      leaseAttempts += 1;
      if (leaseAttempts === 1) throw new Error('cloud_state_partial_publication');
      return fn();
    },
    async readSnapshot(options) {
      assert.deepEqual(options, { repair: true });
      repairs += 1;
      return { generation: 14, authorityGeneration: 14 };
    }
  };

  const output = await runCloudDrainWithRecovery({
    store,
    queue: {},
    retryDelaysMs: [5],
    sleep: async (ms) => sleeps.push(ms),
    drain: async () => result('idle')
  });

  assert.equal(output.stopReason, 'idle');
  assert.equal(leaseAttempts, 2);
  assert.equal(repairs, 1);
  assert.deepEqual(sleeps, [5]);
  assert.deepEqual(output.recovery, [{
    attempt: 1,
    error: 'cloud_state_partial_publication',
    repaired: true,
    repairError: null,
    generation: 14,
    authorityGeneration: 14
  }]);
});

test('lease contention backs off without performing needless ref repair', async () => {
  let leaseAttempts = 0;
  let repairs = 0;
  const store = {
    async withGlobalLease(fn) {
      leaseAttempts += 1;
      if (leaseAttempts === 1) throw new Error('cloud_global_lease_busy');
      return fn();
    },
    async readSnapshot() {
      repairs += 1;
      return {};
    }
  };

  const output = await runCloudDrainWithRecovery({
    store,
    queue: {},
    retryDelaysMs: [1],
    sleep: async () => {},
    drain: async () => result()
  });

  assert.equal(output.stopReason, 'idle');
  assert.equal(leaseAttempts, 2);
  assert.equal(repairs, 0);
});

test('bounded recovery exhaustion recommends a fresh same-lane continuation', async () => {
  let leaseAttempts = 0;
  let repairAttempts = 0;
  const store = {
    async withGlobalLease() {
      leaseAttempts += 1;
      throw new Error('cloud_state_generation_election_failed');
    },
    async readSnapshot() {
      repairAttempts += 1;
      throw new Error('cloud_state_conflict');
    }
  };

  const output = await runCloudDrainWithRecovery({
    store,
    queue: {},
    retryDelaysMs: [1, 1],
    sleep: async () => {},
    drain: async () => result()
  });

  assert.equal(leaseAttempts, 3);
  assert.equal(repairAttempts, 3);
  assert.equal(output.stopReason, 'state_recovery_limit');
  assert.equal(output.remainingWork, true);
  assert.equal(output.continuationRecommended, true);
  assert.equal(output.recovery.length, 3);
});

test('security-significant state failures remain fail closed', async () => {
  const store = {
    async withGlobalLease() {
      throw new Error('cloud_state_history_fork');
    },
    async readSnapshot() {
      throw new Error('must not repair a security failure');
    }
  };

  await assert.rejects(
    () => runCloudDrainWithRecovery({ store, queue: {}, retryDelaysMs: [], sleep: async () => {} }),
    /cloud_state_history_fork/
  );
});

test('non-recoverable repair failure is surfaced immediately', async () => {
  const store = {
    async withGlobalLease() {
      throw new Error('cloud_state_partial_publication');
    },
    async readSnapshot() {
      throw new Error('cloud_state_snapshot_untrusted');
    }
  };

  await assert.rejects(
    () => runCloudDrainWithRecovery({ store, queue: {}, retryDelaysMs: [], sleep: async () => {} }),
    /cloud_state_snapshot_untrusted/
  );
});


test('exhausted bounded GitHub state reads become continuation instead of wedging the lane', async () => {
  let leaseAttempts = 0;
  let repairs = 0;
  const store = {
    async withGlobalLease() {
      leaseAttempts += 1;
      throw new Error('cloud_state_github_request_failed');
    },
    async readSnapshot() {
      repairs += 1;
      throw new Error('cloud_state_github_request_failed');
    }
  };

  const output = await runCloudDrainWithRecovery({
    store,
    queue: {},
    retryDelaysMs: [1],
    sleep: async () => {},
    drain: async () => result()
  });

  assert.equal(leaseAttempts, 2);
  assert.equal(repairs, 2);
  assert.equal(output.stopReason, 'state_recovery_limit');
  assert.equal(output.remainingWork, true);
  assert.equal(output.continuationRecommended, true);
  assert.deepEqual(output.recovery.map((entry) => entry.error), [
    'cloud_state_github_request_failed',
    'cloud_state_github_request_failed'
  ]);
});


test('GitHub state request failure caused by inherited deadline immediately chains continuation', async () => {
  let repairs = 0;
  let sleeps = 0;
  const deadlineError = new Error('workflow_deadline_cap_exceeded');
  const requestError = new Error('cloud_state_github_request_failed', { cause: deadlineError });
  const store = {
    async withGlobalLease() {
      throw requestError;
    },
    async readSnapshot() {
      repairs += 1;
      return {};
    }
  };

  const output = await runCloudDrainWithRecovery({
    store,
    queue: {},
    retryDelaysMs: [1, 1],
    sleep: async () => { sleeps += 1; },
    drain: async () => result()
  });

  assert.equal(repairs, 0);
  assert.equal(sleeps, 0);
  assert.equal(output.stopReason, 'duration_limit');
  assert.equal(output.remainingWork, true);
  assert.equal(output.continuationRecommended, true);
  assert.equal(output.recovery.length, 1);
  assert.equal(output.recovery[0].deadlineExhausted, true);
});
