import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('ignored build command skips unrelated commits but builds control-center commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'vercel-control-scope-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const commit = (message) => {
    git('add', '.');
    git('-c', 'user.name=Agent Test', '-c', 'user.email=agent-test@example.invalid', 'commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const runIgnore = (previous, current) => spawnSync('bash', ['-lc', config.ignoreCommand], {
    cwd: root,
    env: {
      ...process.env,
      VERCEL_GIT_PREVIOUS_SHA: previous,
      VERCEL_GIT_COMMIT_SHA: current
    },
    encoding: 'utf8'
  }).status;

  try {
    git('init');
    mkdirSync(join(root, 'control-center'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'control-center', 'index.html'), 'base\n');
    writeFileSync(join(root, 'src', 'worker.js'), 'base\n');
    const base = commit('base');

    writeFileSync(join(root, 'src', 'worker.js'), 'unrelated\n');
    const unrelated = commit('unrelated');
    assert.equal(runIgnore(base, unrelated), 0, 'unrelated orchestrator change should skip Vercel build');

    writeFileSync(join(root, 'control-center', 'index.html'), 'changed\n');
    const related = commit('control center');
    assert.equal(runIgnore(unrelated, related), 1, 'control-center change should build');

    assert.equal(runIgnore('', related), 1, 'missing previous deployment SHA must fail open to a build');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
