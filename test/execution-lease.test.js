import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, Orchestrator, RunStatus, WorkflowEngine, WorkflowStepStatus, configFrom, defaultToolSkillRegistry } from '../src/core.js';

async function temporaryStore() {
  return new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-execution-lease-')), 'state.json'));
}

function configuredProject(id = 'lease-project') {
  return configFrom({
    id,
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    acceptance: { require: ['test', 'ci'] },
    deployment: { provider: 'none' },
    execution: { provider: 'local-sanitized' }
  });
}

function completePlaceholder(plan, id) {
  const step = plan.steps.find((candidate) => candidate.id === id);
  step.status = WorkflowStepStatus.COMPLETED;
  step.error = null;
  step.evidence = {
    type: 'executor',
    ok: true,
    completedAt: '2026-09-11T00:00:00.000Z',
    skill: step.skill,
    registryFingerprint: plan.registryFingerprint,
    projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint
  };
}

test('execution lease rejects a live second owner and releases after success or failure', async () => {
  const store = await temporaryStore();
  await store.mutate((data) => { data.runs.one = { id: 'one', executionLease: null }; });

  const lease = await store.claimExecutionLease('runs', 'one', 'run');
  await assert.rejects(store.claimExecutionLease('runs', 'one', 'run'), /run_execution_in_progress/);
  assert.equal(await store.releaseExecutionLease('runs', 'one', lease.leaseId), true);
  assert.equal((await store.getRun('one')).executionLease, null);

  await assert.rejects(
    store.withExecutionLease('runs', 'one', 'run', async () => { throw new Error('fixture_failure'); }),
    /fixture_failure/
  );
  assert.equal((await store.getRun('one')).executionLease, null);
});

test('execution lease recovers only after the previous owner is demonstrably abandoned', async () => {
  const store = await temporaryStore();
  await store.mutate((data) => {
    data.runs.one = {
      id: 'one',
      executionLease: { leaseId: 'stale', kind: 'run', pid: 999999, createdAt: '2026-09-11T00:00:00.000Z', ownerIdentity: null }
    };
  });
  store.lockOwnerIsAbandoned = async () => true;
  const recovered = await store.claimExecutionLease('runs', 'one', 'run');
  assert.notEqual(recovered.leaseId, 'stale');
  assert.equal(recovered.pid, process.pid);
  assert.equal(await store.releaseExecutionLease('runs', 'one', recovered.leaseId), true);
});

test('concurrent workflow run is rejected before the verification command executes twice', async () => {
  const store = await temporaryStore();
  const project = configuredProject();
  const projects = new Map([[project.id, project]]);
  let calls = 0;
  let enterCommand;
  let releaseCommand;
  const entered = new Promise((resolve) => { enterCommand = resolve; });
  const gate = new Promise((resolve) => { releaseCommand = resolve; });
  const engine = new WorkflowEngine({
    store,
    projects,
    commandRunner: async (_project, name) => {
      calls += 1;
      enterCommand();
      await gate;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await engine.create({ profile: 'data-analysis', projectId: project.id, goal: 'Verify once' });
  await engine.update(created.id, (plan) => { completePlaceholder(plan, 'inspect-data'); });

  const first = engine.run(created.id);
  await entered;
  await assert.rejects(engine.run(created.id), /workflow_execution_in_progress/);
  assert.equal(calls, 1);
  releaseCommand();
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.COMPLETED);
  assert.equal((await engine.get(created.id)).executionLease, null);
});

test('concurrent orchestrator continuation is rejected before planner work is duplicated', async () => {
  const store = await temporaryStore();
  const project = configuredProject('run-lease-project');
  let plannerCalls = 0;
  let enterPlanner;
  let releasePlanner;
  const entered = new Promise((resolve) => { enterPlanner = resolve; });
  const gate = new Promise((resolve) => { releasePlanner = resolve; });
  const planner = {
    async plan() {
      plannerCalls += 1;
      enterPlanner();
      await gate;
      throw new Error('fixture_stop_after_lease_test');
    }
  };
  const orchestrator = new Orchestrator({ store, planner, registry: defaultToolSkillRegistry });
  const run = await orchestrator.create(project, 'Run once');
  assert.equal(run.status, RunStatus.CREATED);

  const first = orchestrator.continueRun(run, project);
  await entered;
  await assert.rejects(orchestrator.continueRun(run, project), /run_execution_in_progress/);
  assert.equal(plannerCalls, 1);
  releasePlanner();
  const failed = await first;
  assert.equal(failed.status, RunStatus.FAILED);
  assert.equal(plannerCalls, 1);
  assert.equal((await store.getRun(run.id)).executionLease, null);
});
