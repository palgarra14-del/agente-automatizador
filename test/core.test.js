import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSdkWorker,
  DockerContainerExecution,
  LocalSanitizedExecution,
  GitHubAdapter,
  JsonStore,
  LocalGitAdapter,
  Orchestrator,
  ProjectCommandRunner,
  RunStatus,
  VercelDeploymentProvider,
  WorkspaceManager,
  assertAllowedWorkingBranch,
  buildWorkerPrompt,
  codexWorkerSecurityConfig,
  configFrom,
  doctor,
  evaluate,
  evaluateChangePolicy,
  fingerprintChangeSet,
  formatDoctor,
  imageIsPinned,
  loadProjects,
  maskSecrets,
  policy,
  runCommand,
  runProcess,
  report,
  remoteMatchesProject,
  resolveExecutionUser,
  safeCommandEnvironment,
  transition,
  managedWorkspacePath
} from '../src/core.js';

function project(overrides = {}) {
  return configFrom({
    id: 'self',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: {
      test: 'node --version',
      typecheck: 'node --version',
      lint: 'node --version',
      build: 'node --version'
    },
    budgets: { maxWorkerAttempts: 2, commandTimeoutMs: 1_000, ciTimeoutMs: 1_000, ciPollIntervalMs: 1_000 },
    ...overrides
  });
}

class FakeLocalGit {
  constructor() {
    this.current = 'main';
    this.currentHead = 'initial-head';
    this.commitCalls = 0;
    this.prepareCalls = 0;
    this.pushCalls = 0;
  }

  async prepareWorkingBranch(_project, runId, expectedBaseHead) {
    this.prepareCalls += 1;
    if (expectedBaseHead !== 'initial-head') throw new Error('base_head_changed');
    this.current = `agent/${runId}`;
    return { initialHead: this.currentHead, workingBranch: this.current, repository: 'fake', remote: 'https://github.com/owner/repo.git', status: '' };
  }

  async inspect() {
    return { initialHead: this.currentHead, currentBranch: this.current, remote: 'https://github.com/owner/repo.git' };
  }

  async assertWorkingBranch(_project, branch) { assert.equal(this.current, branch); }
  async head() { return this.currentHead; }
  async assertSafeChangedPaths() { return ['docs/worker-fixture.md']; }
  async inspectChangeSet() {
    const changeSet = { paths: await this.assertSafeChangedPaths(), changedFiles: 1, additions: 1, deletions: 0, diffLines: 1, sensitiveContent: false, contentFingerprint: 'fixture-content-a' };
    return { ...changeSet, changeSetFingerprint: fingerprintChangeSet(changeSet) };
  }

  async commit(_project, branch, _message, { expectedChangeSetFingerprint, ...options } = {}) {
    assert.equal(branch, this.current);
    this.commitOptions = options;
    const changeSet = await this.inspectChangeSet();
    assert.equal(changeSet.changeSetFingerprint, expectedChangeSetFingerprint);
    this.commitCalls += 1;
    this.committedPaths = changeSet.paths;
    this.committedChangeSetFingerprint = changeSet.changeSetFingerprint;
    this.currentHead = `commit-${this.commitCalls}`;
    return { message: 'agent: safe change', finalHead: this.currentHead, committedPaths: changeSet.paths, committedChangeSetFingerprint: changeSet.changeSetFingerprint };
  }

  async push(_project, branch, options = {}) { this.pushCalls += 1; this.pushOptions = options; return { branch, finalHead: this.currentHead }; }
}

function governedChangeSet(paths = ['src/worker-fixture.js'], { additions = 1, deletions = 0, contentFingerprint = 'content-a', sensitiveContent = false } = {}) {
  const changeSet = { paths, changedFiles: paths.length, additions, deletions, diffLines: additions + deletions, contentFingerprint, sensitiveContent };
  return { ...changeSet, changeSetFingerprint: fingerprintChangeSet(changeSet) };
}

class GovernedFakeGit extends FakeLocalGit {
  constructor(changeSet = governedChangeSet()) {
    super();
    this.changeSet = changeSet;
  }

  async assertSafeChangedPaths() { return this.changeSet.paths; }
  async inspectChangeSet() { return { ...this.changeSet, changeSetFingerprint: this.changeSet.changeSetFingerprint ?? fingerprintChangeSet(this.changeSet) }; }
}

class FakeGitHub {
  constructor() { this.pullRequests = 0; this.ciCalls = 0; }

  async inspect(configured) { return { provider: 'github', status: 'ok', repository: `${configured.repository.owner}/${configured.repository.name}`, defaultBranch: 'main', head: 'initial-head' }; }

  async createPullRequest() {
    this.pullRequests += 1;
    return { number: this.pullRequests, url: `https://example.test/pr/${this.pullRequests}`, state: 'open' };
  }

  async waitForCi() {
    this.ciCalls += 1;
    return { state: 'success', checks: [{ name: 'verify', status: 'completed', conclusion: 'success' }], durationMs: 5 };
  }
}

class FakeWorker {
  constructor() { this.calls = 0; }

  async execute() {
    this.calls += 1;
    return { status: 'completed', summary: 'changed a fixture', output: '' };
  }
}

class FakeWorkspaceManager {
  constructor() { this.prepareCalls = 0; this.describeCalls = 0; }

  describe(configured, runId) {
    this.describeCalls += 1;
    return { workspace: join(configured.managedWorkspaceRoot, configured.id, runId), managed: true, retained: true };
  }

