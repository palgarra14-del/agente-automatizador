import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonStore, WorkflowEngine, WorkflowStepStatus, configFrom, createWorkflowPlan, evaluateDefinitionOfDone, fingerprintChangeSet, validateWorkflowPlan } from '../src/core.js';

function project() {
  return configFrom({ id: 'workflow-project', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, execution: { provider: 'local-sanitized' } });
}

function emptyChangeSet() {
  const base = { paths: [], changedFiles: 0, additions: 0, deletions: 0, diffLines: 0, changedBytes: 0, maxFileBytes: 0, sensitiveContent: false, contentFingerprint: '0'.repeat(64) };
  return { ...base, changeSetFingerprint: fingerprintChangeSet(base) };
}

function stableLocalGit(overrides = {}) {
  return {
    async inspect(project) {
      return { repository: project.workspace, remote: `https://github.com/${project.repository.owner}/${project.repository.name}.git`, currentBranch: project.defaultBranch, initialHead: 'deadbeef', status: '' };
    },
    async inspectChangeSet() { return emptyChangeSet(); },
    async assertRepositoryState(project, expected = {}) {
      const current = await this.inspect(project);
      if (expected.branch && current.currentBranch !== expected.branch) throw new Error('Unexpected current branch');
      if (expected.head && current.initialHead !== expected.head) throw new Error('Unexpected HEAD');
      if (expected.remote && current.remote !== expected.remote) throw new Error('Unexpected origin remote');
      return current;
    },
    ...overrides
  };
}

async function engine({ runner, projects, workspaceManager, localGit, skillExecutor, codingWorker, now } = {}) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-workflow-')), 'state.json'));
  const configuredProjects = projects ?? new Map([['workflow-project', project()]]);
  return new WorkflowEngine({ store, projects: configuredProjects, workspaceManager, localGit: localGit ?? stableLocalGit(), skillExecutor, codingWorker, now, commandRunner: runner ?? (async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'ok', stderr: '' })) });
}

