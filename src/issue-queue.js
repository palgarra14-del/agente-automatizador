import { createHash } from 'node:crypto';
import { maskSecrets, WorkflowStepStatus } from './core.js';

export const ISSUE_REQUEST_MARKER = '<!-- agent-request:v1 -->';
const approvalPattern = /^\/agent\s+(approve|reject)\s+([a-f0-9]{64})$/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertObjectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function boundedString(value, label, { required = false, max = 1_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function pathList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error(`${label} must be an array with at most 40 items`);
  return [...new Set(value.map((item, index) => {
    const path = boundedString(item, `${label}[${index}]`, { required: true, max: 240 }).replaceAll('\\', '/');
    if (path.startsWith('/') || path.includes('..') || /[\r\n\0]/.test(path)) throw new Error(`${label}[${index}] is not a safe repository-relative path`);
    return path.replace(/^\.\//, '').replace(/\/$/, '');
  }))].sort();
}

export function normalizeIssueRequest(value) {
  assertObjectKeys(value, new Set(['version', 'projectId', 'profile', 'goal', 'scope']), 'agent request');
  if (value.version !== 1) throw new Error('agent request version must be 1');
  if (value.profile !== 'app-improvement') throw new Error('issue queue currently supports only app-improvement');
  const scope = value.scope ?? {};
  assertObjectKeys(scope, new Set(['allowedPaths', 'forbiddenPaths']), 'agent request scope');
  return {
    version: 1,
    projectId: boundedString(value.projectId, 'agent request projectId', { required: true, max: 80 }),
    profile: 'app-improvement',
    goal: boundedString(value.goal, 'agent request goal', { required: true, max: 1_000 }),
    scope: {
      allowedPaths: pathList(scope.allowedPaths, 'agent request scope.allowedPaths'),
      forbiddenPaths: pathList(scope.forbiddenPaths, 'agent request scope.forbiddenPaths')
    }
  };
}

export function parseIssueRequestBody(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 16 * 1024) throw new Error('agent request body is missing or exceeds 16 KiB');
  const markerIndex = body.indexOf(ISSUE_REQUEST_MARKER);
  if (markerIndex < 0 || body.indexOf(ISSUE_REQUEST_MARKER, markerIndex + ISSUE_REQUEST_MARKER.length) >= 0) throw new Error('agent request body must contain exactly one request marker');
  const before = body.slice(0, markerIndex).trim();
  const after = body.slice(markerIndex + ISSUE_REQUEST_MARKER.length).trim();
  if (before) throw new Error('agent request marker must be the first non-whitespace content');
  let parsed;
  try { parsed = JSON.parse(after); }
  catch (error) { throw new Error(`agent request JSON is invalid: ${error.message}`, { cause: error }); }
  const request = normalizeIssueRequest(parsed);
  return { request, requestFingerprint: fingerprint(request) };
}

export function parseApprovalComment(body) {
  if (typeof body !== 'string') return null;
  const match = approvalPattern.exec(body.trim());
  if (!match) return null;
  return { decision: match[1].toLowerCase(), approvalFingerprint: match[2].toLowerCase() };
}

function stepApprovalContext(plan, step) {
  return {
    workflowId: plan.id,
    projectId: plan.projectId,
    profile: plan.profile,
    inputFingerprint: plan.inputFingerprint ?? null,
    registryFingerprint: plan.registryFingerprint,
    projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: plan.specialistRegistryFingerprint,
    workspace: plan.workspace ? {
      managed: Boolean(plan.workspace.managed),
      baseHead: plan.workspace.baseHead ?? null,
      workingBranch: plan.workspace.workingBranch ?? null,
      remote: plan.workspace.remote ?? null
    } : null,
    modelCalls: plan.modelUsage?.calls ?? 0,
    step: {
      id: step.id,
      type: step.type,
      skill: step.skill,
      status: step.status,
      error: step.error ?? null,
      evidence: step.evidence ?? null
    }
  };
}

export function startApprovalFingerprint({ requestFingerprint, workflow, dryRun }) {
  return fingerprint({
    kind: 'start',
    requestFingerprint,
    workflowId: workflow.id,
    projectId: workflow.projectId,
    profile: workflow.profile,
    registryFingerprint: workflow.registryFingerprint,
    projectSkillPolicyFingerprint: workflow.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: workflow.specialistRegistryFingerprint,
    inputFingerprint: workflow.inputFingerprint ?? null,
    scope: workflow.scope,
    plannedSteps: dryRun.plannedSteps?.map((step) => ({
      id: step.id,
      type: step.type,
      skill: step.skill,
      specialist: step.specialist,
      specialistAuthority: step.specialistAuthority,
      commands: step.commands
    })) ?? [],
    plannedExternalWrites: dryRun.plannedExternalWrites ?? []
  });
}

export function workflowApprovalFingerprint({ requestFingerprint, workflow, stepId }) {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step || step.status !== WorkflowStepStatus.AWAITING_APPROVAL) throw new Error('workflow approval target is not awaiting approval');
  return fingerprint({ kind: 'workflow-step', requestFingerprint, context: stepApprovalContext(workflow, step) });
}

