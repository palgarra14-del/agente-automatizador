const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_DURATION_MS = 20 * 60 * 1000;

const PARKED_APPROVAL_STATUSES = new Set([
  'awaiting_start_approval',
  'awaiting_workflow_approval'
]);

const HUMAN_GATE_STATUSES = new Set([
  ...PARKED_APPROVAL_STATUSES,
  'execution_deferred',
  'operator_update_pending',
  'operator_revision_check_failed'
]);

function integerInRange(value, fallback, label, min, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label}_invalid`);
  }
  return resolved;
}

function shouldRunAutonomous(queueResult) {
  return !queueResult || PARKED_APPROVAL_STATUSES.has(queueResult.status);
}

export async function runCloudDrain({
  queue,
  autonomousSelfImprovement = null,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  now = () => Date.now()
} = {}) {
  if (!queue ||
      typeof queue.tick !== 'function' ||
      typeof queue.hasWork !== 'function' ||
      typeof queue.ingestAdmissionIntents !== 'function') {
    throw new Error('cloud_drain_queue_invalid');
  }
  if (autonomousSelfImprovement !== null &&
      (typeof autonomousSelfImprovement.tick !== 'function' ||
       typeof autonomousSelfImprovement.hasWork !== 'function')) {
    throw new Error('cloud_drain_autonomous_worker_invalid');
  }
  if (typeof now !== 'function') throw new Error('cloud_drain_clock_invalid');

  const iterationLimit = integerInRange(maxIterations, DEFAULT_MAX_ITERATIONS, 'cloud_drain_max_iterations', 1, 32);
  const durationLimitMs = integerInRange(maxDurationMs, DEFAULT_MAX_DURATION_MS, 'cloud_drain_max_duration', 1_000, 30 * 60 * 1000);
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error('cloud_drain_clock_invalid');
  const deadlineAt = startedAt + durationLimitMs;

  const iterations = [];
  let stopReason = 'iteration_limit';

  for (let index = 0; index < iterationLimit; index += 1) {
    const beforeIteration = now();
    if (!Number.isFinite(beforeIteration)) throw new Error('cloud_drain_clock_invalid');
    if (beforeIteration - startedAt >= durationLimitMs) {
      stopReason = 'duration_limit';
      break;
    }

    const admitted = await queue.ingestAdmissionIntents();
    const queueResult = await queue.tick();

    let autonomousResult = null;
    if (autonomousSelfImprovement && shouldRunAutonomous(queueResult)) {
      const beforeAutonomous = now();
      if (!Number.isFinite(beforeAutonomous)) throw new Error('cloud_drain_clock_invalid');
      if (beforeAutonomous >= deadlineAt) {
        iterations.push({
          index: index + 1,
          admitted: Boolean(admitted),
          queueResult,
          autonomousResult
        });
        stopReason = 'duration_limit';
        break;
      }
      try {
        autonomousResult = await autonomousSelfImprovement.tick({ deadlineCapAt: deadlineAt });
      } catch (error) {
        if (error?.message !== 'workflow_deadline_cap_exceeded') throw error;
        iterations.push({
          index: index + 1,
          admitted: Boolean(admitted),
          queueResult,
          autonomousResult
        });
        stopReason = 'duration_limit';
        break;
      }
    }

    iterations.push({
      index: index + 1,
      admitted: Boolean(admitted),
      queueResult,
      autonomousResult
    });

    if (autonomousResult?.status === 'failed') {
      stopReason = 'autonomous_failure';
      break;
    }

    const humanGate = Boolean(queueResult && HUMAN_GATE_STATUSES.has(queueResult.status));
    const parkedApprovalGate = Boolean(queueResult && PARKED_APPROVAL_STATUSES.has(queueResult.status));
    const autonomousHasWork = autonomousSelfImprovement
      ? await autonomousSelfImprovement.hasWork()
      : false;

    if (humanGate) {
      if (!parkedApprovalGate || !autonomousHasWork) {
        stopReason = 'human_gate';
        break;
      }
      const afterIteration = now();
      if (!Number.isFinite(afterIteration)) throw new Error('cloud_drain_clock_invalid');
      if (afterIteration - startedAt >= durationLimitMs) {
        stopReason = 'duration_limit';
        break;
      }
      continue;
    }

    const queueHasWork = await queue.hasWork();

    if (!queueHasWork && !autonomousHasWork) {
      stopReason = 'idle';
      break;
    }

    const afterIteration = now();
    if (!Number.isFinite(afterIteration)) throw new Error('cloud_drain_clock_invalid');
    if (afterIteration - startedAt >= durationLimitMs) {
      stopReason = 'duration_limit';
      break;
    }
  }

  let remainingWork;
  if (stopReason === 'idle') {
    remainingWork = false;
  } else if (stopReason === 'human_gate' || stopReason === 'autonomous_failure') {
    remainingWork = true;
  } else {
    const queueHasWork = await queue.hasWork();
    const autonomousHasWork = autonomousSelfImprovement
      ? await autonomousSelfImprovement.hasWork()
      : false;
    remainingWork = queueHasWork || autonomousHasWork;
  }

  const finishedAt = now();
  if (!Number.isFinite(finishedAt)) throw new Error('cloud_drain_clock_invalid');

  return {
    version: 1,
    iterations,
    stopReason,
    remainingWork,
    continuationRecommended:
      remainingWork &&
      (stopReason === 'iteration_limit' || stopReason === 'duration_limit'),
    elapsedMs: Math.max(0, finishedAt - startedAt),
    limits: {
      maxIterations: iterationLimit,
      maxDurationMs: durationLimitMs
    }
  };
}

export const CLOUD_DRAIN_DEFAULTS = Object.freeze({
  maxIterations: DEFAULT_MAX_ITERATIONS,
  maxDurationMs: DEFAULT_MAX_DURATION_MS
});
