import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexReadOnlySkillExecutor,
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
  WorkflowPublicationBridge,
  WorkspaceManager,
  assertAllowedWorkingBranch,
  buildWorkerPrompt,
  codexWorkerSecurityConfig,
  codexTurnFailureDiagnostics,
  codexApiKeyFromEnvironment,
  collectReadOnlyRepositoryContext,
  configFrom,
  doctor,
  evaluate,
  evaluateChangePolicy,
  fingerprintChangeSet,
  formatDoctor,
  githubApiTokenForProject,
  githubGitNetworkEnvironment,
  imageIsPinned,
  loadProjects,
  maskSecrets,
  nonRetryableModelFailureCode,
  policy,
  runCommand,
  runProcess,
  report,
  remoteMatchesProject,
  readBoundedRegularFile,
  resolveExecutionUser,
  safeCommandEnvironment,
  transition,
  websiteBlueprintForBrief,
  websiteBlueprintIdForCategory,
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

  async authenticatedCommitIdentity() {
    return { id: 123, login: 'owner', name: 'owner', email: '123+owner@users.noreply.github.com' };
  }

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
  for (const id of ['self', 'leadfinder', 'callflow', 'website-pilot']) {
    assert.equal(configured.get(id).businessContext.version, 1);
    assert.match(configured.get(id).businessContext.model, /LeadFinder.*Callflow.*website-pilot/i);
    assert.ok(configured.get(id).businessContext.currentFocus.includes('Peluquerías'));
    assert.ok(configured.get(id).businessContext.constraints.some((item) => /precios|ofertas|descuentos/i.test(item)));
  }
  assert.match(configured.get('leadfinder').businessContext.projectRole, /captación|prospectos/i);
  assert.match(configured.get('callflow').businessContext.projectRole, /llamadas|seguimiento/i);
  assert.match(configured.get('website-pilot').businessContext.projectRole, /demos|webs/i);
  assert.throws(() => project({ budgets: { maxModelCalls: 0 } }), /maxModelCalls must be an integer >= 1/);
  assert.throws(() => project({ businessContext: { version: 1, model: 'x', projectRole: 'y', unknown: true } }), /businessContext contains unknown fields/);
});

test('self control-plane source and configuration require sensitive approval', async () => {
  const configured = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  for (const path of ['config/projects.json', 'config/issue-queue.json', 'src/core.js', 'src/issue-queue.js', 'src/feature.js']) {
    const decision = evaluateChangePolicy(configured.get('self'), { paths: [path], changedFiles: 1, diffLines: 1 });
    assert.equal(decision.classification, 'sensitive', path);
  }
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
    { paths: ['apps/web/package.json'], changedFiles: 1, diffLines: 1 },
    { paths: ['packages/ui/pnpm-lock.yaml'], changedFiles: 1, diffLines: 1 },
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
  assert.equal(result.previewObservation, 'GITHUB_DEPLOYMENTS_FALLBACK');
  assert.equal(result.branchProtection, 'NO');
  assert.equal(result.modelCallBudget, 6);
  assert.match(formatDoctor(result), /MODEL CALL BUDGET\n6/);
  assert.match(formatDoctor(result), /COMMANDS CONFIGURED\ninstall, test, lint, build/);
  assert.match(formatDoctor(result), /PREVIEW OBSERVATION\nGITHUB_DEPLOYMENTS_FALLBACK/);
  assert.match(formatDoctor(result), /CAPABILITY REGISTRY\n[0-9a-f]{12}/);
  assert.match(formatDoctor(result), /ORCHESTRATOR SKILLS AVAILABLE/);
  assert.match(formatDoctor(result), /EXECUTION SANDBOX AVAILABLE\nYES/);
});

test('bounded regular-file reader rejects symlinks and oversize workflow inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bounded-input-'));
  const regular = join(root, 'brief.json');
  const oversized = join(root, 'oversized.json');
  const linked = join(root, 'brief-link.json');
  await writeFile(regular, '{"ok":true}');
  await writeFile(oversized, 'x'.repeat(33));
  await symlink(regular, linked);

  const content = await readBoundedRegularFile(regular, { maxBytes: 32, label: 'Business brief' });
  assert.equal(content.toString('utf8'), '{"ok":true}');
  await assert.rejects(
    readBoundedRegularFile(linked, { maxBytes: 32, label: 'Business brief' }),
    /regular non-symlink file/
  );
  await assert.rejects(
    readBoundedRegularFile(oversized, { maxBytes: 32, label: 'Business brief' }),
    /exceeds 32 bytes/
  );
});

test('read-only repository context excerpts large files while fingerprinting the full source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-large-context-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    const path = join(root, 'src', 'large.js');
    const source = Array.from({ length: 7_000 }, (_, index) => `export const marker${index} = "${index}";`).join('\n') + '\n';
    assert.ok(Buffer.byteLength(source) > 64 * 1024);
    await writeFile(path, source);
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['add', 'src/large.js'], { cwd: root, timeoutMs: 5_000 })).ok, true);

    const configured = { changePolicy: { forbiddenPaths: [] } };
    const limits = {
      maxFileBytes: 8 * 1024,
      maxSourceFileBytes: 512 * 1024,
      maxTotalBytes: 16 * 1024,
      maxSourceTotalBytes: 1024 * 1024
    };
    const first = await collectReadOnlyRepositoryContext({
      workspace: root,
      project: configured,
      scope: { allowedPaths: ['src/large.js'], forbiddenPaths: [] },
      limits
    });
    const file = first.files[0];
    assert.equal(file.path, 'src/large.js');
    assert.equal(file.excerpted, true);
    assert.ok(file.bytes > limits.maxFileBytes);
    assert.ok(file.excerptBytes <= limits.maxFileBytes);
    assert.ok(Buffer.byteLength(file.content) <= limits.maxFileBytes);
    assert.match(file.content, /marker0/);
    assert.match(file.content, /marker6999/);
    assert.match(file.content, /repository context excerpt 1\/8/);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);

    const changed = source.replace('marker3500 = "3500"', 'marker3500 = "X3500"');
    await writeFile(path, changed);
    const second = await collectReadOnlyRepositoryContext({
      workspace: root,
      project: configured,
      scope: { allowedPaths: ['src/large.js'], forbiddenPaths: [] },
      limits
    });
    assert.notEqual(second.files[0].sha256, file.sha256);
    assert.notEqual(second.fingerprint, first.fingerprint);

    await assert.rejects(
      collectReadOnlyRepositoryContext({
        workspace: root,
        project: configured,
        scope: { allowedPaths: ['src/large.js'], forbiddenPaths: [] },
        limits: { ...limits, maxSourceFileBytes: 64 * 1024 }
      }),
      /repository_context_file_read_failed:src\/large\.js:.*exceeds 65536 bytes/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only repository context excludes forbidden files before limits and never exposes their bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-filtered-context-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'allowed.js'), 'export const allowedMarker = "visible";\n');
    await writeFile(join(root, 'src', 'capabilities.js'), 'export const forbiddenMarker = "must-never-be-visible";\n');
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['add', 'src'], { cwd: root, timeoutMs: 5_000 })).ok, true);

    const configured = { changePolicy: { forbiddenPaths: [] } };
    const context = await collectReadOnlyRepositoryContext({
      workspace: root,
      project: configured,
      scope: { allowedPaths: ['src'], forbiddenPaths: ['src/capabilities.js'] },
      limits: {
        maxFiles: 1,
        maxFileBytes: 4 * 1024,
        maxSourceFileBytes: 8 * 1024,
        maxTotalBytes: 4 * 1024,
        maxSourceTotalBytes: 8 * 1024
      }
    });

    assert.deepEqual(context.files.map((file) => file.path), ['src/allowed.js']);
    assert.match(context.files[0].content, /allowedMarker/);
    assert.doesNotMatch(JSON.stringify(context), /must-never-be-visible/);

    await assert.rejects(
      collectReadOnlyRepositoryContext({
        workspace: root,
        project: configured,
        scope: { allowedPaths: ['src/capabilities.js'], forbiddenPaths: ['src/capabilities.js'] }
      }),
      /repository_context_forbidden_path:src\/capabilities\.js/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('JsonStore commits a capped save through a deadline-bounded rename process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deadline-state-'));
  const file = join(directory, 'state.json');
  const calls = [];
  const store = new JsonStore(file, {
    now: () => 1_000,
    processRunner: async (binary, args, options) => {
      calls.push({ binary, args, options });
      await rename(args.at(-2), args.at(-1));
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
    }
  });
  await store.save({ ok: true }, { deadlineAt: 2_000 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, process.execPath);
  assert.equal(calls[0].options.timeoutMs, 1_000);
  assert.equal(calls[0].options.killGraceMs, 0);
});

test('JsonStore rejects a capped save when the rename process reaches the deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deadline-state-timeout-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file, {
    now: () => 1_000,
    processRunner: async () => ({ ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '', durationMs: 1_000 })
  });
  await assert.rejects(() => store.save({ ok: true }, { deadlineAt: 2_000 }), /workflow_deadline_cap_exceeded/);
  assert.equal(existsSync(file), false);
});

test('JsonStore reconciles a deadline timeout when the rename already committed the intended state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deadline-state-reconcile-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file, {
    now: () => 1_000,
    processRunner: async (_binary, args) => {
      await rename(args.at(-2), args.at(-1));
      return { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '', durationMs: 1_000 };
    }
  });
  await store.save({ reconciled: true }, { deadlineAt: 2_000 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).reconciled, true);
});