function approvalInstruction(token) {
  return `/agent approve ${token}`;
}

function rejectionInstruction(token) {
  return `/agent reject ${token}`;
}

function compactDryRun(dryRun) {
  return {
    workflowId: dryRun.id,
    projectId: dryRun.projectId,
    profile: dryRun.profile,
    steps: (dryRun.plannedSteps ?? []).map((step) => ({
      id: step.id,
      skill: step.skill,
      specialist: step.specialist,
      authority: step.specialistAuthority,
      commands: step.commands
    })),
    externalWrites: dryRun.plannedExternalWrites ?? []
  };
}

function publicationSummary(workflow) {
  const publication = workflow.steps?.find((step) => step.id === 'publication');
  if (!publication?.evidence) return null;
  return {
    pullRequest: publication.evidence.pullRequest?.url ?? null,
    pullRequestNumber: publication.evidence.pullRequest?.number ?? null,
    commitSha: publication.evidence.commit?.finalHead ?? null,
    previewUrl: publication.evidence.preview?.url ?? null,
    previewState: publication.evidence.preview?.state ?? null
  };
}

export class GitHubIssueChannel {
  constructor({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, repository } = {}) {
    if (!repository?.owner || !repository?.name) throw new Error('issue channel repository is required');
    this.token = token;
    this.fetch = fetchImpl;
    this.repository = { owner: repository.owner, name: repository.name };
  }

  headers() {
    if (!this.token) throw new Error('GITHUB_TOKEN is required for issue queue');
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' };
  }

