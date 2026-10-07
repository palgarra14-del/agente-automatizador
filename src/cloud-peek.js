const POST_REPAIR_TRANSIENT_ERRORS = new Set([
  'cloud_state_conflict',
  'cloud_state_rollback',
  'cloud_state_partial_publication'
]);

export async function cloudPeekHasWork({
  store,
  queue,
  autonomousSelfImprovement = null,
  executionOnly = false
}) {
  if (!store || !queue) throw new Error('cloud_peek_dependencies_required');

  let admissionIntents = null;
  if (typeof queue.pendingAdmissionIntents === 'function') {
    admissionIntents = await queue.pendingAdmissionIntents();
    if (Array.isArray(admissionIntents) && admissionIntents.length > 0) return true;
  }

  let snapshot;
  try {
    snapshot = await store.readSnapshot({ repair: true });
  } catch (error) {
    if (error?.message === 'cloud_state_conflict') return true;
    throw error;
  }

  try {
    const rootState = snapshot?.state ?? null;
    const queueWork = executionOnly
      ? await queue.hasExecutionWork(rootState)
      : await queue.hasWork(rootState, admissionIntents);
    const autonomousWork = autonomousSelfImprovement
      ? await autonomousSelfImprovement.hasWork(rootState)
      : false;
    return Boolean(queueWork || autonomousWork);
  } catch (error) {
    if (POST_REPAIR_TRANSIENT_ERRORS.has(error?.message ?? '')) return true;
    throw error;
  }
}