  async prepare(configured, runId) {
    this.prepareCalls += 1;
    return { ...this.describe(configured, runId), clone: { ok: true, durationMs: 1, exitCode: 0 }, remoteUrl: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` };
  }
}

class FakeDeployment {
  constructor(result = { state: 'READY', ok: true, deploymentId: 'dpl_test', url: 'https://preview.test' }) { this.result = result; this.calls = 0; }
  async waitForPreview() { this.calls += 1; return { provider: 'vercel', ...this.result }; }
}

function leadfinderProject(overrides = {}) {
  return project({
    id: 'leadfinder',
    repository: { owner: 'owner', name: 'leadfinder' },
    workspaceStrategy: 'managed',
    commands: { install: 'node --version', test: 'node --version', lint: 'node --version', build: 'node --version' },
    acceptance: { require: ['install', 'test', 'lint', 'build', 'ci', 'deployment'] },
    deployment: { provider: 'vercel', projectId: 'prj_test', teamId: 'team_test', requirePreviewReady: true },
    ...overrides
  });
}

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), 'engineering-orchestrator-'));
  return new JsonStore(join(directory, 'state.json'));
}

test('configuration confines workspaces and policy blocks protected branch actions', () => {
  assert.throws(() => configFrom({ id: 'BAD' }));
  assert.throws(() => configFrom({
    id: 'safe',
    repository: { owner: 'o', name: 'r' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '../../outside',
    commands: { test: 'node --version' }
  }, join(tmpdir(), 'repo', 'config')));
  assert.equal(policy('create_pull_request', project()), 'SAFE');
  assert.equal(policy('merge', project()), 'APPROVAL_REQUIRED');
  assert.equal(policy('force_push_main', project({ policies: { requireApprovalFor: ['force_push_main'] } })), 'FORBIDDEN');
  assert.throws(() => assertAllowedWorkingBranch(project(), 'main'));
  assert.throws(() => assertAllowedWorkingBranch(project(), 'feature/untrusted'));
});

test('self project keeps a shell-free cross-platform typecheck command', async () => {
  const configured = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  assert.equal(configured.get('self').commands.typecheck, 'node --check src/core.js');
  assert.equal(configured.get('self').toolchain.command, 'npm');
  assert.deepEqual(configured.get('leadfinder').toolchain, { command: 'pnpm', version: '11.19.0' });
  assert.deepEqual(configured.get('self').changePolicy.budgets, { maxChangedFiles: 8, maxDiffLines: 500, maxChangedBytes: 8 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024 });
  assert.deepEqual(configured.get('leadfinder').changePolicy.budgets, { maxChangedFiles: 3, maxDiffLines: 200, maxChangedBytes: 8 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024 });
  assert.equal(configured.get('self').budgets.maxModelCalls, 6);
  assert.equal(configured.get('leadfinder').budgets.maxModelCalls, 6);
  assert.equal(configured.get('callflow').budgets.maxModelCalls, 6);
  assert.throws(() => project({ budgets: { maxModelCalls: 0 } }), /maxModelCalls must be an integer >= 1/);
});

test('v0.5 treats only the self control-plane project configuration as sensitive', async () => {
  const configured = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  const controlPlane = evaluateChangePolicy(configured.get('self'), { paths: ['config/projects.json'], changedFiles: 1, diffLines: 1 });
  const ordinarySource = evaluateChangePolicy(configured.get('self'), { paths: ['src/feature.js'], changedFiles: 1, diffLines: 1 });
  assert.equal(controlPlane.classification, 'sensitive');
  assert.equal(ordinarySource.classification, 'normal');
});

test('v0.4 change policy rejects forbidden files, workspace escape, scope violations, and over-budget diffs', () => {
  const governed = project({ changePolicy: { budgets: { maxChangedFiles: 10, maxDiffLines: 50 } } });
  for (const path of ['.env', 'nested/.env.local', 'keys/service.pem', 'keys/service.key', 'secrets/value.txt', 'creds/value.txt', '.git/config']) {
    const result = evaluateChangePolicy(governed, { paths: [path], changedFiles: 1, diffLines: 1 });
    assert.equal(result.ok, false, path);
    assert.match(result.reason, /^forbidden_path:/);
  }
  assert.equal(evaluateChangePolicy(governed, { paths: ['../outside.txt'] }).reason, 'forbidden_path:workspace_escape');
  assert.equal(evaluateChangePolicy(governed, { paths: ['docs/blocked.md'], changedFiles: 1, diffLines: 1 }, { allowedPaths: ['src'], forbiddenPaths: ['docs'] }).reason, 'forbidden_scope_path:docs/blocked.md');
  assert.equal(evaluateChangePolicy(governed, { paths: Array.from({ length: 11 }, (_, index) => `src/${index}.js`), changedFiles: 11, diffLines: 11 }).reason, 'change_budget_exceeded');
  assert.equal(evaluateChangePolicy(governed, { paths: ['src/large.js'], changedFiles: 1, diffLines: 51 }).reason, 'change_budget_exceeded');
});

test('v0.4 change policy marks package, workflow, and security/auth changes as sensitive while a one-file source change continues', () => {
  const governed = project();
  for (const changeSet of [
    { paths: ['package.json'], changedFiles: 1, diffLines: 1 },
    { paths: ['.github/workflows/verify.yml'], changedFiles: 1, diffLines: 1 },
    { paths: ['src/feature.js'], changedFiles: 1, diffLines: 1, sensitiveContent: true }
  ]) assert.equal(evaluateChangePolicy(governed, changeSet).classification, 'sensitive');
  const normal = evaluateChangePolicy(governed, { paths: ['src/feature.js'], changedFiles: 1, diffLines: 1 }, { allowedPaths: ['src'] });
  assert.deepEqual({ ok: normal.ok, classification: normal.classification }, { ok: true, classification: 'normal' });
});

test('doctor reports governed project readiness without exposing configuration secrets', async () => {
  const result = await doctor(leadfinderProject(), {
    github: { inspect: async () => ({ defaultBranchProtected: false }) },
    codexAvailable: () => true,
    environment: {},
    executionRunner: { doctor: async () => ({ configuredProvider: 'container-required', selectedProvider: 'container', sandboxAvailable: 'YES', containerAvailable: 'YES', postWorkerNetwork: 'DENIED (--network none)', hostFallback: 'NONE (FAIL-SAFE)' }) }
  });
  assert.equal(result.githubConnectivity, 'YES');
  assert.equal(result.codexAvailable, 'YES');
  assert.equal(result.vercelConfigured, 'YES');
  assert.equal(result.vercelToken, 'NO');
  assert.equal(result.branchProtection, 'NO');
  assert.equal(result.modelCallBudget, 6);
  assert.match(formatDoctor(result), /MODEL CALL BUDGET\n6/);
  assert.match(formatDoctor(result), /COMMANDS CONFIGURED\ninstall, test, lint, build/);
  assert.match(formatDoctor(result), /CAPABILITY REGISTRY\n[0-9a-f]{12}/);
  assert.match(formatDoctor(result), /ORCHESTRATOR SKILLS AVAILABLE/);
  assert.match(formatDoctor(result), /EXECUTION SANDBOX AVAILABLE\nYES/);
});

test('security rejects control characters in governed paths and keeps state private', async () => {
  const configured = project();
  const decision = evaluateChangePolicy(configured, { paths: ['safe\n.env'], changedFiles: 1, diffLines: 1 });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'forbidden_path:workspace_escape');

  const directory = await mkdtemp(join(tmpdir(), 'agent-private-state-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  await store.mutate((data) => { data.runs.example = { id: 'example' }; });
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('state transitions deny bypass and persisted state is valid JSON', async () => {
  const run = { status: RunStatus.CREATED };
  transition(run, RunStatus.PLANNING);
  assert.throws(() => transition(run, RunStatus.COMPLETED));
  const store = await temporaryStore();
  await store.mutate((data) => { data.runs.one = { id: 'one', status: 'created' }; });
  assert.equal((await store.getRun('one')).id, 'one');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).runs.one.status, 'created');
});

test('command runner uses a fixed allowlist, a shell-free runner, and dry-run', async () => {
  const configured = project();
  const dryRun = await runCommand(configured, 'test', { dryRun: true });
  assert.equal(dryRun.skipped, true);
  await assert.rejects(() => runCommand(configured, 'not-allowlisted'));
  await assert.rejects(() => runCommand(project({ commands: { test: 'node --version; rm -rf /' } }), 'test'));
});

test('command runner finds npm through the current Node installation on Windows', async () => {
  const calls = [];
  const configured = project({ commands: { test: 'npm test' } });
  const result = await runCommand(configured, 'test', {
    processRunner: async (binary, args) => {
      calls.push({ binary, args });
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
    }
  });
  assert.equal(result.ok, true);
  if (process.platform === 'win32') {
    assert.equal(calls[0].binary, process.execPath);
    assert.match(calls[0].args[0], /npm-cli\.js$/);
  }
});

test('v0.5 resolves container runtime user from the host without requiring root', () => {
  const expected = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? `${process.getuid()}:${process.getgid()}`
    : '1000:1000';
  assert.equal(resolveExecutionUser('host'), expected);
  assert.equal(resolveExecutionUser('1234:5678'), '1234:5678');

  const configured = project({
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim', user: 'host' }
  });
  assert.equal(configured.execution.user, 'host');
  const execution = new DockerContainerExecution();
  const { containerArgs } = execution.commandArguments(configured, 'test', { containerName: 'agent-test', gitMetadata: join(configured.workspace, '.git') });
  assert.equal(containerArgs[containerArgs.indexOf('--user') + 1], expected);
});

test('v0.5 validates explicit execution providers and configures registered projects as container-required', async () => {
  const configured = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  assert.equal(configured.get('self').execution.provider, 'container-required');
  assert.equal(configured.get('self').execution.image, 'node:22-bookworm-slim');
  assert.equal(configured.get('leadfinder').execution.provider, 'container-required');
  assert.equal(configured.get('leadfinder').execution.image, 'agent-node22-pnpm11:local');
  assert.equal(imageIsPinned('registry.example/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(imageIsPinned(configured.get('leadfinder').execution.image), false);
  assert.throws(() => project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim', fallbackProvider: 'local-sanitized' } }), /cannot use a host fallback/);
  assert.throws(() => project({ execution: { provider: 'container', image: 'node:22-bookworm-slim', user: 'root' } }), /numeric uid:gid/);
});

test('v0.5 container execution mounts workspace read-write and nested git metadata read-only with no other host mounts', async () => {
  const calls = [];
  const runner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'version') return { ok: true, exitCode: 0, stdout: '27.0', stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') return { ok: true, exitCode: 0, stdout: 'image', stderr: '' };
    return { ok: true, exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 1 };
  };
  const configured = project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim', resources: { memoryMb: 256, cpuCount: 1, pidsLimit: 64 } } });
  const result = await new DockerContainerExecution({ processRunner: runner }).execute(configured, 'test', { stage: 'post-worker' });
  assert.equal(result.ok, true);
  const container = calls.at(-1);
  assert.equal(container.binary, 'docker');
  assert.deepEqual(container.args.slice(0, 5), ['run', '--pull', 'never', '--rm', '--init']);
  assert.match(container.args[container.args.indexOf('--name') + 1], /^agent-command-[0-9a-f-]+$/);
  assert.equal(container.args[container.args.indexOf('--network') + 1], 'none');
  for (const flag of ['--read-only', '--tmpfs', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--memory-swap', '--cpus', '--user']) assert.ok(container.args.includes(flag));
  const mounts = container.args.filter((value) => String(value).includes('type=bind,'));
  assert.equal(mounts.length, 2);
  assert.equal(mounts.filter((value) => /dst=\/workspace(?:,|$)/.test(value)).length, 1);
  assert.equal(mounts.some((value) => /dst=\/workspace(?:,|$).*readonly/.test(value)), false);
  assert.equal(mounts.some((value) => /src=.*\.git,dst=\/workspace\/\.git,readonly$/.test(value)), true);
  assert.equal(mounts.filter((value) => /dst=\/workspace\/\.git,readonly$/.test(value)).length, 1);
  assert.equal(container.args.some((value) => /docker(?:_engine)?\.sock|\.ssh|\.gitconfig|\.codex|--privileged|type=volume|--volume/i.test(String(value))), false);
  assert.equal(container.options.env.GITHUB_TOKEN, undefined);
  assert.equal(container.options.env.VERCEL_TOKEN, undefined);
  assert.equal(container.options.env.HOME, undefined);
  assert.equal(container.options.inheritEnvironment, false);
  assert.equal(container.options.restrictEnvironment, true);
  assert.ok(container.options.timeoutMs > 0 && container.options.timeoutMs <= configured.budgets.commandTimeoutMs);
});

test('v0.5 force-removes a named container after a timed out project command', async () => {
  const calls = [];
  const runner = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'version' || (args[0] === 'image' && args[1] === 'inspect')) return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' };
    if (args[0] === 'rm') return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    return { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: 'timeout' };
  };
  const result = await new DockerContainerExecution({ processRunner: runner }).execute(project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim' } }), 'test');
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanup.attempted, true);
  assert.equal(result.cleanup.ok, true);
  const cleanup = calls.find((args) => args[0] === 'rm');
  assert.deepEqual(cleanup.slice(0, 2), ['rm', '--force']);
  assert.equal(cleanup[2], result.cleanup.containerName);
});

test('v0.5 allows network only for pre-worker bootstrap and never pulls a missing image', async () => {
  const calls = [];
  const availableRunner = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'version' || (args[0] === 'image' && args[1] === 'inspect')) return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' };
    return { ok: true, exitCode: 0, stdout: '', stderr: '' };
  };
  const configured = project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim' }, commands: { install: 'npm ci', test: 'npm test', typecheck: 'node --version', lint: 'npm test', build: 'npm test' } });
  await new DockerContainerExecution({ processRunner: availableRunner }).execute(configured, 'install', { stage: 'bootstrap' });
  assert.equal(calls.at(-1).includes('--network'), false);
  assert.equal(calls.some((args) => args[0] === 'pull'), false);
  const unavailable = new DockerContainerExecution({ processRunner: async (_binary, args) => args[0] === 'version' ? { ok: true, exitCode: 0, stdout: 'ok', stderr: '' } : { ok: false, exitCode: 1, stdout: '', stderr: 'missing image' } });
  const blocked = await unavailable.execute(configured, 'test', { stage: 'post-worker' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.stderr, /execution_provider_unavailable/);
});

test('v0.5 container-required fails safe and local fallback is only explicit', async () => {
  let localCalls = 0;
  const local = { availability: async () => ({ available: true, provider: 'local-sanitized', sandboxed: false }), execute: async () => { localCalls += 1; return { ok: true, execution: { provider: 'local-sanitized' } }; } };
  const unavailableContainer = { availability: async () => ({ available: false, provider: 'container', reason: 'Docker unavailable' }), probe: async () => ({ available: false, reason: 'Docker unavailable' }) };
  const required = new ProjectCommandRunner({ localExecution: local, containerExecution: unavailableContainer });
  const blocked = await required.run(project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim' } }), 'test');
  assert.equal(blocked.ok, false);
  assert.match(blocked.stderr, /execution_provider_unavailable/);
  assert.equal(localCalls, 0);
  const fallback = new ProjectCommandRunner({ localExecution: local, containerExecution: unavailableContainer });
  const run = await fallback.run(project({ execution: { provider: 'container', image: 'node:22-bookworm-slim', fallbackProvider: 'local-sanitized' } }), 'test');
  assert.equal(run.ok, true);
  assert.equal(localCalls, 1);
});

test('v0.5 command selection is fixed by project configuration and cannot be overridden by a worker option', async () => {
  let containerCalls = 0;
  let localCalls = 0;
  const selected = new ProjectCommandRunner({
    containerExecution: { availability: async () => ({ available: true, provider: 'container', sandboxed: true }), probe: async () => ({ available: true }), execute: async () => { containerCalls += 1; return { ok: true, execution: { provider: 'container' } }; } },
    localExecution: { availability: async () => ({ available: true, provider: 'local-sanitized' }), execute: async () => { localCalls += 1; return { ok: true, execution: { provider: 'local-sanitized' } }; } }
  });
  const result = await selected.run(project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim' } }), 'test', { executionProvider: 'local-sanitized' });
  assert.equal(result.execution.provider, 'container');
  assert.equal(containerCalls, 1);
  assert.equal(localCalls, 0);
});

test('v0.5 runs install only before the worker and never reruns it after a sensitive package change', async () => {
  const localGit = new GovernedFakeGit(governedChangeSet(['package.json'], { contentFingerprint: 'package-after-worker' }));
  const commandCalls = [];
  const configured = project({
    commands: { install: 'node --version', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    acceptance: { require: ['install', 'test', 'typecheck', 'lint', 'build', 'ci'] },
    execution: { provider: 'local-sanitized' }
  });
  const orchestrator = new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name, options) => { commandCalls.push({ name, stage: options.stage ?? 'post-worker' }); return { name, ok: true, stdout: '', stderr: '', durationMs: 1 }; }
  });
  const waiting = await orchestrator.run(configured, 'Do not reinstall package metadata changed by the worker');
  assert.equal(waiting.status, RunStatus.WAITING_APPROVAL);
  assert.deepEqual(commandCalls, [{ name: 'install', stage: 'bootstrap' }]);
  await orchestrator.decideApproval(waiting.pendingAction.approvalId, true);
  const completed = await orchestrator.resume(waiting.id, configured);
  assert.equal(completed.status, RunStatus.COMPLETED);
  assert.equal(commandCalls.filter(({ name }) => name === 'install').length, 1);
});

test('v0.5 doctor distinguishes an unavailable container from an explicit local fallback', async () => {
  const unavailableContainer = { availability: async () => ({ available: false, provider: 'container', reason: 'Docker unavailable' }), probe: async () => ({ available: false, reason: 'Docker unavailable' }) };
  const executionRunner = new ProjectCommandRunner({ localExecution: new LocalSanitizedExecution({ processRunner: async () => ({ ok: true }) }), containerExecution: unavailableContainer });
  const result = await doctor(project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim' } }), { github: { inspect: async () => ({}) }, codexAvailable: () => true, environment: {}, executionRunner });
  assert.deepEqual(result.execution, {
    configuredProvider: 'container-required', selectedProvider: 'container', sandboxAvailable: 'NO', containerAvailable: 'NO', dockerAvailable: 'NO', imageAvailable: 'NO', imagePinned: 'NO', projectToolchain: 'npm', runtimeUser: resolveExecutionUser('host'), gitMetadata: 'READ ONLY BY CONTRACT (PROVIDER UNAVAILABLE)', postWorkerNetwork: 'DENIED BY CONTRACT (PROVIDER UNAVAILABLE)', hostFallback: 'NONE (FAIL-SAFE)', reason: 'Docker unavailable'
  });
  assert.match(formatDoctor(result), /DOCKER AVAILABLE\nNO/);
});

test('v0.5 accepts only exact configured GitHub HTTPS or SSH origin remotes', () => {
  const configured = project();
  for (const remote of ['https://github.com/owner/repo.git', 'https://github.com/owner/repo', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
    assert.equal(remoteMatchesProject(remote, configured), true, remote);
  }
  for (const remote of ['https://github.com/owner/repo-evil.git', 'https://github.com/owner/repo.git.evil', 'https://evil.example/owner/repo.git', 'https://github.com/owner/repo/extra', 'git@github.com:owner/repository.git']) {
    assert.equal(remoteMatchesProject(remote, configured), false, remote);
  }
});

test('v0.5 revalidates repository identity before controlled commit and push and skips hooks', async () => {
  const configured = project();
  const adapter = new LocalGitAdapter();
  const observed = [];
  const changeSet = governedChangeSet();
  adapter.assertRepositoryState = async (_project, expected) => { observed.push(expected); return { currentBranch: 'agent/test', initialHead: expected.head, remote: expected.remote }; };
  adapter.assertWorkingBranch = async () => {};
  adapter.inspectChangeSet = async () => changeSet;
  adapter.head = async () => 'commit-head';
  adapter.git = async (args) => {
    if (args[0] === 'diff' && args[1] === '--cached') return { exitCode: 1, stdout: '', stderr: '' };
    observed.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await adapter.commit(configured, 'agent/test', 'safe change', {
    expectedChangeSetFingerprint: changeSet.changeSetFingerprint,
    expectedHead: 'base-head',
    expectedRemote: 'https://github.com/owner/repo.git'
  });
  await adapter.push(configured, 'agent/test', { expectedHead: 'commit-head', expectedRemote: 'https://github.com/owner/repo.git' });
  assert.deepEqual(observed.filter((value) => !Array.isArray(value)), [
    { branch: 'agent/test', head: 'base-head', remote: 'https://github.com/owner/repo.git' },
    { branch: 'agent/test', head: 'commit-head', remote: 'https://github.com/owner/repo.git' }
  ]);
  assert.deepEqual(observed.find((args) => Array.isArray(args) && args[0] === 'commit').slice(0, 2), ['commit', '--no-verify']);
});

test('project subprocesses retain PATH but never inherit orchestrator credentials', async () => {
  const names = ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    GITHUB_TOKEN: 'ghp_command_environment_test', VERCEL_TOKEN: 'vcp_command_environment_test',
    OPENAI_API_KEY: 'sk-command_environment_test', CODEX_API_KEY: 'codex-command_environment_test'
  });
  try {
    const result = await runCommand(project({ commands: { test: 'node fixtures/command-env.js' } }), 'test');
    const observed = JSON.parse(result.stdout);
    assert.equal(result.ok, true);
    assert.equal(observed.pathAvailable, true);
    assert.deepEqual(observed.credentials, { github: false, vercel: false, openai: false, codex: false });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('structured redaction preserves JSON syntax when free text contains authorization secrets', () => {
  const configured = project({
    commandEnvironment: {
      SAFE_NOTE: 'Deploy note: Authorization: Bearer top-secret-token-value, then continue.'
    }
  });
  assert.equal(configured.commandEnvironment.SAFE_NOTE.includes('top-secret-token-value'), false);
  assert.match(configured.commandEnvironment.SAFE_NOTE, /Authorization:\s*\[REDACTED\]/i);
  assert.match(JSON.stringify(configured.commandEnvironment), /^\{"SAFE_NOTE":/);
});

test('project command environment permits literal non-secret values only', () => {
  assert.equal(safeCommandEnvironment({ NEXT_TELEMETRY_DISABLED: '1' }).NEXT_TELEMETRY_DISABLED, '1');
  assert.throws(() => configFrom({
    id: 'safe', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    commands: { test: 'node --version' }, commandEnvironment: { SERVICE_TOKEN: 'not-allowed' }
  }));
});

test('worker prompt redacts secrets and Codex SDK receives isolated permission-profile configuration', async () => {
  const invocation = {};
  class FakeCodex {
    constructor(options) { invocation.clientOptions = options; }

    startThread(options) {
      invocation.threadOptions = options;
      return {
        id: 'thread-1',
        run: async (prompt, turnOptions) => {
          invocation.prompt = prompt;
          invocation.turnOptions = turnOptions;
          return { finalResponse: 'changed one fixture', usage: { input_tokens: 1 } };
        }
      };
    }
  }
  let cleaned = false;
  const worker = new CodexSdkWorker({
    CodexClient: FakeCodex,
    environment: () => ({ PATH: '/safe/bin', CODEX_HOME: '/real/codex-home', HOME: '/real/home' }),
    codexHomeFactory: async (sourceEnvironment) => {
      invocation.sourceEnvironment = sourceEnvironment;
      return { path: '/isolated/codex-home', cleanup: async () => { cleaned = true; } };
    },
    platform: 'linux'
  });
  const result = await worker.execute({ objective: 'update fixture', token: 'ghp_hiddenToken', nested: { password: 'hidden' } }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(result.status, 'completed');
  assert.equal(invocation.clientOptions.env.PATH, '/safe/bin');
  assert.equal(invocation.clientOptions.env.CODEX_HOME, '/isolated/codex-home');
  assert.equal(invocation.clientOptions.env.HOME, '/isolated/codex-home');
  assert.notEqual(invocation.clientOptions.env.CODEX_HOME, invocation.sourceEnvironment.CODEX_HOME);
  assert.equal(cleaned, true);
  assert.deepEqual(invocation.threadOptions, {
    workingDirectory: '/safe/workspace', approvalPolicy: 'never', webSearchMode: 'disabled'
  });
  const overrides = invocation.clientOptions.configOverrides;
  for (const required of [
    'default_permissions="agent-workflow"',
    'permissions.agent-workflow.network.enabled=false',
    'allow_login_shell=false',
    'shell_environment_policy.inherit="none"',
    'project_doc_max_bytes=0',
    'skills.include_instructions=false',
    'skills.bundled.enabled=false',
    'features.apps=false',
    'features.plugins=false',
    'features.browser_use=false',
    'features.computer_use=false',
    'agents.enabled=false',
    'history.persistence="none"',
    'ephemeral=true'
  ]) assert.ok(overrides.includes(required), required);
  assert.ok(overrides.some((entry) => entry.includes('":root"="deny"') && entry.includes('"."="write"') && entry.includes('".git"="read"')));
  assert.equal(Object.hasOwn(invocation.threadOptions, 'sandboxMode'), false);
  assert.equal(Object.hasOwn(invocation.threadOptions, 'networkAccessEnabled'), false);
  assert.equal(invocation.prompt.includes('ghp_hiddenToken'), false);
  assert.equal(invocation.prompt.includes('hidden'), false);
  assert.equal(buildWorkerPrompt({ authorization: 'Bearer abcdef123456' }).includes('abcdef123456'), false);
});

test('default worker environment excludes GitHub, Vercel, and OpenAI credentials', async () => {
  let clientEnvironment;
  class FakeCodex {
    constructor(options) { clientEnvironment = options.env; }
    startThread() { return { run: async () => ({ finalResponse: 'done' }) }; }
  }
  const names = ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { GITHUB_TOKEN: 'ghp_worker_test', VERCEL_TOKEN: 'vcp_worker_test', OPENAI_API_KEY: 'sk_worker_test', CODEX_API_KEY: 'codex_worker_test' });
  try {
    await new CodexSdkWorker({ CodexClient: FakeCodex }).execute({ objective: 'fixture' }, { workspace: process.cwd(), timeoutMs: 100 });
    for (const name of names) assert.equal(clientEnvironment[name], undefined);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('GitHub adapter requires both check runs and commit status contexts to be healthy', async () => {
  const responses = [
    { total_count: 1, check_runs: [{ name: 'verify', status: 'in_progress', conclusion: null }] },
    [],
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    [{ context: 'external', state: 'success', description: 'ok', target_url: 'https://example.test/success' }],
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    [{ context: 'external', state: 'failure', description: 'failed', target_url: 'https://example.test/failure' }],
    { total_count: 0, check_runs: [] },
    [{ context: 'legacy-ci', state: 'success', description: 'ok', target_url: null }],
    { total_count: 0, check_runs: [] },
    []
  ];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  const pending = await adapter.checks(project(), 'sha');
  assert.equal(pending.state, 'pending');
  const success = await adapter.checks(project(), 'sha');
  assert.equal(success.state, 'success');
  assert.equal(success.statuses[0].context, 'external');
  const failedStatus = await adapter.checks(project(), 'sha');
  assert.equal(failedStatus.state, 'failure');
  assert.equal(failedStatus.statuses[0].state, 'failure');
  assert.equal((await adapter.checks(project(), 'sha')).state, 'success');
  assert.equal((await adapter.checks(project(), 'sha')).state, 'pending');
  assert.equal(maskSecrets('ghp_adapterToken').includes('ghp_adapterToken'), false);
});

test('GitHub adapter treats a failing check run as failure even while a commit status is pending', async () => {
  const responses = [
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'failure' }] },
    [{ context: 'external', state: 'pending' }]
  ];
  const adapter = new GitHubAdapter({ token: 'ghp_adapterToken', fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }) });
  assert.equal((await adapter.checks(project(), 'sha')).state, 'failure');
});

test('GitHub adapter evaluates only the latest status for each commit status context', async () => {
  const responses = [
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    [
      { context: 'external', state: 'failure', updated_at: '2026-09-11T10:00:00Z' },
      { context: 'external', state: 'success', updated_at: '2026-09-11T10:01:00Z' }
    ]
  ];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  const result = await adapter.checks(project(), 'sha');
  assert.equal(result.state, 'success');
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].context, 'external');
  assert.equal(result.statuses[0].state, 'success');
});

test('GitHub adapter paginates CI signals and observes failures beyond the first page', async () => {
  const checkPageOne = Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}`, status: 'completed', conclusion: 'success' }));
  const statusPageOne = Array.from({ length: 100 }, (_, index) => ({ context: `status-${index}`, state: 'success' }));
  const requested = [];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async (url) => {
      requested.push(url);
      const checkRuns = url.includes('/check-runs');
      const pageTwo = url.includes('page=2');
      const body = checkRuns
        ? (pageTwo
            ? { total_count: 101, check_runs: [{ name: 'late-check', status: 'completed', conclusion: 'failure' }] }
            : { total_count: 101, check_runs: checkPageOne })
        : (pageTwo
            ? [{ context: 'late-status', state: 'success' }]
            : statusPageOne);
      return { ok: true, json: async () => body };
    }
  });
  const result = await adapter.checks(project(), 'sha');
  assert.equal(result.state, 'failure');
  assert.equal(result.checks.length, 101);
  assert.equal(result.statuses.length, 101);
  assert.equal(requested.some((url) => url.includes('check-runs?filter=latest&per_page=100&page=2')), true);
  assert.equal(requested.some((url) => url.includes('/statuses?per_page=100&page=2')), true);
});

