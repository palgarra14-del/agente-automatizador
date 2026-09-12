import { createHash, randomUUID } from 'node:crypto';
import { maskSecrets, readBoundedRegularFile, WorkflowStepStatus } from './core.js';

export const ISSUE_REQUEST_MARKER = '<!-- agent-request:v1 -->';
const approvalPattern = /^\/agent\s+(approve|reject)\s+([a-f0-9]{64})$/i;

export function normalizeIssueQueueConfig(value) {
  assertObjectKeys(value, new Set(['version', 'repository', 'allowedActors', 'pollIntervalMs']), 'issue queue config');
  if (value.version !== 1) throw new Error('issue queue config version must be 1');
  assertObjectKeys(value.repository, new Set(['owner', 'name']), 'issue queue config repository');
  const owner = boundedString(value.repository.owner, 'issue queue repository owner', { required: true, max: 100 }).toLowerCase();
  const name = boundedString(value.repository.name, 'issue queue repository name', { required: true, max: 100 }).toLowerCase();
  if (!Array.isArray(value.allowedActors) || value.allowedActors.length < 1 || value.allowedActors.length > 20) throw new Error('issue queue allowedActors must contain between 1 and 20 logins');
  const allowedActors = [...new Set(value.allowedActors.map((actor, index) => boundedString(actor, `issue queue allowedActors[${index}]`, { required: true, max: 80 }).toLowerCase()))].sort();
  const pollIntervalMs = value.pollIntervalMs ?? 15_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) throw new Error('issue queue pollIntervalMs must be between 1000 and 300000');
  return { version: 1, repository: { owner, name }, allowedActors, pollIntervalMs };
}

