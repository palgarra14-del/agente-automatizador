import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isDigestPinnedRuntimeImage, loadRuntimeRecipes, normalizeRuntimeRecipes, projectRuntimeStatus, syncProjectRuntimes } from '../src/runtime.js';

const PINNED = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const LOCAL = 'agent-node22-pnpm11:local';
const EMPTY_RECIPES = { version: 1, recipes: [] };

function projects() {
  return [
    { id: 'self', execution: { image: PINNED } },
    { id: 'callflow', execution: { image: PINNED } },
    { id: 'leadfinder', execution: { image: LOCAL } }
  ];
}

function fixture({ dockerAvailable = true, dockerProbeFailures = 0, present = [], pullFails = false, pullPersists = true, buildFails = false, buildPersists = true } = {}) {
  const images = new Map(present.map((entry) => typeof entry === 'string'
    ? [entry, { id: `sha256:${'a'.repeat(64)}`, recipeFingerprint: null }]
    : [entry.image, { id: entry.id ?? `sha256:${'a'.repeat(64)}`, recipeFingerprint: entry.recipeFingerprint ?? null }]));
  const calls = [];
  let probeCount = 0;
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, 'docker');
    if (args[0] === 'version') {
      probeCount += 1;
      return dockerAvailable && probeCount > dockerProbeFailures
        ? { exitCode: 0, stdout: '29.0.0\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'unavailable' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = images.get(args[2]);
      if (!image) return { exitCode: 1, stdout: '', stderr: 'missing' };
      const format = args.at(-1);
      if (format === '{{.Id}}') return { exitCode: 0, stdout: `${image.id}\n`, stderr: '' };
      if (format.includes('engineering-orchestrator.runtime.recipe-sha256')) return { exitCode: 0, stdout: `${image.recipeFingerprint ?? ''}\n`, stderr: '' };
      throw new Error(`unexpected image inspect format: ${format}`);
    }
    if (args.includes('pull')) {
      const image = args.at(-1);
      if (pullFails) return { exitCode: 1, stdout: '', stderr: 'denied' };
      if (pullPersists) images.set(image, { id: `sha256:${'b'.repeat(64)}`, recipeFingerprint: null });
      return { exitCode: 0, stdout: image, stderr: '' };
    }
    if (args.includes('build')) {
      if (buildFails) return { exitCode: 1, stdout: '', stderr: 'build denied' };
      const tagIndex = args.indexOf('--tag');
      const labelIndex = args.indexOf('--label');
      const image = args[tagIndex + 1];
      const label = args[labelIndex + 1];
      const recipeFingerprint = label.split('=').at(-1);
      if (buildPersists) images.set(image, { id: `sha256:${'c'.repeat(64)}`, recipeFingerprint });
      return { exitCode: 0, stdout: 'built', stderr: '' };
    }
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
  return { runner, calls, images };
}

async function recipeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-recipe-'));
  const context = join(root, 'docker', 'node22-pnpm11');
  await mkdir(context, { recursive: true });
  const dockerfile = 'FROM scratch\nLABEL purpose="runtime-test"\n';
  await writeFile(join(context, 'Dockerfile'), dockerfile, { mode: 0o600 });
  const runtimeRecipes = {
    version: 1,
    recipes: [{
      image: LOCAL,
      context: 'docker/node22-pnpm11',
      dockerfile: 'docker/node22-pnpm11/Dockerfile',
      dockerfileSha256: createHash('sha256').update(dockerfile).digest('hex')
    }]
  };
  return { root, context, dockerfile, runtimeRecipes };
}

test('runtime image policy recognizes only exact digest-pinned references', () => {
  assert.equal(isDigestPinnedRuntimeImage(PINNED), true);
  assert.equal(isDigestPinnedRuntimeImage('node:22-bookworm-slim'), false);
  assert.equal(isDigestPinnedRuntimeImage(LOCAL), false);
  assert.equal(isDigestPinnedRuntimeImage(`${PINNED} extra`), false);
});