test('GitHub adapter fails closed when CI pagination exceeds its bounded evidence limit', async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ context: `status-${index}`, state: 'success' }));
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.includes('/check-runs') ? { total_count: 0, check_runs: [] } : fullPage
    })
  });
  await assert.rejects(adapter.checks(project(), 'sha'), /github_ci_statuses_pagination_limit_exceeded/);
});

test('LocalGitAdapter creates the working branch at the fetched remote base and rejects a changed base', async () => {
  const calls = [];
  let currentBranch = 'main';
  let currentHead = 'stale-local-main';
  const configured = project();
  const runner = async (_binary, args) => {
    calls.push(args);
    const command = args.join(' ');
    if (command === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: configured.workspace, stderr: '' };
    if (command === 'remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/owner/repo.git', stderr: '' };
    if (command === 'branch --show-current') return { exitCode: 0, stdout: currentBranch, stderr: '' };
    if (command === 'rev-parse HEAD') return { exitCode: 0, stdout: currentHead, stderr: '' };
    if (command === 'status --porcelain') return { exitCode: 0, stdout: '', stderr: '' };
    if (command === 'fetch origin main') return { exitCode: 0, stdout: '', stderr: '' };
    if (command === 'rev-parse refs/remotes/origin/main') return { exitCode: 0, stdout: 'new-remote-main', stderr: '' };
    if (command.startsWith('show-ref --verify --quiet')) return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'switch') { currentBranch = args[2]; currentHead = args[3]; return { exitCode: 0, stdout: '', stderr: '' }; }
    throw new Error(`Unexpected git command: ${command}`);
  };
  const adapter = new LocalGitAdapter({ processRunner: runner });
  const prepared = await adapter.prepareWorkingBranch(configured, 'run-id', 'new-remote-main');
  assert.equal(prepared.initialHead, 'new-remote-main');
  assert.deepEqual(calls.at(-2), ['switch', '--create', 'agent/run-id', 'new-remote-main']);
  const mismatch = new LocalGitAdapter({ processRunner: runner });
  await assert.rejects(() => mismatch.prepareWorkingBranch(configured, 'second-run', 'github-other-head'), /base_head_changed/);
  assert.equal(calls.some((args) => args[0] === 'switch' && args[2] === 'agent/second-run'), false);
});

