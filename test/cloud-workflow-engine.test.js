import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  DurableCloudWorkflowEngine,
  durableCheckpointExternalWrite,
  preserveDurableReleaseEvidence,
  releaseCheckpointCandidate
} from '../src/cloud-workflow-engine.js';
import { WorkflowStepStatus } from '../src/core.js';

const reviewedFingerprint = 'a'.repeat(64);
const baseHead = 'b'.repeat(40);
const durableHead = 'c'.repeat(40);
const remote = 'https://github.com/owner/repo.git';

function releasePlan(overrides = {}) {
  const implementation = {
    id: 'implementation',
    status: WorkflowStepStatus.COMPLETED,
    evidence: {
      changeSetFingerprint: reviewedFingerprint,
      changeSet: { paths: ['src/example.js'] }
    }
  };
  const review = {
    id: 'review',
    status: WorkflowStepStatus.COMPLETED,
    evidence: {
      result: { reviewEvidence: { verdict: 'PASS' } },
      reviewedChangeSetFingerprint: reviewedFingerprint
    }
  };
  const release = {
    id: 'release-readiness',
    status: WorkflowStepStatus.PENDING,
    dependsOn: ['review'],
    evidence: null
  };
  return {
    id: 'workflow-cloud-continuity',
    profile: 'app-improvement',
    steps: [implementation, review, release],
    ...overrides
  };
}

test('durable release checkpoint is eligible only for the exact reviewed change set', () => {
  const plan = releasePlan();
  const candidate = releaseCheckpointCandidate(plan);
  assert.ok(candidate);
  assert.equal(candidate.changeSetFingerprint, reviewedFingerprint);

  const staleReview = structuredClone(plan);
  staleReview.steps.find((step) => step.id === 'review').evidence.reviewedChangeSetFingerprint = 'd'.repeat(64);
  assert.equal(releaseCheckpointCandidate(staleReview), null);

  const failedReview = structuredClone(plan);
  failedReview.steps.find((step) => step.id === 'review').evidence.result.reviewEvidence.verdict = 'FAIL';
  assert.equal(releaseCheckpointCandidate(failedReview), null);

  const alreadyDurable = structuredClone(plan);
  alreadyDurable.steps.find((step) => step.id === 'release-readiness').evidence = { durableCheckpoint: { commit: { finalHead: durableHead } } };
  assert.equal(releaseCheckpointCandidate(alreadyDurable), null);
});

test('release approval preserves the exact durable commit sha', () => {
  const checkpoint = {
    version: 1,
    changeSetFingerprint: reviewedFingerprint,
    branch: 'agent/workflow-cloud-continuity',
    baseHead,
    commit: { finalHead: durableHead }
  };
  const evidence = preserveDurableReleaseEvidence({ approvedChangeSetFingerprint: reviewedFingerprint }, checkpoint);
  assert.equal(evidence.approvedChangeSetFingerprint, reviewedFingerprint);
  assert.equal(evidence.approvedCommitSha, durableHead);
  assert.deepEqual(evidence.durableCheckpoint, checkpoint);

  const malformed = preserveDurableReleaseEvidence({ safe: true }, { commit: { finalHead: 'not-a-sha' } });
  assert.deepEqual(malformed, { safe: true });
});

test('dry-run authority description exposes the pre-approval durable branch write', () => {
  assert.deepEqual(durableCheckpointExternalWrite(), {
    id: 'release-readiness-durable-checkpoint',
    skill: 'release.publish-reviewed-workflow',
    specialist: 'release-manager',
    purpose: 'Persist the exact reviewed change on the non-protected working branch before the final release-readiness approval.'
  });
});

