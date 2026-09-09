import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { Codex } from '@openai/codex-sdk';

export const RunStatus = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  WORKING: 'working',
  WORKER_FAILED_RETRYABLE: 'worker_failed_retryable',
  TESTING: 'testing',
  PUSHING: 'pushing',
  WAITING_CI: 'waiting_ci',
  EVALUATING: 'evaluating',
  WAITING_APPROVAL: 'waiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const transitions = Object.freeze({
  created: ['planning', 'cancelled'],
  planning: ['working', 'waiting_approval', 'failed', 'cancelled'],
  working: ['testing', 'worker_failed_retryable', 'waiting_approval', 'failed', 'cancelled'],
  worker_failed_retryable: ['working', 'failed', 'cancelled'],
  testing: ['pushing', 'worker_failed_retryable', 'failed', 'cancelled'],
  pushing: ['waiting_ci', 'waiting_approval', 'failed', 'cancelled'],
  waiting_ci: ['evaluating', 'working', 'failed', 'cancelled'],
  evaluating: ['working', 'completed', 'failed', 'cancelled'],
  waiting_approval: ['pushing', 'completed', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: []
});

const dangerousActions = new Set([
  'merge', 'production_deploy', 'destructive_data_change', 'modify_secrets', 'send_communication'
]);
const forbiddenActions = new Set([
  'force_push_main', 'delete_repository', 'print_secret', 'disable_security', 'production_test',
  'approval_bypass', 'delete_protected_branch'
]);
const protectedFilePattern = /(^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key)$|secrets?(?:\.|$))/i;
const secretKeyPattern = /(api[_-]?key|token|secret|password|credential|authorization)/i;

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`..${sep}`));
}

function positiveInteger(value, fallback, label, minimum = 1) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return result;
}

function clip(value, size = 8_000) {
  return maskSecrets(String(value ?? '')).slice(0, size);
}

function safeJson(value) {
  return JSON.parse(maskSecrets(JSON.stringify(value)));
}

export function maskSecrets(value) {
  return String(value)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]');
}

export function transition(run, nextStatus) {
  if (!transitions[run.status]?.includes(nextStatus)) {
    throw new Error(`Invalid state transition: ${run.status} -> ${nextStatus}`);
  }
  run.status = nextStatus;
  run.updatedAt = new Date().toISOString();
}

export function policy(action, project = {}) {
  if (forbiddenActions.has(action) || project.policies?.forbidden?.includes(action)) return 'FORBIDDEN';
  if (dangerousActions.has(action) || project.policies?.requireApprovalFor?.includes(action)) {
    return 'APPROVAL_REQUIRED';
  }
  return 'SAFE';
}

export function buildWorkingBranch(project, runId) {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('Invalid run id for branch creation');
  const pattern = project.workingBranchPattern ?? 'agent/{runId}';
  if ((pattern.match(/\{runId\}/g) ?? []).length !== 1) throw new Error('workingBranchPattern must contain {runId} once');
  const branch = pattern.replace('{runId}', runId);
  if (!/^agent\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw new Error('Invalid working branch pattern');
  }
  return branch;
}

export function assertAllowedWorkingBranch(project, branch) {
  if (project.protectedBranches.includes(branch)) throw new Error(`Protected branch cannot be used as working branch: ${branch}`);
  const expectedPrefix = (project.workingBranchPattern ?? 'agent/{runId}').split('{runId}')[0];
  if (!branch.startsWith(expectedPrefix) || !/^agent\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error(`Working branch is outside the allowlist: ${branch}`);
  }
}

