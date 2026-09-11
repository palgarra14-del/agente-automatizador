import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolSkillRegistry, defaultSkills, defaultToolSkillRegistry, defaultTools } from '../src/capabilities.js';
import { configFrom, createWorkflowPlan, validateWorkflowPlan } from '../src/core.js';

function configuredProject(overrides = {}) {
  return configFrom({
    id: 'capability-project',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: {
      allow: ['project.verify', 'human.approval', 'code.inspect', 'code.implement', 'release.observe-ci'],
      deny: []
    },
    ...overrides
  });
}

test('tool and skill registry fingerprint is deterministic across declaration order', () => {
  const left = new ToolSkillRegistry({ tools: defaultTools, skills: defaultSkills });
  const right = new ToolSkillRegistry({ tools: [...defaultTools].reverse(), skills: [...defaultSkills].reverse() });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.deepEqual(left.snapshot(), right.snapshot());
});

test('registry rejects duplicate ids and skills that reference unknown tools', () => {
  assert.throws(() => new ToolSkillRegistry({
    tools: [defaultTools[0], defaultTools[0]],
    skills: []
  }), /Duplicate tool id/);
  assert.throws(() => new ToolSkillRegistry({
    tools: defaultTools,
    skills: [{ id: 'broken.skill', requiresTools: ['missing-tool'], surfaces: ['workflow'] }]
  }), /unknown tool/);
});

test('project capability policy is explicit and rejects unknown or contradictory skills', () => {
  assert.throws(() => configFrom({
    id: 'bad-policy',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['does.not-exist'], deny: [] }
  }), /unknown skill/);
  assert.throws(() => defaultToolSkillRegistry.validateProjectPolicy({
    allow: ['project.verify'],
    deny: ['project.verify']
  }), /both allowed and denied/);
});

test('capability resolution distinguishes policy, binding, and execution surface', () => {
  const project = configuredProject();
  const verification = defaultToolSkillRegistry.resolve(project, 'project.verify', { surface: 'workflow' });
  assert.equal(verification.allowed, true);
  assert.equal(verification.available, true);
  assert.equal(verification.reason, null);

  const inspectWorkflow = defaultToolSkillRegistry.resolve(project, 'code.inspect', { surface: 'workflow' });
  assert.equal(inspectWorkflow.allowed, true);
  assert.equal(inspectWorkflow.available, false);
  assert.equal(inspectWorkflow.reason, 'skill_not_bound_to_surface');

  const inspectOrchestrator = defaultToolSkillRegistry.resolve(project, 'code.inspect', { surface: 'orchestrator' });
  assert.equal(inspectOrchestrator.available, true);

  const research = defaultToolSkillRegistry.resolve(project, 'research.web', { surface: 'workflow' });
  assert.equal(research.allowed, false);
  assert.equal(research.available, false);
  assert.equal(research.reason, 'skill_not_allowed');
});

test('capability report never claims unbound future tools are available', () => {
  const project = configuredProject({
    skills: { allow: ['project.verify', 'human.approval', 'research.web'], deny: [] }
  });
  const report = defaultToolSkillRegistry.report(project, { surface: 'workflow' });
  const research = report.skills.find((skill) => skill.id === 'research.web');
  assert.equal(research.allowed, true);
  assert.equal(research.available, false);
  assert.ok(['skill_not_bound_to_surface', 'tool_unbound'].includes(research.reason));
  assert.equal(typeof report.registryFingerprint, 'string');
  assert.equal(report.registryFingerprint.length, 64);
});

test('workflow plan persists registry fingerprint and exact skill ids', () => {
  const project = configuredProject();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project, goal: 'Inspect capabilities' });
  assert.equal(plan.registryFingerprint, defaultToolSkillRegistry.fingerprint);
  assert.equal(plan.projectSkillPolicyFingerprint, defaultToolSkillRegistry.policyFingerprint(project.skills));
  assert.equal(plan.steps.find((step) => step.id === 'inspect-project').skill, 'code.inspect');
  assert.equal(plan.steps.find((step) => step.id === 'tests').skill, 'project.verify');
  assert.equal(validateWorkflowPlan(plan, new Map([[project.id, project]])).ok, true);
});

test('workflow validation fails closed on registry fingerprint or skill tampering', () => {
  const project = configuredProject();
  const fingerprintTampered = createWorkflowPlan({ profile: 'app-improvement', project, goal: 'Reject registry tampering' });
  fingerprintTampered.registryFingerprint = '0'.repeat(64);
  assert.throws(() => validateWorkflowPlan(fingerprintTampered, new Map([[project.id, project]])), /registry fingerprint/);

  const skillTampered = createWorkflowPlan({ profile: 'app-improvement', project, goal: 'Reject skill tampering' });
  skillTampered.steps.find((step) => step.id === 'tests').skill = 'human.approval';
  assert.throws(() => validateWorkflowPlan(skillTampered, new Map([[project.id, project]])), /step skill/);
});


test('workflow validation fails closed when project skill policy changes after plan creation', () => {
  const project = configuredProject();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project, goal: 'Freeze project capability policy' });
  const changedProject = configuredProject({
    skills: {
      allow: ['project.verify', 'human.approval', 'code.inspect', 'code.implement', 'release.observe-ci', 'requirements.define'],
      deny: []
    }
  });
  assert.notEqual(defaultToolSkillRegistry.policyFingerprint(project.skills), defaultToolSkillRegistry.policyFingerprint(changedProject.skills));
  assert.throws(() => validateWorkflowPlan(plan, new Map([[changedProject.id, changedProject]])), /project skill policy fingerprint/);
});


test('registry fingerprint ignores descriptions but changes on executable contract changes', () => {
  const described = new ToolSkillRegistry({
    tools: defaultTools.map((tool) => ({ ...tool, description: `changed: ${tool.description}` })),
    skills: defaultSkills.map((skill) => ({ ...skill, description: `changed: ${skill.description}` }))
  });
  assert.equal(described.fingerprint, defaultToolSkillRegistry.fingerprint);

  const rebound = new ToolSkillRegistry({
    tools: defaultTools.map((tool) => tool.id === 'project-command' ? { ...tool, binding: 'DifferentRunner' } : tool),
    skills: defaultSkills
  });
  assert.notEqual(rebound.fingerprint, defaultToolSkillRegistry.fingerprint);
});

test('registry internals cannot be mutated through public properties', () => {
  const registry = new ToolSkillRegistry({ tools: defaultTools, skills: defaultSkills });
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.hasOwn(registry, 'tools'), false);
  assert.equal(Object.hasOwn(registry, 'skills'), false);
  const original = registry.fingerprint;
  assert.throws(() => { registry.fingerprint = 'tampered'; }, TypeError);
  assert.equal(registry.fingerprint, original);
});
