import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMOUS_MAINTENANCE_GOAL,
  AUTONOMOUS_MAINTENANCE_SCOPE,
  AutonomousSelfImprovement,
  autonomousSensitiveImplementationAllowed
} from '../src/self-improvement.js';

const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);

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

function pendingPlan(id = 'workflow-auto-1') {
  return {
    id,
    profile: 'autonomous-maintenance',
    projectId: 'self',
    status: 'pending',
    result: null,
    steps: [
      { id: 'implementation', status: 'pending' },
      { id: 'review', status: 'pending' },
      { id: 'release-readiness', status: 'pending' },
      { id: 'publication', status: 'pending', evidence: null }
    ]
  };
}

function releaseWaiting(id = 'workflow-auto-1') {
  return {
    ...pendingPlan(id),
    status: 'awaiting_approval',
    steps: [
      { id: 'implementation', status: 'completed' },
      { id: 'review', status: 'completed' },
      { id: 'release-readiness', status: 'awaiting_approval' },
      { id: 'publication', status: 'pending', evidence: null }
    ]
  };
}

function sensitiveImplementation({ reason = 'sensitive_change:src/core.js', paths = ['src/core.js'], sensitiveContent = false } = {}) {
  return {
    id: 'implementation',
    status: 'awaiting_approval',
    error: 'workflow_sensitive_change_requires_approval',
    evidence: {
      changeSetFingerprint: 'd'.repeat(64),
      changePolicy: { ok: true, classification: 'sensitive', reason, paths },
      changeSet: { paths, sensitiveContent }
    }
  };
}

test('autopilot creates one bounded autonomous workflow and records a reviewed PR without merge authority', async () => {
  const store = fakeStore();
  let plan = null;
  const calls = { create: [], run: [], approve: [] };
  const engine = {
    async create(input) {
      calls.create.push(clone(input));
      plan = pendingPlan();
      return clone(plan);
    },
    async get(id) {
      assert.equal(id, plan.id);
      return clone(plan);
    },
    async approve(id, stepId, options) {
      calls.approve.push({ id, stepId, options: clone(options) });
      assert.equal(stepId, 'release-readiness');
      plan = {
        ...plan,
        status: 'pending',
        steps: plan.steps.map((step) => step.id === stepId ? { ...step, status: 'completed' } : step)
      };
      return clone(plan);
    },
    async run(id) {
      calls.run.push(id);
      if (calls.run.length === 1) {
        plan = releaseWaiting(id);
        return clone(plan);
      }
      plan = {
        ...plan,
        status: 'completed',
        steps: plan.steps.map((step) => step.id === 'publication'
          ? {
              ...step,
              status: 'completed',
              evidence: {
                pullRequest: { number: 231, url: 'https://github.com/example/repo/pull/231' },
                commit: { finalHead: 'c'.repeat(40) }
              }
            }
          : step)
      };
      return clone(plan);
    }
  };
  const now = Date.parse('2026-09-23T00:00:00Z');
  const autopilot = new AutonomousSelfImprovement({ store, workflowEngine: engine, operatorRevision: REV_A, now: () => now });

  assert.equal(await autopilot.hasWork(), true);
  const result = await autopilot.tick();
  assert.equal(result.status, 'completed');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].profile, 'autonomous-maintenance');
  assert.equal(calls.create[0].projectId, 'self');
  assert.equal(calls.create[0].goal, AUTONOMOUS_MAINTENANCE_GOAL);
  assert.deepEqual(calls.create[0].scope.allowedPaths, [...AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths]);
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('.github'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('config'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('package.json'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('src/self-improvement.js'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('src/core.js'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('src/cloud-state.js'));
  assert.deepEqual(calls.create[0].scope.allowedPaths, ['src', 'test/autonomous']);
  assert.equal(calls.approve.length, 1);
  assert.equal(calls.approve[0].stepId, 'release-readiness');
  assert.match(calls.approve[0].options.externalApprovalFingerprint, /^[a-f0-9]{64}$/);

  const persisted = store.state.autopilotSelfImprovement;
  assert.equal(persisted.activeWorkflowId, null);
  assert.equal(persisted.history.at(-1).pullRequestNumber, 231);
  assert.equal(persisted.history.at(-1).baseRevision, REV_A);
  assert.equal(await autopilot.hasWork(), false);
});

test('bounded src/test sensitivity can be auto-approved only from exact governed evidence', async () => {
  const safe = sensitiveImplementation({
    paths: ['src/recovery.js', 'test/autonomous/recovery.test.js'],
    reason: 'sensitive_change:src/recovery.js'
  });
  assert.equal(autonomousSensitiveImplementationAllowed(safe), true);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    sensitiveContent: true,
    reason: 'sensitive_change:security_or_auth_content'
  })), false);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    paths: ['src/recovery.js', 'config/projects.json'],
    reason: 'sensitive_change:src/recovery.js'
  })), false);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    paths: ['package.json'],
    reason: 'sensitive_change:package.json'
  })), false);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    paths: ['src/core.js'],
    reason: 'sensitive_change:src/core.js'
  })), false);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    paths: ['test/existing.test.js'],
    reason: 'sensitive_change:src/recovery.js'
  })), false);
  const mismatched = sensitiveImplementation({
    paths: ['src/recovery.js'],
    reason: 'sensitive_change:src/recovery.js'
  });
  mismatched.evidence.changeSet.paths = ['src/other.js'];
  assert.equal(autonomousSensitiveImplementationAllowed(mismatched), false);
  assert.equal(autonomousSensitiveImplementationAllowed(sensitiveImplementation({
    paths: ['src/../config/projects.json'],
    reason: 'sensitive_change:src/../config/projects.json'
  })), false);
});

