import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/agent-cloud.yml', import.meta.url), 'utf8');
const projects = JSON.parse(readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8'));
const self = projects.projects.find((project) => project.id === 'self');

test('cloud worker reacts to owner control-plane events with a scheduled fallback only', () => {
  assert.match(workflow, /issues:\n\s+types: \[opened, edited, reopened\]/);
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /github\.actor == 'palgarra14-del'/);
  assert.match(workflow, /github\.event\.issue\.pull_request == null/);
});

test('cloud worker serializes execution and has bounded runtime', () => {
  assert.match(workflow, /concurrency:\n\s+group: agent-self-cloud\n\s+cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 20/);
});

test('cloud worker permissions are explicit and exclude deployment or identity authority', () => {
  for (const permission of [
    'actions: write',
    'checks: read',
    'contents: write',
    'issues: write',
    'pull-requests: write',
    'statuses: read'
  ]) assert.match(workflow, new RegExp(`^  ${permission}$`, 'm'));
  assert.doesNotMatch(workflow, /^\s*(deployments|id-token|packages|environments):/m);
});

test('cloud worker checks out trusted main without persisting checkout credentials', () => {
  assert.match(workflow, /uses: actions\/checkout@v5[\s\S]*?ref: main[\s\S]*?persist-credentials: false/);
  assert.match(workflow, /uses: actions\/setup-node@v4[\s\S]*?node-version: 24/);
  const thirdPartyUses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)]
    .map((match) => match[1])
    .filter((action) => !/^actions\/(checkout|setup-node)@/.test(action));
  assert.deepEqual(thirdPartyUses, []);
});

test('cloud worker uses frozen dependencies and exact configured self runtime', () => {
  assert.ok(self);
  assert.match(self.execution.image, /@sha256:[a-f0-9]{64}$/);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.ok(workflow.includes(`run: docker pull ${self.execution.image}`));
});

test('cloud credentials exist only at the governed queue step and are never put in command arguments', () => {
  assert.equal((workflow.match(/^\s*GITHUB_TOKEN:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*OPENAI_API_KEY:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/secrets\.OPENAI_API_KEY/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /VERCEL_TOKEN|CODEX_API_KEY/);
  assert.doesNotMatch(workflow, /https:\/\/[^\s]*\$\{\{\s*(?:github\.token|secrets\.)/);
  assert.match(workflow, /exec node src\/cli\.js inbox cloud-once/);
});

test('cloud worker has no merge or production deployment command surface', () => {
  assert.doesNotMatch(workflow, /\bgh\s+pr\s+merge\b|merge_pull_request|vercel\s+--prod|production[_ -]?deploy/i);
});
