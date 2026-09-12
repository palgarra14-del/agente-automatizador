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
  const deniedPolicy = defaultToolSkillRegistry.validateProjectPolicy({
    allow: ['project.verify'],
    deny: ['project.verify']
  });
  const deniedProject = configuredProject({ skills: deniedPolicy });
  const denied = defaultToolSkillRegistry.resolve(deniedProject, 'project.verify', { surface: 'workflow' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'skill_not_allowed');
});

test('capability resolution distinguishes policy, binding, and execution surface', () => {
  const project = configuredProject();
  const verification = defaultToolSkillRegistry.resolve(project, 'project.verify', { surface: 'workflow' });
  assert.equal(verification.allowed, true);
  assert.equal(verification.available, true);
  assert.equal(verification.reason, null);

  const inspectWorkflow = defaultToolSkillRegistry.resolve(project, 'code.inspect', { surface: 'workflow' });
  assert.equal(inspectWorkflow.allowed, true);
  assert.equal(inspectWorkflow.available, true);
  assert.equal(inspectWorkflow.reason, null);

  const inspectOrchestrator = defaultToolSkillRegistry.resolve(project, 'code.inspect', { surface: 'orchestrator' });
  assert.equal(inspectOrchestrator.available, false);
  assert.equal(inspectOrchestrator.reason, 'skill_not_bound_to_surface');

  const research = defaultToolSkillRegistry.resolve(project, 'research.web', { surface: 'workflow' });
  assert.equal(research.allowed, false);
  assert.equal(research.available, false);
  assert.equal(research.reason, 'skill_not_allowed');
});

test('website planning is workflow-only read authority and does not grant implementation or publication', () => {
  const configured = configuredProject({ skills: { allow: ['website.plan'], deny: [] } });
  const capability = defaultToolSkillRegistry.resolve(configured, 'website.plan', { surface: 'workflow' });
  assert.equal(capability.available, true);
  assert.equal(capability.risk, 'workspace-read');
  assert.deepEqual(capability.tools.map((tool) => tool.id), ['analysis-worker']);
  assert.equal(defaultToolSkillRegistry.resolve(configured, 'website.plan', { surface: 'orchestrator' }).available, false);
  assert.equal(defaultToolSkillRegistry.resolve(configured, 'code.implement', { surface: 'workflow' }).available, false);
  assert.equal(defaultToolSkillRegistry.resolve(configured, 'release.publish-reviewed-workflow', { surface: 'workflow' }).available, false);
});

test('dependency refresh capability is workflow-only and keeps network authority explicit', () => {
  const project = configuredProject({
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    toolchain: { command: 'npm' },
    execution: { provider: 'container-required', image: 'node:22-bookworm-slim' },
    skills: { allow: ['project.dependencies.refresh'], deny: [] }
  });
  const capability = defaultToolSkillRegistry.resolve(project, 'project.dependencies.refresh', { surface: 'workflow' });
  assert.equal(capability.available, true);
  assert.equal(capability.risk, 'network-workspace-execution');
  assert.deepEqual(capability.tools.map((tool) => tool.id), ['project-command']);
  assert.equal(defaultToolSkillRegistry.resolve(project, 'project.dependencies.refresh', { surface: 'orchestrator' }).available, false);
});