function continuityFixture({ checkpoint = null, observedRemoteHead = durableHead } = {}) {
  const workspacePath = resolve(join(tmpdir(), `agent-cloud-workspace-does-not-exist-${process.pid}-${Math.random().toString(16).slice(2)}`));
  const branch = 'agent/workflow-cloud-continuity';
  const plan = {
    id: 'workflow-cloud-continuity',
    deadlineAt: 60_000,
    workspace: {
      managed: true,
      path: workspacePath,
      workingBranch: branch,
      baseHead,
      remote
    },
    steps: checkpoint ? [{ id: 'release-readiness', evidence: { durableCheckpoint: checkpoint } }] : []
  };
  const project = {
    id: 'self',
    workspaceStrategy: 'managed',
    workspace: '.',
    managedWorkspaceRoot: resolve(join(tmpdir(), 'agent-cloud-workspaces')),
    budgets: { commandTimeoutMs: 30_000 }
  };
  const calls = [];
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.store = { async load() { return { workflows: { [plan.id]: plan } }; } };
  instance.now = () => 0;
  instance.workspaceManager = {
    describe() { return { workspace: workspacePath, managed: true, retained: true }; },
    async prepare(_project, runId, options) {
      calls.push(['prepare', runId, options]);
      return { workspace: workspacePath, managed: true, retained: true };
    }
  };
  instance.localGit = {
    async inspect() {
      calls.push(['inspect']);
      return { remote, currentBranch: 'main', initialHead: baseHead, status: '' };
    },
    async prepareWorkingBranch(_project, runId, expectedBase) {
      calls.push(['prepareWorkingBranch', runId, expectedBase]);
      return { workingBranch: branch, initialHead: baseHead, remote };
    },
    async git(args) {
      calls.push(['git', ...args]);
      if (args[0] === 'rev-parse') return { stdout: `${observedRemoteHead}\n` };
      return { stdout: '' };
    },
    async assertRepositoryState(_project, expected) {
      calls.push(['assertRepositoryState', expected]);
      return expected;
    }
  };
  return { instance, plan, project, calls, branch, workspacePath };
}

test('new cloud runner reconstructs the clean working branch before implementation', async () => {
  const { instance, plan, project, calls, workspacePath, branch } = continuityFixture();
  const hydrated = await instance.workspaceProject(plan.id, project);
  assert.equal(hydrated.workspace, workspacePath);
  assert.ok(calls.some((call) => call[0] === 'prepare'));
  assert.deepEqual(calls.find((call) => call[0] === 'prepareWorkingBranch'), ['prepareWorkingBranch', plan.id, baseHead]);
  assert.equal(calls.some((call) => call[0] === 'git'), false);
  assert.equal(branch, plan.workspace.workingBranch);
});

test('new cloud runner rehydrates an approved durable branch from the exact remote sha', async () => {
  const checkpoint = {
    version: 1,
    changeSetFingerprint: reviewedFingerprint,
    branch: 'agent/workflow-cloud-continuity',
    baseHead,
    commit: { finalHead: durableHead }
  };
  const { instance, plan, project, calls } = continuityFixture({ checkpoint });
  await instance.workspaceProject(plan.id, project);

  assert.ok(calls.some((call) => call[0] === 'git' && call[1] === 'fetch'));
  assert.ok(calls.some((call) => call[0] === 'git' && call[1] === 'rev-parse'));
  assert.ok(calls.some((call) => call[0] === 'git' && call[1] === 'switch' && call.includes(plan.workspace.workingBranch)));
  const assertion = calls.find((call) => call[0] === 'assertRepositoryState');
  assert.equal(assertion[1].head, durableHead);
  assert.equal(assertion[1].branch, plan.workspace.workingBranch);
});

test('cloud rehydration fails closed if the remote working branch moved', async () => {
  const checkpoint = {
    version: 1,
    changeSetFingerprint: reviewedFingerprint,
    branch: 'agent/workflow-cloud-continuity',
    baseHead,
    commit: { finalHead: durableHead }
  };
  const { instance, plan, project, calls } = continuityFixture({ checkpoint, observedRemoteHead: 'd'.repeat(40) });
  await assert.rejects(() => instance.workspaceProject(plan.id, project), /durable_checkpoint_remote_head_changed/);
  assert.equal(calls.some((call) => call[0] === 'git' && call[1] === 'switch'), false);
});

test('capped durable run performs interrupted read-only recovery before normal execution', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  const calls = [];
  instance.recoverInterruptedReadOnlyStepForRun = async (id, options) => {
    calls.push(['recover', id, options.deadlineCapAt]);
    return { id, status: WorkflowStepStatus.BLOCKED, result: { historicalRecovery:true } };
  };
  instance.store = {
    async withExecutionLease(collection, id, kind, operation, options) {
      calls.push(['lease', collection, id, kind, options.deadlineAt]);
      return operation();
    }
  };

  const result = await instance.run('workflow-stale-readonly', { deadlineCapAt: 1_000 });

  assert.equal(result.status, WorkflowStepStatus.BLOCKED);
  assert.equal(result.result.historicalRecovery, true);
  assert.deepEqual(calls, [
    ['lease', 'workflows', 'workflow-stale-readonly', 'workflow', 1_000],
    ['recover', 'workflow-stale-readonly', 1_000]
  ]);
});

