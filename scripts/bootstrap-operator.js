#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = ['package.json', 'package-lock.json', 'src/cli.js', 'config/projects.json', 'config/runtime-images.json'];

async function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ exitCode: code ?? 1, signal: signal ?? null }));
  });
}

function npmEnvironment(environment, isolatedHome) {
  const output = {
    PATH: String(environment.PATH ?? ''),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CI: 'true',
    npm_config_userconfig: join(isolatedHome, '.npmrc'),
    npm_config_cache: join(isolatedHome, '.npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (typeof environment[key] === 'string' && environment[key]) output[key] = environment[key];
  }
  return output;
}

async function validateRepositoryRoot(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error('operator_bootstrap_repository_root_invalid');
  for (const relativePath of requiredFiles) {
    const target = resolve(root, relativePath);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) throw new Error(`operator_bootstrap_required_file_invalid:${relativePath}`);
  }
  return root;
}

export async function bootstrapOperator({
  repositoryRoot = scriptRepositoryRoot,
  environment = process.env,
  platform = process.platform,
  runner = runCommand,
  npmExecutable = platform === 'win32' ? 'npm.cmd' : 'npm',
  nodeExecutable = process.execPath,
  project = 'callflow'
} = {}) {
  if (platform === 'win32') throw new Error('operator_bootstrap_requires_wsl_or_linux');
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project)) throw new Error('operator_bootstrap_project_invalid');
  const root = await validateRepositoryRoot(repositoryRoot);
  const isolatedHome = await mkdtemp(join(tmpdir(), 'engineering-orchestrator-npm-'));
  try {
    const install = await runner(npmExecutable, ['ci', '--ignore-scripts', '--audit=false', '--fund=false'], {
      cwd: root,
      env: npmEnvironment(environment, isolatedHome)
    });
    if (install.exitCode !== 0) throw new Error('operator_bootstrap_dependency_install_failed');
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }

  const cli = resolve(root, 'src/cli.js');
  const service = await runner(nodeExecutable, [cli, 'service', 'bootstrap'], { cwd: root, env: environment });
  if (service.exitCode !== 0) throw new Error('operator_bootstrap_service_failed');

  const doctor = await runner(nodeExecutable, [cli, 'doctor', '--project', project], { cwd: root, env: environment });
  if (doctor.exitCode !== 0) throw new Error('operator_bootstrap_doctor_failed');

  return { ok: true, project, dependencyInstall: 'completed', serviceBootstrap: 'completed', doctor: 'completed' };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const result = await bootstrapOperator();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
