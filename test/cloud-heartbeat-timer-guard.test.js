import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const path = new URL('../scripts/install-cloud-heartbeat-timer-guard.sh', import.meta.url);
const source = readFileSync(path, 'utf8');

test('cloud heartbeat uses an independent recurring calendar', () => {
  const syntax = spawnSync('bash', ['-n', path.pathname], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /OnUnitActiveSec=/);
  assert.match(source, /OnCalendar=\*-\*-\* \*:0\/2:00/);
  assert.match(source, /Persistent=true/);
  assert.match(source, /reset-failed engineering-orchestrator-cloud-heartbeat\.service/);
  assert.match(source, /restart engineering-orchestrator-cloud-heartbeat\.timer/);
});
