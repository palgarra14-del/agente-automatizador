import { createHash, randomUUID } from 'node:crypto';
import { humanApprovalDependencyFingerprint, maskSecrets, normalizeBusinessBrief, readBoundedRegularFile, WorkflowStepStatus } from './core.js';

export const ISSUE_REQUEST_MARKER = '<!-- agent-request:v1 -->';
const ISSUE_REQUEST_MAX_BYTES = 80 * 1024;
const approvalPattern = /^\/agent\s+(approve|reject)\s+([a-f0-9]{64})$/i;

export function normalizeIssueQueueConfig(value) {
  assertObjectKeys(value, new Set(['version', 'repository', 'allowedActors', 'pollIntervalMs', 'cloudProjectIds']), 'issue queue config');
  if (value.version !== 1) throw new Error('issue queue config version must be 1');
  assertObjectKeys(value.repository, new Set(['owner', 'name']), 'issue queue config repository');
  const owner = boundedString(value.repository.owner, 'issue queue repository owner', { required: true, max: 100 }).toLowerCase();
  const name = boundedString(value.repository.name, 'issue queue repository name', { required: true, max: 100 }).toLowerCase();
  if (!Array.isArray(value.allowedActors) || value.allowedActors.length < 1 || value.allowedActors.length > 20) throw new Error('issue queue allowedActors must contain between 1 and 20 logins');
  const allowedActors = [...new Set(value.allowedActors.map((actor, index) => boundedString(actor, `issue queue allowedActors[${index}]`, { required: true, max: 80 }).toLowerCase()))].sort();
  const pollIntervalMs = value.pollIntervalMs ?? 15_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) throw new Error('issue queue pollIntervalMs must be between 1000 and 300000');
  const cloudProjectIds = value.cloudProjectIds ?? [];
  if (!Array.isArray(cloudProjectIds) || cloudProjectIds.length > 20) throw new Error('issue queue cloudProjectIds must be an array with at most 20 project ids');
  const normalizedCloudProjectIds = [...new Set(cloudProjectIds.map((projectId, index) => {
    const normalized = boundedString(projectId, `issue queue cloudProjectIds[${index}]`, { required: true, max: 80 });
    if (!/^[a-z0-9-]+$/.test(normalized)) throw new Error(`issue queue cloudProjectIds[${index}] is invalid`);
    return normalized;
  }))].sort();
  return { version: 1, repository: { owner, name }, allowedActors, pollIntervalMs, cloudProjectIds: normalizedCloudProjectIds };
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
  if (!project || typeof project !== 'object' || Array.isArray(project) || typeof project.id !== 'string' || !project.id) throw new Error('project execution context is invalid');
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

export function workflowBindingFingerprint(workflow) {
  if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.steps)) throw new Error('workflow binding context is invalid');
  return fingerprint({
    id: workflow.id,
    goal: workflow.goal,
    projectId: workflow.projectId,
    profile: workflow.profile,
    inputFingerprint: workflow.inputFingerprint ?? null,
    registryFingerprint: workflow.registryFingerprint,
    projectSkillPolicyFingerprint: workflow.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: workflow.specialistRegistryFingerprint,
    scope: workflow.scope,
    budgets: workflow.budgets,
    definitionOfDone: workflow.definitionOfDone,
    bootstrap: workflow.bootstrap ? { required: workflow.bootstrap.required, command: workflow.bootstrap.command, projectId: workflow.bootstrap.projectId } : null,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      type: step.type,
      skill: step.skill,
      specialist: step.specialist,
      dependsOn: step.dependsOn,
      commands: step.commands
    }))
  });
}

function redactApprovalValue(value, key = '') {
  if (/(api[_-]?key|token|secret|password|credential|authorization|cookie|session)/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactApprovalValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactApprovalValue(child, childKey)]));
  return value;
}

function approvalEvidenceSummary(workflow, stepId) {
  const targetIndex = workflow.steps.findIndex((step) => step.id === stepId);
  const summary = {
    dependencyEvidenceFingerprint: humanApprovalDependencyFingerprint(workflow, stepId),
    predecessors: workflow.steps.slice(0, Math.max(0, targetIndex))
      .filter((step) => step.status === WorkflowStepStatus.COMPLETED)
      .map((step) => ({
        id: step.id,
        skill: step.skill,
        result: step.evidence?.result ?? null,
        changeSetFingerprint: step.evidence?.changeSetFingerprint ?? null,
        reviewedChangeSetFingerprint: step.evidence?.reviewedChangeSetFingerprint ?? null
      }))
  };
  let serialized;
  try { serialized = JSON.stringify(redactApprovalValue(summary), null, 2); }
  catch { serialized = '"[UNSERIALIZABLE]"'; }
  const safe = maskSecrets(serialized)
    .replaceAll('`', "'")
    .replace(/\/agent/gi, '[agent-command]')
    .replaceAll('@', '＠');
  const bytes = Buffer.byteLength(safe, 'utf8');
  if (bytes > 32 * 1024) throw new Error(`approval_evidence_summary_too_large:${bytes}>32768`);
  return safe;
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
  assertObjectKeys(value, new Set(['version', 'projectId', 'profile', 'goal', 'scope', 'input']), 'agent request');
  if (value.version !== 1) throw new Error('agent request version must be 1');
  if (!['app-improvement', 'website-build'].includes(value.profile)) throw new Error('issue queue profile must be app-improvement or website-build');
  if (!value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)) throw new Error('agent request scope is required');
  const scope = value.scope;
  assertObjectKeys(scope, new Set(['allowedPaths', 'forbiddenPaths']), 'agent request scope');
  const allowedPaths = pathList(scope.allowedPaths, 'agent request scope.allowedPaths');
  if (allowedPaths.length < 1) throw new Error('agent request scope.allowedPaths must contain at least one bounded path');

  let input = null;
  if (value.profile === 'website-build') {
    assertObjectKeys(value.input, new Set(['businessBrief']), 'agent request input');
    input = { businessBrief: normalizeBusinessBrief(value.input.businessBrief) };
  } else if (value.input !== undefined && value.input !== null) {
    throw new Error('agent request input is supported only for website-build');
  }

  return {
    version: 1,
    projectId: boundedString(value.projectId, 'agent request projectId', { required: true, max: 80 }),
    profile: value.profile,
    goal: maskSecrets(boundedString(value.goal, 'agent request goal', { required: true, max: 1_000 })),
    scope: {
      allowedPaths,
      forbiddenPaths: pathList(scope.forbiddenPaths, 'agent request scope.forbiddenPaths')
    },
    ...(input ? { input } : {})
  };
}

