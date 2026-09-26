import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, LocalGitAdapter, configFrom, evaluateChangePolicy, maskSecrets, runProcess } from '../src/core.js';

test('secret masking redacts quoted JSON-style secret fields and authorization headers', () => {
  const input = JSON.stringify({
    token: 'generic-token-value',
    api_key: 'generic-api-key-value',
    password: 'generic-password-value',
    credential: 'generic-credential-value',
    access_token: 'generic-access-token-value',
    client_secret: 'generic-client-secret-value',
    session_cookie: 'generic-session-cookie-value',
    authorization: 'Basic Zm9vOmJhcg=='
  });
  const masked = maskSecrets(input);
  for (const secret of [
    'generic-token-value',
    'generic-api-key-value',
    'generic-password-value',
    'generic-credential-value',
    'generic-access-token-value',
    'generic-client-secret-value',
    'generic-session-cookie-value',
    'Zm9vOmJhcg=='
  ]) assert.equal(masked.includes(secret), false, `secret remained visible: ${secret}`);

  assert.equal(maskSecrets('Authorization: Basic Zm9vOmJhcg==').includes('Zm9vOmJhcg=='), false);
});

test('secret masking preserves valid JSON structure while redacting embedded authorization-like strings', () => {
  const raw = JSON.stringify({
    note: 'Authorization: Bearer top-secret-token-value',
    nested: { token: 'nested-secret-value' },
    list: ['safe', 'Authorization: Basic Zm9vOmJhcg==']
  });
  const masked = maskSecrets(raw);
  const parsed = JSON.parse(masked);
  assert.equal(parsed.note, 'Authorization: [REDACTED]');
  assert.equal(parsed.nested.token, '[REDACTED]');
  assert.equal(parsed.list[1], 'Authorization: [REDACTED]');
  assert.equal(masked.includes('top-secret-token-value'), false);
  assert.equal(masked.includes('nested-secret-value'), false);
  assert.equal(masked.includes('Zm9vOmJhcg=='), false);

  const configured = configFrom({
    id: 'safe-json-redaction',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    commandEnvironment: { NOTE: 'Authorization: Bearer environment-secret-value' }
  });
  assert.equal(configured.commandEnvironment.NOTE, 'Authorization: [REDACTED]');
});

test('secret masking consumes complete quoted shell and YAML values', () => {
  const cases = [
    ['TOKEN="abc123"', 'abc123'],
    ["TOKEN='abc$123!@#'", 'abc$123!@#'],
    ['PASSWORD="foo bar"', 'foo bar'],
    ["API_KEY='secret:with=symbols'", 'secret:with=symbols'],
    ['token: "yaml-secret"', 'yaml-secret'],
    ["password: 'yaml secret'", 'yaml secret'],
    ['authorization: Bearer bearer-value', 'bearer-value'],
    ['authorization: Basic basic-value', 'basic-value']
  ];
  for (const [input, secret] of cases) assert.equal(maskSecrets(input).includes(secret), false, input);
});

test('controlled git push disables repository-provided pre-push hooks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-push-hook-'));
  const project = configFrom({
    id: 'hook-test',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '..',
    workingBranchPattern: 'agent/{runId}',
    commands: { test: 'node --version' },
    budgets: { commandTimeoutMs: 1000 }
  }, join(workspace, 'config'));
  const calls = [];
  const processRunner = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, exitCode: 0, stdout: `${workspace}\n`, stderr: '', timedOut: false };
    if (args[0] === 'remote') return { ok: true, exitCode: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '', timedOut: false };
    if (args[0] === 'branch') return { ok: true, exitCode: 0, stdout: 'agent/test-run\n', stderr: '', timedOut: false };
    if (args[0] === 'status') return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false };
    if (args[0] === 'push') return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
    return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };

  const git = new LocalGitAdapter({ processRunner });
  await git.push(project, 'agent/test-run', { expectedHead: 'abc123', expectedRemote: 'https://github.com/owner/repo.git' });
  const push = calls.find((args) => args[0] === 'push');
  assert.ok(push);
  assert.ok(push.includes('--no-verify'), `push hooks are still enabled: git ${push.join(' ')}`);
});

test('change governance accounts for changed bytes and per-file size, including binary files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-binary-budget-'));
  const project = configFrom({
    id: 'binary-budget',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '..',
    commands: { test: 'node --version' },
    changePolicy: { budgets: { maxChangedFiles: 5, maxDiffLines: 100, maxChangedBytes: 64 * 1024, maxFileBytes: 64 * 1024 } },
    budgets: { commandTimeoutMs: 5000 }
  }, join(workspace, 'config'));

  await runProcess('git', ['init'], { cwd: workspace, timeoutMs: 5000 });
  await runProcess('git', ['config', 'user.email', 'agent@example.invalid'], { cwd: workspace, timeoutMs: 5000 });
  await runProcess('git', ['config', 'user.name', 'Agent Test'], { cwd: workspace, timeoutMs: 5000 });
  await writeFile(join(workspace, 'README.md'), 'baseline\n');
  await runProcess('git', ['add', 'README.md'], { cwd: workspace, timeoutMs: 5000 });
  await runProcess('git', ['commit', '--no-verify', '-m', 'baseline'], { cwd: workspace, timeoutMs: 5000 });
  await writeFile(join(workspace, 'large.bin'), Buffer.alloc(128 * 1024, 0xa5));

  const changeSet = await new LocalGitAdapter().inspectChangeSet(project);
  assert.ok(Number.isInteger(changeSet.changedBytes) && changeSet.changedBytes >= 128 * 1024, 'changed byte accounting is missing');
  assert.ok(changeSet.maxFileBytes >= 128 * 1024, 'per-file byte accounting is missing');
  const decision = evaluateChangePolicy(project, changeSet);
  assert.equal(decision.ok, false, 'a binary file over the configured byte budget was accepted');
  assert.equal(decision.reason, 'change_budget_exceeded');
});



