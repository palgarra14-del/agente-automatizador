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


const upgradeEnvironment = (home) => ({ PATH: '/tmp/untrusted:/usr/bin', HOME: home, GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890' });
const upgradeOptions = (home, root, runner, stateLoader = async () => ({})) => ({
  repositoryRoot: root,
  expectedRepository: 'palgarra14-del/agente-automatizador',
  stateLoader,
  home,
  commandRunner: runner,
  environment: upgradeEnvironment(home)
});

function upgradeFixtureRunner({ root, oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40), ciSuccess = true, failFirstNpm = false, unsafeGitConfig = '' } = {}) {
  const calls = [];
  let npmCalls = 0;
  let head = oldSha;
  const result = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' });
  const runner = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'systemctl') {
      if (args[1] === 'is-enabled') return result('enabled\n');
      if (args[1] === 'is-active') return result('active\n');
      return result();
    }
    if (command === 'git') {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return result(root + '\n');
      if (key === 'rev-parse --absolute-git-dir') return result(join(root, '.git') + '\n');
      if (key.startsWith('config --get-regexp ')) return unsafeGitConfig ? result(unsafeGitConfig) : result('', 1);
      if (args.includes('fetch')) {
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(options.env.GIT_ASKPASS, '/bin/false');
        assert.equal(options.env.SSH_ASKPASS, '/bin/false');
        assert.equal(options.env.GCM_INTERACTIVE, 'Never');
        assert.ok(args.includes('credential.helper='));
        assert.ok(args.includes('credential.https://github.com.helper=!gh auth git-credential'));
        assert.ok(args.includes('http.sslVerify=true'));
        assert.ok(args.includes('http.https://github.com/.sslVerify=true'));
      }
      if (key === 'branch --show-current') return result('main\n');
      if (key === 'status --porcelain=v1 --untracked-files=normal') return result();
      if (key === 'remote get-url origin') return result('https://github.com/palgarra14-del/agente-automatizador.git\n');
      if (key === 'rev-parse HEAD') return result(head + '\n');
      if (key === 'rev-parse refs/remotes/origin/main') return result(newSha + '\n');
      if (key === `merge-base --is-ancestor ${oldSha} ${newSha}`) return result();
      if (key === `rev-list --first-parent --reverse ${oldSha}..${newSha}`) return result(newSha + '\n');
      if (args.includes('merge')) { head = newSha; return result(); }
      if (args.includes('reset')) { head = oldSha; return result(); }
      return result();
    }
    if (command === 'gh') {
      assert.equal(options.env.GH_HOST, 'github.com');
      const endpoint = args[1];
      if (endpoint.includes('/branches/main')) return result(JSON.stringify({ commit: { sha: newSha } }));
      if (endpoint.includes(`commits/${newSha}/pulls`)) return result(JSON.stringify([{ merged_at: '2026-09-13T00:00:00Z', merge_commit_sha: newSha, base: { ref: 'main' }, head: { sha: 'c'.repeat(40) } }]));
      if (endpoint.includes('/actions/runs?')) return result(JSON.stringify({ workflow_runs: ciSuccess ? [{ name: 'CI', event: 'pull_request', head_sha: 'c'.repeat(40), conclusion: 'success' }] : [] }));
    }
    if (command === 'npm') {
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      npmCalls += 1;
      return failFirstNpm && npmCalls === 1 ? result('', 1) : result();
    }
    if (command === process.execPath) assert.match(options.env.GITHUB_TOKEN ?? '', /^gho_/);
    return result(command === process.execPath ? '{}\n' : '');
  };
  return { runner, calls, oldSha, newSha };
}

async function prepareManagedUpgradeService(home, root) {
  const dir = join(home, '.config', 'systemd', 'user');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INBOX_SERVICE_NAME), renderInboxServiceUnit({ repositoryRoot: root, nodePath: process.execPath, home }));
}