test('dry-run persists a complete simulation without invoking worker, git writes, commands, or PR writes', async () => {
  const store = await temporaryStore();
  const localGit = new FakeLocalGit();
  const github = new FakeGitHub();
  const worker = new FakeWorker();
  let commandCalls = 0;
  const run = await new Orchestrator({ store, localGit, github, worker, commandRunner: async () => { commandCalls += 1; return { ok: true }; } })
    .run(project(), 'Simulate exactly one safe fixture change', { dryRun: true });
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(run.evaluation.decision, 'DRY_RUN');
  assert.equal(localGit.prepareCalls, 0);
  assert.equal(localGit.commitCalls, 0);
  assert.equal(localGit.pushCalls, 0);
  assert.equal(worker.calls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(github.pullRequests, 0);
  assert.equal(run.results.worker.simulated, true);
});

test('report exposes capability fingerprints and preflight outcome without raw policy data', () => {
  const rendered = report({
    id: 'capability-report',
    projectId: 'fixture',
    projectName: 'Fixture',
    goal: 'safe goal',
    status: 'created',
    dryRun: true,
    registryFingerprint: 'a'.repeat(64),
    projectSkillPolicyFingerprint: 'b'.repeat(64),
    results: { capabilities: { ok: false } },
    budgets: { maxWorkerAttempts: 1, maxModelCalls: 3 },
    modelUsage: { maxCalls: 3, calls: 1, inputTokens: 12, outputTokens: 4, totalTokens: 16, unknownUsageCalls: 0, entries: [] },
    workerAttempts: 0,
    approvals: []
  });
  assert.match(rendered, /MODEL CALLS\n1\/3/);
  assert.match(rendered, /REPORTED TOKENS\n16 total \(12 input \/ 4 output\), 0 call\(s\) without usage evidence/);
  assert.match(rendered, /CAPABILITY REGISTRY\na{12}/);
  assert.match(rendered, /PROJECT SKILL POLICY\nb{12}/);
  assert.match(rendered, /CAPABILITY PREFLIGHT\nFAIL/);
  assert.doesNotMatch(rendered, /a{64}|b{64}/);
});

test('GitHub inspection reports default-branch protection without changing repository settings', async () => {
  const responses = [
    { full_name: 'owner/repo', default_branch: 'main' },
    { commit: { sha: 'base-sha' }, protected: true }
  ];
  const inspected = await new GitHubAdapter({ token: 'ghp_adapterToken', fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }) }).inspect(project());
  assert.equal(inspected.defaultBranchProtected, true);
  assert.match(report({ id: 'run', status: 'created', goal: 'fixture', repository: inspected, results: {}, budgets: { maxWorkerAttempts: 1 } }), /DEFAULT BRANCH PROTECTION\ntrue/);
});

