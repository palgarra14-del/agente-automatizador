import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WSL_MANAGED_RUNNER_DIRECTORIES,
  WSL_WAKEUP_RUN_VALUE,
  renderWslGuardianScript,
  syncWslWakeup,
  uninstallWslWakeup,
  wslWakeupConfiguration,
  wslWakeupStatus
} from '../src/wsl-wakeup.js';

function environment(overrides = {}) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/home/pablo',
    USER: 'pablo',
    WSL_DISTRO_NAME: 'Ubuntu',
    WSL_INTEROP: '/run/WSL/123_interop',
    ...overrides
  };
}

async function seedInboxService(home) {
  const directory = join(home, '.config', 'systemd', 'user');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'engineering-orchestrator-inbox.service'), '# managed-by=engineering-orchestrator:v1\n');
}

function fixtureRunner({ failRunWrite = false } = {}) {
  const registry = new Map();
  const calls = [];
  const key = (registryKey, name) => `${registryKey}|${name}`;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'systemctl') {
      const action = args[1];
      if (action === 'is-enabled') return { exitCode: 0, stdout: 'enabled\n', stderr: '' };
      if (action === 'is-active') return { exitCode: 0, stdout: 'active\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    assert.equal(command, '/fake/reg.exe');
    const action = args[0];
    const registryKey = args[1];
    const valueIndex = args.indexOf('/v');
    const name = args[valueIndex + 1];
    if (action === 'QUERY') {
      const value = registry.get(key(registryKey, name));
      if (value === undefined) return { exitCode: 1, stdout: '', stderr: 'not found' };
      return { exitCode: 0, stdout: `\n    ${name}    REG_SZ    ${value}\n`, stderr: '' };
    }
    if (action === 'ADD') {
      if (failRunWrite && name === WSL_WAKEUP_RUN_VALUE) return { exitCode: 5, stdout: '', stderr: 'denied' };
      registry.set(key(registryKey, name), args[args.indexOf('/d') + 1]);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (action === 'DELETE') {
      const existed = registry.delete(key(registryKey, name));
      return { exitCode: existed ? 0 : 1, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected registry action: ${action}`);
  };
  return { runner, registry, calls, key };
}

test('WSL wakeup command is bounded, hidden, explicit-user, and guardian keeps WSL alive', () => {
  const config = wslWakeupConfiguration({ home: '/home/pablo', environment: environment() });
  assert.equal(config.distro, 'Ubuntu');
  assert.equal(config.linuxUser, 'pablo');
  assert.ok(config.command.length <= 260);
  assert.match(config.command, /WindowStyle Hidden/);
  assert.match(config.command, /wsl\.exe -d Ubuntu --user pablo --exec \/home\/pablo\/\.config\/engineering-orchestrator\/wsl-guardian\.sh/);
  assert.match(config.commandHash, /^[a-f0-9]{64}$/);
  const guardian = renderWslGuardianScript();
  assert.match(guardian, /systemctl --user start engineering-orchestrator-inbox\.service/);
  assert.match(guardian, /exec \/usr\/bin\/sleep infinity/);
  assert.doesNotMatch(guardian, /token|secret|password/i);
});

test('WSL guardian supervises the three configured local Actions runners without embedding credentials', () => {
  assert.deepEqual(WSL_MANAGED_RUNNER_DIRECTORIES, [
    'actions-runner-agente',
    'actions-runner-agente-2',
    'actions-runner-agente-3'
  ]);
  const guardian = renderWslGuardianScript();
  for (const directory of WSL_MANAGED_RUNNER_DIRECTORIES) {
    assert.match(guardian, new RegExp(`runner_watch "\\\$HOME/${directory.replaceAll('.', '\\\\.')}"`));
  }
  assert.match(guardian, /runner_listener_active/);
  assert.match(guardian, /\/proc\/\[0-9\]\*/);
  assert.match(guardian, /readlink "\$process\/cwd"/);
  assert.match(guardian, /Runner\.Listener/);
  assert.match(guardian, /run\.sh/);
  assert.match(guardian, /\[ ! -L "\$runner" \]/);
  assert.match(guardian, /\[ ! -L "\$runner\/\.runner" \]/);
  assert.match(guardian, /\[ ! -L "\$listener" \]/);
  assert.match(guardian, /\[ ! -L "\$launcher" \]/);
  assert.match(guardian, /sleep 10/);
  assert.match(guardian, /sleep 5/);
  assert.doesNotMatch(guardian, /token|secret|password|credential/i);
  if (process.platform !== 'win32') {
    const syntax = spawnSync('/bin/sh', ['-n'], { input: guardian, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test('WSL wakeup sync is idempotent and status is ownership-bound', async () => {
  const home = await mkdtemp(join(tmpdir(), 'w-'));
  const fixture = fixtureRunner();
  await seedInboxService(home);
  const options = { home, platform: 'linux', pathValue: '/usr/bin:/bin', environment: environment({ HOME: home }), commandRunner: fixture.runner, regExecutable: '/fake/reg.exe' };
  try {
    const first = await syncWslWakeup(options);
    assert.equal(first.healthy, true);
    assert.equal(first.changed, true);
    const guardian = await readFile(first.guardianPath, 'utf8');
    assert.equal(guardian, renderWslGuardianScript());
    assert.equal((await lstat(first.guardianPath)).mode & 0o777, 0o700);

    const second = await syncWslWakeup(options);
    assert.equal(second.healthy, true);
    assert.equal(second.changed, false);
    const status = await wslWakeupStatus(options);
    assert.equal(status.installed, true);
    assert.equal(status.healthy, true);

    const removed = await uninstallWslWakeup(options);
    assert.equal(removed.removed, true);
    const after = await wslWakeupStatus(options);
    assert.equal(after.installed, false);
    assert.equal(after.healthy, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('WSL wakeup refuses foreign or tampered startup state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'w-'));
  const fixture = fixtureRunner();
  await seedInboxService(home);
  const options = { home, platform: 'linux', pathValue: '/usr/bin:/bin', environment: environment({ HOME: home }), commandRunner: fixture.runner, regExecutable: '/fake/reg.exe' };
  try {
    const installed = await syncWslWakeup(options);
    const runEntry = [...fixture.registry.keys()].find((entry) => entry.endsWith(`|${WSL_WAKEUP_RUN_VALUE}`));
    fixture.registry.set(runEntry, 'C:\\Windows\\System32\\calc.exe');
    await assert.rejects(syncWslWakeup(options), /wsl_wakeup_run_command_tampered/);
    assert.equal(fixture.registry.get(runEntry), 'C:\\Windows\\System32\\calc.exe');

    fixture.registry.clear();
    await rm(installed.guardianPath, { force: true });
    await writeFile(installed.guardianPath, '#!/bin/sh\necho foreign\n', { mode: 0o700 });
    await assert.rejects(syncWslWakeup(options), /wsl_guardian_not_managed_by_agent/);

    await rm(installed.guardianPath, { force: true });
    const linkedGuardian = join(home, 'linked-guardian.sh');
    await writeFile(linkedGuardian, renderWslGuardianScript(), { mode: 0o700 });
    await link(linkedGuardian, installed.guardianPath);
    await assert.rejects(syncWslWakeup(options), /wsl_guardian_must_not_be_hardlinked/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('WSL wakeup refuses a symlinked config ancestor before creating guardian state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'w-'));
  const target = await mkdtemp(join(tmpdir(), 'w-target-'));
  const fixture = fixtureRunner();
  try {
    await symlink(target, join(home, '.config'), 'dir');
    const serviceDirectory = join(target, 'systemd', 'user');
    await mkdir(serviceDirectory, { recursive: true });
    await writeFile(join(serviceDirectory, 'engineering-orchestrator-inbox.service'), '# managed-by=engineering-orchestrator:v1\n');

    const options = { home, platform: 'linux', pathValue: '/usr/bin:/bin', environment: environment({ HOME: home }), commandRunner: fixture.runner, regExecutable: '/fake/reg.exe' };
    await assert.rejects(syncWslWakeup(options), /wsl_guardian_directory_invalid/);
    await assert.rejects(lstat(join(target, 'engineering-orchestrator')), /ENOENT/);
    assert.equal(fixture.registry.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('WSL wakeup rolls registry and guardian back if Windows registration fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'w-'));
  const fixture = fixtureRunner({ failRunWrite: true });
  await seedInboxService(home);
  const options = { home, platform: 'linux', pathValue: '/usr/bin:/bin', environment: environment({ HOME: home }), commandRunner: fixture.runner, regExecutable: '/fake/reg.exe' };
  try {
    await assert.rejects(syncWslWakeup(options), /windows_registry_write_failed:EngineeringOrchestratorWSLWakeup/);
    assert.equal(fixture.registry.size, 0);
    const config = wslWakeupConfiguration({ home, environment: options.environment });
    await assert.rejects(readFile(config.guardianPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('WSL wakeup fails closed without interop and rejects identifier injection', async () => {
  const unsupported = await wslWakeupStatus({ platform: 'linux', environment: environment({ WSL_INTEROP: '' }) });
  assert.equal(unsupported.supported, false);
  await assert.rejects(
    syncWslWakeup({ platform: 'linux', environment: environment({ WSL_INTEROP: '' }) }),
    /wsl_wakeup_requires_windows_interop/
  );
  assert.throws(
    () => wslWakeupConfiguration({ home: '/home/pablo', environment: environment({ WSL_DISTRO_NAME: 'Ubuntu;calc.exe' }) }),
    /unsafe characters/
  );
  assert.throws(
    () => wslWakeupConfiguration({ home: '/home/pablo', environment: environment({ USER: 'pablo"&calc' }) }),
    /unsafe characters/
  );
});
