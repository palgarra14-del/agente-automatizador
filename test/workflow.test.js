import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonStore, WorkflowEngine, WorkflowStepStatus, configFrom, createWorkflowPlan, evaluateDefinitionOfDone, validateWorkflowPlan } from '../src/core.js';

function project() {
  return configFrom({ id: 'workflow-project', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, execution: { provider: 'local-sanitized' } });
}

async function engine({ runner, projects, workspaceManager, now } = {}) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-workflow-')), 'state.json'));
  const configuredProjects = projects ?? new Map([['workflow-project', project()]]);
  return new WorkflowEngine({ store, projects: configuredProjects, workspaceManager, now, commandRunner: runner ?? (async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'ok', stderr: '' })) });
}

function completeStep(plan, id) {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown workflow step fixture: ${id}`);
  step.status = WorkflowStepStatus.COMPLETED;
  step.error = null;
  const completedAt = '2026-09-11T00:00:00.000Z';
  if (step.type === 'placeholder') step.evidence = { type: 'executor', ok: true, completedAt };
  else if (step.type === 'checkpoint') step.evidence = { approvedAt: completedAt };
  else step.evidence = { commands: step.commands.map((name) => ({ name, ok: true, exitCode: 0, stdout: '', stderr: '' })) };
  return step;
}

function managedProject(id, root, { commands = { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, budgets } = {}) {
  return configFrom({
    id, repository: { owner: 'owner', name: `${id}-repo` }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', workspaceStrategy: 'managed', managedWorkspaceRoot: '.managed-workspaces',
    commands, acceptance: { require: ['test'] }, execution: { provider: 'local-sanitized' }, budgets
  }, join(root, id, 'config'));
}

class FakeWorkflowWorkspaceManager {
  constructor() { this.prepared = []; }
  describe(project, runId) {
    if (project.workspaceStrategy !== 'managed') return { workspace: project.workspace, managed: false, retained: false };
    return { workspace: resolve(project.managedWorkspaceRoot, project.id, runId), managed: true, retained: true };
  }
  async prepare(project, runId, options = {}) {
    const allocation = this.describe(project, runId);
    this.prepared.push({ projectId: project.id, ...allocation, options });
    return { ...allocation, remoteUrl: `https://github.com/${project.repository.owner}/${project.repository.name}.git` };
  }
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

test('workflow placeholders block honestly instead of claiming unimplemented work completed', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Improve safely' });
  const current = await instance.run(created.id);
  const inspect = current.steps.find((step) => step.id === 'inspect-project');
  assert.equal(current.status, WorkflowStepStatus.BLOCKED);
  assert.equal(current.result.error, 'skill_not_bound_to_surface');
  assert.equal(inspect.status, WorkflowStepStatus.BLOCKED);
  assert.equal(inspect.error, 'skill_not_bound_to_surface');
  assert.equal(evaluateDefinitionOfDone(current).ok, false);
  await assert.rejects(instance.approve(created.id, 'inspect-project'), /not awaiting human approval/);
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
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await instance.run(created.id);
  const failed = await instance.get(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.steps.find((step) => step.id === 'validate-data').attempts, 2);
});

test('workflow stops command execution as soon as accumulated output exceeds its budget', async () => {
  const calls = [];
  const instance = await engine({ runner: async (_project, name) => { calls.push(name); return { name, ok: true, exitCode: 0, stdout: 'x'.repeat(2_000), stderr: '' }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Bound output', budgets: { maxOutputBytes: 1_024 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_output_budget_exhausted');
  assert.deepEqual(calls, ['test']);
});

test('workflow resume blocks an interrupted executable step until a human approves it', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Recover safely' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  await instance.approve(created.id, 'validate-data');
  const resumed = await instance.run(created.id);
  assert.equal(resumed.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.COMPLETED);
  assert.equal(resumed.status, WorkflowStepStatus.BLOCKED);
  assert.equal(resumed.result.error, 'skill_not_bound_to_surface');
});

test('Definition of Done and malformed persisted workflow state are enforced', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Validate done' });
  assert.equal(evaluateDefinitionOfDone(created).ok, false);
  await instance.store.mutate((data) => { data.workflows.bad = { id: 'bad', projectId: 'workflow-project', profile: 'data-analysis', budgets: {}, steps: [] }; });
  await assert.rejects(instance.run('bad'), /must contain steps/);
});