test('autopilot may approve an exact bounded src implementation but never auth/security content', async () => {
  const initial = {
    version: 1,
    activeWorkflowId: 'workflow-sensitive',
    activeBaseRevision: REV_A,
    sequence: 1,
    starts: ['2026-09-23T00:00:00.000Z'],
    history: [],
    waitingForMerge: null,
    suspendedUntil: null,
    updatedAt: null
  };
  const store = fakeStore({ autopilotSelfImprovement: initial });
  let plan = {
    id: 'workflow-sensitive',
    profile: 'autonomous-maintenance',
    projectId: 'self',
    status: 'awaiting_approval',
    result: null,
    steps: [sensitiveImplementation({ paths: ['src/recovery.js', 'test/autonomous/recovery.test.js'], reason: 'sensitive_change:src/recovery.js' })]
  };
  const approvals = [];
  const engine = {
    async get() { return clone(plan); },
    async approve(id, stepId, options) {
      approvals.push({ id, stepId, options: clone(options) });
      plan = { ...plan, status: 'blocked', result: { error: 'fixture_stop' }, steps: plan.steps.map((step) => ({ ...step, status: 'completed' })) };
      return clone(plan);
    },
    async run() { throw new Error('terminal approval result should settle before run'); }
  };
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV_A,
    now: () => Date.parse('2026-09-23T00:10:00Z')
  });
  const result = await autopilot.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].stepId, 'implementation');
  assert.match(approvals[0].options.externalApprovalFingerprint, /^[a-f0-9]{64}$/);

  const blockedStore = fakeStore({ autopilotSelfImprovement: initial });
  let blockedApprovals = 0;
  let cancellations = 0;
  const blockedEngine = {
    async get() {
      return {
        id: 'workflow-sensitive',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'awaiting_approval',
        result: null,
        steps: [sensitiveImplementation({
          sensitiveContent: true,
          reason: 'sensitive_change:security_or_auth_content'
        })]
      };
    },
    async approve() { blockedApprovals += 1; throw new Error('must not approve auth/security changes'); },
    async run() { throw new Error('must not run while human approval is required'); },
    async cancel(id, options) {
      cancellations += 1;
      assert.equal(id, 'workflow-sensitive');
      assert.equal(options.reason, 'autonomous_maintenance_human_gate_required');
      return {
        id,
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'blocked',
        result: { error: options.reason },
        steps: []
      };
    }
  };
  const blockedAutopilot = new AutonomousSelfImprovement({
    store: blockedStore,
    workflowEngine: blockedEngine,
    operatorRevision: REV_A,
    now: () => Date.parse('2026-09-23T00:10:00Z')
  });
  const blocked = await blockedAutopilot.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.humanGateStepId, 'implementation');
  assert.equal(blockedApprovals, 0);
  assert.equal(cancellations, 1);
  assert.equal(blockedStore.state.autopilotSelfImprovement.activeWorkflowId, null);
});

