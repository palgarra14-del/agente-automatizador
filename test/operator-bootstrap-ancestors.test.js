import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapOperator } from '../scripts/bootstrap-operator.js';

test('operator bootstrap rejects a symlinked control-directory ancestor before running npm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-bootstrap-parent-'));
  const outside = await mkdtemp(join(tmpdir(), 'operator-bootstrap-outside-'));
  let calls = 0;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'package-lock.json'), '{}\n');
    await writeFile(join(root, 'src', 'cli.js'), '// fixture\n');
    await writeFile(join(outside, 'projects.json'), '{}\n');
    await writeFile(join(outside, 'runtime-images.json'), '{}\n');
    await symlink(outside, join(root, 'config'), 'dir');

    await assert.rejects(
      bootstrapOperator({
        repositoryRoot: root,
        environment: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        runner: async () => { calls += 1; return { exitCode: 0, signal: null }; }
      }),
      /operator_bootstrap_required_file_invalid:config\/projects\.json/
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
