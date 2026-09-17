import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCloudWorkflowEngine } from '../src/cloud-workflow-engine.js';
import { WorkflowStepStatus } from '../src/core.js';
import { defaultToolSkillRegistry } from '../src/capabilities.js';
import { defaultSpecialistRegistry } from '../src/specialists.js';

const fingerprint = 'a'.repeat(64);

test('tampered or incomplete persisted workflow cannot reach durable checkpoint side effects through get()', async () => {
  const plan = {
    id: 'workflow-invalid-before-write',
    projectId: 'missing-project',
    profile: 'app-improvement',
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
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  instance.store = { async load() { return { workflows: { [plan.id]: plan } }; } };
  instance.projects = new Map();
  instance.registry = defaultToolSkillRegistry;
  instance.specialistRegistry = defaultSpecialistRegistry;
  instance.suppressDurability = 0;
  instance.preparingDurableCheckpoints = new Set();
  let externalPathReached = false;
  instance.ensureDurableReleaseCheckpoint = async () => {
    externalPathReached = true;
    return plan;
  };

  await assert.rejects(() => instance.get(plan.id));
  assert.equal(externalPathReached, false);
});