export function configFrom(input, baseDirectory = process.cwd()) {
  if (!input?.id || !/^[a-z0-9-]+$/.test(input.id)) throw new Error('Invalid project id');
  if (!input.repository?.owner || !input.repository?.name) throw new Error('repository owner/name required');
  if (!input.defaultBranch || !Array.isArray(input.protectedBranches) || !input.protectedBranches.includes(input.defaultBranch)) {
    throw new Error('default branch must be protected');
  }
  if (!input.commands || Object.values(input.commands).some((command) => typeof command !== 'string' || !command.trim())) {
    throw new Error('allowlisted commands required');
  }
  const configDirectory = resolve(baseDirectory);
  const projectRoot = resolve(configDirectory, '..');
  const workspace = resolve(configDirectory, input.workspace ?? '..');
  if (!isWithin(projectRoot, workspace)) throw new Error('workspace must stay within the configured project root');
  const budgets = input.budgets ?? {};
  const project = {
    ...input,
    workspace,
    projectRoot,
    workingBranchPattern: input.workingBranchPattern ?? 'agent/{runId}',
    budgets: {
      maxIterations: positiveInteger(budgets.maxIterations, 3, 'maxIterations'),
      maxTasks: positiveInteger(budgets.maxTasks, 10, 'maxTasks'),
      maxRuntimeMinutes: positiveInteger(budgets.maxRuntimeMinutes, 10, 'maxRuntimeMinutes'),
      maxModelCalls: positiveInteger(budgets.maxModelCalls, 0, 'maxModelCalls', 0),
      maxWorkerAttempts: positiveInteger(budgets.maxWorkerAttempts, 2, 'maxWorkerAttempts'),
      commandTimeoutMs: positiveInteger(budgets.commandTimeoutMs, 30_000, 'commandTimeoutMs', 100),
      ciTimeoutMs: positiveInteger(budgets.ciTimeoutMs, 600_000, 'ciTimeoutMs', 1_000),
      ciPollIntervalMs: positiveInteger(budgets.ciPollIntervalMs, 10_000, 'ciPollIntervalMs', 1_000)
    }
  };
  buildWorkingBranch(project, 'validation-run');
  return project;
}

export async function loadProjects(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return new Map(data.projects.map((project) => {
    const configured = configFrom(project, dirname(file));
    return [configured.id, configured];
  }));
}

export class JsonStore {
  constructor(file) { this.file = file; }

  async load() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { runs: {}, approvals: {}, events: [] };
      throw error;
    }
  }

  async save(data) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2));
    await rename(temporary, this.file);
  }

  async mutate(mutator) {
    const data = await this.load();
    const output = await mutator(data);
    await this.save(data);
    return output;
  }

  async getRun(id) { return (await this.load()).runs[id]; }
}

export async function runProcess(command, args, { cwd, env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveResult({ ...result, timedOut, stdout: clip(stdout), stderr: clip(stderr), durationMs: Date.now() - startedAt });
    };
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { clearTimeout(timer); stderr += error.message; finish({ ok: false, exitCode: null }); });
    child.on('close', (exitCode) => { clearTimeout(timer); finish({ ok: exitCode === 0 && !timedOut, exitCode }); });
  });
}