test('command runner resolves pnpm through its JavaScript entrypoint without a shell on Windows', async () => {
  const calls = [];
  const result = await runCommand(project({ commands: { test: 'pnpm test' } }), 'test', {
    processRunner: async (binary, args) => { calls.push({ binary, args }); return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }; }
  });
  assert.equal(result.ok, true);
  if (process.platform === 'win32') {
    assert.equal(calls[0].binary, process.execPath);
    assert.match(calls[0].args[0], /pnpm\.mjs$/i);
  }
});

test('managed workspaces are isolated under the configured root and clone only the configured repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-workspace-root-'));
  const configured = configFrom({
    id: 'leadfinder', repository: { owner: 'owner', name: 'leadfinder' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    workspaceStrategy: 'managed', managedWorkspaceRoot: '.agent-workspaces', commands: { install: 'node --version', test: 'node --version', lint: 'node --version', build: 'node --version' },
    acceptance: { require: ['install', 'test', 'lint', 'build', 'ci'] }
  }, join(root, 'host', 'config'));
  const calls = [];
  const manager = new WorkspaceManager({ processRunner: async (binary, args, options) => { calls.push({ binary, args, options }); return { ok: true, exitCode: 0, durationMs: 1, stdout: '', stderr: '' }; } });
  const allocation = await manager.prepare(configured, 'agent-20260910-abcdef12');
  assert.match(allocation.workspace, /leadfinder[\\/]agent-20260910-abcdef12$/);
  assert.deepEqual(calls[0].args.slice(0, 6), ['clone', '--origin', 'origin', '--branch', 'main', 'https://github.com/owner/leadfinder.git']);
  assert.throws(() => configFrom({ ...configured, managedWorkspaceRoot: '../../escape' }, join(root, 'host', 'config')));
  assert.throws(() => managedWorkspacePath(configured, '../other-project'));
});

test('managed workspace prepare reuses a valid interrupted clone and quarantines a partial clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-workspace-recovery-'));
  const configured = configFrom({
    id: 'leadfinder', repository: { owner: 'owner', name: 'leadfinder' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    workspaceStrategy: 'managed', managedWorkspaceRoot: '.agent-workspaces', commands: { test: 'node --version' }, acceptance: { require: ['test'] }
  }, join(root, 'host', 'config'));
  const runId = 'agent-20260911-recovery1';
  const details = managedWorkspacePath(configured, runId);
  await mkdir(details.workspace, { recursive: true });
  let cloneCalls = 0;
  const valid = new WorkspaceManager({ processRunner: async (_binary, args) => {
    if (args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel') return { ok: true, exitCode: 0, stdout: details.workspace, stderr: '' };
    if (args[0] === '-C' && args[2] === 'remote') return { ok: true, exitCode: 0, stdout: 'https://github.com/owner/leadfinder.git', stderr: '' };
    if (args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--verify') return { ok: true, exitCode: 0, stdout: 'deadbeef', stderr: '' };
    if (args[0] === '-C' && args[2] === 'branch') return { ok: true, exitCode: 0, stdout: 'main', stderr: '' };
    if (args[0] === '-C' && args[2] === 'status') return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'clone') { cloneCalls += 1; return { ok: true, exitCode: 0, stdout: '', stderr: '' }; }
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  } });
  const reused = await valid.prepare(configured, runId);
  assert.equal(reused.clone.reused, true);
  assert.equal(cloneCalls, 0);

  const partialRunId = 'agent-20260911-recovery2';
  const partialDetails = managedWorkspacePath(configured, partialRunId);
  await mkdir(partialDetails.workspace, { recursive: true });
  const partial = new WorkspaceManager({ processRunner: async (_binary, args) => {
    if (args[0] === '-C') return { ok: false, exitCode: 128, stdout: '', stderr: 'not a complete repository' };
    if (args[0] === 'clone') { cloneCalls += 1; return { ok: true, exitCode: 0, durationMs: 1, stdout: '', stderr: '' }; }
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  } });
  const recovered = await partial.prepare(configured, partialRunId);
  assert.equal(recovered.clone.reused, false);
  assert.equal(cloneCalls, 1);
  const entries = await readdir(partialDetails.projectDirectory);
  assert.ok(entries.some((name) => name.startsWith(`${partialRunId}.failed-`)));
});

test('a managed-root symlink fails before clone or any workspace write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'managed-workspace-symlink-'));
  const host = join(root, 'host');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(join(host, 'config'), { recursive: true }), mkdir(outside, { recursive: true })]);
  try {
    await symlink(outside, join(host, '.agent-workspaces'), 'junction');
  } catch (error) {
    t.skip(`symbolic links are unavailable in this environment: ${error.code ?? error.message}`);
    return;
  }
  const configured = configFrom({
    id: 'leadfinder', repository: { owner: 'owner', name: 'leadfinder' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', workspaceStrategy: 'managed',
    commands: { install: 'node --version', test: 'node --version', lint: 'node --version', build: 'node --version' }, acceptance: { require: ['install', 'test', 'lint', 'build', 'ci'] }
  }, join(host, 'config'));
  let cloneAttempted = false;
  const manager = new WorkspaceManager({ processRunner: async () => { cloneAttempted = true; throw new Error('clone must not run'); } });
  await assert.rejects(() => manager.prepare(configured, 'agent-20260910-abcdef12'), /symlink/);
  assert.equal(cloneAttempted, false);
  assert.equal(existsSync(join(outside, 'leadfinder')), false);
});

test('workspace clone and repository-identity failures stop before an external branch is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-workspace-failure-'));
  const configured = configFrom({
    id: 'leadfinder', repository: { owner: 'owner', name: 'leadfinder' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', workspaceStrategy: 'managed',
    commands: { install: 'node --version', test: 'node --version', lint: 'node --version', build: 'node --version' }, acceptance: { require: ['install', 'test', 'lint', 'build', 'ci'] }
  }, join(root, 'host', 'config'));
  const manager = new WorkspaceManager({ processRunner: async () => ({ ok: false, exitCode: 1, stderr: 'clone denied', stdout: '', durationMs: 1 }) });
  await assert.rejects(() => manager.prepare(configured, 'agent-20260910-abcdef12'), /workspace_clone_failed/);
  const github = new FakeGitHub();
  github.inspect = async () => ({ provider: 'github', status: 'ok', repository: 'owner/other-repo', defaultBranch: 'main', head: 'initial-head' });
  const workspaceManager = new FakeWorkspaceManager();
  const localGit = new FakeLocalGit();
  const run = await new Orchestrator({ store: await temporaryStore(), github, workspaceManager, localGit, worker: new FakeWorker(), commandRunner: async () => ({ ok: true }) }).run(leadfinderProject(), 'Reject a mismatched repository');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(workspaceManager.prepareCalls, 0);
  assert.equal(localGit.prepareCalls, 0);
});

test('project isolation gives self and LeadFinder distinct managed workspaces and a worker failure stays unpublished', async () => {
  const manager = new FakeWorkspaceManager();
  const selfPath = manager.describe(project({ workspaceStrategy: 'managed' }), 'agent-20260910-aaaa1111').workspace;
  const leadPath = manager.describe(leadfinderProject(), 'agent-20260910-aaaa1111').workspace;
  assert.notEqual(selfPath, leadPath);
  const failingWorker = { calls: 0, async execute() { this.calls += 1; return { status: 'failed', output: 'worker failed' }; } };
  const github = new FakeGitHub();
  const run = await new Orchestrator({ store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment(), github, localGit: new FakeLocalGit(), worker: failingWorker, commandRunner: async (_project, name) => ({ name, ok: true }) }).run(leadfinderProject(), 'Stop failed worker');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(failingWorker.calls, 2);
  assert.equal(github.pullRequests, 0);
});

