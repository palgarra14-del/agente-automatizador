import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isDigestPinnedRuntimeImage,
  loadRuntimeImageConfig,
  normalizeRuntimeImageConfig,
  projectRuntimeStatus,
  syncProjectRuntimes
} from '../src/runtime.js';

const PINNED = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const LOCAL = 'agent-node22-pnpm11:local';
const DOCKERFILE = 'FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5\nRUN echo ok\n';

function projects() {
  return [
    { id: 'self', execution: { image: PINNED } },
    { id: 'callflow', execution: { image: PINNED } },
    { id: 'leadfinder', execution: { image: LOCAL } }
  ];
}

function buildConfig(contents = DOCKERFILE) {
  return normalizeRuntimeImageConfig({
    version: 1,
    builds: [{
      image: LOCAL,
      context: 'docker/node22-pnpm11',
      files: [{ path: 'Dockerfile', sha256: createHash('sha256').update(contents).digest('hex') }]
    }]
  });
}

async function buildRepository(contents = DOCKERFILE) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-repo-'));
  const context = join(root, 'docker', 'node22-pnpm11');
  await mkdir(context, { recursive: true });
  await writeFile(join(context, 'Dockerfile'), contents);
  return { root, context };
}

function fixture({
  dockerAvailable = true,
  present = [],
  labels = {},
  pullFails = false,
  pullPersists = true,
  buildFails = false,
  buildPersists = true
} = {}) {
  const images = new Map(present.map((image) => [image, { id: `sha256:${'a'.repeat(64)}`, label: labels[image] ?? null }]));
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, 'docker');
    if (args[0] === 'version') return dockerAvailable
      ? { exitCode: 0, stdout: '29.0.0\n', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'unavailable' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args[2];
      const record = images.get(image);
      if (!record) return { exitCode: 1, stdout: '', stderr: 'missing' };
      const format = args[args.indexOf('--format') + 1] ?? '';
      if (format.includes('Config.Labels')) return { exitCode: 0, stdout: `${record.label ?? '<no value>'}\n`, stderr: '' };
      return { exitCode: 0, stdout: `${record.id}\n`, stderr: '' };
    }
    if (args.includes('pull')) {
      const image = args.at(-1);
      if (pullFails) return { exitCode: 1, stdout: '', stderr: 'denied' };
      if (pullPersists) images.set(image, { id: `sha256:${'b'.repeat(64)}`, label: null });
      return { exitCode: 0, stdout: image, stderr: '' };
    }
    if (args.includes('build')) {
      const image = args[args.indexOf('--tag') + 1];
      const label = args[args.indexOf('--label') + 1]?.split('=').slice(1).join('=') ?? null;
      if (buildFails) return { exitCode: 1, stdout: '', stderr: 'build failed' };
      if (buildPersists) images.set(image, { id: `sha256:${'c'.repeat(64)}`, label });
      return { exitCode: 0, stdout: 'built', stderr: '' };
    }
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
  return { runner, calls, images };
}

test('runtime image policy recognizes only exact digest-pinned references', () => {
  assert.equal(isDigestPinnedRuntimeImage(PINNED), true);
  assert.equal(isDigestPinnedRuntimeImage('node:22-bookworm-slim'), false);
  assert.equal(isDigestPinnedRuntimeImage(LOCAL), false);
  assert.equal(isDigestPinnedRuntimeImage(`${PINNED} extra`), false);
});

test('runtime build configuration is strict, unique, and repository-relative', () => {
  const valid = buildConfig();
  assert.equal(valid.builds.length, 1);
  assert.match(valid.builds[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => normalizeRuntimeImageConfig({
    version: 1,
    builds: [
      { image: LOCAL, context: '../escape', files: [{ path: 'Dockerfile', sha256: 'a'.repeat(64) }] }
    ]
  }), /context_invalid/);
  assert.throws(() => normalizeRuntimeImageConfig({
    version: 1,
    builds: [
      { image: PINNED, context: 'docker/x', files: [{ path: 'Dockerfile', sha256: 'a'.repeat(64) }] }
    ]
  }), /image_invalid/);
  assert.throws(() => normalizeRuntimeImageConfig({
    version: 1,
    builds: [
      { image: LOCAL, context: 'docker/x', files: [{ path: 'Dockerfile', sha256: 'a'.repeat(64) }] },
      { image: LOCAL, context: 'docker/y', files: [{ path: 'Dockerfile', sha256: 'b'.repeat(64) }] }
    ]
  }), /duplicate/);
});

test('runtime config loader rejects symlinked configuration files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-config-'));
  try {
    const real = join(root, 'real.json');
    const linked = join(root, 'runtime-images.json');
    await writeFile(real, JSON.stringify(buildConfig()));
    await symlink(real, linked);
    await assert.rejects(loadRuntimeImageConfig(linked), /runtime_image_config_file_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime status deduplicates shared images and never writes', async () => {
  const f = fixture({ present: [PINNED] });
  const status = await projectRuntimeStatus(projects(), { environment: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'do-not-forward' }, commandRunner: f.runner });
  assert.equal(status.ready, false);
  assert.equal(status.managedReady, true);
  assert.equal(status.images.length, 2);
  const pinned = status.images.find((entry) => entry.image === PINNED);
  assert.deepEqual(pinned.projects, ['callflow', 'self']);
  assert.equal(pinned.action, 'present');
  assert.equal(status.images.find((entry) => entry.image === LOCAL).action, 'missing');
  assert.equal(f.calls.some((call) => call.args.includes('pull') || call.args.includes('build')), false);
  for (const call of f.calls) {
    assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', CI: 'true' });
    assert.equal(call.options.env.GITHUB_TOKEN, undefined);
    assert.equal(call.options.env.HOME, undefined);
  }
});

