import { planWork } from './work-scheduler.js';

const RECOVERABLE = /cloud_state_(conflict|rollback|partial_publication|generation_election_failed|github_request_failed|state_recovery_failed|checkpoint_recovery_failed|witness_recovery_failed)|cloud_global_lease_(busy|lost|release_failed)|workflow_deadline_cap_exceeded|timeout|deadline/i;
const REQUEST_MARKER = '<!-- agent-request:v1 -->';
const HEARTBEAT_LANE_ORDER = Object.freeze(['callflow','leadfinder','website-pilot','self']);
const HEARTBEAT_EXECUTION_MODES = new Set(['cloud','local-primary']);
const CONTROL_AUTH_UNAVAILABLE = /github_cli_auth_required|GitHub issue queue request failed: (?:401|403)|bad credentials|requires authentication|token[^\n]{0,80}invalid/i;

export function heartbeatExecutionMode(value = 'cloud') {
  const mode = String(value || 'cloud').trim().toLowerCase();
  if (!HEARTBEAT_EXECUTION_MODES.has(mode)) throw new Error('heartbeat_execution_mode_invalid');
  return mode;
}

export function heartbeatControlAuthUnavailable(error) {
  return CONTROL_AUTH_UNAVAILABLE.test(String(error ?? ''));
}

export function localCloudUnitName(lane) {
  const value = String(lane ?? '');
  if (!/^[a-z0-9-]{1,80}$/.test(value)) throw new Error('heartbeat_lane_invalid');
  return `agent-local-cloud-${value}`;
}

export function heartbeatObservationOrder(lanes = [], operatorLanes = [], rotation = 0) {
  const operator = operatorLanes instanceof Set ? operatorLanes : new Set(operatorLanes ?? []);
  const rank = new Map(HEARTBEAT_LANE_ORDER.map((lane, index) => [lane, index]));
  const ordered = [...lanes].sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    String(left).localeCompare(String(right))
  );
  const operatorFirst = ordered.filter((lane) => operator.has(lane));
  const ordinary = ordered.filter((lane) => !operator.has(lane));
  const self = ordinary.filter((lane) => lane === 'self');
  const business = ordinary.filter((lane) => lane !== 'self');
  const numericRotation = Number.isFinite(Number(rotation)) ? Math.trunc(Number(rotation)) : 0;
  const offset = business.length
    ? ((numericRotation % business.length) + business.length) % business.length
    : 0;
  return [
    ...operatorFirst,
    ...business.slice(offset),
    ...business.slice(0, offset),
    ...self
  ];
}

export function heartbeatRunLane(run, lanes = []) {
  if (run?.event !== 'workflow_dispatch') return null;
  const match = /^Agent Cloud Worker \(([a-z0-9-]{1,80})\)$/.exec(String(run?.displayTitle ?? ''));
  if (!match) return null;
  return new Set((lanes ?? []).map(String)).has(match[1]) ? match[1] : null;
}

export function operatorRequestedLanes(issues = [], config = {}) {
  const allowedActors = new Set((config.allowedActors ?? []).map(String));
  const projectToLane = new Map();
  for (const lane of config.cloudLanes ?? []) {
    if (!lane?.id || !Array.isArray(lane.projectIds)) continue;
    for (const projectId of lane.projectIds) projectToLane.set(projectId, lane.id);
  }

  const lanes = new Set();
  for (const issue of issues) {
    if (!allowedActors.has(issue?.author?.login)) continue;
    const body = typeof issue?.body === 'string' ? issue.body : '';
    if (!body || body.length > 128 * 1024) continue;
    const markerAt = body.indexOf(REQUEST_MARKER);
    if (markerAt < 0) continue;
    let request;
    try {
      request = JSON.parse(body.slice(markerAt + REQUEST_MARKER.length).trim());
    } catch {
      continue;
    }
    if (request?.version !== 1 || typeof request?.projectId !== 'string') continue;
    const lane = projectToLane.get(request.projectId);
    if (lane) lanes.add(lane);
  }
  return [...lanes].sort();
}

export function classifyLaneObservation(observation) {
  const lane = observation?.lane;
  if (!lane) throw new Error('lane_observation_invalid');
  const operatorRequested = observation.operatorRequested === true;
  if (observation.active) return { lane, state:'running', runnable:false, reason:'already_active', operatorRequested };
  if (observation.rateLimitCooldown === true) {
    return { lane, state:'deferred', runnable:false, reason:'rate_limit_cooldown', operatorRequested };
  }
  if (observation.controlUnavailable === true) {
    return { lane, state:'deferred', runnable:false, reason:'local_control_auth_unavailable', operatorRequested };
  }
  if (observation.observationSkipped === true) {
    return { lane, state:'deferred', runnable:false, reason:'observation_budget', operatorRequested };
  }
  if (observation.hasWork === true) return { lane, state:'pending', runnable:true, reason:'work_detected', operatorRequested };
  if (observation.error && RECOVERABLE.test(String(observation.error))) {
    return { lane, state:'recovery', runnable:true, reason:'recoverable_control_error', operatorRequested };
  }
  if (observation.error) return { lane, state:'blocked', runnable:false, reason:'non_recoverable_control_error', operatorRequested };
  return { lane, state:'idle', runnable:false, reason:'idle', operatorRequested };
}

export function planHeartbeat(observations = [], limits = {}) {
  const classified = observations.map(classifyLaneObservation);
  const running = classified
    .filter((item) => item.state === 'running')
    .map((item) => ({
      id:`running:${item.lane}`,
      lane:item.lane,
      source:item.operatorRequested ? 'operator' : (item.lane === 'self' ? 'autonomous' : 'business'),
      operatorRequested:item.operatorRequested
    }));
  const pending = classified
    .filter((item) => item.runnable)
    .map((item) => ({
      id:`${item.state}:${item.lane}`,
      lane:item.lane,
      source:item.operatorRequested ? 'operator' : (item.lane === 'self' ? 'autonomous' : 'business'),
      operatorRequested:item.operatorRequested,
      reliability:item.state === 'recovery'
    }));
  const plan = planWork(pending, { running, ...limits });
  return {
    version:1,
    classified,
    running,
    dispatch:plan.selected.map((item) => ({
      lane:item.lane,
      priority:item.band,
      reason:classified.find((entry) => entry.lane === item.lane)?.reason ?? 'scheduled'
    })),
    deferred:plan.deferred.map(({item,reason}) => ({lane:item.lane,priority:item.band,reason})),
    yieldCandidates:plan.yieldCandidates
  };
}