test('completed autonomous PRs do not halt the loop and their files are excluded from later cycles', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: null,
      activeBaseRevision: null,
      sequence: 1,
      starts: ['2026-09-23T10:00:00.000Z'],
      history: [{
        workflowId: 'workflow-old',
        status: 'completed',
        error: null,
        changedPaths: ['src/runtime.js', 'test/autonomous/runtime.test.js'],
        pullRequestNumber: 200,
        pullRequestUrl: 'https://github.com/example/repo/pull/200',
        finalHead: 'c'.repeat(40),
        baseRevision: REV_A,
        completedAt: '2026-09-23T10:20:00.000Z'
      }],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  let createdInput = null;
  const engine = {
    async create(input) {
      createdInput = clone(input);
      return { id: 'workflow-new' };
    },
    async get() {
      return {
        id: 'workflow-new',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'failed',
        result: { error: 'fixture_stop' },
        steps: []
      };
    }
  };
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV_A,
    now: () => now
  });

  assert.equal(await autopilot.hasWork(), true);
  const result = await autopilot.tick();
  assert.equal(result.status, 'failed');
  assert.ok(createdInput.scope.forbiddenPaths.includes('src/runtime.js'));
  assert.ok(createdInput.scope.forbiddenPaths.includes('test/autonomous/runtime.test.js'));
  assert.match(createdInput.goal, /Do not revisit these files/);
  assert.match(createdInput.goal, /src\/runtime\.js/);
  assert.equal(createdInput.scope.forbiddenPaths.includes('src/core.js'), true);
});

test('autopilot enforces cooldown and a hard daily start budget', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const recentStarts = [
    '2026-09-23T02:00:00.000Z',
    '2026-09-23T04:00:00.000Z',
    '2026-09-23T06:00:00.000Z',
    '2026-09-23T08:00:00.000Z'
  ];
  const budgetStore = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: null,
      activeBaseRevision: null,
      sequence: 4,
      starts: recentStarts,
      history: [],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  const noCreate = { async create() { throw new Error('daily budget must block creation'); } };
  const budgeted = new AutonomousSelfImprovement({ store: budgetStore, workflowEngine: noCreate, operatorRevision: REV_A, now: () => now });
  assert.equal(await budgeted.hasWork(), false);
  assert.equal((await budgeted.tick()).status, 'idle');

  const cooldownStore = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: null,
      activeBaseRevision: null,
      sequence: 1,
      starts: ['2026-09-23T11:45:00.000Z'],
      history: [],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  const cooling = new AutonomousSelfImprovement({ store: cooldownStore, workflowEngine: noCreate, operatorRevision: REV_A, now: () => now });
  assert.equal(await cooling.hasWork(), false);
  assert.equal((await cooling.tick()).status, 'idle');
});

test('completed failed cycle can retry immediately after authoritative main advances', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const state = {
    version: 1,
    activeWorkflowId: null,
    activeBaseRevision: null,
    sequence: 1,
    starts: ['2026-09-23T11:50:00.000Z'],
    history: [{
      workflowId: 'workflow-old',
      status: 'failed',
      error: 'read_only_repository_context_failed',
      changedPaths: [],
      pullRequestNumber: null,
      pullRequestUrl: null,
      finalHead: null,
      baseRevision: REV_A,
      completedAt: '2026-09-23T11:55:00.000Z'
    }],
    suspendedUntil: null,
    updatedAt: null
  };

  const sameRevision = new AutonomousSelfImprovement({
    store: fakeStore({ autopilotSelfImprovement: state }),
    workflowEngine: { async create() { throw new Error('same revision must remain cooled down'); } },
    operatorRevision: REV_A,
    now: () => now
  });
  assert.equal(await sameRevision.hasWork(), false);

  let creates = 0;
  const advancedStore = fakeStore({ autopilotSelfImprovement: state });
  const advancedRevision = new AutonomousSelfImprovement({
    store: advancedStore,
    workflowEngine: {
      async create() {
        creates += 1;
        return { id: 'workflow-new' };
      },
      async get() {
        return {
          id: 'workflow-new',
          profile: 'autonomous-maintenance',
          projectId: 'self',
          status: 'failed',
          result: { error: 'fixture_stop' },
          steps: []
        };
      }
    },
    operatorRevision: REV_B,
    now: () => now
  });
  assert.equal(await advancedRevision.hasWork(), true);
  assert.equal((await advancedRevision.tick()).status, 'failed');
  assert.equal(creates, 1);
});

