import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMOUS_CALLFLOW_GOAL,
  AUTONOMOUS_CALLFLOW_SCOPE,
  AUTONOMOUS_LEADFINDER_GOAL,
  AUTONOMOUS_LEADFINDER_SCOPE,
  AutonomousSelfImprovement,
  autonomousPolicyForLane
} from '../../src/self-improvement.js';

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

function terminalPlan(id, projectId, status = 'failed') {
  return {
    id,
    profile: 'autonomous-maintenance',
    projectId,
    status,
    result: { error: 'fixture_stop' },
    steps: []
  };
}

test('commercial cloud lanes expose bounded autonomous policies without website-pilot automation', () => {
  const leadfinder = autonomousPolicyForLane('leadfinder');
  const callflow = autonomousPolicyForLane('callflow');

  assert.equal(leadfinder.projectId, 'leadfinder');
  assert.equal(leadfinder.stateKey, 'autopilotLeadfinderImprovement');
  assert.equal(leadfinder.goal, AUTONOMOUS_LEADFINDER_GOAL);
  assert.deepEqual(leadfinder.scope, AUTONOMOUS_LEADFINDER_SCOPE);
  assert.equal(leadfinder.allowSensitiveImplementation, false);
  assert.ok(leadfinder.scope.allowedPaths.length <= 24);
  assert.ok(leadfinder.scope.allowedPaths.includes('src/services'));
  assert.ok(leadfinder.scope.allowedPaths.includes('src/providers/business-discovery-aggregator.ts'));
  assert.ok(leadfinder.scope.forbiddenPaths.includes('src/app'));
  assert.ok(leadfinder.scope.forbiddenPaths.includes('src/lib/product-access.ts'));

  assert.equal(callflow.projectId, 'callflow');
  assert.equal(callflow.stateKey, 'autopilotCallflowImprovement');
  assert.equal(callflow.goal, AUTONOMOUS_CALLFLOW_GOAL);
  assert.deepEqual(callflow.scope, AUTONOMOUS_CALLFLOW_SCOPE);
  assert.equal(callflow.allowSensitiveImplementation, false);
  assert.ok(callflow.scope.forbiddenPaths.includes('google-apps-script'));
  assert.ok(callflow.scope.forbiddenPaths.includes('api'));

  assert.equal(autonomousPolicyForLane('website-pilot'), null);
  assert.equal(autonomousPolicyForLane('unknown'), null);
});

test('leadfinder autopilot creates a direct autonomous workflow with its own state and scope', async () => {
  const store = fakeStore();
  let created = null;
  const engine = {
    async create(input) {
      created = clone(input);
      return { id: 'workflow-leadfinder' };
    },
    async get() {
      return terminalPlan('workflow-leadfinder', 'leadfinder');
    }
  };
  const policy = autonomousPolicyForLane('leadfinder');
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV,
    projectId: policy.projectId,
    stateKey: policy.stateKey,
    goal: policy.goal,
    scope: policy.scope,
    allowSensitiveImplementation: policy.allowSensitiveImplementation,
    workflowTimeoutMs: 25 * 60_000,
    now: () => Date.parse('2026-09-28T00:00:00Z')
  });

  assert.equal(await autopilot.hasWork(), true);
  const result = await autopilot.tick();
  assert.equal(result.status, 'failed');
  assert.equal(created.profile, 'autonomous-maintenance');
  assert.equal(created.projectId, 'leadfinder');
  assert.equal(created.goal, AUTONOMOUS_LEADFINDER_GOAL);
  assert.deepEqual(created.scope.allowedPaths, [...AUTONOMOUS_LEADFINDER_SCOPE.allowedPaths]);
  assert.ok(created.scope.forbiddenPaths.includes('src/app'));
  assert.ok(store.state.autopilotLeadfinderImprovement);
  assert.equal(store.state.autopilotSelfImprovement, undefined);
});

test('callflow autopilot uses independent state and does not inherit leadfinder history', async () => {
  const store = fakeStore({
    autopilotLeadfinderImprovement: {
      version: 1,
      activeWorkflowId: null,
      activeBaseRevision: null,
      sequence: 2,
      starts: ['2026-09-27T23:50:00.000Z'],
      history: [],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  let created = null;
  const engine = {
    async create(input) {
      created = clone(input);
      return { id: 'workflow-callflow' };
    },
    async get() {
      return terminalPlan('workflow-callflow', 'callflow');
    }
  };
  const policy = autonomousPolicyForLane('callflow');
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV,
    projectId: policy.projectId,
    stateKey: policy.stateKey,
    goal: policy.goal,
    scope: policy.scope,
    allowSensitiveImplementation: policy.allowSensitiveImplementation,
    workflowTimeoutMs: 20 * 60_000,
    now: () => Date.parse('2026-09-28T00:00:00Z')
  });

  assert.equal(await autopilot.hasWork(), true);
  await autopilot.tick();
  assert.equal(created.projectId, 'callflow');
  assert.equal(created.goal, AUTONOMOUS_CALLFLOW_GOAL);
  assert.ok(store.state.autopilotCallflowImprovement);
  assert.equal(store.state.autopilotLeadfinderImprovement.sequence, 2);
});

test('commercial autopilot cancels instead of auto-approving sensitive implementation', async () => {
  const policy = autonomousPolicyForLane('leadfinder');
  const store = fakeStore({
    [policy.stateKey]: {
      version: 1,
      activeWorkflowId: 'workflow-sensitive',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-09-28T00:00:00.000Z'],
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
    projectId: 'leadfinder',
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
          reason: 'sensitive_change:src/services/search-service.ts',
          paths: ['src/services/search-service.ts']
        },
        changeSet: {
          paths: ['src/services/search-service.ts'],
          sensitiveContent: false
        }
      }
    }]
  };
  const engine = {
    async get() { return clone(plan); },
    async approve() {
      approvals += 1;
      throw new Error('commercial sensitive changes must not be auto-approved');
    },
    async cancel(id, options) {
      cancellations += 1;
      assert.equal(options.reason, 'autonomous_maintenance_human_gate_required');
      return terminalPlan(id, 'leadfinder', 'blocked');
    }
  };
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV,
    projectId: policy.projectId,
    stateKey: policy.stateKey,
    goal: policy.goal,
    scope: policy.scope,
    allowSensitiveImplementation: policy.allowSensitiveImplementation,
    now: () => Date.parse('2026-09-28T00:05:00Z')
  });

  const result = await autopilot.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.humanGateStepId, 'implementation');
  assert.equal(approvals, 0);
  assert.equal(cancellations, 1);
});
