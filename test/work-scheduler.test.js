import assert from 'node:assert/strict';
import test from 'node:test';
import { planWork, rankWork, schedulingPolicySnapshot } from '../src/work-scheduler.js';

test('operator work outranks business and autonomous maintenance', () => {
  const ranked = rankWork([
    { id:'self-1', lane:'self', createdAt:'2026-09-30T10:00:00Z' },
    { id:'lead-1', lane:'leadfinder', createdAt:'2026-09-30T10:01:00Z' },
    { id:'mobile-1', lane:'website-pilot', source:'mobile', createdAt:'2026-09-30T10:02:00Z' }
  ]);
  assert.deepEqual(ranked.map((item) => item.id), ['mobile-1', 'lead-1', 'self-1']);
});

test('scheduler reserves capacity so self cannot crowd out business', () => {
  const result = planWork([
    { id:'self-1', lane:'self' },
    { id:'self-2', lane:'self' },
    { id:'lead-1', lane:'leadfinder' },
    { id:'call-1', lane:'callflow' },
    { id:'web-1', lane:'website-pilot' }
  ]);
  assert.deepEqual(result.selected.map((item) => item.id), ['call-1', 'lead-1', 'self-1']);
  assert.equal(result.deferred.find(({item}) => item.id === 'self-2').reason, 'global_capacity');
  assert.equal(result.deferred.find(({item}) => item.id === 'web-1').reason, 'business_capacity');
});

test('human-gated work is parked while independent work advances', () => {
  const result = planWork([
    { id:'call-gated', lane:'callflow', source:'mobile', humanGate:true },
    { id:'lead-free', lane:'leadfinder' },
    { id:'self-free', lane:'self' }
  ]);
  assert.deepEqual(result.selected.map((item) => item.id), ['lead-free', 'self-free']);
  assert.equal(result.deferred[0].reason, 'human_gate');
});

test('operator work recommends safe yield from running self work when capacity is full', () => {
  const result = planWork([
    { id:'operator-fix', lane:'callflow', source:'mobile' }
  ], {
    running: [
      { id:'self-running', lane:'self' },
      { id:'lead-running', lane:'leadfinder' },
      { id:'web-running', lane:'website-pilot' }
    ]
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.deferred[0].reason, 'global_capacity');
  assert.deepEqual(result.yieldCandidates, [{
    id:'self-running',
    lane:'self',
    reason:'yield_at_next_safe_checkpoint_for_operator_work'
  }]);
});

test('lightweight tasks do not consume heavy concurrency slots', () => {
  const result = planWork([
    { id:'status', lane:'self', heavy:false },
    { id:'call', lane:'callflow' }
  ], {
    running:[
      { id:'lead-running', lane:'leadfinder' },
      { id:'web-running', lane:'website-pilot' },
      { id:'self-running', lane:'self' }
    ]
  });
  assert.deepEqual(result.selected.map((item) => item.id), ['status']);
});

test('policy snapshot documents the sustainable scheduling contract', () => {
  const policy = schedulingPolicySnapshot();
  assert.equal(policy.version, 1);
  assert.ok(policy.principles.includes('business throughput outranks self-improvement'));
});
