import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { routeCloudLanes } from '../scripts/cloud-lane-route.js';

const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
const queueConfig = JSON.parse(readFileSync(new URL('../config/issue-queue.json', import.meta.url), 'utf8'));

test('routing activates exactly self, website-pilot, leadfinder and callflow as cloud-owned lanes', () => {
  assert.equal(Array.isArray(queueConfig.cloudLanes), true);
  assert.deepEqual(queueConfig.cloudLanes, [
    {
      id: 'self',
      projectIds: ['self'],
      tag: 'agent-cloud-state-v1',
      statePath: '.agent/cloud-state.json'
    },
    {
      id: 'website-pilot',
      projectIds: ['website-pilot'],
      tag: 'agent-cloud-state-website-pilot-v1',
      statePath: '.agent/cloud-state-website-pilot.json'
    },
    {
      id: 'leadfinder',
      projectIds: ['leadfinder'],
      tag: 'agent-cloud-state-leadfinder-v1',
      statePath: '.agent/cloud-state-leadfinder.json'
    },
    {
      id: 'callflow',
      projectIds: ['callflow'],
      tag: 'agent-cloud-state-callflow-v1',
      statePath: '.agent/cloud-state-callflow.json'
    }
  ]);
  assert.equal(Object.hasOwn(queueConfig, 'cloudProjectIds'), false);
  assert.equal(new Set(queueConfig.cloudLanes.flatMap((lane) => lane.projectIds)).size, 4);
  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.tag)).size, 4);
  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.statePath)).size, 4);
});

test('cloud-once resolves an explicit configured lane and binds state plus queue ownership to it', () => {
  assert.match(cli, /const requestedLaneId = take\('--lane'\) \?\? 'self'/);
  assert.match(cli, /queueConfig\.cloudLanes\.find\(\(lane\) => lane\.id === requestedLaneId\)/);
  assert.match(cli, /laneId: cloudLane\.id/);
  assert.match(cli, /allowedProjectIds: cloudLane\.projectIds/);
  assert.match(cli, /tag: cloudLane\.tag/);
  assert.match(cli, /statePath: cloudLane\.statePath/);
  assert.match(cli, /includedProjectIds: cloudAction \? cloudLane\.projectIds : null/);
  assert.match(cli, /excludedProjectIds: cloudAction \? \[\] : queueConfig\.cloudProjectIds/);
  assert.match(cli, /Cloud inbox lane is not configured/);
});


test('scheduled watchdogs route exactly one lane at staggered quarter-hour offsets', () => {
  const schedules = new Map([
    ['2 * * * *', 'self'],
    ['17 * * * *', 'website-pilot'],
    ['32 * * * *', 'leadfinder'],
    ['47 * * * *', 'callflow']
  ]);
  for (const [schedule, expectedLane] of schedules) {
    assert.deepEqual(routeCloudLanes({
      eventName: 'schedule',
      schedule,
      config: queueConfig
    }), [expectedLane]);
  }
  assert.throws(
    () => routeCloudLanes({ eventName: 'schedule', schedule: '0 * * * *', config: queueConfig }),
    /cloud_lane_route_schedule_invalid/
  );
});

test('lane-specific continuations remain immediate and bypass watchdog staggering', () => {
  assert.deepEqual(routeCloudLanes({
    eventName: 'workflow_dispatch',
    requestedLane: 'callflow',
    config: queueConfig
  }), ['callflow']);
});
