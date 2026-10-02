import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveControlHealth,
  laneFromRun,
  summarizeGithubRateLimit,
  summarizeLaneRuns,
  summarizeRunners
} from '../control-center/telemetry.mjs';

const run = (lane, overrides={}) => ({
  databaseId: Math.floor(Math.random()*100000),
  displayTitle: `Agent Cloud Worker (${lane})`,
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-10-02T20:00:00Z',
  updatedAt: '2026-10-02T20:02:00Z',
  url: 'https://example.invalid/run',
  ...overrides
});

test('lane parser accepts only explicit lane-scoped cloud runs', () => {
  assert.equal(laneFromRun(run('callflow')), 'callflow');
  assert.equal(laneFromRun({displayTitle:'Agent Cloud Worker (schedule)'}), null);
  assert.equal(laneFromRun({displayTitle:'Agent Cloud Worker (callflow); rm -rf'}), null);
});

test('lane summary exposes current work, recent reliability and business health', () => {
  const now = Date.parse('2026-10-02T20:10:00Z');
  const summary = summarizeLaneRuns([
    run('callflow'),
    run('leadfinder',{conclusion:'failure'}),
    run('leadfinder',{databaseId:99,createdAt:'2026-10-02T20:03:00Z',updatedAt:'2026-10-02T20:04:00Z'}),
    run('website-pilot',{status:'in_progress',conclusion:null,createdAt:'2026-10-02T20:09:00Z',updatedAt:'2026-10-02T20:09:30Z'})
  ], now);
  assert.equal(summary.lanes.callflow.successRate, 100);
  assert.equal(summary.lanes.leadfinder.successRate, 50);
  assert.equal(summary.lanes.leadfinder.recentFailures, 1);
  assert.equal(summary.lanes['website-pilot'].current.status, 'in_progress');
  assert.equal(summary.business.healthy, 3);
  assert.equal(summary.business.allHealthy, true);
});

test('runner summary reports usable capacity', () => {
  assert.deepEqual(summarizeRunners([
    {id:1,name:'one',status:'online',busy:true,os:'Linux'},
    {id:2,name:'two',status:'online',busy:false,os:'Linux'},
    {id:3,name:'three',status:'offline',busy:false,os:'Linux'}
  ]), {
    total:3, online:2, busy:1, free:1,
    runners:[
      {id:1,name:'one',os:'Linux',status:'online',busy:true},
      {id:2,name:'two',os:'Linux',status:'online',busy:false},
      {id:3,name:'three',os:'Linux',status:'offline',busy:false}
    ]
  });
});

test('rate-limit summary exposes remaining budget and reset', () => {
  const now = Date.parse('2026-10-02T20:00:00Z');
  const reset = Math.floor(now / 1000) + 120;
  const summary = summarizeGithubRateLimit({
    resources:{
      core:{limit:5000,remaining:500,used:4500,reset},
      graphql:{limit:5000,remaining:4000,used:1000,reset}
    }
  }, now);
  assert.equal(summary.core.remainingPercent, 10);
  assert.equal(summary.core.resetInSeconds, 120);
  assert.equal(summary.graphql.remainingPercent, 80);
});

test('control health penalizes real capacity and rate-limit pressure without hiding healthy lanes', () => {
  const health = deriveControlHealth({
    service:{active:true},
    queue:{error:null},
    runnerTelemetry:{online:3,busy:3,free:0},
    rateLimit:{core:{remainingPercent:4}},
    laneTelemetry:{business:{healthy:3}}
  });
  assert.equal(health.score, 75);
  assert.equal(health.state, 'good');
  assert.deepEqual(health.reasons,['runner_capacity_full','github_core_critical']);
});
