import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOperatorServiceUnit,
  installOperatorService,
  operatorServiceStatus,
  resolveGitHubToken,
  uninstallOperatorService
} from '../src/operator-service.js';

test('service unit is token-free, restartable, and hardened around one repository root', () => {
  const unit = buildOperatorServiceUnit({
    repositoryRoot: '/home/pablo/projects/agente-automatizador',
    nodePath: '/home/pablo/.nvm/versions/node/v22/bin/node'
  });
  assert.match(unit, /ExecStart="\/home\/pablo\/\.nvm\/versions\/node\/v22\/bin\/node" "\/home\/pablo\/projects\/agente-automatizador\/src\/cli\.js" inbox watch/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ProtectHome=read-only/);
  assert.match(unit, /ReadWritePaths="\/home\/pablo\/projects\/agente-automatizador"/);
  assert.doesNotMatch(unit, /GITHUB_TOKEN|gho_|auth token/i);
  assert.throws(() => buildOperatorServiceUnit({ repositoryRoot: '/home/pablo/bad$path' }), /safe absolute path/);
});

test('GitHub token resolution prefers environment and otherwise delegates without exposing credentials', async () => {
  let calls = 0;
  const fromEnvironment = await resolveGitHubToken({
    environment: { GITHUB_TOKEN: 'gho_environment_secret' },
    tokenReader: async () => { calls += 1; return 'should-not-run'; }
  });
  assert.equal(fromEnvironment, 'gho_environment_secret');
  assert.equal(calls, 0);

  const fromGh = await resolveGitHubToken({
    environment: { HOME: '/home/pablo', PATH: '/usr/bin' },
    tokenReader: async ({ environment }) => {
      calls += 1;
      assert.equal(environment.HOME, '/home/pablo');
      return 'gho_runtime_secret';
    }
  });
  assert.equal(fromGh, 'gho_runtime_secret');
  assert.equal(calls, 1);
  await assert.rejects(
    resolveGitHubToken({ environment: { GITHUB_TOKEN: 'two tokens' } }),
    /one bounded token/
  );
});

test('service installation is atomic, stores no token, and enables the user service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-repo-'));
  const calls = [];
  const processRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  };
  try {
    const result = await installOperatorService({
      repositoryRoot,
      nodePath: '/usr/bin/node',
      home,
      platform: 'linux',
      processRunner,
      tokenResolver: async () => 'gho_never_persist_this'
    });
    const unit = await readFile(result.serviceFile, 'utf8');
    const info = await lstat(result.serviceFile);
    assert.equal(info.isFile(), true);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(unit.includes('gho_never_persist_this'), false);
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'engineering-orchestrator.service']
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('service installation rejects symlink targets and rolls back failed activation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-repo-'));
  const serviceDir = join(home, '.config', 'systemd', 'user');
  const serviceFile = join(serviceDir, 'engineering-orchestrator.service');
  try {
    await mkdir(serviceDir, { recursive: true });
    await writeFile(join(home, 'target'), 'x');
    await symlink(join(home, 'target'), serviceFile);
    await assert.rejects(
      installOperatorService({
        repositoryRoot,
        nodePath: '/usr/bin/node',
        home,
        platform: 'linux',
        processRunner: async () => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '' }),
        tokenResolver: async () => 'token'
      }),
      /regular non-symlink/
    );
    await rm(serviceFile, { force: true });

    const repositoryLink = join(home, 'repository-link');
    await symlink(repositoryRoot, repositoryLink, 'dir');
    await assert.rejects(
      installOperatorService({
        repositoryRoot: repositoryLink,
        nodePath: '/usr/bin/node',
        home,
        platform: 'linux',
        processRunner: async () => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '' }),
        tokenResolver: async () => 'token'
      }),
      /repositoryRoot must not traverse symlinks/
    );

    const calls = [];
    await assert.rejects(
      installOperatorService({
        repositoryRoot,
        nodePath: '/usr/bin/node',
        home,
        platform: 'linux',
        processRunner: async (command, args) => {
          calls.push([command, ...args]);
          if (args.includes('enable')) return { exitCode: 1, timedOut: false, stdout: '', stderr: 'failed' };
          return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
        },
        tokenResolver: async () => 'token'
      }),
      /systemctl --user enable failed/
    );
    await assert.rejects(lstat(serviceFile), { code: 'ENOENT' });
    assert.ok(calls.some((call) => call.includes('disable')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('service status and uninstall use only the user systemd manager', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-home-'));
  const calls = [];
  const processRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('is-enabled')) return { exitCode: 0, timedOut: false, stdout: 'enabled\n', stderr: '' };
    if (args.includes('is-active')) return { exitCode: 0, timedOut: false, stdout: 'active\n', stderr: '' };
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  };
  try {
    assert.deepEqual(await operatorServiceStatus({ processRunner }), {
      service: 'engineering-orchestrator.service',
      enabled: true,
      active: true
    });
    const removed = await uninstallOperatorService({ home, platform: 'linux', processRunner });
    assert.equal(removed.removed, true);
    assert.ok(calls.every((call) => call[0] === 'systemctl' && call[1] === '--user'));
    await assert.rejects(
      installOperatorService({ repositoryRoot: '/tmp/agent', platform: 'win32', processRunner, tokenResolver: async () => 'token' }),
      /only on Linux\/WSL/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
