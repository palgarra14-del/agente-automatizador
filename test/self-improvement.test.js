import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMOUS_MAINTENANCE_GOAL,
  AUTONOMOUS_MAINTENANCE_SCOPE,
  AutonomousSelfImprovement
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

function releaseWaiting(id = 'workflow-auto-1') {
  return {
    id,
    profile: 'autonomous-maintenance',
    projectId: 'self',
    status: 'awaiting_approval',
    result: null,
    steps: [
      { id: 'implementation', status: 'completed' },
      { id: 'review', status: 'completed' },
      { id: 'release-readiness', status: 'awaiting_approval' },
      { id: 'publication', status: 'pending', evidence: null }
    ]
  };
}

test('autopilot creates one bounded autonomous workflow and auto-approves only release readiness', async () => {
  const store = fakeStore();
  let plan = null;
  const calls = { create: [], run: [], approve: [] };
  const engine = {
    async create(input) {
      calls.create.push(clone(input));
      plan = releaseWaiting();
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
      if (calls.approve.length === 0) return clone(plan);
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
  let now = Date.parse('2026-09-23T00:00:00Z');
  const autopilot = new AutonomousSelfImprovement({ store, workflowEngine: engine, operatorRevision: REV_A, now: () => now });

  assert.equal(await autopilot.hasWork(), true);
  const first = await autopilot.tick();
  assert.equal(first.status, 'awaiting_approval');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].profile, 'autonomous-maintenance');
  assert.equal(calls.create[0].projectId, 'self');
  assert.equal(calls.create[0].goal, AUTONOMOUS_MAINTENANCE_GOAL);
  assert.deepEqual(calls.create[0].scope.allowedPaths, [...AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths]);
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('.github'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('config'));
  assert.ok(calls.create[0].scope.forbiddenPaths.includes('package.json'));

  now += 60_000;
  const second = await autopilot.tick();
  assert.equal(second.status, 'completed');
  assert.equal(calls.approve.length, 1);
  assert.equal(calls.approve[0].stepId, 'release-readiness');
  assert.match(calls.approve[0].options.externalApprovalFingerprint, /^[a-f0-9]{64}$/);

  const persisted = store.state.autopilotSelfImprovement;
  assert.equal(persisted.activeWorkflowId, null);
  assert.equal(persisted.waitingForMerge.pullRequestNumber, 231);
  assert.equal(persisted.waitingForMerge.baseRevision, REV_A);
  assert.equal(await autopilot.hasWork(), false);
});

test('autopilot never auto-approves sensitive implementation or unexpected human gates', async () => {
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-sensitive',
      activeBaseRevision: REV_A,
      sequence: 1,
      starts: ['2026-09-23T00:00:00.000Z'],
      history: [],
      waitingForMerge: null,
      suspendedUntil: null,
      updatedAt: null
    }
  });
  let approveCalls = 0;
  const engine = {
    async get() {
      return {
        id: 'workflow-sensitive',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'awaiting_approval',
        result: null,
        steps: [
          { id: 'implementation', status: 'awaiting_approval', error: 'workflow_sensitive_change_requires_approval' },
          { id: 'release-readiness', status: 'pending' }
        ]
      };
    },
    async approve() { approveCalls += 1; throw new Error('must not approve'); },
    async run() { throw new Error('must not run while sensitive approval is required'); }
  };
  const autopilot = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV_A,
    now: () => Date.parse('2026-09-23T00:10:00Z')
  });

  const result = await autopilot.tick();
  assert.equal(result.status, 'human_gate_required');
  assert.equal(result.stepId, 'implementation');
  assert.equal(approveCalls, 0);
});

test('published autopilot work cannot spawn again until authoritative main advances', async () => {
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: null,
      activeBaseRevision: null,
      sequence: 1,
      starts: ['2026-09-22T20:00:00.000Z'],
      history: [],
      waitingForMerge: {
        workflowId: 'workflow-old',
        baseRevision: REV_A,
        pullRequestNumber: 200,
        pullRequestUrl: 'https://github.com/example/repo/pull/200',
        finalHead: 'c'.repeat(40),
        since: '2026-09-22T20:10:00.000Z'
      },
      suspendedUntil: null,
      updatedAt: null
    }
  });
  let creates = 0;
  const engine = {
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
    },
    async run() { throw new Error('terminal plan should settle before run'); }
  };

  const sameMain = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV_A,
    now: () => Date.parse('2026-09-23T00:00:00Z')
  });
  assert.equal(await sameMain.hasWork(), false);
  assert.equal((await sameMain.tick()).status, 'waiting_for_merge');
  assert.equal(creates, 0);

  const advancedMain = new AutonomousSelfImprovement({
    store,
    workflowEngine: engine,
    operatorRevision: REV_B,
    now: () => Date.parse('2026-09-23T01:00:00Z')
  });
  assert.equal(await advancedMain.hasWork(), true);
  const result = await advancedMain.tick();
  assert.equal(creates, 1);
  assert.equal(result.status, 'failed');
  assert.equal(store.state.autopilotSelfImprovement.waitingForMerge, null);
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
      waitingForMerge: null,
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
  assert.ok(Date.parse(store.state.autopilotSelfImprovement.suspendedUntil) >= now + 6 * 60 * 60 * 1000);
  assert.equal(await autopilot.hasWork(), false);
});
