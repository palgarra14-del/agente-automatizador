import assert from 'node:assert/strict';
import test from 'node:test';
import { isDigestPinnedRuntimeImage, projectRuntimeStatus, syncProjectRuntimes } from '../src/runtime.js';

const PINNED = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const LOCAL = 'agent-node22-pnpm11:local';

function projects() {
  return [
    { id: 'self', execution: { image: PINNED } },
    { id: 'callflow', execution: { image: PINNED } },
    { id: 'leadfinder', execution: { image: LOCAL } }
  ];
}

function fixture({ dockerAvailable = true, present = [], pullFails = false, pullPersists = true } = {}) {
  const images = new Set(present);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, 'docker');
    if (args[0] === 'version') return dockerAvailable
      ? { exitCode: 0, stdout: '29.0.0\n', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'unavailable' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args[2];
      return images.has(image)
        ? { exitCode: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'missing' };
    }
    if (args[0] === 'pull') {
      const image = args.at(-1);
      if (pullFails) return { exitCode: 1, stdout: '', stderr: 'denied' };
      if (pullPersists) images.add(image);
      return { exitCode: 0, stdout: image, stderr: '' };
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
  assert.equal(f.calls.some((call) => call.args[0] === 'pull'), false);
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
  const pulls = f.calls.filter((call) => call.args[0] === 'pull');
  assert.equal(pulls.length, 1);
  assert.deepEqual(pulls[0].args, ['pull', '--quiet', PINNED]);
});

test('runtime sync performs no pull when configured images are already present', async () => {
  const f = fixture({ present: [PINNED, LOCAL] });
  const result = await syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner });
  assert.equal(result.ready, true);
  assert.equal(result.images.every((entry) => entry.action === 'present'), true);
  assert.equal(f.calls.some((call) => call.args[0] === 'pull'), false);
});

test('runtime sync fails closed when Docker or a managed pull is unavailable', async () => {
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
});

test('runtime sync verifies a successful pull actually made the exact image inspectable', async () => {
  const f = fixture({ pullPersists: false });
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner }),
    /runtime_image_pull_verification_failed:node:22-bookworm-slim@sha256:/
  );
});

test('runtime sync validates its networked pull timeout before touching Docker', async () => {
  const f = fixture();
  await assert.rejects(
    syncProjectRuntimes(projects(), { environment: { PATH: '/usr/bin:/bin' }, commandRunner: f.runner, pullTimeoutMs: 999 }),
    /runtime_pull_timeout_invalid/
  );
  assert.equal(f.calls.length, 0);
});
