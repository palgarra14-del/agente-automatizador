import { createHash } from 'node:crypto';

const PROFILE = 'autonomous-maintenance';
const STATE_KEY = 'autopilotSelfImprovement';
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const COOLDOWN_MS = 30 * 60 * 1000;
const BILLING_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_STARTS_PER_24H = 4;
const HISTORY_LIMIT = 20;

export const AUTONOMOUS_MAINTENANCE_SCOPE = Object.freeze({
  allowedPaths: Object.freeze(['src', 'test']),
  forbiddenPaths: Object.freeze([
    '.github',
    'config',
    'scripts',
    'package.json',
    'package-lock.json',
    'docs'
  ])
});

export const AUTONOMOUS_MAINTENANCE_GOAL =
  "Inspect authoritative main and implement exactly one bounded, high-impact improvement to the agent's 24/7 autonomy, reliability, recovery or observability. Prefer a concrete defect, warning, inefficiency or missing regression over speculative refactoring. Keep all changes inside src/ and test/. Do not change workflows, config, scripts, dependency manifests, deployment, authentication, secrets or external communication behavior. Add adversarial regression coverage, preserve all merge/production safety boundaries, and stop after one coherent improvement.";

function emptyAutopilot() {
  return {
    version: 1,
    activeWorkflowId: null,
    activeBaseRevision: null,
    sequence: 0,
    starts: [],
    history: [],
    waitingForMerge: null,
    suspendedUntil: null,
    updatedAt: null
  };
}

function normalizeAutopilot(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : emptyAutopilot();
  return {
    ...emptyAutopilot(),
    ...state,
    starts: Array.isArray(state.starts) ? state.starts.filter((item) => Number.isFinite(Date.parse(item))).slice(-MAX_STARTS_PER_24H * 4) : [],
    history: Array.isArray(state.history) ? state.history.slice(-HISTORY_LIMIT) : []
  };
}

function policyFingerprint(workflowId, baseRevision, stepId) {
  return createHash('sha256')
    .update(`autonomous-maintenance-policy-v1|${workflowId}|${baseRevision}|${stepId}`)
    .digest('hex');
}

function pathWithin(root, path) {
  return path === root || path.startsWith(`${root}/`);
}

function pathAllowedForAutopilot(path) {
  const allowed = AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths.some((root) => pathWithin(root, path));
  const forbidden = AUTONOMOUS_MAINTENANCE_SCOPE.forbiddenPaths.some((root) => pathWithin(root, path));
  return allowed && !forbidden;
}

export function autonomousSensitiveImplementationAllowed(step) {
  if (!step ||
      step.id !== 'implementation' ||
      step.status !== 'awaiting_approval' ||
      step.error !== 'workflow_sensitive_change_requires_approval') return false;
  const policy = step.evidence?.changePolicy;
  const changeSet = step.evidence?.changeSet;
  const paths = Array.isArray(policy?.paths) ? policy.paths : changeSet?.paths;
  if (policy?.ok !== true || policy.classification !== 'sensitive' || !Array.isArray(paths) || paths.length < 1) return false;
  if (changeSet?.sensitiveContent === true || policy.reason === 'sensitive_change:security_or_auth_content') return false;
  if (typeof policy.reason !== 'string' || !policy.reason.startsWith('sensitive_change:src')) return false;
  if (!paths.every((path) => typeof path === 'string' && pathAllowedForAutopilot(path))) return false;
  return /^[a-f0-9]{64}$/i.test(step.evidence?.changeSetFingerprint ?? '');
}

function resultSummary(plan) {
  const publication = plan?.steps?.find((step) => step.id === 'publication');
  return {
    workflowId: plan?.id ?? null,
    status: plan?.status ?? null,
    error: plan?.result?.error ?? null,
    pullRequestNumber: publication?.evidence?.pullRequest?.number ?? null,
    pullRequestUrl: publication?.evidence?.pullRequest?.url ?? null,
    finalHead: publication?.evidence?.commit?.finalHead ?? null
  };
}

export class AutonomousSelfImprovement {
  constructor({ store, workflowEngine, operatorRevision, now = () => Date.now() } = {}) {
    if (!store || !workflowEngine) throw new Error('autonomous_self_improvement_dependencies_required');
    if (typeof operatorRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(operatorRevision)) {
      throw new Error('autonomous_self_improvement_revision_invalid');
    }
    this.store = store;
    this.workflowEngine = workflowEngine;
    this.operatorRevision = operatorRevision.toLowerCase();
    this.now = now;
  }

  async readState() {
    const root = await this.store.load();
    return normalizeAutopilot(root[STATE_KEY]);
  }

  async writeState(mutator) {
    return this.store.mutate((root) => {
      const current = normalizeAutopilot(root[STATE_KEY]);
      const next = mutator(current) ?? current;
      next.version = 1;
      next.updatedAt = new Date(this.now()).toISOString();
      root[STATE_KEY] = next;
      return next;
    });
  }

  recentStarts(state) {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    return state.starts.filter((value) => Date.parse(value) >= cutoff);
  }

  async hasWork() {
    const state = await this.readState();
    if (state.activeWorkflowId) return true;
    if (state.waitingForMerge?.baseRevision === this.operatorRevision) return false;
    if (state.suspendedUntil && Date.parse(state.suspendedUntil) > this.now()) return false;
    if (this.recentStarts(state).length >= MAX_STARTS_PER_24H) return false;
    const lastStart = this.recentStarts(state).at(-1);
    if (lastStart && this.now() - Date.parse(lastStart) < COOLDOWN_MS) return false;
    return true;
  }

