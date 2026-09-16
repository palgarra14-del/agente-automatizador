import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_MARKER = '<!-- agent-request:v1 -->';
const DEFAULT_CONFIG_PATH = resolve('config/issue-queue.json');
const VALID_LANE_ID = /^[a-z0-9-]{1,80}$/;
const VALID_PROJECT_ID = /^[a-z0-9-]{1,80}$/;

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

export function routeCloudLanes({ eventName, issueBody = '', config } = {}) {
  const { lanes, projectToLane } = trustedRouting(config);
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') return lanes;
  if (!['issues', 'issue_comment'].includes(eventName)) return lanes;
  if (typeof issueBody !== 'string') return lanes;

  const markerIndex = issueBody.indexOf(REQUEST_MARKER);
  if (markerIndex < 0 || issueBody.slice(0, markerIndex).trim()) return lanes;

  let request;
  try {
    request = JSON.parse(issueBody.slice(markerIndex + REQUEST_MARKER.length).trim());
  } catch {
    return lanes;
  }
  const projectId = request?.projectId;
  if (typeof projectId !== 'string') return lanes;
  const lane = projectToLane.get(projectId);
  return lane ? [lane] : lanes;
}

function main() {
  const configPath = process.env.AGENT_CLOUD_ROUTE_CONFIG
    ? resolve(process.env.AGENT_CLOUD_ROUTE_CONFIG)
    : DEFAULT_CONFIG_PATH;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const lanes = routeCloudLanes({
    eventName: process.env.AGENT_CLOUD_EVENT_NAME ?? '',
    issueBody: process.env.AGENT_CLOUD_ISSUE_BODY ?? '',
    config
  });
  process.stdout.write(JSON.stringify(lanes));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
