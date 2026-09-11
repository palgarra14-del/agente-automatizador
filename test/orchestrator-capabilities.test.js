import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, Orchestrator, RunStatus, configFrom } from '../src/core.js';

async function store() {
  return new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-capability-orchestrator-')), 'state.json'));
}

function project(skills) {
  return configFrom({
    id: 'capability-orchestrator',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { install: 'node --version', test: 'node --version' },
    acceptance: { require: ['install', 'test', 'ci'] },
    deployment: { provider: 'none' },
    execution: { provider: 'local-sanitized' },
    skills
  });
}

test('orchestrator persists registry and project-policy fingerprints on a run', async () => {
  const configured = project({
    allow: ['project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'code.implement', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  const orchestrator = new Orchestrator({ store: await store() });
  const run = await orchestrator.create(configured, 'Record capabilities');
  assert.equal(typeof run.registryFingerprint, 'string');
  assert.equal(run.registryFingerprint.length, 64);
  assert.equal(typeof run.projectSkillPolicyFingerprint, 'string');
  assert.equal(run.projectSkillPolicyFingerprint.length, 64);
});

test('orchestrator rejects a saved run after project capability policy changes', async () => {
  const original = project({
    allow: ['project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'code.implement', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  const orchestrator = new Orchestrator({ store: await store() });
  const run = await orchestrator.create(original, 'Freeze capabilities');
  const changed = project({
    allow: ['project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'code.implement', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  assert.throws(() => orchestrator.assertRunCapabilityContext(run, changed), /project_skill_policy_changed/);
});

test('repository observation gate fails before GitHub inspection', async () => {
  const configured = project({
    allow: ['workspace.prepare', 'project.bootstrap', 'project.verify', 'human.approval', 'code.implement', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  let inspected = 0;
  const github = { async inspect() { inspected += 1; return {}; } };
  const orchestrator = new Orchestrator({ store: await store(), github });
  const run = await orchestrator.create(configured, 'Do not inspect');
  await assert.rejects(orchestrator.initializeWorkspace(run, configured), /capability_unavailable:repository.observe:skill_not_allowed/);
  assert.equal(inspected, 0);
});

test('coding gate fails before worker or local git is touched', async () => {
  const configured = project({
    allow: ['project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  let workerCalls = 0;
  let gitCalls = 0;
  const worker = { async execute() { workerCalls += 1; return { status: 'completed' }; } };
  const localGit = new Proxy({}, { get() { return async () => { gitCalls += 1; throw new Error('git should not run'); }; } });
  const orchestrator = new Orchestrator({ store: await store(), worker, localGit });
  const run = await orchestrator.create(configured, 'Do not code');
  run.status = RunStatus.WORKING;
  run.workingBranch = 'agent/test';
  run.plan = { codingTask: {} };
  await assert.rejects(orchestrator.executeAttempt(run, configured), /capability_unavailable:code.implement:skill_not_allowed/);
  assert.equal(workerCalls, 0);
  assert.equal(gitCalls, 0);
});

test('pull request publication gate fails before GitHub write', async () => {
  const configured = project({
    allow: ['project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'code.implement', 'release.observe-ci'],
    deny: []
  });
  let writes = 0;
  const github = { async createPullRequest() { writes += 1; return {}; } };
  const orchestrator = new Orchestrator({ store: await store(), github });
  const run = await orchestrator.create(configured, 'Do not publish PR');
  run.workingBranch = 'agent/test';
  await assert.rejects(orchestrator.createPullRequest(run, configured), /capability_unavailable:release.publish-pr:skill_not_allowed/);
  assert.equal(writes, 0);
});


test('orchestrator lifecycle preflight rejects a missing downstream capability before execution', () => {
  const configured = project({
    allow: ['workspace.prepare', 'project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  const orchestrator = new Orchestrator({ store: { mutate() {}, load() {} } });
  assert.throws(() => orchestrator.assertOrchestratorCapabilities(configured), /capability_unavailable:code.implement:skill_not_allowed/);
});

test('dry run reports unavailable lifecycle capabilities without invoking the worker', async () => {
  const configured = project({
    allow: ['workspace.prepare', 'project.bootstrap', 'project.verify', 'human.approval', 'repository.observe', 'repository.publish', 'release.observe-ci', 'release.publish-pr'],
    deny: []
  });
  let workerCalls = 0;
  const github = {
    async inspect() {
      return {
        provider: 'github',
        repository: 'owner/repo',
        defaultBranch: 'main',
        head: 'deadbeef',
        branchProtection: { protected: true }
      };
    }
  };
  const worker = { async execute() { workerCalls += 1; return { status: 'completed' }; } };
  const orchestrator = new Orchestrator({ store: await store(), github, worker });
  const run = await orchestrator.run(configured, 'Inspect only', { dryRun: true });
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(workerCalls, 0);
  assert.equal(run.results.capabilities.ok, false);
  const implementation = run.results.capabilities.required.find((capability) => capability.id === 'code.implement');
  assert.equal(implementation.available, false);
  assert.equal(implementation.reason, 'skill_not_allowed');
  assert.ok(run.evaluation.reasons.some((reason) => reason.includes('code.implement:skill_not_allowed')));
});
