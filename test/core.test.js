import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSdkWorker,
  GitHubAdapter,
  JsonStore,
  LocalGitAdapter,
  Orchestrator,
  RunStatus,
  VercelDeploymentProvider,
  WorkspaceManager,
  assertAllowedWorkingBranch,
  buildWorkerPrompt,
  configFrom,
  doctor,
  evaluate,
  evaluateChangePolicy,
  formatDoctor,
  loadProjects,
  maskSecrets,
  policy,
  runCommand,
  report,
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

  async commit(_project, branch) {
    assert.equal(branch, this.current);
    this.commitCalls += 1;
    this.currentHead = `commit-${this.commitCalls}`;
    return { message: 'agent: safe change', finalHead: this.currentHead };
  }

  async push(_project, branch) { this.pushCalls += 1; return { branch, finalHead: this.currentHead }; }
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
  assert.deepEqual(configured.get('self').changePolicy.budgets, { maxChangedFiles: 8, maxDiffLines: 500 });
  assert.deepEqual(configured.get('leadfinder').changePolicy.budgets, { maxChangedFiles: 3, maxDiffLines: 200 });
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
    environment: {}
  });
  assert.equal(result.githubConnectivity, 'YES');
  assert.equal(result.codexAvailable, 'YES');
  assert.equal(result.vercelConfigured, 'YES');
  assert.equal(result.vercelToken, 'NO');
  assert.equal(result.branchProtection, 'NO');
  assert.match(formatDoctor(result), /COMMANDS CONFIGURED\ninstall, test, lint, build/);
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

test('project command environment permits literal non-secret values only', () => {
  assert.equal(safeCommandEnvironment({ NEXT_TELEMETRY_DISABLED: '1' }).NEXT_TELEMETRY_DISABLED, '1');
  assert.throws(() => configFrom({
    id: 'safe', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    commands: { test: 'node --version' }, commandEnvironment: { SERVICE_TOKEN: 'not-allowed' }
  }));
});

test('worker prompt redacts secrets and Codex SDK receives constrained thread options', async () => {
  let invocation = {};
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
  const worker = new CodexSdkWorker({ CodexClient: FakeCodex, environment: () => ({ PATH: '/safe/bin' }) });
  const result = await worker.execute({ objective: 'update fixture', token: 'ghp_hiddenToken', nested: { password: 'hidden' } }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(result.status, 'completed');
  assert.equal(invocation.clientOptions.env.PATH, '/safe/bin');
  assert.deepEqual(invocation.threadOptions, {
    workingDirectory: '/safe/workspace', sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled'
  });
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

test('GitHub adapter maps check runs to pending, success, and failure without exposing its token', async () => {
  const responses = [
    { check_runs: [{ name: 'verify', status: 'in_progress', conclusion: null }] },
    { check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    { check_runs: [{ name: 'verify', status: 'completed', conclusion: 'failure' }] }
  ];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  assert.equal((await adapter.checks(project(), 'sha')).state, 'pending');
  assert.equal((await adapter.checks(project(), 'sha')).state, 'success');
  assert.equal((await adapter.checks(project(), 'sha')).state, 'failure');
  assert.equal(maskSecrets('ghp_adapterToken').includes('ghp_adapterToken'), false);
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
  assert.deepEqual(calls[0].args.slice(0, 4), ['clone', '--origin', 'origin', 'https://github.com/owner/leadfinder.git']);
  assert.throws(() => configFrom({ ...configured, managedWorkspaceRoot: '../../escape' }, join(root, 'host', 'config')));
  assert.throws(() => managedWorkspacePath(configured, '../other-project'));
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
    async inspectChangeSet() { return { paths: ['package.json'], changedFiles: 1, additions: 1, deletions: 0, diffLines: 1, sensitiveContent: false }; }
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
