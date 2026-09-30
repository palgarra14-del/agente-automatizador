import { runCloudDrain } from './cloud-drain.js';

const RECOVERABLE_CONTROL_ERRORS = new Set([
  'cloud_state_conflict',
  'cloud_state_rollback',
  'cloud_state_partial_publication',
  'cloud_state_generation_election_failed',
  'cloud_state_github_request_failed',
  'cloud_state_state_recovery_failed',
  'cloud_state_checkpoint_recovery_failed',
  'cloud_state_witness_recovery_failed',
  'cloud_global_lease_busy',
  'cloud_global_lease_lost',
  'cloud_global_lease_release_failed'
]);

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);

export function recoverableCloudControlError(error) {
  return RECOVERABLE_CONTROL_ERRORS.has(String(error?.message ?? ''));
}

function causedByWorkflowDeadline(error) {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current?.message === 'workflow_deadline_cap_exceeded') return true;
    current = current?.cause ?? null;
  }
  return false;
}

export async function runCloudDrainWithRecovery({
  store,
  queue,
  autonomousSelfImprovement = null,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  drain = runCloudDrain,
  drainOptions = {}
} = {}) {
  if (!store || typeof store.withGlobalLease !== 'function' || typeof store.readSnapshot !== 'function') {
    throw new Error('cloud_drain_recovery_store_invalid');
  }
  if (!queue) throw new Error('cloud_drain_recovery_queue_invalid');
  if (!Array.isArray(retryDelaysMs) ||
      retryDelaysMs.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 30_000)) {
    throw new Error('cloud_drain_recovery_delays_invalid');
  }
  if (typeof sleep !== 'function' || typeof drain !== 'function') {
    throw new Error('cloud_drain_recovery_dependency_invalid');
  }

  const startedAt = Date.now();
  const recovery = [];

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const result = await store.withGlobalLease(() => drain({
        queue,
        autonomousSelfImprovement,
        ...drainOptions
      }));
      return {
        ...result,
        recovery
      };
    } catch (error) {
      if (!recoverableCloudControlError(error)) throw error;

      const deadlineExhausted = causedByWorkflowDeadline(error);
      const evidence = {
        attempt: attempt + 1,
        error: error.message,
        repaired: false,
        repairError: null,
        generation: null,
        authorityGeneration: null,
        ...(deadlineExhausted ? { deadlineExhausted: true } : {})
      };

      if (deadlineExhausted) {
        recovery.push(evidence);
        return {
          version: 1,
          iterations: [],
          stopReason: 'duration_limit',
          remainingWork: true,
          continuationRecommended: true,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          limits: {
            recoveryAttempts: attempt + 1
          },
          recovery
        };
      }

      if (error.message !== 'cloud_global_lease_busy') {
        try {
          const snapshot = await store.readSnapshot({ repair: true });
          evidence.repaired = true;
          evidence.generation = snapshot?.generation ?? null;
          evidence.authorityGeneration = snapshot?.authorityGeneration ?? null;
        } catch (repairError) {
          if (!recoverableCloudControlError(repairError)) throw repairError;
          evidence.repairError = repairError.message;
        }
      }

      recovery.push(evidence);

      if (attempt >= retryDelaysMs.length) {
        return {
          version: 1,
          iterations: [],
          stopReason: 'state_recovery_limit',
          remainingWork: true,
          continuationRecommended: true,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          limits: {
            recoveryAttempts: retryDelaysMs.length + 1
          },
          recovery
        };
      }

      await sleep(retryDelaysMs[attempt]);
    }
  }

  throw new Error('cloud_drain_recovery_unreachable');
}

export const CLOUD_DRAIN_RECOVERY_DEFAULTS = Object.freeze({
  retryDelaysMs: DEFAULT_RETRY_DELAYS_MS
});
