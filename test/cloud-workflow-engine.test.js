import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    skill: 'repository.publish',
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

test('cloud CLI wires durable continuity only into cloud inbox actions', () => {
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(cli, /import \{ DurableCloudWorkflowEngine \} from '\.\/cloud-workflow-engine\.js';/);
  assert.match(cli, /const activeWorkflows = cloudAction\n\s+\? new DurableCloudWorkflowEngine\(\{ store: activeStore, projects \}\)\n\s+: workflows;/);
  assert.match(cli, /const workflows = new WorkflowEngine\(\{ store, projects \}\);/);
  assert.match(pkg.scripts.typecheck, /node --check src\/cloud-workflow-engine\.js/);
});
