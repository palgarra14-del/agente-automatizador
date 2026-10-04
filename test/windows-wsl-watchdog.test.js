import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const watchdog = readFileSync(new URL('../scripts/windows-wsl-watchdog.ps1', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../scripts/install-windows-wsl-watchdog.ps1', import.meta.url), 'utf8');

test('Windows WSL watchdog is bounded and only ensures user services are started', () => {
  assert.match(watchdog, /WaitForExit\(\$timeoutMs\)/);
  assert.match(watchdog, /Stop-Process -Id \$process\.Id -Force/);
  assert.match(watchdog, /\/bin\/true/);
  assert.match(watchdog, /systemctl --user start engineering-orchestrator-inbox\.service/);
  assert.match(watchdog, /actions-runner-callflow\.service/);
  assert.match(watchdog, /actions-runner-leadfinder\.service/);
  assert.match(watchdog, /actions-runner-self\.service/);
  assert.match(watchdog, /engineering-orchestrator-cloud-heartbeat\.timer/);
  assert.doesNotMatch(watchdog, /Restart-Service|wsl\.exe --shutdown|shutdown\.exe|Restart-Computer/i);
  assert.doesNotMatch(watchdog, /token|secret|password|credential/i);
});

test('watchdog installer is current-user, recurring and non-elevated', () => {
  assert.match(installer, /schtasks\.exe \/Create/);
  assert.match(installer, /\/SC MINUTE \/MO \$IntervalMinutes \/F/);
  assert.match(installer, /Copy-Item -LiteralPath \$source -Destination \$destination -Force/);
  assert.doesNotMatch(installer, /\/RL HIGHEST|\/RU SYSTEM|Start-Process[^\n]+-Verb RunAs/i);
  assert.doesNotMatch(installer, /token|secret|password|credential/i);
});
