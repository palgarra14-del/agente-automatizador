import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSdkWorker,
  GitHubAdapter,
  JsonStore,
  LocalGitAdapter,
  Orchestrator,
  RunStatus,
  assertAllowedWorkingBranch,
  buildWorkerPrompt,
  configFrom,
  evaluate,
  loadProjects,
  maskSecrets,
  policy,
  runCommand,
  transition
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

  async inspect() { return { provider: 'github', status: 'ok', repository: 'owner/repo', defaultBranch: 'main', head: 'initial-head' }; }

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