export async function loadIssueQueueConfig(file) {
  let parsed;
  try {
    const content = await readBoundedRegularFile(file, { maxBytes: 16 * 1024, label: 'Issue queue config' });
    parsed = JSON.parse(content.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid issue queue config JSON: ${error.message}`, { cause: error });
    throw error;
  }
  return normalizeIssueQueueConfig(parsed);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function textFingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function projectExecutionFingerprint(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project) || typeof project.id !== 'string' || !project.id) {
    throw new Error('project execution context is invalid');
  }
  return fingerprint({
    id: project.id,
    repository: project.repository ?? null,
    defaultBranch: project.defaultBranch ?? null,
    workingBranchPattern: project.workingBranchPattern ?? null,
    protectedBranches: project.protectedBranches ?? [],
    workspace: project.workspace ?? null,
    workspaceStrategy: project.workspaceStrategy ?? null,
    managedWorkspaceRoot: project.managedWorkspaceRoot ?? null,
    commandEnvironment: project.commandEnvironment ?? {},
    execution: project.execution ?? null,
    toolchain: project.toolchain ?? null,
    changePolicy: project.changePolicy ?? null,
    commands: project.commands ?? {},
    policies: project.policies ?? null,
    acceptance: project.acceptance ?? null,
    deployment: project.deployment ?? null,
    budgets: project.budgets ?? null,
    skills: project.skills ?? null,
    pullRequest: project.pullRequest ?? null
  });
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
    const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.') throw new Error(`${label}[${index}] must identify a bounded repository path, not the repository root`);
    return normalized;
  }))].sort();
}

export function normalizeIssueRequest(value) {
  assertObjectKeys(value, new Set(['version', 'projectId', 'profile', 'goal', 'scope']), 'agent request');
  if (value.version !== 1) throw new Error('agent request version must be 1');
  if (value.profile !== 'app-improvement') throw new Error('issue queue currently supports only app-improvement');
  if (!value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)) throw new Error('agent request scope is required');
  const scope = value.scope;
  assertObjectKeys(scope, new Set(['allowedPaths', 'forbiddenPaths']), 'agent request scope');
  const allowedPaths = pathList(scope.allowedPaths, 'agent request scope.allowedPaths');
  if (allowedPaths.length < 1) throw new Error('agent request scope.allowedPaths must contain at least one bounded path');
  return {
    version: 1,
    projectId: boundedString(value.projectId, 'agent request projectId', { required: true, max: 80 }),
    profile: 'app-improvement',
    goal: maskSecrets(boundedString(value.goal, 'agent request goal', { required: true, max: 1_000 })),
    scope: {
      allowedPaths,
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
  return {
    request,
    requestFingerprint: fingerprint(request),
    issueBodyFingerprint: textFingerprint(body)
  };
}

export function parseApprovalComment(body) {
  if (typeof body !== 'string') return null;
  const match = approvalPattern.exec(body.trim());
  if (!match) return null;
  return { decision: match[1].toLowerCase(), approvalFingerprint: match[2].toLowerCase() };
}

function approvalWorkflowContext(plan, targetStepId) {
  return {
    workflowId: plan.id,
    projectId: plan.projectId,
    profile: plan.profile,
    goal: plan.goal,
    status: plan.status,
    inputFingerprint: plan.inputFingerprint ?? null,
    registryFingerprint: plan.registryFingerprint,
    projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: plan.specialistRegistryFingerprint,
    scope: plan.scope,
    workspace: plan.workspace ? {
      managed: Boolean(plan.workspace.managed),
      path: plan.workspace.path ?? null,
      baseHead: plan.workspace.baseHead ?? null,
      workingBranch: plan.workspace.workingBranch ?? null,
      remote: plan.workspace.remote ?? null
    } : null,
    bootstrap: plan.bootstrap ?? null,
    modelUsage: plan.modelUsage ?? null,
    outputBytes: plan.outputBytes ?? 0,
    targetStepId,
    steps: plan.steps.map((step) => ({
      id: step.id,
      type: step.type,
      skill: step.skill,
      specialist: step.specialist,
      status: step.status,
      dependsOn: step.dependsOn,
      attempts: step.attempts,
      commands: step.commands,
      error: step.error ?? null,
      evidence: step.evidence ?? null
    }))
  };
}

export function startApprovalFingerprint({ requestFingerprint, issueBodyFingerprint, projectFingerprint, controlPlaneFingerprint, workflow, dryRun }) {
  return fingerprint({
    kind: 'start',
    requestFingerprint,
    issueBodyFingerprint,
    projectFingerprint,
    controlPlaneFingerprint,
    workflow: approvalWorkflowContext(workflow, 'start'),
    dryRun: {
      plannedBootstrap: dryRun.plannedBootstrap ?? null,
      plannedSteps: dryRun.plannedSteps?.map((step) => ({
        id: step.id,
        type: step.type,
        status: step.status,
        dependsOn: step.dependsOn,
        skill: step.skill,
        specialist: step.specialist,
        specialistMode: step.specialistMode,
        specialistAuthority: step.specialistAuthority,
        capability: step.capability ?? null,
        commands: step.commands
      })) ?? [],
      plannedExternalWrites: dryRun.plannedExternalWrites ?? []
    }
  });
}

function stepNeedsHumanApproval(step) {
  return step?.status === WorkflowStepStatus.AWAITING_APPROVAL ||
    (step?.status === WorkflowStepStatus.BLOCKED && step.error === 'interrupted_step_requires_human_approval');
}

export function workflowApprovalFingerprint({ requestFingerprint, issueBodyFingerprint, projectFingerprint, controlPlaneFingerprint, workflow, stepId }) {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!stepNeedsHumanApproval(step)) throw new Error('workflow approval target does not require human approval');
  return fingerprint({
    kind: 'workflow-step',
    requestFingerprint,
    issueBodyFingerprint,
    projectFingerprint,
    controlPlaneFingerprint,
    context: approvalWorkflowContext(workflow, stepId)
  });
}

function compactMaskedJson(value, maxBytes = 6_000) {
  let serialized;
  try { serialized = JSON.stringify(canonical(value), null, 2); }
  catch { serialized = '"[UNSERIALIZABLE]"'; }
  const masked = maskSecrets(serialized);
  return Buffer.from(masked, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function approvalEvidenceSummary(workflow, step) {
  if (workflow.profile !== 'app-improvement') return null;
  if (step.id === 'plan-change') {
    return compactMaskedJson({
      inspection: workflow.steps.find((candidate) => candidate.id === 'inspect-project')?.evidence?.result ?? null,
      diagnosis: workflow.steps.find((candidate) => candidate.id === 'diagnose')?.evidence?.result ?? null
    });
  }
  if (step.id === 'implementation' && step.error === 'workflow_sensitive_change_requires_approval') {
    return compactMaskedJson({
      classification: step.evidence?.changePolicy?.classification ?? null,
      reason: step.evidence?.changePolicy?.reason ?? null,
      paths: step.evidence?.changePolicy?.paths ?? step.evidence?.changeSet?.paths ?? [],
      changeSetFingerprint: step.evidence?.changeSetFingerprint ?? null
    });
  }
  if (step.id === 'release-readiness') {
    const implementation = workflow.steps.find((candidate) => candidate.id === 'implementation');
    const review = workflow.steps.find((candidate) => candidate.id === 'review');
    const tests = workflow.steps.find((candidate) => candidate.id === 'tests');
    const verification = workflow.steps.find((candidate) => candidate.id === 'verification');
    return compactMaskedJson({
      changedPaths: implementation?.evidence?.changeSet?.paths ?? [],
      changeSetFingerprint: implementation?.evidence?.changeSetFingerprint ?? null,
      review: review?.evidence?.result ?? null,
      tests: { status: tests?.status ?? null, error: tests?.error ?? null },
      verification: { status: verification?.status ?? null, error: verification?.error ?? null }
    });
  }
  if (step.error === 'interrupted_step_requires_human_approval') {
    return compactMaskedJson({ interruptedStep: step.id, skill: step.skill, error: step.error });
  }
  return null;
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

const requestStatuses = new Set(['initializing', 'awaiting_start_approval', 'running', 'awaiting_workflow_approval', 'completed', 'failed', 'blocked', 'rejected']);

export function validateIssueQueueRecord(record, { issue, requestFingerprint, issueBodyFingerprint, projectFingerprint, controlPlaneFingerprint } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1) throw new Error('issue queue record version is invalid');
  if (!Number.isInteger(record.issueNumber) || record.issueNumber < 1 || !record.issueId) throw new Error('issue queue record issue identity is invalid');
  if (issue && (record.issueNumber !== issue.number || record.issueId !== issue.id || record.author !== issue.user?.login)) throw new Error('issue queue record no longer matches issue identity');
  if (!requestStatuses.has(record.status)) throw new Error('issue queue record status is invalid');
  if (!Number.isInteger(record.lastProcessedCommentId) || record.lastProcessedCommentId < 0) throw new Error('issue queue record comment cursor is invalid');
  if (record.request !== null) {
    const normalized = normalizeIssueRequest(record.request);
    if (JSON.stringify(normalized) !== JSON.stringify(record.request)) throw new Error('issue queue record request is not normalized');
    const expected = fingerprint(normalized);
    if (record.requestFingerprint !== expected) throw new Error('issue queue record request fingerprint is invalid');
    if (requestFingerprint && expected !== requestFingerprint) throw new Error('issue queue record request fingerprint no longer matches issue body');
    if (!/^[a-f0-9]{64}$/.test(record.issueBodyFingerprint ?? '')) throw new Error('issue queue record issue-body fingerprint is invalid');
    if (issueBodyFingerprint && record.issueBodyFingerprint !== issueBodyFingerprint) throw new Error('issue queue record issue-body fingerprint no longer matches issue body');
    if (record.status !== 'rejected' && !/^[a-f0-9]{64}$/.test(record.projectFingerprint ?? '')) throw new Error('issue queue record project fingerprint is invalid');
    if (projectFingerprint && record.projectFingerprint !== projectFingerprint) throw new Error('issue queue record project fingerprint no longer matches active project');
    if (!/^[a-f0-9]{64}$/.test(record.controlPlaneFingerprint ?? '')) throw new Error('issue queue record control-plane fingerprint is invalid');
    if (controlPlaneFingerprint && record.controlPlaneFingerprint !== controlPlaneFingerprint) throw new Error('issue queue record control-plane fingerprint no longer matches active authority');
  }
  if (record.workflowId !== null && (typeof record.workflowId !== 'string' || !record.workflowId.trim())) throw new Error('issue queue record workflowId is invalid');
  if (record.startApprovalFingerprint !== null && record.startApprovalFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.startApprovalFingerprint)) throw new Error('issue queue start approval fingerprint is invalid');
  if (record.status === 'initializing') {
    const lease = record.initializationLease;
    if (!lease || typeof lease.leaseId !== 'string' || !lease.leaseId || !Number.isInteger(lease.pid) || lease.pid <= 0 || !Number.isFinite(Date.parse(lease.createdAt ?? ''))) throw new Error('issue queue initialization lease is invalid');
  } else if (record.initializationLease !== null && record.initializationLease !== undefined) throw new Error('settled issue queue record cannot retain initialization lease');
  if (record.pendingApproval !== null && record.pendingApproval !== undefined) {
    if (!['start', 'workflow-step'].includes(record.pendingApproval.kind) || typeof record.pendingApproval.stepId !== 'string' || !/^[a-f0-9]{64}$/.test(record.pendingApproval.fingerprint ?? '')) throw new Error('issue queue pending approval is invalid');
  }
  return true;
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
  constructor({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, repository, requestTimeoutMs = 30_000 } = {}) {
    if (!repository?.owner || !repository?.name) throw new Error('issue channel repository is required');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) throw new Error('issue channel requestTimeoutMs must be between 1000 and 120000');
    this.token = token;
    this.fetch = fetchImpl;
    this.repository = {
      owner: boundedString(repository.owner, 'issue channel repository owner', { required: true, max: 100 }).toLowerCase(),
      name: boundedString(repository.name, 'issue channel repository name', { required: true, max: 100 }).toLowerCase()
    };
    this.requestTimeoutMs = requestTimeoutMs;
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
      signal: options.signal ?? globalThis.AbortSignal.timeout(this.requestTimeoutMs),
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

  controlPlaneFingerprint() {
    return fingerprint({
      repository: this.channel.repository,
      allowedActors: [...this.allowedActors].sort()
    });
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

  async claimInitialization(issue, parsed, projectFingerprintValue) {
    const key = this.requestKey(issue);
    const ownerIdentity = await this.store.ownerIdentity(process.pid);
    return this.store.mutate((data) => {
      data.requests ??= {};
      if (data.requests[key]) return { claimed: false, record: data.requests[key] };
      const now = this.now();
      const record = {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
        requestFingerprint: parsed.requestFingerprint, issueBodyFingerprint: parsed.issueBodyFingerprint,
        projectFingerprint: projectFingerprintValue, controlPlaneFingerprint: this.controlPlaneFingerprint(),
        request: parsed.request, workflowId: null,
        status: 'initializing', reason: null, createdAt: now, updatedAt: now, pendingApproval: null,
        startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null,
        initializationLease: { leaseId: randomUUID(), pid: process.pid, createdAt: now, ownerIdentity },
        lastProcessedCommentId: 0
      };
      data.requests[key] = record;
      return { claimed: true, record };
    });
  }

  authorized(login) {
    return typeof login === 'string' && this.allowedActors.has(login.toLowerCase());
  }

  async post(number, text) {
    return this.channel.comment(number, text);
  }

  async revalidateCurrentRequest(issue, record) {
    const current = await this.channel.issue(issue.number);
    if (!current || current.state !== 'open' || current.pull_request ||
        current.number !== record.issueNumber || current.id !== record.issueId ||
        current.user?.login !== record.author) {
      return { ok: false, reason: 'issue_identity_or_state_changed' };
    }
    let parsed;
    try {
      parsed = parseIssueRequestBody(current.body);
    } catch {
      return { ok: false, reason: 'request_body_invalid' };
    }
    if (parsed.requestFingerprint !== record.requestFingerprint || parsed.issueBodyFingerprint !== record.issueBodyFingerprint) {
      return { ok: false, reason: 'request_body_changed' };
    }
    return { ok: true, issue: current, parsed };
  }

  async blockRequestRevalidation(issue, key, record, reason) {
    const next = { ...record, status: 'blocked', reason, updatedAt: this.now(), pendingApproval: null, initializationLease: null };
    await this.saveRecord(key, next);
    await this.post(issue.number, 'Agent request blocked: the accepted request/control context changed or can no longer be verified exactly. No further execution was authorized.');
    return next;
  }

  async initializeIssue(issue, parsed) {
    if (!this.authorized(issue.user?.login)) return null;
    const project = this.projects.get(parsed.request.projectId) ?? null;
    const activeProjectFingerprint = project ? projectExecutionFingerprint(project) : null;
    const claim = await this.claimInitialization(issue, parsed, activeProjectFingerprint);
    if (!claim.claimed) return claim.record;
    if (!project) {
      const rejected = {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
        requestFingerprint: parsed.requestFingerprint, issueBodyFingerprint: parsed.issueBodyFingerprint,
        projectFingerprint: null, controlPlaneFingerprint: this.controlPlaneFingerprint(),
        request: parsed.request, workflowId: null,
        status: 'rejected', reason: 'unknown_project', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null,
        startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, initializationLease: null, lastProcessedCommentId: 0
      };
      await this.saveRecord(this.requestKey(issue), rejected);
      await this.post(issue.number, `Agent request rejected: unknown registered project \`${parsed.request.projectId}\`.`);
      return rejected;
    }
    let workflow;
    let dryRun;
    try {
      workflow = await this.workflowEngine.create({
        profile: parsed.request.profile,
        projectId: parsed.request.projectId,
        goal: parsed.request.goal,
        scope: parsed.request.scope
      });
      dryRun = await this.workflowEngine.run(workflow.id, { dryRun: true });
    } catch (error) {
      const blocked = {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
        requestFingerprint: parsed.requestFingerprint, issueBodyFingerprint: parsed.issueBodyFingerprint,
        projectFingerprint: activeProjectFingerprint, controlPlaneFingerprint: this.controlPlaneFingerprint(),
        request: parsed.request, workflowId: workflow?.id ?? null,
        status: 'blocked', reason: 'workflow_initialization_failed', createdAt: this.now(), updatedAt: this.now(),
        pendingApproval: null, startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, initializationLease: null,
        lastProcessedCommentId: 0
      };
      await this.saveRecord(this.requestKey(issue), blocked);
      await this.post(issue.number, `Agent request blocked during workflow initialization/dry-run: \`${maskSecrets(error.message)}\`. No real execution was authorized.`);
      return blocked;
    }
    const token = startApprovalFingerprint({
      requestFingerprint: parsed.requestFingerprint,
      issueBodyFingerprint: parsed.issueBodyFingerprint,
      projectFingerprint: activeProjectFingerprint,
      controlPlaneFingerprint: this.controlPlaneFingerprint(),
      workflow,
      dryRun
    });
    const record = {
      version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
      requestFingerprint: parsed.requestFingerprint, issueBodyFingerprint: parsed.issueBodyFingerprint,
      projectFingerprint: activeProjectFingerprint, controlPlaneFingerprint: this.controlPlaneFingerprint(),
      request: parsed.request, workflowId: workflow.id,
      status: 'awaiting_start_approval', reason: null, createdAt: this.now(), updatedAt: this.now(),
      pendingApproval: { kind: 'start', stepId: 'start', fingerprint: token },
      startApprovalFingerprint: token,
      startApprovalCommentId: null,
      startApprovedBy: null, initializationLease: null,
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
    const instruction = record.pendingApproval?.fingerprint ? approvalInstruction(record.pendingApproval.fingerprint) : null;
    const instructionPresent = Boolean(instruction && comments.some((comment) =>
      typeof comment.body === 'string' &&
      this.authorized(comment.user?.login) &&
      comment.body.includes(instruction)
    ));
    const ordered = comments
      .filter((comment) => Number.isInteger(comment.id))
      .sort((a, b) => a.id - b.id);
    let highest = record.lastProcessedCommentId ?? 0;
    let decision = null;
    for (const comment of ordered) {
      highest = Math.max(highest, comment.id);
      const parsed = parseApprovalComment(comment.body);
      if (!parsed || !this.authorized(comment.user?.login)) continue;
      if (parsed.approvalFingerprint !== record.pendingApproval?.fingerprint) continue;
      decision = { ...parsed, commentId: comment.id, actor: comment.user.login };
    }
    return { decision, highestCommentId: highest, instructionPresent };
  }

  async historicalDecision(issueNumber, approvalFingerprint) {
    const comments = await this.channel.comments(issueNumber);
    let decision = null;
    for (const comment of comments
      .filter((candidate) => Number.isInteger(candidate.id))
      .sort((a, b) => a.id - b.id)) {
      const parsed = parseApprovalComment(comment.body);
      if (parsed?.approvalFingerprint === approvalFingerprint && this.authorized(comment.user?.login)) {
        decision = { ...parsed, commentId: comment.id, actor: comment.user.login };
      }
    }
    return decision;
  }

  workflowMatchesRecord(record, workflow) {
    return Boolean(
      workflow &&
      workflow.id === record.workflowId &&
      workflow.projectId === record.request?.projectId &&
      workflow.profile === record.request?.profile &&
      workflow.goal === record.request?.goal &&
      JSON.stringify(workflow.scope ?? {}) === JSON.stringify(record.request?.scope ?? {})
    );
  }

  workflowIsPristine(workflow) {
    if (!workflow || !Array.isArray(workflow.steps) || !workflow.steps.length) return false;
    if ((workflow.modelUsage?.calls ?? 0) !== 0 || workflow.workspace) return false;
    return workflow.steps.every((step, index) => index === 0 ? step.status === WorkflowStepStatus.READY : step.status === WorkflowStepStatus.PENDING);
  }

  completedCheckpointMatchesPendingApproval(record, workflow, stepId) {
    const target = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!target || target.type !== 'checkpoint' || target.status !== WorkflowStepStatus.COMPLETED || !target.evidence?.approvedAt) return false;
    const reconstructed = JSON.parse(JSON.stringify(workflow));
    const reconstructedTarget = reconstructed.steps.find((candidate) => candidate.id === stepId);
    reconstructed.status = WorkflowStepStatus.AWAITING_APPROVAL;
    reconstructedTarget.status = WorkflowStepStatus.AWAITING_APPROVAL;
    reconstructedTarget.error = null;
    reconstructedTarget.evidence = null;
    const expected = workflowApprovalFingerprint({
      requestFingerprint: record.requestFingerprint,
      issueBodyFingerprint: record.issueBodyFingerprint,
      projectFingerprint: record.projectFingerprint,
      controlPlaneFingerprint: record.controlPlaneFingerprint,
      workflow: reconstructed,
      stepId
    });
    return expected === record.pendingApproval?.fingerprint;
  }

  async persistPendingWorkflowApproval(issue, key, record, workflow) {
    const step = workflow.steps.find((candidate) => stepNeedsHumanApproval(candidate));
    if (!step) throw new Error('workflow reports human approval is needed without an approvable step');
    const token = workflowApprovalFingerprint({
      requestFingerprint: record.requestFingerprint,
      issueBodyFingerprint: record.issueBodyFingerprint,
      projectFingerprint: record.projectFingerprint,
      controlPlaneFingerprint: record.controlPlaneFingerprint,
      workflow,
      stepId: step.id
    });
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
      const reviewSummary = approvalEvidenceSummary(workflow, step);
      await this.post(issue.number, [
        `Agent workflow is awaiting explicit approval for step \`${step.id}\` (skill \`${step.skill}\`).`,
        `Current workflow status: \`${workflow.status}\`.`,
        ...(reviewSummary ? ['', 'Evidence bound to this approval fingerprint:', '```json', reviewSummary, '```'] : []),
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
    if (!this.workflowMatchesRecord(record, workflow)) {
      const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, 'Agent workflow no longer matches the accepted issue/project/profile/goal/scope binding. Manual inspection is required.');
      return next;
    }
    const interruptedApproval = workflow.status === WorkflowStepStatus.BLOCKED &&
      workflow.steps?.some((step) => step.status === WorkflowStepStatus.BLOCKED && step.error === 'interrupted_step_requires_human_approval');
    if (workflow.status === WorkflowStepStatus.AWAITING_APPROVAL || interruptedApproval) return this.persistPendingWorkflowApproval(issue, key, record, workflow);
    const resumableObservation = workflow.status === WorkflowStepStatus.BLOCKED &&
      workflow.steps?.some((step) => step.status === WorkflowStepStatus.BLOCKED && ['workflow_publication_ci_timeout', 'workflow_publication_preview_timeout'].includes(step.error));
    if (resumableObservation) {
      const next = { ...record, status: 'running', reason: 'resumable_publication_observation', updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      return next;
    }
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
    if (['completed', 'failed', 'blocked', 'rejected'].includes(record.status)) return record;
    const currentRequest = await this.revalidateCurrentRequest(issue, record);
    if (!currentRequest.ok) return this.blockRequestRevalidation(issue, key, record, currentRequest.reason);
    issue = currentRequest.issue;
    parsed = currentRequest.parsed;
    const activeProject = this.projects.get(record.request?.projectId);
    if (!activeProject || projectExecutionFingerprint(activeProject) !== record.projectFingerprint) {
      return this.blockRequestRevalidation(issue, key, record, 'project_config_changed');
    }
    if (this.controlPlaneFingerprint() !== record.controlPlaneFingerprint) {
      return this.blockRequestRevalidation(issue, key, record, 'control_plane_changed');
    }
    try {
      validateIssueQueueRecord(record, {
        issue,
        requestFingerprint: parsed.requestFingerprint,
        issueBodyFingerprint: parsed.issueBodyFingerprint,
        projectFingerprint: projectExecutionFingerprint(activeProject),
        controlPlaneFingerprint: this.controlPlaneFingerprint()
      });
    } catch (error) {
      const next = { ...record, status: 'blocked', reason: 'queue_state_invalid', updatedAt: this.now(), pendingApproval: null, initializationLease: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, `Agent request blocked because local queue state failed validation: \`${maskSecrets(error.message)}\`.`);
      return next;
    }
    if (record.status === 'initializing') {
      let abandoned;
      try { abandoned = await this.store.lockOwnerIsAbandoned(record.initializationLease); }
      catch { return record; }
      if (!abandoned) return record;
      const next = { ...record, status: 'blocked', reason: 'initialization_interrupted', initializationLease: null, updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, 'Agent request blocked because initialization was interrupted. No automatic retry or duplicate workflow was created; submit a new request after inspection.');
      return next;
    }

    if (record.pendingApproval) {
      const { decision, highestCommentId, instructionPresent } = await this.findDecision(issue.number, record);
      if (highestCommentId > (record.lastProcessedCommentId ?? 0)) {
        record = await this.saveRecord(key, { ...record, lastProcessedCommentId: highestCommentId, updatedAt: this.now() });
      }
      if (!decision) {
        if (!instructionPresent) {
          await this.post(issue.number, [
            `Agent approval instruction recovered for \`${record.pendingApproval.kind}\` / \`${record.pendingApproval.stepId}\`.`,
            'Approve exactly:',
            `\`${approvalInstruction(record.pendingApproval.fingerprint)}\``,
            'Or reject exactly:',
            `\`${rejectionInstruction(record.pendingApproval.fingerprint)}\``
          ].join('\n'));
        }
        return record;
      }
      if (decision.decision === 'reject') {
        const next = { ...record, status: 'rejected', reason: `rejected_by:${decision.actor}`, updatedAt: this.now(), pendingApproval: null };
        await this.saveRecord(key, next);
        await this.post(issue.number, `Agent request rejected by \`${decision.actor}\`. No further execution will occur.`);
        return next;
      }
      if (record.pendingApproval.kind === 'start') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        if (!this.workflowMatchesRecord(record, workflow)) {
          const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent start approval cannot be applied because the persisted workflow binding no longer matches the accepted request.');
          return next;
        }
        if (workflow.status !== WorkflowStepStatus.PENDING || !this.workflowIsPristine(workflow)) {
          const next = { ...record, status: 'blocked', reason: 'start_approval_state_diverged', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent start approval cannot be applied because the workflow is no longer pristine. Manual inspection is required.');
          return next;
        }
        const dryRun = await this.workflowEngine.run(record.workflowId, { dryRun: true });
        const expected = startApprovalFingerprint({
          requestFingerprint: record.requestFingerprint,
          issueBodyFingerprint: record.issueBodyFingerprint,
          projectFingerprint: record.projectFingerprint,
          controlPlaneFingerprint: record.controlPlaneFingerprint,
          workflow,
          dryRun
        });
        if (expected !== record.pendingApproval.fingerprint) {
          const next = { ...record, status: 'blocked', reason: 'start_approval_stale', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent start approval became stale because the workflow plan changed. Create a new request.');
          return next;
        }
        const currentBeforeExecution = await this.revalidateCurrentRequest(issue, record);
        if (!currentBeforeExecution.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeExecution.reason);
        issue = currentBeforeExecution.issue;
        const latestDecision = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
        if (latestDecision?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${latestDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, `Agent request rejected by \`${latestDecision.actor}\` before execution. No further execution will occur.`);
          return next;
        }
        if (latestDecision?.decision !== 'approve') return record;
        await this.workflowEngine.resetPristineDeadline(record.workflowId);
        record = await this.saveRecord(key, {
          ...record,
          status: 'running',
          pendingApproval: null,
          startApprovalFingerprint: expected,
          startApprovalCommentId: latestDecision.commentId,
          startApprovedBy: latestDecision.actor,
          updatedAt: this.now()
        });
        const result = await this.workflowEngine.run(record.workflowId);
        return this.settleWorkflow(issue, key, record, result);
      }
      if (record.pendingApproval.kind === 'workflow-step') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        if (!this.workflowMatchesRecord(record, workflow)) {
          const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent workflow approval cannot be applied because the persisted workflow binding no longer matches the accepted request.');
          return next;
        }
        if (!Array.isArray(workflow.steps)) {
          const next = { ...record, status: 'blocked', reason: 'workflow_missing_or_invalid', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent workflow is missing or structurally invalid while an approval is pending. Manual inspection is required.');
          return next;
        }
        const targetStep = workflow.steps.find((candidate) => candidate.id === record.pendingApproval.stepId);
        if (!stepNeedsHumanApproval(targetStep)) {
          const proof = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
          if (proof?.decision === 'reject') {
            const next = { ...record, status: 'rejected', reason: `rejected_by:${proof.actor}`, updatedAt: this.now(), pendingApproval: null };
            await this.saveRecord(key, next);
            await this.post(issue.number, `Agent request rejected by \`${proof.actor}\` during approval recovery. No further execution will occur.`);
            return next;
          }
          if (proof?.decision === 'approve' && targetStep?.status === WorkflowStepStatus.COMPLETED) {
            if (!this.completedCheckpointMatchesPendingApproval(record, workflow, record.pendingApproval.stepId)) {
              const next = { ...record, status: 'blocked', reason: 'workflow_approval_recovery_mismatch', updatedAt: this.now(), pendingApproval: null };
              await this.saveRecord(key, next);
              await this.post(issue.number, 'Agent checkpoint recovery could not prove that the completed step matches the exact approved pre-state. Manual inspection is required.');
              return next;
            }
            const currentBeforeRecovery = await this.revalidateCurrentRequest(issue, record);
            if (!currentBeforeRecovery.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeRecovery.reason);
            issue = currentBeforeRecovery.issue;
            const latestRecoveryDecision = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
            if (latestRecoveryDecision?.decision === 'reject') {
              const next = { ...record, status: 'rejected', reason: `rejected_by:${latestRecoveryDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
              await this.saveRecord(key, next);
              await this.post(issue.number, `Agent request rejected by \`${latestRecoveryDecision.actor}\` before recovered workflow execution. No further execution will occur.`);
              return next;
            }
            if (latestRecoveryDecision?.decision !== 'approve') return record;
            record = await this.saveRecord(key, {
              ...record,
              status: 'running',
              reason: 'workflow_approval_already_applied',
              pendingApproval: null,
              updatedAt: this.now()
            });
            const result = await this.workflowEngine.run(record.workflowId);
            return this.settleWorkflow(issue, key, record, result);
          }
          const next = { ...record, status: 'blocked', reason: 'workflow_approval_state_diverged', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent workflow approval state diverged from the pending queue checkpoint. Manual inspection is required; the approval will not be replayed.');
          return next;
        }
        const expected = workflowApprovalFingerprint({
          requestFingerprint: record.requestFingerprint,
          issueBodyFingerprint: record.issueBodyFingerprint,
          projectFingerprint: record.projectFingerprint,
          controlPlaneFingerprint: record.controlPlaneFingerprint,
          workflow,
          stepId: record.pendingApproval.stepId
        });
        if (expected !== record.pendingApproval.fingerprint) {
          const next = { ...record, status: 'blocked', reason: 'workflow_approval_stale', updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, 'Agent workflow approval became stale because the persisted workflow state changed. Manual inspection is required.');
          return next;
        }
        const currentBeforeApproval = await this.revalidateCurrentRequest(issue, record);
        if (!currentBeforeApproval.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeApproval.reason);
        issue = currentBeforeApproval.issue;
        const latestDecision = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
        if (latestDecision?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${latestDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, `Agent request rejected by \`${latestDecision.actor}\` before workflow approval. No further execution will occur.`);
          return next;
        }
        if (latestDecision?.decision !== 'approve') return record;
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
    if (!this.workflowMatchesRecord(record, workflow)) {
      const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
      await this.saveRecord(key, next);
      await this.post(issue.number, 'Agent workflow no longer matches the accepted issue/project/profile/goal/scope binding. Manual inspection is required.');
      return next;
    }
    if (workflow.status === WorkflowStepStatus.PENDING) {
      if (this.workflowIsPristine(workflow)) {
        const dryRun = await this.workflowEngine.run(workflow.id, { dryRun: true });
        const expectedStart = startApprovalFingerprint({
          requestFingerprint: record.requestFingerprint,
          issueBodyFingerprint: record.issueBodyFingerprint,
          projectFingerprint: record.projectFingerprint,
          controlPlaneFingerprint: record.controlPlaneFingerprint,
          workflow,
          dryRun
        });
        const proof = await this.historicalDecision(issue.number, expectedStart);
        if (proof?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${proof.actor}`, updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, `Agent request rejected by \`${proof.actor}\` before recovered start execution. No further execution will occur.`);
          return next;
        }
        if (proof?.decision !== 'approve') {
          const already = record.status === 'awaiting_start_approval' && record.pendingApproval?.fingerprint === expectedStart;
          const next = {
            ...record,
            status: 'awaiting_start_approval',
            reason: null,
            startApprovalFingerprint: expectedStart,
            pendingApproval: { kind: 'start', stepId: 'start', fingerprint: expectedStart },
            updatedAt: this.now()
          };
          await this.saveRecord(key, next);
          if (!already) await this.post(issue.number, `Agent start authorization is missing or stale. Approve the current dry-run with exactly:\n\`${approvalInstruction(expectedStart)}\``);
          return next;
        }
        const currentBeforeRecoveredStart = await this.revalidateCurrentRequest(issue, record);
        if (!currentBeforeRecoveredStart.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeRecoveredStart.reason);
        issue = currentBeforeRecoveredStart.issue;
        const latestRecoveredStartDecision = await this.historicalDecision(issue.number, expectedStart);
        if (latestRecoveredStartDecision?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${latestRecoveredStartDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
          await this.saveRecord(key, next);
          await this.post(issue.number, `Agent request rejected by \`${latestRecoveredStartDecision.actor}\` before recovered start execution. No further execution will occur.`);
          return next;
        }
        if (latestRecoveredStartDecision?.decision !== 'approve') return record;
        await this.workflowEngine.resetPristineDeadline(workflow.id);
        record = await this.saveRecord(key, {
          ...record,
          status: 'running',
          startApprovalFingerprint: expectedStart,
          startApprovalCommentId: latestRecoveredStartDecision.commentId,
          startApprovedBy: latestRecoveredStartDecision.actor,
          pendingApproval: null,
          updatedAt: this.now()
        });
      }
      const result = await this.workflowEngine.run(workflow.id);
      return this.settleWorkflow(issue, key, record, result);
    }
    if (workflow.status === WorkflowStepStatus.RUNNING) {
      const result = await this.workflowEngine.resume(workflow.id);
      return this.settleWorkflow(issue, key, record, result);
    }
    if (workflow.status === WorkflowStepStatus.BLOCKED &&
        workflow.steps?.some((step) => step.status === WorkflowStepStatus.BLOCKED && ['workflow_publication_ci_timeout', 'workflow_publication_preview_timeout'].includes(step.error))) {
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
      if (existing && !['completed', 'failed', 'blocked', 'rejected'].includes(existing.status)) {
        return this.blockRequestRevalidation(issue, key, existing, 'request_body_invalid');
      }
      if (!existing && this.authorized(issue.user?.login)) {
        await this.post(issue.number, `Agent request rejected during parsing: \`${maskSecrets(error.message)}\`.`);
        await this.saveRecord(key, {
          version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
          requestFingerprint: null, issueBodyFingerprint: null, projectFingerprint: null,
          controlPlaneFingerprint: this.controlPlaneFingerprint(), request: null, workflowId: null, status: 'rejected',
          reason: 'invalid_request', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null,
          startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, initializationLease: null, lastProcessedCommentId: 0
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
      const existing = await this.getRecord(this.requestKey(issue));
      if (existing && ['completed', 'failed', 'blocked', 'rejected'].includes(existing.status)) continue;
      const result = await this.processIssue(issue);
      if (result) return result;
    }
    return null;
  }
}

export async function watchIssueQueue(queue, { pollIntervalMs = 15_000, signal, onTick, onError } = {}) {
  if (!queue) throw new Error('watchIssueQueue requires a queue');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000) throw new Error('issue queue pollIntervalMs must be at least 1000');
  for (;;) {
    if (signal?.aborted) return;
    try {
      const result = await queue.tick();
      await onTick?.(result);
    } catch (error) {
      await onError?.(error);
    }
    if (signal?.aborted) return;
    await new Promise((resolveSleep) => {
      let timer = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener?.('abort', finish);
        resolveSleep();
      };
      timer = setTimeout(finish, pollIntervalMs);
      if (signal) {
        if (signal.aborted) return finish();
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      }
    });
  }
}
