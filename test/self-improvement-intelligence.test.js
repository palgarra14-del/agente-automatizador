import assert from 'node:assert/strict';
import test from 'node:test';
import { AutonomousGapIntelligence } from '../src/self-improvement-intelligence.js';
import { AutonomousProjectImprovement } from '../src/self-improvement.js';

const REV = 'a'.repeat(40);

function project(id) {
  return { id, skills: { allow: [], deny: [] } };
}

function fakeStore(initial = {}) {
  const state = JSON.parse(JSON.stringify(initial));
  return {
    state,
    async load() { return JSON.parse(JSON.stringify(state)); },
    async mutate(fn) {
      const result = await fn(state);
      return JSON.parse(JSON.stringify(result));
    }
  };
}

test('gap intelligence prioritizes repeated GitHub state failures over speculative capability work', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('self') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'failed', error: 'cloud_state_github_request_failed:403', changedPaths: [] },
      { status: 'failed', error: 'cloud_state_too_large', changedPaths: [] },
      { status: 'blocked', error: 'github_request_failed:403', changedPaths: [] }
    ]
  });

  assert.equal(analysis.primary, 'reliability:github-state');
  assert.match(analysis.directive, /3 recent non-successful cycle/);
  const capabilityGap = analysis.signals.find((signal) => signal.kind === 'capability:missing');
  assert.ok(capabilityGap);
  assert.equal(capabilityGap.actionable, false);
  assert.ok(capabilityGap.skills.includes('visual.review'));
});

test('executor attempt exhaustion is classified as model execution debt', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('self') });
  const analysis = intelligence.analyze({
    history: [
      {
        status: 'failed',
        error: 'skill_executor_attempt_budget_exhausted',
        failureDetail: 'Refusing to create helper binaries under temporary codex_home',
        changedPaths: []
      },
      { status: 'failed', error: 'skill_executor_attempt_budget_exhausted', changedPaths: [] }
    ]
  });

  assert.equal(analysis.primary, 'reliability:model-execution');
  assert.match(analysis.directive, /model-execution/);
  assert.match(analysis.directive, /codex_home/);
});

test('business lanes keep orchestrator failures visible but do not spend commercial cycles on them', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('callflow') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'failed', error: 'skill_executor_attempt_budget_exhausted', failureDetail: 'no_role_candidate_available', changedPaths: [] },
      { status: 'failed', error: 'workflow_budget_deadline_exceeded', changedPaths: [] },
      { status: 'failed', error: 'provider_temporarily_unavailable', changedPaths: [] },
      { status: 'blocked', error: 'stale_autoranking_replan', changedPaths: [] }
    ]
  });

  assert.equal(analysis.primary, 'continuous-improvement:opportunity');
  for (const kind of ['reliability:model-execution', 'reliability:runtime-timeout', 'reliability:model-availability', 'reliability:control-plane']) {
    const signal = analysis.signals.find((item) => item.kind === kind);
    assert.ok(signal);
    assert.equal(signal.actionable, false);
    assert.match(signal.evidence, /self lane/);
  }
  const throughput = analysis.signals.find((item) => item.kind === 'throughput:no-recent-success');
  assert.equal(throughput.actionable, false);
});

test('unclassified business implementation failures remain actionable instead of being hidden as infrastructure', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('website-pilot') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'failed', error: 'workflow_implementation_attempt_budget_exhausted', changedPaths: [] }
    ]
  });

  assert.equal(analysis.primary, 'reliability:other');
  const signal = analysis.signals.find((item) => item.kind === 'reliability:other');
  assert.equal(signal.actionable, true);
});

test('implementation no-change failures become a concrete autonomous priority', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('callflow') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'failed', error: 'workflow_implementation_no_changes', changedPaths: [] }
    ]
  });

  assert.equal(analysis.primary, 'reliability:implementation-noop');
  assert.match(analysis.directive, /implementation-noop/);
});

test('unavailable desired capabilities stay visible but cannot become the implementable primary by themselves', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('website-pilot') });
  const analysis = intelligence.analyze({ history: [] });

  assert.equal(analysis.primary, 'continuous-improvement:opportunity');
  assert.ok(analysis.signals.some((signal) => signal.kind === 'capability:missing'));
  assert.match(analysis.directive, /do not weaken policy/i);
});

