import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMOUS_PROJECT_POLICIES,
  AutonomousProjectImprovement
} from '../src/self-improvement.js';

const REV = 'a'.repeat(40);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeStore(initial = {}) {
  const state = clone(initial);
  return {
    state,
    async load() { return clone(state); },
    async mutate(fn) {
      const result = await fn(state);
      return clone(result);
    }
  };
}

function completedPlan(projectId, id = 'workflow-project-1') {
  return {
    id,
    profile: 'autonomous-maintenance',
    projectId,
    status: 'completed',
    result: null,
    steps: [
      {
        id: 'implementation',
        status: 'completed',
        evidence: { changeSet: { paths: ['src/example.ts'] } }
      },
      {
        id: 'publication',
        status: 'completed',
        evidence: { pullRequest: { number: 10, url: 'https://example.invalid/pr/10' } }
      }
    ]
  };
}

test('every business lane has an explicit bounded autonomous policy', () => {
  assert.deepEqual(Object.keys(AUTONOMOUS_PROJECT_POLICIES).sort(), [
    'callflow',
    'leadfinder',
    'self',
    'website-pilot'
  ]);
  for (const [projectId, policy] of Object.entries(AUTONOMOUS_PROJECT_POLICIES)) {
    assert.ok(policy.goal.length > 80, projectId);
    assert.ok(policy.scope.allowedPaths.length > 0, projectId);
    assert.ok(policy.scope.forbiddenPaths.length > 0, projectId);
    assert.equal(policy.maxStartsPer24h, projectId === 'self' ? 6 : 12);
  }
  assert.equal(AUTONOMOUS_PROJECT_POLICIES.callflow.scope.forbiddenPaths.includes('google-apps-script'), true);
  assert.equal(AUTONOMOUS_PROJECT_POLICIES.leadfinder.scope.forbiddenPaths.includes('.github'), true);
  assert.equal(AUTONOMOUS_PROJECT_POLICIES['website-pilot'].scope.forbiddenPaths.includes('vercel.json'), true);
});

test('external project autopilot creates a project-bound autonomous workflow and chains after success', async () => {
  const store = fakeStore();
  let created = null;
  const engine = {
    async create(input) {
      created = clone(input);
      return { id: 'workflow-project-1' };
    },
    async get(id) {
      assert.equal(id, 'workflow-project-1');
      return completedPlan('leadfinder', id);
    }
  };
  const now = Date.parse('2026-09-29T22:00:00Z');
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV,
    projectId: 'leadfinder',
    workflowTimeoutMs: 25 * 60_000,
    now: () => now
  });

  assert.equal(await autopilot.hasWork(), true);
  const result = await autopilot.tick();
  assert.equal(result.status, 'completed');
  assert.equal(created.profile, 'autonomous-maintenance');
  assert.equal(created.projectId, 'leadfinder');
  assert.deepEqual(created.scope.allowedPaths, [...AUTONOMOUS_PROJECT_POLICIES.leadfinder.scope.allowedPaths]);
  assert.match(created.goal, /qualified lead throughput/i);
  assert.equal(store.state.autopilotProjectImprovement.history.at(-1).pullRequestNumber, 10);
  assert.equal(store.state.autopilotSelfImprovement, undefined);
  assert.equal(await autopilot.hasWork(), true);
});

test('external autopilot never auto-approves sensitive implementation changes', async () => {
  const store = fakeStore({
    autopilotProjectImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-sensitive',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-09-29T22:00:00.000Z'],
      history: [],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  let approvals = 0;
  let cancellations = 0;
  const plan = {
    id: 'workflow-sensitive',
    profile: 'autonomous-maintenance',
    projectId: 'callflow',
    status: 'awaiting_approval',
    result: null,
    steps: [{
      id: 'implementation',
      status: 'awaiting_approval',
      error: 'workflow_sensitive_change_requires_approval',
      evidence: {
        changeSetFingerprint: 'd'.repeat(64),
        changePolicy: {
          ok: true,
          classification: 'sensitive',
          reason: 'sensitive_change:src/example.js',
          paths: ['app.js']
        },
        changeSet: { paths: ['app.js'], sensitiveContent: false }
      }
    }]
  };
  const engine = {
    async get() { return clone(plan); },
    async approve() {
      approvals += 1;
      throw new Error('external sensitive changes must not auto-approve');
    },
    async cancel(id, options) {
      cancellations += 1;
      assert.equal(id, 'workflow-sensitive');
      assert.equal(options.reason, 'autonomous_maintenance_human_gate_required');
      return {
        id,
        profile: 'autonomous-maintenance',
        projectId: 'callflow',
        status: 'blocked',
        result: { error: options.reason },
        steps: []
      };
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV,
    projectId: 'callflow',
    now: () => Date.parse('2026-09-29T22:05:00Z')
  });

  const result = await autopilot.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.humanGateStepId, 'implementation');
  assert.equal(approvals, 0);
  assert.equal(cancellations, 1);
});
