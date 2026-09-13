import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { INBOX_SERVICE_NAME, runLocalCommand, serviceStatus } from './service.js';

export const WSL_WAKEUP_RUN_VALUE = 'EngineeringOrchestratorWSLWakeup';
const guardianMarker = '# managed-by=engineering-orchestrator:wsl-guardian:v1';
const ownerMarker = 'engineering-orchestrator:wsl-wakeup:v1';
const ownerKey = 'HKCU\\Software\\EngineeringOrchestrator';
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const ownerValue = 'WSLWakeupManagedBy';
const hashValue = 'WSLWakeupCommandSha256';

function text(value, label) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function identifier(value, label) {
  const normalized = text(String(value ?? ''), label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) throw new Error(`${label} contains unsafe characters`);
  return normalized;
}

function paths(home) {
  const directory = join(resolve(home), '.config', 'engineering-orchestrator');
  return { directory, guardianPath: join(directory, 'wsl-guardian.sh') };
}

export function renderWslGuardianScript() {
  return [
    '#!/bin/sh',
    guardianMarker,
    'set -eu',
    `/usr/bin/systemctl --user start ${INBOX_SERVICE_NAME}`,
    'exec /usr/bin/sleep infinity',
    ''
  ].join('\n');
}

export function wslWakeupConfiguration({
  home = homedir(),
  environment = process.env,
  windowsSystemRoot = 'C:\\Windows'
} = {}) {
  const distro = identifier(environment.WSL_DISTRO_NAME, 'WSL_DISTRO_NAME');
  const linuxUser = identifier(environment.USER ?? basename(resolve(home)), 'WSL Linux user');
  if (linuxUser === 'root') throw new Error('wsl_wakeup_root_user_not_supported');
  const { guardianPath } = paths(home);
  if (!/^\/[A-Za-z0-9._/-]+$/.test(guardianPath)) throw new Error('wsl_guardian_path_contains_unsafe_characters');
  if (!/^[A-Za-z]:\\[A-Za-z0-9._\\-]+$/.test(windowsSystemRoot)) throw new Error('windows_system_root_invalid');
  const powershell = `${windowsSystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const wsl = `${windowsSystemRoot}\\System32\\wsl.exe`;
  const command = `${powershell} -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ${wsl} -d ${distro} --user ${linuxUser} --exec ${guardianPath}"`;
  if (command.length > 260) throw new Error('wsl_wakeup_run_command_exceeds_windows_limit');
  return { distro, linuxUser, guardianPath, command, commandHash: createHash('sha256').update(command).digest('hex') };
}

function interopEnvironment(environment, home) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: resolve(home),
    WSL_INTEROP: text(environment.WSL_INTEROP, 'WSL_INTEROP'),
    WSL_DISTRO_NAME: identifier(environment.WSL_DISTRO_NAME, 'WSL_DISTRO_NAME')
  };
}

async function regQuery(runner, regExecutable, key, name, options) {
  const result = await runner(regExecutable, ['QUERY', key, '/v', name], {
    cwd: options.home,
    env: interopEnvironment(options.environment, options.home),
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  });
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw new Error(`windows_registry_query_failed:${name}`);
  const line = String(result.stdout ?? '').split(/\r?\n/).find((entry) => entry.trimStart().startsWith(name));
  const match = line?.match(/^\s*([^\s]+)\s+REG_SZ\s+(.*)$/i);
  if (!match || match[1] !== name) throw new Error(`windows_registry_query_unparseable:${name}`);
  return match[2].trim();
}

async function regSet(runner, regExecutable, key, name, value, options) {
  const result = await runner(regExecutable, ['ADD', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
    cwd: options.home,
    env: interopEnvironment(options.environment, options.home),
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  });
  if (result.exitCode !== 0) throw new Error(`windows_registry_write_failed:${name}`);
}