test('gap intelligence detects low success rate and local-minimum repetition from bounded history', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('callflow') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'completed', changedPaths: ['app.js'] },
      { status: 'failed', error: 'workflow_budget_deadline_exceeded', changedPaths: [] },
      { status: 'failed', error: 'verification_failed', changedPaths: [] },
      { status: 'completed', changedPaths: ['app.js'] },
      { status: 'failed', error: 'workspace_clone_failed', changedPaths: [] },
      { status: 'failed', error: 'workflow_budget_deadline_exceeded', changedPaths: [] }
    ],
    recentProposalPaths: ['app.js', 'prospect.js']
  });

  assert.ok(analysis.signals.some((signal) => signal.kind === 'throughput:low-success-rate'));
  assert.ok(analysis.signals.some((signal) => signal.kind === 'learning:local-minimum'));
  assert.match(analysis.directive, /app\.js, prospect\.js/);
});

test('learning memory reduces immediate repetition of a just-resolved gap', () => {
  const intelligence = new AutonomousGapIntelligence({ project: project('self') });
  const analysis = intelligence.analyze({
    history: [
      { status: 'failed', error: 'verification_failed', changedPaths: [] },
      { status: 'failed', error: 'workspace_clone_failed', changedPaths: [] }
    ],
    memory: [
      {
        kind: 'reliability:verification',
        seenCount: 4,
        selectedCount: 2,
        successCount: 1,
        failureCount: 1,
        blockedCount: 0,
        lastOutcome: 'completed'
      }
    ]
  });

  assert.equal(analysis.primary, 'reliability:workspace');
  const verification = analysis.signals.find((signal) => signal.kind === 'reliability:verification');
  assert.ok(verification);
  assert.equal(verification.learning.lastOutcome, 'completed');
  assert.ok(verification.learning.outcomeAdjustment < 0);
});

test('autonomous workflow creation injects the current gap directive into the next bounded goal', async () => {
  const store = fakeStore();
  let created = null;
  const workflowEngine = {
    async create(input) {
      created = input;
      return { id: 'workflow-intelligent' };
    }
  };
  const intelligence = {
    analyze({ history, recentProposalPaths, memory }) {
      assert.deepEqual(history, []);
      assert.deepEqual(recentProposalPaths, []);
      assert.deepEqual(memory, []);
      return {
        version: 1,
        projectId: 'self',
        primary: 'reliability:github-state',
        signals: [{ kind: 'reliability:github-state', score: 88, actionable: true, evidence: 'fixture' }],
        directive: 'Autonomous gap intelligence priority: reliability:github-state. Fix the evidence-backed bottleneck.'
      };
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine,
    operatorRevision: REV,
    projectId: 'self',
    intelligence,
    now: () => Date.parse('2026-09-30T00:00:00Z')
  });

  const workflowId = await autopilot.createWorkflow();

  assert.equal(workflowId, 'workflow-intelligent');
  assert.match(created.goal, /Autonomous gap intelligence priority: reliability:github-state/);
  assert.equal(store.state.autopilotSelfImprovement.lastIntelligence.primary, 'reliability:github-state');
  assert.equal(store.state.autopilotSelfImprovement.lastIntelligence.signals.length, 1);
  assert.equal(store.state.autopilotSelfImprovement.gapMemory.length, 1);
  assert.equal(store.state.autopilotSelfImprovement.gapMemory[0].kind, 'reliability:github-state');
  assert.equal(store.state.autopilotSelfImprovement.gapMemory[0].selectedCount, 1);
});