function completeStep(plan, id) {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown workflow step fixture: ${id}`);
  step.status = WorkflowStepStatus.COMPLETED;
  step.error = null;
  const completedAt = '2026-09-11T00:00:00.000Z';
  const capability = {
    skill: step.skill,
    registryFingerprint: plan.registryFingerprint,
    projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint
  };
  if (step.type === 'placeholder' && step.skill === 'code.implement') step.evidence = { ...capability, type: 'executor', ok: true, completedAt, changeSetFingerprint: emptyChangeSet().changeSetFingerprint, changePolicy: { ok: true, classification: 'normal' }, workerEvidence: { status: 'completed' }, repositoryState: { branch: 'main', head: 'deadbeef', remote: 'https://github.com/owner/repo.git' } };
  else if (step.type === 'placeholder') step.evidence = { ...capability, type: 'executor', ok: true, completedAt };
  else if (step.type === 'checkpoint') step.evidence = { ...capability, approvedAt: completedAt };
  else step.evidence = { ...capability, commands: step.commands.map((name) => ({ name, ok: true, exitCode: 0, stdout: '', stderr: '' })) };
  return step;
}

function managedProject(id, root, { commands = { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, budgets, skills } = {}) {
  return configFrom({
    id, repository: { owner: 'owner', name: `${id}-repo` }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', workspaceStrategy: 'managed', managedWorkspaceRoot: '.managed-workspaces',
    commands, acceptance: { require: ['test'] }, execution: { provider: 'local-sanitized' }, budgets, skills
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
  assert.equal(current.result.error, 'skill_not_allowed');
  assert.equal(inspect.status, WorkflowStepStatus.BLOCKED);
  assert.equal(inspect.error, 'skill_not_allowed');
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
  assert.equal(resumed.result.error, 'skill_not_allowed');
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
  await assert.rejects(instance.run(created.id), /evidence/);
});


test('managed workflow denies workspace preparation before clone when capability is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-workspace-capability-'));
  const limited = managedProject('limited-workspace', root, {
    skills: {
      allow: ['project.verify', 'human.approval'],
      deny: []
    }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[limited.id, limited]]), workspaceManager: manager });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Do not clone' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.result.error, 'skill_not_allowed');
  assert.equal(blocked.result.skill, 'workspace.prepare');
  assert.equal(manager.prepared.length, 0);
});

test('managed workflow denies bootstrap before clone when install capability is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-capability-'));
  const limited = managedProject('limited-bootstrap', root, {
    commands: { install: 'node --version', test: 'node --version' },
    skills: {
      allow: ['workspace.prepare', 'project.verify', 'human.approval'],
      deny: []
    }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[limited.id, limited]]), workspaceManager: manager });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Do not install' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.result.error, 'skill_not_allowed');
  assert.equal(blocked.result.skill, 'project.bootstrap');
  assert.equal(manager.prepared.length, 0);
});


test('completed workflow evidence cannot be replayed under a different skill or capability fingerprint', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Bind evidence context' });
  const step = completeStep(plan, 'inspect-data');
  step.evidence.skill = 'project.verify';
  assert.throws(() => validateWorkflowPlan(plan, new Map([['workflow-project', project()]])), /capability context/);

  const fingerprintPlan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Bind evidence fingerprint' });
  const fingerprintStep = completeStep(fingerprintPlan, 'inspect-data');
  fingerprintStep.evidence.registryFingerprint = '0'.repeat(64);
  assert.throws(() => validateWorkflowPlan(fingerprintPlan, new Map([['workflow-project', project()]])), /capability context/);
});


test('stale capability context blocks workflow approval and resume before mutation', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Freeze capability context' });
  await instance.update(created.id, (plan) => {
    for (const id of ['inspect-project', 'diagnose']) completeStep(plan, id);
    const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
    checkpoint.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.pausedAt = plan.deadlineAt - plan.budgets.timeoutMs + 1;
  });
  const beforeApproval = await instance.get(created.id);
  const originalRegistryFingerprint = beforeApproval.registryFingerprint;
  const originalPausedAt = beforeApproval.pausedAt;
  await instance.update(created.id, (plan) => { plan.registryFingerprint = '0'.repeat(64); });
  await assert.rejects(instance.approve(created.id, 'plan-change'), /registry fingerprint/);
  const afterApproval = await instance.get(created.id);
  assert.equal(afterApproval.steps.find((step) => step.id === 'plan-change').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(afterApproval.pausedAt, originalPausedAt);

  await instance.update(created.id, (plan) => {
    plan.registryFingerprint = originalRegistryFingerprint;
    const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
    checkpoint.status = WorkflowStepStatus.COMPLETED;
    checkpoint.evidence = {
      skill: checkpoint.skill,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      approvedAt: '2026-09-11T00:00:00.000Z'
    };
    const implementation = plan.steps.find((step) => step.id === 'implementation');
    implementation.status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
    plan.pausedAt = null;
  });
  const beforeResume = await instance.get(created.id);
  const originalPolicyFingerprint = beforeResume.projectSkillPolicyFingerprint;
  await instance.update(created.id, (plan) => { plan.projectSkillPolicyFingerprint = 'f'.repeat(64); });
  await assert.rejects(instance.resume(created.id), /project skill policy fingerprint/);
  const afterResume = await instance.get(created.id);
  assert.equal(afterResume.steps.find((step) => step.id === 'implementation').status, WorkflowStepStatus.RUNNING);
  assert.equal(afterResume.status, WorkflowStepStatus.RUNNING);
  assert.notEqual(afterResume.projectSkillPolicyFingerprint, originalPolicyFingerprint);
});


test('app-improvement executes read-only inspection and diagnosis in one run before the human checkpoint', async () => {
  const configured = configFrom({
    id: 'readonly-app',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: {
      allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'],
      deny: []
    }
  });
  const calls = [];
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async execute(request) {
      calls.push(request);
      if (request.skill === 'code.inspect') {
        return { ok: true, status: 'completed', outputBytes: 120, codexThreadId: 'inspect-thread', result: { inspectionEvidence: { summary: 'inspected', relevantPaths: ['src/core.js'] } } };
      }
      return { ok: true, status: 'completed', outputBytes: 100, codexThreadId: 'diagnose-thread', result: { diagnosis: { summary: 'diagnosed', cause: 'fixture' } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Improve one app behavior' });
  const waiting = await instance.run(created.id);

  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.steps.find((step) => step.id === 'inspect-project').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'diagnose').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'plan-change').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].contract.outputs, ['inspectionEvidence']);
  assert.deepEqual(calls[1].contract.outputs, ['diagnosis']);
  assert.equal(calls[1].context.priorEvidence['inspect-project'].inspectionEvidence.summary, 'inspected');
  assert.equal(waiting.outputBytes, 220);
  assert.equal(waiting.steps.find((step) => step.id === 'inspect-project').evidence.codexThreadId, 'inspect-thread');
  assert.equal(waiting.steps.find((step) => step.id === 'diagnose').evidence.codexThreadId, 'diagnose-thread');
});

test('read-only skill executor retries within workflow attempt budget and persists bounded failure evidence', async () => {
  const configured = configFrom({
    id: 'readonly-retry',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      calls += 1;
      return { ok: false, status: 'failed', outputBytes: 25, error: 'invalid structured output from fixture' };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Retry inspection', budgets: { maxAttempts: 2 } });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');

  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.status, WorkflowStepStatus.FAILED);
  assert.equal(step.attempts, 2);
  assert.equal(step.error, 'skill_executor_attempt_budget_exhausted');
  assert.equal(calls, 2);
  assert.equal(failed.outputBytes, 50);
  assert.equal(step.evidence.error, 'invalid structured output from fixture');
});


function changedChangeSet(paths, overrides = {}) {
  const base = {
    paths,
    changedFiles: paths.length,
    additions: overrides.additions ?? paths.length,
    deletions: overrides.deletions ?? 0,
    diffLines: overrides.diffLines ?? paths.length,
    changedBytes: overrides.changedBytes ?? Math.max(1, paths.length * 32),
    maxFileBytes: overrides.maxFileBytes ?? 32,
    sensitiveContent: overrides.sensitiveContent ?? false,
    contentFingerprint: overrides.contentFingerprint ?? '1'.repeat(64)
  };
  return { ...base, changeSetFingerprint: fingerprintChangeSet(base) };
}

async function prepareImplementation(instance, workflowId) {
  await instance.update(workflowId, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture inspection', relevantPaths: ['src/core.js'] } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture diagnosis', cause: 'fixture cause' } };
    completeStep(plan, 'plan-change');
  });
}

test('read-only workflow step fails closed if workspace changes despite read-only sandbox', async () => {
  const configured = configFrom({
    id: 'readonly-integrity',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let snapshots = 0;
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      snapshots += 1;
      return snapshots === 1 ? emptyChangeSet() : changedChangeSet(['src/unexpected.js']);
    }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 20, result: { inspectionEvidence: { summary: 'fixture' } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Inspect only' });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.status, WorkflowStepStatus.FAILED);
  assert.equal(step.error, 'read_only_skill_modified_workspace');
  assert.equal(step.evidence.ok, false);
  assert.notEqual(step.evidence.workspaceBeforeFingerprint, step.evidence.workspaceAfterFingerprint);
});

test('app-improvement implementation completes only after normal governed change evidence and verification', async () => {
  let changeCalls = 0;
  const normalChange = changedChangeSet(['src/feature.js'], { additions: 3, diffLines: 3, changedBytes: 96 });
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : normalChange;
    }
  });
  const codingWorker = {
    async execute(task, options) {
      assert.equal(task.objective, 'Implement safely');
      assert.equal(task.workflow.profile, 'app-improvement');
      assert.ok(task.inspectionEvidence);
      assert.ok(task.diagnosis);
      assert.ok(task.approvedPlanChange?.approvedAt);
      assert.equal(options.workspace.length > 0, true);
      return { status: 'completed', summary: 'implemented', codexThreadId: 'write-thread', output: 'done', outputBytes: 4 };
    }
  };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Implement safely' });
  await prepareImplementation(instance, created.id);
  const result = await instance.run(created.id);
  const implementation = result.steps.find((step) => step.id === 'implementation');
  assert.equal(implementation.status, WorkflowStepStatus.COMPLETED);
  assert.equal(implementation.evidence.ok, true);
  assert.equal(implementation.evidence.workerEvidence.status, 'completed');
  assert.equal(implementation.evidence.changePolicy.classification, 'normal');
  assert.equal(implementation.evidence.changeSetFingerprint, normalChange.changeSetFingerprint);
  assert.equal(result.steps.find((step) => step.id === 'tests').status, WorkflowStepStatus.COMPLETED);
  assert.equal(result.steps.find((step) => step.id === 'verification').status, WorkflowStepStatus.COMPLETED);
  assert.equal(result.steps.find((step) => step.id === 'release-readiness').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(result.status, WorkflowStepStatus.AWAITING_APPROVAL);
});

test('implementation sensitive change blocks before verification', async () => {
  let changeCalls = 0;
  const sensitiveChange = changedChangeSet(['package.json']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : sensitiveChange; } });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'changed package', output: '', outputBytes: 0 }; } };
  let verificationCalls = 0;
  const instance = await engine({
    localGit,
    codingWorker,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Sensitive change' });
  await prepareImplementation(instance, created.id);
  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.error, 'workflow_sensitive_change_requires_approval');
  assert.equal(implementation.evidence.changePolicy.classification, 'sensitive');
  assert.equal(verificationCalls, 0);
  await assert.rejects(instance.approve(created.id, 'implementation'), /not awaiting human approval/);
});

test('implementation forbidden path and budget excess fail closed before verification', async () => {
  for (const fixture of [
    { name: 'forbidden', change: changedChangeSet(['.env']), expectedReason: /forbidden_path/ },
    { name: 'budget', change: changedChangeSet(Array.from({ length: 9 }, (_, index) => `src/file-${index}.js`)), expectedReason: /change_budget_exceeded/ }
  ]) {
    let changeCalls = 0;
    const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : fixture.change; } });
    const codingWorker = { async execute() { return { status: 'completed', summary: fixture.name, output: '', outputBytes: 0 }; } };
    let verificationCalls = 0;
    const instance = await engine({
      localGit,
      codingWorker,
      runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
    });
    const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: fixture.name });
    await prepareImplementation(instance, created.id);
    const failed = await instance.run(created.id);
    const implementation = failed.steps.find((step) => step.id === 'implementation');
    assert.equal(failed.status, WorkflowStepStatus.FAILED);
    assert.equal(implementation.error, 'workflow_change_policy_rejected');
    assert.match(failed.result.reason, fixture.expectedReason);
    assert.equal(verificationCalls, 0);
  }
});

test('failed implementation that leaves changes blocks instead of retrying', async () => {
  let changeCalls = 0;
  const partial = changedChangeSet(['src/partial.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : partial; } });
  let workerCalls = 0;
  const codingWorker = { async execute() { workerCalls += 1; return { status: 'failed', summary: 'failed', output: 'worker error', outputBytes: 12 }; } };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Partial failure' });
  await prepareImplementation(instance, created.id);
  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.error, 'workflow_failed_implementation_left_changes');
  assert.equal(implementation.attempts, 1);
  assert.equal(workerCalls, 1);
});

test('interrupted implementation with observed changes cannot be silently retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-interrupted-implementation-'));
  const configured = managedProject('interrupted-implementation', root, {
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'human.approval', 'project.verify'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changed = changedChangeSet(['src/already-written.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { return changed; } });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Recover safely' });
  await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = plan.steps.find((step) => step.id === 'implementation');
    implementation.status = WorkflowStepStatus.RUNNING;
    implementation.attempts = 1;
    implementation.evidence = {
      type: 'executor-start',
      skill: implementation.skill,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      workspacePath: plan.workspace.path,
      repositoryState: { branch: configured.defaultBranch, head: 'deadbeef', remote: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` },
      workspaceBeforeFingerprint: emptyChangeSet().changeSetFingerprint
    };
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.pausedAt, null);
  assert.equal(implementation.error, 'interrupted_implementation_changes_detected');
  assert.equal(implementation.evidence.changeSetFingerprint, changed.changeSetFingerprint);
  await assert.rejects(instance.approve(created.id, 'implementation'), /not awaiting human approval/);
});