test('runtime sync pulls each missing digest-pinned image exactly once and verifies it', async () => {
  const f = fixture();
  const result = await syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner });
  assert.equal(result.managedReady, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingUnmanaged, [LOCAL]);
  assert.equal(result.images.find((entry) => entry.image === PINNED).action, 'pulled');
  assert.equal(result.images.find((entry) => entry.image === LOCAL).action, 'manual');
  const pulls = f.calls.filter((call) => call.args.includes('pull'));
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].args[0], '--config');
  assert.match(pulls[0].args[1], /engineering-orchestrator-docker-/);
  assert.deepEqual(pulls[0].args.slice(2), ['pull', '--quiet', PINNED]);
  assert.equal(pulls[0].options.env.HOME, undefined);
  assert.equal(pulls[0].options.env.GITHUB_TOKEN, undefined);
  await assert.rejects(lstat(pulls[0].args[1]), /ENOENT/);
});

test('managed local runtime is built only from the verified staged recipe and becomes trusted', async () => {
  const repoFixture = await buildRepository();
  const config = buildConfig();
  const f = fixture({ present: [PINNED] });
  try {
    const result = await syncProjectRuntimes(projects(), {
      buildConfig: config,
      repositoryRoot: repoFixture.root,
      environment: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'never-forward' },
      commandRunner: f.runner
    });
    assert.equal(result.ready, true);
    assert.equal(result.managedReady, true);
    const local = result.images.find((entry) => entry.image === LOCAL);
    assert.equal(local.action, 'built');
    assert.equal(local.trusted, true);
    const builds = f.calls.filter((call) => call.args.includes('build'));
    assert.equal(builds.length, 1);
    const build = builds[0];
    assert.equal(build.args[0], '--config');
    assert.match(build.args[1], /engineering-orchestrator-docker-/);
    assert.ok(build.args.includes('--pull=false'));
    assert.equal(build.args[build.args.indexOf('--tag') + 1], LOCAL);
    assert.equal(build.args[build.args.indexOf('--label') + 1], `engineering-orchestrator.recipe-sha256=${config.builds[0].fingerprint}`);
    const stagedContext = build.args.at(-1);
    assert.match(stagedContext, /engineering-orchestrator-build-/);
    await assert.rejects(lstat(stagedContext), /ENOENT/);
    await assert.rejects(lstat(build.args[1]), /ENOENT/);
    assert.equal(build.options.env.GITHUB_TOKEN, undefined);
    assert.equal(build.options.env.HOME, undefined);

    const status = await projectRuntimeStatus(projects(), {
      buildConfig: config,
      repositoryRoot: repoFixture.root,
      environment: { PATH: '/usr/bin:/bin' },
      commandRunner: f.runner
    });
    assert.equal(status.ready, true);
    assert.equal(status.images.find((entry) => entry.image === LOCAL).action, 'present');
    assert.equal(status.images.find((entry) => entry.image === LOCAL).trusted, true);
  } finally {
    await rm(repoFixture.root, { recursive: true, force: true });
  }
});

