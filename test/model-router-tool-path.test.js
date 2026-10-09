import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const routerDir = resolve('scripts/design-lab');

test('model CLI discovery uses current HOME even when systemd PATH hides user tools', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-cli-home-'));
  try {
    const makeExecutable = (relative) => {
      const path = join(home, relative);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o700);
      return path;
    };
    const agy = makeExecutable('.local/bin/agy');
    const opencode = makeExecutable('.opencode/bin/opencode');
    const codex = makeExecutable('.nvm/versions/node/v22.23.2/bin/codex');
    const script = [
      'import json, shutil, sys',
      'shutil.which = lambda name: None',
      'sys.path.insert(0, sys.argv[1])',
      'import model_router',
      'print(json.dumps({"agy": model_router.AGY, "opencode": model_router.OPENCODE, "codex": model_router.CODEX}))'
    ].join('\n');
    const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' };
    delete env.ANTIGRAVITY_CLI;
    delete env.OPENCODE_BIN;
    delete env.CODEX_BIN;
    const run = spawnSync('python3', ['-c', script, routerDir], {
      env, encoding: 'utf8', timeout: 15_000
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { agy, opencode, codex });

    const overridden = spawnSync('python3', ['-c', script, routerDir], {
      env: { ...env, CODEX_BIN: '/usr/local/custom/codex' },
      encoding: 'utf8', timeout: 15_000
    });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(JSON.parse(overridden.stdout).codex, '/usr/local/custom/codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unavailable Antigravity is probed once per routing wave and rechecked after cooldown', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-readiness-home-'));
  try {
    const agy = join(home, '.local/bin/agy');
    mkdirSync(resolve(agy, '..'), { recursive: true });
    writeFileSync(agy, '#!/bin/sh\nexit 0\n');
    chmodSync(agy, 0o700);
    const script = [
      'import json, sys, time, types',
      'sys.path.insert(0, sys.argv[1])',
      'import model_router',
      'model_router.AGY = sys.argv[2]',
      'calls = []',
      'def mock_run(args, timeout=None, **kwargs):',
      '    calls.append(timeout)',
      '    return types.SimpleNamespace(returncode=1,stdout="",stderr="please sign in")',
      'model_router._run = mock_run',
      'assert model_router.antigravity_authenticated() is False',
      'assert model_router.antigravity_authenticated() is False',
      'assert calls == [12], calls',
      'model_router._ANTIGRAVITY_AUTH_CACHE["checkedAt"] -= 31',
      'assert model_router.antigravity_authenticated() is False',
      'assert calls == [12, 12], calls',
      'print("ok")'
    ].join('\n');
    const result = spawnSync('python3', ['-c', script, routerDir, agy], {
      env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