async function regDelete(runner, regExecutable, key, name, options) {
  const result = await runner(regExecutable, ['DELETE', key, '/v', name, '/f'], {
    cwd: options.home,
    env: interopEnvironment(options.environment, options.home),
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  });
  if (![0, 1].includes(result.exitCode)) throw new Error(`windows_registry_delete_failed:${name}`);
}

async function registrySnapshot(runner, regExecutable, options) {
  const [owner, hash, run] = await Promise.all([
    regQuery(runner, regExecutable, ownerKey, ownerValue, options),
    regQuery(runner, regExecutable, ownerKey, hashValue, options),
    regQuery(runner, regExecutable, runKey, WSL_WAKEUP_RUN_VALUE, options)
  ]);
  return { owner, hash, run };
}

async function guardianSnapshot(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('wsl_guardian_must_be_regular_file');
    const content = await readFile(file, 'utf8');
    if (!content.includes(guardianMarker)) throw new Error('wsl_guardian_not_managed_by_agent');
    return { content, mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegistryOwned(snapshot, expected) {
  if (snapshot.owner === null) {
    if (snapshot.hash !== null || snapshot.run !== null) throw new Error('wsl_wakeup_registry_state_not_owned');
    return;
  }
  if (snapshot.owner !== ownerMarker) throw new Error('wsl_wakeup_registry_owned_by_other_software');
  if (snapshot.hash !== null && snapshot.hash !== expected.commandHash) throw new Error('wsl_wakeup_registry_hash_tampered');
  if (snapshot.run !== null && snapshot.run !== expected.command) throw new Error('wsl_wakeup_run_command_tampered');
}

async function restoreRegistry(runner, regExecutable, snapshot, options) {
  const restore = async (key, name, value) => value === null
    ? regDelete(runner, regExecutable, key, name, options)
    : regSet(runner, regExecutable, key, name, value, options);
  await restore(runKey, WSL_WAKEUP_RUN_VALUE, snapshot.run);
  await restore(ownerKey, hashValue, snapshot.hash);
  await restore(ownerKey, ownerValue, snapshot.owner);
}

function supported(environment, platform) {
  return platform === 'linux' && Boolean(environment.WSL_DISTRO_NAME && environment.WSL_INTEROP);
}

export async function wslWakeupStatus({
  home = homedir(),
  platform = process.platform,
  environment = process.env,
  commandRunner = runLocalCommand,
  regExecutable = '/mnt/c/Windows/System32/reg.exe'
} = {}) {
  if (!supported(environment, platform)) return { supported: false, installed: false, healthy: false, reason: 'wsl_interop_unavailable' };
  const expected = wslWakeupConfiguration({ home, environment });
  let guardian;
  let registry;
  try {
    guardian = await guardianSnapshot(expected.guardianPath);
    registry = await registrySnapshot(commandRunner, regExecutable, { environment, home });
  } catch (error) {
    return { supported: true, installed: true, healthy: false, reason: error.message, ...expected };
  }
  const installed = Boolean(guardian || registry.owner || registry.hash || registry.run);
  const healthy = Boolean(
    guardian?.content === renderWslGuardianScript() &&
    registry.owner === ownerMarker &&
    registry.hash === expected.commandHash &&
    registry.run === expected.command
  );
  return { supported: true, installed, healthy, reason: healthy || !installed ? null : 'wsl_wakeup_state_incomplete_or_changed', ...expected };
}

export async function syncWslWakeup({
  home = homedir(),
  platform = process.platform,
  pathValue = process.env.PATH ?? '',
  environment = process.env,
  commandRunner = runLocalCommand,
  regExecutable = '/mnt/c/Windows/System32/reg.exe'
} = {}) {
  if (!supported(environment, platform)) throw new Error('wsl_wakeup_requires_windows_interop');
  const inbox = await serviceStatus({ home, pathValue, commandRunner });
  if (!inbox.installed || !inbox.enabled || !inbox.active) throw new Error('wsl_wakeup_requires_active_inbox_service');

  const expected = wslWakeupConfiguration({ home, environment });
  const guardianBefore = await guardianSnapshot(expected.guardianPath);
  const registryBefore = await registrySnapshot(commandRunner, regExecutable, { environment, home });
  assertRegistryOwned(registryBefore, expected);
  const desiredGuardian = renderWslGuardianScript();
  const changed = guardianBefore?.content !== desiredGuardian ||
    registryBefore.owner !== ownerMarker ||
    registryBefore.hash !== expected.commandHash ||
    registryBefore.run !== expected.command;
  if (!changed) {
    await chmod(expected.guardianPath, 0o700);
    return { ...(await wslWakeupStatus({ home, platform, environment, commandRunner, regExecutable })), changed: false };
  }

  const { directory, guardianPath } = paths(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('wsl_guardian_directory_invalid');
  const temporary = `${guardianPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, desiredGuardian, { mode: 0o700, flag: 'wx' });
    await rename(temporary, guardianPath);
    await chmod(guardianPath, 0o700);
    await regSet(commandRunner, regExecutable, ownerKey, ownerValue, ownerMarker, { environment, home });
    await regSet(commandRunner, regExecutable, ownerKey, hashValue, expected.commandHash, { environment, home });
    await regSet(commandRunner, regExecutable, runKey, WSL_WAKEUP_RUN_VALUE, expected.command, { environment, home });
    const status = await wslWakeupStatus({ home, platform, environment, commandRunner, regExecutable });
    if (!status.healthy) throw new Error('wsl_wakeup_verification_failed');
    return { ...status, changed: true };
  } catch (error) {
    await rm(temporary, { force: true });
    try {
      await restoreRegistry(commandRunner, regExecutable, registryBefore, { environment, home });
      if (guardianBefore) {
        await writeFile(guardianPath, guardianBefore.content, { mode: guardianBefore.mode || 0o700 });
        await chmod(guardianPath, guardianBefore.mode || 0o700);
      } else await rm(guardianPath, { force: true });
    } catch {
      throw new Error('wsl_wakeup_failed_rollback_incomplete', { cause: error });
    }
    throw error;
  }
}

export async function uninstallWslWakeup({
  home = homedir(),
  platform = process.platform,
  environment = process.env,
  commandRunner = runLocalCommand,
  regExecutable = '/mnt/c/Windows/System32/reg.exe'
} = {}) {
  if (!supported(environment, platform)) throw new Error('wsl_wakeup_requires_windows_interop');
  const expected = wslWakeupConfiguration({ home, environment });
  const guardianBefore = await guardianSnapshot(expected.guardianPath);
  const registryBefore = await registrySnapshot(commandRunner, regExecutable, { environment, home });
  const absent = !guardianBefore && registryBefore.owner === null && registryBefore.hash === null && registryBefore.run === null;
  if (absent) return { supported: true, installed: false, healthy: false, removed: false, guardianPath: expected.guardianPath };
  assertRegistryOwned(registryBefore, expected);
  if (!guardianBefore || registryBefore.owner !== ownerMarker || registryBefore.hash !== expected.commandHash || registryBefore.run !== expected.command) {
    throw new Error('wsl_wakeup_uninstall_requires_complete_managed_state');
  }
  try {
    await regDelete(commandRunner, regExecutable, runKey, WSL_WAKEUP_RUN_VALUE, { environment, home });
    await regDelete(commandRunner, regExecutable, ownerKey, hashValue, { environment, home });
    await regDelete(commandRunner, regExecutable, ownerKey, ownerValue, { environment, home });
    await rm(expected.guardianPath, { force: true });
    return { supported: true, installed: false, healthy: false, removed: true, guardianPath: expected.guardianPath };
  } catch (error) {
    try {
      await restoreRegistry(commandRunner, regExecutable, registryBefore, { environment, home });
      await writeFile(expected.guardianPath, guardianBefore.content, { mode: guardianBefore.mode || 0o700 });
      await chmod(expected.guardianPath, guardianBefore.mode || 0o700);
    } catch {
      throw new Error('wsl_wakeup_uninstall_rollback_incomplete', { cause: error });
    }
    throw error;
  }
}
