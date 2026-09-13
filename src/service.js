import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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

export function renderInboxServiceUnit({ repositoryRoot, nodePath, pathValue, home = homedir() }) {
  const rawRoot = validateText(repositoryRoot, 'repositoryRoot');
  const rawNode = validateText(nodePath, 'nodePath');
  if (!isAbsolute(rawRoot) || !isAbsolute(rawNode)) throw new Error('service paths must be absolute');
  const root = resolve(rawRoot);
  const node = resolve(rawNode);
  const cli = join(root, 'src', 'cli.js');
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
    `Environment=${systemdQuote(`PATH=${validateText(pathValue, 'PATH')}`)}`,
    `Environment=${systemdQuote(`HOME=${resolve(home)}`)}`,
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

async function systemctl(commandRunner, args, { home, pathValue, allowFailure = false }) {
  const result = await commandRunner('systemctl', ['--user', ...args], {
    cwd: home,
    env: { PATH: pathValue, HOME: home },
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
  const cliInfo = await lstat(cliPath);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error('service_cli_entrypoint_invalid');
  const { unitDirectory, unitPath } = servicePaths(home);
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  await assertManagedOrMissing(unitPath);
  const unit = renderInboxServiceUnit({ repositoryRoot, nodePath, pathValue, home });
  const temporary = `${unitPath}.tmp-${process.pid}`;
  await writeFile(temporary, unit, { mode: 0o600 });
  await rename(temporary, unitPath);
  try {
    await systemctl(commandRunner, ['daemon-reload'], { home, pathValue });
    await systemctl(commandRunner, ['enable', '--now', INBOX_SERVICE_NAME], { home, pathValue });
    const status = await serviceStatus({ home, pathValue, commandRunner });
    if (!status.enabled || !status.active) throw new Error('persistent_inbox_service_failed_to_start');
    return status;
  } catch (error) {
    await systemctl(commandRunner, ['disable', '--now', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
    await rm(unitPath, { force: true });
    await systemctl(commandRunner, ['daemon-reload'], { home, pathValue, allowFailure: true });
    throw error;
  }
}

export async function serviceStatus({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand } = {}) {
  const { unitPath } = servicePaths(home);
  const installed = await assertManagedOrMissing(unitPath);
  if (!installed) return { service: INBOX_SERVICE_NAME, installed: false, enabled: false, active: false, unitPath };
  const enabled = await systemctl(commandRunner, ['is-enabled', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
  const active = await systemctl(commandRunner, ['is-active', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
  return {
    service: INBOX_SERVICE_NAME,
    installed: true,
    enabled: enabled.exitCode === 0 && enabled.stdout.trim() === 'enabled',
    active: active.exitCode === 0 && active.stdout.trim() === 'active',
    unitPath
  };
}

export async function restartInboxService({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand } = {}) {
  const { unitPath } = servicePaths(home);
  if (!await assertManagedOrMissing(unitPath)) throw new Error('persistent_inbox_service_not_installed');
  await systemctl(commandRunner, ['restart', INBOX_SERVICE_NAME], { home, pathValue });
  return serviceStatus({ home, pathValue, commandRunner });
}

export async function uninstallInboxService({ home = homedir(), pathValue = process.env.PATH ?? '', commandRunner = runLocalCommand } = {}) {
  const { unitPath } = servicePaths(home);
  if (!await assertManagedOrMissing(unitPath)) return { service: INBOX_SERVICE_NAME, installed: false, removed: false, unitPath };
  await systemctl(commandRunner, ['disable', '--now', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
  const active = await systemctl(commandRunner, ['is-active', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
  if (active.exitCode === 0 && active.stdout.trim() === 'active') throw new Error('persistent_inbox_service_still_active');
  await rm(unitPath, { force: true });
  await systemctl(commandRunner, ['daemon-reload'], { home, pathValue });
  await systemctl(commandRunner, ['reset-failed', INBOX_SERVICE_NAME], { home, pathValue, allowFailure: true });
  return { service: INBOX_SERVICE_NAME, installed: false, removed: true, unitPath };
}
