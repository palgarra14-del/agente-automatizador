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
    analyze({ history, recentProposalPaths }) {
      assert.deepEqual(history, []);
      assert.deepEqual(recentProposalPaths, []);
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
});
