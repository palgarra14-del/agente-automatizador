import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const INBOX_SERVICE_NAME = 'engineering-orchestrator-inbox.service';
const managedMarker = '# managed-by=engineering-orchestrator:v1';

function validateText(value, label) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function systemdQuote(value) {
  return `"${validateText(value, 'systemd value').replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function minimalGhEnvironment(environment) {
  const allowed = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));
}

function trustedServicePath(nodePath) {
  return [...new Set(['/usr/local/bin', '/usr/bin', '/bin', dirname(resolve(nodePath))])].join(':');
}

function serviceRuntimeEnvironment(environment = {}) {
  const result = {};
  for (const name of ['XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'CODEX_HOME', 'LANG', 'LC_ALL']) {
    const value = environment[name];
    if (value === undefined) continue;
    const text = validateText(String(value), name);
    if (['XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'CODEX_HOME'].includes(name) && !isAbsolute(text)) throw new Error(`${name} must be absolute`);
    result[name] = text;
  }
  return result;
}

export function runLocalCommand(command, args, { cwd, env, timeoutMs = 15_000, maxOutputBytes = 16_384 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const append = (current, chunk) => {
      if (current.byteLength >= maxOutputBytes) return current;
      return Buffer.concat([current, chunk.subarray(0, maxOutputBytes - current.byteLength)]);
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode: exitCode ?? 1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

export async function ensureGitHubToken({ environment = process.env, commandRunner = runLocalCommand, home = homedir() } = {}) {
  const existing = environment.GITHUB_TOKEN;
  if (typeof existing === 'string' && existing.trim()) return { source: 'environment' };
  let result;
  try {
    result = await commandRunner('gh', ['auth', 'token'], {
      cwd: home,
      env: minimalGhEnvironment(environment),
      timeoutMs: 10_000,
      maxOutputBytes: 8_192
    });
  } catch {
    throw new Error('github_cli_auth_required');
  }
  const token = String(result.stdout ?? '').trim();
  if (result.exitCode !== 0 || token.length < 20 || token.length > 4_096 || /\s/.test(token)) throw new Error('github_cli_auth_required');
  environment.GITHUB_TOKEN = token;
  return { source: 'gh' };
}

export function renderInboxServiceUnit({ repositoryRoot, nodePath, home = homedir(), environment = {} }) {
  const rawRoot = validateText(repositoryRoot, 'repositoryRoot');
  const rawNode = validateText(nodePath, 'nodePath');
  if (!isAbsolute(rawRoot) || !isAbsolute(rawNode)) throw new Error('service paths must be absolute');
  const root = resolve(rawRoot);
  const node = resolve(rawNode);
  const cli = join(root, 'src', 'cli.js');
  const runtimeEnvironment = serviceRuntimeEnvironment(environment);
  const environmentLines = Object.entries(runtimeEnvironment).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`);
  return [
    managedMarker,
    '[Unit]',
    'Description=Engineering Orchestrator supervised inbox',
    'After=default.target',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=10',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdQuote(root)}`,
    `ExecStart=${systemdQuote(node)} ${systemdQuote(cli)} inbox watch`,
    `Environment=${systemdQuote(`PATH=${trustedServicePath(node)}`)}`,
    `Environment=${systemdQuote(`HOME=${resolve(home)}`)}`,
    ...environmentLines,
    'Restart=always',
    'RestartSec=3',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=15',
    'UMask=0077',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function servicePaths(home) {
  const unitDirectory = join(resolve(home), '.config', 'systemd', 'user');
  return { unitDirectory, unitPath: join(unitDirectory, INBOX_SERVICE_NAME) };
}

async function assertManagedOrMissing(unitPath) {
  try {
    const info = await lstat(unitPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('service_unit_must_be_regular_file');
    const content = await readFile(unitPath, 'utf8');
    if (!content.startsWith(managedMarker)) throw new Error('service_unit_not_managed_by_agent');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function systemdUserCommandEnvironment({ home, pathValue, environment = process.env }) {
  const result = { PATH: pathValue, HOME: home };
  const runtimeDir = environment.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined) {
    const value = validateText(String(runtimeDir), 'XDG_RUNTIME_DIR');
    if (!isAbsolute(value)) throw new Error('XDG_RUNTIME_DIR must be absolute');
    result.XDG_RUNTIME_DIR = value;
  }
  const busAddress = environment.DBUS_SESSION_BUS_ADDRESS;
  if (busAddress !== undefined) result.DBUS_SESSION_BUS_ADDRESS = validateText(String(busAddress), 'DBUS_SESSION_BUS_ADDRESS');
  return result;
}

async function systemctl(commandRunner, args, { home, pathValue, allowFailure = false, environment = process.env }) {
  const result = await commandRunner('systemctl', ['--user', ...args], {
    cwd: home,
    env: systemdUserCommandEnvironment({ home, pathValue, environment }),
    timeoutMs: 20_000,
    maxOutputBytes: 16_384
  });
  if (!allowFailure && result.exitCode !== 0) throw new Error(`systemd_user_command_failed:${args[0]}`);
  return result;
}

export async function installInboxService({
  repositoryRoot = process.cwd(),
  nodePath = process.execPath,
  pathValue = process.env.PATH ?? '',
  home = homedir(),
  platform = process.platform,
  commandRunner = runLocalCommand,
  environment = process.env
} = {}) {
  if (platform !== 'linux') throw new Error('persistent_inbox_service_requires_linux_systemd');
  await ensureGitHubToken({ environment, commandRunner, home });
  const cliPath = join(resolve(repositoryRoot), 'src', 'cli.js');
  const [cliInfo, nodeInfo] = await Promise.all([lstat(cliPath), lstat(resolve(nodePath))]);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error('service_cli_entrypoint_invalid');
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink() || (nodeInfo.mode & 0o111) === 0) throw new Error('service_node_entrypoint_invalid');
  const { unitDirectory, unitPath } = servicePaths(home);
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(unitDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('service_unit_directory_invalid');
  if (await assertManagedOrMissing(unitPath)) throw new Error('persistent_inbox_service_already_installed_use_restart');
  const unit = renderInboxServiceUnit({ repositoryRoot, nodePath, home, environment });
  const temporary = `${unitPath}.tmp-${process.pid}`;
  await writeFile(temporary, unit, { mode: 0o600, flag: 'wx' });
  await rename(temporary, unitPath);
  try {
    await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, environment });
    await systemctl(commandRunner, ['enable', '--now', INBOX_SERVICE_NAME], { home, pathValue, environment });
    const status = await serviceStatus({ home, pathValue, commandRunner, environment });
    if (!status.enabled || !status.active) throw new Error('persistent_inbox_service_failed_to_start');
    return status;
  } catch (error) {
    await systemctl(commandRunner, ['disable', '--now', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
    await rm(unitPath, { force: true });
    await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, allowFailure: true, environment });
    throw error;
  }
}

export async function syncInboxService({
  repositoryRoot = process.cwd(),
  nodePath = process.execPath,
  pathValue = process.env.PATH ?? '',
  home = homedir(),
  platform = process.platform,
  commandRunner = runLocalCommand,
  environment = process.env
} = {}) {
  if (platform !== 'linux') throw new Error('persistent_inbox_service_requires_linux_systemd');
  await ensureGitHubToken({ environment, commandRunner, home });
  const root = resolve(repositoryRoot);
  const cliPath = join(root, 'src', 'cli.js');
  const [cliInfo, nodeInfo] = await Promise.all([lstat(cliPath), lstat(resolve(nodePath))]);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error('service_cli_entrypoint_invalid');
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink() || (nodeInfo.mode & 0o111) === 0) throw new Error('service_node_entrypoint_invalid');

  const { unitDirectory, unitPath } = servicePaths(home);
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(unitDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('service_unit_directory_invalid');

  const existed = await assertManagedOrMissing(unitPath);
  const previous = existed ? await readFile(unitPath, 'utf8') : null;
  const previousStatus = existed ? await serviceStatus({ home, pathValue, commandRunner, environment }) : null;
  const unit = renderInboxServiceUnit({ repositoryRoot: root, nodePath, home, environment });
  const changed = previous !== unit;
  const temporary = `${unitPath}.tmp-${process.pid}`;

  try {
    if (changed) {
      await writeFile(temporary, unit, { mode: 0o600, flag: 'wx' });
      await rename(temporary, unitPath);
    }
    await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, environment });
    await systemctl(commandRunner, ['enable', INBOX_SERVICE_NAME], { home, pathValue, environment });
    await systemctl(commandRunner, ['restart', INBOX_SERVICE_NAME], { home, pathValue, environment });
    const status = await serviceStatus({ home, pathValue, commandRunner, environment });
    if (!status.enabled || !status.active) throw new Error('persistent_inbox_service_failed_to_start');
    return { ...status, changed };
  } catch (error) {
    await rm(temporary, { force: true });
    if (previous === null) {
      await systemctl(commandRunner, ['disable', '--now', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
      await rm(unitPath, { force: true });
      await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, allowFailure: true, environment });
    } else {
      if (changed) await writeFile(unitPath, previous, { mode: 0o600 });
      await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, allowFailure: true, environment });
      if (previousStatus.enabled) await systemctl(commandRunner, ['enable', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
      else await systemctl(commandRunner, ['disable', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
      if (previousStatus.active) await systemctl(commandRunner, ['restart', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
      else await systemctl(commandRunner, ['stop', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
    }
    throw error;
  }
}

export async function serviceStatus({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand, environment = process.env } = {}) {
  const { unitPath } = servicePaths(home);
  const installed = await assertManagedOrMissing(unitPath);
  if (!installed) return { service: INBOX_SERVICE_NAME, installed: false, enabled: false, active: false, unitPath };
  const enabled = await systemctl(commandRunner, ['is-enabled', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
  const active = await systemctl(commandRunner, ['is-active', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
  return {
    service: INBOX_SERVICE_NAME,
    installed: true,
    enabled: enabled.exitCode === 0 && enabled.stdout.trim() === 'enabled',
    active: active.exitCode === 0 && active.stdout.trim() === 'active',
    unitPath
  };
}

export async function restartInboxService({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand, environment = process.env } = {}) {
  const { unitPath } = servicePaths(home);
  if (!await assertManagedOrMissing(unitPath)) throw new Error('persistent_inbox_service_not_installed');
  await systemctl(commandRunner, ['restart', INBOX_SERVICE_NAME], { home, pathValue, environment });
  return serviceStatus({ home, pathValue, commandRunner, environment });
}

export async function uninstallInboxService({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand, environment = process.env } = {}) {
  const { unitPath } = servicePaths(home);
  if (!await assertManagedOrMissing(unitPath)) return { service: INBOX_SERVICE_NAME, installed: false, removed: false, unitPath };
  await systemctl(commandRunner, ['disable', '--now', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
  const active = await systemctl(commandRunner, ['is-active', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
  if (active.exitCode === 0 && active.stdout.trim() === 'active') throw new Error('persistent_inbox_service_still_active');
  await rm(unitPath, { force: true });
  await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, environment });
  await systemctl(commandRunner, ['reset-failed', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true, environment });
  return { service: INBOX_SERVICE_NAME, installed: false, removed: true, unitPath };
}


const terminalUpgradeRunStatuses = new Set(['completed', 'failed', 'cancelled']);
const terminalUpgradeWorkflowStatuses = new Set(['completed', 'failed', 'blocked']);
const terminalUpgradeRequestStatuses = new Set(['completed', 'failed', 'blocked', 'rejected']);

export function assertOperatorUpgradeIdleState(state = {}) {
  const activeRun = Object.values(state.runs ?? {}).find((entry) => entry && !terminalUpgradeRunStatuses.has(entry.status));
  if (activeRun) throw new Error(`operator_upgrade_active_run:${activeRun.id ?? 'unknown'}`);
  const activeWorkflow = Object.values(state.workflows ?? {}).find((entry) => entry && !terminalUpgradeWorkflowStatuses.has(entry.status));
  if (activeWorkflow) throw new Error(`operator_upgrade_active_workflow:${activeWorkflow.id ?? 'unknown'}`);
  const activeRequest = Object.values(state.requests ?? {}).find((entry) => entry && !terminalUpgradeRequestStatuses.has(entry.status));
  if (activeRequest) throw new Error(`operator_upgrade_active_request:${activeRequest.issueNumber ?? 'unknown'}`);
  return true;
}

function normalizedGitHubRepository(remote) {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/?#]+)\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

function upgradeEnvironment(environment = {}) {
  const allowed = ['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));
}

function upgradeTrustedPath(nodePath) {
  return [...new Set([dirname(resolve(nodePath)), '/usr/bin', '/bin', '/usr/local/bin'])].join(':');
}

function upgradeGitEnvironment(env) {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'Never'
  };
}

function trustedGitHubFetchArgs(defaultBranch) {
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth git-credential',
    '-c', 'http.sslVerify=true',
    '-c', 'http.https://github.com/.sslVerify=true',
    'fetch', '--no-tags', 'origin', defaultBranch
  ];
}

async function checkedUpgradeCommand(commandRunner, command, args, { cwd, env, allowExitCodes = [0], timeoutMs = 30_000, maxOutputBytes = 128 * 1024 } = {}) {
  const result = await commandRunner(command, args, { cwd, env, timeoutMs, maxOutputBytes });
  if (result.timedOut || !allowExitCodes.includes(result.exitCode)) throw new Error(`operator_upgrade_command_failed:${command}:${args[0]}`);
  return result;
}

async function ghApiJson(commandRunner, endpoint, { cwd, env }) {
  const result = await checkedUpgradeCommand(commandRunner, 'gh', ['api', endpoint], { cwd, env, timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('operator_upgrade_github_response_invalid'); }
}

async function verifyUpgradeCommit(commandRunner, repository, branch, commitSha, { cwd, env }) {
  const pulls = await ghApiJson(commandRunner, `repos/${repository}/commits/${commitSha}/pulls`, { cwd, env });
  if (!Array.isArray(pulls)) throw new Error('operator_upgrade_associated_prs_invalid');
  const merged = pulls.find((pr) =>
    pr?.merged_at &&
    pr?.merge_commit_sha === commitSha &&
    pr?.base?.ref === branch &&
    typeof pr?.head?.sha === 'string' &&
    /^[a-f0-9]{40}$/i.test(pr.head.sha)
  );
  if (!merged) throw new Error(`operator_upgrade_commit_not_reviewed_pr:${commitSha}`);
  const runs = await ghApiJson(
    commandRunner,
    `repos/${repository}/actions/runs?head_sha=${encodeURIComponent(merged.head.sha)}&event=pull_request&status=completed&per_page=20`,
    { cwd, env }
  );
  const verified = Array.isArray(runs?.workflow_runs) && runs.workflow_runs.some((run) =>
    run?.name === 'CI' &&
    run?.event === 'pull_request' &&
    run?.head_sha === merged.head.sha &&
    run?.conclusion === 'success'
  );
  if (!verified) throw new Error(`operator_upgrade_ci_not_verified:${commitSha}`);
}

async function upgradeProcessIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = contents.slice(contents.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function upgradeLeasePaths(home) {
  const directory = join(resolve(home), '.config', 'engineering-orchestrator');
  return {
    directory,
    lockFile: join(directory, 'operator-upgrade.lock'),
    recoveryFile: join(directory, 'operator-upgrade.lock.recovery')
  };
}

async function readUpgradeLease(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.leaseId !== 'string' ||
      !value.leaseId ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      !Number.isFinite(Date.parse(value.createdAt ?? '')) ||
      (value.ownerIdentity !== null && value.ownerIdentity !== undefined && typeof value.ownerIdentity !== 'string')
    ) throw new Error('operator_upgrade_lease_invalid');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message === 'operator_upgrade_lease_invalid') throw error;
    throw new Error('operator_upgrade_lease_invalid', { cause: error });
  }
}

async function upgradeLeaseAbandoned(lease) {
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    return false;
  }
  if (lease.ownerIdentity && process.platform === 'linux') {
    const current = await upgradeProcessIdentity(lease.pid);
    return Boolean(current && current !== lease.ownerIdentity);
  }
  return false;
}

function sameUpgradeLease(left, right) {
  return left?.leaseId === right?.leaseId &&
    left?.pid === right?.pid &&
    left?.createdAt === right?.createdAt &&
    left?.ownerIdentity === right?.ownerIdentity;
}

async function writeUpgradeLease(file) {
  const lease = {
    leaseId: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerIdentity: await upgradeProcessIdentity(process.pid)
  };
  await writeFile(file, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  return lease;
}

async function acquireUpgradeLease(home) {
  const { directory, lockFile, recoveryFile } = upgradeLeasePaths(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('operator_upgrade_lease_directory_invalid');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const lease = await writeUpgradeLease(lockFile);
      return { lease, lockFile };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const observed = await readUpgradeLease(lockFile);
      if (!observed) continue;
      if (!await upgradeLeaseAbandoned(observed)) throw new Error('operator_upgrade_in_progress', { cause: error });
      let recoveryOwned = false;
      try {
        await writeUpgradeLease(recoveryFile);
        recoveryOwned = true;
      } catch (recoveryError) {
        if (recoveryError.code !== 'EEXIST') throw recoveryError;
        const recovery = await readUpgradeLease(recoveryFile);
        if (recovery && await upgradeLeaseAbandoned(recovery)) await rm(recoveryFile, { force: true });
      }
      if (recoveryOwned) {
        try {
          const current = await readUpgradeLease(lockFile);
          if (current && sameUpgradeLease(observed, current) && await upgradeLeaseAbandoned(current)) await rm(lockFile, { force: true });
        } finally {
          await rm(recoveryFile, { force: true });
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error('operator_upgrade_lease_timeout');
}

async function releaseUpgradeLease(lockFile, lease) {
  const current = await readUpgradeLease(lockFile);
  if (!current || !sameUpgradeLease(current, lease)) return false;
  await rm(lockFile, { force: true });
  return true;
}

async function performInboxServiceUpgrade({
  repositoryRoot,
  expectedRepository,
  defaultBranch,
  stateLoader,
  nodePath,
  home,
  commandRunner,
  environment,
  maxCommits
}) {
  assertOperatorUpgradeIdleState(await stateLoader());

  const trustedPath = upgradeTrustedPath(nodePath);
  const authEnvironment = { ...environment, PATH: trustedPath, HOME: resolve(home), GH_HOST: 'github.com' };
  await ensureGitHubToken({ environment: authEnvironment, commandRunner, home });
  const env = { ...upgradeEnvironment(authEnvironment), PATH: trustedPath, HOME: resolve(home), GH_HOST: 'github.com' };
  const gitEnv = upgradeGitEnvironment(env);
  const githubEnv = { ...env, GITHUB_TOKEN: authEnvironment.GITHUB_TOKEN };

  const root = resolve(repositoryRoot);
  const status = await serviceStatus({ home, pathValue: trustedPath, commandRunner });
  if (!status.installed) throw new Error('persistent_inbox_service_not_installed');
  if (!status.enabled || !status.active) throw new Error('operator_upgrade_service_must_be_enabled_and_active');

  const repository = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', '--show-toplevel'], { cwd: root, env })).stdout.trim();
  if (resolve(repository) !== root) throw new Error('operator_upgrade_repository_root_mismatch');
  const gitDirectory = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', '--absolute-git-dir'], { cwd: root, env })).stdout.trim();
  if (resolve(gitDirectory) !== resolve(root, '.git')) throw new Error('operator_upgrade_git_directory_mismatch');
  const unsafeGitConfig = await checkedUpgradeCommand(
    commandRunner,
    'git',
    ['config', '--get-regexp', '^(url\\..*\\.insteadof|remote\\.origin\\.(uploadpack|receivepack)|core\\.(sshcommand|fsmonitor)|filter\\..*\\.(clean|smudge|process|required)|http(?:\\..*)?\\.(sslverify|sslcainfo|sslcapath|sslbackend))$'],
    { cwd: root, env: gitEnv, allowExitCodes: [0, 1] }
  );
  if (unsafeGitConfig.stdout.trim()) throw new Error('operator_upgrade_unsafe_git_transport_config');

  const branch = (await checkedUpgradeCommand(commandRunner, 'git', ['branch', '--show-current'], { cwd: root, env })).stdout.trim();
  if (branch !== defaultBranch) throw new Error(`operator_upgrade_wrong_branch:${branch || 'detached'}`);
  const dirty = (await checkedUpgradeCommand(commandRunner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, env })).stdout.trim();
  if (dirty) throw new Error('operator_upgrade_worktree_not_clean');
  const remote = (await checkedUpgradeCommand(commandRunner, 'git', ['remote', 'get-url', 'origin'], { cwd: root, env })).stdout.trim();
  if (normalizedGitHubRepository(remote)?.toLowerCase() !== expectedRepository.toLowerCase()) throw new Error('operator_upgrade_remote_mismatch');

  const localSha = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim();
  await checkedUpgradeCommand(commandRunner, 'git', trustedGitHubFetchArgs(defaultBranch), { cwd: root, env: gitEnv, timeoutMs: 60_000 });
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const remoteSha = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', remoteRef], { cwd: root, env })).stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(localSha) || !/^[a-f0-9]{40}$/i.test(remoteSha)) throw new Error('operator_upgrade_commit_identity_invalid');

  const branchEvidence = await ghApiJson(commandRunner, `repos/${expectedRepository}/branches/${encodeURIComponent(defaultBranch)}`, { cwd: root, env: githubEnv });
  if (branchEvidence?.commit?.sha !== remoteSha) throw new Error('operator_upgrade_remote_head_not_confirmed_by_github');
  if (localSha === remoteSha) return { ...status, upgraded: false, from: localSha, to: remoteSha, commits: 0 };

  const ancestor = await checkedUpgradeCommand(commandRunner, 'git', ['merge-base', '--is-ancestor', localSha, remoteSha], { cwd: root, env, allowExitCodes: [0, 1] });
  if (ancestor.exitCode !== 0) throw new Error('operator_upgrade_requires_fast_forward');
  const commits = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-list', '--first-parent', '--reverse', `${localSha}..${remoteSha}`], { cwd: root, env }))
    .stdout.split(/\r?\n/).filter(Boolean);
  if (!commits.length || commits.length > maxCommits) throw new Error('operator_upgrade_commit_range_out_of_bounds');
  for (const commit of commits) await verifyUpgradeCommit(commandRunner, expectedRepository, defaultBranch, commit, { cwd: root, env: githubEnv });

  await systemctl(commandRunner, ['stop', INBOX_SERVICE_NAME], { home, pathValue: trustedPath });
  try {
    assertOperatorUpgradeIdleState(await stateLoader());
    const secondBranch = (await checkedUpgradeCommand(commandRunner, 'git', ['branch', '--show-current'], { cwd: root, env })).stdout.trim();
    const secondHead = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim();
    const secondStatus = (await checkedUpgradeCommand(commandRunner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, env })).stdout.trim();
    const secondRemoteHead = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', remoteRef], { cwd: root, env })).stdout.trim();
    const secondRemote = (await checkedUpgradeCommand(commandRunner, 'git', ['remote', 'get-url', 'origin'], { cwd: root, env })).stdout.trim();
    if (secondBranch !== defaultBranch || secondHead !== localSha || secondStatus || secondRemoteHead !== remoteSha || normalizedGitHubRepository(secondRemote)?.toLowerCase() !== expectedRepository.toLowerCase()) {
      throw new Error('operator_upgrade_local_state_changed_before_fast_forward');
    }
  } catch (error) {
    const restored = await systemctl(commandRunner, ['restart', INBOX_SERVICE_NAME], { home, pathValue: trustedPath, allowFailure: true });
    if (restored.exitCode !== 0) throw new Error('operator_upgrade_state_changed_watcher_restore_failed', { cause: error });
    throw error;
  }

  let upgraded = false;
  try {
    await checkedUpgradeCommand(commandRunner, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', remoteSha], { cwd: root, env, timeoutMs: 60_000 });
    upgraded = true;
    const mergedHead = (await checkedUpgradeCommand(commandRunner, 'git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim();
    if (mergedHead !== remoteSha) throw new Error('operator_upgrade_fast_forward_head_mismatch');

    await checkedUpgradeCommand(commandRunner, 'npm', ['ci', '--ignore-scripts'], { cwd: root, env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
    const postInstallStatus = (await checkedUpgradeCommand(commandRunner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, env })).stdout.trim();
    if (postInstallStatus) throw new Error('operator_upgrade_dependency_refresh_modified_repository');

    await checkedUpgradeCommand(commandRunner, nodePath, [resolve(root, 'src', 'cli.js'), 'service', 'sync'], { cwd: root, env: githubEnv, timeoutMs: 60_000, maxOutputBytes: 32 * 1024 });
    const finalStatus = await serviceStatus({ home, pathValue: trustedPath, commandRunner });
    if (!finalStatus.enabled || !finalStatus.active) throw new Error('operator_upgrade_service_not_active');
    return { ...finalStatus, upgraded: true, from: localSha, to: remoteSha, commits: commits.length };
  } catch (error) {
    let rollbackError = null;
    try {
      if (upgraded) await checkedUpgradeCommand(commandRunner, 'git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--hard', localSha], { cwd: root, env, timeoutMs: 30_000 });
      await checkedUpgradeCommand(commandRunner, 'npm', ['ci', '--ignore-scripts'], { cwd: root, env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
      await checkedUpgradeCommand(commandRunner, nodePath, [resolve(root, 'src', 'cli.js'), 'service', 'sync'], { cwd: root, env: githubEnv, timeoutMs: 60_000, maxOutputBytes: 32 * 1024 });
    } catch (rollback) {
      rollbackError = rollback;
    }
    if (rollbackError) throw new Error('operator_upgrade_failed_rollback_incomplete', { cause: error });
    throw error;
  }
}

export async function upgradeInboxService({
  repositoryRoot = process.cwd(),
  expectedRepository,
  defaultBranch = 'main',
  stateLoader,
  nodePath = process.execPath,
  home = homedir(),
  platform = process.platform,
  commandRunner = runLocalCommand,
  environment = process.env,
  maxCommits = 20
} = {}) {
  if (platform !== 'linux') throw new Error('persistent_inbox_service_requires_linux_systemd');
  if (typeof expectedRepository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(expectedRepository)) throw new Error('operator_upgrade_expected_repository_invalid');
  if (typeof defaultBranch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch) || defaultBranch.includes('..')) throw new Error('operator_upgrade_default_branch_invalid');
  if (!Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > 100) throw new Error('operator_upgrade_max_commits_invalid');
  if (typeof stateLoader !== 'function') throw new Error('operator_upgrade_state_loader_required');

  const { lease, lockFile } = await acquireUpgradeLease(home);
  let output;
  let operationError = null;
  try {
    output = await performInboxServiceUpgrade({
      repositoryRoot,
      expectedRepository,
      defaultBranch,
      stateLoader,
      nodePath,
      home,
      commandRunner,
      environment,
      maxCommits
    });
  } catch (error) {
    operationError = error;
  }

  let released = false;
  let releaseError = null;
  try {
    released = await releaseUpgradeLease(lockFile, lease);
  } catch (error) {
    releaseError = error;
  }
  if (releaseError || !released) throw new Error('operator_upgrade_lease_release_failed', { cause: operationError ?? releaseError ?? undefined });
  if (operationError) throw operationError;
  return output;
}