test('cross-repository dry-run simulates workspace, install, Vercel, and publication with zero writes', async () => {
  const workspaceManager = new FakeWorkspaceManager();
  const localGit = new FakeLocalGit();
  const github = new FakeGitHub();
  const worker = new FakeWorker();
  let commandCalls = 0;
  const run = await new Orchestrator({ store: await temporaryStore(), workspaceManager, localGit, github, worker, commandRunner: async () => { commandCalls += 1; return { ok: true }; } })
    .run(leadfinderProject(), 'Simulate a docs-only external change', { dryRun: true });
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.match(run.workspace, /leadfinder[\\/]agent-/);
  assert.equal(workspaceManager.prepareCalls, 0);
  assert.equal(worker.calls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(localGit.prepareCalls, 0);
  assert.equal(github.pullRequests, 0);
  assert.equal(run.results.install.simulated, true);
  assert.equal(run.results.deployment.simulated, true);
});

test('cross-repository happy path uses an isolated workspace, install, configured checks, and preview evidence', async () => {
  const workspaceManager = new FakeWorkspaceManager();
  const deploymentProvider = new FakeDeployment();
  const commands = [];
  const run = await new Orchestrator({
    store: await temporaryStore(), workspaceManager, deploymentProvider, github: new FakeGitHub(), localGit: new FakeLocalGit(), worker: new FakeWorker(),
    commandRunner: async (_project, name) => { commands.push(name); return { name, ok: true, exitCode: 0, durationMs: 1 }; }
  }).run(leadfinderProject(), 'Create a docs-only external fixture');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(workspaceManager.prepareCalls, 1);
  assert.deepEqual(commands, ['install', 'test', 'lint', 'build']);
  assert.equal(deploymentProvider.calls, 1);
  assert.equal(run.results.deployment.state, 'READY');
});

test('install failure stops before worker, push and PR creation', async () => {
  const worker = new FakeWorker();
  const github = new FakeGitHub();
  const run = await new Orchestrator({
    store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment(), github, localGit: new FakeLocalGit(), worker,
    commandRunner: async (_project, name) => ({ name, ok: name !== 'install', stderr: name === 'install' ? 'install failed' : '' })
  }).run(leadfinderProject(), 'Stop on bootstrap failure');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(worker.calls, 0);
  assert.equal(github.pullRequests, 0);
});

test('bootstrap changes to governed files fail before the worker starts', async () => {
  class BootstrapMutationGit extends FakeLocalGit {
    constructor() { super(); this.inspections = 0; }
    async inspectChangeSet() {
      this.inspections += 1;
      return this.inspections === 1 ? governedChangeSet([]) : governedChangeSet(['package.json'], { contentFingerprint: 'bootstrap-mutated' });
    }
  }
  const worker = new FakeWorker();
  const github = new FakeGitHub();
  const run = await new Orchestrator({
    store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment(), github, localGit: new BootstrapMutationGit(), worker,
    commandRunner: async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: '', stderr: '' })
  }).run(leadfinderProject(), 'Reject bootstrap changes before the worker');
  assert.equal(run.status, RunStatus.FAILED);
  assert.match(run.failureReason, /bootstrap_modified_governed_files/);
  assert.equal(run.results.bootstrapGovernance.ok, false);
  assert.equal(worker.calls, 0);
  assert.equal(github.pullRequests, 0);
});

test('push, PR, and Vercel failures leave coherent failed cross-repository runs', async () => {
  class FailingPushGit extends FakeLocalGit { async push() { throw new Error('push failed'); } }
  const pushRun = await new Orchestrator({ store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment(), github: new FakeGitHub(), localGit: new FailingPushGit(), worker: new FakeWorker(), commandRunner: async (_p, name) => ({ name, ok: true }) }).run(leadfinderProject(), 'Exercise push failure');
  assert.equal(pushRun.status, RunStatus.FAILED);
  const failingPr = new FakeGitHub();
  failingPr.createPullRequest = async () => { throw new Error('PR failed'); };
  const prRun = await new Orchestrator({ store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment(), github: failingPr, localGit: new FakeLocalGit(), worker: new FakeWorker(), commandRunner: async (_p, name) => ({ name, ok: true }) }).run(leadfinderProject(), 'Exercise PR failure');
  assert.equal(prRun.status, RunStatus.FAILED);
  const previewRun = await new Orchestrator({ store: await temporaryStore(), workspaceManager: new FakeWorkspaceManager(), deploymentProvider: new FakeDeployment({ state: 'ERROR', ok: false }), github: new FakeGitHub(), localGit: new FakeLocalGit(), worker: new FakeWorker(), commandRunner: async (_p, name) => ({ name, ok: true }) }).run(leadfinderProject(), 'Exercise preview failure');
  assert.equal(previewRun.status, RunStatus.FAILED);
  assert.equal(previewRun.results.deployment.state, 'ERROR');
});

test('Vercel adapter accepts only an exact non-production commit and branch match', async () => {
  const ready = new VercelDeploymentProvider({ token: 'vercel_test', fetchImpl: async () => ({ ok: true, json: async () => ({ deployments: [
    { uid: 'dpl_production', state: 'READY', target: 'production', url: 'production.vercel.app', meta: { githubCommitSha: 'sha', githubCommitRef: 'agent/run' } },
    { uid: 'dpl_wrong_branch', state: 'READY', target: null, url: 'wrong-branch.vercel.app', meta: { githubCommitSha: 'sha', githubCommitRef: 'agent/other' } },
    { uid: 'dpl_ready', state: 'READY', target: null, url: 'preview.vercel.app', createdAt: 0, meta: { githubCommitSha: 'sha', githubCommitRef: 'agent/run' } }
  ] }) }) });
  const observed = await ready.waitForPreview(leadfinderProject(), { commitSha: 'sha', branch: 'agent/run' }, { timeoutMs: 10, pollIntervalMs: 1 });
  assert.equal(observed.state, 'READY');
  assert.equal(observed.deploymentId, 'dpl_ready');
  assert.equal(observed.url, 'https://preview.vercel.app');
  let now = 0;
  const timeout = new VercelDeploymentProvider({ token: 'vercel_test', now: () => now, sleep: async () => { now += 2; }, fetchImpl: async () => ({ ok: true, json: async () => ({ deployments: [] }) }) });
  const timed = await timeout.waitForPreview(leadfinderProject(), { commitSha: 'sha', branch: 'agent/run' }, { timeoutMs: 1, pollIntervalMs: 1 });
  assert.equal(timed.state, 'TIMEOUT');
});

test('happy path persists branch, commit, push, PR, CI, evaluation, and report state', async () => {
  const store = await temporaryStore();
  const github = new FakeGitHub();
  const localGit = new FakeLocalGit();
  const worker = new FakeWorker();
  const orchestrator = new Orchestrator({
    store,
    github,
    localGit,
    worker,
    commandRunner: async (_project, name) => ({ name, ok: true, stdout: '', stderr: '', durationMs: 1 })
  });
  const run = await orchestrator.run(project(), 'Update a controlled fixture');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.match(run.workingBranch, /^agent\//);
  assert.equal(run.results.commit.ok, true);
  assert.equal(run.results.push.ok, true);
  assert.equal(run.results.pullRequest.ok, true);
  assert.equal(run.results.ci.ok, true);
  assert.equal(run.evaluation.decision, 'PASS');
  assert.equal(worker.calls, 1);
  assert.equal(github.pullRequests, 1);
});

test('a sensitive diff waits for approval before checks, commit, push, or pull-request creation', async () => {
  class SensitiveGit extends FakeLocalGit {
    async inspectChangeSet() {
      const changeSet = { paths: ['package.json'], changedFiles: 1, additions: 1, deletions: 0, diffLines: 1, sensitiveContent: false, contentFingerprint: 'package-content-a' };
      return { ...changeSet, changeSetFingerprint: fingerprintChangeSet(changeSet) };
    }
  }
  const github = new FakeGitHub();
  const localGit = new SensitiveGit();
  let commandCalls = 0;
  const orchestrator = new Orchestrator({
    store: await temporaryStore(), github, localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => { commandCalls += 1; return { name, ok: true, stdout: '', stderr: '' }; }
  });
  const waiting = await orchestrator.run(project(), 'Change a sensitive package fixture');
  assert.equal(waiting.status, RunStatus.WAITING_APPROVAL);
  assert.equal(waiting.results.changePolicy.classification, 'sensitive');
  assert.equal(commandCalls, 0);
  assert.equal(localGit.commitCalls, 0);
  assert.equal(localGit.pushCalls, 0);
  assert.equal(github.pullRequests, 0);
  await orchestrator.decideApproval(waiting.pendingAction.approvalId, true);
  const completed = await orchestrator.resume(waiting.id, project());
  assert.equal(completed.status, RunStatus.COMPLETED);
  assert.ok(commandCalls > 0);
  assert.equal(github.pullRequests, 1);
});

test('v0.4 post-check governance blocks a generated .env before any further command or publication', async () => {
  const localGit = new GovernedFakeGit();
  const github = new FakeGitHub();
  const commands = [];
  const run = await new Orchestrator({
    store: await temporaryStore(), github, localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => {
      commands.push(name);
      if (name === 'test') localGit.changeSet = governedChangeSet(['.env'], { contentFingerprint: 'env-created' });
      return { name, ok: true, stdout: '', stderr: '', durationMs: 1 };
    }
  }).run(project(), 'Do not permit generated environment files');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureReason, 'forbidden_path:.env');
  assert.deepEqual(commands, ['test']);
  assert.equal(localGit.commitCalls, 0);
  assert.equal(localGit.pushCalls, 0);
  assert.equal(github.pullRequests, 0);
});

