import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/agent-cloud-watchdog.yml', import.meta.url), 'utf8');

test('cloud watchdog is lightweight, offset, and can only dispatch Actions', () => {
  assert.match(workflow, /cron: '3\/5 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+actions: write\n\s+contents: read/);
  assert.doesNotMatch(workflow, /issues:\s*write|pull-requests:\s*write|statuses:\s*write|deployments:|id-token:|packages:/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /uses: actions\/checkout@v5[\s\S]*ref: main[\s\S]*persist-credentials: false/);
  assert.match(workflow, /uses: actions\/setup-node@v4[\s\S]*node-version: 24/);
  assert.match(workflow, /AGENT_WATCHDOG_MAX_AGE_MINUTES: '20'/);
  assert.match(workflow, /node scripts\/cloud-watchdog\.js/);
  assert.doesNotMatch(workflow, /npm ci|docker|CODEX_API_KEY|OPENAI_API_KEY|AGENT_GITHUB_TOKEN|VERCEL_TOKEN|secrets\./);
});

test('cloud watchdog serializes its own runs without cancelling an in-flight decision', () => {
  assert.match(workflow, /concurrency:\n\s+group: agent-cloud-watchdog\n\s+cancel-in-progress: false/);
});