test('billing failures back off instead of creating a costly retry loop', async () => {
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-billing',
      activeBaseRevision: REV_A,
      sequence: 1,
      starts: ['2026-09-23T00:00:00.000Z'],
      history: [],
      suspendedUntil: null,
      updatedAt: null
    }
  });
  const engine = {
    async get() {
      return {
        id: 'workflow-billing',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'blocked',
        result: { error: 'model_billing_unavailable' },
        steps: []
      };
    }
  };
  const now = Date.parse('2026-09-23T00:05:00Z');
  const autopilot = new AutonomousSelfImprovement({ store, workflowEngine: engine, operatorRevision: REV_A, now: () => now });
  const result = await autopilot.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(Date.parse(store.state.autopilotSelfImprovement.suspendedUntil), now + 6 * 60 * 60 * 1000);
  assert.equal(await autopilot.hasWork(), false);
});

test('repeated billing failures back off exponentially and cap at 24 hours', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const makeStore = (priorFailures) => fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-billing',
      activeBaseRevision: REV_A,
      sequence: priorFailures.length + 1,
      starts: ['2026-09-23T11:50:00.000Z'],
      history: priorFailures.map((completedAt, index) => ({
        workflowId: `workflow-prior-${index + 1}`,
        status: 'blocked',
        error: 'model_billing_unavailable',
        changedPaths: [],
        pullRequestNumber: null,
        pullRequestUrl: null,
        finalHead: null,
        baseRevision: REV_A,
        completedAt
      })),
      suspendedUntil: null,
      updatedAt: null
    }
  });
  const engine = {
    async get() {
      return {
        id: 'workflow-billing',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'blocked',
        result: { error: 'model_billing_unavailable' },
        steps: []
      };
    }
  };

  for (const [priorFailures, expectedHours] of [
    [[], 6],
    [['2026-09-23T01:00:00.000Z'], 12],
    [['2026-09-23T01:00:00.000Z', '2026-09-23T07:00:00.000Z'], 24],
    [['2026-09-22T01:00:00.000Z', '2026-09-22T07:00:00.000Z', '2026-09-22T19:00:00.000Z'], 24]
  ]) {
    const store = makeStore(priorFailures);
    const autopilot = new AutonomousSelfImprovement({ store, workflowEngine: engine, operatorRevision: REV_A, now: () => now });
    assert.equal((await autopilot.tick()).status, 'blocked');
    assert.equal(Date.parse(store.state.autopilotSelfImprovement.suspendedUntil), now + expectedHours * 60 * 60 * 1000);
  }
});

test('a non-billing terminal result clears an expired billing suspension', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-normal-failure',
      activeBaseRevision: REV_A,
      sequence: 2,
      starts: ['2026-09-23T11:50:00.000Z'],
      history: [{
        workflowId: 'workflow-billing',
        status: 'blocked',
        error: 'model_billing_unavailable',
        changedPaths: [],
        pullRequestNumber: null,
        pullRequestUrl: null,
        finalHead: null,
        baseRevision: REV_A,
        completedAt: '2026-09-23T01:00:00.000Z'
      }],
      suspendedUntil: '2026-09-23T07:00:00.000Z',
      updatedAt: null
    }
  });
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: {
      async get() {
        return {
          id: 'workflow-normal-failure',
          profile: 'autonomous-maintenance',
          projectId: 'self',
          status: 'failed',
          result: { error: 'read_only_repository_context_failed' },
          steps: []
        };
      }
    },
    operatorRevision: REV_A,
    now: () => now
  });
  assert.equal((await autopilot.tick()).status, 'failed');
  assert.equal(store.state.autopilotSelfImprovement.suspendedUntil, null);
});
