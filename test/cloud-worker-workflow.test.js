import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/agent-cloud.yml', import.meta.url), 'utf8');
const projects = JSON.parse(readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8'));
const queueConfig = JSON.parse(readFileSync(new URL('../config/issue-queue.json', import.meta.url), 'utf8'));
const self = projects.projects.find((project) => project.id === 'self');
const website = projects.projects.find((project) => project.id === 'website-pilot');
const callflow = projects.projects.find((project) => project.id === 'callflow');

test('cloud worker reacts to owner control-plane events with a scheduled fallback only', () => {
  assert.match(workflow, /issues:\n\s+types: \[opened, edited, reopened\]/);
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /github\.actor == 'palgarra14-del'/);
  assert.match(workflow, /github\.event\.issue\.pull_request == null/);
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, '\/agent'\)/);
});

test('cloud worker routes events through trusted main before constructing the lane matrix', () => {
  assert.match(workflow, /route:\n[\s\S]*name: route cloud lanes/);
  assert.match(workflow, /route:[\s\S]*permissions:\n\s+contents: read/);
  assert.match(workflow, /route:[\s\S]*uses: actions\/checkout@v5[\s\S]*ref: main[\s\S]*persist-credentials: false/);
  assert.match(workflow, /node scripts\/cloud-lane-route\.js/);
  const routeBlock = workflow.slice(workflow.indexOf('  route:'), workflow.indexOf('  cloud-once:'));
  assert.doesNotMatch(routeBlock, /actions\/setup-node|npm ci|docker pull/);
  assert.match(workflow, /outputs:\n\s+lanes: \$\{\{ steps\.route\.outputs\.lanes \}\}/);
  assert.match(workflow, /cloud-once:[\s\S]*needs: route/);
  assert.match(workflow, /lane: \$\{\{ fromJSON\(needs\.route\.outputs\.lanes\) \}\}/);
  assert.match(workflow, /group: agent-\$\{\{ matrix\.lane \}\}-cloud/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 35/);
  assert.doesNotMatch(workflow, /lane:\s*\$\{\{\s*github\./);
  assert.deepEqual(queueConfig.cloudLanes.map((lane) => lane.id), ['self', 'website-pilot', 'callflow']);
});

test('all active lanes have distinct durable namespaces and non-overlapping ownership', () => {
  const selfLane = queueConfig.cloudLanes.find((lane) => lane.id === 'self');
  const websiteLane = queueConfig.cloudLanes.find((lane) => lane.id === 'website-pilot');
  const callflowLane = queueConfig.cloudLanes.find((lane) => lane.id === 'callflow');

  assert.deepEqual(selfLane, {
    id: 'self',
    projectIds: ['self'],
    tag: 'agent-cloud-state-v1',
    statePath: '.agent/cloud-state.json'
  });
  assert.deepEqual(websiteLane, {
    id: 'website-pilot',
    projectIds: ['website-pilot'],
    tag: 'agent-cloud-state-website-pilot-v1',
    statePath: '.agent/cloud-state-website-pilot.json'
  });
  assert.deepEqual(callflowLane, {
    id: 'callflow',
    projectIds: ['callflow'],
    tag: 'agent-cloud-state-callflow-v1',
    statePath: '.agent/cloud-state-callflow.json'
  });

  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.tag)).size, 3);
  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.statePath)).size, 3);
  assert.equal(new Set(queueConfig.cloudLanes.flatMap((lane) => lane.projectIds)).size, 3);
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

test('routing job receives event data but no secrets or write credentials', () => {
  const routeStart = workflow.indexOf('  route:');
  const cloudStart = workflow.indexOf('  cloud-once:');
  assert.ok(routeStart >= 0 && cloudStart > routeStart);
  const route = workflow.slice(routeStart, cloudStart);
  assert.match(route, /AGENT_CLOUD_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(route, /AGENT_CLOUD_EVENT_ACTION: \$\{\{ github\.event\.action \}\}/);
  assert.match(route, /AGENT_CLOUD_ISSUE_BODY: \$\{\{ github\.event\.issue\.body \}\}/);
  assert.doesNotMatch(route, /GITHUB_TOKEN|AGENT_GITHUB_TOKEN|CODEX_API_KEY|OPENAI_API_KEY|secrets\./);
});

test('cloud worker uses frozen dependencies and the managed Git-enabled runtime shared by active lanes', () => {
  assert.ok(self);
  assert.ok(website);
  assert.ok(callflow);
  assert.equal(self.execution.image, 'agent-node22-pnpm11:local');
  assert.equal(website.execution.image, self.execution.image);
  assert.equal(callflow.execution.image, self.execution.image);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.ok(workflow.includes('node src/cli.js runtime sync'));
  assert.ok(workflow.includes(`docker run --rm --entrypoint git ${self.execution.image} --version`));
});

test('cloud worker gates heavy runtime behind a read-only lane preflight', () => {
  const preflightStart = workflow.indexOf('- name: Check lane for governed work');
  const runtimeStart = workflow.indexOf('- name: Prepare exact cloud runtime');
  const tickStart = workflow.indexOf('- name: Run one governed cloud queue tick');
  assert.ok(preflightStart > 0);
  assert.ok(runtimeStart > preflightStart);
  assert.ok(tickStart > runtimeStart);
  const preflight = workflow.slice(preflightStart, runtimeStart);
  assert.match(preflight, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(preflight, /inbox cloud-peek --lane "\$AGENT_CLOUD_LANE"/);
  assert.match(preflight, /has_work=\$HAS_WORK/);
  assert.doesNotMatch(preflight, /CODEX_API_KEY|AGENT_GITHUB_TOKEN|OPENAI_API_KEY/);
  assert.match(workflow, /- name: Prepare exact cloud runtime\n\s+if: steps\.preflight\.outputs\.has_work == 'true'/);
  assert.match(workflow, /- name: Run one governed cloud queue tick\n\s+if: steps\.preflight\.outputs\.has_work == 'true'/);
});

test('model and cross-repo credentials exist only at the governed queue step', () => {
  assert.equal((workflow.match(/^\s*GITHUB_TOKEN:/gm) ?? []).length, 2);
  assert.equal((workflow.match(/^\s*AGENT_GITHUB_TOKEN:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*CODEX_API_KEY:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*OPENAI_API_KEY:/gm) ?? []).length, 0);
  assert.equal((workflow.match(/secrets\.OPENAI_API_KEY/g) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*AGENT_CLOUD_LANE:/gm) ?? []).length, 2);
  assert.match(workflow, /AGENT_CLOUD_LANE: \$\{\{ matrix\.lane \}\}/);
  assert.doesNotMatch(workflow, /AGENT_CLOUD_LANE: \$\{\{\s*github\./);
  assert.doesNotMatch(workflow, /VERCEL_TOKEN|secrets\.CODEX_API_KEY/);
  assert.doesNotMatch(workflow, /https:\/\/[^\s]*\$\{\{\s*(?:github\.token|secrets\.)/);
  assert.match(workflow, /run: exec node src\/cli\.js inbox cloud-once --lane "\$AGENT_CLOUD_LANE"/);
});

test('cloud worker has no merge or production deployment command surface', () => {
  assert.doesNotMatch(workflow, /\bgh\s+pr\s+merge\b|merge_pull_request|vercel\s+--prod|production[_ -]?deploy/i);
});