test('v0.4 post-check governance pauses a generated sensitive package change before the next command', async () => {
  const localGit = new GovernedFakeGit();
  const commands = [];
  const run = await new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => {
      commands.push(name);
      if (name === 'test') localGit.changeSet = governedChangeSet(['package.json'], { contentFingerprint: 'package-created' });
      return { name, ok: true, stdout: '', stderr: '', durationMs: 1 };
    }
  }).run(project(), 'Pause package changes');
  assert.equal(run.status, RunStatus.WAITING_APPROVAL);
  assert.equal(run.results.changePolicy.phase, 'after_test');
  assert.equal(run.results.changePolicy.classification, 'sensitive');
  assert.deepEqual(commands, ['test']);
  assert.equal(localGit.commitCalls, 0);
});

test('v0.4 post-check governance blocks a command that exceeds the changed-file budget', async () => {
  const localGit = new GovernedFakeGit();
  const run = await new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => {
      if (name === 'test') localGit.changeSet = governedChangeSet(Array.from({ length: 9 }, (_value, index) => `src/generated-${index}.js`), { additions: 9, contentFingerprint: 'too-many-files' });
      return { name, ok: true, stdout: '', stderr: '', durationMs: 1 };
    }
  }).run(project(), 'Enforce changed-file budget');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureReason, 'change_budget_exceeded');
  assert.equal(localGit.commitCalls, 0);
});

test('v0.4 post-check governance blocks a command that exceeds the diff-line budget', async () => {
  const localGit = new GovernedFakeGit();
  const run = await new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => {
      if (name === 'test') localGit.changeSet = governedChangeSet(['src/generated.js'], { additions: 501, contentFingerprint: 'too-many-lines' });
      return { name, ok: true, stdout: '', stderr: '', durationMs: 1 };
    }
  }).run(project(), 'Enforce diff-line budget');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureReason, 'change_budget_exceeded');
  assert.equal(localGit.commitCalls, 0);
});

test('v0.4 never reuses an approval when the approved sensitive fingerprint becomes stale', async () => {
  const store = await temporaryStore();
  const localGit = new GovernedFakeGit(governedChangeSet(['package.json'], { contentFingerprint: 'sensitive-a' }));
  let commandCalls = 0;
  const orchestrator = new Orchestrator({
    store, github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => { commandCalls += 1; return { name, ok: true, stdout: '', stderr: '', durationMs: 1 }; }
  });
  const waiting = await orchestrator.run(project(), 'Approve only the reviewed sensitive change');
  const firstApprovalId = waiting.pendingAction.approvalId;
  const firstFingerprint = waiting.pendingAction.changeSetFingerprint;
  assert.equal((await store.load()).approvals[firstApprovalId].changeSetFingerprint, firstFingerprint);
  await orchestrator.decideApproval(firstApprovalId, true);
  localGit.changeSet = governedChangeSet(['package.json'], { contentFingerprint: 'sensitive-b' });
  const stale = await orchestrator.resume(waiting.id, project());
  const state = await store.load();
  assert.equal(stale.status, RunStatus.WAITING_APPROVAL);
  assert.notEqual(stale.pendingAction.approvalId, firstApprovalId);
  assert.equal(state.approvals[firstApprovalId].status, 'stale');
  assert.equal(state.approvals[firstApprovalId].execution, 'stale');
  assert.equal(commandCalls, 0);
});

test('v0.4 resumes an approved unchanged sensitive fingerprint and completes publication', async () => {
  const localGit = new GovernedFakeGit(governedChangeSet(['package.json'], { contentFingerprint: 'sensitive-a' }));
  const github = new FakeGitHub();
  let commandCalls = 0;
  const orchestrator = new Orchestrator({
    store: await temporaryStore(), github, localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => { commandCalls += 1; return { name, ok: true, stdout: '', stderr: '', durationMs: 1 }; }
  });
  const waiting = await orchestrator.run(project(), 'Approve an unchanged sensitive change');
  await orchestrator.decideApproval(waiting.pendingAction.approvalId, true);
  const completed = await orchestrator.resume(waiting.id, project());
  assert.equal(completed.status, RunStatus.COMPLETED);
  assert.equal(commandCalls, 4);
  assert.equal(github.pullRequests, 1);
});

test('v0.4 evaluates an unchanged normal change after every check and before commit', async () => {
  const localGit = new GovernedFakeGit();
  const run = await new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => ({ name, ok: true, stdout: '', stderr: '', durationMs: 1 })
  }).run(project(), 'Continuously govern an unchanged normal change');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.deepEqual(run.governanceHistory.map((entry) => entry.phase), ['before_checks', 'after_test', 'after_typecheck', 'after_lint', 'after_build', 'before_commit']);
  assert.equal(run.results.changePolicy.phase, 'before_commit');
});

test('v0.4 commits exactly the final governed change set', async () => {
  const localGit = new GovernedFakeGit(governedChangeSet(['src/only-governed.js'], { contentFingerprint: 'exact-governed-change' }));
  const run = await new Orchestrator({
    store: await temporaryStore(), github: new FakeGitHub(), localGit, worker: new FakeWorker(),
    commandRunner: async (_project, name) => ({ name, ok: true, stdout: '', stderr: '', durationMs: 1 })
  }).run(project(), 'Commit only the final governed change');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.deepEqual(run.results.commit.committedPaths, run.results.changePolicy.paths);
  assert.equal(run.results.commit.committedChangeSetFingerprint, run.results.changePolicy.changeSetFingerprint);
});

test('orchestrator model-call budget stops a retry before another worker invocation', async () => {
  const store = await temporaryStore();
  const worker = new FakeWorker();
  let testCalls = 0;
  const configured = project({ budgets: { maxModelCalls: 1, maxWorkerAttempts: 2, commandTimeoutMs: 1_000, ciTimeoutMs: 1_000, ciPollIntervalMs: 1_000 } });
  const orchestrator = new Orchestrator({
    store,
    github: new FakeGitHub(),
    localGit: new FakeLocalGit(),
    worker,
    commandRunner: async (_project, name) => {
      if (name === 'test') testCalls += 1;
      return { name, ok: name !== 'test', stdout: '', stderr: name === 'test' ? 'failure' : '', durationMs: 1 };
    }
  });
  const run = await orchestrator.run(configured, 'Bound Codex retries');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureReason, 'model_call_budget_exhausted');
  assert.equal(run.budgetExhausted, 'maxModelCalls');
  assert.equal(worker.calls, 1);
  assert.equal(testCalls, 1);
  assert.equal(run.modelUsage.calls, 1);
  assert.equal(run.modelUsage.maxCalls, 1);
  assert.equal(run.modelUsage.unknownUsageCalls, 1);
  assert.equal(run.modelUsage.entries[0].skill, 'code.implement');
  assert.equal(run.modelUsage.entries[0].status, 'completed');
});

test('orchestrator records reported token usage for the coding worker', async () => {
  const worker = {
    calls: 0,
    async execute() {
      this.calls += 1;
      return { status: 'completed', summary: 'changed fixture', output: '', usage: { input_tokens: 11, output_tokens: 7 } };
    }
  };
  const run = await new Orchestrator({
    store: await temporaryStore(),
    github: new FakeGitHub(),
    localGit: new FakeLocalGit(),
    worker,
    commandRunner: async (_project, name) => ({ name, ok: true, stdout: '', stderr: '', durationMs: 1 })
  }).run(project(), 'Account for model usage');

  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(worker.calls, 1);
  assert.equal(run.modelUsage.calls, 1);
  assert.equal(run.modelUsage.inputTokens, 11);
  assert.equal(run.modelUsage.outputTokens, 7);
  assert.equal(run.modelUsage.totalTokens, 18);
  assert.equal(run.modelUsage.unknownUsageCalls, 0);
  assert.equal(run.modelUsage.entries[0].surface, 'orchestrator');
  assert.equal(run.modelUsage.entries[0].status, 'completed');
});

test('failed checks retry once and eventually complete without an infinite loop', async () => {
  const store = await temporaryStore();
  const worker = new FakeWorker();
  let testCalls = 0;
  const orchestrator = new Orchestrator({
    store,
    github: new FakeGitHub(),
    localGit: new FakeLocalGit(),
    worker,
    commandRunner: async (_project, name) => {
      if (name === 'test') testCalls += 1;
      return { name, ok: name !== 'test' || testCalls > 1, stdout: '', stderr: testCalls === 1 ? 'failure' : '', durationMs: 1 };
    }
  });
  const run = await orchestrator.run(project(), 'Repair a failing fixture');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(worker.calls, 2);
  assert.equal(run.workerAttempts, 2);
});

test('a failed CI retries the worker, pushes the same PR branch, then completes on the next CI success', async () => {
  const github = new FakeGitHub();
  github.waitForCi = async () => {
    github.ciCalls += 1;
    return { state: github.ciCalls === 1 ? 'failure' : 'success', checks: [{ name: 'verify', status: 'completed', conclusion: github.ciCalls === 1 ? 'failure' : 'success' }] };
  };
  const localGit = new FakeLocalGit();
  const worker = new FakeWorker();
  const run = await new Orchestrator({ store: await temporaryStore(), github, localGit, worker, commandRunner: async (_project, name) => ({ name, ok: true }) })
    .run(project(), 'Fix the CI fixture');
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(worker.calls, 2);
  assert.equal(localGit.commitCalls, 2);
  assert.equal(localGit.pushCalls, 2);
  assert.equal(github.pullRequests, 1);
  assert.equal(github.ciCalls, 2);
});

