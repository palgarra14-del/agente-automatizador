import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCloudWorkflowEngine, durableCheckpointExternalWrite } from '../src/cloud-workflow-engine.js';
import { WorkflowStepStatus } from '../src/core.js';

const fingerprint = 'a'.repeat(64);
const baseHead = 'b'.repeat(40);

function candidatePlan() {
  return {
    id: 'workflow-capability-gate',
    projectId: 'self',
    profile: 'app-improvement',
    workspace: {
      managed: true,
      path: '/tmp/workflow-capability-gate',
      workingBranch: 'agent/workflow-capability-gate',
      baseHead,
      remote: 'https://github.com/owner/repo.git'
    },
    steps: [
      {
        id: 'implementation',
        status: WorkflowStepStatus.COMPLETED,
        evidence: { changeSetFingerprint: fingerprint, changeSet: { paths: ['src/example.js'] } }
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
        status: WorkflowStepStatus.PENDING,
        dependsOn: ['review'],
        evidence: null
      }
    ]
  };
}

test('durable checkpoint declares the same workflow publication authority it enforces', () => {
  assert.equal(durableCheckpointExternalWrite().skill, 'release.publish-reviewed-workflow');
});

test('durable checkpoint performs no external observation or write when publication capability is unavailable', async () => {
  const plan = candidatePlan();
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.store = { async load() { return { workflows: { [plan.id]: plan } }; } };
  instance.projects = new Map([['self', {
    id: 'self',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main'
  }]]);
  const resolved = [];
  instance.registry = {
    resolve(project, skill, options) {
      resolved.push({ project: project.id, skill, surface: options.surface });
      return { id: skill, available: false, reason: 'skill_not_allowed' };
    }
  };
  let externalTouched = false;
  instance.publicationBridge = {
    async inspectBase() { externalTouched = true; throw new Error('must not be called'); }
  };
  instance.blockDurability = async (_id, error, detail) => ({ blocked: true, error, detail });

  const result = await instance.ensureDurableReleaseCheckpoint(plan.id);
  assert.deepEqual(resolved, [{ project: 'self', skill: 'release.publish-reviewed-workflow', surface: 'workflow' }]);
  assert.equal(externalTouched, false);
  assert.equal(result.blocked, true);
  assert.equal(result.error, 'durable_checkpoint_publication_capability_unavailable');
  assert.equal(result.detail, 'skill_not_allowed');
});
