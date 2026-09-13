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
  uninstallInboxService,
  assertOperatorUpgradeIdleState,
  upgradeInboxService
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
  assert.match(unit, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/home\/pablo\/\.nvm\/versions\/node\/v22\.23\.2\/bin/);
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

test('service sync rolls back first-install enablement when restart fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-service-sync-rollback-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-sync-rollback-repo-'));
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh') return { exitCode: 0, stdout: 'gho_abcdefghijklmnopqrstuvwxyz1234567890\n', stderr: '' };
    const action = args[1];
    if (action === 'restart') return { exitCode: 1, stdout: '', stderr: 'failed' };
    return { exitCode: 0, stdout: action === 'is-enabled' ? 'enabled\n' : action === 'is-active' ? 'active\n' : '', stderr: '' };
  };
  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
    await assert.rejects(
      syncInboxService({
        repositoryRoot,
        nodePath: process.execPath,
        pathValue: '/usr/bin:/bin',
        home,
        platform: 'linux',
        commandRunner: runner,
        environment: { PATH: '/usr/bin:/bin', HOME: home }
      }),
      /systemd_user_command_failed:restart/
    );
    assert.ok(calls.some((entry) => entry.join(' ') === `systemctl --user disable --now ${INBOX_SERVICE_NAME}`));
    assert.equal((await serviceStatus({ home, pathValue: '/usr/bin:/bin', commandRunner: runner })).installed, false);
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


function upgradeFixtureRunner({ root, oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40), ciSuccess = true, failFirstNpm = false } = {}) {
  const calls = [];
  let npmCalls = 0;
  let head = oldSha;
  const runner = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'systemctl') {
      const action = args[1];
      if (action === 'is-enabled') return { exitCode: 0, stdout: 'enabled\n', stderr: '' };
      if (action === 'is-active') return { exitCode: 0, stdout: 'active\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'git') {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: root + '\n', stderr: '' };
      if (key === 'rev-parse --absolute-git-dir') return { exitCode: 0, stdout: join(root, '.git') + '\n', stderr: '' };
      if (key.startsWith('config --get-regexp ')) return { exitCode: 1, stdout: '', stderr: '' };
      if (key === 'branch --show-current') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (key === 'status --porcelain=v1 --untracked-files=normal') return { exitCode: 0, stdout: '', stderr: '' };
      if (key === 'remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/palgarra14-del/agente-automatizador.git\n', stderr: '' };
      if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: head + '\n', stderr: '' };
      if (key === 'rev-parse refs/remotes/origin/main') return { exitCode: 0, stdout: newSha + '\n', stderr: '' };
      if (key === `merge-base --is-ancestor ${oldSha} ${newSha}`) return { exitCode: 0, stdout: '', stderr: '' };
      if (key === `rev-list --first-parent --reverse ${oldSha}..${newSha}`) return { exitCode: 0, stdout: newSha + '\n', stderr: '' };
      if (args.includes('merge')) { head = newSha; return { exitCode: 0, stdout: '', stderr: '' }; }
      if (args.includes('reset')) { head = oldSha; return { exitCode: 0, stdout: '', stderr: '' }; }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'gh') {
      assert.equal(options.env.GH_HOST, 'github.com');
      const endpoint = args[1];
      if (endpoint.includes('/branches/main')) return { exitCode: 0, stdout: JSON.stringify({ commit: { sha: newSha } }), stderr: '' };
      if (endpoint.includes(`commits/${newSha}/pulls`)) {
        return { exitCode: 0, stdout: JSON.stringify([{ merged_at: '2026-09-13T00:00:00Z', merge_commit_sha: newSha, base: { ref: 'main' }, head: { sha: 'c'.repeat(40) } }]), stderr: '' };
      }
      if (endpoint.includes('/actions/runs?')) {
        return { exitCode: 0, stdout: JSON.stringify({ workflow_runs: ciSuccess ? [{ name: 'CI', event: 'pull_request', head_sha: 'c'.repeat(40), conclusion: 'success' }] : [] }), stderr: '' };
      }
    }
    if (command === 'npm') {
      npmCalls += 1;
      if (failFirstNpm && npmCalls === 1) return { exitCode: 1, stdout: '', stderr: 'failed' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === process.execPath) return { exitCode: 0, stdout: '{}\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls, oldSha, newSha };
}

async function prepareManagedUpgradeService(home, root) {
  const dir = join(home, '.config', 'systemd', 'user');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INBOX_SERVICE_NAME), renderInboxServiceUnit({ repositoryRoot: root, nodePath: process.execPath, home }));
}

test('operator upgrade refuses active work before touching Git or systemd', () => {
  assert.throws(() => assertOperatorUpgradeIdleState({ requests: { a: { status: 'running', issueNumber: 42 } } }), /operator_upgrade_active_request:42/);
  assert.throws(() => assertOperatorUpgradeIdleState({ workflows: { w: { id: 'w', status: 'awaiting_approval' } } }), /operator_upgrade_active_workflow:w/);
  assert.equal(assertOperatorUpgradeIdleState({ runs: { r: { id: 'r', status: 'failed' } }, requests: { a: { status: 'rejected' } } }), true);
});