test('durable deadline cap blocks get and resume before any prework when already expired', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 10_000;
  let loads = 0;
  let leases = 0;
  let mutations = 0;
  instance.store = {
    async load() { loads += 1; return { workflows: {} }; },
    async mutate() { mutations += 1; throw new Error('unexpected_mutation'); },
    async withExecutionLease() { leases += 1; throw new Error('unexpected_lease'); }
  };

  await assert.rejects(
    () => instance.get('workflow-expired', { deadlineCapAt: 9_999 }),
    /workflow_deadline_cap_exceeded/
  );
  await assert.rejects(
    () => instance.resume('workflow-expired', { deadlineCapAt: 9_999 }),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(loads, 0);
  assert.equal(mutations, 0);
  assert.equal(leases, 0);
});

test('durable get rechecks the cap after a slow store read before checkpoint prework', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let checkpointCalls = 0;
  instance.now = () => now;
  instance.store = {
    async load() {
      now = 2_000;
      return { workflows: { slow: releasePlan({ id: 'slow' }) } };
    }
  };
  instance.ensureDurableReleaseCheckpoint = async () => {
    checkpointCalls += 1;
    throw new Error('unexpected_checkpoint');
  };

  await assert.rejects(
    () => instance.get('slow', { deadlineCapAt: 1_000 }),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(checkpointCalls, 0);
});

test('explicit durable get keeps its deadline context active through nested prework', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let mutations = 0;
  instance.now = () => now;
  instance.store = {
    async mutate() {
      mutations += 1;
      throw new Error('unexpected_mutation');
    }
  };

  await assert.rejects(
    () => instance.withExecutionDeadlineCap('nested-get', 1_000, async () => {
      assert.equal(instance.executionDeadlineContext.getStore().get('nested-get'), 1_000);
      now = 2_000;
      await instance.update('nested-get', () => {});
    }),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(mutations, 0);

  const source = readFileSync(new URL('../src/cloud-workflow-engine.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /options\.deadlineCapAt[\s\S]*withExecutionDeadlineCap\([\s\S]*\(\) => this\.get\(id\)/
  );
});

test('capped resume enforces its deadline inside execution-lease persistence', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let observed = null;
  instance.now = () => now;
  instance.store = {
    async withExecutionLease(collection, id, kind, _operation, options) {
      observed = { collection, id, kind, options };
      now = 2_000;
      await options.beforeClaimCommit();
      throw new Error('unexpected_resume_after_deadline');
    }
  };

  await assert.rejects(
    () => instance.resume('resume-deadline', { deadlineCapAt: 1_000 }),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(observed.collection, 'workflows');
  assert.equal(observed.id, 'resume-deadline');
  assert.equal(observed.kind, 'workflow');
  assert.equal(observed.options.deadlineAt, 1_000);
  assert.equal(typeof observed.options.beforeClaimCommit, 'function');
});

test('nested resume uses the effective earlier deadline for its lease claim', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  let observedDeadline = null;
  instance.store = {
    async withExecutionLease(_collection, _id, _kind, _operation, options) {
      observedDeadline = options.deadlineAt;
      throw new Error('stop_after_observation');
    }
  };

  await assert.rejects(
    () => instance.withExecutionDeadlineCap(
      'nested-resume',
      1_000,
      () => instance.resume('nested-resume', { deadlineCapAt: 5_000 })
    ),
    /stop_after_observation/
  );
  assert.equal(observedDeadline, 1_000);
});

test('durable deadline context protects internal updates during resume prework', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let mutations = 0;
  instance.now = () => now;
  instance.store = {
    async withExecutionLease(_scope, _id, _kind, task) {
      now = 2_000;
      return task();
    },
    async mutate() {
      mutations += 1;
      throw new Error('unexpected_mutation');
    }
  };

  await assert.rejects(
    () => instance.resume('slow-resume', { deadlineCapAt: 1_000 }),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(mutations, 0);
});