test('implementation with no changes retries only within the workflow attempt budget', async () => {
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return { status: 'completed', summary: 'no-op', output: '', outputBytes: 0 };
    }
  };
  const instance = await engine({ localGit: stableLocalGit(), codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Require a real change', budgets: { maxAttempts: 2 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_no_changes');
  assert.equal(implementation.attempts, 2);
  assert.equal(workerCalls, 2);
});

test('implementation timeout without changes retries only within the workflow attempt budget', async () => {
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return { status: 'failed', timedOut: true, summary: 'timeout', output: 'timeout', outputBytes: 7 };
    }
  };
  const instance = await engine({ localGit: stableLocalGit(), codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Timeout safely', budgets: { maxAttempts: 2 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_timeout');
  assert.equal(implementation.attempts, 2);
  assert.equal(workerCalls, 2);
});

test('implementation output budget exhaustion stops before verification', async () => {
  let changeCalls = 0;
  const normalChange = changedChangeSet(['src/output-budget.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : normalChange; } });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'large output', output: 'x'.repeat(2_000), outputBytes: 2_000 }; } };
  let verificationCalls = 0;
  const instance = await engine({
    localGit,
    codingWorker,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Respect output budget', budgets: { maxOutputBytes: 1_024 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_output_budget_exhausted');
  assert.equal(verificationCalls, 0);
});

test('workflow implementation enforces allowed path scope', async () => {
  let changeCalls = 0;
  const outsideScope = changedChangeSet(['src/other/outside.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : outsideScope; } });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'outside scope', output: '', outputBytes: 0 }; } };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'Stay scoped',
    scope: { allowedPaths: ['src/feature'], forbiddenPaths: [] }
  });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_change_policy_rejected');
  assert.match(failed.result.reason, /scope_violation/);
});


test('verification command that mutates governed implementation diff fails closed', async () => {
  const governed = changedChangeSet(['src/feature.js'], { additions: 2, diffLines: 2, changedBytes: 64 });
  const mutated = changedChangeSet(['src/feature.js', 'src/generated.js'], { additions: 3, diffLines: 3, changedBytes: 96 });
  let changeCalls = 0;
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? governed : mutated;
    }
  });
  let commandCalls = 0;
  const configured = project();
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    runner: async (_project, name) => {
      commandCalls += 1;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Guard verification diff' });
  const workspaceProject = await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture' } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture' } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.changeSet = governed;
    implementation.evidence.workspacePath = workspaceProject.workspace;
  });
  const failed = await instance.run(created.id);
  const testsStep = failed.steps.find((step) => step.id === 'tests');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(testsStep.error, 'workflow_change_set_changed_during_verification');
  assert.equal(testsStep.evidence.expectedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(testsStep.evidence.observedChangeSetFingerprint, mutated.changeSetFingerprint);
  assert.equal(commandCalls, 1);
});