test('Definition of Done requires completed steps and never accepts skipped mandatory work', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Strict DoD' });
  for (const step of plan.steps) completeStep(plan, step.id);
  const required = plan.steps.find((step) => step.id === 'validate-data');
  required.status = WorkflowStepStatus.SKIPPED;
  assert.equal(evaluateDefinitionOfDone(plan).ok, false);
  required.status = WorkflowStepStatus.COMPLETED;
  assert.equal(evaluateDefinitionOfDone(plan).ok, true);
});

test('Callflow and LeadFinder workflows bind every command to their selected managed workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-projects-'));
  const callflow = managedProject('callflow', root);
  const leadfinder = managedProject('leadfinder', root);
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[callflow.id, callflow], [leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (boundProject, name) => {
    calls.push({ id: boundProject.id, workspace: boundProject.workspace, name });
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const callflowWorkflow = await instance.create({ profile: 'data-analysis', projectId: 'callflow', goal: 'Isolate Callflow' });
  const leadfinderWorkflow = await instance.create({ profile: 'data-analysis', projectId: 'leadfinder', goal: 'Isolate LeadFinder' });
  await instance.update(callflowWorkflow.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await instance.update(leadfinderWorkflow.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const callflowCompleted = await instance.run(callflowWorkflow.id);
  const leadfinderCompleted = await instance.run(leadfinderWorkflow.id);
  const expectedCallflow = manager.describe(callflow, callflowWorkflow.id).workspace;
  const expectedLeadfinder = manager.describe(leadfinder, leadfinderWorkflow.id).workspace;
  assert.equal(callflowCompleted.workspace.path, expectedCallflow);
  assert.deepEqual(callflowCompleted.workspace.repository, callflow.repository);
  assert.equal(leadfinderCompleted.workspace.path, expectedLeadfinder);
  assert.equal(leadfinderCompleted.workspace.managed, true);
  assert.deepEqual(leadfinderCompleted.workspace.repository, leadfinder.repository);
  assert.ok(calls.length > 0);
  assert.ok(calls.filter((call) => call.id === 'callflow').every((call) => call.workspace === expectedCallflow));
  assert.ok(calls.filter((call) => call.id === 'leadfinder').every((call) => call.workspace === expectedLeadfinder));
  assert.equal(calls.some((call) => call.id === 'callflow' && call.name === 'install'), false);
  assert.notEqual(expectedCallflow, expectedLeadfinder);
  assert.equal(manager.prepared.length, 2);
});

test('workflow rejects persisted workspace escape, cross-project substitution, and managed symlink before commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-escape-'));
  const callflow = managedProject('callflow', root);
  const leadfinder = managedProject('leadfinder', root);
  const projects = new Map([[callflow.id, callflow], [leadfinder.id, leadfinder]]);
  const manager = new FakeWorkflowWorkspaceManager();
  let calls = 0;
  const instance = await engine({ projects, workspaceManager: manager, runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'leadfinder', goal: 'Reject workspace tampering' });
  await instance.update(created.id, (plan) => {
    plan.workspace = { path: manager.describe(callflow, created.id).workspace, managed: true, projectId: leadfinder.id, repository: leadfinder.repository, initializedAt: new Date().toISOString() };
  });
  await assert.rejects(instance.run(created.id), /outside the managed workspace root/);
  await instance.update(created.id, (plan) => { plan.workspace.path = resolve(leadfinder.managedWorkspaceRoot, '..', 'outside'); });
  await assert.rejects(instance.run(created.id), /outside the managed workspace root/);
  await instance.update(created.id, (plan) => {
    plan.workspace = null;
    completeStep(plan, 'inspect-data');
  });
  await mkdir(leadfinder.managedWorkspaceRoot, { recursive: true });
  const external = await mkdtemp(join(tmpdir(), 'agent-workflow-external-'));
  await symlink(external, join(leadfinder.managedWorkspaceRoot, leadfinder.id), 'junction');
  await assert.rejects(instance.run(created.id), /cannot contain a symlink/);
  assert.equal(calls, 0);
});

