import { createHash } from 'node:crypto';

const PROFILE = 'autonomous-maintenance';
const SELF_STATE_KEY = 'autopilotSelfImprovement';
const PROJECT_STATE_KEY = 'autopilotProjectImprovement';
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const SELF_COOLDOWN_MS = 30 * 60 * 1000;
const PROJECT_COOLDOWN_MS = 2 * 60 * 1000;
const BILLING_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
const BILLING_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_STARTS_PER_24H = 24;
const HISTORY_LIMIT = 20;
const STATE_KEY = SELF_STATE_KEY;
const COOLDOWN_MS = SELF_COOLDOWN_MS;
const MAX_STARTS_PER_24H = DEFAULT_MAX_STARTS_PER_24H;

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
    'src/cloud-drain.js',
    'src/cli.js',
    'src/issue-queue.js',
    'src/capabilities.js',
    'src/specialists.js'
  ])
});

export const AUTONOMOUS_MAINTENANCE_GOAL =
  "Inspect authoritative main and implement exactly one bounded, high-impact improvement that makes the commercial operating system more effective: LeadFinder -> Callflow -> conversion-focused demo/site production -> follow-up -> conversion -> feedback into lead quality and automation. Prioritize measurable improvements to qualified-lead throughput, contactability, CRM outcome/follow-up quality, demo turnaround, conversion instrumentation, cross-project learning, repeated-work automation, or 24/7 reliability that directly enables those outcomes. If a decision-relevant data gap is visible, prefer bounded instrumentation or feedback-loop support over guessing. Avoid speculative refactoring, cosmetic engineering, or technical polish without a clear commercial, throughput, data-quality, conversion, or reliability benefit. Treat the autonomy controller, workflow core, Cloud State, CLI, issue queue, capability/specialist registries, workflows, config, scripts, dependencies, deployment, authentication, secrets and external communications as immutable roots of trust. Never edit existing baseline tests; add any new regression only under test/autonomous/. Preserve all merge/production safety boundaries and stop after one coherent improvement.";


export const AUTONOMOUS_PROJECT_POLICIES = Object.freeze({
  self: Object.freeze({
    stateKey: SELF_STATE_KEY,
    cooldownMs: SELF_COOLDOWN_MS,
    maxStartsPer24h: DEFAULT_MAX_STARTS_PER_24H,
    goal: AUTONOMOUS_MAINTENANCE_GOAL,
    scope: AUTONOMOUS_MAINTENANCE_SCOPE,
    allowSensitiveImplementation: true
  }),
  leadfinder: Object.freeze({
    stateKey: PROJECT_STATE_KEY,
    cooldownMs: PROJECT_COOLDOWN_MS,
    maxStartsPer24h: DEFAULT_MAX_STARTS_PER_24H,
    goal: "Inspect authoritative LeadFinder main and implement exactly one bounded improvement that increases qualified lead throughput, contact-data quality, niche targeting, deduplication, prioritization, observability or reliable handoff into Callflow. Prefer measurable fixes and regression coverage over speculative refactors. Work only on safe application/docs paths, never secrets, workflow control, dependencies, deployment configuration or production data. Publish reviewable work only; never merge or deploy production.",
    scope: Object.freeze({
      allowedPaths: Object.freeze(['src', 'docs']),
      forbiddenPaths: Object.freeze(['.github', '.env.example', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'next.config.ts', 'tsconfig.json', 'vitest.config.ts'])
    }),
    allowSensitiveImplementation: false
  }),
  callflow: Object.freeze({
    stateKey: PROJECT_STATE_KEY,
    cooldownMs: PROJECT_COOLDOWN_MS,
    maxStartsPer24h: DEFAULT_MAX_STARTS_PER_24H,
    goal: "Inspect authoritative Callflow main and implement exactly one bounded improvement that increases sales-call throughput, lead prioritization, outcome capture, follow-up discipline, operator usability or feedback quality back to LeadFinder. Prefer deterministic UX/data-quality fixes with tests. Do not touch Apps Script, API/config secrets, deployment configuration, package metadata or external communications. Publish reviewable work only; never merge or deploy production.",
    scope: Object.freeze({
      allowedPaths: Object.freeze(['app.js', 'prospect.js', 'prospect-utils.js', 'callflow-navigation.js', 'index.html', 'styles.css', 'closing.css', 'tests']),
      forbiddenPaths: Object.freeze(['.github', 'google-apps-script', 'api', 'config.js', '.clasp.json', '.claspignore', 'package.json', 'scripts'])
    }),
    allowSensitiveImplementation: false
  }),
  'website-pilot': Object.freeze({
    stateKey: PROJECT_STATE_KEY,
    cooldownMs: PROJECT_COOLDOWN_MS,
    maxStartsPer24h: DEFAULT_MAX_STARTS_PER_24H,
    goal: "Inspect authoritative Website Pilot main and implement exactly one bounded improvement that makes the existing demo/site portfolio more professional, responsive, accessible, conversion-oriented, distinctive or faster to reuse for qualified local-business leads. Preserve factual honesty and existing routes. Prefer fixes supported by tests or rendered evidence. Do not touch dependency, deployment or secret-bearing control files. Publish reviewable work only; never merge or deploy production.",
    scope: Object.freeze({
      allowedPaths: Object.freeze(['index.html', 'assets', 'barberia', 'galeria', 'servicios', 'test', 'docs', '404.html', 'robots.txt', 'sitemap.xml']),
      forbiddenPaths: Object.freeze(['.github', '.vercel', 'vercel.json', 'package.json', 'scripts', 'aviso-legal', 'privacidad', 'cookies'])
    }),
    allowSensitiveImplementation: false
  })
});

