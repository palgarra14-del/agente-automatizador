import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/agent-cloud.yml', import.meta.url), 'utf8');
const heartbeat = readFileSync(new URL('../scripts/cloud-heartbeat.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../control-center/server.mjs', import.meta.url), 'utf8');
const app = readFileSync(new URL('../control-center/public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../control-center/public/index.html', import.meta.url), 'utf8');

test('GitHub watchdog routing honors operator global and per-lane pauses', () => {
  assert.match(workflow, /AGENT_GLOBAL_PAUSE: \$\{\{ vars\.AGENT_GLOBAL_PAUSE \}\}/);
  assert.match(workflow, /AGENT_PAUSED_LANES: \$\{\{ vars\.AGENT_PAUSED_LANES \}\}/);
  assert.match(workflow, /active: \$\{\{ steps\.route\.outputs\.active \}\}/);
  assert.match(workflow, /Operator pause prevented this cloud wakeup/);
});

test('MSI heartbeat reads the same durable operator controls before dispatching', () => {
  assert.match(heartbeat, /actions\/variables\/\$\{name\}/);
  assert.match(heartbeat, /AGENT_GLOBAL_PAUSE/);
  assert.match(heartbeat, /AGENT_PAUSED_LANES/);
  assert.match(heartbeat, /operatorControl\.globalPause/);
  assert.match(heartbeat, /pausedLanes\.includes\(lane\)/);
});

test('Control Center exposes governed pause controls without arbitrary shell access', () => {
  assert.match(server, /\/api\/control\/global/);
  assert.match(server, /\/api\/control\/lane/);
  assert.match(server, /gh', \['variable', 'set'/);
  assert.match(server, /systemctl', \['--user', 'start', '--no-block', 'engineering-orchestrator-cloud-heartbeat\.service'\]/);
  assert.doesNotMatch(server, /\/api\/shell|\/api\/exec|child_process.*req\.body/);
  assert.match(html, /id="pauseAllBtn"/);
  assert.match(html, /id="resumeAllBtn"/);
  assert.match(app, /data-lane-pause/);
  assert.match(app, /Autonomía pausada/);
});