test('verification command that changes repository state fails closed even when the diff fingerprint is unchanged', async () => {
  const governed = changedChangeSet(['src/feature.js'], { additions: 2, diffLines: 2, changedBytes: 64 });
  let commandCalls = 0;
  const localGit = stableLocalGit({
    async inspect(project) {
      return {
        repository: project.workspace,
        remote: `https://github.com/${project.repository.owner}/${project.repository.name}.git`,
        currentBranch: commandCalls === 0 ? project.defaultBranch : 'unexpected-branch',
        initialHead: 'deadbeef',
        status: ''
      };
    },
    async inspectChangeSet() { return governed; }
  });
  const configured = project();
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    runner: async (_project, name) => {
      commandCalls += 1;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Guard repository identity' });
  const workspaceProject = await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture' } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture' } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.changeSet = governed;
    implementation.evidence.workspacePath = workspaceProject.workspace;
    implementation.evidence.repositoryState = { branch: configured.defaultBranch, head: 'deadbeef', remote: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` };
  });
  const failed = await instance.run(created.id);
  const testsStep = failed.steps.find((step) => step.id === 'tests');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(testsStep.error, 'workflow_change_set_integrity_failed_during_verification');
  assert.match(testsStep.evidence.error, /Unexpected current branch/);
  assert.equal(commandCalls, 1);
});