export async function runCommand(project, name, { timeoutMs = project.budgets.commandTimeoutMs, dryRun = false, processRunner = runProcess } = {}) {
  const command = project.commands[name];
  if (!command) throw new Error(`Command not allowlisted: ${name}`);
  if (/[;&|`$<>\n\r]/.test(command)) throw new Error('Unsafe configured command');
  if (dryRun) return { name, command, skipped: true, ok: true, durationMs: 0, stdout: 'dry-run', stderr: '' };
  const [binary, ...args] = command.split(/\s+/);
  const result = await processRunner(binary, args, { cwd: project.workspace, env: { CI: 'true' }, timeoutMs });
  return { name, command, ...result };
}

export function sanitizeCodingTask(task) {
  const cleanse = (value, key = '') => {
    if (secretKeyPattern.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return maskSecrets(value);
    if (Array.isArray(value)) return value.map((item) => cleanse(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, cleanse(childValue, childKey)]));
    return value;
  };
  return cleanse(task);
}

export function buildWorkerPrompt(task) {
  const cleanTask = sanitizeCodingTask(task);
  return [
    'You are the coding worker in a controlled engineering run.',
    'Implement only the requested objective inside the current workspace.',
    'Do not use git to commit, push, merge, rebase, reset, switch branches, or change remotes.',
    'Do not read, create, or modify .env files, credentials, tokens, secrets, deployment settings, or files outside the workspace.',
    'Do not disable policies or safety controls. Do not perform production actions.',
    'The orchestrator, not you, runs validation commands and controls GitHub actions.',
    'Make the smallest safe change that satisfies the acceptance criteria. Explain what changed when finished.',
    '', 'Structured coding task:', JSON.stringify(cleanTask, null, 2)
  ].join('\n');
}

export class MockCodingWorker {
  async execute() { return { status: 'completed', summary: 'Mock worker performed no filesystem writes', output: '' }; }
}

function workerEnvironment() {
  const allowed = ['APPDATA', 'CODEX_HOME', 'HOME', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'];
  return Object.fromEntries(allowed.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}

export class CodexSdkWorker {
  constructor({ CodexClient = Codex, environment = workerEnvironment } = {}) { Object.assign(this, { CodexClient, environment }); }

  async execute(task, { workspace, timeoutMs }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const client = new this.CodexClient({ env: this.environment() });
      const thread = client.startThread({
        workingDirectory: workspace,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled'
      });
      const turn = await thread.run(buildWorkerPrompt(task), { signal: controller.signal });
      return {
        status: 'completed',
        summary: 'Codex SDK completed the coding task',
        codexThreadId: thread.id,
        usage: safeJson(turn.usage),
        output: clip(turn.finalResponse)
      };
    } catch (error) {
      return { status: 'failed', summary: 'Codex SDK did not complete the coding task', timedOut, output: clip(error.message) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LocalGitAdapter {
  constructor({ processRunner = runProcess } = {}) { this.processRunner = processRunner; }

  async git(args, project, { allowExitCodes = [0] } = {}) {
    const result = await this.processRunner('git', args, { cwd: project.workspace, timeoutMs: project.budgets.commandTimeoutMs });
    if (!allowExitCodes.includes(result.exitCode) || result.timedOut) throw new Error(`Git ${args[0]} failed: ${clip(result.stderr || result.stdout)}`);
    return result;
  }

  async currentBranch(project) { return (await this.git(['branch', '--show-current'], project)).stdout.trim(); }
  async head(project) { return (await this.git(['rev-parse', 'HEAD'], project)).stdout.trim(); }

  async inspect(project) {
    const repository = (await this.git(['rev-parse', '--show-toplevel'], project)).stdout.trim();
    if (!isWithin(project.workspace, repository) || !isWithin(repository, project.workspace)) throw new Error('Workspace is not the repository root');
    const remote = (await this.git(['remote', 'get-url', 'origin'], project)).stdout.trim();
    const expected = `${project.repository.owner}/${project.repository.name}`.toLowerCase();
    if (!remote.toLowerCase().replace(/\.git$/, '').includes(expected)) throw new Error('Remote repository does not match project configuration');
    return { repository, remote, currentBranch: await this.currentBranch(project), initialHead: await this.head(project), status: (await this.git(['status', '--porcelain'], project)).stdout };
  }

  async prepareWorkingBranch(project, runId) {
    const inspection = await this.inspect(project);
    if (project.protectedBranches.includes(inspection.currentBranch) && inspection.currentBranch !== project.defaultBranch) {
      throw new Error(`Engineering runs cannot start from protected branch ${inspection.currentBranch}`);
    }
    if (inspection.status.trim()) throw new Error('Working tree must be clean before an engineering run');
    const workingBranch = buildWorkingBranch(project, runId);
    assertAllowedWorkingBranch(project, workingBranch);
    const exists = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${workingBranch}`], project, { allowExitCodes: [0, 1] });
    if (exists.exitCode === 0) throw new Error(`Working branch already exists: ${workingBranch}`);
    await this.git(['switch', '--create', workingBranch, project.defaultBranch], project);
    return { ...inspection, workingBranch, initialHead: await this.head(project) };
  }

  async assertWorkingBranch(project, branch) {
    assertAllowedWorkingBranch(project, branch);
    const current = await this.currentBranch(project);
    if (current !== branch) throw new Error(`Unexpected current branch: ${current}`);
  }

  async changedPaths(project) {
    const tracked = (await this.git(['diff', '--name-only'], project)).stdout.split(/\r?\n/).filter(Boolean);
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard'], project)).stdout.split(/\r?\n/).filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  }

  async assertSafeChangedPaths(project) {
    const paths = await this.changedPaths(project);
    const unsafe = paths.find((path) => protectedFilePattern.test(path) || path.includes('..'));
    if (unsafe) throw new Error(`Worker changed a protected path: ${unsafe}`);
    return paths;
  }

  async hasDiff(project) { return (await this.changedPaths(project)).length > 0; }

  async commit(project, branch, message) {
    await this.assertWorkingBranch(project, branch);
    await this.assertSafeChangedPaths(project);
    await this.git(['add', '--all'], project);
    const staged = await this.git(['diff', '--cached', '--quiet'], project, { allowExitCodes: [0, 1] });
    if (staged.exitCode === 0) throw new Error('No staged change to commit');
    const description = String(message).replace(/[\r\n]+/g, ' ').replace(/[^\w .,:;!?()/-]/g, '').slice(0, 68).trim() || 'safe engineering change';
    const safeMessage = `agent: ${description}`;
    await this.git(['commit', '--message', safeMessage], project);
    return { message: safeMessage, finalHead: await this.head(project) };
  }

  async push(project, branch) {
    await this.assertWorkingBranch(project, branch);
    assertAllowedWorkingBranch(project, branch);
    await this.git(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], project);
    return { branch, finalHead: await this.head(project) };
  }
}