  async settle(plan, { baseRevision }) {
    const summary = resultSummary(plan);
    const billingUnavailable = /billing/i.test(String(summary.error ?? ''));
    return this.writeState((state) => ({
      ...state,
      activeWorkflowId: null,
      activeBaseRevision: null,
      history: [...state.history, {
        ...summary,
        baseRevision,
        completedAt: new Date(this.now()).toISOString()
      }].slice(-HISTORY_LIMIT),
      waitingForMerge: summary.status === 'completed'
        ? {
            workflowId: summary.workflowId,
            baseRevision,
            pullRequestNumber: summary.pullRequestNumber,
            pullRequestUrl: summary.pullRequestUrl,
            finalHead: summary.finalHead,
            since: new Date(this.now()).toISOString()
          }
        : null,
      suspendedUntil: billingUnavailable
        ? new Date(this.now() + BILLING_BACKOFF_MS).toISOString()
        : state.suspendedUntil
    }));
  }

  async createWorkflow() {
    const state = await this.readState();
    if (state.activeWorkflowId) return state.activeWorkflowId;
    if (state.waitingForMerge?.baseRevision === this.operatorRevision) return null;
    if (state.suspendedUntil && Date.parse(state.suspendedUntil) > this.now()) return null;
    const starts = this.recentStarts(state);
    if (starts.length >= MAX_STARTS_PER_24H) return null;
    const lastStart = starts.at(-1);
    if (lastStart && this.now() - Date.parse(lastStart) < COOLDOWN_MS) return null;

    const workflow = await this.workflowEngine.create({
      profile: PROFILE,
      projectId: 'self',
      goal: AUTONOMOUS_MAINTENANCE_GOAL,
      scope: {
        allowedPaths: [...AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths],
        forbiddenPaths: [...AUTONOMOUS_MAINTENANCE_SCOPE.forbiddenPaths]
      }
    });
    const startedAt = new Date(this.now()).toISOString();
    await this.writeState((current) => ({
      ...current,
      activeWorkflowId: workflow.id,
      activeBaseRevision: this.operatorRevision,
      sequence: current.sequence + 1,
      starts: [...this.recentStarts(current), startedAt],
      waitingForMerge: current.waitingForMerge?.baseRevision === this.operatorRevision ? current.waitingForMerge : null,
      suspendedUntil: null
    }));
    return workflow.id;
  }

  async tick() {
    let state = await this.readState();
    if (state.waitingForMerge && state.waitingForMerge.baseRevision !== this.operatorRevision) {
      state = await this.writeState((current) => ({ ...current, waitingForMerge: null }));
    }

    let workflowId = state.activeWorkflowId;
    if (!workflowId) {
      workflowId = await this.createWorkflow();
      if (!workflowId) {
        const refreshed = await this.readState();
        return {
          status: refreshed.waitingForMerge?.baseRevision === this.operatorRevision ? 'waiting_for_merge' : 'idle',
          workflowId: null
        };
      }
      state = await this.readState();
    }

    const baseRevision = state.activeBaseRevision ?? this.operatorRevision;
    for (let transition = 0; transition < 4; transition += 1) {
      let plan = await this.workflowEngine.get(workflowId);
      if (!plan) {
        await this.writeState((current) => ({
          ...current,
          activeWorkflowId: null,
          activeBaseRevision: null,
          suspendedUntil: new Date(this.now() + COOLDOWN_MS).toISOString()
        }));
        return { status: 'missing_workflow', workflowId };
      }
      if (plan.profile !== PROFILE || plan.projectId !== 'self') {
        await this.writeState((current) => ({
          ...current,
          activeWorkflowId: null,
          activeBaseRevision: null,
          suspendedUntil: new Date(this.now() + BILLING_BACKOFF_MS).toISOString()
        }));
        return { status: 'workflow_binding_invalid', workflowId };
      }

      if (TERMINAL.has(plan.status)) {
        await this.settle(plan, { baseRevision });
        return { ...resultSummary(plan), status: plan.status };
      }

      if (plan.status === 'awaiting_approval') {
        const awaiting = plan.steps.filter((step) => step.status === 'awaiting_approval');
        if (awaiting.length !== 1) {
          return { status: 'human_gate_required', workflowId, stepId: null };
        }
        const step = awaiting[0];
        const releaseReady = step.id === 'release-readiness';
        const boundedSensitiveImplementation = autonomousSensitiveImplementationAllowed(step);
        if (!releaseReady && !boundedSensitiveImplementation) {
          return { status: 'human_gate_required', workflowId, stepId: step.id };
        }
        plan = await this.workflowEngine.approve(workflowId, step.id, {
          externalApprovalFingerprint: policyFingerprint(workflowId, baseRevision, step.id)
        });
        if (TERMINAL.has(plan.status)) {
          await this.settle(plan, { baseRevision });
          return { ...resultSummary(plan), status: plan.status };
        }
        continue;
      }

      plan = await this.workflowEngine.run(workflowId);
      if (TERMINAL.has(plan.status)) {
        await this.settle(plan, { baseRevision });
        return { ...resultSummary(plan), status: plan.status };
      }
      if (plan.status === 'awaiting_approval') continue;
      return { ...resultSummary(plan), status: plan.status };
    }

    const current = await this.workflowEngine.get(workflowId);
    return { ...resultSummary(current), status: current?.status ?? 'transition_budget_exhausted' };
  }
}
