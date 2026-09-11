import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, WorkflowEngine, WorkflowStepStatus, configFrom, createWorkflowPlan, evaluateDefinitionOfDone, validateWorkflowPlan } from '../src/core.js';

function project() {
  return configFrom({ id: 'workflow-project', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, execution: { provider: 'local-sanitized' } });
}

async function engine({ runner } = {}) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-workflow-')), 'state.json'));
  const projects = new Map([['workflow-project', project()]]);
  return new WorkflowEngine({ store, projects, commandRunner: runner ?? (async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'ok', stderr: '' })) });
}

test('workflow profiles create validated deterministic plans', () => {
  for (const profile of ['website-build', 'app-improvement', 'data-analysis']) {
    const plan = createWorkflowPlan({ profile, project: project(), goal: `Exercise ${profile}` });
    assert.equal(validateWorkflowPlan(plan, new Set(['workflow-project'])).ok, true);
    assert.ok(plan.steps.length > 3);
    assert.ok(plan.definitionOfDone.length > 0);
  }
});

test('workflow validation rejects duplicate ids, missing dependencies, cycles, and budgets', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  plan.steps[1].id = plan.steps[0].id;
  assert.throws(() => validateWorkflowPlan(plan, new Set(['workflow-project'])), /unique/);
  const missing = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  missing.steps[0].dependsOn = ['missing'];
  assert.throws(() => validateWorkflowPlan(missing, new Set(['workflow-project'])), /does not exist/);
  const cycle = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  cycle.steps[0].dependsOn = [cycle.steps.at(-1).id];
  assert.throws(() => validateWorkflowPlan(cycle, new Set(['workflow-project'])), /cycle/);
  assert.throws(() => createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate', budgets: { maxSteps: 1 } }), /maxSteps/);
});

test('workflow runs dependencies sequentially, honors checkpoints, and satisfies Definition of Done', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Improve safely' });
  let current = await instance.run(created.id);
  assert.equal(current.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(current.steps.find((step) => step.id === 'implementation').status, WorkflowStepStatus.PENDING);
  await instance.approve(created.id, 'plan-change');
  current = await instance.run(created.id);
  assert.equal(current.status, WorkflowStepStatus.AWAITING_APPROVAL);
  await instance.approve(created.id, 'release-readiness');
  current = await instance.run(created.id);
  assert.equal(current.status, WorkflowStepStatus.COMPLETED);
  assert.equal(current.validation.ok, true);
});

test('workflow dry-run reports executable steps without invoking the command executor', async () => {
  let calls = 0;
  const instance = await engine({ runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Analyze' });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(calls, 0);
  assert.equal((await instance.get(created.id)).steps[0].status, WorkflowStepStatus.READY);
});

test('workflow limits retries and persists failure evidence', async () => {
  const instance = await engine({ runner: async (project, name) => ({ name, ok: false, exitCode: 1, stdout: '', stderr: `${project.id}:${name}` }) });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Fail safely', budgets: { maxAttempts: 2 } });
  await instance.run(created.id);
  const failed = await instance.get(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.steps.find((step) => step.id === 'validate-data').attempts, 2);
});

test('workflow fails when accumulated command output exceeds its budget', async () => {
  const instance = await engine({ runner: async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'x'.repeat(2_000), stderr: '' }) });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Bound output', budgets: { maxOutputBytes: 1_024 } });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_output_budget_exhausted');
});

test('workflow resume blocks an interrupted running step until a human approves it', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Recover safely' });
  await instance.update(created.id, (plan) => { plan.steps[0].status = WorkflowStepStatus.RUNNING; plan.status = WorkflowStepStatus.RUNNING; });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps[0].status, WorkflowStepStatus.BLOCKED);
  await instance.approve(created.id, blocked.steps[0].id);
  const resumed = await instance.run(created.id);
  assert.equal(resumed.steps[0].status, WorkflowStepStatus.COMPLETED);
});

test('Definition of Done and malformed persisted workflow state are enforced', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Validate done' });
  assert.equal(evaluateDefinitionOfDone(created).ok, false);
  await instance.store.mutate((data) => { data.workflows.bad = { id: 'bad', projectId: 'workflow-project', profile: 'data-analysis', budgets: {}, steps: [] }; });
  await assert.rejects(instance.run('bad'), /must contain steps/);
});
