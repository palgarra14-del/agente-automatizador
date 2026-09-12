import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateChangePolicy, JsonStore, loadProjects, WorkflowStepStatus } from '../src/core.js';
const clone = (value) => JSON.parse(JSON.stringify(value));

import {
  GitHubIssueChannel,
  ISSUE_REQUEST_MARKER,
  SupervisedIssueQueue,
  normalizeIssueQueueConfig,
  normalizeIssueRequest,
  parseApprovalComment,
  parseIssueRequestBody,
  projectExecutionFingerprint,
  startApprovalFingerprint,
  workflowApprovalFingerprint,
  watchIssueQueue
} from '../src/issue-queue.js';

function requestBody(overrides = {}) {
  const request = {
    version: 1,
    projectId: 'callflow',
    profile: 'app-improvement',
    goal: 'Improve one bounded Callflow behavior',
    scope: { allowedPaths: ['app'], forbiddenPaths: ['docs'] },
    ...overrides
  };
  return `${ISSUE_REQUEST_MARKER}\n${JSON.stringify(request)}`;
}

function workflowPlan() {
  return {
    id: 'workflow-fixture',
    goal: 'Improve one bounded Callflow behavior',
    projectId: 'callflow',
    profile: 'app-improvement',
    inputFingerprint: null,
    registryFingerprint: 'a'.repeat(64),
    projectSkillPolicyFingerprint: 'b'.repeat(64),
    specialistRegistryFingerprint: 'c'.repeat(64),
    scope: { allowedPaths: ['app'], forbiddenPaths: ['docs'] },
    workspace: null,
    modelUsage: { calls: 0 },
    status: WorkflowStepStatus.PENDING,
    steps: [
      { id: 'inspect-project', type: 'placeholder', skill: 'code.inspect', specialist: 'code-inspector', status: WorkflowStepStatus.READY, error: null, evidence: null },
      { id: 'plan-change', type: 'checkpoint', skill: 'human.approval', specialist: 'human-supervisor', status: WorkflowStepStatus.PENDING, error: null, evidence: null },
      { id: 'publication', type: 'placeholder', skill: 'release.publish-reviewed-workflow', specialist: 'release-manager', status: WorkflowStepStatus.PENDING, error: null, evidence: null }
    ]
  };
}

function dryRun(plan) {
  return {
    ...clone(plan),
    dryRun: true,
    plannedSteps: [
      { id: 'inspect-project', type: 'placeholder', skill: 'code.inspect', specialist: 'code-inspector', specialistAuthority: 'workspace-read', commands: [] },
      { id: 'plan-change', type: 'checkpoint', skill: 'human.approval', specialist: 'human-supervisor', specialistAuthority: 'approval', commands: [] },
      { id: 'publication', type: 'placeholder', skill: 'release.publish-reviewed-workflow', specialist: 'release-manager', specialistAuthority: 'external-write', commands: [] }
    ],
    plannedExternalWrites: [{ id: 'publication', skill: 'release.publish-reviewed-workflow', specialist: 'release-manager' }]
  };
}

class FakeWorkflowEngine {
  constructor() {
    this.plan = workflowPlan();
    this.createCalls = [];
    this.runCalls = [];
    this.approveCalls = [];
    this.resumeCalls = [];
    this.realRunResult = null;
    this.resumeResult = null;
  }

  async create(input) {
    this.createCalls.push(clone(input));
    return clone(this.plan);
  }

  async get() { return clone(this.plan); }

  async run(_id, options = {}) {
    this.runCalls.push(clone(options));
    if (options.dryRun) return dryRun(this.plan);
    if (this.realRunResult) {
      this.plan = clone(this.realRunResult);
      return clone(this.plan);
    }
    return clone(this.plan);
  }

  async approve(_id, stepId, options = {}) {
    this.approveCalls.push(stepId);
    const step = this.plan.steps.find((candidate) => candidate.id === stepId);
    if (step) {
      step.status = WorkflowStepStatus.COMPLETED;
      step.error = null;
      step.evidence = {
        approvedAt: '2026-09-12T00:00:00.000Z',
        externalApprovalFingerprint: options.externalApprovalFingerprint ?? null,
        approvedDependencyEvidenceFingerprint: options.approvedDependencyEvidenceFingerprint ?? null
      };
    }
    this.plan.status = WorkflowStepStatus.PENDING;
    return clone(this.plan);
  }

  async resume() {
    this.resumeCalls.push(true);
    if (this.resumeResult) this.plan = clone(this.resumeResult);
    return clone(this.plan);
  }
}

class FakeChannel {
  constructor(issue) {
    this.repository = { owner: 'palgarra14-del', name: 'agente-automatizador' };
    this.issues = [issue];
    this.commentsByIssue = new Map([[issue.number, []]]);
    this.posted = [];
    this.nextCommentId = 100;
    this.failNextPost = false;
  }

  async openIssues() { return clone(this.issues); }

  async issue(number) {
    this.issueReadCount = (this.issueReadCount ?? 0) + 1;
    this.onIssueRead?.(number, this.issueReadCount);
    return clone(this.issues.find((issue) => issue.number === number) ?? null);
  }

  async comments(number) {
    this.commentsReadCount = (this.commentsReadCount ?? 0) + 1;
    this.onCommentsRead?.(number, this.commentsReadCount);
    return clone(this.commentsByIssue.get(number) ?? []);
  }

