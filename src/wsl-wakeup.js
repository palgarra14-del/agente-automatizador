import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

function windowsPathToWsl(path) {
  const match = text(path, 'Windows path').match(/^([A-Za-z]):\\(.*)$/);
  if (!match) throw new Error('windows_path_invalid');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

async function guardianProcessActive(guardianPath) {
  let entries;
  try {
    entries = await readdir('/proc', { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const argv = (await readFile(`/proc/${entry.name}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (argv.includes(guardianPath)) return true;
    } catch {
      // Processes can disappear while /proc is being inspected.
    }
  }
  return false;
}

function paths(home) {
  const directory = join(resolve(home), '.config', 'engineering-orchestrator');
  return { directory, guardianPath: join(directory, 'wsl-guardian.sh') };
}

async function ensureGuardianDirectory(home) {
  const root = resolve(home);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('wsl_guardian_home_directory_invalid');
  const candidates = [join(root, '.config'), join(root, '.config', 'engineering-orchestrator')];
  for (const candidate of candidates) {
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(candidate);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('wsl_guardian_directory_invalid');
  }
  return paths(root);
}

async function writeGuardianAtomically(file, content, mode = 0o700) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export const WSL_MANAGED_RUNNER_DIRECTORIES = Object.freeze([
  'actions-runner-agente',
  'actions-runner-agente-2',
  'actions-runner-agente-3'
]);
const WSL_MANAGED_RUNNER_NAMES = Object.freeze([
  'MSI-WSL-agent',
  'MSI-WSL-agent-2',
  'MSI-WSL-agent-3'
]);
const WSL_RUNNER_REPOSITORY = 'palgarra14-del/agente-automatizador';

export function renderWslGuardianScript() {
  return [
    '#!/bin/sh',
    guardianMarker,
    'set -eu',
    `/usr/bin/systemctl --user start ${INBOX_SERVICE_NAME}`,
    '',
    'runner_listener_pid() {',
    '  runner="$1"',
    '  listener="$runner/bin/Runner.Listener"',
    '  for process in /proc/[0-9]*; do',
    '    [ -r "$process/cmdline" ] || continue',
    '    cwd="$(/usr/bin/readlink "$process/cwd" 2>/dev/null || true)"',
    '    [ "$cwd" = "$runner" ] || continue',
    '    command="$(/usr/bin/tr "\\000" " " < "$process/cmdline" 2>/dev/null || true)"',
    '    case "$command" in',
    '      *Runner.Listener*)',
    '        pid="${process##*/}"',
    '        printf "%s\\n" "$pid"',
    '        return 0',
    '        ;;',
    '    esac',
    '  done',
    '  return 1',
    '}',
    '',
    'runner_worker_active() {',
    '  runner="$1"',
    '  worker="$runner/bin/Runner.Worker"',
    '  for process in /proc/[0-9]*; do',
    '    [ -e "$process/exe" ] || continue',
    '    executable="$(/usr/bin/readlink "$process/exe" 2>/dev/null || true)"',
    '    [ "$executable" = "$worker" ] && return 0',
    '  done',
    '  return 1',
    '}',
    '',
    'listener_elapsed_seconds() {',
    '  pid="$1"',
    '  elapsed="$(/usr/bin/ps -o etimes= -p "$pid" 2>/dev/null | /usr/bin/tr -d "[:space:]" || true)"',
    '  case "$elapsed" in',
    '    ""|*[!0-9]*) return 1 ;;',
    '  esac',
    '  printf "%s\\n" "$elapsed"',
    '}',
    '',
    'runner_reported_offline() {',
    '  runner_name="$1"',
    `  statuses="$(/usr/bin/gh api "repos/${WSL_RUNNER_REPOSITORY}/actions/runners?per_page=100" --template '{{range .runners}}{{printf "%s %s\\n" .name .status}}{{end}}' 2>/dev/null || true)"`,
    '  [ -n "$statuses" ] || return 1',
    '  printf "%s\\n" "$statuses" | /usr/bin/grep -Fx "$runner_name offline" >/dev/null 2>&1',
    '}',
    '',
    'recycle_stale_offline_listener() {',
    '  runner="$1"',
    '  runner_name="$2"',
    '  pid="$3"',
    '  elapsed="$(listener_elapsed_seconds "$pid" || true)"',
    '  [ -n "$elapsed" ] || return 1',
    '  [ "$elapsed" -ge 7200 ] || return 1',
    '  [ $((elapsed % 300)) -lt 10 ] || return 1',
    '  runner_worker_active "$runner" && return 1',
    '  runner_reported_offline "$runner_name" || return 1',
    '  /usr/bin/sleep 2',
    '  runner_worker_active "$runner" && return 1',
    '  runner_reported_offline "$runner_name" || return 1',
    '  /bin/kill -TERM "$pid" 2>/dev/null || true',
    '  for attempt in 1 2 3 4 5; do',
    '    /bin/kill -0 "$pid" 2>/dev/null || return 0',
    '    /usr/bin/sleep 1',
    '  done',
    '  /bin/kill -KILL "$pid" 2>/dev/null || true',
    '  return 0',
    '}',
    '',
    'runner_watch() {',
    '  runner="$1"',
    '  runner_name="$2"',
    '  listener="$runner/bin/Runner.Listener"',
    '  launcher="$runner/run.sh"',
    '  [ -d "$runner" ] || return 0',
    '  [ ! -L "$runner" ] || return 0',
    '  [ -f "$runner/.runner" ] || return 0',
    '  [ ! -L "$runner/.runner" ] || return 0',
    '  [ -x "$listener" ] || return 0',
    '  [ ! -L "$listener" ] || return 0',
    '  [ -x "$launcher" ] || return 0',
    '  [ ! -L "$launcher" ] || return 0',
    '  launch_pid=""',
    '  while :; do',
    '    pid="$(runner_listener_pid "$runner" || true)"',
    '    if [ -n "$pid" ]; then',
    '      launch_pid=""',
    '      if recycle_stale_offline_listener "$runner" "$runner_name" "$pid"; then',
    '        /usr/bin/sleep 2',
    '        continue',
    '      fi',
    '      /usr/bin/sleep 10',
    '      continue',
    '    fi',
    '    if [ -n "$launch_pid" ] && /bin/kill -0 "$launch_pid" 2>/dev/null; then',
    '      /usr/bin/sleep 2',
    '      continue',
    '    fi',
    '    (cd "$runner" && "$launcher") >/dev/null 2>&1 &',
    '    launch_pid="$!"',
    '    /usr/bin/sleep 2',
    '  done',
    '}',
    '',
    ...WSL_MANAGED_RUNNER_DIRECTORIES.map((directory, index) => `runner_watch "$HOME/${directory}" "${WSL_MANAGED_RUNNER_NAMES[index]}" &`),
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
  return {
    distro,
    linuxUser,
    guardianPath,
    powershell,
    powershellInterop: windowsPathToWsl(powershell),
    wsl,
    command,
    commandHash: createHash('sha256').update(command).digest('hex')
  };
}

async function startWslGuardian(expected, { home, environment, commandRunner }) {
  const ps = `Start-Process -WindowStyle Hidden -FilePath '${expected.wsl}' -ArgumentList @('-d','${expected.distro}','--user','${expected.linuxUser}','--exec','${expected.guardianPath}')`;
  const result = await commandRunner(expected.powershellInterop, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    ps
  ], {
    cwd: resolve(home),
    env: interopEnvironment(environment, home),
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  });
  if (result.exitCode !== 0) throw new Error('wsl_guardian_current_session_start_failed');
}

async function ensureWslGuardianRunning(expected, {
  home,
  environment,
  commandRunner,
  guardianRunning,
  guardianStarter
}) {
  if (await guardianRunning(expected.guardianPath)) return false;
  await guardianStarter(expected, { home, environment, commandRunner });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await guardianRunning(expected.guardianPath)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('wsl_guardian_current_session_not_running');
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
    if (Number(info.nlink) !== 1) throw new Error('wsl_guardian_must_not_be_hardlinked');
    for (const directory of [dirname(dirname(file)), dirname(file)]) {
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('wsl_guardian_ancestor_directory_invalid');
    }
    const content = await readFile(file, 'utf8');
    if (!content.startsWith(`#!/bin/sh\n${guardianMarker}\n`)) throw new Error('wsl_guardian_not_managed_by_agent');
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
  regExecutable = '/mnt/c/Windows/System32/reg.exe',
  guardianRunning = guardianProcessActive
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
  const running = installed ? await guardianRunning(expected.guardianPath) : false;
  return { supported: true, installed, healthy, running, reason: healthy || !installed ? null : 'wsl_wakeup_state_incomplete_or_changed', ...expected };
}

export async function syncWslWakeup({
  home = homedir(),
  platform = process.platform,
  pathValue = process.env.PATH ?? '',
  environment = process.env,
  commandRunner = runLocalCommand,
  regExecutable = '/mnt/c/Windows/System32/reg.exe',
  guardianRunning = guardianProcessActive,
  guardianStarter = startWslGuardian
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
    const started = await ensureWslGuardianRunning(expected, { home, environment, commandRunner, guardianRunning, guardianStarter });
    return {
      ...(await wslWakeupStatus({ home, platform, environment, commandRunner, regExecutable, guardianRunning })),
      changed: false,
      started
    };
  }

  const { guardianPath } = await ensureGuardianDirectory(home);
  try {
    await writeGuardianAtomically(guardianPath, desiredGuardian);
    await regSet(commandRunner, regExecutable, ownerKey, ownerValue, ownerMarker, { environment, home });
    await regSet(commandRunner, regExecutable, ownerKey, hashValue, expected.commandHash, { environment, home });
    await regSet(commandRunner, regExecutable, runKey, WSL_WAKEUP_RUN_VALUE, expected.command, { environment, home });
    const started = await ensureWslGuardianRunning(expected, { home, environment, commandRunner, guardianRunning, guardianStarter });
    const status = await wslWakeupStatus({ home, platform, environment, commandRunner, regExecutable, guardianRunning });
    if (!status.healthy || !status.running) throw new Error('wsl_wakeup_verification_failed');
    return { ...status, changed: true, started };
  } catch (error) {
    try {
      await restoreRegistry(commandRunner, regExecutable, registryBefore, { environment, home });
      if (guardianBefore) await writeGuardianAtomically(guardianPath, guardianBefore.content, guardianBefore.mode || 0o700);
      else await rm(guardianPath, { force: true });
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
      await writeGuardianAtomically(expected.guardianPath, guardianBefore.content, guardianBefore.mode || 0o700);
    } catch {
      throw new Error('wsl_wakeup_uninstall_rollback_incomplete', { cause: error });
    }
    throw error;
  }
}