  path(suffix = '') {
    return `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}${suffix}`;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...this.headers(), ...(options.headers ?? {}) }
    });
    if (!response.ok) throw new Error(`GitHub issue queue request failed: ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  async openIssues({ perPage = 100, maxPages = 5 } = {}) {
    const issues = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request(this.path(`/issues?state=open&sort=created&direction=asc&per_page=${perPage}&page=${page}`));
      if (!Array.isArray(batch)) throw new Error('GitHub issue queue response is invalid');
      issues.push(...batch.filter((issue) => !issue.pull_request));
      if (batch.length < perPage) return issues;
    }
    throw new Error('GitHub issue queue pagination limit exceeded');
  }

  async issue(number) {
    return this.request(this.path(`/issues/${encodeURIComponent(number)}`));
  }

  async comments(number, { perPage = 100, maxPages = 5 } = {}) {
    const comments = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request(this.path(`/issues/${encodeURIComponent(number)}/comments?per_page=${perPage}&page=${page}`));
      if (!Array.isArray(batch)) throw new Error('GitHub issue comments response is invalid');
      comments.push(...batch);
      if (batch.length < perPage) return comments;
    }
    throw new Error('GitHub issue comments pagination limit exceeded');
  }

  async comment(number, body) {
    const result = await this.request(this.path(`/issues/${encodeURIComponent(number)}/comments`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    return { id: result.id, url: result.html_url ?? null };
  }
}

export class SupervisedIssueQueue {
  constructor({ store, projects, workflowEngine, channel, allowedActors, now = () => new Date().toISOString() } = {}) {
    if (!store || !projects || !workflowEngine || !channel) throw new Error('SupervisedIssueQueue requires store, projects, workflowEngine, and channel');
    if (!Array.isArray(allowedActors) || !allowedActors.length) throw new Error('SupervisedIssueQueue requires at least one allowed actor');
    this.store = store;
    this.projects = projects;
    this.workflowEngine = workflowEngine;
    this.channel = channel;
    this.allowedActors = new Set(allowedActors.map((actor) => boundedString(actor, 'allowed actor', { required: true, max: 80 }).toLowerCase()));
    this.now = now;
  }

  requestKey(issue) {
    return `${this.channel.repository.owner}/${this.channel.repository.name}#${issue.number}`;
  }

  async getRecord(key) {
    return (await this.store.load()).requests?.[key] ?? null;
  }

  async saveRecord(key, record) {
    return this.store.mutate((data) => {
      data.requests ??= {};
      data.requests[key] = record;
      return record;
    });
  }

  authorized(login) {
    return typeof login === 'string' && this.allowedActors.has(login.toLowerCase());
  }

  async post(number, text) {
    return this.channel.comment(number, text);
  }

  async initializeIssue(issue, parsed) {
    if (!this.authorized(issue.user?.login)) return null;
    if (!this.projects.has(parsed.request.projectId)) {
      await this.post(issue.number, `Agent request rejected: unknown registered project \`${parsed.request.projectId}\`.`);
      return this.saveRecord(this.requestKey(issue), {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
        requestFingerprint: parsed.requestFingerprint, request: parsed.request, workflowId: null,
        status: 'rejected', reason: 'unknown_project', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null, lastProcessedCommentId: 0
      });
    }
    const workflow = await this.workflowEngine.create({
      profile: parsed.request.profile,
      projectId: parsed.request.projectId,
      goal: parsed.request.goal,
      scope: parsed.request.scope
    });
    const dryRun = await this.workflowEngine.run(workflow.id, { dryRun: true });
    const token = startApprovalFingerprint({ requestFingerprint: parsed.requestFingerprint, workflow, dryRun });
    const record = {
      version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
      requestFingerprint: parsed.requestFingerprint, request: parsed.request, workflowId: workflow.id,
      status: 'awaiting_start_approval', reason: null, createdAt: this.now(), updatedAt: this.now(),
      pendingApproval: { kind: 'start', stepId: 'start', fingerprint: token },
      lastProcessedCommentId: 0
    };
    await this.saveRecord(this.requestKey(issue), record);
    const summary = compactDryRun(dryRun);
    await this.post(issue.number, [
      'Agent dry-run prepared. No Codex call, project write, Git write, PR creation, or deployment was performed.',
      '',
      `Workflow: \`${workflow.id}\``,
      `Project/profile: \`${workflow.projectId}\` / \`${workflow.profile}\``,
      `Planned steps: ${summary.steps.map((step) => `${step.id}[${step.specialist}/${step.authority}]`).join(' → ')}`,
      `Planned external writes: ${summary.externalWrites.length ? summary.externalWrites.map((write) => write.id).join(', ') : 'none'}`,
      '',
      'To authorize the first real execution transition, post exactly:',
      `\`${approvalInstruction(token)}\``,
      '',
      'To reject this request, post exactly:',
      `\`${rejectionInstruction(token)}\``
    ].join('\n'));
    return record;
  }

  async findDecision(issueNumber, record) {
    const comments = await this.channel.comments(issueNumber);
    const eligible = comments
      .filter((comment) => Number.isInteger(comment.id) && comment.id > (record.lastProcessedCommentId ?? 0))
      .sort((a, b) => a.id - b.id);
    let highest = record.lastProcessedCommentId ?? 0;
    let decision = null;
    for (const comment of eligible) {
      highest = Math.max(highest, comment.id);
      const parsed = parseApprovalComment(comment.body);
      if (!parsed || !this.authorized(comment.user?.login)) continue;
      if (parsed.approvalFingerprint !== record.pendingApproval?.fingerprint) continue;
      decision = { ...parsed, commentId: comment.id, actor: comment.user.login };
      break;
    }
    return { decision, highestCommentId: highest };
  }

  async persistPendingWorkflowApproval(issue, key, record, workflow) {
    const step = workflow.steps.find((candidate) => candidate.status === WorkflowStepStatus.AWAITING_APPROVAL);
    if (!step) throw new Error('workflow reports awaiting approval without an awaiting step');
    const token = workflowApprovalFingerprint({ requestFingerprint: record.requestFingerprint, workflow, stepId: step.id });
    const already = record.status === 'awaiting_workflow_approval' && record.pendingApproval?.fingerprint === token;
    const next = {
      ...record,
      status: 'awaiting_workflow_approval',
      reason: null,
      updatedAt: this.now(),
      pendingApproval: { kind: 'workflow-step', stepId: step.id, fingerprint: token }
    };
    await this.saveRecord(key, next);
    if (!already) {
      await this.post(issue.number, [
        `Agent workflow is awaiting explicit approval for step \`${step.id}\` (skill \`${step.skill}\`).`,
        `Current workflow status: \`${workflow.status}\`.`,
        '',
        'Approve exactly this persisted state with:',
        `\`${approvalInstruction(token)}\``,
        '',
        'Reject with:',
        `\`${rejectionInstruction(token)}\``
      ].join('\n'));
    }
    return next;
  }

  async settleWorkflow(issue, key, record, workflow) {
    if (workflow.status === WorkflowStepStatus.AWAITING_APPROVAL) return this.persistPendingWorkflowApproval(issue, key, record, workflow);
    if (workflow.status === WorkflowStepStatus.COMPLETED) {
      const published = publicationSummary(workflow);
      const next = { ...record, status: 'completed', reason: null, updatedAt: this.now(), pendingApproval: null, publication: published };
      await this.saveRecord(key, next);
      await this.post(issue.number, [
        'Agent workflow completed its Definition of Done.',
        published?.pullRequest ? `Pull request: ${published.pullRequest}` : 'Pull request: not recorded',
        published?.previewUrl ? `Preview: ${published.previewUrl}` : 'Preview: not recorded',
        'No merge or production deployment was performed by the issue queue.'
      ].join('\n'));
      return next;
    }
    if (workflow.status === WorkflowStepStatus.FAILED || workflow.status === WorkflowStepStatus.BLOCKED) {
      const reason = maskSecrets(workflow.result?.error ?? workflow.status);
      const next = { ...record, status: workflow.status, reason, updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, `Agent workflow stopped with status \`${workflow.status}\`: \`${reason}\`. No automatic merge/production action was attempted.`);
      return next;
    }
    const next = { ...record, status: 'running', reason: null, updatedAt: this.now(), pendingApproval: null };
    await this.saveRecord(key, next);
    return next;
  }

  async processExisting(issue, parsed, record) {
    const key = this.requestKey(issue);
    if (parsed.requestFingerprint !== record.requestFingerprint) {
      const next = { ...record, status: 'blocked', reason: 'request_body_changed', updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, 'Agent request blocked: the issue body changed after the request fingerprint was accepted. Create a new request instead of editing an approved one.');
      return next;
    }
    if (['completed', 'failed', 'blocked', 'rejected'].includes(record.status)) return record;

    if (record.pendingApproval) {
      const { decision, highestCommentId } = await this.findDecision(issue.number, record);
      if (highestCommentId > (record.lastProcessedCommentId ?? 0)) {
        record = await this.saveRecord(key, { ...record, lastProcessedCommentId: highestCommentId, updatedAt: this.now() });
      }
      if (!decision) return record;
      if (decision.decision === 'reject') {
        const next = { ...record, status: 'rejected', reason: `rejected_by:${decision.actor}`, updatedAt: this.now(), pendingApproval: null };
        await this.saveRecord(key, next);
        await this.post(issue.number, `Agent request rejected by \`${decision.actor}\`. No further execution will occur.`);
        return next;
      }
      if (record.pendingApproval.kind === 'start') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        const dryRun = await this.workflowEngine.run(record.workflowId, { dryRun: true });
        const expected = startApprovalFingerprint({ requestFingerprint: record.requestFingerprint, workflow, dryRun });
        if (expected !== record.pendingApproval.fingerprint) {
          const next = { ...record, status: 'blocked', reason: 'start_approval_stale', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent start approval became stale because the workflow plan changed. Create a new request.');
          return next;
        }
        record = await this.saveRecord(key, { ...record, status: 'running', pendingApproval: null, updatedAt: this.now() });
        const result = await this.workflowEngine.run(record.workflowId);
        return this.settleWorkflow(issue, key, record, result);
      }
      if (record.pendingApproval.kind === 'workflow-step') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        const expected = workflowApprovalFingerprint({ requestFingerprint: record.requestFingerprint, workflow, stepId: record.pendingApproval.stepId });
        if (expected !== record.pendingApproval.fingerprint) {
          const next = { ...record, status: 'blocked', reason: 'workflow_approval_stale', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent workflow approval became stale because the persisted workflow state changed. Manual inspection is required.');
          return next;
        }
        await this.workflowEngine.approve(record.workflowId, record.pendingApproval.stepId);
        record = await this.saveRecord(key, { ...record, status: 'running', pendingApproval: null, updatedAt: this.now() });
        const result = await this.workflowEngine.run(record.workflowId);
        return this.settleWorkflow(issue, key, record, result);
      }
    }

    const workflow = await this.workflowEngine.get(record.workflowId);
    if (!workflow) {
      const next = { ...record, status: 'blocked', reason: 'workflow_missing', updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      return next;
    }
    if (workflow.status === WorkflowStepStatus.PENDING) {
      const result = await this.workflowEngine.run(workflow.id);
      return this.settleWorkflow(issue, key, record, result);
    }
    if (workflow.status === WorkflowStepStatus.RUNNING) {
      const result = await this.workflowEngine.resume(workflow.id);
      return this.settleWorkflow(issue, key, record, result);
    }
    return this.settleWorkflow(issue, key, record, workflow);
  }

  async processIssue(issue) {
    if (!Number.isInteger(issue?.number) || !issue.id || issue.state !== 'open' || issue.pull_request) return null;
    if (typeof issue.body !== 'string' || !issue.body.includes(ISSUE_REQUEST_MARKER)) return null;
    let parsed;
    try { parsed = parseIssueRequestBody(issue.body); }
    catch (error) {
      const key = this.requestKey(issue);
      const existing = await this.getRecord(key);
      if (!existing && this.authorized(issue.user?.login)) {
        await this.post(issue.number, `Agent request rejected during parsing: \`${maskSecrets(error.message)}\`.`);
        await this.saveRecord(key, {
          version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
          requestFingerprint: null, request: null, workflowId: null, status: 'rejected',
          reason: 'invalid_request', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null, lastProcessedCommentId: 0
        });
      }
      return null;
    }
    const key = this.requestKey(issue);
    const existing = await this.getRecord(key);
    return existing ? this.processExisting(issue, parsed, existing) : this.initializeIssue(issue, parsed);
  }

  async tick() {
    const issues = await this.channel.openIssues();
    for (const issue of issues) {
      if (typeof issue.body !== 'string' || !issue.body.includes(ISSUE_REQUEST_MARKER)) continue;
      const result = await this.processIssue(issue);
      if (result && !['completed', 'failed', 'blocked', 'rejected'].includes(result.status)) return result;
    }
    return null;
  }
}

export async function watchIssueQueue(queue, { pollIntervalMs = 15_000, signal, onTick } = {}) {
  if (!queue) throw new Error('watchIssueQueue requires a queue');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000) throw new Error('issue queue pollIntervalMs must be at least 1000');
  for (;;) {
    if (signal?.aborted) return;
    const result = await queue.tick();
    await onTick?.(result);
    if (signal?.aborted) return;
    await new Promise((resolveSleep) => {
      const timer = setTimeout(resolveSleep, pollIntervalMs);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolveSleep(); }, { once: true });
    });
  }
}
