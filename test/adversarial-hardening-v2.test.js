import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, LocalGitAdapter, configFrom, evaluateChangePolicy, maskSecrets, runProcess } from '../src/core.js';

function minimalProject(workspace, overrides = {}) {
  return configFrom({
    id: 'adversarial',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '..',
    workingBranchPattern: 'agent/{runId}',
    commands: { test: 'node --version' },
    budgets: { commandTimeoutMs: 2_000 },
    ...overrides
  }, join(workspace, 'config'));
}

test('adversarial: quoted secrets and Basic/Bearer authorization are fully redacted', () => {
  const input = JSON.stringify({ token: 'generic-token-value', api_key: 'generic-api-key-value', password: 'generic-password-value', credential: 'generic-credential-value', cookie: 'session-cookie-value', authorization: 'Basic Zm9vOmJhcg==' });
  const masked = maskSecrets(input);
  for (const secret of ['generic-token-value', 'generic-api-key-value', 'generic-password-value', 'generic-credential-value', 'session-cookie-value', 'Zm9vOmJhcg==']) assert.equal(masked.includes(secret), false, `secret remained visible: ${secret}`);
  assert.equal(maskSecrets('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'), false);
  assert.equal(maskSecrets('Authorization: Basic Zm9vOmJhcg==').includes('Zm9vOmJhcg=='), false);
});

test('adversarial: controlled push disables repository-provided pre-push hooks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-push-hook-v2-'));
  const project = minimalProject(workspace);
  const calls = [];
  const processRunner = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, exitCode: 0, stdout: `${workspace}\n`, stderr: '', timedOut: false };
    if (args[0] === 'remote') return { ok: true, exitCode: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '', timedOut: false };
    if (args[0] === 'branch') return { ok: true, exitCode: 0, stdout: 'agent/test-run\n', stderr: '', timedOut: false };
    if (args[0] === 'status') return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false };
    return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const git = new LocalGitAdapter({ processRunner });
  await git.push(project, 'agent/test-run', { expectedHead: 'abc123', expectedRemote: 'https://github.com/owner/repo.git' });
  const push = calls.find((args) => args[0] === 'push');
  assert.ok(push);
  assert.ok(push.includes('--no-verify'), `pre-push hooks remain enabled: git ${push.join(' ')}`);
});

test('adversarial: binary changes are governed by total-byte and per-file budgets', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-binary-budget-v2-'));
  const project = minimalProject(workspace, { changePolicy: { budgets: { maxChangedFiles: 5, maxDiffLines: 100, maxChangedBytes: 64 * 1024, maxFileBytes: 64 * 1024 } } });
  await runProcess('git', ['init'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['config', 'user.email', 'agent@example.invalid'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['config', 'user.name', 'Agent Test'], { cwd: workspace, timeoutMs: 5_000 });
  await writeFile(join(workspace, 'README.md'), 'baseline\n');
  await runProcess('git', ['add', 'README.md'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['commit', '--no-verify', '-m', 'baseline'], { cwd: workspace, timeoutMs: 5_000 });
  await writeFile(join(workspace, 'large.bin'), Buffer.alloc(128 * 1024, 0xa5));
  const changeSet = await new LocalGitAdapter().inspectChangeSet(project);
  assert.ok(changeSet.changedBytes >= 128 * 1024);
  assert.ok(changeSet.maxFileBytes >= 128 * 1024);
  const decision = evaluateChangePolicy(project, changeSet);
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'change_budget_exceeded');
});

test('adversarial: shared JSON state mutations do not lose concurrent updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-race-v2-'));
  const file = join(directory, 'state.json');
  const first = new JsonStore(file);
  const second = new JsonStore(file);
  await first.save({ runs: {}, approvals: {}, events: [] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstEntered = false;
  const firstMutation = first.mutate(async (data) => {
    firstEntered = true;
    await gate;
    data.runs['run-a'] = { id: 'run-a', status: 'created' };
  });
  while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 5));
  const secondMutation = second.mutate(async (data) => {
    data.runs['run-b'] = { id: 'run-b', status: 'created' };
  });
  setTimeout(() => release(), 50);
  await Promise.all([firstMutation, secondMutation]);
  const final = await first.load();
  assert.ok(final.runs['run-a']);
  assert.ok(final.runs['run-b']);
});

test('adversarial: noisy subprocess output stays bounded while byte evidence remains accurate', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(1024 * 1024))"], { timeoutMs: 5_000, outputLimit: 1_024, captureOutputDigest: true });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= 1_024);
  assert.ok(result.stdoutBytes >= 1024 * 1024);
  assert.match(result.stdoutDigest, /^[a-f0-9]{64}$/);
});

test('adversarial: timed-out subprocess that ignores SIGTERM is escalated and terminates', async () => {
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 100, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - startedAt < 2_000, 'timeout escalation did not terminate promptly');
});
