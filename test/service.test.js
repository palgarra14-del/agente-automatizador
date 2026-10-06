import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_UPGRADE_SERVICE_NAME,
  AUTO_UPGRADE_TIMER_NAME,
  INBOX_SERVICE_NAME,
  assertOperatorUpgradeIdleState,
  autoUpgradeInboxService,
  autoUpgradeTimerStatus,
  ensureGitHubToken,
  installInboxService,
  readCheckoutRevision,
  renderAutoUpgradeServiceUnit,
  renderAutoUpgradeTimerUnit,
  renderInboxServiceUnit,
  restartInboxService,
  serviceStatus,
  syncAutoUpgradeTimer,
  syncInboxService,
  uninstallAutoUpgradeTimer,
  uninstallInboxService,
  upgradeInboxService,
  UPGRADE_UNSAFE_GIT_CONFIG_PATTERN
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

test('checkout revision probe is local, bounded, and receives no GitHub secret', async () => {
  const secret = 'gho_abcdefghijklmnopqrstuvwxyz1234567890';
  const revision = 'A'.repeat(40);
  const calls = [];
  const result = await readCheckoutRevision({
    repositoryRoot: '/home/pablo/projects/agente-automatizador',
    environment: {
      PATH: '/usr/bin:/bin',
      HOME: '/home/pablo',
      LANG: 'C.UTF-8',
      GITHUB_TOKEN: secret
    },
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: revision + '\n', stderr: '' };
    }
  });
  assert.equal(result, revision.toLowerCase());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', '--verify', 'HEAD']);
  assert.equal(calls[0].options.cwd, '/home/pablo/projects/agente-automatizador');
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
  assert.equal(JSON.stringify(calls[0].options).includes(secret), false);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.maxOutputBytes, 512);

  await assert.rejects(
    readCheckoutRevision({
      repositoryRoot: '/repo',
      commandRunner: async () => ({ exitCode: 0, stdout: 'not-a-sha\n', stderr: '' }),
      environment: { PATH: '/usr/bin', HOME: '/home/pablo' }
    }),
    /service_checkout_revision_unavailable/
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
      MODEL_COST_POLICY: 'subscription_included',
      ANTIGRAVITY_CLI: '/home/pablo/.local/bin/agy',
      CODEX_BIN: '/usr/bin/codex',
      OPENCODE_BIN: '/usr/bin/opencode',
      OPENCODE_FREE_TIMEOUT: '90',
      GITHUB_TOKEN: 'must-never-be-rendered',
      OPENAI_API_KEY: 'must-never-be-rendered',
      CODEX_API_KEY: 'must-never-be-rendered',
      PAID_MODELS_EXPLICITLY_ENABLED: '1'
    }
  });
  assert.match(unit, /managed-by=engineering-orchestrator:v1/);
  assert.match(unit, /ExecStart=.*src\/cli\.js.*inbox watch/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/home\/pablo\/\.nvm\/versions\/node\/v22\.23\.2\/bin/);
  assert.match(unit, /GH_CONFIG_DIR=\/home\/pablo\/\.config\/gh-custom/);
  assert.match(unit, /CODEX_HOME=\/home\/pablo\/\.codex-custom/);
  assert.match(unit, /MODEL_COST_POLICY=subscription_included/);
  assert.match(unit, /ANTIGRAVITY_CLI=\/home\/pablo\/\.local\/bin\/agy/);
  assert.match(unit, /CODEX_BIN=\/usr\/bin\/codex/);
  assert.match(unit, /OPENCODE_BIN=\/usr\/bin\/opencode/);
  assert.match(unit, /OPENCODE_FREE_TIMEOUT=90/);
  assert.doesNotMatch(unit, /\/tmp\/untrusted-bin|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|PAID_MODELS_EXPLICITLY_ENABLED|must-never-be-rendered|gho_|ghp_/);
});