test('workflow fails closed when persisted state introduces arbitrary commands or invalid fields', async () => {
  let calls = 0;
  const instance = await engine({ runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Reject corruption' });
  await instance.update(created.id, (plan) => { plan.steps.find((step) => step.id === 'validate-data').commands = ['curl']; });
  await assert.rejects(instance.run(created.id), /not allowlisted/);
  await instance.update(created.id, (plan) => { plan.steps.find((step) => step.id === 'validate-data').commands = ['test', 'typecheck', 'lint', 'build']; plan.outputBytes = -1; });
  await assert.rejects(instance.run(created.id), /outputBytes/);
  assert.equal(calls, 0);
});

test('workflow global deadline is enforced before start, between steps, between commands, and retries', async () => {
  let clock = 0;
  let calls = 0;
  const expired = await engine({ now: () => clock, runner: async () => { calls += 1; return { ok: true }; } });
  const expiredPlan = await expired.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Expired', budgets: { timeoutMs: 1_000 } });
  clock = 1_000;
  assert.equal((await expired.run(expiredPlan.id)).result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(calls, 0);

  clock = 0;
  const betweenSteps = await engine({ now: () => clock, runner: async (_project, name) => { calls += 1; clock = 1_000; return { name, ok: true, stdout: '', stderr: '' }; } });
  const stepPlan = await betweenSteps.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Between steps', budgets: { timeoutMs: 1_000 } });
  await betweenSteps.update(stepPlan.id, (plan) => { completeStep(plan, 'inspect-data'); });
  assert.equal((await betweenSteps.run(stepPlan.id)).result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(calls, 1);

  clock = 0;
  const commandTimeouts = [];
  const betweenCommands = await engine({ now: () => clock, runner: async (_project, name, options) => { calls += 1; commandTimeouts.push(options.timeoutMs); clock = 1_000; return { name, ok: false, stdout: '', stderr: '' }; } });
  const commandPlan = await betweenCommands.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Between commands', budgets: { timeoutMs: 1_000, maxAttempts: 2 } });
  await betweenCommands.update(commandPlan.id, (plan) => {
    for (const id of ['inspect-project', 'diagnose', 'plan-change', 'implementation', 'tests']) completeStep(plan, id);
  });
  const deadlineFailed = await betweenCommands.run(commandPlan.id);
  assert.equal(deadlineFailed.result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(commandTimeouts.at(-1), 1_000);
  assert.equal(calls, 2);
  assert.equal(deadlineFailed.steps.find((step) => step.id === 'verification').attempts, 1);
});

test('crash and resume preserve a managed workspace and never repeat completed steps before approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-resume-'));
  const leadfinder = managedProject('leadfinder', root);
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (boundProject, name) => {
    calls.push({ workspace: boundProject.workspace, name });
    return { name, ok: true, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Resume safely' });
  const expectedWorkspace = (await instance.workspaceProject(created.id, leadfinder)).workspace;
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  assert.equal(calls.length, 0);
  await instance.approve(created.id, 'validate-data');
  const resumed = await instance.run(created.id);
  assert.equal(resumed.steps.find((step) => step.id === 'inspect-data').status, WorkflowStepStatus.COMPLETED);
  assert.equal(resumed.workspace.path, expectedWorkspace);
  assert.equal(manager.prepared.length, 1);
  assert.ok(calls.length > 0 && calls.every((call) => call.workspace === expectedWorkspace));
});

test('a new LeadFinder-like workspace bootstraps once before its verification commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const order = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name, options) => {
    order.push(`${options.stage}:${name}`);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bootstrap dependencies' });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.plannedBootstrap, 'install');
  assert.equal(manager.prepared.length, 0);
  assert.deepEqual(order, []);
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const completed = await instance.run(created.id);
  assert.deepEqual(order, ['bootstrap:install', 'post-worker:test']);
  assert.equal(order.filter((entry) => entry === 'bootstrap:install').length, 1);
  assert.equal(manager.prepared.length, 1);
  assert.equal(completed.bootstrap.status, 'completed');
  assert.equal(completed.bootstrap.workspacePath, completed.workspace.path);
  await instance.resume(created.id);
  assert.equal(order.filter((entry) => entry === 'bootstrap:install').length, 1);
});

test('bootstrap failure or output exhaustion stops managed workflow verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-failure-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build' } });
  const attempts = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => {
    attempts.push(name);
    return { name, ok: name !== 'install', exitCode: name === 'install' ? 1 : 0, stdout: '', stderr: 'install failed' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Stop on install failure' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'workflow_bootstrap_failed');
  assert.deepEqual(attempts, ['install']);

  const exhausted = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'x'.repeat(2_000), stderr: '' }) });
  const outputPlan = await exhausted.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound install output', budgets: { maxOutputBytes: 1_024 } });
  await exhausted.update(outputPlan.id, (plan) => { completeStep(plan, 'inspect-data'); });
  assert.equal((await exhausted.run(outputPlan.id)).result.error, 'workflow_output_budget_exhausted');
});