export function autonomousProjectPolicy(projectId) {
  const policy = AUTONOMOUS_PROJECT_POLICIES[projectId];
  if (!policy) throw new Error(`autonomous_project_policy_missing:${projectId}`);
  return policy;
}

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

function normalizeAutopilot(value, maxStartsPer24h = MAX_STARTS_PER_24H) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : emptyAutopilot();
  return {
    ...emptyAutopilot(),
    ...state,
    starts: Array.isArray(state.starts) ? state.starts.filter((item) => Number.isFinite(Date.parse(item))).slice(-maxStartsPer24h * 4) : [],
    history: Array.isArray(state.history) ? state.history.slice(-HISTORY_LIMIT) : []
  };
}

function policyFingerprint(workflowId, baseRevision, stepId, projectId = 'self') {
  return createHash('sha256')
    .update(`autonomous-maintenance-policy-v2|${projectId}|${workflowId}|${baseRevision}|${stepId}`)
    .digest('hex');
}

function pathWithin(root, path) {
  return path === root || path.startsWith(`${root}/`);
}

function pathAllowedForAutopilot(path, scope = AUTONOMOUS_MAINTENANCE_SCOPE) {
  const allowed = scope.allowedPaths.some((root) => pathWithin(root, path));
  const forbidden = scope.forbiddenPaths.some((root) => pathWithin(root, path));
  return allowed && !forbidden;
}

function pristineWorkflowForDeadlineRefresh(plan) {
  return Boolean(
    plan &&
    plan.status === 'pending' &&
    plan.workspace === null &&
    plan.outputBytes === 0 &&
    (plan.modelUsage?.calls ?? 0) === 0 &&
    Array.isArray(plan.steps) &&
    plan.steps.length > 0 &&
    plan.steps.every((step, index) =>
      step.status === (index === 0 ? 'ready' : 'pending') &&
      step.attempts === 0 &&
      step.evidence === null &&
      step.error === null
    ) &&
    ['pending', 'not_required'].includes(plan.bootstrap?.status)
  );
}

function sensitiveImplementationAllowedForScope(step, scope) {
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
    pathAllowedForAutopilot(path, scope)
  )) return false;
  return /^[a-f0-9]{64}$/i.test(step.evidence?.changeSetFingerprint ?? '');
}

