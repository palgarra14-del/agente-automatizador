import assert from 'node:assert/strict';
import test from 'node:test';
import { AutonomousProjectImprovement, AutonomousSelfImprovement } from '../../src/self-improvement.js';

const CURRENT = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function subject(autopilot, projectId = 'self') {
  const stateKey = projectId === 'self' ? 'autopilotSelfImprovement' : 'autopilotProjectImprovement';
  const root = { [stateKey]: autopilot };
  const store = {
    async load() { return root; },
    async mutate(mutator) { return mutator(root); }
  };
  const Constructor = projectId === 'self' ? AutonomousSelfImprovement : AutonomousProjectImprovement;
  return new Constructor({
    store,
    workflowEngine: {},
    operatorRevision: CURRENT,
    projectId,
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

test('self autopilot allows up to 6 autonomous filler starts per day and still fails closed at the cap', async () => {
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
  // A new revision must not reset an exhausted rolling daily start budget.
  assert.equal(await advanced.hasWork(), false);
});


test('business-lane autopilots allow up to 12 autonomous filler starts per day', async () => {
  const starts = Array.from({ length: 12 }, (_, index) =>
    new Date(NOW - (12 - index) * 60 * 60 * 1000 + 1_000).toISOString()
  );
  for (const projectId of ['leadfinder', 'callflow', 'website-pilot']) {
    const capped = subject(baseState({ starts }), projectId);
    assert.equal(await capped.hasWork(), false, `${projectId} should stop at 12 starts`);
  }
});