test('operator upgrade idle gate treats only live work as active', () => {
  assert.throws(() => assertOperatorUpgradeIdleState({ requests: { a: { status: 'running', issueNumber: 42 } } }), /operator_upgrade_active_request:42/);
  assert.throws(() => assertOperatorUpgradeIdleState({ workflows: { w: { id: 'w', status: 'awaiting_approval' } } }), /operator_upgrade_active_workflow:w/);
  assert.equal(assertOperatorUpgradeIdleState({ workflows: { w: { status: 'blocked' } }, requests: { a: { status: 'rejected' } }, runs: { r: { status: 'failed' } } }), true);
});

test('operator upgrade lease rejects a concurrent live upgrader before external work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-lease-'));
  const directory = join(home, '.config', 'engineering-orchestrator');
  const calls = [];
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'operator-upgrade.lock'), JSON.stringify({ leaseId: 'live', pid: process.pid, createdAt: new Date().toISOString(), ownerIdentity: null }));
    await assert.rejects(upgradeInboxService({ ...upgradeOptions(home, '/tmp/unused', async (command, args) => { calls.push([command, ...args]); return { exitCode: 0, stdout: '', stderr: '' }; }) }), /operator_upgrade_in_progress/);
    assert.deepEqual(calls, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('operator upgrade verifies GitHub review and CI before exact fast-forward', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-ok-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const fixture = upgradeFixtureRunner({ root });
    const result = await upgradeInboxService(upgradeOptions(home, root, fixture.runner));
    assert.deepEqual([result.upgraded, result.from, result.to, result.commits], [true, fixture.oldSha, fixture.newSha, 1]);
    const stop = fixture.calls.findIndex((call) => call.join(' ') === `systemctl --user stop ${INBOX_SERVICE_NAME}`);
    const ci = fixture.calls.findIndex((call) => call[0] === 'gh' && call.join(' ').includes('/actions/runs?'));
    const merge = fixture.calls.findIndex((call) => call[0] === 'git' && call.includes('merge'));
    assert.ok(ci >= 0 && stop > ci && merge > stop);
    assert.ok(fixture.calls.some((call) => call[0] === 'git' && call.includes('core.hooksPath=/dev/null') && call.includes(fixture.newSha)));
    assert.ok(fixture.calls.some((call) => call[0] === 'npm' && call.slice(1).join(' ') === 'ci --ignore-scripts'));
    assert.ok(fixture.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('operator upgrade closes watcher race before Git mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-race-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-race-repo-'));
  let reads = 0;
  try {
    await prepareManagedUpgradeService(home, root);
    const fixture = upgradeFixtureRunner({ root });
    const stateLoader = async () => (++reads === 1 ? {} : { requests: { q: { status: 'running', issueNumber: 42 } } });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, fixture.runner, stateLoader)), /operator_upgrade_active_request:42/);
    assert.equal(fixture.calls.some((call) => call[0] === 'git' && call.includes('merge')), false);
    assert.ok(fixture.calls.some((call) => call.join(' ') === `systemctl --user restart ${INBOX_SERVICE_NAME}`));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('operator upgrade rejects unverified CI and rolls back failed dependency refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-fail-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-fail-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const unsafeTls = upgradeFixtureRunner({ root, unsafeGitConfig: 'http.https://github.com/.sslCAInfo /tmp/attacker-ca.pem\n' });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, unsafeTls.runner)), /operator_upgrade_unsafe_git_transport_config/);
    assert.equal(unsafeTls.calls.some((call) => call.includes('fetch')), false);

    const unverified = upgradeFixtureRunner({ root, ciSuccess: false });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, unverified.runner)), /operator_upgrade_ci_not_verified/);
    assert.equal(unverified.calls.some((call) => call[1] === 'stop'), false);

    const rollback = upgradeFixtureRunner({ root, failFirstNpm: true });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, rollback.runner)), /operator_upgrade_command_failed:npm:ci/);
    assert.ok(rollback.calls.some((call) => call[0] === 'git' && call.includes('reset') && call.includes(rollback.oldSha)));
    assert.ok(rollback.calls.filter((call) => call[0] === 'npm').length >= 2);
    assert.ok(rollback.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
