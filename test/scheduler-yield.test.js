import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  clearSchedulerYield,
  requestSchedulerYield,
  schedulerYieldRequested,
  syncSchedulerYieldRequests
} from '../src/scheduler-yield.js';

test('scheduler yield request is bounded, durable and expires automatically', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scheduler-yield-'));
  const now = Date.parse('2026-09-30T20:00:00Z');
  const payload = await requestSchedulerYield('self', {
    stateDir,
    ttlMs: 60_000,
    now: () => now,
    reason: 'operator_work_waiting'
  });
  assert.equal(payload.lane, 'self');
  assert.equal(await schedulerYieldRequested('self', { stateDir, now: () => now + 30_000 }), true);
  assert.equal(await schedulerYieldRequested('self', { stateDir, now: () => now + 61_000 }), false);
});

test('sync requests yield only for selected lanes and clears stale lane requests', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scheduler-yield-sync-'));
  const now = Date.parse('2026-09-30T20:00:00Z');
  await requestSchedulerYield('website-pilot', { stateDir, now: () => now });
  const requested = await syncSchedulerYieldRequests(
    ['self','website-pilot','leadfinder'],
    [{lane:'self',reason:'yield_at_next_safe_checkpoint_for_operator_work'}],
    {stateDir, now: () => now}
  );
  assert.deepEqual(requested,['self']);
  assert.equal(await schedulerYieldRequested('self', {stateDir,now:()=>now}), true);
  assert.equal(await schedulerYieldRequested('website-pilot', {stateDir,now:()=>now}), false);
  assert.equal(await schedulerYieldRequested('leadfinder', {stateDir,now:()=>now}), false);
});

test('malformed yield markers fail safe instead of forcing a lane to stop', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scheduler-yield-bad-'));
  await requestSchedulerYield('self', { stateDir });
  const target = join(stateDir, 'yield-self.json');
  const original = await readFile(target, 'utf8');
  assert.match(original, /"version":1/);
  await clearSchedulerYield('self', {stateDir});
  assert.equal(await schedulerYieldRequested('self', {stateDir}), false);
});

test('scheduler yield rejects untrusted lane identifiers and unbounded ttl', async () => {
  await assert.rejects(() => requestSchedulerYield('../self'), /lane_invalid/);
  await assert.rejects(() => requestSchedulerYield('self',{ttlMs:60*60*1000+1}), /ttl_invalid/);
});
