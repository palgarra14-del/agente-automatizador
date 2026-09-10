import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFrom, DockerContainerExecution } from '../src/core.js';

const image = process.argv[2] ?? 'agent-node22-pnpm11:local';
const root = await mkdtemp(join(tmpdir(), 'agent-docker-smoke-'));
const workspace = join(root, 'workspace');
const homeSentinel = join(homedir(), `agent-host-home-${process.pid}`);
const runtimeUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
  ? `${process.getuid()}:${process.getgid()}`
  : '1000:1000';

function smokeProject(commands, timeoutMs) {
  return configFrom({
    id: 'docker-smoke', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.',
    commands, commandEnvironment: { SMOKE_HOST_HOME_SENTINEL: homeSentinel },
    execution: { provider: 'container-required', image, user: runtimeUser, resources: { memoryMb: 128, cpuCount: 1, pidsLimit: 64 } }, budgets: { commandTimeoutMs: timeoutMs }
  }, workspace);
}

try {
  const docker = new DockerContainerExecution();
  const available = await docker.availability(smokeProject({ test: 'node smoke.mjs' }, 10_000));
  if (!available.available) throw new Error(`BLOCKED_EXTERNAL_RUNTIME: ${available.reason}`);
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(homeSentinel, 'host-only');
  await writeFile(join(workspace, 'smoke.mjs'), `
import assert from 'node:assert/strict'; import { access, readdir, writeFile } from 'node:fs/promises'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
const execute = promisify(execFile); assert.match(process.version, /^v22\\./); const pnpm = await execute('pnpm', ['--version']); assert.equal(pnpm.stdout.trim(), '11.19.0');
await writeFile('/workspace/agent-workspace-write-test', 'workspace is writable'); let gitWriteFailed = false; try { await writeFile('/workspace/.git/agent-write-test', 'must not exist'); } catch { gitWriteFailed = true; } assert.equal(gitWriteFailed, true);
await assert.rejects(access(process.env.SMOKE_HOST_HOME_SENTINEL)); for (const path of ['/root/.ssh', '/home/node/.ssh', '/var/run/docker.sock']) await assert.rejects(access(path));
assert.deepEqual((await readdir('/sys/class/net')).sort(), ['lo']); for (const name of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) assert.equal(process.env[name], undefined);
`);
  await writeFile(join(workspace, 'timeout.mjs'), 'setTimeout(() => {}, 30_000);');
  const boundaryProject = smokeProject({ test: 'node smoke.mjs' }, 10_000);
  const smoke = await docker.execute(boundaryProject, 'test', { stage: 'post-worker' });
  assert.equal(smoke.ok, true, smoke.stderr || smoke.stdout);

  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'agent-pnpm-runtime-smoke', private: true, version: '1.0.0', packageManager: 'pnpm@11.19.0', scripts: { test: 'node pnpm-smoke.mjs' }
  }, null, 2));
  await writeFile(join(workspace, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n  .: {}\n");
  await writeFile(join(workspace, 'pnpm-smoke.mjs'), "console.log('pnpm project command PASS');\n");
  const pnpmProject = smokeProject({ install: 'pnpm install --frozen-lockfile', test: 'pnpm test' }, 30_000);
  const install = await docker.execute(pnpmProject, 'install', { stage: 'bootstrap' });
  assert.equal(install.ok, true, install.stderr || install.stdout);
  const pnpmTest = await docker.execute(pnpmProject, 'test', { stage: 'post-worker' });
  assert.equal(pnpmTest.ok, true, pnpmTest.stderr || pnpmTest.stdout);

  const timeoutProject = smokeProject({ test: 'node timeout.mjs' }, 1_500);
  const timeout = await docker.execute(timeoutProject, 'test', { stage: 'post-worker' });
  assert.equal(timeout.timedOut, true, timeout.stderr || timeout.stdout); assert.equal(timeout.cleanup?.attempted, true);
  console.log(`docker integration smoke PASS (${runtimeUser})`);
} finally { await rm(homeSentinel, { force: true }); await rm(root, { recursive: true, force: true }); }