test('runtime status deduplicates shared images and never writes', async () => {
  const f = fixture({ present: [PINNED] });
  const status = await projectRuntimeStatus(projects(), { environment: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'do-not-forward' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES });
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
  const result = await syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES });
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

test('runtime sync performs no pull when configured images are already present', async () => {
  const f = fixture({ present: [PINNED, LOCAL] });
  const result = await syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES });
  assert.equal(result.ready, true);
  assert.equal(result.images.every((entry) => entry.action === 'present'), true);
  assert.equal(f.calls.some((call) => call.args.includes('pull')), false);
});

test('runtime sync fails closed when Docker or a managed pull is unavailable', async () => {
  const unavailable = fixture({ dockerAvailable: false });
  await assert.rejects(
    syncProjectRuntimes(projects(), {
      environment: { PATH: '/usr/bin:/bin' },
      commandRunner: unavailable.runner,
      runtimeRecipes: EMPTY_RECIPES,
      dockerProbeRetryDelaysMs: [0, 0],
      sleep: async () => {}
    }),
    /docker_runtime_unavailable/
  );
  assert.equal(unavailable.calls.filter((call) => call.args[0] === 'version').length, 3);

  const failingPull = fixture({ pullFails: true });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: failingPull.runner, runtimeRecipes: EMPTY_RECIPES }),
    /runtime_image_pull_failed:node:22-bookworm-slim@sha256:/
  );
});

test('runtime sync retries only transient Docker probe unavailability before continuing', async () => {
  const f = fixture({ dockerProbeFailures: 2, present: [PINNED, LOCAL] });
  const sleeps = [];
  const result = await syncProjectRuntimes(projects(), {
    environment: { PATH: '/usr/bin:/bin' },
    commandRunner: f.runner,
    runtimeRecipes: EMPTY_RECIPES,
    dockerProbeRetryDelaysMs: [5, 10],
    sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.equal(result.ready, true);
  assert.equal(result.docker.available, true);
  assert.equal(result.docker.attempts, 3);
  assert.deepEqual(sleeps, [5, 10]);
  assert.equal(f.calls.filter((call) => call.args[0] === 'version').length, 3);
});

test('runtime sync validates Docker probe retry policy before touching Docker', async () => {
  const f = fixture();
  await assert.rejects(
    syncProjectRuntimes(projects(), {
      environment: { PATH: '/usr/bin:/bin' },
      commandRunner: f.runner,
      runtimeRecipes: EMPTY_RECIPES,
      dockerProbeRetryDelaysMs: [31_000]
    }),
    /runtime_docker_probe_retry_delays_invalid/
  );
  assert.equal(f.calls.length, 0);
});

test('runtime sync verifies a successful pull actually made the exact image inspectable', async () => {
  const f = fixture({ pullPersists: false });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES }),
    /runtime_image_pull_verification_failed:node:22-bookworm-slim@sha256:/
  );
});

test('runtime sync validates its networked timeouts before touching Docker', async () => {
  const f = fixture();
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES, pullTimeoutMs: 999 }),
    /runtime_pull_timeout_invalid/
  );
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: EMPTY_RECIPES, buildTimeoutMs: 999 }),
    /runtime_build_timeout_invalid/
  );
  assert.equal(f.calls.length, 0);
});