test('LocalGitAdapter uses zero kill grace for deadline-bound git commands', async () => {
  const calls = [];
  const git = new LocalGitAdapter({
    now: () => 1_000,
    processRunner: async (_binary, _args, options) => {
      calls.push(options);
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
    }
  });
  await git.git(['status', '--porcelain'], project(), { deadlineAt: 2_000 });
  assert.equal(calls[0].timeoutMs, 1_000);
  assert.equal(calls[0].killGraceMs, 0);
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
  assert.equal(configured.get('self').execution.image, 'agent-node22-pnpm11:local');
  assert.equal(imageIsPinned(configured.get('self').execution.image), false);
  assert.equal(configured.get('leadfinder').execution.provider, 'container-required');
  assert.equal(configured.get('leadfinder').execution.image, 'agent-node22-pnpm11:local');
  assert.equal(imageIsPinned('registry.example/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(imageIsPinned(configured.get('leadfinder').execution.image), false);
  assert.throws(() => project({ execution: { provider: 'container-required', image: 'node:22-bookworm-slim', fallbackProvider: 'local-sanitized' } }), /cannot use a host fallback/);
  assert.throws(() => project({ execution: { provider: 'container', image: 'node:22-bookworm-slim', user: 'root' } }), /numeric uid:gid/);
});

test('v0.12 dependency refresh configuration is exact, frozen, script-disabled, and container-required', () => {
  const npm = project({
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim' }
  });
  assert.equal(npm.commands.dependencyRefresh, 'npm ci --ignore-scripts');

  const pnpm = project({
    commands: { dependencyRefresh: 'pnpm install --frozen-lockfile --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'pnpm', version: '11.19.0' },
    execution: { provider: 'container-required', image: 'agent-node22-pnpm11:local' }
  });
  assert.equal(pnpm.commands.dependencyRefresh, 'pnpm install --frozen-lockfile --ignore-scripts');

  assert.throws(() => project({
    commands: { dependencyRefresh: 'npm install lodash', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim' }
  }), /exact frozen no-lifecycle-script command/);

  assert.throws(() => project({
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'local-sanitized' }
  }), /requires container-required/);
});

test('v0.12 dependency refresh is the only post-worker container stage allowed to use network', () => {
  const configured = project({
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim' }
  });
  const execution = new DockerContainerExecution();
  const gitMetadata = join(configured.workspace, '.git');

  const verification = execution.commandArguments(configured, 'test', { stage: 'post-worker', containerName: 'agent-test', gitMetadata });
  assert.equal(verification.containerArgs[verification.containerArgs.indexOf('--network') + 1], 'none');
  assert.equal(verification.networkEnabled, false);

  const dependencyRefresh = execution.commandArguments(configured, 'dependencyRefresh', { stage: 'dependency-refresh', containerName: 'agent-deps', gitMetadata });
  assert.equal(dependencyRefresh.containerArgs.includes('--network'), false);
  assert.equal(dependencyRefresh.networkEnabled, true);
  assert.equal(dependencyRefresh.stage, 'dependency-refresh');
  assert.deepEqual(dependencyRefresh.containerArgs.slice(-4), ['node:22-bookworm-slim', 'npm', 'ci', '--ignore-scripts']);

  assert.throws(
    () => execution.commandArguments(configured, 'test', { stage: 'dependency-refresh', containerName: 'agent-bypass', gitMetadata }),
    /only allows dependencyRefresh/
  );
  assert.throws(
    () => execution.commandArguments(configured, 'dependencyRefresh', { stage: 'unknown', containerName: 'agent-bypass', gitMetadata }),
    /Unknown execution stage/
  );
});

test('v0.12 project command runner refuses dependency refresh if provider or frozen command is tampered after configuration', async () => {
  const configured = project({
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim' }
  });
  const runner = new ProjectCommandRunner({
    containerExecution: { availability: async () => ({ available: true, provider: 'container', sandboxed: true }), probe: async () => ({ available: true }), execute: async () => ({ ok: true, execution: { provider: 'container' } }) },
    localExecution: { availability: async () => ({ available: true, provider: 'local-sanitized' }), execute: async () => ({ ok: true, execution: { provider: 'local-sanitized' } }) }
  });

  const wrongProvider = { ...configured, execution: { ...configured.execution, provider: 'local-sanitized' } };
  await assert.rejects(runner.run(wrongProvider, 'dependencyRefresh', { stage: 'dependency-refresh' }), /requires container-required/);

  const wrongCommand = { ...configured, commands: { ...configured.commands, dependencyRefresh: 'npm ci' } };
  await assert.rejects(runner.run(wrongCommand, 'dependencyRefresh', { stage: 'dependency-refresh' }), /no longer matches the frozen policy/);

  await assert.rejects(runner.run(configured, 'test', { stage: 'dependency-refresh' }), /only allows dependencyRefresh/);
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
  let commitGitOptions = null;
  adapter.git = async (args, _project, options = {}) => {
    if (args[0] === 'diff' && args[1] === '--cached' && args.includes('--name-only')) {
      return { exitCode: 0, stdout: `${changeSet.paths.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'diff' && args[1] === '--cached') return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'commit') commitGitOptions = options;
    observed.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await adapter.commit(configured, 'agent/test', 'safe change', {
    expectedChangeSetFingerprint: changeSet.changeSetFingerprint,
    expectedHead: 'base-head',
    expectedRemote: 'https://github.com/owner/repo.git',
    identity: { name: 'owner', email: '123+owner@users.noreply.github.com' }
  });
  await adapter.push(configured, 'agent/test', { expectedHead: 'commit-head', expectedRemote: 'https://github.com/owner/repo.git' });
  assert.deepEqual(observed.filter((value) => !Array.isArray(value)), [
    { branch: 'agent/test', head: 'base-head', remote: 'https://github.com/owner/repo.git' },
    { branch: 'agent/test', head: 'commit-head', remote: 'https://github.com/owner/repo.git' }
  ]);
  assert.deepEqual(observed.find((args) => Array.isArray(args) && args[0] === 'commit').slice(0, 2), ['commit', '--no-verify']);
  assert.deepEqual(commitGitOptions?.env, {
    GIT_AUTHOR_NAME: 'owner',
    GIT_AUTHOR_EMAIL: '123+owner@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'owner',
    GIT_COMMITTER_EMAIL: '123+owner@users.noreply.github.com'
  });
});

test('managed commit succeeds without host git identity and does not write repository identity config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-managed-identity-'));
  try {
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'one\n');
    assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    const baseHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
    assert.equal((await runProcess('git', ['switch', '-c', 'agent/test'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'two\n');

    const configDirectory = join(root, 'config');
    await mkdir(configDirectory, { recursive: true });
    const configured = configFrom({
      id: 'fixture',
      repository: { owner: 'owner', name: 'repo' },
      defaultBranch: 'main',
      protectedBranches: ['main'],
      workspace: '..',
      commands: { test: 'node --version' }
    }, configDirectory);
    const adapter = new LocalGitAdapter();
    const changeSet = await adapter.inspectChangeSet(configured);
    const beforeConfig = (await readFile(join(root, '.git', 'config'), 'utf8'));

    const committed = await adapter.commit(configured, 'agent/test', 'identity fixture', {
      expectedChangeSetFingerprint: changeSet.changeSetFingerprint,
      expectedHead: baseHead,
      expectedRemote: 'https://github.com/owner/repo.git',
      identity: { name: 'owner', email: '123+owner@users.noreply.github.com' }
    });

    assert.match(committed.finalHead, /^[a-f0-9]{40}$/);
    const identity = (await runProcess('git', ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce'], { cwd: root, timeoutMs: 5_000 })).stdout.trim().split('\0');
    assert.deepEqual(identity, [
      'owner',
      '123+owner@users.noreply.github.com',
      'owner',
      '123+owner@users.noreply.github.com'
    ]);
    assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), beforeConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed commit preserves the reviewed change-set fingerprint when staging new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-staging-invariant-'));
  try {
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'one\n');
    assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    const baseHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
    assert.equal((await runProcess('git', ['switch', '-c', 'agent/test'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'two\n');
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'test/new.test.js'), "export const fresh = true;\n");
    const configDirectory = join(root, 'config');
    await mkdir(configDirectory, { recursive: true });
    const configured = configFrom({
      id: 'fixture', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main',
      protectedBranches: ['main'], workingBranchPattern: 'agent/{runId}', workspace: '..',
      commands: { test: 'node --version' }
    }, configDirectory);
    const adapter = new LocalGitAdapter();
    const reviewed = await adapter.inspectChangeSet(configured);
    assert.deepEqual([...reviewed.paths].sort(), ['fixture.txt', 'test/new.test.js']);
    const committed = await adapter.commit(configured, 'agent/test', 'staging invariant fixture', {
      expectedChangeSetFingerprint: reviewed.changeSetFingerprint, expectedHead: baseHead,
      expectedRemote: 'https://github.com/owner/repo.git',
      identity: { name: 'owner', email: '123+owner@users.noreply.github.com' }
    });
    assert.equal(committed.committedChangeSetFingerprint, reviewed.changeSetFingerprint);
    assert.deepEqual(committed.committedPaths, ['fixture.txt', 'test/new.test.js']);
    assert.equal((await runProcess('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 5_000 })).stdout, '');
    const committedPaths = (await runProcess('git', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout
      .split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(committedPaths, ['fixture.txt', 'test/new.test.js']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed commit rejects a new untracked file created after staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-post-stage-untracked-'));
  try {
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'one\n');
    assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    const baseHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
    assert.equal((await runProcess('git', ['switch', '-c', 'agent/test'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'reviewed\n');
    const configDirectory = join(root, 'config');
    await mkdir(configDirectory, { recursive: true });
    const configured = configFrom({
      id: 'fixture', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main',
      protectedBranches: ['main'], workingBranchPattern: 'agent/{runId}', workspace: '..',
      commands: { test: 'node --version' }
    }, configDirectory);
    const adapter = new LocalGitAdapter();
    const reviewed = await adapter.inspectChangeSet(configured);
    const realGit = adapter.git.bind(adapter);
    let injected = false;
    adapter.git = async (args, project, options = {}) => {
      const result = await realGit(args, project, options);
      if (!injected && args[0] === 'add' && args[1] === '--all') {
        injected = true;
        await writeFile(join(root, 'late-untracked.txt'), 'appeared after staging\n');
      }
      return result;
    };
    await assert.rejects(adapter.commit(configured, 'agent/test', 'must reject post-stage drift', {
      expectedChangeSetFingerprint: reviewed.changeSetFingerprint, expectedHead: baseHead,
      expectedRemote: 'https://github.com/owner/repo.git',
      identity: { name: 'owner', email: '123+owner@users.noreply.github.com' }
    }), /changeset_changed_while_staging/);
    assert.equal(injected, true);
    assert.equal((await realGit(['rev-parse', 'HEAD'], configured)).stdout.trim(), baseHead);
    assert.equal((await realGit(['ls-files', '--others', '--exclude-standard'], configured)).stdout.trim(), 'late-untracked.txt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed commit still rejects real content drift before staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-staging-drift-'));
  try {
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'fixture.txt'), 'one\n');
    assert.equal((await runProcess('git', ['add', 'fixture.txt'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    const baseHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
    assert.equal((await runProcess('git', ['switch', '-c', 'agent/test'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    await writeFile(join(root, 'new.txt'), 'reviewed\n');
    const configDirectory = join(root, 'config');
    await mkdir(configDirectory, { recursive: true });
    const configured = configFrom({
      id: 'fixture', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main',
      protectedBranches: ['main'], workingBranchPattern: 'agent/{runId}', workspace: '..',
      commands: { test: 'node --version' }
    }, configDirectory);
    const adapter = new LocalGitAdapter();
    const reviewed = await adapter.inspectChangeSet(configured);
    await writeFile(join(root, 'new.txt'), 'changed after review\n');
    await assert.rejects(adapter.commit(configured, 'agent/test', 'must fail closed', {
      expectedChangeSetFingerprint: reviewed.changeSetFingerprint, expectedHead: baseHead,
      expectedRemote: 'https://github.com/owner/repo.git',
      identity: { name: 'owner', email: '123+owner@users.noreply.github.com' }
    }), /changeset_changed_before_commit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed commit fails closed when GitHub-bound identity is missing or malformed', async () => {
  const configured = project({ workingBranchPattern: 'agent/{runId}' });
  const adapter = new LocalGitAdapter();
  const changeSet = governedChangeSet();
  adapter.assertRepositoryState = async () => ({ currentBranch: 'agent/test', initialHead: 'base-head', remote: 'https://github.com/owner/repo.git' });
  adapter.assertWorkingBranch = async () => {};
  adapter.inspectChangeSet = async () => changeSet;
  adapter.git = async (args) => {
    if (args[0] === 'diff' && args[1] === '--cached') return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'commit') throw new Error('commit subprocess must not run with invalid identity');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const base = {
    expectedChangeSetFingerprint: changeSet.changeSetFingerprint,
    expectedHead: 'base-head',
    expectedRemote: 'https://github.com/owner/repo.git'
  };
  await assert.rejects(adapter.commit(configured, 'agent/test', 'missing identity', base), /managed_git_commit_identity_invalid/);
  await assert.rejects(
    adapter.commit(configured, 'agent/test', 'bad identity', { ...base, identity: { name: 'owner', email: 'owner@example.com' } }),
    /managed_git_commit_identity_invalid/
  );
});

test('model billing/auth failures are fail-fast while transient transport failures remain retryable', () => {
  assert.equal(nonRetryableModelFailureCode(
    'stream disconnected before completion: You have no credits remaining. Add credits to continue using the API.'
  ), 'model_billing_unavailable');
  assert.equal(nonRetryableModelFailureCode('insufficient_quota'), 'model_billing_unavailable');
  assert.equal(nonRetryableModelFailureCode('billing_hard_limit_reached'), 'model_billing_unavailable');
  assert.equal(nonRetryableModelFailureCode('Incorrect API key provided'), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode('invalid_api_key'), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode(
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
  ), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode('session expired'), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode('login required'), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode('not logged in'), 'model_authentication_unavailable');
  assert.equal(nonRetryableModelFailureCode('rate limit exceeded, retry later'), null);
  assert.equal(nonRetryableModelFailureCode('stream disconnected before completion'), null);
  assert.equal(nonRetryableModelFailureCode(null), null);
});

test('project subprocesses retain PATH but never inherit orchestrator credentials', async () => {
  const names = ['AGENT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const agentGitToken = 'ghp_agent_command_environment_test_1234567890';
  Object.assign(process.env, {
    AGENT_GITHUB_TOKEN: agentGitToken,
    GITHUB_TOKEN: 'ghp_command_environment_test', VERCEL_TOKEN: 'vcp_command_environment_test',
    OPENAI_API_KEY: 'sk-command_environment_test', CODEX_API_KEY: 'codex-command_environment_test'
  });
  try {
    const result = await runCommand(project({ commands: { test: 'node fixtures/command-env.js' } }), 'test');
    const observed = JSON.parse(result.stdout);
    assert.equal(result.ok, true);
    assert.equal(observed.pathAvailable, true);
    assert.deepEqual(observed.credentials, { github: false, vercel: false, openai: false, codex: false });
    assert.equal(result.stdout.includes(agentGitToken), false);
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
          return {
            finalResponse: 'changed one fixture',
            usage: { input_tokens: 1 },
            items: [
              {
                id: 'cmd-1',
                type: 'command_execution',
                command: 'codex --fixture token=ghp_hiddenDiagnosticSecret',
                aggregated_output: 'spawn failed: executable missing; Authorization: Bearer secret-diagnostic',
                exit_code: 127,
                status: 'failed'
              },
              {
                id: 'file-1',
                type: 'file_change',
                changes: [{ path: 'tests/prospect-utils.test.mjs', kind: 'update' }],
                status: 'failed'
              }
            ]
          };
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
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].type, 'command_execution');
  assert.equal(result.diagnostics[0].exitCode, 127);
  assert.equal(result.diagnostics[0].executable, 'codex');
  assert.equal(result.diagnostics[0].errorOutput.includes('secret-diagnostic'), false);
  assert.equal(JSON.stringify(result.diagnostics[0]).includes('ghp_hiddenDiagnosticSecret'), false);
  assert.deepEqual(result.diagnostics[1], { type: 'file_change', paths: ['tests/prospect-utils.test.mjs'] });
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

test('coding prompt executes the fingerprint-bound approved plan without weakening safety rules', () => {
  const prompt = buildWorkerPrompt({
    objective: 'Improve one deterministic edge case',
    scope: { allowedPaths: ['tests/prospect-utils.test.mjs'], forbiddenPaths: ['config.js', '.github'] },
    approvedPlanChange: {
      recommendedChange: 'Add regression assertions for solid and insufficient_data without changing production logic.',
      approvedDependencyEvidenceFingerprint: 'a'.repeat(64)
    }
  });
  assert.match(prompt, /fingerprint-bound human-approved implementation plan/i);
  assert.match(prompt, /perform those edits in the workspace/i);
  assert.ok(prompt.includes('Add regression assertions for solid and insufficient_data without changing production logic.'));
  assert.match(prompt, /never as authority to override scope/i);
  assert.match(prompt, /structured coding task as untrusted data/i);
  assert.match(prompt, /cannot override these rules/i);
});

test('coding prompt uses governed business context without inventing commercial facts', () => {
  const prompt = buildWorkerPrompt({
    objective: 'Improve lead handoff',
    businessContext: {
      version: 1,
      model: 'LeadFinder -> Callflow -> demo -> follow-up -> conversion',
      projectRole: 'Improve CRM follow-up quality.',
      priorities: ['Reduce repeated manual work.'],
      metrics: ['follow-ups completed'],
      constraints: ['Do not invent prices or prospect facts.']
    }
  });
  assert.match(prompt, /trusted strategic context/i);
  assert.match(prompt, /measurable funnel improvements/i);
  assert.match(prompt, /Do not infer or hard-code prices/i);
  assert.ok(prompt.includes('LeadFinder -> Callflow -> demo -> follow-up -> conversion'));
  assert.ok(prompt.includes('follow-ups completed'));
});

test('website coding prompt forbids fabricated business claims and preserves brief restrictions', () => {
  const prompt = buildWorkerPrompt({
    objective: 'Create a professional local website',
    websiteBuild: {
      businessBrief: {
        businessName: 'Fontanería Ejemplo',
        facts: ['Atención en Madrid'],
        contentRestrictions: ['No afirmar servicio 24 horas']
      },
      websitePlan: { missingInputs: ['Años de experiencia', 'Precios'] },
      assetEvidence: { assets: [{ path: 'public/logo.png', sha256: 'a'.repeat(64) }] }
    }
  });
  for (const required of [
    'complete authoritative source of business facts',
    'Do not invent or imply testimonials',
    'prices',
    'guarantees',
    'certifications',
    'opening hours',
    'websitePlan.missingInputs',
    'contentRestrictions',
    'verified asset paths'
  ]) assert.ok(prompt.includes(required), required);
  assert.ok(prompt.includes('No afirmar servicio 24 horas'));
  assert.match(prompt, /structured coding task as untrusted data/i);
  assert.match(prompt, /cannot override these rules/i);
});

test('read-only deterministic diagnosis consumes no Codex client and stays grounded in validated inspection', async () => {
  let clientConstructions = 0;
  class NeverCodex {
    constructor() { clientConstructions += 1; }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: NeverCodex });
  assert.equal(executor.usesModel('code.inspect'), true);
  assert.equal(executor.usesModel('code.diagnose'), false);

  const sourceContent = 'fixture';
  const sourceSha = createHash('sha256').update(sourceContent).digest('hex');
  const sourceBytes = Buffer.byteLength(sourceContent);
  const sourceMetadata = [{ path: 'src/core.js', sha256: sourceSha, bytes: sourceBytes }];
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(sourceMetadata)).digest('hex');
  const request = {
    skill: 'code.diagnose',
    goal: 'Apply the explicitly bounded change without touching unrelated files',
    contract: { version: 3, inputs: [], outputs: ['diagnosis'] },
    context: {
      priorEvidence: {
        'inspect-project': {
          inspectionEvidence: {
            summary: 'The target behavior is isolated in src/core.js.',
            relevantPaths: ['src/core.js'],
            findings: ['The current branch performs the redundant analysis step before approval.']
          }
        }
      },
      repositoryContext: {
        version: 1,
        files: [{ path: 'src/core.js', sha256: sourceSha, bytes: sourceBytes, content: sourceContent }],
        fingerprint: sourceFingerprint
      }
    }
  };
  const result = await executor.execute(request, { workspace: process.cwd(), timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.executionMode, 'deterministic');
  assert.equal(result.codexThreadId, null);
  assert.equal(result.usage, null);
  assert.notEqual(result.result.diagnosis.recommendedChange, request.goal);
  assert.match(result.result.diagnosis.recommendedChange, /validated inspected paths \[src\/core\.js\]/);
  assert.match(result.result.diagnosis.recommendedChange, /Apply the explicitly bounded change/);
  assert.deepEqual(result.result.diagnosis.relevantPaths, ['src/core.js']);
  assert.match(result.result.diagnosis.cause, /redundant analysis step/);
  assert.equal(result.result.diagnosis.risks.length, 2);
  assert.match(result.result.diagnosis.risks[0], /src\/core\.js/);
  assert.match(result.result.diagnosis.risks[1], /approval, review, verification, publication/);
  assert.equal(clientConstructions, 0);

  const longGoal = 'Prioritize qualified-lead throughput, follow-up quality, demo turnaround and conversion learning while preserving every existing governance boundary. ' + 'commercial-context '.repeat(70);
  assert.ok(longGoal.length > 1_000);
  const longGoalResult = await executor.execute({ ...request, goal: longGoal }, { workspace: process.cwd(), timeoutMs: 100 });
  assert.equal(longGoalResult.ok, true);
  assert.equal(longGoalResult.executionMode, 'deterministic');
  assert.match(longGoalResult.result.diagnosis.recommendedChange, /Prioritize qualified-lead throughput/);
  assert.ok(longGoalResult.result.diagnosis.recommendedChange.length <= 1_500);
  assert.equal(clientConstructions, 0);

  const missing = await executor.execute({
    ...request,
    context: { priorEvidence: {}, repositoryContext: request.context.repositoryContext }
  }, { workspace: process.cwd(), timeoutMs: 100 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing_validated_inspection/);
  assert.equal(clientConstructions, 0);

  const otherContent = 'fixture';
  const otherSha = createHash('sha256').update(otherContent).digest('hex');
  const otherBytes = Buffer.byteLength(otherContent);
  const otherMetadata = [{ path: 'test/core.test.js', sha256: otherSha, bytes: otherBytes }];
  const otherFingerprint = createHash('sha256').update(JSON.stringify(otherMetadata)).digest('hex');
  const mismatchedContext = await executor.execute({
    ...request,
    context: {
      ...request.context,
      repositoryContext: {
        version: 1,
        files: [{ path: 'test/core.test.js', sha256: otherSha, bytes: otherBytes, content: otherContent }],
        fingerprint: otherFingerprint
      }
    }
  }, { workspace: process.cwd(), timeoutMs: 100 });
  assert.equal(mismatchedContext.ok, false);
  assert.match(mismatchedContext.error, /deterministic_diagnosis_invalid_inspection:inspection_references_unsupplied_path:src\/core\.js/);
  assert.equal(clientConstructions, 0);

  const rebound = await executor.execute({
    ...request,
    context: {
      priorEvidence: {
        'inspect-project': {
          inspectionEvidence: {
            summary: 'The target behavior is isolated in test/core.test.js.',
            relevantPaths: ['test/core.test.js'],
            findings: ['The regression fixture must change with the inspected path binding.']
          }
        }
      },
      repositoryContext: {
        version: 1,
        files: [{ path: 'test/core.test.js', sha256: otherSha, bytes: otherBytes, content: otherContent }],
        fingerprint: otherFingerprint
      }
    }
  }, { workspace: process.cwd(), timeoutMs: 100 });
  assert.equal(rebound.ok, true);
  assert.deepEqual(rebound.result.diagnosis.relevantPaths, ['test/core.test.js']);
  assert.match(rebound.result.diagnosis.recommendedChange, /validated inspected paths \[test\/core\.test\.js\]/);
  assert.notEqual(rebound.result.diagnosis.recommendedChange, result.result.diagnosis.recommendedChange);
  assert.notEqual(
    createHash('sha256').update(JSON.stringify(rebound.result.diagnosis)).digest('hex'),
    createHash('sha256').update(JSON.stringify(result.result.diagnosis)).digest('hex')
  );
  assert.equal(clientConstructions, 0);
});

test('website blueprint selection is deterministic, fact-bound, accent-insensitive, and has a generic fallback', () => {
  assert.equal(websiteBlueprintIdForCategory('Peluquería y salón de belleza'), 'beauty-salon');
  assert.equal(websiteBlueprintIdForCategory('PELUQUERIA PREMIUM'), 'beauty-salon');
  assert.equal(websiteBlueprintIdForCategory('Barbería urbana'), 'beauty-salon');
  assert.equal(websiteBlueprintIdForCategory('Fontanería 24 horas'), 'home-services');
  assert.equal(websiteBlueprintIdForCategory('Reformas integrales'), 'home-services');
  assert.equal(websiteBlueprintIdForCategory('Estudio jurídico local'), 'generic-local');
  assert.equal(websiteBlueprintIdForCategory('Wheelchair repair'), 'generic-local');

  const brief = {
    category: 'Salón de Belleza',
    locations: ['Madrid'],
    services: [{ name: 'Corte' }],
    facts: ['Solo con cita.'],
    contentRestrictions: ['No inventar precios.'],
    contact: {},
    assets: {},
    website: {
      primaryGoal: 'solicitar cita',
      requiredPages: ['home', 'servicios', 'contacto'],
      requiredFeatures: ['CTA de cita']
    }
  };
  const beauty = websiteBlueprintForBrief(brief);
  const beautyAgain = websiteBlueprintForBrief(JSON.parse(JSON.stringify(brief)));
  const home = websiteBlueprintForBrief({ ...brief, category: 'Fontanería' });
  const generic = websiteBlueprintForBrief({ ...brief, category: 'Consultoría' });

  assert.equal(beauty.profileId, 'beauty-salon');
  assert.equal(home.profileId, 'home-services');
  assert.equal(generic.profileId, 'generic-local');
  assert.deepEqual(beauty, beautyAgain);
  assert.notDeepEqual(beauty, home);
  assert.deepEqual(beauty.pages.map((page) => page.route), ['/', '/servicios', '/contacto']);
  assert.ok(beauty.pages.find((page) => page.route === '/')?.sections.includes('hero'));
  assert.deepEqual(beauty.contentSources.services, ['businessBrief.services[0]']);
  assert.deepEqual(beauty.seoRequirements.locationSources, ['businessBrief.locations[0]']);
  assert.equal(beauty.ctas[0].kind, 'route');
  assert.equal(beauty.ctas[0].destination, '/contacto');
  assert.equal(beauty.pages.find((page) => page.route === '/')?.sections.includes('contact'), false);
  const dedicatedContactAgain = websiteBlueprintForBrief(JSON.parse(JSON.stringify(brief)));
  assert.deepEqual(dedicatedContactAgain.ctas, beauty.ctas);
  assert.equal(
    createHash('sha256').update(JSON.stringify(dedicatedContactAgain)).digest('hex'),
    createHash('sha256').update(JSON.stringify(beauty)).digest('hex')
  );

  const homeContactBrief = {
    ...brief,
    website: { ...brief.website, requiredPages: ['home'] }
  };
  const homeContact = websiteBlueprintForBrief(homeContactBrief);
  const homeContactAgain = websiteBlueprintForBrief(JSON.parse(JSON.stringify(homeContactBrief)));
  assert.equal(homeContact.pages.find((page) => page.route === '/')?.sections.includes('contact'), true);
  assert.equal(homeContact.ctas[0].kind, 'section');
  assert.equal(homeContact.ctas[0].destination, '#contact');
  assert.deepEqual(homeContactAgain.ctas, homeContact.ctas);
  assert.equal(
    createHash('sha256').update(JSON.stringify(homeContactAgain)).digest('hex'),
    createHash('sha256').update(JSON.stringify(homeContact)).digest('hex')
  );

  const assertBlueprintCtasResolve = (blueprint) => {
    const routes = new Set(blueprint.navigation.routes.map((entry) => entry.route));
    const homeAnchors = new Set(blueprint.navigation.homeAnchors);
    for (const cta of blueprint.ctas) {
      if (cta.destination === 'provided-contact') continue;
      if (cta.destination.startsWith('#')) {
        assert.equal(homeAnchors.has(cta.destination), true, `unresolved CTA anchor: ${cta.destination}`);
      } else {
        assert.equal(routes.has(cta.destination), true, `unresolved CTA route: ${cta.destination}`);
      }
    }
  };
  assertBlueprintCtasResolve(beauty);
  assertBlueprintCtasResolve(homeContact);

  const explicitWhatsapp = websiteBlueprintForBrief({
    ...brief,
    contact: { whatsapp: '34600000000', phone: '600000000' },
    website: { ...brief.website, primaryGoal: 'contacto por WhatsApp' }
  });
  assert.equal(explicitWhatsapp.ctas[0].kind, 'whatsapp');
  assert.equal(explicitWhatsapp.ctas[0].source, 'businessBrief.contact.whatsapp');
  assert.equal(explicitWhatsapp.ctas[1].kind, 'route');
  assert.equal(explicitWhatsapp.ctas[1].destination, '/contacto');
  assertBlueprintCtasResolve(explicitWhatsapp);
  const formGoal = websiteBlueprintForBrief({
    ...brief,
    contact: { whatsapp: '34600000000', phone: '600000000' },
    website: { ...brief.website, primaryGoal: 'enviar formulario' }
  });
  assert.equal(formGoal.ctas[0].kind, 'route');
  assert.equal(formGoal.ctas[0].destination, '/contacto');
  assertBlueprintCtasResolve(formGoal);
  assert.equal(beauty.assets.slots.some((slot) => slot.provenance === 'generic-decorative'), true);
  assert.deepEqual([...beauty.missingFactSources].sort(), [
    'businessBrief.contact.address',
    'businessBrief.contact.email',
    'businessBrief.contact.phone',
    'businessBrief.contact.whatsapp'
  ].sort());
  assert.equal(beauty.forbiddenClaims[0].value, 'No inventar precios.');
  assert.equal(beauty.forbiddenClaims[0].source, 'businessBrief.contentRestrictions[0]');

  const serialized = JSON.stringify(beauty).toLowerCase();
  for (const forbidden of ['4.9', '500 reseñas', 'años de experiencia', 'tel:', '€']) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const fingerprintA = createHash('sha256').update(JSON.stringify(beauty)).digest('hex');
  const fingerprintB = createHash('sha256').update(JSON.stringify(beautyAgain)).digest('hex');
  assert.equal(fingerprintA, fingerprintB);

  const factChanged = websiteBlueprintForBrief({ ...brief, facts: ['Solo con cita.', 'Aparcamiento concertado.'] });
  const restrictionChanged = websiteBlueprintForBrief({ ...brief, contentRestrictions: ['No inventar precios.', 'No inventar testimonios.'] });
  assert.notEqual(factChanged.sourceBriefFingerprint, beauty.sourceBriefFingerprint);
  assert.notEqual(restrictionChanged.sourceBriefFingerprint, beauty.sourceBriefFingerprint);
  assert.notEqual(
    createHash('sha256').update(JSON.stringify(factChanged)).digest('hex'),
    fingerprintA
  );
  assert.notEqual(
    createHash('sha256').update(JSON.stringify(restrictionChanged)).digest('hex'),
    fingerprintA
  );
  assert.throws(() => websiteBlueprintForBrief(null), /website_blueprint_business_brief_invalid/);
});

test('Codex routing prefers the logged-in session and uses paid API only as a bounded fallback', async () => {
  const codexKey = 'codex_cloud_worker_test_key_1234567890';
  const openAiKey = 'sk-cloud-worker-fallback-key-1234567890';
  assert.equal(codexApiKeyFromEnvironment({ CODEX_API_KEY: codexKey, OPENAI_API_KEY: openAiKey }), codexKey);
  assert.equal(codexApiKeyFromEnvironment({ OPENAI_API_KEY: openAiKey }), openAiKey);
  assert.equal(codexApiKeyFromEnvironment({}), null);
  assert.throws(() => codexApiKeyFromEnvironment({ CODEX_API_KEY: 'too short' }), /codex_api_key_invalid/);
  assert.throws(() => codexApiKeyFromEnvironment({ OPENAI_API_KEY: 'sk-valid-length-but has-space-1234' }), /codex_api_key_invalid/);

  const isolatedHome = async (_sourceEnvironment, authAvailable = true) => ({
    path: '/isolated/codex-home',
    authAvailable,
    cleanup: async () => {}
  });

  const sessionOnlyOptions = [];
  class SessionCodex {
    constructor(options) { sessionOnlyOptions.push(options); }
    startThread() {
      return { id: 'thread-session', run: async () => ({ finalResponse: 'done from session' }) };
    }
  }
  const sessionResult = await new CodexSdkWorker({
    CodexClient: SessionCodex,
    environment: () => ({ PATH: '/safe/bin', CODEX_API_KEY: codexKey }),
    codexHomeFactory: (env) => isolatedHome(env, true),
    platform: 'linux'
  }).execute({ objective: 'session fixture' }, { workspace: process.cwd(), timeoutMs: 500 });
  assert.equal(sessionResult.status, 'completed');
  assert.equal(sessionResult.authMode, 'session');
  assert.equal(sessionResult.paidApiUsed, false);
  assert.equal(sessionOnlyOptions.length, 1);
  assert.equal(Object.hasOwn(sessionOnlyOptions[0], 'apiKey'), false);
  assert.equal(sessionOnlyOptions[0].env.CODEX_API_KEY, undefined);
  assert.equal(sessionOnlyOptions[0].env.OPENAI_API_KEY, undefined);

  const fallbackOptions = [];
  class QuotaThenApiCodex {
    constructor(options) { this.options = options; fallbackOptions.push(options); }
    startThread() {
      const paid = Object.hasOwn(this.options, 'apiKey');
      return {
        id: paid ? 'thread-api' : 'thread-session',
        run: async () => {
          if (!paid) throw new Error('You have hit your usage limit for Codex. Try again later.');
          return { finalResponse: 'done from paid fallback', usage: { input_tokens: 1, output_tokens: 1 } };
        }
      };
    }
  }
  const fallbackResult = await new CodexSdkWorker({
    CodexClient: QuotaThenApiCodex,
    environment: () => ({ PATH: '/safe/bin', CODEX_API_KEY: codexKey, OPENAI_API_KEY: openAiKey }),
    codexHomeFactory: (env) => isolatedHome(env, true),
    platform: 'linux'
  }).execute({ objective: 'fallback fixture' }, { workspace: process.cwd(), timeoutMs: 500 });
  assert.equal(fallbackResult.status, 'completed');
  assert.equal(fallbackResult.authMode, 'api');
  assert.equal(fallbackResult.paidApiUsed, true);
  assert.equal(fallbackOptions.length, 2);
  assert.equal(Object.hasOwn(fallbackOptions[0], 'apiKey'), false);
  assert.equal(fallbackOptions[1].apiKey, codexKey);
  assert.equal(fallbackOptions[1].env.CODEX_API_KEY, undefined);
  assert.equal(fallbackOptions[1].env.OPENAI_API_KEY, undefined);

  const noSessionOptions = [];
  class ApiOnlyCodex {
    constructor(options) { this.options = options; noSessionOptions.push(options); }
    startThread() { return { id: 'thread-api-only', run: async () => ({ finalResponse: 'api only' }) }; }
  }
  const noSessionResult = await new CodexSdkWorker({
    CodexClient: ApiOnlyCodex,
    environment: () => ({ PATH: '/safe/bin', OPENAI_API_KEY: openAiKey }),
    codexHomeFactory: (env) => isolatedHome(env, false),
    platform: 'linux'
  }).execute({ objective: 'no session fixture' }, { workspace: process.cwd(), timeoutMs: 500 });
  assert.equal(noSessionResult.status, 'completed');
  assert.equal(noSessionResult.authMode, 'api');
  assert.equal(noSessionResult.paidApiUsed, true);
  assert.equal(noSessionOptions.length, 1);
  assert.equal(noSessionOptions[0].apiKey, openAiKey);

  const transientOptions = [];
  class TransientCodex {
    constructor(options) { transientOptions.push(options); }
    startThread() {
      return { id: 'thread-transient', run: async () => { throw new Error('stream disconnected before completion'); } };
    }
  }
  const transientResult = await new CodexSdkWorker({
    CodexClient: TransientCodex,
    environment: () => ({ PATH: '/safe/bin', CODEX_API_KEY: codexKey }),
    codexHomeFactory: (env) => isolatedHome(env, true),
    platform: 'linux'
  }).execute({ objective: 'transient fixture' }, { workspace: process.cwd(), timeoutMs: 500 });
  assert.equal(transientResult.status, 'failed');
  assert.equal(transientOptions.length, 1);
  assert.equal(Object.hasOwn(transientOptions[0], 'apiKey'), false);
  assert.match(transientResult.output, /stream disconnected/);
});

test('both writing and read-only Codex surfaces share the session-first cost router', () => {
  const source = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  assert.equal((source.match(/await runCostAwareCodexTurn\(\{/g) ?? []).length, 2);
  assert.match(source, /refreshAuthFromSource/);
  assert.match(source, /if \(signal\?\.aborted \|\| !apiKey \|\| !codexPaidFallbackEligible\(sessionError\?\.message\)\) throw sessionError;/);
  assert.match(source, /paidApiUsed: authentication === 'api'/);
  assert.match(source, /authMode: execution\.authMode \?\? \(execution\.executionMode === 'deterministic' \? 'deterministic' : null\)/);
  assert.match(source, /workerEvidence:[\s\S]*authMode: worker\.authMode \?\? null,[\s\S]*paidApiUsed: Boolean\(worker\.paidApiUsed\)/);
  assert.match(source, /authMode: error\?\.codexAuthMode \?\? null,[\s\S]*paidApiUsed: Boolean\(error\?\.paidApiUsed\)/);
});

test('GitHub adapter derives a process-local commit identity from the authenticated user', async () => {
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async (url) => {
      assert.match(url, /\/user$/);
      return { ok: true, json: async () => ({ id: 277463323, login: 'palgarra14-del' }) };
    }
  });
  assert.deepEqual(await adapter.authenticatedCommitIdentity(), {
    id: 277463323,
    login: 'palgarra14-del',
    name: 'palgarra14-del',
    email: '277463323+palgarra14-del@users.noreply.github.com'
  });

  for (const bad of [
    { id: 0, login: 'owner' },
    { id: 1, login: '' },
    { id: 1, login: 'bad login' }
  ]) {
    const invalid = new GitHubAdapter({
      token: 'ghp_adapterToken',
      fetchImpl: async () => ({ ok: true, json: async () => bad })
    });
    await assert.rejects(invalid.authenticatedCommitIdentity(), /github_authenticated_commit_identity_invalid/);
  }
});

test('GitHub adapter bounds individual API requests so publication timeouts cannot hang on one fetch', async () => {
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      const signal = options.signal;
      assert.ok(signal, 'request must provide an abort signal');
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });

  await assert.rejects(adapter.authenticatedCommitIdentity(), /github_api_request_timeout/);
  assert.throws(
    () => new GitHubAdapter({ token: 'ghp_adapterToken', requestTimeoutMs: 0 }),
    /github_request_timeout_invalid/
  );
  assert.throws(
    () => new GitHubAdapter({ token: 'ghp_adapterToken', requestTimeoutMs: 120_001 }),
    /github_request_timeout_invalid/
  );

  const controller = new globalThis.AbortController();
  const callerAbort = new GitHubAdapter({
    token: 'ghp_adapterToken',
    requestTimeoutMs: 30_000,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('caller_abort_fixture')), { once: true });
      controller.abort();
    })
  });
  await assert.rejects(
    callerAbort.request('/user', { signal: controller.signal }),
    /caller_abort_fixture|aborted/i
  );
});

test('GitHub adapter dispatches an allowlisted CI workflow and accepts 204 responses', async () => {
  const calls = [];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 204, json: async () => { throw new Error('204 must not parse JSON'); } };
    }
  });
  const configured = project();
  const result = await adapter.dispatchWorkflow(configured, { workflow: 'ci.yml', ref: 'agent/workflow-123' });
  assert.deepEqual(result, { workflow: 'ci.yml', ref: 'agent/workflow-123', dispatched: true });
  assert.match(calls[0].url, /\/actions\/workflows\/ci\.yml\/dispatches$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'agent/workflow-123' });
  await assert.rejects(adapter.dispatchWorkflow(configured, { workflow: '../ci.yml', ref: 'agent/workflow-123' }), /workflow_dispatch_name_invalid/);
  await assert.rejects(adapter.dispatchWorkflow(configured, { workflow: 'ci.yml', ref: 'main' }), /workflow_dispatch_ref_invalid/);
});

test('publication bridge dispatches CI only when cloud workflow is explicitly configured', async () => {
  const calls = [];
  const github = {
    dispatchWorkflow: async (_project, payload) => {
      calls.push(payload);
      return { ...payload, dispatched: true };
    }
  };
  const configured = project();
  const cloud = new WorkflowPublicationBridge({ github, localGit: {}, deploymentProvider: {}, ciWorkflow: 'ci.yml' });
  assert.deepEqual(await cloud.dispatchCi(configured, { branch: 'agent/workflow-123' }), {
    required: true,
    workflow: 'ci.yml',
    ref: 'agent/workflow-123',
    dispatched: true
  });
  assert.deepEqual(calls, [{ workflow: 'ci.yml', ref: 'agent/workflow-123' }]);

  const local = new WorkflowPublicationBridge({ github, localGit: {}, deploymentProvider: {}, ciWorkflow: null });
  assert.deepEqual(await local.dispatchCi(configured, { branch: 'agent/workflow-123' }), { required: false, dispatched: false });
  assert.throws(() => new WorkflowPublicationBridge({ github, localGit: {}, deploymentProvider: {}, ciWorkflow: '../ci.yml' }), /ci_workflow_invalid/);
});

test('GitHub adapter keeps Vercel preview statuses out of CI while retaining them as deployment evidence', async () => {
  const responses = [
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    [
      {
        context: 'Vercel – app-llamadas',
        state: 'failure',
        description: 'Deployment blocked',
        target_url: 'https://vercel.com/team/project/deployment'
      },
      {
        context: 'external-ci',
        state: 'success',
        description: 'ok',
        target_url: 'https://example.test/ci'
      }
    ]
  ];
  const adapter = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  const configured = project({
    deployment: { provider: 'vercel', projectId: 'prj_test', teamId: 'team_test', requirePreviewReady: true }
  });
  const result = await adapter.checks(configured, 'sha');
  assert.equal(result.state, 'success');
  assert.deepEqual(result.statuses.map((status) => status.context), ['external-ci']);
  assert.deepEqual(result.deploymentStatuses.map((status) => status.context), ['Vercel – app-llamadas']);

  const spoofedResponses = [
    { total_count: 1, check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] },
    [{ context: 'Vercel – spoofed', state: 'failure', target_url: 'https://attacker.example/deploy' }]
  ];
  const spoofed = new GitHubAdapter({
    token: 'ghp_adapterToken',
    fetchImpl: async () => ({ ok: true, json: async () => spoofedResponses.shift() })
  });
  const spoofedResult = await spoofed.checks(configured, 'sha');
  assert.equal(spoofedResult.state, 'failure');
  assert.equal(spoofedResult.statuses[0].context, 'Vercel – spoofed');
  assert.deepEqual(spoofedResult.deploymentStatuses, []);
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

test('GitHub network Git credentials use least authority: self fallback by default and cross-repo token only when requested', () => {
  const agentToken = 'ghs_agent_cross_repo_fixture_123456789012345';
  const fallbackToken = 'ghs_cloud_default_repo_fixture_123456789012345';

  const selfEnv = githubGitNetworkEnvironment({ AGENT_GITHUB_TOKEN: agentToken, GITHUB_TOKEN: fallbackToken });
  assert.equal(selfEnv.GH_TOKEN, fallbackToken);
  assert.equal(JSON.stringify(selfEnv).includes(agentToken), false);

  const env = githubGitNetworkEnvironment(
    { AGENT_GITHUB_TOKEN: agentToken, GITHUB_TOKEN: fallbackToken },
    { preferAgentToken: true }
  );
  assert.equal(env.GH_TOKEN, agentToken);
  assert.equal(env.GH_HOST, 'github.com');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '!gh auth git-credential');
  assert.equal(Object.hasOwn(env, 'AGENT_GITHUB_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false);
  assert.equal(JSON.stringify(env).includes('https://x-access-token:'), false);
  assert.equal(JSON.stringify(env).includes(fallbackToken), false);

  const fallback = githubGitNetworkEnvironment({ GITHUB_TOKEN: fallbackToken }, { preferAgentToken: true });
  assert.equal(fallback.GH_TOKEN, fallbackToken);
  assert.deepEqual(githubGitNetworkEnvironment({}), {});
  assert.throws(
    () => githubGitNetworkEnvironment(
      { AGENT_GITHUB_TOKEN: 'too short', GITHUB_TOKEN: fallbackToken },
      { preferAgentToken: true }
    ),
    /github_orchestrator_token_invalid/
  );
  assert.equal(
    githubGitNetworkEnvironment({ AGENT_GITHUB_TOKEN: 'too short', GITHUB_TOKEN: fallbackToken }).GH_TOKEN,
    fallbackToken
  );
  assert.throws(() => githubGitNetworkEnvironment({ GITHUB_TOKEN: 'ghs_valid_length_but has_space_123456' }), /github_orchestrator_token_invalid/);
  assert.equal(maskSecrets(`AGENT_GITHUB_TOKEN=${agentToken}`).includes(agentToken), false);
});

test('target-repository GitHub API token keeps self least-authority and prefers cross-repo credential only for non-self projects', () => {
  const agentToken = 'ghs_api_cross_repo_fixture_123456789012345';
  const fallbackToken = 'ghs_api_self_fixture_123456789012345';
  const environment = { AGENT_GITHUB_TOKEN: agentToken, GITHUB_TOKEN: fallbackToken };
  assert.equal(githubApiTokenForProject(project({ id: 'self' }), environment), fallbackToken);
  assert.equal(githubApiTokenForProject(project({ id: 'website-pilot' }), environment), agentToken);
  assert.equal(githubApiTokenForProject(project({ id: 'website-pilot' }), { GITHUB_TOKEN: fallbackToken }), fallbackToken);
  assert.throws(
    () => githubApiTokenForProject(project({ id: 'website-pilot' }), { AGENT_GITHUB_TOKEN: 'too short', GITHUB_TOKEN: fallbackToken }),
    /github_orchestrator_token_invalid/
  );
  assert.equal(
    githubApiTokenForProject(project({ id: 'self' }), { AGENT_GITHUB_TOKEN: 'too short', GITHUB_TOKEN: fallbackToken }),
    fallbackToken
  );
});

test('workflow publication routes target GitHub API and preview fallback through the cross-repo credential without changing self authority', async () => {
  const agentToken = 'ghs_bridge_cross_repo_fixture_123456789012345';
  const fallbackToken = 'ghs_bridge_self_fixture_123456789012345';
  const environment = { AGENT_GITHUB_TOKEN: agentToken, GITHUB_TOKEN: fallbackToken };
  const calls = [];
  const githubFactory = (token) => ({
    inspect: async (configured) => { calls.push({ op: 'inspect', projectId: configured.id, token }); return { provider: 'github', head: 'base' }; },
    authenticatedCommitIdentity: async () => { calls.push({ op: 'identity', token }); return { name: 'fixture', email: '1+fixture@users.noreply.github.com' }; },
    branchHead: async (configured, branch) => { calls.push({ op: 'branch', projectId: configured.id, token }); return { branch, head: 'commit' }; },
    createPullRequest: async (configured) => { calls.push({ op: 'pr', projectId: configured.id, token }); return { number: 1, state: 'open' }; },
    pullRequest: async (configured) => { calls.push({ op: 'pr-read', projectId: configured.id, token }); return { number: 1, state: 'open', headSha: 'commit', headRef: 'agent/run', baseRef: configured.defaultBranch }; },
    dispatchWorkflow: async (configured) => { calls.push({ op: 'dispatch', projectId: configured.id, token }); return { workflow: 'ci.yml', ref: 'agent/run', dispatched: true }; },
    waitForCi: async (configured) => { calls.push({ op: 'ci', projectId: configured.id, token }); return { state: 'success' }; },
    previewDeployment: async (configured) => { calls.push({ op: 'preview', projectId: configured.id, token }); return { provider: 'vercel', state: 'READY', ok: true }; }
  });
  const localGit = {
    commit: async () => ({ finalHead: 'commit' }),
    push: async () => ({ finalHead: 'commit' })
  };
  const bridge = new WorkflowPublicationBridge({
    localGit,
    environment,
    githubFactory,
    deploymentProviderFactory: ({ github }) => new VercelDeploymentProvider({ token: '', github }),
    ciWorkflow: 'ci.yml'
  });
  const crossRepo = project({ id: 'website-pilot', deployment: { provider: 'vercel', projectId: 'prj_test', teamId: 'team_test' } });
  const selfProject = project({ id: 'self', deployment: { provider: 'vercel', projectId: 'prj_self', teamId: 'team_test' } });

  assert.equal((await bridge.inspectBase(crossRepo)).head, 'base');
  await bridge.commit(crossRepo, { branch: 'agent/run', goal: 'fixture', baseHead: 'base', remote: 'https://github.com/owner/repo.git', changeSetFingerprint: 'a'.repeat(64) });
  await bridge.verifyRemoteBranch(crossRepo, 'agent/run', 'commit');
  await bridge.createPullRequest(crossRepo, { branch: 'agent/run', workflowId: 'workflow-1', changeSetFingerprint: 'a'.repeat(64), goal: 'fixture' });
  await bridge.dispatchCi(crossRepo, { branch: 'agent/run' });
  await bridge.waitForCi(crossRepo, 'commit', {});
  await bridge.waitForPreview(crossRepo, { commitSha: 'commit', branch: 'agent/run' }, { timeoutMs: 1, pollIntervalMs: 1 });
  await bridge.inspectBase(selfProject);

  const crossRepoCalls = calls.filter((call) => call.projectId === 'website-pilot' || ['identity', 'preview'].includes(call.op));
  assert.ok(crossRepoCalls.length >= 7);
  assert.ok(crossRepoCalls.every((call) => call.token === agentToken));
  const selfCalls = calls.filter((call) => call.projectId === 'self');
  assert.equal(selfCalls.length, 1);
  assert.equal(selfCalls[0].token, fallbackToken);
  assert.equal(JSON.stringify(calls).includes('AGENT_GITHUB_TOKEN'), false);
  assert.equal(JSON.stringify(calls).includes('GITHUB_TOKEN'), false);
});

test('managed private clone gets GitHub credential helper only through subprocess environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-private-clone-'));
  const configured = configFrom({
    id: 'website-pilot', repository: { owner: 'owner', name: 'private-repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    workspaceStrategy: 'managed', managedWorkspaceRoot: '.agent-workspaces', commands: { test: 'node --version' }, acceptance: { require: ['test'] }
  }, join(root, 'host', 'config'));
  const token = 'ghs_private_clone_fixture_123456789012345';
  const fallbackToken = 'ghs_private_clone_fallback_123456789012345';
  let observed = null;
  const manager = new WorkspaceManager({
    environment: { AGENT_GITHUB_TOKEN: token, GITHUB_TOKEN: fallbackToken },
    processRunner: async (binary, args, options) => {
      observed = { binary, args, options };
      return { ok: true, exitCode: 0, durationMs: 1, stdout: '', stderr: '' };
    }
  });
  await manager.prepare(configured, 'agent-20260914-cloudauth');
  assert.equal(observed.binary, 'git');
  assert.equal(observed.args[0], 'clone');
  assert.equal(observed.args.some((arg) => String(arg).includes(token)), false);
  assert.equal(observed.options.env.GH_TOKEN, token);
  assert.equal(observed.options.env.GIT_CONFIG_VALUE_0, '!gh auth git-credential');
  assert.equal(Object.hasOwn(observed.options.env, 'AGENT_GITHUB_TOKEN'), false);
  assert.equal(Object.hasOwn(observed.options.env, 'GITHUB_TOKEN'), false);
  assert.equal(JSON.stringify(observed).includes(fallbackToken), false);
});

test('LocalGitAdapter injects GitHub credentials only when a Git operation is explicitly networked', async () => {
  const token = 'ghs_private_git_fixture_1234567890123456';
  const fallbackToken = 'ghs_private_git_fallback_1234567890123456';
  const calls = [];
  const configured = project({ id: 'website-pilot' });
  const adapter = new LocalGitAdapter({
    environment: { AGENT_GITHUB_TOKEN: token, GITHUB_TOKEN: fallbackToken },
    processRunner: async (_binary, args, options) => {
      calls.push({ args, options });
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' };
    }
  });
  await adapter.git(['status', '--porcelain'], configured);
  await adapter.git(['fetch', 'origin', 'main'], configured, { network: true });
  assert.deepEqual(calls[0].options.env, {});
  assert.equal(calls[1].options.env.GH_TOKEN, token);
  assert.equal(calls[1].options.env.GIT_CONFIG_VALUE_0, '!gh auth git-credential');
  assert.equal(Object.hasOwn(calls[1].options.env, 'AGENT_GITHUB_TOKEN'), false);
  assert.equal(Object.hasOwn(calls[1].options.env, 'GITHUB_TOKEN'), false);
  assert.equal(calls[1].args.some((arg) => String(arg).includes(token)), false);
  assert.equal(JSON.stringify(calls).includes(fallbackToken), false);
});

test('self network Git ignores the broader cross-repo credential even when it is present', async () => {
  const agentToken = 'ghs_agent_self_must_ignore_123456789012345';
  const fallbackToken = 'ghs_self_workflow_token_123456789012345';
  const calls = [];
  const configured = project({ id: 'self' });
  const adapter = new LocalGitAdapter({
    environment: { AGENT_GITHUB_TOKEN: agentToken, GITHUB_TOKEN: fallbackToken },
    processRunner: async (_binary, args, options) => {
      calls.push({ args, options });
      return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' };
    }
  });
  await adapter.git(['fetch', 'origin', 'main'], configured, { network: true });
  assert.equal(calls[0].options.env.GH_TOKEN, fallbackToken);
  assert.equal(JSON.stringify(calls).includes(agentToken), false);
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

test('Vercel adapter bounds each direct API request and rejects invalid timeout configuration', async () => {
  assert.throws(
    () => new VercelDeploymentProvider({ token: 'vercel_test', requestTimeoutMs: 0 }),
    /vercel_request_timeout_invalid/
  );
  assert.throws(
    () => new VercelDeploymentProvider({ token: 'vercel_test', requestTimeoutMs: 120_001 }),
    /vercel_request_timeout_invalid/
  );

  let observedSignal = null;
  const adapter = new VercelDeploymentProvider({
    token: 'vercel_test',
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      assert.ok(observedSignal, 'direct Vercel request must be abortable');
      if (observedSignal.aborted) {
        reject(observedSignal.reason);
        return;
      }
      observedSignal.addEventListener('abort', () => reject(observedSignal.reason), { once: true });
    })
  });
  await assert.rejects(
    adapter.latest(leadfinderProject(), { commitSha: 'sha', branch: 'agent/run' }),
    /vercel_api_request_timeout/
  );
  assert.equal(observedSignal.aborted, true);
});

test('GitHub deployment observer accepts only exact Preview evidence and trusted Vercel URLs', async () => {
  const sha = 'a'.repeat(40);
  const branch = 'agent/run';
  const requests = [];
  let environmentUrl = 'https://callflow-preview-abc.vercel.app';
  let statusActor = 'vercel[bot]';
  const adapter = new GitHubAdapter({
    token: 'github-test-token',
    fetchImpl: async (url) => {
      requests.push(url);
      const body = url.includes('/statuses?')
        ? [
            { id: 1, state: 'pending', environment: 'Preview', creator: { login: 'vercel[bot]' }, created_at: '2026-09-13T00:00:00Z' },
            { id: 2, state: 'success', environment: 'Preview', creator: { login: statusActor }, environment_url: environmentUrl, created_at: '2026-09-13T00:01:00Z' }
          ]
        : [
            { id: 10, sha, ref: branch, environment: 'Production', production_environment: true, created_at: '2026-09-13T00:02:00Z' },
            { id: 11, sha, ref: 'agent/other', environment: 'Preview', production_environment: false, created_at: '2026-09-13T00:02:00Z' },
            { id: 12, sha, ref: branch, environment: 'Preview', production_environment: false, created_at: '2026-09-13T00:03:00Z' }
          ];
      return { ok: true, json: async () => body };
    }
  });
  const ready = await adapter.previewDeployment(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.deploymentId, '12');
  assert.equal(ready.url, environmentUrl + '/');
  assert.equal(ready.source, 'github-deployments');
  assert.ok(requests[0].includes(`sha=${sha}`));
  assert.ok(requests[0].includes('ref=agent%2Frun'));

  environmentUrl = 'https://attacker.example/preview';
  const invalid = await adapter.previewDeployment(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(invalid.state, 'INVALID');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.url, undefined);

  environmentUrl = 'https://valid-again.vercel.app';
  statusActor = 'other-bot[bot]';
  const wrongActor = await adapter.previewDeployment(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(wrongActor.state, 'INVALID');
  assert.match(wrongActor.reason, /not an exact Vercel Preview status/);
});

test('GitHub preview observer falls back to trusted Vercel commit statuses only for non-default branches', async () => {
  const sha = 'd'.repeat(40);
  const branch = 'agent/run';
  const configured = leadfinderProject();
  const makeAdapter = (statuses) => new GitHubAdapter({
    token: 'github-test-token',
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.includes('/deployments?') ? [] : statuses
    })
  });

  const ready = await makeAdapter([
    { context: 'Vercel – primary', state: 'failure', target_url: 'https://vercel.com/team/project/older', updated_at: '2026-09-13T00:00:00Z' },
    { context: 'Vercel – primary', state: 'success', target_url: 'https://vercel.com/team/project/newer', updated_at: '2026-09-13T00:02:00Z' },
    { context: 'Vercel – secondary', state: 'success', target_url: 'https://vercel.com/team/project/secondary', updated_at: '2026-09-13T00:01:00Z' }
  ]).previewDeployment(configured, { commitSha: sha, branch });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.ok, true);
  assert.equal(ready.source, 'github-commit-statuses');
  assert.equal(ready.environment, 'preview');
  assert.equal(ready.commitSha, sha);
  assert.equal(ready.branch, branch);
  assert.equal(ready.url, undefined);
  assert.equal(ready.statuses.length, 2);

  const failed = await makeAdapter([
    { context: 'Vercel – primary', state: 'success', target_url: 'https://vercel.com/team/project/ok' },
    { context: 'Vercel – secondary', state: 'failure', target_url: 'https://vercel.com/team/project/fail' }
  ]).previewDeployment(configured, { commitSha: sha, branch });
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.ok, false);

  const building = await makeAdapter([
    { context: 'Vercel – primary', state: 'success', target_url: 'https://vercel.com/team/project/ok' },
    { context: 'Vercel – secondary', state: 'pending', target_url: 'https://vercel.com/team/project/pending' }
  ]).previewDeployment(configured, { commitSha: sha, branch });
  assert.equal(building.state, 'BUILDING');
  assert.equal(building.ok, false);

  const spoofed = await makeAdapter([
    { context: 'Vercel – spoofed', state: 'success', target_url: 'https://attacker.example/deployment' }
  ]).previewDeployment(configured, { commitSha: sha, branch });
  assert.equal(spoofed.state, 'NOT_FOUND');
  assert.equal(spoofed.ok, false);

  let statusRequests = 0;
  const defaultBranch = new GitHubAdapter({
    token: 'github-test-token',
    fetchImpl: async (url) => {
      if (url.includes('/statuses?')) statusRequests += 1;
      return { ok: true, json: async () => [] };
    }
  });
  const productionLike = await defaultBranch.previewDeployment(configured, { commitSha: sha, branch: configured.defaultBranch });
  assert.equal(productionLike.state, 'NOT_FOUND');
  assert.equal(statusRequests, 0);
});

test('GitHub deployment observer uses the latest status and Vercel adapter falls back without a Vercel token', async () => {
  const sha = 'b'.repeat(40);
  const branch = 'agent/run';
  const github = new GitHubAdapter({
    token: 'github-test-token',
    fetchImpl: async (url) => ({ ok: true, json: async () => url.includes('/statuses?')
      ? [
          { id: 20, state: 'success', environment: 'Preview', creator: { login: 'vercel[bot]' }, environment_url: 'https://older.vercel.app', created_at: '2026-09-13T00:00:00Z' },
          { id: 21, state: 'failure', environment: 'Preview', creator: { login: 'vercel[bot]' }, environment_url: 'https://failed.vercel.app', created_at: '2026-09-13T00:02:00Z' }
        ]
      : [{ id: 19, sha, ref: branch, environment: 'Preview', production_environment: false, created_at: '2026-09-13T00:01:00Z' }] })
  });
  const failed = await github.previewDeployment(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.ok, false);

  let fallbackCalls = 0;
  const fallback = new VercelDeploymentProvider({
    token: '',
    github: { previewDeployment: async (_project, context) => {
      fallbackCalls += 1;
      assert.deepEqual(context, { commitSha: sha, branch });
      return { provider: 'vercel', source: 'github-deployments', state: 'READY', ok: true, url: 'https://fallback.vercel.app/' };
    } },
    fetchImpl: async () => { throw new Error('Vercel API must not be called without a token'); }
  });
  const observed = await fallback.latest(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(observed.state, 'READY');
  assert.equal(observed.source, 'github-deployments');
  assert.equal(fallbackCalls, 1);

  const unavailable = await new VercelDeploymentProvider({
    token: '',
    github: { previewDeployment: async () => { throw new Error('GitHub API request failed: 403'); } }
  }).latest(leadfinderProject(), { commitSha: sha, branch });
  assert.equal(unavailable.state, 'NOT_CONFIGURED');
  assert.match(unavailable.reason, /GitHub deployment observation unavailable/);
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


test('Codex worker permission profile remains fail-closed on unknown platforms', async () => {
  let constructed = 0;
  class FakeCodex { constructor() { constructed += 1; } }
  const worker = new CodexSdkWorker({ CodexClient: FakeCodex, platform: 'freebsd', environment: () => ({ PATH: '/safe' }) });
  const result = await worker.execute({ objective: 'fixture' }, { workspace: '/workspace', timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'codex_worker_read_isolation_unverified_on_freebsd');
  assert.equal(constructed, 0);
});

test('Codex worker security config denies root reads, exposes only the exact native runtime, and blocks native Windows', () => {
  const writeRuntime = '/opt/agent-native/codex-linux-x64';
  const readRuntime = '/opt/agent-native/codex-darwin-x64';
  const write = codexWorkerSecurityConfig({ writeAccess: true, pathValue: '/bin:/usr/bin', platform: 'linux', nativeRuntimePath: writeRuntime });
  const read = codexWorkerSecurityConfig({ writeAccess: false, pathValue: '/bin:/usr/bin', platform: 'darwin', nativeRuntimePath: readRuntime });
  const windowsRead = codexWorkerSecurityConfig({ writeAccess: false, pathValue: 'C:\\safe', platform: 'win32' });
  const windowsWrite = codexWorkerSecurityConfig({ writeAccess: true, pathValue: 'C:\\safe', platform: 'win32' });
  assert.equal(write.supported, true);
  assert.equal(read.supported, true);
  assert.equal(windowsRead.supported, false);
  assert.equal(windowsWrite.supported, false);
  assert.equal(windowsRead.error, 'codex_worker_native_windows_isolation_unverified_use_wsl');
  assert.equal(windowsWrite.error, 'codex_worker_native_windows_isolation_unverified_use_wsl');
  const writeProfile = write.configOverrides.find((entry) => entry.startsWith('permissions.agent-workflow.filesystem='));
  const readProfile = read.configOverrides.find((entry) => entry.startsWith('permissions.agent-workflow.filesystem='));
  assert.match(writeProfile, /":root"="deny"/);
  assert.match(writeProfile, /":minimal"="read"/);
  assert.match(writeProfile, /":workspace_roots"=\{"\."="write","\.git"="read"\}/);
  assert.match(readProfile, /":workspace_roots"=\{"\."="read","\.git"="read"\}/);
  assert.ok(writeProfile.includes(`${JSON.stringify(writeRuntime)}="read"`));
  assert.ok(readProfile.includes(`${JSON.stringify(readRuntime)}="read"`));
  assert.equal(writeProfile.includes('"/opt/agent-native"="read"'), false);
  assert.equal(writeProfile.includes('"/opt"="read"'), false);
  assert.ok(write.configOverrides.includes('shell_environment_policy.set.PATH="/bin:/usr/bin"'));
  assert.equal(windowsRead.configOverrides.length, 0);
  assert.equal(windowsWrite.configOverrides.length, 0);

  const unavailable = codexWorkerSecurityConfig({
    platform: 'linux',
    arch: 'x64',
    nativeRuntimeResolver: () => { throw new Error('fixture secret must not escape'); }
  });
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.error, 'codex_worker_native_runtime_unavailable_on_linux_x64');
  assert.equal(JSON.stringify(unavailable).includes('fixture secret'), false);

  const invalidRoot = codexWorkerSecurityConfig({ platform: 'linux', nativeRuntimePath: '/' });
  assert.equal(invalidRoot.supported, false);
  assert.equal(invalidRoot.error, 'codex_worker_native_runtime_path_invalid');
  assert.equal(codexWorkerSecurityConfig({ platform: 'freebsd' }).supported, false);
});

test('Codex turn diagnostics retain only bounded failed tool evidence', () => {
  const diagnostics = codexTurnFailureDiagnostics([
    { type: 'reasoning', text: 'must never be retained' },
    { type: 'agent_message', text: 'must never be retained either' },
    { type: 'error', message: 'tool failed with sk-superSecretValue' },
    { type: 'mcp_tool_call', server: 'fixture', tool: 'write', status: 'failed', error: { message: 'Bearer sensitive-value' } },
    { type: 'command_execution', command: 'node fixture.js', aggregated_output: 'ordinary source line\nfailure: fixture exploded', exit_code: 1, status: 'failed' },
    { type: 'command_execution', command: 'node successful.js', aggregated_output: 'failure word in successful output', exit_code: 0, status: 'completed' }
  ]);
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].type, 'error');
  assert.equal(diagnostics[0].message.includes('sk-superSecretValue'), false);
  assert.equal(diagnostics[1].type, 'mcp_tool_call');
  assert.equal(diagnostics[2].type, 'command_execution');
  assert.equal(diagnostics[2].executable, 'node');
  assert.equal(diagnostics[2].errorOutput.includes('ordinary source line'), false);
  assert.match(diagnostics[2].errorOutput, /failure: fixture exploded/);
  assert.equal(JSON.stringify(diagnostics).includes('reasoning'), false);
  assert.equal(JSON.stringify(diagnostics).includes('must never'), false);
  assert.equal(JSON.stringify(diagnostics).includes('successful.js'), false);
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
