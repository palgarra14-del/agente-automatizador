import { planWork } from './work-scheduler.js';

const RECOVERABLE = /cloud_state_(conflict|rollback|partial_publication|generation_election_failed|github_request_failed|state_recovery_failed|checkpoint_recovery_failed|witness_recovery_failed)|cloud_global_lease_(busy|lost|release_failed)|workflow_deadline_cap_exceeded|timeout|deadline/i;

export function classifyLaneObservation(observation) {
  const lane = observation?.lane;
  if (!lane) throw new Error('lane_observation_invalid');
  if (observation.active) return { lane, state:'running', runnable:false, reason:'already_active' };
  if (observation.hasWork === true) return { lane, state:'pending', runnable:true, reason:'work_detected' };
  if (observation.error && RECOVERABLE.test(String(observation.error))) {
    return { lane, state:'recovery', runnable:true, reason:'recoverable_control_error' };
  }
  if (observation.error) return { lane, state:'blocked', runnable:false, reason:'non_recoverable_control_error' };
  return { lane, state:'idle', runnable:false, reason:'idle' };
}

export function planHeartbeat(observations = [], limits = {}) {
  const classified = observations.map(classifyLaneObservation);
  const running = classified
    .filter((item) => item.state === 'running')
    .map((item) => ({
      id:`running:${item.lane}`,
      lane:item.lane,
      source:item.lane === 'self' ? 'autonomous' : 'business'
    }));
  const pending = classified
    .filter((item) => item.runnable)
    .map((item) => ({
      id:`${item.state}:${item.lane}`,
      lane:item.lane,
      source:item.lane === 'self' ? 'autonomous' : 'business',
      reliability:item.state === 'recovery'
    }));
  const plan = planWork(pending, { running, ...limits });
  return {
    version:1,
    classified,
    running,
    dispatch:plan.selected.map((item) => ({
      lane:item.lane,
      reason:classified.find((entry) => entry.lane === item.lane)?.reason ?? 'scheduled'
    })),
    deferred:plan.deferred.map(({item,reason}) => ({lane:item.lane,reason})),
    yieldCandidates:plan.yieldCandidates
  };
}
