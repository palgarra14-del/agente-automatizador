const KNOWN_LANES = Object.freeze(['callflow','leadfinder','website-pilot','self']);
const BUSINESS_LANES = new Set(['callflow','leadfinder','website-pilot']);

export function laneFromRun(run) {
  const title = String(run?.displayTitle || run?.name || '');
  const match = /^Agent Cloud Worker \((callflow|leadfinder|website-pilot|self)\)$/.exec(title);
  return match ? match[1] : null;
}

function completedSuccess(run) {
  return run?.status === 'completed' && run?.conclusion === 'success';
}

function completedFailure(run) {
  return run?.status === 'completed' && ['failure','cancelled','timed_out','action_required'].includes(String(run?.conclusion || ''));
}

function durationMs(run) {
  const start = Date.parse(run?.createdAt || '');
  const end = Date.parse(run?.updatedAt || '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function summarizeLaneRuns(runs = [], nowMs = Date.now()) {
  const byLane = new Map(KNOWN_LANES.map((lane) => [lane, []]));
  for (const run of runs) {
    const lane = laneFromRun(run);
    if (lane) byLane.get(lane).push(run);
  }

  const lanes = {};
  for (const lane of KNOWN_LANES) {
    const recent = byLane.get(lane)
      .slice()
      .sort((a,b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
      .slice(0, 10);
    const completed = recent.filter((run) => run.status === 'completed');
    const successes = completed.filter(completedSuccess);
    const failures = completed.filter(completedFailure);
    const current = recent.find((run) => run.status !== 'completed') || null;
    const latest = recent[0] || null;
    const lastSuccess = recent.find(completedSuccess) || null;
    const lastFailure = recent.find(completedFailure) || null;
    const successRate = completed.length ? Math.round((successes.length / completed.length) * 100) : null;
    const lastSuccessAgeMs = lastSuccess ? Math.max(0, nowMs - Date.parse(lastSuccess.updatedAt || lastSuccess.createdAt || '')) : null;
    const durations = successes.map(durationMs).filter(Number.isFinite);
    const avgSuccessDurationMs = durations.length
      ? Math.round(durations.reduce((sum,value) => sum + value, 0) / durations.length)
      : null;

    lanes[lane] = {
      lane,
      business: BUSINESS_LANES.has(lane),
      current: current ? {
        id: current.databaseId,
        status: current.status,
        conclusion: current.conclusion || null,
        createdAt: current.createdAt || null,
        updatedAt: current.updatedAt || null,
        url: current.url || null
      } : null,
      latest: latest ? {
        id: latest.databaseId,
        status: latest.status,
        conclusion: latest.conclusion || null,
        createdAt: latest.createdAt || null,
        updatedAt: latest.updatedAt || null,
        url: latest.url || null
      } : null,
      recentCompleted: completed.length,
      recentSuccesses: successes.length,
      recentFailures: failures.length,
      successRate,
      lastSuccessAt: lastSuccess?.updatedAt || lastSuccess?.createdAt || null,
      lastSuccessAgeMs,
      lastFailureAt: lastFailure?.updatedAt || lastFailure?.createdAt || null,
      lastFailureConclusion: lastFailure?.conclusion || null,
      avgSuccessDurationMs
    };
  }

  const business = [...BUSINESS_LANES].map((lane) => lanes[lane]);
  const healthyBusiness = business.filter((item) =>
    item.current || (item.lastSuccessAgeMs !== null && item.lastSuccessAgeMs <= 20 * 60 * 1000)
  ).length;
  return {
    lanes,
    business: {
      healthy: healthyBusiness,
      total: business.length,
      allHealthy: healthyBusiness === business.length
    }
  };
}

export function summarizeRunners(runners = []) {
  const normalized = runners.map((runner) => {
    const labels = Array.isArray(runner.labels)
      ? runner.labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean)
      : [];
    return {
      id: runner.id ?? null,
      name: String(runner.name || ''),
      os: runner.os || null,
      status: runner.status || 'unknown',
      busy: runner.busy === true,
      labels,
      role: labels.includes('agent-local') ? 'msi-heavy' : labels.includes('agent-lite') ? 'auxiliary' : 'other'
    };
  });
  const online = normalized.filter((runner) => runner.status === 'online');
  const busy = online.filter((runner) => runner.busy);
  const msi = normalized.filter((runner) => runner.role === 'msi-heavy');
  const msiOnline = msi.filter((runner) => runner.status === 'online');
  const msiBusy = msiOnline.filter((runner) => runner.busy);
  const auxiliary = normalized.filter((runner) => runner.role === 'auxiliary');
  return {
    total: normalized.length,
    online: online.length,
    busy: busy.length,
    free: Math.max(0, online.length - busy.length),
    msiTotal: msi.length,
    msiOnline: msiOnline.length,
    msiBusy: msiBusy.length,
    msiFree: Math.max(0, msiOnline.length - msiBusy.length),
    auxiliaryOnline: auxiliary.filter((runner) => runner.status === 'online').length,
    runners: normalized
  };
}

function oneRateLimit(value, nowMs) {
  if (!value || typeof value !== 'object') return null;
  const limit = Number(value.limit);
  const remaining = Number(value.remaining);
  const resetSeconds = Number(value.reset);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return {
    limit,
    remaining: Math.max(0, remaining),
    used: Number.isFinite(Number(value.used)) ? Number(value.used) : Math.max(0, limit - remaining),
    remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))),
    resetAt: Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000).toISOString() : null,
    resetInSeconds: Number.isFinite(resetSeconds) ? Math.max(0, Math.ceil(resetSeconds - nowMs / 1000)) : null
  };
}

