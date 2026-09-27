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
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+lane:\n\s+description: Trusted cloud lane for bounded continuation\n\s+required: false\n\s+type: string/);
  assert.match(workflow, /cron: '17 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /push:\n\s+branches: \[main\][\s\S]*paths:[\s\S]*'\.github\/workflows\/agent-cloud\.yml'[\s\S]*'src\/\*\*'[\s\S]*'config\/\*\*'[\s\S]*'scripts\/\*\*'/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /github\.actor == 'palgarra14-del'/);
  assert.match(workflow, /github\.event\.issue\.pull_request == null/);
  assert.match(workflow, /AGENT_CLOUD_COMMENT_BODY: \$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(workflow, /\.trim\(\)[\s\S]*body\.startsWith\("\/agent "\)/);
});

test('temporary quota-outage mode pins every cloud job to the private local runner', () => {
  const localRunner = 'runs-on: [self-hosted, Linux, X64, agent-local]';
  assert.equal(workflow.split(localRunner).length - 1, 4);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
});

test('trusted main updates wake the cloud worker without requiring a manual dispatch', () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.doesNotMatch(workflow, /push:\n\s+branches: \[(?!main\])/);
});

test('cloud worker routes events through trusted main before constructing the lane matrix', () => {
  assert.match(workflow, /route:\n[\s\S]*name: route cloud lanes/);
  assert.match(workflow, /route:[\s\S]*permissions:\n\s+contents: read/);
  assert.match(workflow, /route:[\s\S]*uses: actions\/checkout@v5[\s\S]*ref: main[\s\S]*persist-credentials: false/);
  assert.match(workflow, /node scripts\/cloud-lane-route\.js/);
  const routeBlock = workflow.slice(workflow.indexOf('  route:'), workflow.indexOf('  admit:'));
  assert.doesNotMatch(routeBlock, /actions\/setup-node|npm ci|docker pull/);
  assert.match(workflow, /outputs:\n\s+active: \$\{\{ steps\.wakeup\.outputs\.active \}\}\n\s+lanes: \$\{\{ steps\.route\.outputs\.lanes \}\}/);
  assert.match(workflow, /cloud-once:[\s\S]*needs: \[route, admit, recover\][\s\S]*needs\.admit\.result[\s\S]*needs\.recover\.result/);
  assert.match(workflow, /lane: \$\{\{ fromJSON\(needs\.route\.outputs\.lanes\) \}\}/);
  assert.match(workflow, /group: agent-\$\{\{ matrix\.lane \}\}-cloud/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /# Supervisor headroom only: internal self\/drain budgets remain bounded separately\.\n\s+timeout-minutes: 60/);
  assert.match(readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8'), /leaseTtlMs: 45 \* 60 \* 1000/);
  assert.doesNotMatch(workflow, /lane:\s*\$\{\{\s*github\./);
  assert.deepEqual(queueConfig.cloudLanes.map((lane) => lane.id), ['self', 'website-pilot', 'leadfinder', 'callflow']);
});

test('all active lanes have distinct durable namespaces and non-overlapping ownership', () => {
  const selfLane = queueConfig.cloudLanes.find((lane) => lane.id === 'self');
  const websiteLane = queueConfig.cloudLanes.find((lane) => lane.id === 'website-pilot');
  const leadfinderLane = queueConfig.cloudLanes.find((lane) => lane.id === 'leadfinder');
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
  assert.deepEqual(leadfinderLane, {
    id: 'leadfinder',
    projectIds: ['leadfinder'],
    tag: 'agent-cloud-state-leadfinder-v1',
    statePath: '.agent/cloud-state-leadfinder.json'
  });
  assert.deepEqual(callflowLane, {
    id: 'callflow',
    projectIds: ['callflow'],
    tag: 'agent-cloud-state-callflow-v1',
    statePath: '.agent/cloud-state-callflow.json'
  });

  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.tag)).size, 4);
  assert.equal(new Set(queueConfig.cloudLanes.map((lane) => lane.statePath)).size, 4);
  assert.equal(new Set(queueConfig.cloudLanes.flatMap((lane) => lane.projectIds)).size, 4);
});

test('cloud worker permissions are explicit and exclude deployment or identity authority', () => {
  for (const permission of [
    'actions: write',
    'checks: read',
    'contents: write',
    'issues: write',
    'pull-requests: write',
    'statuses: write'
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

test('cloud worker does not depend on runner cache for workflow continuity', () => {
  assert.doesNotMatch(workflow, /actions\/cache@/);
  assert.doesNotMatch(workflow, /agent-workspace-\$\{\{ matrix\.lane \}\}/);
  assert.doesNotMatch(workflow, /Restore lane workspace continuity/);
  assert.doesNotMatch(workflow, /\.agent-workspaces\/\$\{\{ matrix\.lane \}\}/);
});

test('routing job receives event data but no secrets or write credentials', () => {
  const routeStart = workflow.indexOf('  route:');
  const cloudStart = workflow.indexOf('  admit:');
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

test('scheduled recovery has the minimum commit-status authority required by Cloud State repair', () => {
  const recoverStart = workflow.indexOf('  recover:');
  const cloudOnceStart = workflow.indexOf('  cloud-once:');
  assert.ok(recoverStart > 0 && cloudOnceStart > recoverStart);
  const recovery = workflow.slice(recoverStart, cloudOnceStart);
  assert.match(recovery, /permissions:\n\s+contents: write\n\s+issues: read\n\s+statuses: write/);
  assert.doesNotMatch(recovery, /actions:\s*write|issues:\s*write|pull-requests:\s*write|checks:\s*write/);
  assert.match(recovery, /inbox cloud-repair --lane "\$AGENT_CLOUD_LANE"/);
});

test('cloud worker reuses one process for repair, control and executable-work preflight', () => {
  const cloudOnceStart = workflow.indexOf('  cloud-once:');
  const prepareStart = workflow.indexOf('- name: Prepare cloud control and executable-work preflight', cloudOnceStart);
  const runtimeStart = workflow.indexOf('- name: Prepare exact cloud runtime', cloudOnceStart);
  const tickStart = workflow.indexOf('- name: Drain governed cloud work continuously', cloudOnceStart);
  assert.ok(prepareStart > cloudOnceStart);
  assert.ok(runtimeStart > prepareStart);
  assert.ok(tickStart > runtimeStart);

  const prepare = workflow.slice(prepareStart, runtimeStart);
  const admitStart = workflow.indexOf('  admit:');
  const recoverJobStart = workflow.indexOf('  recover:');
  assert.ok(admitStart > 0 && recoverJobStart > admitStart && cloudOnceStart > recoverJobStart);
  const admit = workflow.slice(admitStart, recoverJobStart);
  const recovery = workflow.slice(recoverJobStart, cloudOnceStart);
  assert.match(admit, /timeout-minutes: 10[\s\S]*for _ in \{1\.\.30\}; do node src\/cli\.js inbox cloud-admit --lane "\$AGENT_CLOUD_LANE" && exit 0; sleep 10; done; exit 1/);
  assert.doesNotMatch(admit, /concurrency:|statuses:\s*write|sleep 30|\{1\.\.90\}/);
  assert.match(recovery, /if: needs\.route\.outputs\.active == 'true' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)/);
  assert.match(recovery, /permissions:\n\s+contents: write\n\s+issues: read\n\s+statuses: write/);
  assert.doesNotMatch(recovery, /actions:\s*write|issues:\s*write|pull-requests:\s*write|CODEX_API_KEY|AGENT_GITHUB_TOKEN|OPENAI_API_KEY/);
  assert.match(recovery, /concurrency:[\s\S]*group: agent-\$\{\{ matrix\.lane \}\}-cloud/);
  assert.match(recovery, /inbox cloud-repair --lane "\$AGENT_CLOUD_LANE"[\s\S]*inbox cloud-recover --lane "\$AGENT_CLOUD_LANE"/);
  assert.match(workflow.slice(cloudOnceStart), /needs: \[route, admit, recover\]/);

  assert.match(prepare, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(prepare, /CROSS_REPO_CREDENTIAL_CONFIGURED: \$\{\{ secrets\.AGENT_GITHUB_TOKEN != '' && 'true' \|\| 'false' \}\}/);
  assert.match(prepare, /inbox cloud-prepare --lane "\$AGENT_CLOUD_LANE"/);
  assert.match(prepare, /hasExecutionWork === true/);
  assert.match(prepare, /AGENT_CLOUD_LANE" != "self[\s\S]*cross_repo_credential_missing/);
  assert.match(prepare, /has_work=\$HAS_WORK/);
  assert.doesNotMatch(prepare, /cloud-admit|cloud-recover|CODEX_API_KEY|^\s*AGENT_GITHUB_TOKEN:|OPENAI_API_KEY/m);

  const cloudOnce = workflow.slice(cloudOnceStart);
  assert.doesNotMatch(cloudOnce.slice(0, runtimeStart - cloudOnceStart), /inbox cloud-repair|inbox cloud-control-once|inbox cloud-execution-peek/);
  assert.match(workflow, /- name: Prepare exact cloud runtime\n\s+if: steps\.preflight\.outputs\.has_work == 'true'/);
  assert.match(workflow, /- name: Drain governed cloud work continuously\n\s+id: drain\n\s+if: steps\.preflight\.outputs\.has_work == 'true'/);

  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /action === 'cloud-prepare'/);
  const prepareCliStart = cli.indexOf("} else if (action === 'cloud-prepare') {");
  const repairCliStart = cli.indexOf("} else if (action === 'cloud-repair') {", prepareCliStart);
  assert.ok(prepareCliStart > 0 && repairCliStart > prepareCliStart);
  const prepareCli = cli.slice(prepareCliStart, repairCliStart);
  assert.doesNotMatch(prepareCli, /readSnapshot\(\{ repair: true \}\)/);
  assert.doesNotMatch(prepareCli, /autonomousSelfImprovement\.hasWork\(\)/);
  assert.match(prepareCli, /if \(autonomousSelfImprovement\)[\s\S]*queue: null, hasExecutionWork: true/);
  assert.match(prepareCli, /else \{[\s\S]*withGlobalLease/);
  assert.match(prepareCli, /hasExecutionWork/);
  assert.match(cli, /executionEnabled: !\['cloud-control-once', 'cloud-prepare'\]\.includes\(action\)/);
});

test('cloud-once emits queue and autonomous results separately for auditability', () => {
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /let autonomousResult = null/);
  assert.match(cli, /autonomousResult = await autonomousSelfImprovement\.tick\(\)/);
  assert.match(cli, /return \{ queueResult, autonomousResult \}/);
  assert.match(cli, /queue: view\(result\.queueResult\)/);
  assert.match(cli, /autonomous: result\.autonomousResult/);
});

test('production cloud execution uses the bounded drain while retaining cloud-once for diagnostics', () => {
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /action === 'cloud-drain'/);
  assert.match(cli, /runCloudDrain\(\{[\s\S]*queue,[\s\S]*autonomousSelfImprovement/);
  assert.match(cli, /stopReason: result\.stopReason/);
  assert.match(cli, /continuationRecommended: result\.continuationRecommended/);
  assert.match(cli, /iterations: result\.iterations\.map/);
  assert.match(cli, /action === 'cloud-once'/);
});

test('autonomous cloud work is session-only and cannot spend a paid OpenAI API key', () => {
  assert.equal((workflow.match(/^\s*GITHUB_TOKEN:/gm) ?? []).length, 6);
  assert.equal((workflow.match(/^\s*AGENT_GITHUB_TOKEN:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*CODEX_API_KEY:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*OPENAI_API_KEY:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/secrets\.OPENAI_API_KEY/g) ?? []).length, 0);
  assert.equal((workflow.match(/secrets\.AGENT_GITHUB_TOKEN/g) ?? []).length, 2);
  assert.match(workflow, /^\s*CODEX_API_KEY: ''$/m);
  assert.match(workflow, /^\s*OPENAI_API_KEY: ''$/m);
  assert.equal((workflow.match(/^\s*AGENT_CLOUD_LANE:/gm) ?? []).length, 6);
  assert.match(workflow, /AGENT_CLOUD_LANE: \$\{\{ matrix\.lane \}\}/);
  assert.doesNotMatch(workflow, /AGENT_CLOUD_LANE: \$\{\{\s*github\./);
  assert.doesNotMatch(workflow, /VERCEL_TOKEN|secrets\.CODEX_API_KEY|secrets\.OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /https:\/\/[^\s]*\$\{\{\s*(?:github\.token|secrets\.)/);
  assert.match(workflow, /node src\/cli\.js inbox cloud-drain --lane "\$AGENT_CLOUD_LANE" > "\$RESULT_FILE"/);
});

test('cloud continuation dispatch is lane-scoped and only follows an explicit drain recommendation', () => {
  assert.match(workflow, /- name: Continue same lane while governed work remains/);
  assert.match(workflow, /if: steps\.drain\.outputs\.continue == 'true'/);
  assert.match(workflow, /GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /AGENT_CLOUD_LANE: \$\{\{ matrix\.lane \}\}/);
  assert.match(workflow, /actions\/workflows\/agent-cloud\.yml\/dispatches/);
  assert.match(workflow, /JSON\.stringify\(\{ ref: 'main', inputs: \{ lane \} \}\)/);
  assert.match(workflow, /response\.status !== 204/);
  assert.doesNotMatch(workflow, /inputs: \{ lane: process\.env\./);
});

test('cloud worker has no merge or production deployment command surface', () => {
  assert.doesNotMatch(workflow, /\bgh\s+pr\s+merge\b|merge_pull_request|vercel\s+--prod|production[_ -]?deploy/i);
});

test('autonomous self-maintenance failures cannot masquerade as a successful cloud drain', () => {
  const drainStart = workflow.indexOf('- name: Drain governed cloud work continuously');
  const continuationStart = workflow.indexOf('- name: Continue same lane while governed work remains');
  assert.ok(drainStart > 0 && continuationStart > drainStart);
  const drain = workflow.slice(drainStart, continuationStart);
  assert.match(drain, /result\.stopReason === "autonomous_failure"/);
  assert.match(drain, /AUTONOMOUS_FAILED=/);
  assert.match(drain, /::error::autonomous self-maintenance failed/);
  assert.match(drain, /exit 1/);
});

test('cloud supervisor headroom does not widen autonomous work budgets', () => {
  const drain = readFileSync(new URL('../src/cloud-drain.js', import.meta.url), 'utf8');
  assert.match(drain, /const DEFAULT_MAX_DURATION_MS = 20 \* 60 \* 1000;/);
  assert.equal(self.budgets.maxRuntimeMinutes, 18);
});

test('scheduled self-maintenance wakes hourly while active work still chains immediately', () => {
  assert.match(workflow, /cron: '17 \* \* \* \*'/);
  assert.match(workflow, /if: steps\.drain\.outputs\.continue == 'true'/);
  assert.match(workflow, /actions\/workflows\/agent-cloud\.yml\/dispatches/);
});