export function parseIssueRequestBody(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > ISSUE_REQUEST_MAX_BYTES) throw new Error('agent request body is missing or exceeds 80 KiB');
  const markerIndex = body.indexOf(ISSUE_REQUEST_MARKER);
  if (markerIndex < 0 || body.indexOf(ISSUE_REQUEST_MARKER, markerIndex + ISSUE_REQUEST_MARKER.length) >= 0) throw new Error('agent request body must contain exactly one request marker');
  const before = body.slice(0, markerIndex).trim();
  const after = body.slice(markerIndex + ISSUE_REQUEST_MARKER.length).trim();
  if (before) throw new Error('agent request marker must be the first non-whitespace content');
  let parsed;
  try { parsed = JSON.parse(after); }
  catch (error) { throw new Error(`agent request JSON is invalid: ${error.message}`, { cause: error }); }
  const request = normalizeIssueRequest(parsed);
  return { request, requestFingerprint: fingerprint(request), issueBodyFingerprint: textFingerprint(body) };
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
    goal: plan.goal,
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
    modelUsage: plan.modelUsage ?? null,
    outputBytes: plan.outputBytes ?? 0,
    dependencyEvidenceFingerprint: humanApprovalDependencyFingerprint(plan, step.id),
    steps: plan.steps.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      skill: candidate.skill,
      specialist: candidate.specialist,
      status: candidate.status,
      dependsOn: candidate.dependsOn,
      attempts: candidate.attempts,
      commands: candidate.commands,
      error: candidate.error ?? null,
      evidence: candidate.evidence ?? null
    })),
    targetStepId: step.id
  };
}

export function startApprovalFingerprint({ requestFingerprint, issueBodyFingerprint = null, projectFingerprint = null, controlPlaneFingerprint = null, workflow, dryRun }) {
  return fingerprint({
    kind: 'start',
    requestFingerprint,
    issueBodyFingerprint,
    projectFingerprint,
    controlPlaneFingerprint,
    workflowBindingFingerprint: workflowBindingFingerprint(workflow),
    workflowId: workflow.id,
    projectId: workflow.projectId,
    profile: workflow.profile,
    goal: workflow.goal,
    registryFingerprint: workflow.registryFingerprint,
    projectSkillPolicyFingerprint: workflow.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: workflow.specialistRegistryFingerprint,
    inputFingerprint: workflow.inputFingerprint ?? null,
    scope: workflow.scope,
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
  });
}

function stepNeedsHumanApproval(step) {
  return step?.status === WorkflowStepStatus.AWAITING_APPROVAL ||
    (step?.status === WorkflowStepStatus.BLOCKED && step.error === 'interrupted_step_requires_human_approval');
}

export function workflowApprovalFingerprint({ requestFingerprint, issueBodyFingerprint = null, projectFingerprint = null, controlPlaneFingerprint = null, workflow, stepId }) {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!stepNeedsHumanApproval(step)) throw new Error('workflow approval target does not require human approval');
  return fingerprint({
    kind: 'workflow-step',
    requestFingerprint,
    issueBodyFingerprint,
    projectFingerprint,
    controlPlaneFingerprint,
    workflowBindingFingerprint: workflowBindingFingerprint(workflow),
    context: stepApprovalContext(workflow, step)
  });
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

function startApprovalMessage(workflow, dryRun, token, { recovered = false } = {}) {
  const summary = compactDryRun(dryRun);
  return [
    recovered
      ? 'Agent dry-run approval instruction recovered. No Codex call, project write, Git write, PR creation, or deployment was performed.'
      : 'Agent dry-run prepared. No Codex call, project write, Git write, PR creation, or deployment was performed.',
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
  ].join('\n');
}