test('durable update rechecks the active cap inside the store mutation', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let saved = false;
  instance.now = () => now;
  instance.store = {
    async mutate(mutator) {
      now = 2_000;
      const data = { workflows: { guarded: { id: 'guarded' } } };
      mutator(data);
      saved = true;
      return data.workflows.guarded;
    }
  };

  await assert.rejects(
    () => instance.withExecutionDeadlineCap(
      'guarded',
      1_000,
      () => instance.update('guarded', () => {})
    ),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(saved, false);
});

test('overlapping deadline contexts for the same workflow remain async-isolated', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;

  let releaseA;
  let releaseB;
  let startedA;
  let startedB;
  const aStarted = new Promise((resolve) => { startedA = resolve; });
  const bStarted = new Promise((resolve) => { startedB = resolve; });
  const waitA = new Promise((resolve) => { releaseA = resolve; });
  const waitB = new Promise((resolve) => { releaseB = resolve; });

  const a = instance.withExecutionDeadlineCap('shared', 1_000, async () => {
    assert.equal(instance.executionDeadlineCap('shared'), 1_000);
    startedA();
    await waitA;
    assert.equal(instance.executionDeadlineCap('shared'), 1_000);
  });
  await aStarted;

  const b = instance.withExecutionDeadlineCap('shared', 500, async () => {
    assert.equal(instance.executionDeadlineCap('shared'), 500);
    startedB();
    await waitB;
    assert.equal(instance.executionDeadlineCap('shared'), 500);
  });
  await bStarted;

  releaseA();
  await a;
  assert.equal(instance.executionDeadlineCap('shared'), null);

  releaseB();
  await b;
  assert.equal(instance.executionDeadlineCap('shared'), null);
});