test('auto-upgrade units are bounded, persistent, and never persist GitHub credentials', () => {
  const secret = 'gho_abcdefghijklmnopqrstuvwxyz1234567890';
  const service = renderAutoUpgradeServiceUnit({
    repositoryRoot: '/home/pablo/projects/agente-automatizador',
    nodePath: '/home/pablo/.nvm/versions/node/v22.23.2/bin/node',
    home: '/home/pablo',
    environment: {
      GH_CONFIG_DIR: '/home/pablo/.config/gh',
      CODEX_HOME: '/home/pablo/.codex',
      GITHUB_TOKEN: secret
    }
  });
  const timer = renderAutoUpgradeTimerUnit();

  assert.match(service, /managed-by=engineering-orchestrator:v1/);
  assert.match(service, /Type=oneshot/);
  assert.match(service, /service auto-upgrade/);
  assert.doesNotMatch(service, /GITHUB_TOKEN|gho_|ghp_|abcdefghijklmnopqrstuvwxyz/);
  assert.match(service, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/home\/pablo\/\.nvm\/versions\/node\/v22\.23\.2\/bin/);

  assert.match(timer, /managed-by=engineering-orchestrator:v1/);
  assert.match(timer, /OnBootSec=2min/);
  assert.match(timer, /OnUnitActiveSec=2min/);
  assert.match(timer, /RandomizedDelaySec=20s/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, new RegExp(`Unit=${AUTO_UPGRADE_SERVICE_NAME.replaceAll('.', '\\.')}\\b`));
  assert.doesNotMatch(timer, /GITHUB_TOKEN|gho_|ghp_/);
});