test('reviewed workflow publication is encapsulated behind one workflow authority', () => {
  const publicationProject = configuredProject({
    skills: { allow: ['release.publish-reviewed-workflow', 'human.approval', 'project.verify'], deny: [] }
  });
  const publication = defaultToolSkillRegistry.resolve(publicationProject, 'release.publish-reviewed-workflow', { surface: 'workflow' });
  assert.equal(publication.available, true);
  assert.deepEqual(publication.tools.map((tool) => tool.id), ['workflow-publication']);
  assert.deepEqual(defaultToolSkillRegistry.getTool('git-publish').surfaces, ['orchestrator']);
  assert.deepEqual(defaultToolSkillRegistry.getTool('github-publish').surfaces, ['orchestrator']);
  assert.deepEqual(defaultToolSkillRegistry.getTool('github-observe').surfaces, ['orchestrator']);
  assert.deepEqual(defaultToolSkillRegistry.getTool('vercel-observe').surfaces, ['orchestrator']);
  assert.equal(defaultToolSkillRegistry.resolve(publicationProject, 'repository.publish', { surface: 'workflow' }).available, false);
  assert.equal(defaultToolSkillRegistry.resolve(publicationProject, 'release.publish-pr', { surface: 'workflow' }).available, false);
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


test('skill contracts are versioned, normalized, and security-relevant', () => {
  const verify = defaultToolSkillRegistry.getSkill('project.verify');
  assert.equal(verify.contract.version, 1);
  assert.deepEqual(verify.contract.inputs, ['checks', 'project', 'workspace']);
  assert.deepEqual(verify.contract.outputs, ['commandEvidence']);

  const changedContractSkills = defaultSkills.map((skill) => skill.id === 'project.verify'
    ? { ...skill, contract: { version: 2, inputs: skill.contract.inputs, outputs: skill.contract.outputs } }
    : skill);
  const changed = new ToolSkillRegistry({ tools: defaultTools, skills: changedContractSkills });
  assert.notEqual(changed.fingerprint, defaultToolSkillRegistry.fingerprint);
});

test('workspace preparation is an explicit workflow capability', () => {
  const project = configuredProject({
    workspaceStrategy: 'managed',
    skills: {
      allow: ['workspace.prepare', 'project.bootstrap', 'project.verify', 'human.approval'],
      deny: []
    }
  });
  const allowed = defaultToolSkillRegistry.resolve(project, 'workspace.prepare', { surface: 'workflow' });
  assert.equal(allowed.available, true);
  assert.equal(allowed.contract.outputs[0], 'workspaceEvidence');

  const deniedProject = configuredProject({
    workspaceStrategy: 'managed',
    skills: {
      allow: ['workspace.prepare', 'project.bootstrap', 'project.verify', 'human.approval'],
      deny: ['workspace.prepare']
    }
  });
  const denied = defaultToolSkillRegistry.resolve(deniedProject, 'workspace.prepare', { surface: 'workflow' });
  assert.equal(denied.available, false);
  assert.equal(denied.reason, 'skill_not_allowed');
});


test('pre-v0.7 workflow plans without registry fingerprints fail closed', () => {
  const project = configuredProject();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project, goal: 'Legacy workflow state' });
  delete plan.registryFingerprint;
  delete plan.projectSkillPolicyFingerprint;
  assert.throws(() => validateWorkflowPlan(plan, new Map([[project.id, project]])), /registry fingerprint/);
});


test('custom registry can validate project configuration and workflow execution consistently', () => {
  const customTools = [...defaultTools, { id: 'custom-tool', kind: 'executor', binding: 'CustomBinding', surfaces: ['workflow'], risk: 'workspace-read', description: 'test tool' }];
  const customSkills = [...defaultSkills, { id: 'custom.skill', requiresTools: ['custom-tool'], surfaces: ['workflow'], contract: { version: 1, inputs: ['project'], outputs: ['customEvidence'] }, risk: 'workspace-read', description: 'test skill' }];
  const registry = new ToolSkillRegistry({ tools: customTools, skills: customSkills });
  const configured = configFrom({
    id: 'custom-registry-project',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['custom.skill', 'project.verify', 'human.approval'], deny: [] }
  }, process.cwd(), registry);
  assert.deepEqual(configured.skills.allow, ['custom.skill', 'human.approval', 'project.verify']);
  assert.equal(registry.resolve(configured, 'custom.skill', { surface: 'workflow' }).available, true);
});


test('default project policy does not pre-authorize optional or future capabilities', () => {
  const configured = configFrom({
    id: 'least-privilege-default',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' }
  });
  for (const skillId of ['research.web', 'visual.review', 'code.inspect', 'code.diagnose', 'requirements.define', 'data.inspect', 'data.analyze', 'data.summarize']) {
    const resolution = defaultToolSkillRegistry.resolve(configured, skillId, { surface: 'orchestrator' });
    assert.equal(resolution.allowed, false, skillId);
    assert.equal(resolution.available, false, skillId);
    assert.equal(resolution.reason, 'skill_not_allowed', skillId);
  }
});