test('bootstrap respects the global deadline and uses only remaining command time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-deadline-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' }, budgets: { commandTimeoutMs: 120_000 } });
  let clock = 0;
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), now: () => clock, runner: async (_project, name, options) => {
    calls.push({ name, timeoutMs: options.timeoutMs, stage: options.stage });
    clock = 1_000;
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound install time', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  clock = 300;
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'workflow_budget_deadline_exceeded');
  assert.deepEqual(calls, [{ name: 'install', timeoutMs: 700, stage: 'bootstrap' }]);
});

test('bootstrap state tampering and crash resume fail closed without reinstalling a completed workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-resume-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name) => {
    calls.push(name);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Resume bootstrap safely' });
  const workspaceProject = await instance.workspaceProject(created.id, leadfinder);
  await instance.bootstrapWorkspace(created.id, leadfinder, workspaceProject);
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  assert.deepEqual(calls, ['install']);
  await instance.approve(created.id, 'validate-data');
  await instance.run(created.id);
  assert.equal(calls.filter((name) => name === 'install').length, 1);
  assert.equal(manager.prepared.length, 1);

  const callsBeforeTampering = calls.length;
  const falseCompleted = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject false bootstrap' });
  await instance.update(falseCompleted.id, (plan) => { plan.bootstrap.status = 'completed'; });
  await assert.rejects(instance.run(falseCompleted.id), /completion evidence is invalid/);
  const arbitraryCommand = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject bootstrap command' });
  await instance.update(arbitraryCommand.id, (plan) => { plan.bootstrap.command = 'curl'; });
  await assert.rejects(instance.run(arbitraryCommand.id), /bootstrap state is invalid/);
  const otherProject = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject foreign bootstrap' });
  await instance.update(otherProject.id, (plan) => { plan.bootstrap.projectId = 'callflow'; });
  await assert.rejects(instance.run(otherProject.id), /bootstrap project is invalid/);
  const otherWorkspace = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject foreign workspace bootstrap' });
  await instance.workspaceProject(otherWorkspace.id, leadfinder);
  await instance.update(otherWorkspace.id, (plan) => { plan.bootstrap.workspacePath = `${plan.workspace.path}-other`; });
  await assert.rejects(instance.run(otherWorkspace.id), /bootstrap does not match its workspace/);
  assert.equal(calls.length, callsBeforeTampering);
});

test('an interrupted bootstrap is never treated as completed and is retried only after resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-interrupted-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name) => {
    calls.push(name);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Recover interrupted install' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const workspaceProject = await instance.workspaceProject(created.id, leadfinder);
  await instance.update(created.id, (plan) => {
    plan.bootstrap.status = 'running';
    plan.bootstrap.workspacePath = workspaceProject.workspace;
    plan.bootstrap.attempts = 1;
  });
  const resumed = await instance.resume(created.id);
  assert.equal(resumed.bootstrap.status, 'completed');
  assert.equal(resumed.bootstrap.attempts, 2);
  assert.equal(calls.filter((name) => name === 'install').length, 1);
  assert.equal(manager.prepared.length, 1);
});

test('workflow persists only bounded masked bootstrap and verification output while budgeting real bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-masked-output-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const bootstrapSecret = 'SUPER_SECRET_TOKEN_123456789';
  const verificationSecret = 'VERIFICATION_SECRET_TOKEN_987654321';
  const largeBootstrapOutput = `Authorization: Bearer ${bootstrapSecret}\n${'x'.repeat(2_000)}`;
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => ({
    name, ok: true, exitCode: 0,
    stdout: name === 'install' ? largeBootstrapOutput : '',
    stderr: name === 'test' ? `Authorization: Bearer ${verificationSecret}` : ''
  }) });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Mask workflow output', budgets: { maxOutputBytes: 8_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const completed = await instance.run(created.id);
  const persisted = JSON.stringify(await instance.get(created.id));
  const bootstrapEvidence = completed.bootstrap.evidence;
  const verificationEvidence = completed.steps.find((step) => step.id === 'validate-data').evidence.commands.find((command) => command.name === 'test');
  assert.equal(persisted.includes(bootstrapSecret), false);
  assert.equal(persisted.includes(verificationSecret), false);
  assert.match(bootstrapEvidence.stdout, /\[REDACTED\]/);
  assert.match(verificationEvidence.stderr, /\[REDACTED\]/);
  assert.ok(bootstrapEvidence.stdout.length <= 1_000);
  assert.ok(completed.outputBytes >= Buffer.byteLength(largeBootstrapOutput));
});