  async comment(number, body) {
    if (this.failNextPost) {
      this.failNextPost = false;
      throw new Error('fixture comment transport failure');
    }
    const entry = { id: this.nextCommentId++, number, body };
    this.posted.push(entry);
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push({ id: entry.id, user: { login: 'palgarra14-del' }, body });
    this.commentsByIssue.set(number, comments);
    return { id: entry.id, url: `https://example.test/comment/${entry.id}` };
  }

  addUserComment(number, { id, login, body }) {
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push({ id, user: { login }, body });
    this.commentsByIssue.set(number, comments);
  }
}

async function queueFixture() {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-issue-queue-')), 'state.json'));
  const issue = { number: 41, id: 4100, state: 'open', body: requestBody(), user: { login: 'palgarra14-del' } };
  const channel = new FakeChannel(issue);
  const workflowEngine = new FakeWorkflowEngine();
  const project = {
    id: 'callflow',
    repository: { owner: 'palgarra14-del', name: 'App-llamadas' },
    defaultBranch: 'main',
    workingBranchPattern: 'agent/{runId}',
    protectedBranches: ['main'],
    workspace: '/tmp/callflow',
    workspaceStrategy: 'managed',
    managedWorkspaceRoot: '/tmp/agent-workspaces/callflow',
    commandEnvironment: {},
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim', resources: { memoryMb: 512, cpuCount: 1, pidsLimit: 96 } },
    toolchain: { command: 'npm', version: null },
    changePolicy: { forbiddenPaths: [], sensitivePaths: [], budgets: { maxChangedFiles: 5, maxDiffLines: 400 } },
    commands: { test: 'npm test' },
    policies: { requireApprovalFor: ['merge'], forbidden: [] },
    acceptance: { require: ['test', 'ci', 'deployment'] },
    deployment: { provider: 'vercel', projectId: 'fixture', teamId: 'fixture-team', requirePreviewReady: true },
    budgets: { maxModelCalls: 6, maxRuntimeMinutes: 20 },
    skills: { allow: ['code.inspect'], deny: [] },
    pullRequest: { titleTemplate: 'Agent: {project} — {objective}' }
  };
  const projects = new Map([['callflow', project]]);
  const queue = new SupervisedIssueQueue({
    store,
    projects,
    workflowEngine,
    channel,
    allowedActors: ['palgarra14-del'],
    now: () => '2026-09-12T00:00:00.000Z'
  });
  return { store, issue, channel, workflowEngine, queue, project, projects };
}

function persistedRequestFields(queue, issue, project) {
  const parsed = parseIssueRequestBody(issue.body);
  return {
    parsed,
    fields: {
      requestFingerprint: parsed.requestFingerprint,
      issueBodyFingerprint: parsed.issueBodyFingerprint,
      projectFingerprint: projectExecutionFingerprint(project),
      controlPlaneFingerprint: queue.controlPlaneFingerprint()
    }
  };
}

test('issue request protocol is strict, bounded, canonical, and redacts accidental secrets', () => {
  const parsed = parseIssueRequestBody(requestBody({ goal: 'Use Authorization: Bearer abcdefghijklmnop safely' }));
  assert.equal(parsed.request.projectId, 'callflow');
  assert.equal(parsed.request.profile, 'app-improvement');
  assert.equal(parsed.request.goal.includes('abcdefghijklmnop'), false);
  assert.match(parsed.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.match(parsed.issueBodyFingerprint, /^[a-f0-9]{64}$/);

  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'website-build', goal: 'x' }), /only app-improvement/);
  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'app-improvement', goal: 'x' }), /scope is required/);
  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'app-improvement', goal: 'x', scope: { allowedPaths: [] } }), /at least one bounded path/);
  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'app-improvement', goal: 'x', scope: { allowedPaths: ['.'] } }), /not the repository root/);
  assert.throws(() => parseIssueRequestBody(`${ISSUE_REQUEST_MARKER}\n{"version":1,"projectId":"callflow","profile":"app-improvement","goal":"x","extra":true}`), /unknown field/);
  assert.throws(() => parseIssueRequestBody(`prefix\n${requestBody()}`), /marker must be the first/);
  assert.throws(() => parseIssueRequestBody(`${requestBody()}\n${ISSUE_REQUEST_MARKER}\n{}`), /exactly one request marker/);
  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'app-improvement', goal: 'x', scope: { allowedPaths: ['../escape'] } }), /safe repository-relative path/);
});

test('exact issue-body fingerprint invalidates formatting-only and masked-secret edits', () => {
  const original = requestBody({ goal: 'Use Authorization: Bearer abcdefghijklmnop safely' });
  const formattingOnly = `${ISSUE_REQUEST_MARKER}\n${JSON.stringify({
    version: 1,
    projectId: 'callflow',
    profile: 'app-improvement',
    goal: 'Use Authorization: Bearer abcdefghijklmnop safely',
    scope: { allowedPaths: ['app'], forbiddenPaths: ['docs'] }
  }, null, 2)}`;
  const changedSecret = requestBody({ goal: 'Use Authorization: Bearer zyxwvutsrqponmlk safely' });

  const first = parseIssueRequestBody(original);
  const formatted = parseIssueRequestBody(formattingOnly);
  const secretChanged = parseIssueRequestBody(changedSecret);

  assert.equal(first.requestFingerprint, formatted.requestFingerprint);
  assert.equal(first.requestFingerprint, secretChanged.requestFingerprint);
  assert.notEqual(first.issueBodyFingerprint, formatted.issueBodyFingerprint);
  assert.notEqual(first.issueBodyFingerprint, secretChanged.issueBodyFingerprint);
});

