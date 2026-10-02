export function summarizeDesignLab(source = {}, nowMs = Date.now()) {
  const serviceState = String(source.serviceState || 'unknown');
  const timerState = String(source.timerState || 'unknown');
  const latest = source.latest && typeof source.latest === 'object' ? source.latest : {};
  const route = latest.route && typeof latest.route === 'object' ? latest.route : {};
  const qa = latest.qa && typeof latest.qa === 'object' ? latest.qa : {};
  const result = latest.result && typeof latest.result === 'object' ? latest.result : null;
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const deferredReason = String(latest.deferredReason || '').trim() || null;
  const quotaEpoch = Number(source.quotaNotBeforeEpoch);
  const quotaActive = Number.isFinite(quotaEpoch) && quotaEpoch * 1000 > nowMs;

  let state = 'idle';
  if (serviceState === 'active' || serviceState === 'activating') state = 'running';
  else if (result) state = result.error ? 'failed' : 'completed';
  else if (deferredReason) state = 'review_deferred';
  else if (latest.name && qa.pass === true) state = 'qa_ready';
  else if (latest.name) state = 'incomplete';

  return {
    state,
    serviceState,
    timerActive: timerState === 'active',
    latestRun: latest.name || null,
    business: latest.brief?.business || result?.business || null,
    category: latest.brief?.category || result?.category || null,
    provider: route.provider || null,
    model: route.model || null,
    emergencyRenderer: route.emergencyRenderer === true,
    qaPass: qa.pass === true ? true : qa.pass === false ? false : null,
    defectCount: Array.isArray(qa.defects) ? qa.defects.length : null,
    deferredReason,
    reviewAuthority: result?.reviewAuthority || null,
    officialTrainingEvidence: result?.officialTrainingEvidence === true,
    completedRuns: Number.isFinite(Number(summary.completedRuns)) ? Number(summary.completedRuns) : null,
    weakestDimension: summary.weakestDimension || null,
    qaPassRate: Number.isFinite(Number(summary.qaPassRate)) ? Number(summary.qaPassRate) : null,
    quotaActive,
    quotaNotBefore: quotaActive ? new Date(quotaEpoch * 1000).toISOString() : null,
    quotaRetryInSeconds: quotaActive ? Math.max(0, Math.ceil(quotaEpoch - nowMs / 1000)) : 0
  };
}