test('human checkpoint wait time pauses the workflow execution deadline', async () => {
  let clock = 0;
  const instance = await engine({ now: () => clock });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Pause while waiting', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
  });
  clock = 200;
  const waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.pausedAt, 200);
  const originalDeadline = waiting.deadlineAt;
  clock = 10_200;
  const stillWaiting = await instance.run(created.id);
  assert.equal(stillWaiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  await instance.approve(created.id, 'plan-change');
  const approved = await instance.get(created.id);
  assert.equal(approved.pausedAt, null);
  assert.equal(approved.deadlineAt, originalDeadline + 10_000);
  assert.ok(approved.deadlineAt > clock);
});

test('managed workspace clone receives only the workflow remaining time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-clone-deadline-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { test: 'pnpm test' }, budgets: { commandTimeoutMs: 120_000 } });
  let clock = 0;
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, now: () => clock });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound clone time', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  clock = 300;
  await instance.run(created.id);
  assert.equal(manager.prepared.length, 1);
  assert.equal(manager.prepared[0].options.timeoutMs, 700);
});

test('bootstrap attempt budget prevents unlimited retry after repeated interrupted installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-attempts-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager() });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound bootstrap attempts', budgets: { maxAttempts: 2 } });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.bootstrap.status = 'pending';
    plan.bootstrap.attempts = 2;
  });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_bootstrap_attempt_budget_exhausted');
});


test('verification steps use profile-specific command sets instead of repeating the full suite', () => {
  const app = createWorkflowPlan({ profile: 'app-improvement', project: project(), goal: 'Map checks' });
  assert.deepEqual(app.steps.find((step) => step.id === 'tests').commands, ['test']);
  assert.deepEqual(app.steps.find((step) => step.id === 'verification').commands, ['typecheck', 'lint', 'build']);
  const website = createWorkflowPlan({ profile: 'website-build', project: project(), goal: 'Map checks' });
  assert.deepEqual(website.steps.find((step) => step.id === 'quality').commands, ['test', 'typecheck', 'lint']);
  assert.deepEqual(website.steps.find((step) => step.id === 'release-readiness').commands, ['build']);
});

test('terminal workflows do not execute again', async () => {
  let calls = 0;
  const instance = await engine({ runner: async (_project, name) => { calls += 1; return { name, ok: true, stdout: '', stderr: '' }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Stay terminal' });
  await instance.update(created.id, (plan) => {
    plan.status = WorkflowStepStatus.FAILED;
    plan.result = { error: 'fixture_failure' };
  });
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'fixture_failure');
  assert.equal(calls, 0);
});

test('workflow state validation ties checkpoint pause state to awaiting approval', () => {
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: project(), goal: 'Validate pause state', nowMs: 100 });
  for (const id of ['inspect-project', 'diagnose']) completeStep(plan, id);
  const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
  checkpoint.status = WorkflowStepStatus.AWAITING_APPROVAL;
  plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  assert.throws(() => validateWorkflowPlan(plan, new Map([['workflow-project', project()]])), /paused checkpoint/);
  plan.pausedAt = 150;
  assert.equal(validateWorkflowPlan(plan, new Map([['workflow-project', project()]])).ok, true);
});


test('workspace clone timeout is distinct from exhausting the global workflow deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-clone-timeout-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { test: 'pnpm test' }, budgets: { commandTimeoutMs: 200 } });
  const manager = new FakeWorkflowWorkspaceManager();
  manager.prepare = async () => {
    const error = new Error('workspace_clone_timeout');
    error.code = 'WORKSPACE_CLONE_TIMEOUT';
    throw error;
  };
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, now: () => 100 });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Distinguish clone timeout', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await assert.rejects(instance.run(created.id), /workspace_clone_timeout/);
  const failed = await instance.get(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workspace_clone_timeout');
});


test('workflow approval cannot bypass non-human capability blocks', async () => {
  const limited = configFrom({ id: 'limited', repository: { owner: 'owner', name: 'limited' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { lint: 'node --version' }, execution: { provider: 'local-sanitized' } });
  const instance = await engine({ projects: new Map([[limited.id, limited]]) });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Require a configured validator' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.result.error, 'verification_command_not_configured');
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  await assert.rejects(instance.approve(created.id, 'validate-data'), /not awaiting human approval/);
});


test('persisted completed steps require type-appropriate evidence', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Reject forged completion' });
  await instance.update(created.id, (plan) => {
    for (const step of plan.steps) {
      step.status = WorkflowStepStatus.COMPLETED;
      step.error = null;
      step.evidence = null;
    }
    plan.status = WorkflowStepStatus.PENDING;
  });
  await assert.rejects(instance.run(created.id), /requires .* evidence/);
});