function ciState(checkRuns) {
  if (!checkRuns.length || checkRuns.some((check) => check.status !== 'completed')) return 'pending';
  const failures = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
  return checkRuns.some((check) => failures.has(check.conclusion)) ? 'failure' : 'success';
}

export class GitHubAdapter {
  constructor({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)), now = () => Date.now() } = {}) {
    Object.assign(this, { token, fetch: fetchImpl, sleep, now });
  }

  headers() {
    if (!this.token) throw new Error('GITHUB_TOKEN is required for GitHub API actions');
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' };
  }

  async request(path, options = {}) {
    const response = await this.fetch(`https://api.github.com${path}`, { ...options, headers: { ...this.headers(), ...(options.headers ?? {}) } });
    if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`);
    return response.json();
  }

  path(project, suffix = '') { return `/repos/${encodeURIComponent(project.repository.owner)}/${encodeURIComponent(project.repository.name)}${suffix}`; }

  async inspect(project) {
    const repository = await this.request(this.path(project));
    const branch = await this.request(this.path(project, `/branches/${encodeURIComponent(project.defaultBranch)}`));
    return { provider: 'github', status: 'ok', repository: repository.full_name, defaultBranch: repository.default_branch, head: branch.commit.sha };
  }

  async createPullRequest(project, { branch, title, body }) {
    const pullRequest = await this.request(this.path(project, '/pulls'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: clip(title, 120), head: branch, base: project.defaultBranch, body: clip(body, 4_000) })
    });
    return { number: pullRequest.number, url: pullRequest.html_url, state: pullRequest.state };
  }

  async checks(project, sha) {
    const data = await this.request(this.path(project, `/commits/${encodeURIComponent(sha)}/check-runs`));
    const checks = (data.check_runs ?? []).map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.details_url }));
    return { state: ciState(checks), checks };
  }

  async waitForCi(project, sha, { timeoutMs, pollIntervalMs }) {
    const startedAt = this.now();
    for (;;) {
      const latest = await this.checks(project, sha);
      if (latest.state !== 'pending') return { ...latest, durationMs: this.now() - startedAt };
      if (this.now() - startedAt >= timeoutMs) return { ...latest, state: 'timeout', durationMs: this.now() - startedAt };
      await this.sleep(pollIntervalMs);
    }
  }
}

export class VercelDeploymentProvider {
  async latest() { return { provider: 'vercel', status: 'not_configured' }; }
}

export class DeterministicPlanner {
  async plan(goal, project) {
    const task = {
      objective: String(goal),
      repositoryContext: { repository: `${project.repository.owner}/${project.repository.name}`, defaultBranch: project.defaultBranch },
      constraints: ['Modify only the authorized workspace.', 'Do not commit, push, merge, deploy, or modify secrets.', 'Keep the change small and safe.'],
      acceptanceCriteria: ['A focused code or documentation diff exists.', 'Configured tests, typecheck, lint, and build pass.', 'A pull request is created and CI succeeds.']
    };
    return {
      summary: `Engineering plan for: ${task.objective}`,
      tasks: [{ id: 'branch', action: 'create_working_branch' }, { id: 'code', action: 'coding_worker' }, { id: 'validate', action: 'run_configured_checks' }, { id: 'publish', action: 'commit_push_create_pr_and_poll_ci' }],
      codingTask: task
    };
  }
}

export function evaluate(results) {
  const required = ['worker', 'diff', 'test', 'typecheck', 'lint', 'build', 'commit', 'push', 'pullRequest', 'ci'];
  const missing = required.filter((name) => results[name]?.ok !== true);
  return { decision: missing.length ? 'FAIL' : 'PASS', reasons: missing.length ? missing.map((name) => `${name} did not pass`) : ['All deterministic engineering criteria passed'] };
}

export function report(run) {
  const checks = Object.entries(run.results ?? {}).filter(([, result]) => result && typeof result === 'object' && 'ok' in result).map(([name, result]) => `${name.toUpperCase()}: ${result.ok ? 'PASS' : 'FAIL'}`).join('\n') || 'No checks executed';
  return `RUN\n${run.id}\n\nOBJECTIVE\n${maskSecrets(run.goal)}\n\nSTATUS\n${run.status}\n\nPROJECT\n${run.projectId}\n\nHEAD INITIAL\n${run.initialHead ?? 'unknown'}\n\nWORKING BRANCH\n${run.workingBranch ?? 'not created'}\n\nHEAD FINAL\n${run.finalHead ?? 'unknown'}\n\nPULL REQUEST\n${run.pullRequestUrl ?? 'not created'}\n\nCHECKS\n${checks}\n\nWORKER ATTEMPTS\n${run.workerAttempts ?? 0}/${run.budgets.maxWorkerAttempts}\n\nAPPROVALS\n${run.approvals?.length ?? 0}\n\nRECOMMENDATION\n${run.budgetExhausted ? `Budget exhausted: ${run.budgetExhausted}` : run.evaluation?.reasons?.join('; ') ?? 'Run has not been evaluated.'}`;
}

export class Orchestrator {
  constructor({ store, planner = new DeterministicPlanner(), github = new GitHubAdapter(), localGit = new LocalGitAdapter(), worker = new CodexSdkWorker(), commandRunner = runCommand }) {
    Object.assign(this, { store, planner, github, localGit, worker, commandRunner });
  }

  async event(runId, component, event, details = {}) {
    await this.store.mutate((data) => { data.events.push({ id: randomUUID(), timestamp: new Date().toISOString(), runId, level: 'info', component, event, details: safeJson(details) }); });
  }

  async updateRun(id, mutator) {
    return this.store.mutate((data) => { const run = data.runs[id]; if (!run) throw new Error('Run not found'); mutator(run, data); return run; });
  }

  async create(project, goal, dryRun = false) {
    const id = `agent-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    const run = { id, projectId: project.id, goal: maskSecrets(goal), status: RunStatus.CREATED, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dryRun, budgets: project.budgets, deadlineAt: Date.now() + project.budgets.maxRuntimeMinutes * 60_000, workerAttempts: 0, approvals: [], results: {}, checkHistory: [] };
    await this.store.mutate((data) => { data.runs[id] = run; });
    await this.event(id, 'orchestrator', 'run.created', { dryRun });
    return run;
  }

  assertDeadline(run) { if (Date.now() > run.deadlineAt) throw new Error('maxRuntimeMinutes'); }

  async fail(runId, reason) {
    const run = await this.updateRun(runId, (current) => { current.failureReason = clip(reason, 1_000); if (![RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.COMPLETED].includes(current.status)) transition(current, RunStatus.FAILED); });
    await this.event(runId, 'orchestrator', 'run.failed', { reason });
    return run;
  }

  async requireApproval(run, action, reason, payload, project) {
    const verdict = policy(action, project);
    if (verdict === 'FORBIDDEN') throw new Error(`Forbidden action: ${action}`);
    if (verdict === 'SAFE') return null;
    const id = createHash('sha256').update(`${run.id}:${action}:${JSON.stringify(payload)}`).digest('hex').slice(0, 16);
    await this.store.mutate((data) => {
      if (!data.approvals[id]) data.approvals[id] = { id, runId: run.id, action, reason: clip(reason), payload: safeJson(payload), createdAt: new Date().toISOString(), status: 'pending', execution: 'pending' };
      const current = data.runs[run.id];
      if (!current.approvals.includes(id)) current.approvals.push(id);
      current.pendingAction = { action, approvalId: id, execution: 'pending' };
      if (current.status !== RunStatus.WAITING_APPROVAL) transition(current, RunStatus.WAITING_APPROVAL);
    });
    await this.event(run.id, 'policy', 'approval.requested', { action, reason });
    return id;
  }

  async decideApproval(id, approved) {
    return this.store.mutate((data) => {
      const approval = data.approvals[id];
      if (!approval) throw new Error('Approval not found');
      if (approval.status !== 'pending') return approval;
      approval.status = approved ? 'approved' : 'rejected';
      approval.execution = approved ? 'pending' : 'rejected';
      approval[approved ? 'approvedAt' : 'rejectedAt'] = new Date().toISOString();
      const run = data.runs[approval.runId];
      run.pendingAction.execution = approval.execution;
      if (!approved) transition(run, RunStatus.CANCELLED);
      return approval;
    });
  }

  async plan(run, project) {
    const plan = await this.planner.plan(run.goal, project);
    if (plan.tasks.length > project.budgets.maxTasks) return this.fail(run.id, 'maxTasks');
    const updated = await this.updateRun(run.id, (current) => { transition(current, RunStatus.PLANNING); current.plan = safeJson(plan); transition(current, RunStatus.WORKING); });
    await this.event(run.id, 'planner', 'plan.generated', { taskCount: plan.tasks.length });
    return updated;
  }

  async initializeWorkspace(run, project) {
    const repository = await this.github.inspect(project);
    if (repository.defaultBranch !== project.defaultBranch) throw new Error('Configured default branch differs from GitHub');
    const branch = await this.localGit.prepareWorkingBranch(project, run.id);
    const updated = await this.updateRun(run.id, (current) => { current.repository = repository; current.initialHead = branch.initialHead; current.workingBranch = branch.workingBranch; current.results.branch = { ok: true, ...branch }; });
    await this.event(run.id, 'git', 'working_branch.created', { branch: branch.workingBranch, initialHead: branch.initialHead });
    return updated;
  }

  async retryOrFail(run, reason) {
    const current = await this.store.getRun(run.id);
    if (current.workerAttempts >= current.budgets.maxWorkerAttempts) return this.fail(run.id, 'worker_attempts_exhausted');
    await this.updateRun(run.id, (saved) => { saved.lastWorkerFailure = clip(reason, 4_000); transition(saved, RunStatus.WORKER_FAILED_RETRYABLE); transition(saved, RunStatus.WORKING); });
    await this.event(run.id, 'orchestrator', 'worker.retry_scheduled', { reason });
    return this.store.getRun(run.id);
  }

  async executeAttempt(run, project) {
    this.assertDeadline(run);
    await this.localGit.assertWorkingBranch(project, run.workingBranch);
    const beforeHead = await this.localGit.head(project);
    const task = { ...run.plan.codingTask, previousFailure: run.lastWorkerFailure };
    const workerResult = await this.worker.execute(task, { workspace: project.workspace, timeoutMs: Math.min(project.budgets.commandTimeoutMs * 4, Math.max(1_000, run.deadlineAt - Date.now())) });
    run = await this.updateRun(run.id, (saved) => { saved.workerAttempts += 1; saved.results.worker = { ok: workerResult.status === 'completed', ...safeJson(workerResult) }; });
    await this.event(run.id, 'worker', 'coding_task.completed', { status: workerResult.status, attempt: run.workerAttempts });
    if (workerResult.status !== 'completed') return this.retryOrFail(run, workerResult.output || 'worker failed');
    await this.localGit.assertWorkingBranch(project, run.workingBranch);
    if (await this.localGit.head(project) !== beforeHead) return this.fail(run.id, 'worker_mutated_git_history');
    const paths = await this.localGit.assertSafeChangedPaths(project);
    run = await this.updateRun(run.id, (saved) => { saved.results.diff = { ok: paths.length > 0, paths }; });
    if (!paths.length) return this.retryOrFail(run, 'worker produced no diff');
    await this.updateRun(run.id, (saved) => transition(saved, RunStatus.TESTING));
    for (const name of ['test', 'typecheck', 'lint', 'build']) {
      this.assertDeadline(await this.store.getRun(run.id));
      const result = await this.commandRunner(project, name, { dryRun: run.dryRun, timeoutMs: Math.min(project.budgets.commandTimeoutMs, Math.max(1_000, run.deadlineAt - Date.now())) });
      run = await this.updateRun(run.id, (saved) => { saved.results[name] = safeJson(result); saved.checkHistory.push({ attempt: saved.workerAttempts, ...safeJson(result) }); });
      if (!result.ok) return this.retryOrFail(run, `${name} failed: ${result.stderr || result.stdout}`);
    }
    await this.updateRun(run.id, (saved) => transition(saved, RunStatus.PUSHING));
    const commit = await this.localGit.commit(project, run.workingBranch, `implement ${run.goal}`);
    run = await this.updateRun(run.id, (saved) => { saved.finalHead = commit.finalHead; saved.results.commit = { ok: true, ...commit }; });
    const push = await this.localGit.push(project, run.workingBranch);
    run = await this.updateRun(run.id, (saved) => { saved.results.push = { ok: true, ...push }; });
    if (!run.pullRequestNumber) {
      const approvalId = await this.requireApproval(run, 'create_pull_request', 'Publish validated engineering work for review', { branch: run.workingBranch, finalHead: run.finalHead }, project);
      if (approvalId) return this.store.getRun(run.id);
      run = await this.createPullRequest(run, project);
    }
    return this.pollCi(run, project);
  }

  async createPullRequest(run, project) {
    const pullRequest = await this.github.createPullRequest(project, { branch: run.workingBranch, title: `Agent: ${clip(run.goal, 90)}`, body: `Automated engineering run ${run.id}.\n\nThe orchestrator ran configured checks before pushing. Review is required before merge.` });
    const updated = await this.updateRun(run.id, (saved) => { saved.pullRequestNumber = pullRequest.number; saved.pullRequestUrl = pullRequest.url; saved.results.pullRequest = { ok: true, ...pullRequest }; transition(saved, RunStatus.WAITING_CI); });
    await this.event(run.id, 'github', 'pull_request.created', pullRequest);
    return updated;
  }

  async pollCi(run, project) {
    run = await this.store.getRun(run.id);
    if (run.status !== RunStatus.WAITING_CI) return run;
    const ci = await this.github.waitForCi(project, run.finalHead, { timeoutMs: project.budgets.ciTimeoutMs, pollIntervalMs: project.budgets.ciPollIntervalMs });
    run = await this.updateRun(run.id, (saved) => { saved.results.ci = { ok: ci.state === 'success', ...safeJson(ci) }; saved.ci = safeJson(ci); if (ci.state === 'success') transition(saved, RunStatus.EVALUATING); });
    await this.event(run.id, 'github', 'ci.observed', ci);
    if (ci.state === 'success') return this.updateRun(run.id, (saved) => { saved.evaluation = evaluate(saved.results); transition(saved, saved.evaluation.decision === 'PASS' ? RunStatus.COMPLETED : RunStatus.FAILED); });
    if (ci.state === 'failure') return this.retryOrFail(run, 'CI failed');
    return this.fail(run.id, 'ci_timeout');
  }

  async continueRun(run, project) {
    try {
      this.assertDeadline(run);
      if (run.status === RunStatus.WAITING_APPROVAL) {
        const approval = (await this.store.load()).approvals[run.pendingAction?.approvalId];
        if (!approval || approval.status !== 'approved') return run;
        if (approval.action === 'create_pull_request') {
          run = await this.updateRun(run.id, (saved) => { approval.execution = 'executing'; saved.pendingAction.execution = 'executing'; transition(saved, RunStatus.PUSHING); });
          run = await this.createPullRequest(run, project);
          return this.pollCi(run, project);
        }
        return this.updateRun(run.id, (saved) => { approval.execution = 'unsupported'; saved.pendingAction.execution = 'unsupported'; transition(saved, RunStatus.COMPLETED); });
      }
      if (run.status === RunStatus.WAITING_CI) return this.pollCi(run, project);
      if (run.status === RunStatus.PLANNING || run.status === RunStatus.CREATED) run = await this.plan(run, project);
      if (!run.workingBranch) run = await this.initializeWorkspace(run, project);
      while (run.status === RunStatus.WORKING && run.workerAttempts < run.budgets.maxWorkerAttempts) {
        run = await this.executeAttempt(run, project);
        if (run.status === RunStatus.WAITING_CI) return run;
      }
      return run;
    } catch (error) {
      return this.fail(run.id, error.message);
    }
  }

  async run(project, goal, { dryRun = false, requestAction } = {}) {
    let run = await this.create(project, goal, dryRun);
    run = await this.plan(run, project);
    if (requestAction) { await this.requireApproval(run, requestAction, 'Requested by run input', {}, project); return this.store.getRun(run.id); }
    return this.continueRun(run, project);
  }

  async resume(id, project) {
    const run = await this.store.getRun(id);
    if (!run) throw new Error('Resumable run not found');
    if (run.projectId !== project.id) throw new Error('Project does not match saved run');
    return this.continueRun(run, project);
  }
}
