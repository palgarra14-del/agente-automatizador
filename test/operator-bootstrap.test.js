import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapOperator } from '../scripts/bootstrap-operator.js';

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'operator-bootstrap-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}\n');
  await writeFile(join(root, 'package-lock.json'), '{}\n');
  await writeFile(join(root, 'src', 'cli.js'), '// fixture\n');
  await writeFile(join(root, 'config', 'projects.json'), '{}\n');
  await writeFile(join(root, 'config', 'runtime-images.json'), '{}\n');
  return root;
}

function runnerFixture({ failAt = null } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    const record = { command, args: [...args], options };
    calls.push(record);
    if (calls.length === 1) {
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      assert.equal(options.env.VERCEL_TOKEN, undefined);
      assert.equal(options.env.npm_config_ignore_scripts, 'true');
      assert.equal(options.env.npm_config_audit, 'false');
      assert.match(options.env.HOME, /engineering-orchestrator-npm-/);
      assert.equal((await lstat(options.env.HOME)).isDirectory(), true);
    }
    return { exitCode: failAt === calls.length ? 1 : 0, signal: null };
  };
  return { runner, calls };
}

test('one-command bootstrap installs frozen dependencies, bootstraps service, then checks Callflow', async () => {
  const root = await repositoryFixture();
  const f = runnerFixture();
  const environment = { PATH: '/usr/bin:/bin', HOME: '/home/operator', GITHUB_TOKEN: 'secret', CODEX_API_KEY: 'secret', VERCEL_TOKEN: 'secret' };
  try {
    const result = await bootstrapOperator({ repositoryRoot: root, environment, platform: 'linux', runner: f.runner, npmExecutable: '/usr/bin/npm', nodeExecutable: '/usr/bin/node' });
    assert.deepEqual(result, { ok: true, project: 'callflow', dependencyInstall: 'completed', serviceBootstrap: 'completed', doctor: 'completed' });
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls[0].args, ['ci', '--ignore-scripts', '--audit=false', '--fund=false']);
    assert.deepEqual(f.calls[1].args.slice(-2), ['service', 'bootstrap']);
    assert.deepEqual(f.calls[2].args.slice(-3), ['doctor', '--project', 'callflow']);
    assert.equal(f.calls[1].options.env, environment);
    assert.equal(f.calls[2].options.env, environment);
    await assert.rejects(lstat(f.calls[0].options.env.HOME), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap stops before service mutation when dependency installation fails', async () => {
  const root = await repositoryFixture();
  const f = runnerFixture({ failAt: 1 });
  try {
    await assert.rejects(
      bootstrapOperator({ repositoryRoot: root, environment: { PATH: '/usr/bin:/bin' }, platform: 'linux', runner: f.runner }),
      /operator_bootstrap_dependency_install_failed/
    );
    assert.equal(f.calls.length, 1);
    await assert.rejects(lstat(f.calls[0].options.env.HOME), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap stops before doctor when persistent service bootstrap fails', async () => {
  const root = await repositoryFixture();
  const f = runnerFixture({ failAt: 2 });
  try {
    await assert.rejects(
      bootstrapOperator({ repositoryRoot: root, environment: { PATH: '/usr/bin:/bin' }, platform: 'linux', runner: f.runner }),
      /operator_bootstrap_service_failed/
    );
    assert.equal(f.calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects native Windows before touching repository or commands', async () => {
  const f = runnerFixture();
  await assert.rejects(
    bootstrapOperator({ repositoryRoot: '/does/not/exist', environment: { PATH: 'C:\\Windows' }, platform: 'win32', runner: f.runner }),
    /operator_bootstrap_requires_wsl_or_linux/
  );
  assert.equal(f.calls.length, 0);
});

test('bootstrap refuses symlinked required control files', async () => {
  const root = await repositoryFixture();
  const outside = join(root, 'outside.json');
  const f = runnerFixture();
  try {
    await writeFile(outside, '{}\n');
    await rm(join(root, 'config', 'runtime-images.json'));
    await symlink(outside, join(root, 'config', 'runtime-images.json'));
    await assert.rejects(
      bootstrapOperator({ repositoryRoot: root, environment: { PATH: '/usr/bin:/bin' }, platform: 'linux', runner: f.runner }),
      /operator_bootstrap_required_file_invalid:config\/runtime-images\.json/
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap validates the doctor project identifier before any command', async () => {
  const root = await repositoryFixture();
  const f = runnerFixture();
  try {
    await assert.rejects(
      bootstrapOperator({ repositoryRoot: root, environment: { PATH: '/usr/bin:/bin' }, platform: 'linux', runner: f.runner, project: '../escape' }),
      /operator_bootstrap_project_invalid/
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
