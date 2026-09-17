import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCloudWorkflowEngine } from '../src/cloud-workflow-engine.js';
import { WorkflowStepStatus } from '../src/core.js';

const fingerprint = 'a'.repeat(64);
const baseHead = 'b'.repeat(40);
const commitHead = 'c'.repeat(40);
const branch = 'agent/workflow-publication-preflight';

function publicationPlan({ releaseStatus = WorkflowStepStatus.COMPLETED, attempts = 0, maxAttempts = 2 } = {}) {
  const checkpoint = {
    version: 1,
    changeSetFingerprint: fingerprint,
    branch,
    baseHead,
    commit: { finalHead: commitHead },
    push: { branch, finalHead: commitHead, remoteBranchHead: commitHead }
  };
  const publication = {
    id: 'publication',
    skill: 'release.publish-reviewed-workflow',
    status: WorkflowStepStatus.READY,
    attempts,
    evidence: null
  };
  return {
    id: 'workflow-publication-preflight',
    profile: 'app-improvement',
    budgets: { maxAttempts },
    workspace: {
      managed: true,
      workingBranch: branch,
      baseHead,
      remote: 'https://github.com/owner/repo.git'
    },
    steps: [
      {
        id: 'implementation',
        status: WorkflowStepStatus.COMPLETED,
        evidence: { changeSetFingerprint: fingerprint }
      },
      {
        id: 'review',
        status: WorkflowStepStatus.COMPLETED,
        evidence: {
          result: { reviewEvidence: { verdict: 'PASS' } },
          reviewedChangeSetFingerprint: fingerprint
        }
      },
      {
        id: 'release-readiness',
        status: releaseStatus,
        evidence: {
          approvedCommitSha: commitHead,
          approvedChangeSetFingerprint: fingerprint,
          durableCheckpoint: checkpoint
        }
      },
      publication
    ]
  };
}

function engineFor(plan) {
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.store = { async load() { return { workflows: { [plan.id]: plan } }; } };
  let externalTouched = false;
  instance.publicationBridge = {
    async inspectBase() { externalTouched = true; return {}; },
    async verifyRemoteBranch() { externalTouched = true; return { ok: true }; },
    async createPullRequest() { externalTouched = true; return { number: 1 }; }
  };
  instance.stopPublication = async (_id, _stepId, error, options) => ({ error, options });
  return { instance, externalTouched: () => externalTouched };
}

test('durable publication cannot write a PR before release-readiness is completed', async () => {
  const plan = publicationPlan({ releaseStatus: WorkflowStepStatus.AWAITING_APPROVAL });
  const next = plan.steps.find((step) => step.id === 'publication');
  const { instance, externalTouched } = engineFor(plan);
  const result = await instance.executePublicationWorkflowStep(plan.id, {}, next);
  assert.equal(result.error, 'workflow_publication_durable_checkpoint_invalid');
  assert.equal(externalTouched(), false);
});

test('durable publication attempt budget is enforced before any PR observation or write', async () => {
  const plan = publicationPlan({ attempts: 2, maxAttempts: 2 });
  const next = plan.steps.find((step) => step.id === 'publication');
  const { instance, externalTouched } = engineFor(plan);
  const result = await instance.executePublicationWorkflowStep(plan.id, {}, next);
  assert.equal(result.error, 'workflow_publication_attempt_budget_exhausted');
  assert.equal(externalTouched(), false);
});