test('failed autonomous outcomes preserve bounded root-cause evidence for the next intelligence cycle', async () => {
  const now = Date.parse('2026-09-30T00:20:00Z');
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-failed-learning',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-09-30T00:15:00.000Z'],
      history: [],
      lastIntelligence: {
        version: 1,
        projectId: 'self',
        primary: 'reliability:model-execution',
        signals: []
      },
      gapMemory: [],
      suspendedUntil: null,
      updatedAt: '2026-09-30T00:15:00.000Z'
    }
  });
  const workflowEngine = {
    async get() {
      return {
        id: 'workflow-failed-learning',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'failed',
        result: { error: 'skill_executor_attempt_budget_exhausted', stepId: 'inspect-project' },
        steps: [{
          id: 'inspect-project',
          status: 'failed',
          error: 'skill_executor_attempt_budget_exhausted',
          evidence: { error: 'gateway timed out while resolving provider '.repeat(30) }
        }]
      };
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine,
    operatorRevision: REV,
    projectId: 'self',
    intelligence: null,
    now: () => now
  });

  const result = await autopilot.tick();

  assert.equal(result.status, 'failed');
  const history = store.state.autopilotSelfImprovement.history.at(-1);
  assert.equal(history.error, 'skill_executor_attempt_budget_exhausted');
  assert.ok(history.failureDetail.length <= 500);
  assert.match(history.failureDetail, /gateway timed out/);
});

test('completed autonomous outcomes are learned by the selected gap before the next cycle', async () => {
  const now = Date.parse('2026-09-30T00:10:00Z');
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-learning',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-09-30T00:00:00.000Z'],
      history: [],
      lastIntelligence: {
        version: 1,
        projectId: 'self',
        primary: 'reliability:github-state',
        signals: []
      },
      gapMemory: [{
        kind: 'reliability:github-state',
        seenCount: 2,
        selectedCount: 1,
        successCount: 0,
        failureCount: 0,
        blockedCount: 0,
        lastOutcome: null,
        lastSeenAt: '2026-09-30T00:00:00.000Z'
      }],
      suspendedUntil: null,
      updatedAt: '2026-09-30T00:00:00.000Z'
    }
  });
  const workflowEngine = {
    async get() {
      return {
        id: 'workflow-learning',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'completed',
        result: null,
        steps: [
          { id: 'implementation', evidence: { changeSet: { paths: ['src/example.js'] } } },
          { id: 'publication', evidence: null }
        ]
      };
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine,
    operatorRevision: REV,
    projectId: 'self',
    intelligence: null,
    now: () => now
  });

  const result = await autopilot.tick();

  assert.equal(result.status, 'completed');
  const learned = store.state.autopilotSelfImprovement.gapMemory.find((entry) => entry.kind === 'reliability:github-state');
  assert.equal(learned.lastOutcome, 'completed');
  assert.equal(learned.successCount, 1);
  assert.equal(learned.failureCount, 0);
  assert.equal(learned.lastCompletedAt, '2026-09-30T00:10:00.000Z');
});

test('every terminal autonomous cycle persists an autoranking and the next iteration consumes it', async () => {
  const now = Date.parse('2026-09-30T01:00:00Z');
  const store = fakeStore({
    autopilotSelfImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-rank-source',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-09-30T00:50:00.000Z'],
      history: [],
      lastIntelligence: {
        version: 1,
        projectId: 'self',
        primary: 'reliability:verification',
        signals: []
      },
      nextRanking: null,
      gapMemory: [],
      suspendedUntil: null,
      updatedAt: '2026-09-30T00:50:00.000Z'
    }
  });
  let analyzeCalls = 0;
  let created = null;
  const intelligence = {
    analyze({ history, memory }) {
      analyzeCalls += 1;
      assert.equal(history.at(-1).workflowId, 'workflow-rank-source');
      assert.equal(history.at(-1).status, 'completed');
      const learned = memory.find((entry) => entry.kind === 'reliability:verification');
      assert.equal(learned?.lastOutcome, 'completed');
      return {
        version: 1,
        projectId: 'self',
        primary: 'continuous-improvement:opportunity',
        signals: [{
          kind: 'continuous-improvement:opportunity',
          score: 20,
          actionable: true,
          evidence: 'rank after terminal workflow'
        }],
        directive: 'Autoranking next iteration: improve the highest-evidence bounded opportunity.'
      };
    }
  };
  const workflowEngine = {
    async get() {
      return {
        id: 'workflow-rank-source',
        profile: 'autonomous-maintenance',
        projectId: 'self',
        status: 'completed',
        result: null,
        steps: [
          { id: 'implementation', evidence: { changeSet: { paths: ['src/ranked.js'] } } },
          { id: 'publication', evidence: null }
        ]
      };
    },
    async create(input) {
      created = input;
      return { id: 'workflow-rank-next' };
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine,
    operatorRevision: REV,
    projectId: 'self',
    intelligence,
    now: () => now
  });

  const settled = await autopilot.tick();
  assert.equal(settled.status, 'completed');
  assert.equal(analyzeCalls, 1);
  const ranking = store.state.autopilotSelfImprovement.nextRanking;
  assert.equal(ranking.primary, 'continuous-improvement:opportunity');
  assert.equal(ranking.trigger, 'workflow_terminal');
  assert.equal(ranking.afterWorkflowId, 'workflow-rank-source');
  assert.equal(ranking.generatedAt, '2026-09-30T01:00:00.000Z');

  const nextId = await autopilot.createWorkflow();
  assert.equal(nextId, 'workflow-rank-next');
  assert.equal(analyzeCalls, 1);
  assert.match(created.goal, /Autoranking next iteration/);
  assert.equal(store.state.autopilotSelfImprovement.nextRanking, null);
  assert.equal(
    store.state.autopilotSelfImprovement.lastIntelligence.primary,
    'continuous-improvement:opportunity'
  );
});


