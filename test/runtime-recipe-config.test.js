import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadRuntimeRecipes, projectRuntimeStatus } from '../src/runtime.js';

const LOCAL = 'agent-node22-pnpm11:local';

test('registered local runtime recipe is bound to the exact reviewed Dockerfile', async () => {
  const config = await loadRuntimeRecipes(resolve('config/runtime-images.json'));
  const recipe = config.recipes.find((candidate) => candidate.image === LOCAL);
  assert.ok(recipe, 'LeadFinder local runtime recipe must be registered');
  const content = await readFile(resolve(recipe.dockerfile));
  assert.equal(createHash('sha256').update(content).digest('hex'), recipe.dockerfileSha256);
  assert.match(recipe.fingerprint, /^[a-f0-9]{64}$/);
});

test('default runtime status loads the governed recipe registry without requiring caller plumbing', async () => {
  const runner = async (_command, args) => {
    if (args[0] === 'version') return { exitCode: 0, stdout: '29.0.0\n', stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'missing' };
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
  const result = await projectRuntimeStatus([{ id: 'leadfinder', execution: { image: LOCAL } }], {
    environment: { PATH: '/usr/bin:/bin' },
    commandRunner: runner,
    repositoryRoot: resolve('.')
  });
  assert.equal(result.images[0].recipeManaged, true);
  assert.match(result.images[0].recipeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.images[0].action, 'missing');
});