test('issue queue config is strict and normalizes actor identity', () => {
  assert.deepEqual(normalizeIssueQueueConfig({
    version: 1,
    repository: { owner: 'Palgarra14-Del', name: 'Agente-Automatizador' },
    allowedActors: ['Palgarra14-Del', 'palgarra14-del'],
    pollIntervalMs: 15_000
  }), {
    version: 1,
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    allowedActors: ['palgarra14-del'],
    pollIntervalMs: 15_000
  });
  assert.throws(() => normalizeIssueQueueConfig({ version: 1, repository: { owner: 'x', name: 'y' }, allowedActors: [] }), /between 1 and 20/);
  assert.throws(() => normalizeIssueQueueConfig({ version: 1, repository: { owner: 'x', name: 'y' }, allowedActors: ['x'], pollIntervalMs: 100 }), /between 1000 and 300000/);
});

test('approval comments must be exact and cannot be embedded in agent status prose', () => {
  const token = 'a'.repeat(64);
  assert.deepEqual(parseApprovalComment(`/agent approve ${token}`), { decision: 'approve', approvalFingerprint: token });
  assert.deepEqual(parseApprovalComment(`/agent reject ${token}`), { decision: 'reject', approvalFingerprint: token });
  assert.equal(parseApprovalComment(`Please run /agent approve ${token}`), null);
  assert.equal(parseApprovalComment(`\`/agent approve ${token}\``), null);
  assert.equal(parseApprovalComment('/agent approve not-a-token'), null);
});

test('new issue produces only a dry-run and fingerprinted start approval request', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  const record = await queue.tick();
  assert.equal(record.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.createCalls.length, 1);
  assert.deepEqual(workflowEngine.runCalls, [{ dryRun: true }]);
  assert.match(record.pendingApproval.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(channel.posted.length, 1);
  assert.match(channel.posted[0].body, /No Codex call, project write, Git write, PR creation, or deployment/);
  assert.ok(channel.posted[0].body.includes(`/agent approve ${record.pendingApproval.fingerprint}`));

  const again = await queue.tick();
  assert.equal(again.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.runCalls.length, 1);
  assert.equal(channel.posted.length, 1);
});

test('missing approval prompt is recovered after a transient GitHub comment failure', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  channel.failNextPost = true;
  await assert.rejects(() => queue.tick(), /fixture comment transport failure/);

  const persisted = await queue.getRecord(queue.requestKey(channel.issues[0]));
  assert.equal(persisted.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.runCalls.length, 1);

  const recovered = await queue.tick();
  assert.equal(recovered.status, 'awaiting_start_approval');
  assert.equal(channel.posted.length, 1);
  assert.ok(channel.posted[0].body.includes(`/agent approve ${persisted.pendingApproval.fingerprint}`));
  assert.equal(workflowEngine.runCalls.length, 1);
});

