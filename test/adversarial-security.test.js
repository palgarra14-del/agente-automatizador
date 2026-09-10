import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGitAdapter, configFrom, maskSecrets } from '../src/core.js';

test('secret masking redacts quoted JSON-style secret fields and authorization headers', () => {
  const input = JSON.stringify({
    token: 'generic-token-value',
    api_key: 'generic-api-key-value',
    password: 'generic-password-value',
    credential: 'generic-credential-value',
    authorization: 'Basic Zm9vOmJhcg=='
  });
  const masked = maskSecrets(input);
  for (const secret of [
    'generic-token-value',
    'generic-api-key-value',
    'generic-password-value',
    'generic-credential-value',
    'Zm9vOmJhcg=='
  ]) assert.equal(masked.includes(secret), false, `secret remained visible: ${secret}`);

  assert.equal(maskSecrets('Authorization: Basic Zm9vOmJhcg==').includes('Zm9vOmJhcg=='), false);
});

test('controlled git push disables repository-provided pre-push hooks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-push-hook-'));
  const project = configFrom({
    id: 'hook-test',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace,
    workingBranchPattern: 'agent/{runId}',
    commands: { test: 'node --version' },
    budgets: { commandTimeoutMs: 1000 }
  });
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