export function summarizeGithubRateLimit(payload = {}, nowMs = Date.now()) {
  const resources = payload.resources || payload;
  return {
    core: oneRateLimit(resources.core, nowMs),
    graphql: oneRateLimit(resources.graphql, nowMs)
  };
}

export function deriveControlHealth({service, queue, runnerTelemetry, rateLimit, laneTelemetry} = {}) {
  let score = 100;
  const reasons = [];
  if (!service?.active) { score -= 45; reasons.push('service_offline'); }
  if (queue?.error) { score -= 20; reasons.push('queue_unavailable'); }
  const msiTotal = Number(runnerTelemetry?.msiTotal);
  const msiOnline = Number(runnerTelemetry?.msiOnline);
  const msiFree = Number(runnerTelemetry?.msiFree);
  if (Number.isFinite(msiTotal) && msiTotal > 0) {
    if (msiOnline === 0) {
      score -= 40;
      reasons.push('msi_runners_offline');
    } else if (msiOnline < msiTotal) {
      score -= Math.min(24, (msiTotal - msiOnline) * 8);
      reasons.push('msi_runner_capacity_degraded');
    }
    if (msiOnline > 0 && msiFree === 0) {
      score -= 5;
      reasons.push('msi_runner_capacity_full');
    }
  } else if (runnerTelemetry?.online === 0) {
    score -= 35;
    reasons.push('runners_offline');
  } else if (runnerTelemetry && runnerTelemetry.free === 0) {
    score -= 5;
    reasons.push('runner_capacity_full');
  }
  const corePct = rateLimit?.core?.remainingPercent;
  if (Number.isFinite(corePct) && corePct <= 5) { score -= 20; reasons.push('github_core_critical'); }
  else if (Number.isFinite(corePct) && corePct <= 15) { score -= 10; reasons.push('github_core_low'); }
  const healthyBusiness = laneTelemetry?.business?.healthy;
  if (Number.isFinite(healthyBusiness) && healthyBusiness < 3) {
    score -= (3 - healthyBusiness) * 8;
    reasons.push('business_lane_stale');
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    state: score >= 90 ? 'strong' : score >= 75 ? 'good' : score >= 55 ? 'degraded' : 'critical',
    reasons
  };
}