test('auto-upgrade timer sync is managed, idempotent, and removable without touching foreign units', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-auto-upgrade-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-auto-upgrade-repo-'));
  const pathValue = '/usr/bin:/bin';
  const states = new Map();
  const calls = [];
  const result = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' });
  const unitFromArgs = (args) => args.find((value) => typeof value === 'string' && value.endsWith('.service') || typeof value === 'string' && value.endsWith('.timer'));
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    assert.equal(command, 'systemctl');
    const action = args[1];
    const unit = unitFromArgs(args);
    if (action === 'enable') {
      const current = states.get(unit) ?? {};
      states.set(unit, { ...current, enabled: true, active: args.includes('--now') ? true : current.active ?? false });
      return result();
    }
    if (action === 'disable') {
      const current = states.get(unit) ?? {};
      states.set(unit, { ...current, enabled: false, active: args.includes('--now') ? false : current.active ?? false });
      return result();
    }
    if (action === 'stop') {
      const current = states.get(unit) ?? {};
      states.set(unit, { ...current, active: false });
      return result();
    }
    if (action === 'is-enabled') {
      const enabled = states.get(unit)?.enabled === true;
      return result(enabled ? 'enabled\n' : 'disabled\n', enabled ? 0 : 1);
    }
    if (action === 'is-active') {
      const active = states.get(unit)?.active === true;
      return result(active ? 'active\n' : 'inactive\n', active ? 0 : 3);
    }
    return result();
  };

  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');

    const first = await syncAutoUpgradeTimer({
      repositoryRoot,
      nodePath: process.execPath,
      pathValue,
      home,
      platform: 'linux',
      commandRunner: runner,
      environment: { PATH: pathValue, HOME: home, GITHUB_TOKEN: 'must-not-persist' }
    });
    assert.equal(first.installed, true);
    assert.equal(first.enabled, true);
    assert.equal(first.active, true);
    assert.equal(first.changed, true);

    const serviceUnit = await readFile(first.serviceUnitPath, 'utf8');
    const timerUnit = await readFile(first.timerUnitPath, 'utf8');
    assert.equal(serviceUnit.includes('must-not-persist'), false);
    assert.equal(timerUnit.includes('must-not-persist'), false);

    const second = await syncAutoUpgradeTimer({
      repositoryRoot,
      nodePath: process.execPath,
      pathValue,
      home,
      platform: 'linux',
      commandRunner: runner,
      environment: { PATH: pathValue, HOME: home }
    });
    assert.equal(second.changed, false);

    const status = await autoUpgradeTimerStatus({ home, pathValue, commandRunner: runner });
    assert.equal(status.enabled, true);
    assert.equal(status.active, true);

    const removed = await uninstallAutoUpgradeTimer({ home, pathValue, commandRunner: runner });
    assert.equal(removed.removed, true);
    assert.equal((await autoUpgradeTimerStatus({ home, pathValue, commandRunner: runner })).installed, false);
    assert.ok(calls.some((entry) => entry.join(' ') === `systemctl --user disable --now ${AUTO_UPGRADE_TIMER_NAME}`));

    await writeFile(removed.timerUnitPath, '[Unit]\nDescription=foreign\n');
    await assert.rejects(
      syncAutoUpgradeTimer({
        repositoryRoot,
        nodePath: process.execPath,
        pathValue,
        home,
        platform: 'linux',
        commandRunner: runner,
        environment: { PATH: pathValue, HOME: home }
      }),
      /service_unit_not_managed_by_agent/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('auto-upgrade timer rolls back its managed files if enablement fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-auto-upgrade-rollback-home-'));
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-auto-upgrade-rollback-repo-'));
  const pathValue = '/usr/bin:/bin';
  const result = (stdout = '', exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr });
  const runner = async (command, args) => {
    assert.equal(command, 'systemctl');
    if (args[1] === 'enable' && args.includes(AUTO_UPGRADE_TIMER_NAME)) return result('', 1, 'fixture failure');
    return result();
  };
  try {
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
    await assert.rejects(
      syncAutoUpgradeTimer({
        repositoryRoot,
        nodePath: process.execPath,
        pathValue,
        home,
        platform: 'linux',
        commandRunner: runner,
        environment: { PATH: pathValue, HOME: home }
      }),
      /systemd_user_command_failed:enable/
    );
    const status = await autoUpgradeTimerStatus({ home, pathValue, commandRunner: runner });
    assert.equal(status.installed, false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
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


const upgradeEnvironment = (home) => ({
  PATH: '/tmp/untrusted:/usr/bin',
  HOME: home,
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  GITHUB_TOKEN: 'gho_abcdefghijklmnopqrstuvwxyz1234567890',
  ORCHESTRATOR_TEST_SECRET: 'must-not-cross-upgrade-boundary'
});
const upgradeOptions = (home, root, runner, stateLoader = async () => ({})) => ({
  repositoryRoot: root,
  expectedRepository: 'palgarra14-del/agente-automatizador',
  stateLoader,
  home,
  commandRunner: runner,
  environment: upgradeEnvironment(home)
});

function upgradeFixtureRunner({ root, oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40), ciSuccess = true, dependencyChanged = false, failFirstNpm = false, failAllNpm = false, unsafeGitConfig = '' } = {}) {
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
      if (key.startsWith('config --get-regexp ')) {
        assert.match(key, /insteadof/);
        assert.match(key, /sshcommand/);
        assert.match(key, /sslverify/);
        assert.match(key, /sslcainfo/);
        assert.doesNotMatch(key, /insteadOf|sshCommand|sslVerify|sslCAInfo/);
        return unsafeGitConfig ? result(unsafeGitConfig) : result('', 1);
      }
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
      if (key === `diff --name-only ${oldSha} ${newSha} -- package.json package-lock.json npm-shrinkwrap.json`) {
        return result(dependencyChanged ? 'package-lock.json\n' : '');
      }
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
      return failAllNpm || (failFirstNpm && npmCalls === 1) ? result('', 1) : result();
    }
    if (command === process.execPath) {
      assert.match(options.env.GITHUB_TOKEN ?? '', /^gho_/);
      assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1000');
      assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
      assert.equal(options.env.ORCHESTRATOR_TEST_SECRET, undefined);
    }
    return result(command === process.execPath ? '{}\n' : '');
  };
  return { runner, calls, oldSha, newSha };
}

async function prepareManagedUpgradeService(home, root) {
  const dir = join(home, '.config', 'systemd', 'user');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INBOX_SERVICE_NAME), renderInboxServiceUnit({ repositoryRoot: root, nodePath: process.execPath, home }));
}

