import { planWork } from './work-scheduler.js';

const RECOVERABLE = /cloud_state_(conflict|rollback|partial_publication|generation_election_failed|github_request_failed|state_recovery_failed|checkpoint_recovery_failed|witness_recovery_failed)|cloud_global_lease_(busy|lost|release_failed)|workflow_deadline_cap_exceeded|timeout|deadline/i;
const REQUEST_MARKER = '<!-- agent-request:v1 -->';
const HEARTBEAT_LANE_ORDER = Object.freeze(['callflow','leadfinder','website-pilot','self']);

export function heartbeatObservationOrder(lanes = [], operatorLanes = []) {
  const operator = operatorLanes instanceof Set ? operatorLanes : new Set(operatorLanes ?? []);
  const rank = new Map(HEARTBEAT_LANE_ORDER.map((lane, index) => [lane, index]));
  return [...lanes].sort((left, right) =>
    Number(operator.has(right)) - Number(operator.has(left)) ||
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    String(left).localeCompare(String(right))
  );
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
  if (observation.observationSkipped === true) {
    return { lane, state:'deferred', runnable:false, reason:'observation_budget', operatorRequested };
  }
  if (observation.active) return { lane, state:'running', runnable:false, reason:'already_active', operatorRequested };
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