test('unauthorized or malformed comments cannot start real execution', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  channel.addUserComment(issue.number, { id: 1, login: 'attacker', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.addUserComment(issue.number, { id: 2, login: 'palgarra14-del', body: `please /agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  assert.equal(record.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.runCalls.length, 1);
});

test('latest exact human decision wins when approve and reject both exist before polling', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  channel.addUserComment(issue.number, { id: 7, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.addUserComment(issue.number, { id: 8, login: 'palgarra14-del', body: `/agent reject ${record.pendingApproval.fingerprint}` });

  const rejected = await queue.tick();
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.reason, /^rejected_by:/);
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('pending approval survives a transient workflow lookup failure after its comment was observed', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  channel.addUserComment(issue.number, { id: 75, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const originalGet = workflowEngine.get.bind(workflowEngine);
  let getCalls = 0;
  workflowEngine.get = async (...args) => {
    getCalls += 1;
    if (getCalls === 1) throw new Error('fixture transient workflow lookup');
    return originalGet(...args);
  };

  await assert.rejects(() => queue.tick(), /fixture transient workflow lookup/);
  const stillPending = await queue.getRecord(queue.requestKey(issue));
  assert.equal(stillPending.status, 'awaiting_start_approval');

  const retried = await queue.tick();
  assert.equal(getCalls >= 2, true);
  assert.notEqual(retried.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 1);
  assert.equal(workflowEngine.runCalls.some((call) => call.refreshPristineDeadline === true), true);
});

test('issue edits invalidate accepted request fingerprint before any real execution', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  await queue.tick();
  channel.issues[0].body = requestBody({ goal: 'Changed after dry-run' });
  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'request_body_changed');
  assert.equal(workflowEngine.runCalls.length, 1);
  assert.match(channel.posted.at(-1).body, /accepted request\/control context changed|can no longer be verified exactly/i);
});

test('formatting-only issue edits invalidate an already prepared approval', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  await queue.tick();
  const parsed = JSON.parse(channel.issues[0].body.slice(ISSUE_REQUEST_MARKER.length).trim());
  channel.issues[0].body = `${ISSUE_REQUEST_MARKER}\n${JSON.stringify(parsed, null, 2)}`;

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'request_body_changed');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('malformed issue edits block an existing request instead of leaving it silently pending', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  await queue.tick();
  channel.issues[0].body = `${ISSUE_REQUEST_MARKER}\n{"version":1,`;
  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'request_body_invalid');
  assert.equal(workflowEngine.runCalls.length, 1);
  assert.match(channel.posted.at(-1).body, /no further execution was authorized/i);
});

test('issue is re-read immediately before start authorization to close edit races', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  channel.addUserComment(issue.number, { id: 9, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.onIssueRead = (_number, count) => {
    if (count === 2) channel.issues[0].body = requestBody({ goal: 'Changed during approval race' });
  };
  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'request_body_changed');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('a newer rejection observed immediately before start prevents execution', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  channel.addUserComment(issue.number, { id: 70, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.onCommentsRead = (_number, count) => {
    if (count === 2) channel.addUserComment(issue.number, { id: 71, login: 'palgarra14-del', body: `/agent reject ${record.pendingApproval.fingerprint}` });
  };

  const rejected = await queue.tick();
  assert.equal(rejected.status, 'rejected');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('project execution-context drift blocks an old approval before real execution', async () => {
  const { queue, channel, workflowEngine, issue, project } = await queueFixture();
  const record = await queue.tick();
  project.repository = { owner: 'palgarra14-del', name: 'Different-repository' };
  channel.addUserComment(issue.number, { id: 72, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'project_config_changed');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('control-plane actor drift blocks an active request instead of granting retroactive authority', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  queue.allowedActors.add('new-actor');
  channel.addUserComment(issue.number, { id: 73, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'control_plane_changed');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('cross-workflow substitution is blocked before an approved start can execute', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  workflowEngine.plan.id = 'substituted-workflow';
  channel.addUserComment(issue.number, { id: 76, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'workflow_binding_mismatch');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('non-pristine workflow cannot consume a pending start approval after local state divergence', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  workflowEngine.plan.steps[0].status = WorkflowStepStatus.COMPLETED;
  workflowEngine.plan.steps[0].evidence = { result: { unexpected: true } };
  channel.addUserComment(issue.number, { id: 74, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'start_approval_state_diverged');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('authorized approvals drive workflow checkpoints without bypassing WorkflowEngine', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();

  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { ok: true };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 10, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  assert.equal(record.status, 'awaiting_workflow_approval');
  assert.equal(record.pendingApproval.stepId, 'plan-change');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 1);
  assert.match(channel.posted.at(-1).body, /Evidence bound to this approval fingerprint/);
  assert.match(channel.posted.at(-1).body, /"ok": true/);
  const checkpointToken = record.pendingApproval.fingerprint;

  const completed = clone(awaitingPlan);
  completed.status = WorkflowStepStatus.COMPLETED;
  completed.steps[1].status = WorkflowStepStatus.COMPLETED;
  completed.steps[1].evidence = { approvedAt: '2026-09-12T00:00:00.000Z' };
  completed.steps[2].status = WorkflowStepStatus.COMPLETED;
  completed.steps[2].evidence = {
    pullRequest: { number: 7, url: 'https://github.com/owner/callflow/pull/7' },
    commit: { finalHead: 'd'.repeat(40) },
    preview: { state: 'READY', url: 'https://preview.example.test' }
  };
  workflowEngine.realRunResult = completed;

  channel.addUserComment(issue.number, { id: 11, login: 'palgarra14-del', body: `/agent approve ${checkpointToken}` });
  record = await queue.tick();
  assert.equal(record.status, 'completed');
  assert.deepEqual(workflowEngine.approveCalls, ['plan-change']);
  assert.equal(record.publication.pullRequest, 'https://github.com/owner/callflow/pull/7');
  assert.equal(record.publication.previewUrl, 'https://preview.example.test');
  assert.match(channel.posted.at(-1).body, /No merge or production deployment/);
});

test('checkpoint approval fingerprint binds completed dependency evidence', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { result: { diagnosisBasis: 'original' } };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 80, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  const checkpointToken = record.pendingApproval.fingerprint;

  workflowEngine.plan.steps[0].evidence = { result: { diagnosisBasis: 'tampered-after-token' } };
  channel.addUserComment(issue.number, { id: 81, login: 'palgarra14-del', body: `/agent approve ${checkpointToken}` });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'workflow_approval_stale');
  assert.equal(workflowEngine.approveCalls.length, 0);
});

test('missing workflow while a checkpoint approval is pending becomes an explicit block', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { result: { ok: true } };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 85, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  assert.equal(record.status, 'awaiting_workflow_approval');

  workflowEngine.get = async () => null;
  channel.addUserComment(issue.number, { id: 86, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  const blocked = await queue.tick();

  assert.equal(blocked.status, 'blocked');
  assert.ok(['workflow_missing', 'workflow_binding_mismatch'].includes(blocked.reason));
  assert.equal(workflowEngine.approveCalls.length, 0);
});

test('a rejection arriving between checkpoint decision read and approval prevents WorkflowEngine approval', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { result: { ok: true } };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 82, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  const checkpointToken = record.pendingApproval.fingerprint;
  channel.commentsReadCount = 0;
  channel.addUserComment(issue.number, { id: 83, login: 'palgarra14-del', body: `/agent approve ${checkpointToken}` });
  channel.onCommentsRead = (_number, count) => {
    if (count === 2) channel.addUserComment(issue.number, { id: 84, login: 'palgarra14-del', body: `/agent reject ${checkpointToken}` });
  };

  const rejected = await queue.tick();
  assert.equal(rejected.status, 'rejected');
  assert.equal(workflowEngine.approveCalls.length, 0);
});

test('approval evidence summaries are secret-redacted before posting to GitHub', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { result: { note: 'Authorization: Bearer supersecretvalue123 ``` /agent approve deadbeef @attacker' } };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 87, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();

  assert.equal(record.status, 'awaiting_workflow_approval');
  const body = channel.posted.at(-1).body;
  assert.equal(body.includes('supersecretvalue123'), false);
  assert.equal(body.includes('/agent approve deadbeef'), false);
  assert.equal(body.includes('@attacker'), false);
  assert.match(body, /REDACTED/);
  assert.match(body, /\[agent-command\]/);
});

test('terminal notification outbox retries after a GitHub comment failure without rerunning the workflow', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  const completed = workflowPlan();
  completed.status = WorkflowStepStatus.COMPLETED;
  completed.steps = completed.steps.map((step) => ({
    ...step,
    status: WorkflowStepStatus.COMPLETED,
    error: null,
    evidence: step.id === 'publication'
      ? { pullRequest: { number: 15, url: 'https://github.com/owner/callflow/pull/15' }, commit: { finalHead: 'b'.repeat(40) }, preview: { state: 'READY', url: 'https://preview-15.example.test' } }
      : { approvedAt: '2026-09-12T00:00:00.000Z' }
  }));
  workflowEngine.realRunResult = completed;

  channel.addUserComment(issue.number, { id: 120, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.failNextPost = true;
  await assert.rejects(() => queue.tick(), /fixture comment transport failure/);

  const persisted = await queue.getRecord(queue.requestKey(issue));
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.terminalNotification.sentAt, null);
  const realRuns = workflowEngine.runCalls.filter((call) => !call.dryRun).length;

  const delivered = await queue.tick();
  assert.equal(delivered.status, 'completed');
  assert.ok(delivered.terminalNotification.sentAt);
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, realRuns);
  assert.match(channel.posted.at(-1).body, /Definition of Done/);
});

test('terminal requests return their transition once and do not starve newer queue work', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  const completed = workflowPlan();
  completed.status = WorkflowStepStatus.COMPLETED;
  completed.steps = completed.steps.map((step) => ({
    ...step,
    status: WorkflowStepStatus.COMPLETED,
    error: null,
    evidence: step.id === 'publication'
      ? { pullRequest: { number: 9, url: 'https://github.com/owner/callflow/pull/9' }, commit: { finalHead: 'f'.repeat(40) }, preview: { state: 'READY', url: 'https://preview-9.example.test' } }
      : { approvedAt: '2026-09-12T00:00:00.000Z' }
  }));
  workflowEngine.realRunResult = completed;
  channel.addUserComment(issue.number, { id: 30, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  record = await queue.tick();
  assert.equal(record.status, 'completed');

  const newer = {
    number: 42,
    id: 4200,
    state: 'open',
    body: requestBody({ goal: 'Second request' }),
    user: { login: 'palgarra14-del' }
  };
  channel.issues.push(newer);
  channel.commentsByIssue.set(newer.number, []);
  workflowEngine.plan = workflowPlan();
  workflowEngine.realRunResult = null;

  const next = await queue.tick();
  assert.equal(next.issueNumber, 42);
  assert.equal(next.status, 'awaiting_start_approval');
});

test('newer rejection cancels recovered start after crash before real execution', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  channel.addUserComment(issue.number, { id: 60, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });

  const originalRun = workflowEngine.run.bind(workflowEngine);
  let realAttempts = 0;
  workflowEngine.run = async (id, options = {}) => {
    if (!options.dryRun) {
      realAttempts += 1;
      if (realAttempts === 1) throw new Error('fixture crash after queue start persistence');
    }
    return originalRun(id, options);
  };

  await assert.rejects(() => queue.tick(), /fixture crash/);
  const afterCrash = await queue.getRecord(queue.requestKey(issue));
  assert.equal(afterCrash.status, 'running');
  assert.equal(workflowEngine.plan.status, WorkflowStepStatus.PENDING);

  channel.addUserComment(issue.number, { id: 61, login: 'palgarra14-del', body: `/agent reject ${record.pendingApproval.fingerprint}` });
  const rejected = await queue.tick();

  assert.equal(rejected.status, 'rejected');
  assert.equal(realAttempts, 1);
});

test('stale start approval is blocked if persisted workflow planning context changed', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  const record = await queue.tick();
  workflowEngine.plan.registryFingerprint = 'f'.repeat(64);
  channel.addUserComment(issue.number, { id: 20, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'start_approval_stale');
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 0);
});

test('applied workflow approval recovers after a crash without replaying approval', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();

  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { ok: true };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 50, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  assert.equal(record.status, 'awaiting_workflow_approval');
  const checkpointToken = record.pendingApproval.fingerprint;

  const afterApproveCrash = clone(awaitingPlan);
  afterApproveCrash.status = WorkflowStepStatus.PENDING;
  afterApproveCrash.steps[1].status = WorkflowStepStatus.COMPLETED;
  afterApproveCrash.steps[1].evidence = {
    approvedAt: '2026-09-12T00:00:00.000Z',
    externalApprovalFingerprint: checkpointToken,
    approvedDependencyEvidenceFingerprint: workflowApprovalFingerprint({
      requestFingerprint: record.requestFingerprint,
      issueBodyFingerprint: record.issueBodyFingerprint,
      projectFingerprint: record.projectFingerprint,
      controlPlaneFingerprint: record.controlPlaneFingerprint,
      workflow: awaitingPlan,
      stepId: 'plan-change'
    }) ? null : null
  };
  // Fill the dependency fingerprint using the same helper indirectly through the posted approval context below.
  afterApproveCrash.steps[1].evidence.approvedDependencyEvidenceFingerprint =
    (await import('../src/core.js')).humanApprovalDependencyFingerprint(afterApproveCrash, 'plan-change');
  workflowEngine.plan = afterApproveCrash;

  const completed = clone(afterApproveCrash);
  completed.status = WorkflowStepStatus.COMPLETED;
  completed.steps[2].status = WorkflowStepStatus.COMPLETED;
  completed.steps[2].evidence = {
    pullRequest: { number: 12, url: 'https://github.com/owner/callflow/pull/12' },
    commit: { finalHead: 'a'.repeat(40) },
    preview: { state: 'READY', url: 'https://preview-12.example.test' }
  };
  workflowEngine.realRunResult = completed;

  channel.addUserComment(issue.number, { id: 51, login: 'palgarra14-del', body: `/agent approve ${checkpointToken}` });
  const recovered = await queue.tick();

  assert.equal(recovered.status, 'completed');
  assert.equal(workflowEngine.approveCalls.length, 0);
  assert.equal(workflowEngine.runCalls.filter((call) => !call.dryRun).length, 2);
});

test('checkpoint crash recovery fails closed if dependency evidence changed after the approved pre-state', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();

  const awaitingPlan = workflowPlan();
  awaitingPlan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  awaitingPlan.steps[0].status = WorkflowStepStatus.COMPLETED;
  awaitingPlan.steps[0].evidence = { result: { basis: 'approved-original' } };
  awaitingPlan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  workflowEngine.realRunResult = awaitingPlan;

  channel.addUserComment(issue.number, { id: 90, login: 'palgarra14-del', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  const checkpointToken = record.pendingApproval.fingerprint;

  channel.addUserComment(issue.number, { id: 91, login: 'palgarra14-del', body: `/agent approve ${checkpointToken}` });
  const forgedAfterCrash = clone(awaitingPlan);
  forgedAfterCrash.status = WorkflowStepStatus.PENDING;
  forgedAfterCrash.steps[0].evidence = { result: { basis: 'tampered-after-approval' } };
  forgedAfterCrash.steps[1].status = WorkflowStepStatus.COMPLETED;
  forgedAfterCrash.steps[1].evidence = {
    approvedAt: '2026-09-12T00:00:00.000Z',
    externalApprovalFingerprint: checkpointToken,
    approvedDependencyEvidenceFingerprint:
      (await import('../src/core.js')).humanApprovalDependencyFingerprint(awaitingPlan, 'plan-change')
  };
  workflowEngine.plan = forgedAfterCrash;

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'workflow_approval_recovery_mismatch');
  assert.equal(workflowEngine.approveCalls.length, 0);
});

test('interrupted workflow steps require a new fingerprinted human approval after daemon restart', async () => {
  const { queue, store, channel, workflowEngine, issue, project } = await queueFixture();
  const { parsed, fields } = persistedRequestFields(queue, issue, project);
  const interrupted = workflowPlan();
  interrupted.status = WorkflowStepStatus.BLOCKED;
  interrupted.steps[0].status = WorkflowStepStatus.BLOCKED;
  interrupted.steps[0].error = 'interrupted_step_requires_human_approval';
  workflowEngine.plan = interrupted;
  const key = queue.requestKey(issue);
  await store.mutate((data) => {
    data.requests = {
      [key]: {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: 'palgarra14-del',
        ...fields, request: parsed.request, workflowId: interrupted.id,
        status: 'running', reason: null, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
        pendingApproval: null, lastProcessedCommentId: 0
      }
    };
  });

  const waiting = await queue.tick();
  assert.equal(waiting.status, 'awaiting_workflow_approval');
  assert.equal(waiting.pendingApproval.stepId, 'inspect-project');
  assert.match(channel.posted.at(-1).body, /awaiting explicit approval/);
});

test('safe CI/preview observation timeouts resume without creating a human approval bypass', async () => {
  const { queue, store, workflowEngine, issue, project } = await queueFixture();
  const { parsed, fields } = persistedRequestFields(queue, issue, project);
  const timedOut = workflowPlan();
  timedOut.status = WorkflowStepStatus.BLOCKED;
  timedOut.steps[0].status = WorkflowStepStatus.COMPLETED;
  timedOut.steps[1].status = WorkflowStepStatus.COMPLETED;
  timedOut.steps[2].status = WorkflowStepStatus.BLOCKED;
  timedOut.steps[2].error = 'workflow_publication_ci_timeout';
  workflowEngine.plan = timedOut;

  const completed = clone(timedOut);
  completed.status = WorkflowStepStatus.COMPLETED;
  completed.steps[2].status = WorkflowStepStatus.COMPLETED;
  completed.steps[2].error = null;
  completed.steps[2].evidence = { pullRequest: { number: 8, url: 'https://github.com/owner/callflow/pull/8' }, commit: { finalHead: 'e'.repeat(40) }, preview: { state: 'READY', url: 'https://preview.example.test' } };
  workflowEngine.resumeResult = completed;

  const key = queue.requestKey(issue);
  await store.mutate((data) => {
    data.requests = {
      [key]: {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: 'palgarra14-del',
        ...fields, request: parsed.request, workflowId: timedOut.id,
        status: 'running', reason: 'resumable_publication_observation', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
        pendingApproval: null, lastProcessedCommentId: 0
      }
    };
  });

  const result = await queue.tick();
  assert.equal(result.status, 'completed');
  assert.equal(workflowEngine.resumeCalls.length, 1);
  assert.equal(workflowEngine.approveCalls.length, 0);
});

test('concurrent watchers atomically reserve a new issue and create only one workflow', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let releaseCreate;
  const createGate = new Promise((resolveGate) => { releaseCreate = resolveGate; });
  const originalCreate = workflowEngine.create.bind(workflowEngine);
  let createCalls = 0;
  workflowEngine.create = async (input) => {
    createCalls += 1;
    await createGate;
    return originalCreate(input);
  };

  const first = queue.processIssue(issue);
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  const second = queue.processIssue(issue);
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  releaseCreate();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(createCalls, 1);
  assert.equal(channel.posted.length, 1);
  assert.ok([left.status, right.status].includes('initializing'));
  assert.ok([left.status, right.status].includes('awaiting_start_approval'));
  const persisted = await queue.getRecord(queue.requestKey(issue));
  assert.equal(persisted.status, 'awaiting_start_approval');
  assert.equal(persisted.initializationLease, null);
});