test('business workflow replans before implementation when its saved priority becomes infrastructure-owned', async () => {
  const now = Date.parse('2026-10-07T11:10:00Z');
  const store = fakeStore({
    autopilotProjectImprovement: {
      version: 1,
      activeWorkflowId: 'workflow-stale-business-ranking',
      activeBaseRevision: REV,
      sequence: 1,
      starts: ['2026-10-07T11:00:00.000Z'],
      history: [
        {
          workflowId: 'workflow-old-failure',
          status: 'failed',
          error: 'skill_executor_attempt_budget_exhausted',
          failureDetail: 'no_role_candidate_available',
          changedPaths: [],
          baseRevision: REV,
          completedAt: '2026-10-07T10:55:00.000Z'
        }
      ],
      lastIntelligence: {
        version: 1,
        projectId: 'leadfinder',
        primary: 'reliability:model-execution',
        signals: []
      },
      nextRanking: null,
      gapMemory: [],
      suspendedUntil: null,
      updatedAt: '2026-10-07T11:00:00.000Z'
    }
  });
  const intelligence = new AutonomousGapIntelligence({ project: project('leadfinder') });
  let cancelled = false;
  let ran = false;
  const basePlan = {
    id: 'workflow-stale-business-ranking',
    profile: 'autonomous-maintenance',
    projectId: 'leadfinder',
    status: 'pending',
    result: null,
    steps: [
      { id: 'inspect-project', status: 'ready', attempts: 1, evidence: { type: 'executor-start' }, error: null },
      { id: 'implementation', status: 'pending', attempts: 0, evidence: null, error: null },
      { id: 'publication', status: 'pending', attempts: 0, evidence: null, error: null }
    ]
  };
  const workflowEngine = {
    async get() { return JSON.parse(JSON.stringify(basePlan)); },
    async cancel(id, options) {
      assert.equal(id, basePlan.id);
      assert.equal(options.reason, 'stale_autoranking_replan');
      cancelled = true;
      const plan = JSON.parse(JSON.stringify(basePlan));
      plan.status = 'blocked';
      plan.result = { error: 'stale_autoranking_replan', stepId: 'inspect-project' };
      plan.steps[0].status = 'blocked';
      plan.steps[0].error = 'stale_autoranking_replan';
      return plan;
    },
    async run() {
      ran = true;
      throw new Error('stale business workflow should have been replanned before execution');
    }
  };
  const autopilot = new AutonomousProjectImprovement({
    store,
    workflowEngine,
    operatorRevision: REV,
    projectId: 'leadfinder',
    intelligence,
    now: () => now
  });

  const result = await autopilot.tick();

  assert.equal(cancelled, true);
  assert.equal(ran, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.replanRecommended, true);
  assert.equal(result.stalePrimary, 'reliability:model-execution');
  assert.equal(store.state.autopilotProjectImprovement.activeWorkflowId, null);
  assert.equal(store.state.autopilotProjectImprovement.nextRanking.primary, 'continuous-improvement:opportunity');
});
