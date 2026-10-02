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

  if (typeof queue.pendingAdmissionIntents === 'function') {
    const intents = await queue.pendingAdmissionIntents();
    if (Array.isArray(intents) && intents.length > 0) return true;
  }

  try {
    await store.readSnapshot({ repair: true });
  } catch (error) {
    if (error?.message === 'cloud_state_conflict') return true;
    throw error;
  }

  try {
    const queueWork = executionOnly
      ? await queue.hasExecutionWork()
      : await queue.hasWork();
    const autonomousWork = autonomousSelfImprovement
      ? await autonomousSelfImprovement.hasWork()
      : false;
    return Boolean(queueWork || autonomousWork);
  } catch (error) {
    if (POST_REPAIR_TRANSIENT_ERRORS.has(error?.message ?? '')) return true;
    throw error;
  }
}