export function autonomousSensitiveImplementationAllowed(step) {
  return sensitiveImplementationAllowedForScope(step, AUTONOMOUS_MAINTENANCE_SCOPE);
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

export class AutonomousProjectImprovement {
  constructor({ store, workflowEngine, operatorRevision, projectId = 'self', workflowTimeoutMs = 300_000, now = () => Date.now() } = {}) {
    if (!store || !workflowEngine) throw new Error('autonomous_self_improvement_dependencies_required');
    if (typeof operatorRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(operatorRevision)) {
      throw new Error('autonomous_self_improvement_revision_invalid');
    }
    if (!Number.isInteger(workflowTimeoutMs) || workflowTimeoutMs < 1_000) {
      throw new Error('autonomous_self_improvement_timeout_invalid');
    }
    const policy = autonomousProjectPolicy(projectId);
    this.store = store;
    this.workflowEngine = workflowEngine;
    this.operatorRevision = operatorRevision.toLowerCase();
    this.projectId = projectId;
    this.stateKey = policy.stateKey;
    this.cooldownMs = policy.cooldownMs;
    this.maxStartsPer24h = policy.maxStartsPer24h;
    this.goal = policy.goal;
    this.scope = policy.scope;
    this.allowSensitiveImplementation = policy.allowSensitiveImplementation === true;
    this.workflowTimeoutMs = workflowTimeoutMs;
    this.now = now;
  }

  async readState() {
    const root = await this.store.load();
    return normalizeAutopilot(root[this.stateKey], this.maxStartsPer24h);
  }

  async writeState(mutator) {
    return this.store.mutate((root) => {
      const current = normalizeAutopilot(root[this.stateKey], this.maxStartsPer24h);
      const next = mutator(current) ?? current;
      next.version = 1;
      next.updatedAt = new Date(this.now()).toISOString();
      root[this.stateKey] = next;
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
      .filter((path) => typeof path === 'string' && pathAllowedForAutopilot(path, this.scope))
    )].sort();
  }

  cooldownApplies(state, starts = this.recentStarts(state)) {
    const lastStart = starts.at(-1);
    if (!lastStart) return false;
    const lastStartAt = Date.parse(lastStart);
    if (!Number.isFinite(lastStartAt) || this.now() - lastStartAt >= this.cooldownMs) return false;
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

  revisionAdvanceBypassesDailyCap(state, starts = this.recentStarts(state)) {
    if (starts.length < MAX_STARTS_PER_24H) return false;
    const latest = state.history.at(-1);
    const lastStartAt = Date.parse(starts.at(-1) ?? '');
    const completedAt = Date.parse(latest?.completedAt ?? '');
    return Number.isFinite(lastStartAt) &&
      Number.isFinite(completedAt) &&
      completedAt >= lastStartAt &&
      typeof latest?.baseRevision === 'string' &&
      /^[a-f0-9]{40}$/i.test(latest.baseRevision) &&
      latest.baseRevision.toLowerCase() !== this.operatorRevision;
  }

  revisionAdvanceBypassesSuspension(state) {
    const latest = state.history.at(-1);
    return typeof latest?.baseRevision === 'string' &&
      /^[a-f0-9]{40}$/i.test(latest.baseRevision) &&
      latest.baseRevision.toLowerCase() !== this.operatorRevision;
  }

  async hasWork() {
    const state = await this.readState();
    if (state.activeWorkflowId) return true;
    if (state.suspendedUntil &&
        Date.parse(state.suspendedUntil) > this.now() &&
        !this.revisionAdvanceBypassesSuspension(state)) return false;
    const starts = this.recentStarts(state);
    if (starts.length >= this.maxStartsPer24h && !this.revisionAdvanceBypassesDailyCap(state, starts)) return false;
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
    if (state.suspendedUntil &&
        Date.parse(state.suspendedUntil) > this.now() &&
        !this.revisionAdvanceBypassesSuspension(state)) return null;
    const starts = this.recentStarts(state);
    if (starts.length >= this.maxStartsPer24h && !this.revisionAdvanceBypassesDailyCap(state, starts)) return null;
    if (this.cooldownApplies(state, starts)) return null;

    const recentProposalPaths = this.recentProposalPaths(state);
    const workflow = await this.workflowEngine.create({
      profile: PROFILE,
      projectId: this.projectId,
      budgets: { timeoutMs: this.workflowTimeoutMs },
      goal: recentProposalPaths.length
        ? `${this.goal} Do not revisit these files already proposed by autonomous PRs in the last 24 hours: ${recentProposalPaths.join(', ')}.`
        : this.goal,
      scope: {
        allowedPaths: [...this.scope.allowedPaths],
        forbiddenPaths: [...new Set([
          ...this.scope.forbiddenPaths,
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
    const tickDeadlineAt = this.now() + this.workflowTimeoutMs;
    for (let transition = 0; transition < 4; transition += 1) {
      let plan = await this.workflowEngine.get(workflowId, { deadlineCapAt: tickDeadlineAt });
      if (!plan) {
        await this.writeState((current) => ({
          ...current,
          activeWorkflowId: null,
          activeBaseRevision: null,
          suspendedUntil: new Date(this.now() + this.cooldownMs).toISOString()
        }));
        return { status: 'missing_workflow', workflowId };
      }
      if (plan.profile !== PROFILE || plan.projectId !== this.projectId) {
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
        const boundedSensitiveImplementation = this.allowSensitiveImplementation && sensitiveImplementationAllowedForScope(step, this.scope);
        if (!releaseReady && !boundedSensitiveImplementation) {
          if (typeof this.workflowEngine.cancel === 'function') {
            const cancelled = await this.workflowEngine.cancel(workflowId, {
              reason: 'autonomous_maintenance_human_gate_required',
              deadlineCapAt: tickDeadlineAt
            });
            await this.settle(cancelled, { baseRevision });
            return { ...resultSummary(cancelled), status: cancelled.status, humanGateStepId: step.id };
          }
          return { status: 'human_gate_required', workflowId, stepId: step.id };
        }
        plan = await this.workflowEngine.approve(workflowId, step.id, {
          externalApprovalFingerprint: policyFingerprint(workflowId, baseRevision, step.id, this.projectId),
          deadlineCapAt: tickDeadlineAt
        });
        if (TERMINAL.has(plan.status)) {
          await this.settle(plan, { baseRevision });
          return { ...resultSummary(plan), status: plan.status };
        }
        continue;
      }

      plan = await this.workflowEngine.run(workflowId, {
        refreshPristineDeadline: pristineWorkflowForDeadlineRefresh(plan),
        deadlineCapAt: tickDeadlineAt
      });
      if (TERMINAL.has(plan.status)) {
        await this.settle(plan, { baseRevision });
        return { ...resultSummary(plan), status: plan.status };
      }
      if (plan.status === 'awaiting_approval') continue;
      return { ...resultSummary(plan), status: plan.status };
    }

    const current = await this.workflowEngine.get(workflowId, { deadlineCapAt: tickDeadlineAt });
    return { ...resultSummary(current), status: current?.status ?? 'transition_budget_exhausted' };
  }
}

export class AutonomousSelfImprovement extends AutonomousProjectImprovement {
  constructor(options = {}) {
    super({ ...options, projectId: 'self' });
  }
}