test('repeated CI failures stop at maxWorkerAttempts without creating another PR', async () => {
  const github = new FakeGitHub();
  github.waitForCi = async () => ({ state: 'failure', checks: [{ name: 'verify', status: 'completed', conclusion: 'failure' }] });
  const localGit = new FakeLocalGit();
  const worker = new FakeWorker();
  const run = await new Orchestrator({ store: await temporaryStore(), github, localGit, worker, commandRunner: async (_project, name) => ({ name, ok: true }) })
    .run(project(), 'Bound the failing CI retry');
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureReason, 'worker_attempts_exhausted');
  assert.equal(worker.calls, 2);
  assert.equal(github.pullRequests, 1);
});

test('approval is distinct from execution and resume creates the approved pull request', async () => {
  const store = await temporaryStore();
  const github = new FakeGitHub();
  const orchestrator = new Orchestrator({
    store,
    github,
    localGit: new FakeLocalGit(),
    worker: new FakeWorker(),
    commandRunner: async (_project, name) => ({ name, ok: true, stdout: '', stderr: '', durationMs: 1 })
  });
  const protectedProject = project({ policies: { requireApprovalFor: ['create_pull_request'] } });
  const waiting = await orchestrator.run(protectedProject, 'Wait for publication approval');
  assert.equal(waiting.status, RunStatus.WAITING_APPROVAL);
  const approvalId = waiting.pendingAction.approvalId;
  const approval = await orchestrator.decideApproval(approvalId, true);
  assert.equal(approval.execution, 'pending');
  const completed = await orchestrator.resume(waiting.id, protectedProject);
  assert.equal(completed.status, RunStatus.COMPLETED);
  assert.equal(completed.pendingAction.execution, 'executing');
  assert.equal(github.pullRequests, 1);
});

test('deterministic evaluator fails incomplete engineering evidence', () => {
  assert.equal(evaluate({ worker: { ok: true } }).decision, 'FAIL');
  assert.equal(evaluate({ worker: { ok: true } }, { retryable: true }).decision, 'NEEDS_RETRY');
  assert.equal(evaluate({ ci: { state: 'pending' } }).decision, 'WAITING');
});


test('project command runner counts Docker preflight once inside the command timeout budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-preflight-budget-'));
  await mkdir(join(root, '.git'), { recursive: true });
  const configured = configFrom({
    id: 'budgeted', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    commands: { test: 'node --version' }, execution: { provider: 'container-required', image: 'node:22-bookworm-slim' },
    budgets: { commandTimeoutMs: 1_000 }
  }, root);
  let clock = 0;
  const calls = [];
  const processRunner = async (_binary, args, options) => {
    calls.push({ args, timeoutMs: options.timeoutMs });
    if (args[0] === 'version') { clock += 300; return { ok: true, exitCode: 0, stdout: '27.0', stderr: '' }; }
    if (args[0] === 'image') { clock += 300; return { ok: true, exitCode: 0, stdout: 'image', stderr: '' }; }
    if (args[0] === 'run') return { ok: true, exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 1 };
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };
  const containerExecution = new DockerContainerExecution({ processRunner, now: () => clock });
  const runner = new ProjectCommandRunner({ containerExecution, now: () => clock });
  const result = await runner.run(configured, 'test', { timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(({ args }) => args[0] === 'version').length, 1);
  assert.equal(calls.filter(({ args }) => args[0] === 'image').length, 1);
  assert.equal(calls.filter(({ args }) => args[0] === 'run').length, 1);
  assert.equal(calls.find(({ args }) => args[0] === 'run').timeoutMs, 400);
});


test('LocalGitAdapter fingerprints ignored protected files without reading their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-protected-ignored-'));
  const initialized = await runProcess('git', ['init'], { cwd: root, timeoutMs: 5_000 });
  assert.equal(initialized.ok, true);
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, '.gitignore'), '.env\nsecrets/\n*.pem\n');
  await writeFile(join(root, '.env'), 'TOKEN=first-secret-value\n');
  await writeFile(join(root, 'secrets', 'client.pem'), 'PRIVATE-KEY-FIRST\n');

  const adapter = new LocalGitAdapter();
  const configured = { workspace: root, budgets: { commandTimeoutMs: 5_000 } };
  const before = await adapter.inspectProtectedIgnoredState(configured);
  assert.deepEqual(before.paths, ['.env', 'secrets/client.pem']);
  assert.match(before.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(before).includes('first-secret-value'), false);
  assert.equal(JSON.stringify(before).includes('PRIVATE-KEY-FIRST'), false);

  await writeFile(join(root, '.env'), 'TOKEN=second-secret-value-with-different-size\n');
  const after = await adapter.inspectProtectedIgnoredState(configured);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.paths, before.paths);
  assert.equal(JSON.stringify(after).includes('second-secret-value'), false);
});


test('LocalGitAdapter fingerprints git control files without exposing their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-git-control-'));
  const initialized = await runProcess('git', ['init'], { cwd: root, timeoutMs: 5_000 });
  assert.equal(initialized.ok, true);
  const adapter = new LocalGitAdapter();
  const configured = { workspace: root, budgets: { commandTimeoutMs: 5_000 } };

  const before = await adapter.inspectRepositoryControlState(configured);
  assert.match(before.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(before.paths.includes('config'));
  assert.ok(before.paths.includes('info/exclude'));

  const excludePath = join(root, '.git', 'info', 'exclude');
  await writeFile(excludePath, '# changed by fixture\nprivate-cache/\n');
  const after = await adapter.inspectRepositoryControlState(configured);

  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(JSON.stringify(after).includes('private-cache'), false);
  assert.equal(JSON.stringify(after).includes('changed by fixture'), false);
});


test('Codex worker permission profile is fail-closed on native Windows', async () => {
  let constructed = 0;
  class FakeCodex { constructor() { constructed += 1; } }
  const worker = new CodexSdkWorker({ CodexClient: FakeCodex, platform: 'win32', environment: () => ({ PATH: 'C:\\safe' }) });
  const result = await worker.execute({ objective: 'fixture' }, { workspace: 'C:\\workspace', timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'codex_worker_read_isolation_unverified_on_win32');
  assert.equal(constructed, 0);
});

test('Codex worker security config denies root reads and selects only requested workspace authority', () => {
  const write = codexWorkerSecurityConfig({ writeAccess: true, pathValue: '/bin:/usr/bin', platform: 'linux' });
  const read = codexWorkerSecurityConfig({ writeAccess: false, pathValue: '/bin:/usr/bin', platform: 'darwin' });
  assert.equal(write.supported, true);
  assert.equal(read.supported, true);
  const writeProfile = write.configOverrides.find((entry) => entry.startsWith('permissions.agent-workflow.filesystem='));
  const readProfile = read.configOverrides.find((entry) => entry.startsWith('permissions.agent-workflow.filesystem='));
  assert.match(writeProfile, /":root"="deny"/);
  assert.match(writeProfile, /":minimal"="read"/);
  assert.match(writeProfile, /":workspace_roots"=\{"\."="write","\.git"="read"\}/);
  assert.match(readProfile, /":workspace_roots"=\{"\."="read","\.git"="read"\}/);
  assert.ok(write.configOverrides.includes('shell_environment_policy.set.PATH="/bin:/usr/bin"'));
  assert.equal(codexWorkerSecurityConfig({ platform: 'win32' }).supported, false);
});

test('Codex worker rejects project-local Codex control configuration before starting the SDK', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-worker-project-config-'));
  await mkdir(join(workspace, '.codex'), { recursive: true });
  await writeFile(join(workspace, '.codex', 'config.toml'), '[features]\napps = true\n');
  let constructed = 0;
  class FakeCodex { constructor() { constructed += 1; } }
  const worker = new CodexSdkWorker({ CodexClient: FakeCodex, platform: 'linux', environment: () => ({ PATH: '/safe/bin' }) });
  const result = await worker.execute({ objective: 'fixture' }, { workspace, timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.match(result.output, /worker_project_control_file_present:\.codex\/config\.toml/);
  assert.equal(constructed, 0);
});


test('git control fingerprint detects temporary ref tampering even when final HEAD is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-git-control-reflog-'));
  assert.equal((await runProcess('git', ['init'], { cwd: root, timeoutMs: 5_000 })).ok, true);
  await writeFile(join(root, 'fixture.txt'), 'one\n');
  assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
  assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'first'], { cwd: root, timeoutMs: 5_000 })).ok, true);
  const first = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();

  await writeFile(join(root, 'fixture.txt'), 'two\n');
  assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
  assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'second'], { cwd: root, timeoutMs: 5_000 })).ok, true);
  const second = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
  const branchName = (await runProcess('git', ['branch', '--show-current'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();

  const adapter = new LocalGitAdapter();
  const configured = { workspace: root, budgets: { commandTimeoutMs: 5_000 } };
  const before = await adapter.inspectRepositoryControlState(configured);

  assert.equal((await runProcess('git', ['update-ref', `refs/heads/${branchName}`, first], { cwd: root, timeoutMs: 5_000 })).ok, true);
  assert.equal((await runProcess('git', ['update-ref', `refs/heads/${branchName}`, second], { cwd: root, timeoutMs: 5_000 })).ok, true);
  assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim(), second);

  const after = await adapter.inspectRepositoryControlState(configured);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(after.paths.some((path) => path === `refs/heads/${branchName}`));
  assert.ok(after.paths.some((path) => path === `logs/refs/heads/${branchName}`));
});
