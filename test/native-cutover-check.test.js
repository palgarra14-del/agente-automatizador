import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../scripts/native-cutover-check.sh', import.meta.url), 'utf8');

test('native cutover checker is read-only and requires pause throughout cutover', () => {
  assert.match(script, /AGENT_GLOBAL_PAUSE/);
  assert.match(script, /global pause is enabled/);
  assert.match(script, /migration\/native-linux-cutover/);
  assert.match(script, /post-cutover branch is main/);
  assert.match(script, /ARCH-orchestrator/);
  assert.match(script, /qwen2\.5-coder:3b/);
  assert.match(script, /engineering-orchestrator-upgrade\.timer/);
  assert.match(script, /XDG_RUNTIME_DIR="\/run\/user\/\$\(id -u\)"/);
  assert.doesNotMatch(script, /git\s+(?:merge|reset|checkout|switch|pull|push)\b/);
  assert.doesNotMatch(script, /gh\s+pr\s+merge\b/);
  assert.doesNotMatch(script, /gh\s+variable\s+set\b/);
  assert.doesNotMatch(script, /systemctl(?:\s+--user)?\s+(?:start|restart|enable|disable|stop)\b/);
  assert.doesNotMatch(script, /rm\s+-|unlink\b|kill\b/);
});
