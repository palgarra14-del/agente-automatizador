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
  assert.match(workflow, /Operator pause or rate-limit cooldown prevented this cloud wakeup/);
});

test('GitHub scheduled watchdog skips a lane while its exact local rate-limit retry timer is active', () => {
  assert.match(workflow, /AGENT_CLOUD_EVENT_NAME.*schedule/);
  assert.match(workflow, /systemctl --user is-active --quiet "agent-cloud-retry-\$SCHEDULE_LANE\.timer"/);
  assert.match(workflow, /scheduled watchdog skipped because an exact rate-limit retry is already pending/);
  assert.match(workflow, /SCHEDULE_LANE=.*lanes\.length !== 1/);
});

test('MSI heartbeat reads the same durable operator controls before dispatching', () => {
  assert.match(heartbeat, /actions\/variables\/\$\{name\}/);
  assert.match(heartbeat, /AGENT_GLOBAL_PAUSE/);
  assert.match(heartbeat, /AGENT_PAUSED_LANES/);
  assert.match(heartbeat, /operatorControl\.globalPause/);
  assert.match(heartbeat, /pausedLanes\.includes\(lane\)/);
});

test('MSI heartbeat respects exact rate-limit retry timers instead of waking a lane early', () => {
  assert.match(heartbeat, /agent-cloud-retry-\$\{lane\}\.timer/);
  assert.match(heartbeat, /rateLimitCooldown:true/);
  assert.match(heartbeat, /rateLimitCooldown:\[\.\.\.cooldown\]/);
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
