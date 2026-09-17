import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCloudWorkflowEngine } from '../src/cloud-workflow-engine.js';

const baseHead = 'a'.repeat(40);
const remoteHead = 'b'.repeat(40);
const fingerprint = 'c'.repeat(64);
const branch = 'agent/workflow-parent-check';
const remoteUrl = 'https://github.com/owner/repo.git';

function recoveryFixture(parentHead = baseHead) {
  const calls = [];
  const instance = Object.create(DurableCloudWorkflowEngine.prototype);
  const workspaceProject = { workspace: '/tmp/fake-workspace' };
  instance.workspaceProject = async () => workspaceProject;
  let changeSetInspection = 0;
  instance.localGit = {
    async inspectChangeSet() {
      changeSetInspection += 1;
      return changeSetInspection === 1
        ? { paths: [] }
        : { paths: ['src/example.js'], changeSetFingerprint: fingerprint };
    },
    async git(args) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: `${remoteHead}\n` };
      if (args[0] === 'rev-list') return { stdout: `${remoteHead} ${parentHead}\n` };
      return { stdout: '' };
    },
    async assertRepositoryState(_project, expected) {
      calls.push(['assert', expected]);
      return expected;
    }
  };
  const plan = {
    workspace: {
      workingBranch: branch,
      baseHead,
      remote: remoteUrl
    }
  };
  const candidate = {
    release: { id: 'release-readiness' },
    changeSetFingerprint: fingerprint,
    implementation: { evidence: { changeSet: { paths: ['src/example.js'] } } }
  };
  return { instance, plan, candidate, calls };
}

test('remote checkpoint recovery accepts only a single direct parent equal to approved base', async () => {
  const { instance, plan, candidate, calls } = recoveryFixture();
  const recovered = await instance.recoverRemoteCheckpoint('workflow-parent-check', {}, plan, candidate, { head: remoteHead });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.commit.finalHead, remoteHead);
  assert.equal(recovered.commit.committedChangeSetFingerprint, fingerprint);
  assert.ok(calls.some((args) => args[0] === 'rev-list' && args[1] === '--parents'));
  assert.ok(calls.some((args) => args[0] === 'reset' && args[1] === '--mixed' && args[2] === baseHead));
});

test('remote checkpoint recovery rejects a matching tree carried by an unexpected parent', async () => {
  const { instance, plan, candidate, calls } = recoveryFixture('d'.repeat(40));
  await assert.rejects(
    () => instance.recoverRemoteCheckpoint('workflow-parent-check', {}, plan, candidate, { head: remoteHead }),
    /durable_checkpoint_remote_parent_mismatch/
  );
  assert.ok(calls.some((args) => args[0] === 'rev-list'));
  assert.equal(calls.some((args) => args[0] === 'reset'), false);
});

test('remote checkpoint recovery rejects merge commits even if one parent is the approved base', async () => {
  const { instance, plan, candidate, calls } = recoveryFixture();
  instance.localGit.git = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: `${remoteHead}\n` };
    if (args[0] === 'rev-list') return { stdout: `${remoteHead} ${baseHead} ${'e'.repeat(40)}\n` };
    return { stdout: '' };
  };
  await assert.rejects(
    () => instance.recoverRemoteCheckpoint('workflow-parent-check', {}, plan, candidate, { head: remoteHead }),
    /durable_checkpoint_remote_parent_mismatch/
  );
  assert.equal(calls.some((args) => args[0] === 'reset'), false);
});
