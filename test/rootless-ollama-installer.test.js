import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../scripts/install-rootless-ollama.sh', import.meta.url), 'utf8');

test('rootless Ollama installer verifies Arch package and stays local-only', () => {
  assert.match(script, /pacman -Sp/);
  assert.match(script, /pacman-key --verify/);
  assert.match(script, /OLLAMA_HOST=127\.0\.0\.1:11434/);
  assert.match(script, /OLLAMA_NO_CLOUD=true/);
  assert.match(script, /CPUQuota=200%/);
  assert.match(script, /MemoryMax=6G/);
  assert.match(script, /--pull-model/);
  assert.match(script, /qwen2\.5-coder:3b/);
  assert.doesNotMatch(script, /sudo|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY/);
});
