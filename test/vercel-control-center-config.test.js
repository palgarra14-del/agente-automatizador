import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('Vercel deploys the control center but skips unrelated orchestrator changes', () => {
  assert.equal(config.outputDirectory, 'control-center/public');
  assert.equal(config.git?.deploymentEnabled?.main, true);
  assert.equal(config.git?.deploymentEnabled?.['*'], false);
  assert.equal(typeof config.ignoreCommand, 'string');
  assert.match(config.ignoreCommand, /VERCEL_GIT_PREVIOUS_SHA/);
  assert.match(config.ignoreCommand, /VERCEL_GIT_COMMIT_SHA/);
  for (const path of [
    'api/control-proxy.mjs',
    'control-center',
    'vercel.json',
    'package.json',
    'package-lock.json'
  ]) assert.ok(config.ignoreCommand.includes(path));
  for (const unrelated of [' src/', ' scripts/', ' test/']) assert.equal(config.ignoreCommand.includes(unrelated), false);
});

test('ignored build command fails open to a real build when previous deployment sha is unavailable', () => {
  assert.match(config.ignoreCommand, /^test -n "\$VERCEL_GIT_PREVIOUS_SHA" && /);
});
