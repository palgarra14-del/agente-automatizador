import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInboxService } from '../src/service.js';

test('systemd user commands preserve only the session bus variables needed in WSL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-bus-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-bus-repo-'));
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890',
    SHOULD_NOT_LEAK: 'secret'
  };
  let active = false;
  let enabled = false;
  const seen = [];

  const runner = async (command, args, options = {}) => {
    if (command !== 'systemctl') throw new Error('unexpected command');
    seen.push(options.env);
    assert.equal(options.env.HOME, home);
    assert.equal(options.env.PATH, environment.PATH);
    assert.equal(options.env.XDG_RUNTIME_DIR, environment.XDG_RUNTIME_DIR);
    assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, environment.DBUS_SESSION_BUS_ADDRESS);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.SHOULD_NOT_LEAK, undefined);
    const action = args[1];
    if (action === 'enable') {
      enabled = true;
      if (args.includes('--now')) active = true;
    }
    if (action === 'restart') active = true;
    if (action === 'disable') {
      enabled = false;
      if (args.includes('--now')) active = false;
    }
    if (action === 'is-enabled') return { exitCode: enabled ? 0 : 1, stdout: enabled ? 'enabled\n' : 'disabled\n', stderr: '' };
    if (action === 'is-active') return { exitCode: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
    const status = await installInboxService({
      repositoryRoot,
      nodePath: process.execPath,
      pathValue: environment.PATH,
      home,
      platform: 'linux',
      commandRunner: runner,
      environment
    });
    assert.equal(status.active, true);
    assert.equal(status.enabled, true);
    assert.ok(seen.length >= 4);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('systemd user command environment rejects a relative XDG runtime directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-bus-invalid-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-bus-invalid-repo-'));
  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
    await assert.rejects(
      installInboxService({
        repositoryRoot,
        nodePath: process.execPath,
        pathValue: '/usr/bin:/bin',
        home,
        platform: 'linux',
        commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        environment: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          XDG_RUNTIME_DIR: 'relative/runtime',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
          GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890'
        }
      }),
      /XDG_RUNTIME_DIR must be absolute/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