test('operator upgrade lease rejects a concurrent live upgrader before external work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-lease-home-'));
  const lockDirectory = join(home, '.config', 'engineering-orchestrator');
  const calls = [];
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(join(lockDirectory, 'operator-upgrade.lock'), JSON.stringify({
      leaseId: 'live-upgrade',
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownerIdentity: null
    }));
    await assert.rejects(
      upgradeInboxService({
        repositoryRoot: '/tmp/unused',
        expectedRepository: 'palgarra14-del/agente-automatizador',
        stateLoader: async () => ({}),
        home,
        commandRunner: async (command, args) => {
          calls.push([command, ...args]);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      }),
      /operator_upgrade_in_progress/
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('operator upgrade verifies reviewed CI commits before fast-forwarding and restarting the new service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-home-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const fixture = upgradeFixtureRunner({ root });
    const result = await upgradeInboxService({
      repositoryRoot: root,
      expectedRepository: 'palgarra14-del/agente-automatizador',
      stateLoader: async () => ({ runs: {}, workflows: {}, requests: {} }),
      home,
      pathValue: '/usr/bin:/bin',
      commandRunner: fixture.runner,
      environment: { PATH: '/usr/bin:/bin', HOME: home, GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890' }
    });
    assert.equal(result.upgraded, true);
    assert.equal(result.from, fixture.oldSha);
    assert.equal(result.to, fixture.newSha);
    assert.equal(result.commits, 1);
    const stopIndex = fixture.calls.findIndex((call) => call.join(' ') === `systemctl --user stop ${INBOX_SERVICE_NAME}`);
    const ciIndex = fixture.calls.findIndex((call) => call[0] === 'gh' && call.join(' ').includes('/actions/runs?'));
    const mergeIndex = fixture.calls.findIndex((call) => call[0] === 'git' && call.includes('merge'));
    assert.ok(ciIndex >= 0 && stopIndex > ciIndex && mergeIndex > stopIndex);
    assert.ok(fixture.calls.some((call) => call[0] === 'npm' && call[1] === 'ci' && call[2] === '--ignore-scripts'));
    assert.ok(fixture.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('operator upgrade closes the watcher TOCTOU window before changing Git', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-race-home-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-race-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const fixture = upgradeFixtureRunner({ root });
    let reads = 0;
    await assert.rejects(
      upgradeInboxService({
        repositoryRoot: root,
        expectedRepository: 'palgarra14-del/agente-automatizador',
        stateLoader: async () => {
          reads += 1;
          return reads === 1 ? {} : { requests: { q: { status: 'running', issueNumber: 42 } } };
        },
        home,
        commandRunner: fixture.runner,
        environment: { PATH: '/tmp/untrusted:/usr/bin', HOME: home, GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890' }
      }),
      /operator_upgrade_active_request:42/
    );
    assert.equal(fixture.calls.some((call) => call[0] === 'git' && call.includes('merge')), false);
    assert.ok(fixture.calls.some((call) => call.join(' ') === `systemctl --user stop ${INBOX_SERVICE_NAME}`));
    assert.ok(fixture.calls.some((call) => call.join(' ') === `systemctl --user restart ${INBOX_SERVICE_NAME}`));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('operator upgrade fails closed on unverified CI and rolls back a failed local dependency refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-fail-home-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-fail-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const unverified = upgradeFixtureRunner({ root, ciSuccess: false });
    await assert.rejects(
      upgradeInboxService({
        repositoryRoot: root,
        expectedRepository: 'palgarra14-del/agente-automatizador',
        stateLoader: async () => ({}),
        home,
        pathValue: '/usr/bin:/bin',
        commandRunner: unverified.runner,
        environment: { PATH: '/usr/bin:/bin', HOME: home, GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890' }
      }),
      /operator_upgrade_ci_not_verified/
    );
    assert.equal(unverified.calls.some((call) => call.join(' ') === `systemctl --user stop ${INBOX_SERVICE_NAME}`), false);

    const rollback = upgradeFixtureRunner({ root, failFirstNpm: true });
    await assert.rejects(
      upgradeInboxService({
        repositoryRoot: root,
        expectedRepository: 'palgarra14-del/agente-automatizador',
        stateLoader: async () => ({}),
        home,
        pathValue: '/usr/bin:/bin',
        commandRunner: rollback.runner,
        environment: { PATH: '/usr/bin:/bin', HOME: home, GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890' }
      }),
      /operator_upgrade_command_failed:npm:ci/
    );
    assert.ok(rollback.calls.some((call) => call[0] === 'git' && call.includes('reset') && call.includes('--hard') && call.includes(rollback.oldSha)));
    assert.ok(rollback.calls.filter((call) => call[0] === 'npm').length >= 2);
    assert.ok(rollback.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
