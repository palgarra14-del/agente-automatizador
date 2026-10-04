import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const path = new URL('../scripts/install-ollama-resource-guard.sh', import.meta.url);
const source = readFileSync(path, 'utf8');

test('Ollama resource guard protects the commercial control plane', () => {
  const syntax = spawnSync('bash', ['-n', path.pathname], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /MemoryHigh=4G/);
  assert.match(source, /MemoryMax=5G/);
  assert.match(source, /MemorySwapMax=768M/);
  assert.match(source, /OLLAMA_KEEP_ALIVE=30s/);
  assert.match(source, /OOMPolicy=stop/);
  assert.match(source, /systemctl --user try-restart ollama-local\.service/);
});