test('malformed initialization lease is validated before liveness probing and blocks cleanly', async () => {
  const { queue, store, issue, project } = await queueFixture();
  const { parsed, fields } = persistedRequestFields(queue, issue, project);
  const key = queue.requestKey(issue);
  store.lockOwnerIsAbandoned = async () => { throw new Error('liveness probe must not run for malformed metadata'); };
  await store.mutate((data) => {
    data.requests = {
      [key]: {
        version: 1,
        issueNumber: issue.number,
        issueId: issue.id,
        author: 'palgarra14-del',
        ...fields,
        request: parsed.request,
        workflowId: null,
        status: 'initializing',
        reason: null,
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
        pendingApproval: null,
        startApprovalFingerprint: null,
        startApprovalCommentId: null,
        startApprovedBy: null,
        initializationLease: { leaseId: '', pid: 'bad', createdAt: 'invalid', ownerIdentity: null },
        lastProcessedCommentId: 0
      }
    };
  });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'queue_state_invalid');
  assert.equal(blocked.initializationLease, null);
});

test('abandoned initialization lease blocks instead of automatically creating a duplicate workflow', async () => {
  const { queue, store, channel, workflowEngine, issue, project } = await queueFixture();
  const { parsed, fields } = persistedRequestFields(queue, issue, project);
  const key = queue.requestKey(issue);
  store.lockOwnerIsAbandoned = async () => true;
  await store.mutate((data) => {
    data.requests = {
      [key]: {
        version: 1,
        issueNumber: issue.number,
        issueId: issue.id,
        author: 'palgarra14-del',
        ...fields,
        request: parsed.request,
        workflowId: null,
        status: 'initializing',
        reason: null,
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
        pendingApproval: null,
        startApprovalFingerprint: null,
        startApprovalCommentId: null,
        startApprovedBy: null,
        initializationLease: {
          leaseId: 'fixture-lease',
          pid: 999999,
          createdAt: '2026-09-12T00:00:00.000Z',
          ownerIdentity: 'dead-owner'
        },
        lastProcessedCommentId: 0
      }
    };
  });

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'initialization_interrupted');
  assert.equal(workflowEngine.createCalls.length, 0);
  assert.match(channel.posted.at(-1).body, /No automatic retry or duplicate workflow/);
});