function workflowApprovalMessage(workflow, step, token, { recovered = false } = {}) {
  return [
    recovered
      ? `Agent workflow approval instruction recovered for step \`${step.id}\` (skill \`${step.skill}\`).`
      : `Agent workflow is awaiting explicit approval for step \`${step.id}\` (skill \`${step.skill}\`).`,
    `Current workflow status: \`${workflow.status}\`.`,
    '',
    'Evidence bound to this approval fingerprint:',
    `\`\`\`json\n${approvalEvidenceSummary(workflow, step.id)}\n\`\`\``,
    '',
    'Approve exactly this persisted state with:',
    `\`${approvalInstruction(token)}\``,
    '',
    'Reject with:',
    `\`${rejectionInstruction(token)}\``
  ].join('\n');
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
    if (!/^[a-f0-9]{64}$/.test(record.controlPlaneFingerprint ?? '')) throw new Error('issue queue record control-plane fingerprint is invalid');
    if (controlPlaneFingerprint && record.controlPlaneFingerprint !== controlPlaneFingerprint) throw new Error('issue queue record control-plane fingerprint no longer matches active authority');
    if (record.status !== 'rejected' && !/^[a-f0-9]{64}$/.test(record.projectFingerprint ?? '')) throw new Error('issue queue record project fingerprint is invalid');
    if (projectFingerprint && record.projectFingerprint !== projectFingerprint) throw new Error('issue queue record project fingerprint no longer matches active project');
  }
  if (record.workflowId !== null && (typeof record.workflowId !== 'string' || !record.workflowId.trim())) throw new Error('issue queue record workflowId is invalid');
  if (record.workflowId !== null && !/^[a-f0-9]{64}$/.test(record.workflowBindingFingerprint ?? '')) throw new Error('issue queue record workflow binding fingerprint is invalid');
  if (record.startApprovalFingerprint !== null && record.startApprovalFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.startApprovalFingerprint)) throw new Error('issue queue start approval fingerprint is invalid');
  if (record.status === 'initializing') {
    const lease = record.initializationLease;
    if (!lease || typeof lease.leaseId !== 'string' || !lease.leaseId || !Number.isInteger(lease.pid) || lease.pid <= 0 || !Number.isFinite(Date.parse(lease.createdAt ?? ''))) throw new Error('issue queue initialization lease is invalid');
  } else if (record.initializationLease !== null && record.initializationLease !== undefined) throw new Error('settled issue queue record cannot retain initialization lease');
  if (record.pendingApproval !== null && record.pendingApproval !== undefined) {
    if (!['start', 'workflow-step'].includes(record.pendingApproval.kind) || typeof record.pendingApproval.stepId !== 'string' || !/^[a-f0-9]{64}$/.test(record.pendingApproval.fingerprint ?? '')) throw new Error('issue queue pending approval is invalid');
  }
  if (record.activeApproval !== null && record.activeApproval !== undefined) {
    if (!['start', 'workflow-step'].includes(record.activeApproval.kind) ||
        typeof record.activeApproval.stepId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.activeApproval.fingerprint ?? '') ||
        !Number.isInteger(record.activeApproval.commentId) || record.activeApproval.commentId < 1 ||
        typeof record.activeApproval.actor !== 'string' || !record.activeApproval.actor) {
      throw new Error('issue queue active approval is invalid');
    }
    if (record.pendingApproval) throw new Error('issue queue cannot have pending and active approval simultaneously');
  }
  if (record.terminalNotification !== null && record.terminalNotification !== undefined) {
    const notification = record.terminalNotification;
    if (!['completed', 'failed', 'blocked', 'rejected'].includes(record.status) ||
        typeof notification.body !== 'string' || !notification.body || notification.body.length > 12_000 ||
        !Number.isInteger(notification.attempts) || notification.attempts < 0 ||
        (notification.commentId !== null && notification.commentId !== undefined && (!Number.isInteger(notification.commentId) || notification.commentId < 1)) ||
        (notification.sentAt !== null && notification.sentAt !== undefined && !Number.isFinite(Date.parse(notification.sentAt)))) {
      throw new Error('issue queue terminal notification is invalid');
    }
  }
  if (typeof record.author !== 'string' || !record.author.trim()) throw new Error('issue queue record author is invalid');
  if (!Number.isFinite(Date.parse(record.createdAt ?? '')) || !Number.isFinite(Date.parse(record.updatedAt ?? ''))) throw new Error('issue queue record timestamps are invalid');
  const terminal = ['completed', 'failed', 'blocked', 'rejected'].includes(record.status);
  if (record.status === 'initializing' &&
      (record.workflowId != null || record.workflowBindingFingerprint != null || record.pendingApproval != null || record.activeApproval != null)) {
    throw new Error('initializing issue queue state is inconsistent');
  }
  if (record.status === 'awaiting_start_approval' &&
      (!record.workflowId || !record.workflowBindingFingerprint ||
       record.pendingApproval?.kind !== 'start' ||
       record.pendingApproval.stepId !== 'start' ||
       record.startApprovalFingerprint !== record.pendingApproval.fingerprint ||
       record.activeApproval != null)) {
    throw new Error('awaiting_start_approval state is inconsistent');
  }
  if (record.status === 'awaiting_workflow_approval' &&
      (!record.workflowId || !record.workflowBindingFingerprint ||
       record.pendingApproval?.kind !== 'workflow-step' ||
       record.activeApproval != null)) {
    throw new Error('awaiting_workflow_approval state is inconsistent');
  }
  if (record.status === 'running' && (!record.workflowId || !record.workflowBindingFingerprint || record.pendingApproval != null)) {
    throw new Error('running issue queue state is inconsistent');
  }
  if (terminal && (record.pendingApproval != null || record.activeApproval != null || record.initializationLease != null)) {
    throw new Error('terminal issue queue state cannot retain live execution state');
  }
  const approvalCommentPresent = record.startApprovalCommentId !== null && record.startApprovalCommentId !== undefined;
  const approvalActorPresent = record.startApprovedBy !== null && record.startApprovedBy !== undefined;
  if (approvalCommentPresent !== approvalActorPresent ||
      (approvalCommentPresent && (!Number.isInteger(record.startApprovalCommentId) || record.startApprovalCommentId < 1 ||
        typeof record.startApprovedBy !== 'string' || !record.startApprovedBy.trim()))) {
    throw new Error('issue queue start approval evidence is invalid');
  }
  if (record.activeApproval?.kind === 'start' &&
      (record.startApprovalFingerprint !== record.activeApproval.fingerprint ||
       record.startApprovalCommentId !== record.activeApproval.commentId ||
       record.startApprovedBy !== record.activeApproval.actor)) {
    throw new Error('active start approval does not match persisted start approval evidence');
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

function safeIssueInline(value, maxBytes = 1_000) {
  const safe = maskSecrets(String(value ?? ''))
    .replaceAll('`', "'")
    .replace(/\/agent/gi, '[agent-command]')
    .replaceAll('@', '＠');
  return Buffer.from(safe, 'utf8').subarray(0, maxBytes).toString('utf8');
}

export function workflowFailureSummary(workflow) {
  const stepId = typeof workflow.result?.stepId === 'string' ? workflow.result.stepId : null;
  const step = workflow.steps?.find((candidate) => candidate.id === stepId)
    ?? workflow.steps?.find((candidate) => [WorkflowStepStatus.FAILED, WorkflowStepStatus.BLOCKED].includes(candidate.status))
    ?? null;
  const workerEvidence = step?.evidence?.workerEvidence;
  const workerDetail = workerEvidence?.diagnostics?.length
    ? [`Tool diagnostics: ${JSON.stringify(workerEvidence.diagnostics)}`, workerEvidence.output ?? workerEvidence.summary ?? null].filter(Boolean).join('\n')
    : workerEvidence?.output ?? workerEvidence?.summary ?? null;
  const detail = step?.evidence?.error ?? workerDetail ?? workflow.result?.detail ?? null;
  return {
    stepId: step?.id ?? stepId,
    skill: step?.skill ?? null,
    specialist: step?.specialist ?? null,
    attempts: Number.isInteger(step?.attempts) ? step.attempts : null,
    maxAttempts: Number.isInteger(workflow.budgets?.maxAttempts) ? workflow.budgets.maxAttempts : null,
    detail: detail === null || detail === undefined ? null : safeIssueInline(detail)
  };
}

export class GitHubIssueChannel {
  constructor({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, repository, requestTimeoutMs = 30_000 } = {}) {
    if (!repository?.owner || !repository?.name) throw new Error('issue channel repository is required');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) throw new Error('issue channel requestTimeoutMs must be between 1000 and 120000');
    this.token = token;
    this.fetch = fetchImpl;
    this.repository = { owner: repository.owner, name: repository.name };
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
    const timeoutSignal = globalThis.AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal
      ? globalThis.AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let response;
    try {
      response = await this.fetch(`https://api.github.com${path}`, {
        ...options,
        signal,
        headers: { ...this.headers(), ...(options.headers ?? {}) }
      });
      if (!response.ok) throw new Error(`GitHub issue queue request failed: ${response.status}`);
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (timeoutSignal.aborted) throw new Error('github_issue_queue_request_timeout', { cause: error });
      throw error;
    }
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

  async branchHead(branch) {
    if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw new Error('issue channel branch is invalid');
    const result = await this.request(this.path(`/branches/${encodeURIComponent(branch)}`));
    const sha = result?.commit?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('GitHub issue queue branch response is invalid');
    return sha.toLowerCase();
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

function validateWatcherLease(lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease) ||
      typeof lease.leaseId !== 'string' || !lease.leaseId ||
      !Number.isInteger(lease.pid) || lease.pid <= 0 ||
      !Number.isFinite(Date.parse(lease.createdAt ?? '')) ||
      !(
        lease.ownerIdentity === null ||
        lease.ownerIdentity === undefined ||
        (typeof lease.ownerIdentity === 'string' && lease.ownerIdentity.length > 0)
      )) {
    throw new Error('issue_queue_watcher_lease_invalid');
  }
  return lease;
}

export class SupervisedIssueQueue {
  constructor({
    store,
    projects,
    workflowEngine,
    channel,
    allowedActors,
    operatorRevision = null,
    operatorBranch = 'main',
    includedProjectIds = null,
    excludedProjectIds = [],
    now = () => new Date().toISOString()
  } = {}) {
    if (!store || !projects || !workflowEngine || !channel) throw new Error('SupervisedIssueQueue requires store, projects, workflowEngine, and channel');
    if (!Array.isArray(allowedActors) || !allowedActors.length) throw new Error('SupervisedIssueQueue requires at least one allowed actor');
    if (operatorRevision !== null && (typeof operatorRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(operatorRevision))) {
      throw new Error('SupervisedIssueQueue operatorRevision must be a 40-character commit sha');
    }
    if (typeof operatorBranch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(operatorBranch) || operatorBranch.includes('..')) {
      throw new Error('SupervisedIssueQueue operatorBranch is invalid');
    }
    this.store = store;
    this.projects = projects;
    this.workflowEngine = workflowEngine;
    this.channel = channel;
    this.allowedActors = new Set(allowedActors.map((actor) => boundedString(actor, 'allowed actor', { required: true, max: 80 }).toLowerCase()));
    if (includedProjectIds !== null && (!Array.isArray(includedProjectIds) || includedProjectIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)))) {
      throw new Error('SupervisedIssueQueue includedProjectIds must be null or an array of valid project ids');
    }
    if (!Array.isArray(excludedProjectIds) || excludedProjectIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))) {
      throw new Error('SupervisedIssueQueue excludedProjectIds must be an array of valid project ids');
    }
    this.includedProjectIds = includedProjectIds === null ? null : new Set(includedProjectIds);
    this.excludedProjectIds = new Set(excludedProjectIds);
    if (this.includedProjectIds && [...this.includedProjectIds].some((id) => this.excludedProjectIds.has(id))) {
      throw new Error('SupervisedIssueQueue project routing overlaps include/exclude sets');
    }
    this.operatorRevision = operatorRevision?.toLowerCase() ?? null;
    this.operatorBranch = operatorBranch;
    this.now = now;
  }

  ownsProject(projectId) {
    if (typeof projectId !== 'string' || !projectId) return this.includedProjectIds === null;
    if (this.excludedProjectIds.has(projectId)) return false;
    return this.includedProjectIds === null || this.includedProjectIds.has(projectId);
  }

  ownsRecord(record) {
    return this.ownsProject(record?.request?.projectId ?? null);
  }

  controlPlaneFingerprint() {
    return fingerprint({
      repository: this.channel.repository,
      allowedActors: [...this.allowedActors].sort(),
      includedProjectIds: this.includedProjectIds ? [...this.includedProjectIds].sort() : null,
      excludedProjectIds: [...this.excludedProjectIds].sort()
    });
  }

  async claimWatcherLease() {
    const ownerIdentity = await this.store.ownerIdentity(process.pid);
    return this.store.mutate(async (data) => {
      const existing = data.issueQueueWatcherLease ?? null;
      if (existing) {
        validateWatcherLease(existing);
        if (!(await this.store.lockOwnerIsAbandoned(existing))) throw new Error('issue_queue_watcher_already_running');
      }
      const lease = {
        leaseId: randomUUID(),
        pid: process.pid,
        createdAt: this.now(),
        ownerIdentity
      };
      data.issueQueueWatcherLease = lease;
      return lease;
    });
  }

  async releaseWatcherLease(leaseId) {
    if (typeof leaseId !== 'string' || !leaseId) throw new Error('issue_queue_watcher_lease_id_invalid');
    return this.store.mutate((data) => {
      const existing = data.issueQueueWatcherLease ?? null;
      if (!existing) return false;
      validateWatcherLease(existing);
      if (existing.leaseId !== leaseId) return false;
      data.issueQueueWatcherLease = null;
      return true;
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
        request: parsed.request, workflowId: null, workflowBindingFingerprint: null,
        status: 'initializing', reason: null, createdAt: now, updatedAt: now, pendingApproval: null,
        startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, activeApproval: null,
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

  instructionPublisher(login) {
    if (typeof login !== 'string') return false;
    const normalized = login.toLowerCase();
    return this.allowedActors.has(normalized) || normalized === 'github-actions[bot]';
  }

  async post(number, text) {
    return this.channel.comment(number, text);
  }

  async deliverTerminalNotification(issue, key, record) {
    validateIssueQueueRecord(record);
    const notification = record.terminalNotification;
    if (!notification || notification.sentAt) return record;
    const comments = await this.channel.comments(issue.number);
    const existing = comments.find((comment) =>
      Number.isInteger(comment.id) &&
      typeof comment.body === 'string' &&
      comment.body === notification.body &&
      this.authorized(comment.user?.login)
    );
    const posted = existing ? { id: existing.id } : await this.post(issue.number, notification.body);
    const next = {
      ...record,
      terminalNotification: {
        ...notification,
        attempts: notification.attempts + 1,
        commentId: posted.id ?? null,
        sentAt: this.now()
      },
      updatedAt: this.now()
    };
    await this.saveRecord(key, next);
    return next;
  }

  async reconcileTerminalWorkflow(workflowId, status) {
    if (!workflowId || !['failed', 'blocked', 'rejected'].includes(status)) return;
    const workflow = await this.workflowEngine.get(workflowId);
    if (workflow && ![WorkflowStepStatus.COMPLETED, WorkflowStepStatus.FAILED, WorkflowStepStatus.BLOCKED].includes(workflow.status)) {
      await this.workflowEngine.cancel(workflowId, { reason: `issue_queue_${status}` });
    }
  }

  async finalizeTerminal(issue, key, record, text) {
    await this.reconcileTerminalWorkflow(record.workflowId, record.status);
    const body = maskSecrets(String(text)).slice(0, 12_000);
    const next = {
      ...record,
      pendingApproval: null,
      activeApproval: null,
      terminalNotification: { body, attempts: 0, commentId: null, sentAt: null },
      updatedAt: this.now()
    };
    await this.saveRecord(key, next);
    return this.deliverTerminalNotification(issue, key, next);
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
    await this.reconcileTerminalWorkflow(record?.workflowId ?? null, 'blocked');
    const now = this.now();
    const next = {
      version: 1,
      issueNumber: Number.isInteger(issue?.number) ? issue.number : record?.issueNumber,
      issueId: issue?.id ?? record?.issueId ?? null,
      author: issue?.user?.login ?? record?.author ?? null,
      requestFingerprint: null,
      issueBodyFingerprint: null,
      projectFingerprint: null,
      controlPlaneFingerprint: this.controlPlaneFingerprint(),
      request: null,
      workflowId: null,
      workflowBindingFingerprint: null,
      status: 'blocked',
      reason,
      createdAt: typeof record?.createdAt === 'string' ? record.createdAt : now,
      updatedAt: now,
      pendingApproval: null,
      activeApproval: null,
      startApprovalFingerprint: null,
      startApprovalCommentId: null,
      startApprovedBy: null,
      initializationLease: null,
      lastProcessedCommentId: 0
    };
    return this.finalizeTerminal(issue, key, next, 'Agent request blocked: the accepted request/control context changed or can no longer be verified exactly. No further execution was authorized.');
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
        request: parsed.request, workflowId: null, workflowBindingFingerprint: null,
        status: 'rejected', reason: 'unknown_project', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null,
        startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, activeApproval: null, initializationLease: null, lastProcessedCommentId: 0
      };
      return this.finalizeTerminal(issue, this.requestKey(issue), rejected, `Agent request rejected: unknown registered project \`${parsed.request.projectId}\`.`);
    }
    let workflow;
    let dryRun;
    try {
      workflow = await this.workflowEngine.create({
        profile: parsed.request.profile,
        projectId: parsed.request.projectId,
        goal: parsed.request.goal,
        scope: parsed.request.scope,
        ...(parsed.request.input ? { input: parsed.request.input } : {})
      });
      dryRun = await this.workflowEngine.run(workflow.id, { dryRun: true });
    } catch (error) {
      const blocked = {
        version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
        requestFingerprint: parsed.requestFingerprint, issueBodyFingerprint: parsed.issueBodyFingerprint,
        projectFingerprint: activeProjectFingerprint, controlPlaneFingerprint: this.controlPlaneFingerprint(),
        request: parsed.request, workflowId: workflow?.id ?? null,
        workflowBindingFingerprint: workflow ? workflowBindingFingerprint(workflow) : null,
        status: 'blocked', reason: 'workflow_initialization_failed', createdAt: this.now(), updatedAt: this.now(),
        pendingApproval: null, startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, activeApproval: null, initializationLease: null,
        lastProcessedCommentId: 0
      };
      return this.finalizeTerminal(issue, this.requestKey(issue), blocked, `Agent request blocked during workflow initialization/dry-run: \`${maskSecrets(error.message)}\`. No real execution was authorized.`);
    }
    const binding = workflowBindingFingerprint(workflow);
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
      request: parsed.request, workflowId: workflow.id, workflowBindingFingerprint: binding,
      status: 'awaiting_start_approval', reason: null, createdAt: this.now(), updatedAt: this.now(),
      pendingApproval: { kind: 'start', stepId: 'start', fingerprint: token },
      startApprovalFingerprint: token,
      startApprovalCommentId: null,
      startApprovedBy: null, activeApproval: null, initializationLease: null,
      lastProcessedCommentId: 0
    };
    await this.saveRecord(this.requestKey(issue), record);
    await this.post(issue.number, startApprovalMessage(workflow, dryRun, token));
    return record;
  }

  async findDecision(issueNumber, record) {
    const comments = await this.channel.comments(issueNumber);
    const instruction = record.pendingApproval?.fingerprint ? approvalInstruction(record.pendingApproval.fingerprint) : null;
    const instructionPresent = Boolean(instruction && comments.some((comment) =>
      typeof comment.body === 'string' &&
      this.instructionPublisher(comment.user?.login) &&
      comment.body.includes(instruction)
    ));
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

  async revalidateActiveApproval(issue, key, record) {
    if (!record.activeApproval) return { ok: true, record };
    const latest = await this.historicalDecision(issue.number, record.activeApproval.fingerprint);
    if (latest?.decision === 'reject') {
      const next = {
        ...record,
        status: 'rejected',
        reason: `rejected_by:${latest.actor}`,
        pendingApproval: null,
        activeApproval: null,
        lastProcessedCommentId: Math.max(record.lastProcessedCommentId ?? 0, latest.commentId),
        updatedAt: this.now()
      };
      const finalized = await this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${latest.actor}\` before continuation. No further execution will occur.`);
      return { ok: false, record: finalized };
    }
    if (latest?.decision !== 'approve') {
      const next = {
        ...record,
        status: 'blocked',
        reason: 'active_approval_no_longer_provable',
        pendingApproval: null,
        activeApproval: null,
        updatedAt: this.now()
      };
      const finalized = await this.finalizeTerminal(issue, key, next, 'Agent continuation blocked because the approval that authorized the current transition can no longer be proven from GitHub.');
      return { ok: false, record: finalized };
    }
    return { ok: true, record, latest };
  }

  workflowIsPristine(workflow) {
    if ((workflow.modelUsage?.calls ?? 0) !== 0 || workflow.workspace) return false;
    return workflow.steps.every((step, index) => index === 0 ? step.status === WorkflowStepStatus.READY : step.status === WorkflowStepStatus.PENDING);
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
    let approvalMessage = null;
    if (!already) {
      try { approvalMessage = workflowApprovalMessage(workflow, step, token); }
      catch (error) {
        return this.blockRequestRevalidation(issue, key, record, `approval_evidence_unpublishable:${maskSecrets(error.message)}`);
      }
    }
    const next = {
      ...record,
      status: 'awaiting_workflow_approval',
      reason: null,
      updatedAt: this.now(),
      pendingApproval: { kind: 'workflow-step', stepId: step.id, fingerprint: token },
      activeApproval: null
    };
    await this.saveRecord(key, next);
    if (approvalMessage) await this.post(issue.number, approvalMessage);
    return next;
  }

  async settleWorkflow(issue, key, record, workflow) {
    const interruptedApproval = workflow.status === WorkflowStepStatus.BLOCKED &&
      workflow.steps?.some((step) => step.status === WorkflowStepStatus.BLOCKED && step.error === 'interrupted_step_requires_human_approval');
    if (workflow.status === WorkflowStepStatus.AWAITING_APPROVAL || interruptedApproval) return this.persistPendingWorkflowApproval(issue, key, record, workflow);
    const resumableObservation = workflow.status === WorkflowStepStatus.BLOCKED &&
      workflow.steps?.some((step) => step.status === WorkflowStepStatus.BLOCKED && ['workflow_publication_ci_timeout', 'workflow_publication_preview_timeout'].includes(step.error));
    if (resumableObservation) {
      const next = { ...record, status: 'running', reason: 'resumable_publication_observation', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
      await this.saveRecord(key, next);
      return next;
    }
    if (workflow.status === WorkflowStepStatus.COMPLETED) {
      const published = publicationSummary(workflow);
      const next = { ...record, status: 'completed', reason: null, updatedAt: this.now(), pendingApproval: null, activeApproval: null, publication: published };
      return this.finalizeTerminal(issue, key, next, [
        'Agent workflow completed its Definition of Done.',
        published?.pullRequest ? `Pull request: ${published.pullRequest}` : 'Pull request: not recorded',
        published?.previewUrl ? `Preview: ${published.previewUrl}` : 'Preview: not recorded',
        'No merge or production deployment was performed by the issue queue.'
      ].join('\n'));
    }
    if (workflow.status === WorkflowStepStatus.FAILED || workflow.status === WorkflowStepStatus.BLOCKED) {
      const reason = safeIssueInline(workflow.result?.error ?? workflow.status);
      const failure = workflowFailureSummary(workflow);
      const detail = [
        `Agent workflow stopped with status \`${workflow.status}\`: \`${reason}\`.`,
        failure.stepId ? `Step: \`${safeIssueInline(failure.stepId, 200)}\`.` : null,
        failure.skill ? `Skill: \`${safeIssueInline(failure.skill, 200)}\`.` : null,
        failure.specialist ? `Specialist: \`${safeIssueInline(failure.specialist, 200)}\`.` : null,
        failure.attempts !== null ? `Attempts: \`${failure.attempts}${failure.maxAttempts !== null ? `/${failure.maxAttempts}` : ''}\`.` : null,
        failure.detail ? `Cause: \`${failure.detail}\`.` : 'Cause: no executor detail was recorded.',
        'No automatic merge/production action was attempted.'
      ].filter(Boolean).join('\n');
      const next = { ...record, status: workflow.status, reason, updatedAt: this.now(), pendingApproval: null, activeApproval: null };
      return this.finalizeTerminal(issue, key, next, detail);
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
    const activeProject = this.projects.get(parsed.request.projectId) ?? null;
    try {
      validateIssueQueueRecord(record, {
        issue,
        requestFingerprint: parsed.requestFingerprint,
        issueBodyFingerprint: parsed.issueBodyFingerprint
      });
    } catch (error) {
      const now = this.now();
      const next = {
        version: 1,
        issueNumber: issue.number,
        issueId: issue.id,
        author: issue.user?.login ?? null,
        requestFingerprint: null,
        issueBodyFingerprint: null,
        projectFingerprint: null,
        controlPlaneFingerprint: this.controlPlaneFingerprint(),
        request: null,
        workflowId: null,
        workflowBindingFingerprint: null,
        status: 'blocked',
        reason: 'queue_state_invalid',
        createdAt: typeof record?.createdAt === 'string' ? record.createdAt : now,
        updatedAt: now,
        pendingApproval: null,
        activeApproval: null,
        startApprovalFingerprint: null,
        startApprovalCommentId: null,
        startApprovedBy: null,
        initializationLease: null,
        lastProcessedCommentId: 0
      };
      return this.finalizeTerminal(issue, key, next, `Agent request blocked because local queue state failed validation: \`${maskSecrets(error.message)}\`. The corrupt local record was quarantined and will not be resumed.`);
    }
    if (!activeProject) return this.blockRequestRevalidation(issue, key, record, 'project_removed');
    if (projectExecutionFingerprint(activeProject) !== record.projectFingerprint) {
      return this.blockRequestRevalidation(issue, key, record, 'project_config_changed');
    }
    if (this.controlPlaneFingerprint() !== record.controlPlaneFingerprint) {
      return this.blockRequestRevalidation(issue, key, record, 'control_plane_changed');
    }
    if (record.status === 'initializing') {
      let abandoned;
      try { abandoned = await this.store.lockOwnerIsAbandoned(record.initializationLease); }
      catch (error) {
        return this.blockRequestRevalidation(issue, key, record, `initialization_lease_check_failed:${maskSecrets(error.message)}`);
      }
      if (!abandoned) return record;
      const next = { ...record, status: 'blocked', reason: 'initialization_interrupted', initializationLease: null, updatedAt: this.now(), pendingApproval: null, activeApproval: null };
      return this.finalizeTerminal(issue, key, next, 'Agent request blocked because initialization was interrupted. No automatic retry or duplicate workflow was created; submit a new request after inspection.');
    }

    if (record.pendingApproval) {
      const { decision, highestCommentId, instructionPresent } = await this.findDecision(issue.number, record);
      if (!decision && highestCommentId > (record.lastProcessedCommentId ?? 0)) {
        record = await this.saveRecord(key, { ...record, lastProcessedCommentId: highestCommentId, updatedAt: this.now() });
      }
      if (!decision) {
        if (!instructionPresent) {
          const workflow = await this.workflowEngine.get(record.workflowId);
          if (!workflow || workflow.id !== record.workflowId || workflowBindingFingerprint(workflow) !== record.workflowBindingFingerprint) {
            const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
            return this.finalizeTerminal(issue, key, next, 'Agent workflow binding no longer matches the accepted request. Manual inspection is required.');
          }
          let recoveredMessage;
          if (record.pendingApproval.kind === 'start') {
            if (!this.workflowIsPristine(workflow)) {
              const next = { ...record, status: 'blocked', reason: 'start_approval_state_diverged', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
              return this.finalizeTerminal(issue, key, next, 'Agent start approval cannot be recovered because the workflow is no longer pristine.');
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
              const next = { ...record, status: 'blocked', reason: 'start_approval_stale', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
              return this.finalizeTerminal(issue, key, next, 'Agent start approval became stale because the workflow plan changed. Create a new request.');
            }
            recoveredMessage = startApprovalMessage(workflow, dryRun, expected, { recovered: true });
          } else {
            const targetStep = workflow.steps.find((candidate) => candidate.id === record.pendingApproval.stepId);
            if (!stepNeedsHumanApproval(targetStep)) {
              const next = { ...record, status: 'blocked', reason: 'workflow_approval_state_diverged', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
              return this.finalizeTerminal(issue, key, next, 'Agent workflow approval cannot be recovered because the target step no longer requires approval.');
            }
            const expected = workflowApprovalFingerprint({
              requestFingerprint: record.requestFingerprint,
              issueBodyFingerprint: record.issueBodyFingerprint,
              projectFingerprint: record.projectFingerprint,
              controlPlaneFingerprint: record.controlPlaneFingerprint,
              workflow,
              stepId: targetStep.id
            });
            if (expected !== record.pendingApproval.fingerprint) {
              const next = { ...record, status: 'blocked', reason: 'workflow_approval_stale', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
              return this.finalizeTerminal(issue, key, next, 'Agent workflow approval became stale because the persisted evidence changed.');
            }
            try { recoveredMessage = workflowApprovalMessage(workflow, targetStep, expected, { recovered: true }); }
            catch (error) {
              return this.blockRequestRevalidation(issue, key, record, `approval_evidence_unpublishable:${maskSecrets(error.message)}`);
            }
          }
          await this.post(issue.number, recoveredMessage);
        }
        return record;
      }
      if (decision.decision === 'reject') {
        const next = { ...record, status: 'rejected', reason: `rejected_by:${decision.actor}`, updatedAt: this.now(), pendingApproval: null };
        return this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${decision.actor}\`. No further execution will occur.`);
      }
      if (record.pendingApproval.kind === 'start') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        if (!workflow || workflow.id !== record.workflowId || workflowBindingFingerprint(workflow) !== record.workflowBindingFingerprint) {
          const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
          return this.finalizeTerminal(issue, key, next, 'Agent workflow binding no longer matches the accepted request. Manual inspection is required.');
        }
        if (!this.workflowIsPristine(workflow)) {
          const next = { ...record, status: 'blocked', reason: 'start_approval_state_diverged', updatedAt: this.now(), pendingApproval: null };
          return this.finalizeTerminal(issue, key, next, 'Agent start approval cannot be applied because the workflow is no longer pristine. Manual inspection is required.');
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
          return this.finalizeTerminal(issue, key, next, 'Agent start approval became stale because the workflow plan changed. Create a new request.');
        }
        const currentBeforeExecution = await this.revalidateCurrentRequest(issue, record);
        if (!currentBeforeExecution.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeExecution.reason);
        issue = currentBeforeExecution.issue;
        const latestDecision = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
        if (latestDecision?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${latestDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
          return this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${latestDecision.actor}\` before execution. No further execution will occur.`);
        }
        if (latestDecision?.decision !== 'approve') return record;
        record = await this.saveRecord(key, {
          ...record,
          status: 'running',
          pendingApproval: null,
          startApprovalFingerprint: expected,
          startApprovalCommentId: latestDecision.commentId,
          startApprovedBy: latestDecision.actor,
          activeApproval: { kind: 'start', stepId: 'start', fingerprint: expected, commentId: latestDecision.commentId, actor: latestDecision.actor },
          lastProcessedCommentId: Math.max(record.lastProcessedCommentId ?? 0, latestDecision.commentId),
          updatedAt: this.now()
        });
        const activeStart = await this.revalidateActiveApproval(issue, key, record);
        if (!activeStart.ok) return activeStart.record;
        const result = await this.workflowEngine.run(record.workflowId, { refreshPristineDeadline: true });
        return this.settleWorkflow(issue, key, record, result);
      }
      if (record.pendingApproval.kind === 'workflow-step') {
        const workflow = await this.workflowEngine.get(record.workflowId);
        if (!workflow || workflow.id !== record.workflowId || workflowBindingFingerprint(workflow) !== record.workflowBindingFingerprint) {
          const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null, activeApproval: null };
          return this.finalizeTerminal(issue, key, next, 'Agent workflow binding no longer matches the accepted request. Manual inspection is required.');
        }
        const targetStep = workflow.steps.find((candidate) => candidate.id === record.pendingApproval.stepId);
        if (!stepNeedsHumanApproval(targetStep)) {
          const proof = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
          if (proof?.decision === 'reject') {
            const next = { ...record, status: 'rejected', reason: `rejected_by:${proof.actor}`, updatedAt: this.now(), pendingApproval: null };
            return this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${proof.actor}\` during approval recovery. No further execution will occur.`);
          }
          if (proof?.decision === 'approve') {
            const externalFingerprint = targetStep?.type === 'checkpoint'
              ? targetStep.evidence?.externalApprovalFingerprint
              : targetStep?.evidence?.sensitiveApproval?.externalApprovalFingerprint ?? targetStep?.evidence?.externalApprovalFingerprint;
            const approvedDependencyFingerprint = targetStep?.type === 'checkpoint'
              ? targetStep.evidence?.approvedDependencyEvidenceFingerprint
              : targetStep?.evidence?.sensitiveApproval?.approvedDependencyEvidenceFingerprint ?? targetStep?.evidence?.approvedDependencyEvidenceFingerprint;
            const currentDependencyFingerprint = (() => {
              try { return targetStep ? humanApprovalDependencyFingerprint(workflow, targetStep.id) : null; }
              catch { return null; }
            })();
            const appliedState = targetStep?.status === WorkflowStepStatus.COMPLETED || targetStep?.status === WorkflowStepStatus.READY;
            if (appliedState &&
                externalFingerprint === record.pendingApproval.fingerprint &&
                approvedDependencyFingerprint === currentDependencyFingerprint) {
              const currentBeforeRecovery = await this.revalidateCurrentRequest(issue, record);
              if (!currentBeforeRecovery.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeRecovery.reason);
              issue = currentBeforeRecovery.issue;
              record = await this.saveRecord(key, {
                ...record,
                status: 'running',
                reason: 'workflow_approval_already_applied',
                pendingApproval: null,
                activeApproval: {
                  kind: 'workflow-step',
                  stepId: targetStep.id,
                  fingerprint: record.pendingApproval.fingerprint,
                  commentId: proof.commentId,
                  actor: proof.actor
                },
                lastProcessedCommentId: Math.max(record.lastProcessedCommentId ?? 0, proof.commentId),
                updatedAt: this.now()
              });
              const recoveredApproval = await this.revalidateActiveApproval(issue, key, record);
              if (!recoveredApproval.ok) return recoveredApproval.record;
              const result = await this.workflowEngine.run(record.workflowId);
              return this.settleWorkflow(issue, key, record, result);
            }
            if (appliedState) {
              const next = { ...record, status: 'blocked', reason: 'workflow_approval_recovery_mismatch', updatedAt: this.now(), pendingApproval: null };
              return this.finalizeTerminal(issue, key, next, 'Agent cannot prove that the persisted workflow state is the exact state authorized before the crash. Manual inspection is required.');
            }
          }
          const next = { ...record, status: 'blocked', reason: 'workflow_approval_state_diverged', updatedAt: this.now(), pendingApproval: null };
          return this.finalizeTerminal(issue, key, next, 'Agent workflow approval state diverged from the pending queue checkpoint. Manual inspection is required; the approval will not be replayed.');
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
          return this.finalizeTerminal(issue, key, next, 'Agent workflow approval became stale because the persisted workflow state changed. Manual inspection is required.');
        }
        const currentBeforeApproval = await this.revalidateCurrentRequest(issue, record);
        if (!currentBeforeApproval.ok) return this.blockRequestRevalidation(issue, key, record, currentBeforeApproval.reason);
        issue = currentBeforeApproval.issue;
        const latestDecision = await this.historicalDecision(issue.number, record.pendingApproval.fingerprint);
        if (latestDecision?.decision === 'reject') {
          const next = { ...record, status: 'rejected', reason: `rejected_by:${latestDecision.actor}`, updatedAt: this.now(), pendingApproval: null };
          return this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${latestDecision.actor}\` before workflow approval. No further execution will occur.`);
        }
        if (latestDecision?.decision !== 'approve') return record;
        await this.workflowEngine.approve(record.workflowId, record.pendingApproval.stepId, { externalApprovalFingerprint: record.pendingApproval.fingerprint });
        record = await this.saveRecord(key, {
          ...record,
          status: 'running',
          pendingApproval: null,
          activeApproval: {
            kind: 'workflow-step',
            stepId: record.pendingApproval.stepId,
            fingerprint: record.pendingApproval.fingerprint,
            commentId: latestDecision.commentId,
            actor: latestDecision.actor
          },
          lastProcessedCommentId: Math.max(record.lastProcessedCommentId ?? 0, latestDecision.commentId),
          updatedAt: this.now()
        });
        const activeWorkflowApproval = await this.revalidateActiveApproval(issue, key, record);
        if (!activeWorkflowApproval.ok) return activeWorkflowApproval.record;
        const result = await this.workflowEngine.run(record.workflowId);
        return this.settleWorkflow(issue, key, record, result);
      }
    }

    if (!record.pendingApproval && record.status === 'running' && record.activeApproval) {
      const active = await this.revalidateActiveApproval(issue, key, record);
      if (!active.ok) return active.record;
    }

    const workflow = await this.workflowEngine.get(record.workflowId);
    if (!workflow) {
      const next = { ...record, status: 'blocked', reason: 'workflow_missing', updatedAt: this.now(), pendingApproval: null };
      return this.finalizeTerminal(issue, key, next, 'Agent workflow state is missing. Manual inspection is required; no continuation was attempted.');
    }
    if (workflow.id !== record.workflowId || workflowBindingFingerprint(workflow) !== record.workflowBindingFingerprint) {
      const next = { ...record, status: 'blocked', reason: 'workflow_binding_mismatch', updatedAt: this.now(), pendingApproval: null };
      return this.finalizeTerminal(issue, key, next, 'Agent workflow binding no longer matches the accepted request. Manual inspection is required.');
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
          return this.finalizeTerminal(issue, key, next, `Agent request rejected by \`${proof.actor}\` before recovered start execution. No further execution will occur.`);
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
        record = await this.saveRecord(key, {
          ...record,
          status: 'running',
          startApprovalFingerprint: expectedStart,
          startApprovalCommentId: proof.commentId,
          startApprovedBy: proof.actor,
          pendingApproval: null,
          activeApproval: { kind: 'start', stepId: 'start', fingerprint: expectedStart, commentId: proof.commentId, actor: proof.actor },
          lastProcessedCommentId: Math.max(record.lastProcessedCommentId ?? 0, proof.commentId),
          updatedAt: this.now()
        });
        const recoveredStart = await this.revalidateActiveApproval(issue, key, record);
        if (!recoveredStart.ok) return recoveredStart.record;
      }
      const result = await this.workflowEngine.run(workflow.id, this.workflowIsPristine(workflow) ? { refreshPristineDeadline: true } : {});
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
        const rejected = {
          version: 1, issueNumber: issue.number, issueId: issue.id, author: issue.user?.login ?? null,
          requestFingerprint: null, issueBodyFingerprint: null, projectFingerprint: null,
          controlPlaneFingerprint: this.controlPlaneFingerprint(), request: null, workflowId: null,
          workflowBindingFingerprint: null, status: 'rejected',
          reason: 'invalid_request', createdAt: this.now(), updatedAt: this.now(), pendingApproval: null,
          startApprovalFingerprint: null, startApprovalCommentId: null, startApprovedBy: null, activeApproval: null, initializationLease: null, lastProcessedCommentId: 0
        };
        return this.finalizeTerminal(issue, key, rejected, `Agent request rejected during parsing: \`${maskSecrets(error.message)}\`.`);
      }
      return null;
    }
    const key = this.requestKey(issue);
    const existing = await this.getRecord(key);
    return existing ? this.processExisting(issue, parsed, existing) : this.initializeIssue(issue, parsed);
  }

  async tick() {
    let notificationError = null;
    const state = await this.store.load();
    const keyPrefix = `${this.channel.repository.owner}/${this.channel.repository.name}#`;
    for (const [key, record] of Object.entries(state.requests ?? {})) {
      if (!key.startsWith(keyPrefix) ||
          !this.ownsRecord(record) ||
          !['completed', 'failed', 'blocked', 'rejected'].includes(record.status) ||
          !record.terminalNotification ||
          record.terminalNotification.sentAt) continue;
      try {
        const issue = await this.channel.issue(record.issueNumber);
        return await this.deliverTerminalNotification(issue ?? { number: record.issueNumber }, key, record);
      } catch (error) {
        notificationError ??= error;
      }
    }
    for (const [key, record] of Object.entries(state.requests ?? {})) {
      if (!key.startsWith(keyPrefix) ||
          !this.ownsRecord(record) ||
          ['completed', 'failed', 'blocked', 'rejected'].includes(record.status)) continue;
      const issue = await this.channel.issue(record.issueNumber);
      if (!issue ||
          issue.state !== 'open' ||
          issue.pull_request ||
          issue.number !== record.issueNumber ||
          issue.id !== record.issueId ||
          issue.user?.login !== record.author) {
        return this.blockRequestRevalidation(
          issue ?? { number: record.issueNumber, id: record.issueId, user: { login: record.author } },
          key,
          record,
          'issue_identity_or_state_changed'
        );
      }
    }
    const issues = await this.channel.openIssues();
    let remoteOperatorRevision = null;
    for (const issue of issues) {
      if (typeof issue.body !== 'string' || !issue.body.includes(ISSUE_REQUEST_MARKER)) continue;
      let routingRequest = null;
      try { routingRequest = parseIssueRequestBody(issue.body).request; }
      catch {
        if (this.includedProjectIds !== null) continue;
      }
      if (routingRequest && !this.ownsProject(routingRequest.projectId)) continue;
      const existing = await this.getRecord(this.requestKey(issue));
      if (existing && !this.ownsRecord(existing)) continue;
      if (existing && ['completed', 'failed', 'blocked', 'rejected'].includes(existing.status)) continue;
      if (!existing && this.operatorRevision) {
        remoteOperatorRevision ??= await this.channel.branchHead(this.operatorBranch);
        if (remoteOperatorRevision !== this.operatorRevision) {
          return {
            status: 'operator_update_pending',
            issueNumber: issue.number,
            localRevision: this.operatorRevision,
            remoteRevision: remoteOperatorRevision,
            updatedAt: this.now()
          };
        }
      }
      const result = await this.processIssue(issue);
      if (result) return result;
    }
    if (notificationError) throw notificationError;
    return null;
  }
}