test('managed local runtime with a missing or wrong recipe label is rebuilt', async () => {
  const repoFixture = await buildRepository();
  const config = buildConfig();
  const f = fixture({ present: [PINNED, LOCAL], labels: { [LOCAL]: 'wrong' } });
  try {
    const result = await syncProjectRuntimes(projects(), {
      buildConfig: config,
      repositoryRoot: repoFixture.root,
      environment: { PATH: '/usr/bin:/bin' },
      commandRunner: f.runner
    });
    assert.equal(result.images.find((entry) => entry.image === LOCAL).action, 'rebuilt');
    assert.equal(f.calls.filter((call) => call.args.includes('build')).length, 1);
  } finally {
    await rm(repoFixture.root, { recursive: true, force: true });
  }
});

test('managed local build fails closed on context drift, extra files, or build failure', async () => {
  const repoFixture = await buildRepository();
  const config = buildConfig();
  try {
    await writeFile(join(repoFixture.context, 'Dockerfile'), `${DOCKERFILE}# tampered\n`);
    const tampered = fixture({ present: [PINNED] });
    await assert.rejects(
      syncProjectRuntimes(projects(), {
        buildConfig: config,
        repositoryRoot: repoFixture.root,
        environment: { PATH: '/usr/bin:/bin' },
        commandRunner: tampered.runner
      }),
      /runtime_build_context_hash_mismatch:Dockerfile/
    );
    assert.equal(tampered.calls.some((call) => call.args.includes('build')), false);

    await writeFile(join(repoFixture.context, 'Dockerfile'), DOCKERFILE);
    await writeFile(join(repoFixture.context, 'unexpected.txt'), 'do not include');
    const extra = fixture({ present: [PINNED] });
    await assert.rejects(
      syncProjectRuntimes(projects(), {
        buildConfig: config,
        repositoryRoot: repoFixture.root,
        environment: { PATH: '/usr/bin:/bin' },
        commandRunner: extra.runner
      }),
      /runtime_build_context_manifest_mismatch/
    );
    assert.equal(extra.calls.some((call) => call.args.includes('build')), false);

    await rm(join(repoFixture.context, 'unexpected.txt'));
    const failed = fixture({ present: [PINNED], buildFails: true });
    await assert.rejects(
      syncProjectRuntimes(projects(), {
        buildConfig: config,
        repositoryRoot: repoFixture.root,
        environment: { PATH: '/usr/bin:/bin' },
        commandRunner: failed.runner
      }),
      /runtime_image_build_failed:agent-node22-pnpm11:local/
    );
  } finally {
    await rm(repoFixture.root, { recursive: true, force: true });
  }
});

test('runtime sync performs no pull or build when configured images are already trusted/present', async () => {
  const repoFixture = await buildRepository();
  const config = buildConfig();
  const f = fixture({
    present: [PINNED, LOCAL],
    labels: { [LOCAL]: config.builds[0].fingerprint }
  });
  try {
    const result = await syncProjectRuntimes(projects(), {
      buildConfig: config,
      repositoryRoot: repoFixture.root,
      environment: { PATH: '/usr/bin:/bin' },
      commandRunner: f.runner
    });
    assert.equal(result.ready, true);
    assert.equal(result.images.every((entry) => entry.action === 'present'), true);
    assert.equal(f.calls.some((call) => call.args.includes('pull') || call.args.includes('build')), false);
  } finally {
    await rm(repoFixture.root, { recursive: true, force: true });
  }
});

test('runtime sync fails closed when Docker, a managed pull, or build verification is unavailable', async () => {
  const unavailable = fixture({ dockerAvailable: false });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: unavailable.runner }),
    /docker_runtime_unavailable/
  );

  const failingPull = fixture({ pullFails: true });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: failingPull.runner }),
    /runtime_image_pull_failed:node:22-bookworm-slim@sha256:/
  );

  const invisiblePull = fixture({ pullPersists: false });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: invisiblePull.runner }),
    /runtime_image_pull_verification_failed:node:22-bookworm-slim@sha256:/
  );

  const repoFixture = await buildRepository();
  try {
    const config = buildConfig();
    const invisibleBuild = fixture({ present: [PINNED], buildPersists: false });
    await assert.rejects(
      syncProjectRuntimes(projects(), {
        buildConfig: config,
        repositoryRoot: repoFixture.root,
        environment: { PATH: '/usr/bin:/bin' },
        commandRunner: invisibleBuild.runner
      }),
      /runtime_image_build_verification_failed:agent-node22-pnpm11:local/
    );
  } finally {
    await rm(repoFixture.root, { recursive: true, force: true });
  }
});

test('runtime sync validates networked maintenance timeouts before touching Docker', async () => {
  const f = fixture();
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, pullTimeoutMs: 999 }),
    /runtime_pull_timeout_invalid/
  );
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, buildTimeoutMs: 999 }),
    /runtime_build_timeout_invalid/
  );
  assert.equal(f.calls.length, 0);
});
