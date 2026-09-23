import { createHash } from 'node:crypto';

const PROFILE = 'autonomous-maintenance';
const STATE_KEY = 'autopilotSelfImprovement';
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const COOLDOWN_MS = 30 * 60 * 1000;
const BILLING_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
const BILLING_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_STARTS_PER_24H = 4;
const HISTORY_LIMIT = 20;

export const AUTONOMOUS_MAINTENANCE_SCOPE = Object.freeze({
  allowedPaths: Object.freeze(['src', 'test/autonomous']),
  forbiddenPaths: Object.freeze([
    '.github',
    'config',
    'scripts',
    'package.json',
    'package-lock.json',
    'docs',
    'src/self-improvement.js',
    'src/core.js',
    'src/cloud-state.js',
    'src/cloud-workflow-engine.js',
    'src/cli.js',
    'src/issue-queue.js',
    'src/capabilities.js',
    'src/specialists.js'
  ])
});

export const AUTONOMOUS_MAINTENANCE_GOAL =
  "Inspect authoritative main and implement exactly one bounded, high-impact improvement to the agent's 24/7 reliability, recovery, runtime, Browser QA or observability. Prefer a concrete defect, warning, inefficiency or missing regression over speculative refactoring. Treat the autonomy controller, workflow core, Cloud State, CLI, issue queue, capability/specialist registries, workflows, config, scripts, dependencies, deployment, authentication, secrets and external communications as immutable roots of trust. Never edit existing baseline tests; add any new regression only under test/autonomous/. Preserve all merge/production safety boundaries and stop after one coherent improvement.";

function emptyAutopilot() {
  return {
    version: 1,
    activeWorkflowId: null,
    activeBaseRevision: null,
    sequence: 0,
    starts: [],
    history: [],
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
  const policyPaths = Array.isArray(policy?.paths) ? [...policy.paths].sort() : null;
  const changePaths = Array.isArray(changeSet?.paths) ? [...changeSet.paths].sort() : null;
  if (policy?.ok !== true || policy.classification !== 'sensitive' || !policyPaths?.length || !changePaths?.length) return false;
  if (JSON.stringify(policyPaths) !== JSON.stringify(changePaths)) return false;
  if (changeSet?.sensitiveContent === true || policy.reason === 'sensitive_change:security_or_auth_content') return false;
  if (typeof policy.reason !== 'string' || !policy.reason.startsWith('sensitive_change:src')) return false;
  if (!policyPaths.every((path) =>
    typeof path === 'string' &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    pathAllowedForAutopilot(path)
  )) return false;
  return /^[a-f0-9]{64}$/i.test(step.evidence?.changeSetFingerprint ?? '');
}

function billingUnavailableError(error) {
  return /(billing|auth(?:entication|orization)?|api[_-]?key|quota|credit)/i.test(String(error ?? ''));
}

function nextBillingBackoffMs(state) {
  let consecutivePriorFailures = 0;
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    if (!billingUnavailableError(state.history[index]?.error)) break;
    consecutivePriorFailures += 1;
  }
  return Math.min(
    BILLING_BACKOFF_BASE_MS * (2 ** Math.min(consecutivePriorFailures, 2)),
    BILLING_BACKOFF_MAX_MS
  );
}