export async function watchIssueQueue(queue, { pollIntervalMs = 15_000, signal, beforeTick, onTick, onError } = {}) {
  if (!queue || typeof queue.claimWatcherLease !== 'function' || typeof queue.releaseWatcherLease !== 'function') {
    throw new Error('watchIssueQueue requires a lease-capable queue');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000) throw new Error('issue queue pollIntervalMs must be at least 1000');
  if (beforeTick !== undefined && typeof beforeTick !== 'function') throw new Error('issue queue beforeTick must be a function');
  if (signal?.aborted) return;
  const lease = await queue.claimWatcherLease();
  let operationError = null;
  try {
    while (!signal?.aborted) {
      if (beforeTick && await beforeTick() === false) break;
      if (signal?.aborted) break;
      try {
        const result = await queue.tick();
        await onTick?.(result);
      } catch (error) {
        await onError?.(error);
      }
      if (signal?.aborted) break;
      await new Promise((resolveSleep) => {
        let timer = null;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          signal?.removeEventListener?.('abort', finish);
          resolveSleep();
        };
        timer = setTimeout(finish, pollIntervalMs);
        if (signal) {
          if (signal.aborted) return finish();
          signal.addEventListener?.('abort', finish, { once: true });
          if (signal.aborted) finish();
        }
      });
    }
  } catch (error) {
    operationError = error;
  }
  let released = false;
  let releaseError = null;
  try { released = await queue.releaseWatcherLease(lease.leaseId); }
  catch (error) { releaseError = error; }
  if (releaseError) throw new Error('issue_queue_watcher_lease_release_failed', { cause: releaseError });
  if (!released) throw new Error('issue_queue_watcher_lease_lost', { cause: operationError ?? undefined });
  if (operationError) throw operationError;
}
