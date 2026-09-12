import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore, WorkflowStepStatus } from '../src/core.js';
import {
  GitHubIssueChannel,
  ISSUE_REQUEST_MARKER,
  SupervisedIssueQueue,
  normalizeIssueQueueConfig,
  normalizeIssueRequest,
  parseApprovalComment,
  parseIssueRequestBody,
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
    ...structuredClone(plan),
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
    this.createCalls.push(structuredClone(input));
    return structuredClone(this.plan);
  }

  async get() { return structuredClone(this.plan); }

  async run(_id, options = {}) {
    this.runCalls.push(structuredClone(options));
    if (options.dryRun) return dryRun(this.plan);
    if (this.realRunResult) {
      this.plan = structuredClone(this.realRunResult);
      return structuredClone(this.plan);
    }
    return structuredClone(this.plan);
  }

  async approve(_id, stepId) {
    this.approveCalls.push(stepId);
    const step = this.plan.steps.find((candidate) => candidate.id === stepId);
    if (step) {
      step.status = WorkflowStepStatus.COMPLETED;
      step.error = null;
      step.evidence = { approvedAt: '2026-09-12T00:00:00.000Z' };
    }
    this.plan.status = WorkflowStepStatus.PENDING;
    return structuredClone(this.plan);
  }

  async resume() {
    this.resumeCalls.push(true);
    if (this.resumeResult) this.plan = structuredClone(this.resumeResult);
    return structuredClone(this.plan);
  }
}

class FakeChannel {
  constructor(issue) {
    this.repository = { owner: 'palgarra14-del', name: 'agente-automatizador' };
    this.issues = [issue];
    this.commentsByIssue = new Map([[issue.number, []]]);
    this.posted = [];
    this.nextCommentId = 100;
  }

  async openIssues() { return structuredClone(this.issues); }
  async comments(number) { return structuredClone(this.commentsByIssue.get(number) ?? []); }

  async comment(number, body) {
    const entry = { id: this.nextCommentId++, number, body };
    this.posted.push(entry);
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
  const queue = new SupervisedIssueQueue({
    store,
    projects: new Map([['callflow', { id: 'callflow' }]]),
    workflowEngine,
    channel,
    allowedActors: ['palgarra14-del'],
    now: () => '2026-09-12T00:00:00.000Z'
  });
  return { store, issue, channel, workflowEngine, queue };
}

test('issue request protocol is strict, bounded, canonical, and redacts accidental secrets', () => {
  const parsed = parseIssueRequestBody(requestBody({ goal: 'Use Authorization: Bearer abcdefghijklmnop safely' }));
  assert.equal(parsed.request.projectId, 'callflow');
  assert.equal(parsed.request.profile, 'app-improvement');
  assert.equal(parsed.request.goal.includes('abcdefghijklmnop'), false);
  assert.match(parsed.requestFingerprint, /^[a-f0-9]{64}$/);

  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'website-build', goal: 'x' }), /only app-improvement/);
  assert.throws(() => parseIssueRequestBody(`${ISSUE_REQUEST_MARKER}\n{"version":1,"projectId":"callflow","profile":"app-improvement","goal":"x","extra":true}`), /unknown field/);
  assert.throws(() => parseIssueRequestBody(`prefix\n${requestBody()}`), /marker must be the first/);
  assert.throws(() => parseIssueRequestBody(`${requestBody()}\n${ISSUE_REQUEST_MARKER}\n{}`), /exactly one request marker/);
  assert.throws(() => normalizeIssueRequest({ version: 1, projectId: 'callflow', profile: 'app-improvement', goal: 'x', scope: { allowedPaths: ['../escape'] } }), /safe repository-relative path/);
});

test('issue queue config is strict and normalizes actor identity', () => {
  assert.deepEqual(normalizeIssueQueueConfig({
    version: 1,
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
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

test('unauthorized or malformed comments cannot start real execution', async () => {
  const { queue, channel, workflowEngine, issue } = await queueFixture();
  let record = await queue.tick();
  channel.addUserComment(issue.number, { id: 1, login: 'attacker', body: `/agent approve ${record.pendingApproval.fingerprint}` });
  channel.addUserComment(issue.number, { id: 2, login: 'palgarra14-del', body: `please /agent approve ${record.pendingApproval.fingerprint}` });
  record = await queue.tick();
  assert.equal(record.status, 'awaiting_start_approval');
  assert.equal(workflowEngine.runCalls.length, 1);
});

test('issue edits invalidate accepted request fingerprint before any real execution', async () => {
  const { queue, channel, workflowEngine } = await queueFixture();
  await queue.tick();
  channel.issues[0].body = requestBody({ goal: 'Changed after dry-run' });
  const blocked = await queue.tick();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'request_body_changed');
  assert.equal(workflowEngine.runCalls.length, 1);
  assert.match(channel.posted.at(-1).body, /issue body changed/);
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
  const checkpointToken = record.pendingApproval.fingerprint;

  const completed = structuredClone(awaitingPlan);
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

test('interrupted workflow steps require a new fingerprinted human approval after daemon restart', async () => {
  const { queue, store, channel, workflowEngine, issue } = await queueFixture();
  const parsed = parseIssueRequestBody(issue.body);
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
        requestFingerprint: parsed.requestFingerprint, request: parsed.request, workflowId: interrupted.id,
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
  const { queue, store, workflowEngine, issue } = await queueFixture();
  const parsed = parseIssueRequestBody(issue.body);
  const timedOut = workflowPlan();
  timedOut.status = WorkflowStepStatus.BLOCKED;
  timedOut.steps[0].status = WorkflowStepStatus.COMPLETED;
  timedOut.steps[1].status = WorkflowStepStatus.COMPLETED;
  timedOut.steps[2].status = WorkflowStepStatus.BLOCKED;
  timedOut.steps[2].error = 'workflow_publication_ci_timeout';
  workflowEngine.plan = timedOut;

  const completed = structuredClone(timedOut);
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
        requestFingerprint: parsed.requestFingerprint, request: parsed.request, workflowId: timedOut.id,
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

test('GitHubIssueChannel uses bounded pagination and authenticated issue-comment writes', async () => {
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

test('approval fingerprints bind exact dry-run and exact awaiting workflow state', () => {
  const plan = workflowPlan();
  const start = startApprovalFingerprint({ requestFingerprint: '1'.repeat(64), workflow: plan, dryRun: dryRun(plan) });
  const changed = dryRun(plan);
  changed.plannedSteps[0].specialistAuthority = 'external-write';
  const changedStart = startApprovalFingerprint({ requestFingerprint: '1'.repeat(64), workflow: plan, dryRun: changed });
  assert.notEqual(start, changedStart);

  plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  plan.steps[0].status = WorkflowStepStatus.COMPLETED;
  plan.steps[1].status = WorkflowStepStatus.AWAITING_APPROVAL;
  const checkpoint = workflowApprovalFingerprint({ requestFingerprint: '1'.repeat(64), workflow: plan, stepId: 'plan-change' });
  plan.steps[1].evidence = { detail: 'changed' };
  const changedCheckpoint = workflowApprovalFingerprint({ requestFingerprint: '1'.repeat(64), workflow: plan, stepId: 'plan-change' });
  assert.notEqual(checkpoint, changedCheckpoint);
});
