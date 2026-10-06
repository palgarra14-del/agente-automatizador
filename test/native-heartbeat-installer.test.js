import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../scripts/install-native-heartbeat.sh', import.meta.url), 'utf8');

test('native heartbeat installer is explicit, local-primary, and secret-free', () => {
  assert.match(script, /managed-by=engineering-orchestrator:native-heartbeat:v1/);
  assert.match(script, /AGENT_HEARTBEAT_EXECUTION_MODE=local-primary/);
  assert.match(script, /MODEL_COST_POLICY/);
  assert.match(script, /--enable/);
  assert.match(script, /OnCalendar=\*-\*-\* \*:0\/2:00/);
  assert.match(script, /XDG_RUNTIME_DIR="\/run\/user\/\$\(id -u\)"/);
  assert.doesNotMatch(script, /GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|PAID_MODELS_EXPLICITLY_ENABLED/);
});