test('streamed untracked text keeps full line accounting beyond the sensitivity sample', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-stream-lines-'));
  const project = configFrom({
    id: 'stream-lines',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '..',
    commands: { test: 'node --version' },
    changePolicy: { budgets: { maxChangedFiles: 5, maxDiffLines: 50_000, maxChangedBytes: 2 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 } },
    budgets: { commandTimeoutMs: 5_000 }
  }, join(workspace, 'config'));

  await runProcess('git', ['init'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['config', 'user.email', 'agent@example.invalid'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['config', 'user.name', 'Agent Test'], { cwd: workspace, timeoutMs: 5_000 });
  await writeFile(join(workspace, 'README.md'), 'baseline\n');
  await runProcess('git', ['add', 'README.md'], { cwd: workspace, timeoutMs: 5_000 });
  await runProcess('git', ['commit', '--no-verify', '-m', 'baseline'], { cwd: workspace, timeoutMs: 5_000 });

  const lines = Array.from({ length: 20_000 }, (_, index) => `line-${index}\n`).join('');
  await writeFile(join(workspace, 'many-lines.txt'), lines);
  const changeSet = await new LocalGitAdapter().inspectChangeSet(project);
  assert.ok(changeSet.diffLines >= 20_000, `streamed line count was truncated: ${changeSet.diffLines}`);
});
test('JsonStore does not lose updates when two agent processes mutate shared state concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-race-'));
  const file = join(directory, 'state.json');
  const first = new JsonStore(file);
  const second = new JsonStore(file);
  await first.save({ runs: {}, approvals: {}, events: [] });

  let firstEntered = false;
  const slowMutation = first.mutate(async (data) => {
    firstEntered = true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    data.runs['run-a'] = { id: 'run-a', status: 'created' };
  });
  while (!firstEntered) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  const competingMutation = second.mutate(async (data) => {
    data.runs['run-b'] = { id: 'run-b', status: 'created' };
  });

  await Promise.all([slowMutation, competingMutation]);
  const final = await first.load();
  assert.ok(final.runs['run-a'], 'concurrent mutation lost run-a');
  assert.ok(final.runs['run-b'], 'concurrent mutation lost run-b');
});

test('JsonStore recovers a lock whose owner process is dead', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-stale-lock-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  await writeFile(`${file}.lock`, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z', ownerIdentity: 'dead-process' }));
  await store.mutate((data) => { data.runs.recovered = { id: 'recovered' }; });
  assert.ok((await store.load()).runs.recovered);
});

test('JsonStore conservatively retains an old lock owned by a live process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-live-lock-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file, { lockTimeoutMs: 30, lockPollMs: 5 });
  const original = JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' });
  await writeFile(`${file}.lock`, original);
  await assert.rejects(store.mutate((data) => { data.runs.mustNotWrite = {}; }), /state_lock_timeout/);
  assert.equal(await readFile(`${file}.lock`, 'utf8'), original);
});

test('JsonStore handles PID reuse without treating a live owner as stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-pid-reuse-'));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file, { lockTimeoutMs: 30, lockPollMs: 5 });
  await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z', ownerIdentity: 'different-process-start' }));
  if (process.platform === 'linux') {
    await store.mutate((data) => { data.runs.recovered = { id: 'recovered' }; });
    assert.ok((await store.load()).runs.recovered);
  } else {
    await assert.rejects(store.mutate((data) => { data.runs.mustNotWrite = {}; }), /state_lock_timeout/);
  }
});

test('runProcess bounds captured output while retaining full byte accounting', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'], {
    timeoutMs: 5_000,
    outputLimit: 1_024,
    restrictEnvironment: true
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= 1_024);
  assert.ok(result.stdoutBytes >= 1024 * 1024);
  assert.equal(result.stdoutTruncated, true);
});

test('runProcess escalates a timed out child instead of waiting indefinitely', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {
    timeoutMs: 50,
    killGraceMs: 50,
    outputLimit: 256,
    restrictEnvironment: true
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(result.durationMs < 2_000, `timed out child survived too long: ${result.durationMs}ms`);
});

test('runProcess writes bounded stdin and closes it for non-interactive commands', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(s.toUpperCase()));'], {
    timeoutMs: 5_000,
    outputLimit: 1_024,
    restrictEnvironment: true,
    input: 'bounded stdin'
  });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'BOUNDED STDIN');
});

test('runProcess rejects oversized stdin before spawning', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.exit(0)'], {
      restrictEnvironment: true,
      input: 'x'.repeat((2 * 1024 * 1024) + 1)
    }),
    /process_stdin_too_large/
  );
});