test('durable publication threads the active deadline into commit and push contexts', () => {
  const source = readFileSync(new URL('../src/cloud-workflow-engine.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /publicationBridge\.commit\([\s\S]*deadlineAt: this\.executionDeadlineCap\(id, deadlineCapAt\)/
  );
  assert.match(
    source,
    /publicationBridge\.push\([\s\S]*deadlineAt: this\.executionDeadlineCap\(id, deadlineCapAt\)/
  );
  assert.match(
    source,
    /withExecutionLease\([\s\S]*deadlineAt: this\.executionDeadlineCap\(id, options\.deadlineCapAt\)/
  );
});

test('nested durable approve uses the effective earlier deadline for its lease claim', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let observed = null;
  instance.now = () => now;
  instance.store = {
    async withExecutionLease(collection, id, kind, _operation, options) {
      observed = { collection, id, kind, options };
      now = 2_000;
      await options.beforeClaimCommit();
      throw new Error('unexpected_approval_after_deadline');
    }
  };

  await assert.rejects(
    () => instance.withExecutionDeadlineCap(
      'approve-deadline',
      1_000,
      () => instance.approve('approve-deadline', 'checkpoint', { deadlineCapAt: 5_000 })
    ),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(observed.collection, 'workflows');
  assert.equal(observed.id, 'approve-deadline');
  assert.equal(observed.kind, 'workflow');
  assert.equal(observed.options.deadlineAt, 1_000);
  assert.equal(typeof observed.options.beforeClaimCommit, 'function');
});

test('nested durable cancel uses the effective earlier deadline for its lease claim', async () => {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  let now = 0;
  let observed = null;
  instance.now = () => now;
  instance.store = {
    async withExecutionLease(collection, id, kind, _operation, options) {
      observed = { collection, id, kind, options };
      now = 2_000;
      await options.beforeClaimCommit();
      throw new Error('unexpected_cancel_after_deadline');
    }
  };

  await assert.rejects(
    () => instance.withExecutionDeadlineCap(
      'cancel-deadline',
      1_000,
      () => instance.cancel('cancel-deadline', { reason: 'issue_queue_blocked', deadlineCapAt: 5_000 })
    ),
    /workflow_deadline_cap_exceeded/
  );
  assert.equal(observed.collection, 'workflows');
  assert.equal(observed.id, 'cancel-deadline');
  assert.equal(observed.kind, 'workflow');
  assert.equal(observed.options.deadlineAt, 1_000);
  assert.equal(typeof observed.options.beforeClaimCommit, 'function');
});

test('base approve and cancel thread deadline options through lease and persistence boundaries', () => {
  const core = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  assert.match(core, /async approve\(id, stepId, options = \{\}\)[\s\S]*beforeClaimCommit:[\s\S]*deadlineAt: deadlineCapAt/);
  assert.match(core, /async cancel\(id,[\s\S]*beforeLeaseClaimCommit[\s\S]*beforeClaimCommit: beforeLeaseClaimCommit[\s\S]*deadlineAt: deadlineCapAt/);
  assert.match(core, /approveUnlocked\(id, stepId,[\s\S]*beforeCommit[\s\S]*deadlineAt: deadlineCapAt/);
});

test('cloud CLI wires durable continuity only into cloud inbox actions', () => {
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(cli, /import \{ DurableCloudWorkflowEngine \} from '\.\/cloud-workflow-engine\.js';/);
  assert.match(cli, /const activeWorkflows = cloudAction\n\s+\? new DurableCloudWorkflowEngine\(\{ store: activeStore, projects, \.\.\.workflowModelExecutors \}\)\n\s+: workflows;/);
  assert.match(cli, /const workflows = new WorkflowEngine\(\{ store, projects, \.\.\.workflowModelExecutors \}\);/);
  assert.match(pkg.scripts.typecheck, /node --check src\/cloud-workflow-engine\.js/);
});

test('cloud workflow rebinds stale managed workspace evidence to the current managed root', async () => {
  const id = 'workflow-portable';
  const staleRoot = resolve(join(tmpdir(), 'old-agent-root'));
  const currentRoot = resolve(join(tmpdir(), 'current-agent-root'));
  const project = {
    id: 'self',
    workspaceStrategy: 'managed',
    managedWorkspaceRoot: currentRoot,
    repository: { owner: 'owner', name: 'repo' },
    protectedBranches: ['main'],
    workingBranchPattern: 'agent/{runId}'
  };
  const state = {
    workflows: {
      [id]: {
        id,
        projectId: 'self',
        profile: 'data-analysis',
        workspace: {
          path: resolve(staleRoot, 'self', id),
          managed: true,
          projectId: 'self',
          repository: { owner: 'owner', name: 'repo' },
          initializedAt: '2026-09-25T00:00:00.000Z'
        },
        steps: []
      }
    }
  };
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.projects = new Map([['self', project]]);
  instance.workspaceManager = {
    describe() { return { workspace: resolve(currentRoot, 'self', id), managed: true }; }
  };
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  instance.store = {
    async load() { return state; },
    async mutate(mutator) { return mutator(state); }
  };

  const rebound = await instance.get(id);
  assert.equal(rebound.workspace.path, resolve(currentRoot, 'self', id));
  assert.equal(rebound.workspace.projectId, 'self');
  assert.deepEqual(rebound.workspace.repository, { owner: 'owner', name: 'repo' });
});

test('cloud workflow moves an exact clean managed workspace into the current runner root', async (t) => {
  const id = 'workflow-portable-existing-clean';
  const staleRoot = mkdtempSync(join(tmpdir(), 'old-agent-root-existing-'));
  const currentRoot = mkdtempSync(join(tmpdir(), 'current-agent-root-existing-'));
  t.after(() => {
    rmSync(staleRoot, { recursive: true, force: true });
    rmSync(currentRoot, { recursive: true, force: true });
  });
  const source = resolve(staleRoot, 'self', id);
  const target = resolve(currentRoot, 'self', id);
  mkdirSync(source, { recursive: true });
  const branch = 'agent/' + id;
  const head = 'd'.repeat(40);
  const project = {
    id: 'self',
    workspaceStrategy: 'managed',
    managedWorkspaceRoot: currentRoot,
    repository: { owner: 'owner', name: 'repo' },
    protectedBranches: ['main'],
    workingBranchPattern: 'agent/{runId}'
  };
  const state = {
    workflows: {
      [id]: {
        id,
        projectId: 'self',
        profile: 'data-analysis',
        workspace: { path: source, managed: true, projectId: 'self', repository: { owner: 'owner', name: 'repo' }, initializedAt: '2026-09-25T00:00:00.000Z', workingBranch: branch, baseHead: head, remote },
        steps: []
      }
    }
  };
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.projects = new Map([['self', project]]);
  instance.workspaceManager = { describe() { return { workspace: target, projectDirectory: resolve(currentRoot, 'self'), managed: true }; } };
  instance.localGit = {
    async inspect(workspaceProject) {
      assert.equal(resolve(workspaceProject.workspace), source);
      return { repository: source, remote, currentBranch: branch, initialHead: head, status: '' };
    }
  };
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  instance.store = { async load() { return state; }, async mutate(mutator) { return mutator(state); } };

  const rebound = await instance.get(id);
  assert.equal(rebound.workspace.path, target);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(target), true);
});

test('cloud workflow refuses to move an existing portable workspace with local changes', async (t) => {
  const id = 'workflow-portable-existing-dirty';
  const staleRoot = mkdtempSync(join(tmpdir(), 'old-agent-root-dirty-'));
  const currentRoot = mkdtempSync(join(tmpdir(), 'current-agent-root-dirty-'));
  t.after(() => {
    rmSync(staleRoot, { recursive: true, force: true });
    rmSync(currentRoot, { recursive: true, force: true });
  });
  const source = resolve(staleRoot, 'self', id);
  const target = resolve(currentRoot, 'self', id);
  mkdirSync(source, { recursive: true });
  const branch = 'agent/' + id;
  const head = 'e'.repeat(40);
  const project = {
    id: 'self', workspaceStrategy: 'managed', managedWorkspaceRoot: currentRoot,
    repository: { owner: 'owner', name: 'repo' }, protectedBranches: ['main'], workingBranchPattern: 'agent/{runId}'
  };
  const state = { workflows: { [id]: { id, projectId: 'self', profile: 'data-analysis', workspace: { path: source, managed: true, projectId: 'self', repository: { owner: 'owner', name: 'repo' }, initializedAt: '2026-09-25T00:00:00.000Z', workingBranch: branch, baseHead: head, remote }, steps: [] } } };
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.projects = new Map([['self', project]]);
  instance.workspaceManager = { describe() { return { workspace: target, projectDirectory: resolve(currentRoot, 'self'), managed: true }; } };
  instance.localGit = { async inspect() { return { repository: source, remote, currentBranch: branch, initialHead: head, status: ' M src/core.js' }; } };
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  instance.store = { async load() { return state; }, async mutate(mutator) { return mutator(state); } };

  await assert.rejects(() => instance.get(id), /cloud_workspace_rebind_source_changed/);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(target), false);
});

test('cloud workflow refuses to rebind arbitrary external workspace evidence', async () => {
  const id = 'workflow-portable';
  const currentRoot = resolve(join(tmpdir(), 'current-agent-root-reject'));
  const project = {
    id: 'self',
    workspaceStrategy: 'managed',
    managedWorkspaceRoot: currentRoot,
    repository: { owner: 'owner', name: 'repo' },
    protectedBranches: ['main'],
    workingBranchPattern: 'agent/{runId}'
  };
  const state = {
    workflows: {
      [id]: {
        id,
        projectId: 'self',
        profile: 'data-analysis',
        workspace: {
          path: resolve(tmpdir(), 'untrusted-parent', id),
          managed: true,
          projectId: 'self',
          repository: { owner: 'owner', name: 'repo' },
          initializedAt: '2026-09-25T00:00:00.000Z'
        },
        steps: []
      }
    }
  };
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.projects = new Map([['self', project]]);
  instance.workspaceManager = {
    describe() { return { workspace: resolve(currentRoot, 'self', id), managed: true }; }
  };
  instance.preparingDurableCheckpoints = new Set();
  instance.suppressDurability = 0;
  instance.now = () => 0;
  instance.store = {
    async load() { return state; },
    async mutate(mutator) { return mutator(state); }
  };

  await assert.rejects(() => instance.get(id), /cloud_workspace_rebind_evidence_invalid/);
});


test('durable workflow remaining time honors the active inherited deadline cap', async () => {
  const engine = Object.create(DurableCloudWorkflowEngine.prototype);
  engine.now = () => 1_000;
  engine.executionDeadlineContext = null;
  const plan = { id: 'workflow-drain-cap', deadlineAt: 20_000 };

  const uncapped = engine.remainingMs(plan);
  const capped = await engine.withExecutionDeadlineCap(
    plan.id,
    6_000,
    async () => engine.remainingMs(plan)
  );

  assert.equal(uncapped, 19_000);
  assert.equal(capped, 5_000);
});
