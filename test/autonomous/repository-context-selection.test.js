import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReadOnlyRepositoryContext, runProcess } from '../../src/core.js';

test('large repositories select a bounded deterministic context instead of failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-context-selection-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Important project overview\n');
    for (let index = 0; index < 36; index += 1) {
      const name = String(index).padStart(2, '0');
      await writeFile(join(root, 'src', `module-${name}.js`), `export const module${index} = ${index};\n`);
    }
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, 'docs', `note-${index}.md`), `note ${index}\n`);
    }
    assert.equal((await runProcess('git', ['init', '--initial-branch=main'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    assert.equal((await runProcess('git', ['add', '.'], { cwd: root, timeoutMs: 5_000 })).ok, true);
    const args = {
      workspace: root,
      project: { changePolicy: { forbiddenPaths: [] } },
      scope: { allowedPaths: ['README.md', 'src', 'docs'], forbiddenPaths: [] },
      limits: {
        maxFiles: 12,
        maxFileBytes: 4 * 1024,
        maxSourceFileBytes: 16 * 1024,
        maxTotalBytes: 24 * 1024,
        maxSourceTotalBytes: 256 * 1024
      }
    };
    const first = await collectReadOnlyRepositoryContext(args);
    const second = await collectReadOnlyRepositoryContext(args);

    assert.equal(first.files.length, 12);
    assert.equal(first.selection.strategy, 'deterministic_relevance_v1');
    assert.equal(first.selection.candidateFiles, 45);
    assert.equal(first.selection.selectedFiles, 12);
    assert.equal(first.selection.omittedFiles, 33);
    assert.ok(first.files.some((file) => file.path === 'README.md'));
    assert.deepEqual(first.files.map((file) => file.path), second.files.map((file) => file.path));
    assert.equal(first.fingerprint, second.fingerprint);
    assert.ok(first.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 24 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