test('runtime recipe config is strict, bounded, unique, and loads only a real file', async () => {
  const fixtureData = await recipeFixture();
  try {
    const configDir = join(fixtureData.root, 'config');
    await mkdir(configDir);
    const configFile = join(configDir, 'runtime-images.json');
    await writeFile(configFile, JSON.stringify(fixtureData.runtimeRecipes));
    const loaded = await loadRuntimeRecipes(configFile);
    assert.equal(loaded.recipes.length, 1);
    assert.match(loaded.recipes[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.throws(() => normalizeRuntimeRecipes({ version: 1, recipes: [{ ...fixtureData.runtimeRecipes.recipes[0], context: '../escape' }] }), /runtime_recipe_context_invalid/);
    assert.throws(() => normalizeRuntimeRecipes({ version: 1, recipes: [fixtureData.runtimeRecipes.recipes[0], fixtureData.runtimeRecipes.recipes[0]] }), /runtime_recipe_duplicate_image/);
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('runtime sync builds a missing local image only from its exact reviewed recipe', async () => {
  const fixtureData = await recipeFixture();
  const f = fixture();
  try {
    const result = await syncProjectRuntimes([{ id: 'leadfinder', execution: { image: LOCAL } }], {
      environment: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'do-not-forward' },
      commandRunner: f.runner,
      runtimeRecipes: fixtureData.runtimeRecipes,
      repositoryRoot: fixtureData.root
    });
    assert.equal(result.ready, true);
    assert.equal(result.managedReady, true);
    assert.equal(result.images[0].action, 'built');
    assert.equal(result.images[0].recipeVerified, true);
    const builds = f.calls.filter((call) => call.args.includes('build'));
    assert.equal(builds.length, 1);
    const build = builds[0];
    assert.equal(build.args[0], '--config');
    assert.match(build.args[1], /engineering-orchestrator-docker-/);
    assert.equal(build.args.includes('--pull=false'), true);
    assert.equal(build.args[build.args.indexOf('--tag') + 1], LOCAL);
    assert.match(build.args[build.args.indexOf('--label') + 1], /^engineering-orchestrator\.runtime\.recipe-sha256=[a-f0-9]{64}$/);
    assert.equal(build.args.at(-1), fixtureData.context);
    assert.equal(build.options.env.GITHUB_TOKEN, undefined);
    assert.equal(build.options.env.HOME, undefined);
    await assert.rejects(lstat(build.args[1]), /ENOENT/);
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('runtime status rejects a same-name local image whose recipe fingerprint is missing or stale', async () => {
  const fixtureData = await recipeFixture();
  const f = fixture({ present: [LOCAL] });
  try {
    const status = await projectRuntimeStatus([{ id: 'leadfinder', execution: { image: LOCAL } }], {
      environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: fixtureData.runtimeRecipes, repositoryRoot: fixtureData.root
    });
    assert.equal(status.ready, false);
    assert.equal(status.managedReady, false);
    assert.equal(status.images[0].action, 'stale-recipe');
    assert.equal(status.images[0].recipeVerified, false);
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('runtime sync rebuilds a stale same-name image and verifies the new recipe label', async () => {
  const fixtureData = await recipeFixture();
  const f = fixture({ present: [LOCAL] });
  try {
    const result = await syncProjectRuntimes([{ id: 'leadfinder', execution: { image: LOCAL } }], {
      environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: fixtureData.runtimeRecipes, repositoryRoot: fixtureData.root
    });
    assert.equal(result.images[0].action, 'rebuilt');
    assert.equal(result.images[0].recipeVerified, true);
    assert.equal(f.calls.filter((call) => call.args.includes('build')).length, 1);
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('runtime sync refuses recipe drift before invoking Docker build', async () => {
  const fixtureData = await recipeFixture();
  const f = fixture();
  try {
    await writeFile(join(fixtureData.context, 'Dockerfile'), 'FROM scratch\nRUN echo tampered\n');
    await assert.rejects(
      syncProjectRuntimes([{ id: 'leadfinder', execution: { image: LOCAL } }], {
        environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: fixtureData.runtimeRecipes, repositoryRoot: fixtureData.root
      }),
      /runtime_recipe_dockerfile_hash_mismatch/
    );
    assert.equal(f.calls.some((call) => call.args.includes('build')), false);
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('runtime sync fails if Docker reports build success without producing the recipe-bound image', async () => {
  const fixtureData = await recipeFixture();
  const f = fixture({ buildPersists: false });
  try {
    await assert.rejects(
      syncProjectRuntimes([{ id: 'leadfinder', execution: { image: LOCAL } }], {
        environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, runtimeRecipes: fixtureData.runtimeRecipes, repositoryRoot: fixtureData.root
      }),
      /runtime_image_build_verification_failed:agent-node22-pnpm11:local/
    );
  } finally {
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});
