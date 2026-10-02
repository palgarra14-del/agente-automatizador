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

test('runner summary separates MSI heavy capacity from auxiliary runners', () => {
  assert.deepEqual(summarizeRunners([
    {id:1,name:'MSI-WSL-agent',status:'online',busy:true,os:'Linux',labels:[{name:'agent-local'}]},
    {id:2,name:'MSI-WSL-agent-2',status:'online',busy:false,os:'Linux',labels:[{name:'agent-local'}]},
    {id:3,name:'MSI-WSL-agent-3',status:'offline',busy:false,os:'Linux',labels:[{name:'agent-local'}]},
    {id:4,name:'ASUS-LITE-01',status:'online',busy:false,os:'Windows',labels:[{name:'agent-lite'}]}
  ]), {
    total:4, online:3, busy:1, free:2,
    msiTotal:3, msiOnline:2, msiBusy:1, msiFree:1, auxiliaryOnline:1,
    runners:[
      {id:1,name:'MSI-WSL-agent',os:'Linux',status:'online',busy:true,labels:['agent-local'],role:'msi-heavy'},
      {id:2,name:'MSI-WSL-agent-2',os:'Linux',status:'online',busy:false,labels:['agent-local'],role:'msi-heavy'},
      {id:3,name:'MSI-WSL-agent-3',os:'Linux',status:'offline',busy:false,labels:['agent-local'],role:'msi-heavy'},
      {id:4,name:'ASUS-LITE-01',os:'Windows',status:'online',busy:false,labels:['agent-lite'],role:'auxiliary'}
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

test('control health scores MSI heavy capacity instead of being masked by an auxiliary runner', () => {
  const health = deriveControlHealth({
    service:{active:true},
    queue:{error:null},
    runnerTelemetry:{online:1,busy:0,free:1,msiTotal:3,msiOnline:0,msiBusy:0,msiFree:0,auxiliaryOnline:1},
    rateLimit:{core:{remainingPercent:80}},
    laneTelemetry:{business:{healthy:3}}
  });
  assert.equal(health.score, 60);
  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.reasons,['msi_runners_offline']);
});

test('control health reports partial MSI degradation and full heavy-capacity use', () => {
  const health = deriveControlHealth({
    service:{active:true},
    queue:{error:null},
    runnerTelemetry:{online:3,busy:2,free:1,msiTotal:3,msiOnline:2,msiBusy:2,msiFree:0,auxiliaryOnline:1},
    rateLimit:{core:{remainingPercent:4}},
    laneTelemetry:{business:{healthy:3}}
  });
  assert.equal(health.score, 67);
  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.reasons,['msi_runner_capacity_degraded','msi_runner_capacity_full','github_core_critical']);
});