test('workflow initialization failure is persisted as blocked and is not retried forever', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  let createCalls = 0;
  workflowEngine.create = async () => {
    createCalls += 1;
    throw new Error('fixture initialization failure');
  };

  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'workflow_initialization_failed');
  assert.equal(createCalls, 1);
  assert.match(channel.posted.at(-1).body, /No real execution was authorized/);

  const later = await queue.tick();
  assert.equal(later, null);
  assert.equal(createCalls, 1);
});

test('watcher survives a transient queue error and processes a later tick', async () => {
  let calls = 0;
  const controller = new AbortController();
  const observed = [];
  const errors = [];
  const queue = {
    async tick() {
      calls += 1;
      if (calls === 1) throw new Error('transient github failure');
      controller.abort();
      return { status: 'awaiting_start_approval', issueNumber: 41 };
    }
  };

  await watchIssueQueue(queue, {
    pollIntervalMs: 1_000,
    signal: controller.signal,
    onTick: (record) => observed.push(record),
    onError: (error) => errors.push(error.message)
  });

  assert.equal(calls, 2);
  assert.deepEqual(errors, ['transient github failure']);
  assert.deepEqual(observed, [{ status: 'awaiting_start_approval', issueNumber: 41 }]);
});

test('watch loop removes abort listeners after ordinary poll sleeps', async () => {
  let calls = 0;
  const signal = {
    aborted: false,
    listeners: new Set(),
    addCount: 0,
    removeCount: 0,
    addEventListener(_type, listener) { this.addCount += 1; this.listeners.add(listener); },
    removeEventListener(_type, listener) { this.removeCount += 1; this.listeners.delete(listener); },
    abort() {
      this.aborted = true;
      for (const listener of [...this.listeners]) listener();
    }
  };
  const queue = {
    async tick() {
      calls += 1;
      if (calls === 2) signal.abort();
      return null;
    }
  };

  await watchIssueQueue(queue, { pollIntervalMs: 1_000, signal });
  assert.equal(calls, 2);
  assert.equal(signal.addCount, 1);
  assert.equal(signal.removeCount, 1);
  assert.equal(signal.listeners.size, 0);
});

