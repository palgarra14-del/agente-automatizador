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

test('scheduler gives all heavy capacity to runnable business before self', () => {
  const result = planWork([
    { id:'self-1', lane:'self' },
    { id:'self-2', lane:'self' },
    { id:'lead-1', lane:'leadfinder' },
    { id:'call-1', lane:'callflow' },
    { id:'web-1', lane:'website-pilot' }
  ]);
  assert.deepEqual(result.selected.map((item) => item.id), ['call-1', 'lead-1', 'web-1']);
  assert.equal(result.deferred.find(({item}) => item.id === 'self-1').reason, 'global_capacity');
  assert.equal(result.deferred.find(({item}) => item.id === 'self-2').reason, 'global_capacity');
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

test('business work recommends safe yield from running self work when all runners are occupied', () => {
  const result = planWork([
    { id:'call-waiting', lane:'callflow' }
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
    reason:'yield_at_next_safe_checkpoint_for_business_work'
  }]);
});

test('self still uses a genuinely spare runner when fewer than three business lanes are runnable', () => {
  const result = planWork([
    { id:'lead-1', lane:'leadfinder' },
    { id:'call-1', lane:'callflow' },
    { id:'self-1', lane:'self' }
  ]);
  assert.deepEqual(result.selected.map((item) => item.id), ['call-1', 'lead-1', 'self-1']);
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


test('scheduler exposes the autoranking used at each dispatch boundary', () => {
  const result = planWork([
    { id:'self-rank', lane:'self', businessImpact:20 },
    { id:'lead-rank', lane:'leadfinder', businessImpact:5 },
    { id:'call-rank', lane:'callflow', urgency:10 }
  ], { maxHeavy:1, maxBusinessHeavy:1, maxSelfHeavy:1 });

  assert.deepEqual(result.ranking.map((item) => ({
    rank:item.rank,
    id:item.id,
    lane:item.lane
  })), [
    { rank:1, id:'call-rank', lane:'callflow' },
    { rank:2, id:'lead-rank', lane:'leadfinder' },
    { rank:3, id:'self-rank', lane:'self' }
  ]);
  assert.ok(result.ranking[0].score > result.ranking[1].score);
  assert.deepEqual(result.selected.map((item) => item.id), ['call-rank']);
});

test('policy snapshot documents the sustainable scheduling contract', () => {
  const policy = schedulingPolicySnapshot();
  assert.equal(policy.version, 1);
  assert.ok(policy.principles.includes('runnable work is re-ranked from current evidence at every dispatch boundary'));
  assert.ok(policy.principles.includes('business throughput outranks self-improvement'));
  assert.ok(policy.principles.includes('self-improvement consumes only spare capacity after runnable business work'));
});