function resultSummary(plan) {
  const implementation = plan?.steps?.find((step) => step.id === 'implementation');
  const publication = plan?.steps?.find((step) => step.id === 'publication');
  return {
    workflowId: plan?.id ?? null,
    status: plan?.status ?? null,
    error: plan?.result?.error ?? null,
    changedPaths: Array.isArray(implementation?.evidence?.changeSet?.paths)
      ? [...implementation.evidence.changeSet.paths].sort()
      : [],
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

  recentProposalPaths(state) {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    return [...new Set(state.history
      .filter((entry) =>
        entry?.status === 'completed' &&
        Number.isFinite(Date.parse(entry.completedAt)) &&
        Date.parse(entry.completedAt) >= cutoff
      )
      .flatMap((entry) => Array.isArray(entry.changedPaths) ? entry.changedPaths : [])
      .filter((path) => typeof path === 'string' && pathAllowedForAutopilot(path))
    )].sort();
  }

  cooldownApplies(state, starts = this.recentStarts(state)) {
    const lastStart = starts.at(-1);
    if (!lastStart) return false;
    const lastStartAt = Date.parse(lastStart);
    if (!Number.isFinite(lastStartAt) || this.now() - lastStartAt >= COOLDOWN_MS) return false;
    const latest = state.history.at(-1);
    const completedAt = Date.parse(latest?.completedAt ?? '');
    const completedLatestStart =
      Number.isFinite(completedAt) &&
      completedAt >= lastStartAt &&
      typeof latest?.baseRevision === 'string' &&
      /^[a-f0-9]{40}$/i.test(latest.baseRevision);
    if (completedLatestStart && latest.baseRevision.toLowerCase() !== this.operatorRevision) return false;
    return true;
  }

  async hasWork() {
    const state = await this.readState();
    if (state.activeWorkflowId) return true;
    if (state.suspendedUntil && Date.parse(state.suspendedUntil) > this.now()) return false;
    const starts = this.recentStarts(state);
    if (starts.length >= MAX_STARTS_PER_24H) return false;
    if (this.cooldownApplies(state, starts)) return false;
    return true;
  }

  async settle(plan, { baseRevision }) {
    const summary = resultSummary(plan);
    const billingUnavailable = billingUnavailableError(summary.error);
    return this.writeState((state) => ({
      ...state,
      activeWorkflowId: null,
      activeBaseRevision: null,
      history: [...state.history, {
        ...summary,
        baseRevision,
        completedAt: new Date(this.now()).toISOString()
      }].slice(-HISTORY_LIMIT),
      suspendedUntil: billingUnavailable
        ? new Date(this.now() + nextBillingBackoffMs(state)).toISOString()
        : null
    }));
  }

  async createWorkflow() {
    const state = await this.readState();
    if (state.activeWorkflowId) return state.activeWorkflowId;
    if (state.suspendedUntil && Date.parse(state.suspendedUntil) > this.now()) return null;
    const starts = this.recentStarts(state);
    if (starts.length >= MAX_STARTS_PER_24H) return null;
    if (this.cooldownApplies(state, starts)) return null;

    const recentProposalPaths = this.recentProposalPaths(state);
    const workflow = await this.workflowEngine.create({
      profile: PROFILE,
      projectId: 'self',
      goal: recentProposalPaths.length
        ? `${AUTONOMOUS_MAINTENANCE_GOAL} Do not revisit these files already proposed by autonomous PRs in the last 24 hours: ${recentProposalPaths.join(', ')}.`
        : AUTONOMOUS_MAINTENANCE_GOAL,
      scope: {
        allowedPaths: [...AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths],
        forbiddenPaths: [...new Set([
          ...AUTONOMOUS_MAINTENANCE_SCOPE.forbiddenPaths,
          ...recentProposalPaths
        ])]
      }
    });
    const startedAt = new Date(this.now()).toISOString();
    await this.writeState((current) => ({
      ...current,
      activeWorkflowId: workflow.id,
      activeBaseRevision: this.operatorRevision,
      sequence: current.sequence + 1,
      starts: [...this.recentStarts(current), startedAt],
      suspendedUntil: null
    }));
    return workflow.id;
  }

  async tick() {
    let state = await this.readState();

    let workflowId = state.activeWorkflowId;
    if (!workflowId) {
      workflowId = await this.createWorkflow();
      if (!workflowId) {
        return { status: 'idle', workflowId: null };
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
          suspendedUntil: new Date(this.now() + BILLING_BACKOFF_MAX_MS).toISOString()
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
          if (typeof this.workflowEngine.cancel === 'function') {
            const cancelled = await this.workflowEngine.cancel(workflowId, {
              reason: 'autonomous_maintenance_human_gate_required'
            });
            await this.settle(cancelled, { baseRevision });
            return { ...resultSummary(cancelled), status: cancelled.status, humanGateStepId: step.id };
          }
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
