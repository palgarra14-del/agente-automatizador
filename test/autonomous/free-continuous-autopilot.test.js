import assert from 'node:assert/strict';
import test from 'node:test';
import { AutonomousSelfImprovement } from '../../src/self-improvement.js';

const CURRENT = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function subject(autopilot) {
  const root = { autopilotSelfImprovement: autopilot };
  const store = {
    async load() { return root; },
    async mutate(mutator) { return mutator(root); }
  };
  return new AutonomousSelfImprovement({
    store,
    workflowEngine: {},
    operatorRevision: CURRENT,
    workflowTimeoutMs: 18 * 60 * 1000,
    now: () => NOW
  });
}

function baseState(patch = {}) {
  return {
    version: 1,
    activeWorkflowId: null,
    activeBaseRevision: null,
    sequence: 0,
    starts: [],
    history: [],
    suspendedUntil: null,
    updatedAt: null,
    ...patch
  };
}

test('new operator revision bypasses an old billing suspension but same revision stays suspended', async () => {
  const suspendedUntil = new Date(NOW + 6 * 60 * 60 * 1000).toISOString();

  const stale = subject(baseState({
    suspendedUntil,
    history: [{ baseRevision: OLD, completedAt: new Date(NOW - 1_000).toISOString() }]
  }));
  assert.equal(await stale.hasWork(), true);

  const current = subject(baseState({
    suspendedUntil,
    history: [{ baseRevision: CURRENT, completedAt: new Date(NOW - 1_000).toISOString() }]
  }));
  assert.equal(await current.hasWork(), false);
});

test('self autopilot caps speculative starts at 6 per day and still bypasses the cap for a new operator revision', async () => {
  const starts = Array.from({ length: 6 }, (_, index) =>
    new Date(NOW - (6 - index) * 60 * 60 * 1000 + 1_000).toISOString()
  );
  const lastStart = starts.at(-1);
  const capped = subject(baseState({
    starts,
    history: [{
      baseRevision: CURRENT,
      completedAt: new Date(Date.parse(lastStart) + 1_000).toISOString()
    }]
  }));
  assert.equal(await capped.hasWork(), false);

  const advanced = subject(baseState({
    starts,
    history: [{
      baseRevision: OLD,
      completedAt: new Date(Date.parse(lastStart) + 1_000).toISOString()
    }]
  }));
  assert.equal(await advanced.hasWork(), true);
});
