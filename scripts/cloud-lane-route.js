import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOperatorControl, globalPauseEnabled, parsePausedLanes } from '../src/operator-control.js';

const REQUEST_MARKER = '<!-- agent-request:v1 -->';
const DEFAULT_CONFIG_PATH = resolve('config/issue-queue.json');
const VALID_LANE_ID = /^[a-z0-9-]{1,80}$/;
const VALID_PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const SCHEDULE_LANES = Object.freeze({
  '2 * * * *': 'self',
  '17 * * * *': 'website-pilot',
  '32 * * * *': 'leadfinder',
  '47 * * * *': 'callflow'
});

function trustedRouting(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.cloudLanes) || config.cloudLanes.length < 1 || config.cloudLanes.length > 20) {
    throw new Error('cloud_lane_route_config_invalid');
  }
  const laneIds = new Set();
  const projectToLane = new Map();
  for (const lane of config.cloudLanes) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane) || !VALID_LANE_ID.test(lane.id ?? '') || !Array.isArray(lane.projectIds) || lane.projectIds.length < 1 || lane.projectIds.length > 20) {
      throw new Error('cloud_lane_route_config_invalid');
    }
    if (laneIds.has(lane.id)) throw new Error('cloud_lane_route_duplicate_lane');
    laneIds.add(lane.id);
    for (const projectId of lane.projectIds) {
      if (!VALID_PROJECT_ID.test(projectId ?? '')) throw new Error('cloud_lane_route_project_invalid');
      if (projectToLane.has(projectId)) throw new Error('cloud_lane_route_project_overlap');
      projectToLane.set(projectId, lane.id);
    }
  }
  return { lanes: [...laneIds], projectToLane };
}

export function routeCloudLanes({
  eventName,
  eventAction = '',
  issueBody = '',
  requestedLane = '',
  schedule = '',
  config,
  globalPause = false,
  pausedLanes = ''
} = {}) {
  const { lanes, projectToLane } = trustedRouting(config);
  const controlled = (selected) => applyOperatorControl(selected, {
    globalPause: globalPauseEnabled(globalPause),
    pausedLanes: parsePausedLanes(pausedLanes, lanes)
  });
  if (eventName === 'workflow_dispatch' && requestedLane) {
    if (!VALID_LANE_ID.test(requestedLane) || !lanes.includes(requestedLane)) {
      throw new Error('cloud_lane_route_requested_lane_invalid');
    }
    return controlled([requestedLane]);
  }
  if (eventName === 'schedule') {
    const lane = SCHEDULE_LANES[schedule];
    if (!lane || !lanes.includes(lane)) throw new Error('cloud_lane_route_schedule_invalid');
    return controlled([lane]);
  }
  if (eventName === 'workflow_dispatch') return controlled(lanes);
  if (eventName === 'push') return [];
  if (!['issues', 'issue_comment'].includes(eventName)) return controlled(lanes);
  if (eventName === 'issues' && eventAction !== 'opened') return controlled(lanes);
  if (typeof issueBody !== 'string') return controlled(lanes);

  const markerIndex = issueBody.indexOf(REQUEST_MARKER);
  if (markerIndex < 0 || issueBody.slice(0, markerIndex).trim()) return controlled(lanes);

  let request;
  try {
    request = JSON.parse(issueBody.slice(markerIndex + REQUEST_MARKER.length).trim());
  } catch {
    return controlled(lanes);
  }
  const projectId = request?.projectId;
  if (typeof projectId !== 'string') return controlled(lanes);
  const lane = projectToLane.get(projectId);
  return controlled(lane ? [lane] : lanes);
}

function main() {
  const configPath = process.env.AGENT_CLOUD_ROUTE_CONFIG
    ? resolve(process.env.AGENT_CLOUD_ROUTE_CONFIG)
    : DEFAULT_CONFIG_PATH;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const lanes = routeCloudLanes({
    eventName: process.env.AGENT_CLOUD_EVENT_NAME ?? '',
    eventAction: process.env.AGENT_CLOUD_EVENT_ACTION ?? '',
    issueBody: process.env.AGENT_CLOUD_ISSUE_BODY ?? '',
    requestedLane: process.env.AGENT_CLOUD_REQUESTED_LANE ?? '',
    schedule: process.env.AGENT_CLOUD_SCHEDULE ?? '',
    globalPause: process.env.AGENT_GLOBAL_PAUSE ?? '',
    pausedLanes: process.env.AGENT_PAUSED_LANES ?? '',
    config
  });
  process.stdout.write(JSON.stringify(lanes));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
