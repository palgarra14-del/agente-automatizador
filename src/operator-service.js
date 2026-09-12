import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SERVICE_NAME = 'engineering-orchestrator.service';

function safeServicePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n"$%]/.test(value)) throw new Error(`${label} must be a safe absolute path`);
  return value;
}

function quoteUnit(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function buildOperatorServiceUnit({ repositoryRoot, nodePath = process.execPath } = {}) {
  const root = safeServicePath(resolve(repositoryRoot ?? '.'), 'repositoryRoot');
  const node = safeServicePath(resolve(nodePath), 'nodePath');
  const cli = safeServicePath(join(root, 'src', 'cli.js'), 'cliPath');
  const pathValue = [...new Set([dirname(node), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  return [
    '[Unit]',
    'Description=Engineering Orchestrator supervised issue operator',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quoteUnit(root)}`,
    `ExecStart=${quoteUnit(node)} ${quoteUnit(cli)} inbox watch`,
    `Environment=${quoteUnit(`PATH=${pathValue}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=30',
    'KillMode=mixed',
    'UMask=0077',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    `ReadWritePaths=${quoteUnit(root)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function validatedToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || Buffer.byteLength(token, 'utf8') > 16 * 1024 || /\s/.test(token)) throw new Error('GitHub authentication did not return one bounded token');
  return token;
}

async function rawGhToken({ spawnImpl = spawn, environment = process.env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveToken, reject) => {
    const child = spawnImpl('gh', ['auth', 'token'], {
      shell: false,
      windowsHide: true,
      env: Object.fromEntries(['HOME', 'PATH', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL'].flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]))
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, token = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveToken(token);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('gh auth token timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 16 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.on('error', () => finish(new Error('gh is unavailable for GitHub authentication')));
    child.on('close', (code) => {
      if (code !== 0 || stdoutBytes > 16 * 1024) return finish(new Error(`gh auth token failed${stderrBytes ? ' with diagnostic output' : ''}`));
      try { finish(null, validatedToken(stdout)); }
      catch (error) { finish(error); }
    });
  });
}

export async function resolveGitHubToken({ environment = process.env, tokenReader = rawGhToken } = {}) {
  if (environment.GITHUB_TOKEN !== undefined) return validatedToken(environment.GITHUB_TOKEN);
  return validatedToken(await tokenReader({ environment }));
}

async function runSystemctl(args, { processRunner } = {}) {
  if (!processRunner) throw new Error('processRunner is required');
  const result = await processRunner('systemctl', ['--user', ...args], { timeoutMs: 30_000, outputLimit: 4_000 });
  if (result.timedOut || result.exitCode !== 0) throw new Error(`systemctl --user ${args[0]} failed`);
  return result;
}

async function assertWritableServiceTarget(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('operator service target must be a regular non-symlink file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function installOperatorService({
  repositoryRoot,
  nodePath = process.execPath,
  home = homedir(),
  platform = process.platform,
  processRunner,
  tokenResolver = resolveGitHubToken
} = {}) {
  if (platform !== 'linux') throw new Error('operator service installation is supported only on Linux/WSL');
  const root = safeServicePath(resolve(repositoryRoot ?? '.'), 'repositoryRoot');
  const serviceDir = safeServicePath(join(home, '.config', 'systemd', 'user'), 'serviceDir');
  const serviceFile = safeServicePath(join(serviceDir, SERVICE_NAME), 'serviceFile');
  validatedToken(await tokenResolver());
  await mkdir(serviceDir, { recursive: true, mode: 0o700 });
  await assertWritableServiceTarget(serviceFile);
  const unit = buildOperatorServiceUnit({ repositoryRoot: root, nodePath });
  const temp = join(serviceDir, `.${SERVICE_NAME}.tmp-${randomUUID()}`);
  try {
    await writeFile(temp, unit, { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, serviceFile);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  try {
    await runSystemctl(['daemon-reload'], { processRunner });
    await runSystemctl(['enable', '--now', SERVICE_NAME], { processRunner });
  } catch (error) {
    try { await processRunner?.('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { timeoutMs: 30_000, outputLimit: 2_000 }); } catch { /* best effort */ }
    await rm(serviceFile, { force: true });
    try { await processRunner?.('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 30_000, outputLimit: 2_000 }); } catch { /* best effort */ }
    throw error;
  }
  return { service: SERVICE_NAME, serviceFile, repositoryRoot: root };
}

export async function operatorServiceStatus({ processRunner } = {}) {
  if (!processRunner) throw new Error('processRunner is required');
  const enabled = await processRunner('systemctl', ['--user', 'is-enabled', SERVICE_NAME], { timeoutMs: 10_000, outputLimit: 1_000 });
  const active = await processRunner('systemctl', ['--user', 'is-active', SERVICE_NAME], { timeoutMs: 10_000, outputLimit: 1_000 });
  return {
    service: SERVICE_NAME,
    enabled: enabled.exitCode === 0 && enabled.stdout.trim() === 'enabled',
    active: active.exitCode === 0 && active.stdout.trim() === 'active'
  };
}

export async function uninstallOperatorService({ home = homedir(), platform = process.platform, processRunner } = {}) {
  if (platform !== 'linux') throw new Error('operator service removal is supported only on Linux/WSL');
  if (!processRunner) throw new Error('processRunner is required');
  const serviceFile = safeServicePath(join(home, '.config', 'systemd', 'user', SERVICE_NAME), 'serviceFile');
  try { await processRunner('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { timeoutMs: 30_000, outputLimit: 2_000 }); } catch { /* service may already be absent */ }
  await assertWritableServiceTarget(serviceFile);
  await rm(serviceFile, { force: true });
  await runSystemctl(['daemon-reload'], { processRunner });
  return { service: SERVICE_NAME, removed: true };
}