test('watch loop notices an abort that races with listener registration', async () => {
  let calls = 0;
  const signal = {
    aborted: false,
    listener: null,
    addEventListener(_type, listener) {
      this.listener = listener;
      this.aborted = true;
    },
    removeEventListener() { this.listener = null; }
  };
  const queue = { async tick() { calls += 1; return null; } };

  await watchIssueQueue(queue, { pollIntervalMs: 300_000, signal });
  assert.equal(calls, 1);
  assert.equal(signal.listener, null);
});

test('GitHubIssueChannel uses bounded pagination and authenticated issue-comment writes', async () => {
  assert.throws(() => new GitHubIssueChannel({
    token: 'x',
    repository: { owner: 'x', name: 'y' },
    requestTimeoutMs: 500
  }), /requestTimeoutMs/);
  const calls = [];
  const responses = [
    [{ id: 1, number: 1, state: 'open' }],
    [{ id: 2, user: { login: 'actor' }, body: 'x' }],
    { id: 3, html_url: 'https://github.com/x/y/issues/1#issuecomment-3' }
  ];
  const channel = new GitHubIssueChannel({
    token: 'ghp_fixtureSecret',
    repository: { owner: 'x', name: 'y' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const payload = responses.shift();
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  assert.equal((await channel.openIssues()).length, 1);
  assert.equal((await channel.comments(1)).length, 1);
  const posted = await channel.comment(1, 'status');
  assert.equal(posted.id, 3);
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  assert.equal(calls[0].options.headers.Authorization.includes('ghp_fixtureSecret'), true);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(JSON.parse(calls[2].options.body).body, 'status');
});

test('approval fingerprints bind exact dry-run, project/control context, and all persisted workflow evidence', () => {
  const plan = workflowPlan();
  const base = {
    requestFingerprint: '1'.repeat(64),
    issueBodyFingerprint: '2'.repeat(64),
    projectFingerprint: '3'.repeat(64),
    controlPlaneFingerprint: '4'.repeat(64)
  };
  const start = startApprovalFingerprint({ ...base, workflow: plan, dryRun: dryRun(plan) });
  const changed = dryRun(plan);
  changed.plannedSteps[0].specialistAuthority = 'external-write';
  const changedStart = startApprovalFingerprint({ ...base, workflow: plan, dryRun: changed });
  assert.notEqual(start, changedStart);
  assert.notEqual(start, startApprovalFingerprint({ ...base, projectFingerprint: '5'.repeat(64), workflow: plan, dryRun: dryRun(plan) }));

  plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  plan.steps[0].status = WorkflowStepStatus.COMPLETED;
  plan.steps[0].evidence = { result: { inspection: 'original' } };
  plan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  const checkpoint = workflowApprovalFingerprint({ ...base, workflow: plan, stepId: 'plan-change' });

  plan.steps[0].evidence = { result: { inspection: 'tampered' } };
  const dependencyChanged = workflowApprovalFingerprint({ ...base, workflow: plan, stepId: 'plan-change' });
  assert.notEqual(checkpoint, dependencyChanged);

  plan.steps[0].evidence = { result: { inspection: 'original' } };
  plan.steps[1].evidence = { detail: 'changed' };
  const targetChanged = workflowApprovalFingerprint({ ...base, workflow: plan, stepId: 'plan-change' });
  assert.notEqual(checkpoint, targetChanged);
});

test('self project classifies the v0.14 control plane as sensitive', async () => {
  const projects = await loadProjects(join(process.cwd(), 'config/projects.json'));
  const self = projects.get('self');
  for (const path of ['config/issue-queue.json', 'src/issue-queue.js', 'src/cli.js']) {
    const decision = evaluateChangePolicy(self, {
      paths: [path],
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      diffLines: 1,
      changedBytes: 1,
      maxFileBytes: 1,
      contentFingerprint: 'fixture'
    }, { allowedPaths: [path] });
    assert.equal(decision.ok, true);
    assert.equal(decision.classification, 'sensitive');
  }
});