test('automatic upgrade treats busy state as a benign skip but preserves real failures', async () => {
  const skipped = await autoUpgradeInboxService({
    platform: 'linux',
    repositoryRoot: '/unused',
    expectedRepository: 'palgarra14-del/agente-automatizador',
    stateLoader: async () => ({ requests: { r: { status: 'running', issueNumber: 68 } } }),
    home: '/tmp/unused-auto-upgrade-home',
    commandRunner: async () => {
      throw new Error('external work must not occur while busy');
    },
    environment: { PATH: '/usr/bin', HOME: '/tmp' }
  });
  assert.equal(skipped.upgraded, false);
  assert.equal(skipped.skipped, 'operator_upgrade_active_request:68');

  await assert.rejects(
    autoUpgradeInboxService({
      platform: 'win32',
      repositoryRoot: '/unused',
      expectedRepository: 'palgarra14-del/agente-automatizador',
      stateLoader: async () => ({})
    }),
    /persistent_inbox_service_requires_linux_systemd/
  );
});

test('operator upgrade rejects a relative systemd runtime directory before external work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-invalid-bus-'));
  const calls = [];
  try {
    await assert.rejects(
      upgradeInboxService({
        repositoryRoot: '/unused',
        expectedRepository: 'palgarra14-del/agente-automatizador',
        stateLoader: async () => ({}),
        home,
        platform: 'linux',
        commandRunner: async (command, args) => {
          calls.push([command, ...args]);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
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
    assert.equal(calls.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('operator upgrade unsafe Git config pattern is accepted by real git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-git-config-regex-'));
  const configFile = join(directory, 'empty.gitconfig');
  try {
    await writeFile(configFile, '');
    const result = spawnSync('git', ['config', '--file', configFile, '--get-regexp', UPGRADE_UNSAFE_GIT_CONFIG_PATTERN], {
      encoding: 'utf8'
    });
    assert.ok([0, 1].includes(result.status), `git rejected upgrade regex with exit ${result.status}: ${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    assert.equal(fixture.calls.some((call) => call[0] === 'npm'), false);
    assert.ok(fixture.calls.some((call) => call[0] === 'git' && call[1] === 'diff' && call.includes('package-lock.json')));
    assert.ok(fixture.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('operator upgrade refreshes dependencies only when dependency control files changed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-upgrade-deps-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-upgrade-deps-repo-'));
  try {
    await prepareManagedUpgradeService(home, root);
    const fixture = upgradeFixtureRunner({ root, dependencyChanged: true });
    const result = await upgradeInboxService(upgradeOptions(home, root, fixture.runner));
    assert.equal(result.upgraded, true);
    assert.equal(fixture.calls.filter((call) => call[0] === 'npm').length, 1);
    assert.ok(fixture.calls.some((call) => call[0] === 'npm' && call.slice(1).join(' ') === 'ci --ignore-scripts'));
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
    const unsafeTls = upgradeFixtureRunner({ root, unsafeGitConfig: 'http.https://github.com/.sslcainfo /tmp/attacker-ca.pem\n' });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, unsafeTls.runner)), /operator_upgrade_unsafe_git_transport_config/);
    assert.equal(unsafeTls.calls.some((call) => call.includes('fetch')), false);

    const unverified = upgradeFixtureRunner({ root, ciSuccess: false });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, unverified.runner)), /operator_upgrade_ci_not_verified/);
    assert.equal(unverified.calls.some((call) => call[1] === 'stop'), false);

    const rollback = upgradeFixtureRunner({ root, dependencyChanged: true, failFirstNpm: true });
    await assert.rejects(upgradeInboxService(upgradeOptions(home, root, rollback.runner)), /operator_upgrade_dependency_refresh_failed/);
    assert.ok(rollback.calls.some((call) => call[0] === 'git' && call.includes('reset') && call.includes(rollback.oldSha)));
    assert.equal(rollback.calls.filter((call) => call[0] === 'npm').length, 2);
    assert.ok(rollback.calls.some((call) => call[0] === process.execPath && call.at(-2) === 'service' && call.at(-1) === 'sync'));

    const brokenRollback = upgradeFixtureRunner({ root, dependencyChanged: true, failAllNpm: true });
    await assert.rejects(
      upgradeInboxService(upgradeOptions(home, root, brokenRollback.runner)),
      /operator_upgrade_failed_rollback_incomplete:stage=dependencies:primary=operator_upgrade_dependency_refresh_failed:rollback=operator_upgrade_command_failed:npm:ci/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
