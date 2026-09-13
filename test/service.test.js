import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INBOX_SERVICE_NAME,
  ensureGitHubToken,
  installInboxService,
  renderInboxServiceUnit,
  restartInboxService,
  serviceStatus,
  syncInboxService,
  uninstallInboxService
} from '../src/service.js';

test('GitHub token bootstrap prefers environment and otherwise reads gh auth without persisting it', async () => {
  const environment = { GITHUB_TOKEN: 'existing-token-value-1234567890', PATH: '/usr/bin', HOME: '/home/test' };
  let calls = 0;
  assert.deepEqual(await ensureGitHubToken({ environment, commandRunner: async () => { calls += 1; } }), { source: 'environment' });
  assert.equal(calls, 0);

  delete environment.GITHUB_TOKEN;
  const secret = 'gho_abcdefghijklmnopqrstuvwxyz1234567890';
  const result = await ensureGitHubToken({
    environment,
    home: '/home/test',
    commandRunner: async (command, args, options) => {
      calls += 1;
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['auth', 'token']);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      return { exitCode: 0, stdout: secret + '\n', stderr: '' };
    }
  });
  assert.deepEqual(result, { source: 'gh' });
  assert.equal(environment.GITHUB_TOKEN, secret);
  assert.equal(calls, 1);

  await assert.rejects(
    ensureGitHubToken({ environment: { PATH: '/usr/bin', HOME: '/home/test' }, commandRunner: async () => ({ exitCode: 1, stdout: secret, stderr: secret }) }),
    (error) => error.message === 'github_cli_auth_required' && !error.message.includes(secret)
  );
});

test('systemd unit is persistent, uses absolute paths, and contains no GitHub secret', () => {
  const unit = renderInboxServiceUnit({
    repositoryRoot: '/home/pablo/projects/agente-automatizador',
    nodePath: '/home/pablo/.nvm/versions/node/v22.23.2/bin/node',
    pathValue: '/tmp/untrusted-bin:/usr/bin',
    home: '/home/pablo',
    environment: {
      GH_CONFIG_DIR: '/home/pablo/.config/gh-custom',
      CODEX_HOME: '/home/pablo/.codex-custom',
      GITHUB_TOKEN: 'must-never-be-rendered'
    }
  });
  assert.match(unit, /managed-by=engineering-orchestrator:v1/);
  assert.match(unit, /ExecStart=.*src\/cli\.js.*inbox watch/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /PATH=\/home\/pablo\/\.nvm\/versions\/node\/v22\.23\.2\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
  assert.match(unit, /GH_CONFIG_DIR=\/home\/pablo\/\.config\/gh-custom/);
  assert.match(unit, /CODEX_HOME=\/home\/pablo\/\.codex-custom/);
  assert.doesNotMatch(unit, /\/tmp\/untrusted-bin|GITHUB_TOKEN|must-never-be-rendered|gho_|ghp_/);
});

test('service install/status/restart/uninstall is managed and rollback-safe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-repo-'));
  const nodePath = process.execPath;
  const pathValue = '/usr/bin:/bin';
  const secret = 'gho_abcdefghijklmnopqrstuvwxyz1234567890';
  const calls = [];
  let active = false;
  let enabled = false;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh') return { exitCode: 0, stdout: secret + '\n', stderr: '' };
    assert.equal(command, 'systemctl');
    const action = args[1];
    if (action === 'enable') { enabled = true; active = true; return { exitCode: 0, stdout: '', stderr: '' }; }
    if (action === 'restart') { active = true; return { exitCode: 0, stdout: '', stderr: '' }; }
    if (action === 'disable') { enabled = false; active = false; return { exitCode: 0, stdout: '', stderr: '' }; }
    if (action === 'is-enabled') return { exitCode: enabled ? 0 : 1, stdout: enabled ? 'enabled\n' : 'disabled\n', stderr: '' };
    if (action === 'is-active') return { exitCode: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
    const environment = { PATH: pathValue, HOME: home };
    const installed = await installInboxService({ repositoryRoot, nodePath, pathValue, home, platform: 'linux', commandRunner: runner, environment });
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.active, true);
    const unit = await readFile(installed.unitPath, 'utf8');
    assert.equal(unit.includes(secret), false);
    assert.ok(calls.some((entry) => entry.join(' ') === `systemctl --user enable --now ${INBOX_SERVICE_NAME}`));
    await assert.rejects(
      installInboxService({ repositoryRoot, nodePath, pathValue, home, platform: 'linux', commandRunner: runner, environment }),
      /persistent_inbox_service_already_installed_use_restart/
    );

    const restarted = await restartInboxService({ home, pathValue, commandRunner: runner });
    assert.equal(restarted.active, true);

    const unchanged = await syncInboxService({ repositoryRoot, nodePath, pathValue, home, platform: 'linux', commandRunner: runner, environment });
    assert.equal(unchanged.changed, false);
    environment.GH_HOST = 'github.com';
    const updated = await syncInboxService({ repositoryRoot, nodePath, pathValue, home, platform: 'linux', commandRunner: runner, environment });
    assert.equal(updated.changed, true);
    const syncedUnit = await readFile(updated.unitPath, 'utf8');
    assert.match(syncedUnit, /GH_HOST=github\.com/);
    assert.equal(syncedUnit.includes(secret), false);

    const removed = await uninstallInboxService({ home, pathValue, commandRunner: runner });
    assert.equal(removed.removed, true);
    assert.equal((await serviceStatus({ home, pathValue, commandRunner: runner })).installed, false);

    const unitDirectory = join(home, '.config', 'systemd', 'user');
    await writeFile(join(unitDirectory, INBOX_SERVICE_NAME), '[Unit]\nDescription=someone else\n');
    await assert.rejects(
      installInboxService({ repositoryRoot, nodePath, pathValue, home, platform: 'linux', commandRunner: runner, environment }),
      /service_unit_not_managed_by_agent/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('service installation fails closed outside Linux', async () => {
  await assert.rejects(
    installInboxService({ platform: 'win32' }),
    /persistent_inbox_service_requires_linux_systemd/
  );
});
