import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonStore, WorkflowEngine, WorkflowPublicationBridge, WorkflowStepStatus, configFrom, createWorkflowPlan, evaluateChangePolicy, evaluateDefinitionOfDone, fingerprintChangeSet, humanApprovalDependencyFingerprint, normalizeBusinessBrief, validateWorkflowPlan } from '../src/core.js';

function project() {
  return configFrom({ id: 'workflow-project', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, execution: { provider: 'local-sanitized' } });
}

function businessBrief(overrides = {}) {
  return {
    version: 1,
    businessName: 'Fontanería Ejemplo',
    category: 'Fontanería',
    summary: 'Servicio profesional de fontanería para hogares y negocios.',
    locations: ['Madrid'],
    services: [
      { name: 'Reparación de fugas', description: 'Diagnóstico y reparación de fugas.' },
      { name: 'Desatascos', description: 'Desatascos domésticos y comerciales.' }
    ],
    contact: { phone: '600 000 000', whatsapp: '34600000000', email: 'hola@example.test', address: 'Calle Ejemplo 1' },
    brand: { tone: 'profesional y cercano', primaryColor: '#123456', secondaryColor: '#abcdef' },
    website: { language: 'es', primaryGoal: 'contacto por WhatsApp', requiredPages: ['home', 'servicios', 'contacto'], requiredFeatures: ['CTA WhatsApp'] },
    facts: ['Atención con cita previa.'],
    contentRestrictions: ['No inventar reseñas ni años de experiencia.'],
    assets: {},
    ...overrides
  };
}

function websitePlanFixture(overrides = {}) {
  return {
    summary: 'Web profesional local orientada a conversión.',
    pages: [
      { slug: '/', title: 'Inicio', purpose: 'Presentar negocio y CTA principal.', sections: ['Hero', 'Servicios', 'Confianza', 'Contacto'] },
      { slug: '/servicios', title: 'Servicios', purpose: 'Explicar los servicios facilitados.', sections: ['Listado', 'Proceso', 'CTA'] },
      { slug: '/contacto', title: 'Contacto', purpose: 'Facilitar contacto directo.', sections: ['Datos de contacto', 'CTA WhatsApp'] }
    ],
    design: { direction: 'Limpia, profesional y local.', tone: 'Profesional y cercano', colors: ['#123456', '#abcdef'], typography: 'Sans-serif legible y moderna.' },
    conversion: { primaryCta: 'Contactar por WhatsApp', secondaryCta: 'Llamar ahora' },
    seo: { primaryLocation: 'Madrid', keywords: ['fontanería Madrid', 'reparación de fugas'] },
    implementation: { priorities: ['Mobile first', 'CTAs visibles', 'Accesibilidad'], constraints: ['No inventar hechos del negocio'] },
    missingInputs: [],
    ...overrides
  };
}


function emptyChangeSet() {
  const base = { paths: [], changedFiles: 0, additions: 0, deletions: 0, diffLines: 0, changedBytes: 0, maxFileBytes: 0, sensitiveContent: false, contentFingerprint: '0'.repeat(64) };
  return { ...base, changeSetFingerprint: fingerprintChangeSet(base) };
}

function emptyProtectedIgnoredState() {
  return { paths: [], fingerprint: createHash('sha256').update('[]').digest('hex') };
}

function emptyRepositoryControlState() {
  return { paths: [], fingerprint: createHash('sha256').update('').digest('hex') };
}

function stableLocalGit(overrides = {}) {
  return {
    async inspect(project) {
      return { repository: project.workspace, remote: `https://github.com/${project.repository.owner}/${project.repository.name}.git`, currentBranch: project.defaultBranch, initialHead: 'deadbeef', status: '' };
    },
    async inspectChangeSet() { return emptyChangeSet(); },
    async inspectProtectedIgnoredState() { return emptyProtectedIgnoredState(); },
    async inspectRepositoryControlState() { return emptyRepositoryControlState(); },
    async assertRepositoryState(project, expected = {}) {
      const current = await this.inspect(project);
      if (expected.branch && current.currentBranch !== expected.branch) throw new Error('Unexpected current branch');
      if (expected.head && current.initialHead !== expected.head) throw new Error('Unexpected HEAD');
      if (expected.remote && current.remote !== expected.remote) throw new Error('Unexpected origin remote');
      return current;
    },
    ...overrides
  };
}

async function engine({ runner, projects, workspaceManager, localGit, skillExecutor, codingWorker, publicationBridge, now } = {}) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'agent-workflow-')), 'state.json'));
  const configuredProjects = projects ?? new Map([['workflow-project', project()]]);
  return new WorkflowEngine({ store, projects: configuredProjects, workspaceManager, localGit: localGit ?? stableLocalGit(), skillExecutor, codingWorker, publicationBridge, now, commandRunner: runner ?? (async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'ok', stderr: '' })) });
}

function fixtureEvidenceFingerprint(value) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function completeStep(plan, id) {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown workflow step fixture: ${id}`);
  step.status = WorkflowStepStatus.COMPLETED;
  step.error = null;
  const completedAt = '2026-09-11T00:00:00.000Z';
  const capability = {
    skill: step.skill,
    specialist: step.specialist,
    registryFingerprint: plan.registryFingerprint,
    projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
    specialistRegistryFingerprint: plan.specialistRegistryFingerprint
  };
  if (step.type === 'placeholder' && step.skill === 'code.implement') step.evidence = { ...capability, type: 'executor', ok: true, completedAt, changeSet: emptyChangeSet(), changeSetFingerprint: emptyChangeSet().changeSetFingerprint, changePolicy: { ok: true, classification: 'normal' }, workerEvidence: { status: 'completed' }, repositoryState: { branch: 'main', head: 'deadbeef', remote: 'https://github.com/owner/repo.git' }, protectedIgnoredFingerprint: emptyProtectedIgnoredState().fingerprint, repositoryControlFingerprint: emptyRepositoryControlState().fingerprint };
  else if (step.type === 'placeholder' && step.skill === 'project.dependencies.refresh') {
    const implementation = plan.steps.find((candidate) => candidate.id === 'implementation');
    const dependencyPaths = [...(implementation?.evidence?.changeSet?.paths ?? [])].filter((path) => ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json'].includes(path)).sort();
    step.evidence = {
      ...capability,
      type: 'executor',
      ok: true,
      completedAt,
      required: dependencyPaths.length > 0,
      dependencyPaths,
      changeSetFingerprint: implementation?.evidence?.changeSetFingerprint ?? null,
      ...(dependencyPaths.length ? {
        command: { name: 'dependencyRefresh', ok: true, exitCode: 0, stdout: '', stderr: '' },
        execution: { provider: 'container', stage: 'dependency-refresh', postWorkerNetwork: 'dependency-refresh-network-enabled' },
        lifecycleScripts: 'disabled'
      } : {})
    };
  }
  else if (step.type === 'placeholder' && step.skill === 'code.review') {
    const implementation = plan.steps.find((candidate) => candidate.id === 'implementation');
    step.evidence = { ...capability, type: 'executor', ok: true, completedAt, result: { reviewEvidence: { verdict: 'PASS', summary: 'fixture review passed', findings: [] } }, reviewedChangeSetFingerprint: implementation?.evidence?.changeSetFingerprint ?? null };
  }
  else if (step.type === 'placeholder') step.evidence = { ...capability, type: 'executor', ok: true, completedAt };
  else if (step.type === 'checkpoint') {
    const checkpointEvidence = { ...capability, approvedAt: completedAt };
    if (plan.profile === 'app-improvement' && step.id === 'plan-change') {
      const diagnosisStep = plan.steps.find((candidate) => candidate.id === 'diagnose');
      diagnosisStep.evidence ??= { ...capability, type: 'executor', ok: true, completedAt };
      diagnosisStep.evidence.result ??= {};
      diagnosisStep.evidence.result.diagnosis ??= { summary: 'fixture diagnosis', cause: 'fixture cause' };
      diagnosisStep.evidence.result.diagnosis.recommendedChange ??= 'fixture approved change';
      checkpointEvidence.approvedRecommendedChange = diagnosisStep.evidence.result.diagnosis.recommendedChange;
      checkpointEvidence.approvedDiagnosisFingerprint = fixtureEvidenceFingerprint(diagnosisStep.evidence.result.diagnosis);
    }
    checkpointEvidence.approvedDependencyEvidenceFingerprint = humanApprovalDependencyFingerprint(plan, step.id);
    step.evidence = checkpointEvidence;
  }
  else step.evidence = { ...capability, commands: step.commands.map((name) => ({ name, ok: true, exitCode: 0, stdout: '', stderr: '' })) };
  return step;
}

function managedProject(id, root, { commands = { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' }, budgets, skills, acceptance = { require: ['test'] }, deployment = { provider: 'none' }, pullRequest, execution = { provider: 'local-sanitized' }, toolchain } = {}) {
  return configFrom({
    id, repository: { owner: 'owner', name: `${id}-repo` }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', workspaceStrategy: 'managed', managedWorkspaceRoot: '.managed-workspaces',
    commands, acceptance, deployment, pullRequest, execution, toolchain, budgets, skills
  }, join(root, id, 'config'));
}

class FakeWorkflowWorkspaceManager {
  constructor() { this.prepared = []; }
  describe(project, runId) {
    if (project.workspaceStrategy !== 'managed') return { workspace: project.workspace, managed: false, retained: false };
    return { workspace: resolve(project.managedWorkspaceRoot, project.id, runId), managed: true, retained: true };
  }
  async prepare(project, runId, options = {}) {
    const allocation = this.describe(project, runId);
    this.prepared.push({ projectId: project.id, ...allocation, options });
    return { ...allocation, remoteUrl: `https://github.com/${project.repository.owner}/${project.repository.name}.git` };
  }
}

class FakeWorkflowPublicationBridge {
  constructor({ baseHead = 'a'.repeat(40), commitHead = 'b'.repeat(40), changeSet, ci = { state: 'success', checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], statuses: [], durationMs: 1 }, preview = { provider: 'none', state: 'NOT_REQUIRED', ok: true, durationMs: 0 }, failAt = null, onCommit = null } = {}) {
    Object.assign(this, { baseHead, commitHead, changeSet, ci, preview, failAt, onCommit, calls: [] });
  }
  fail(name) { if (this.failAt === name) throw new Error(`fixture_${name}_failure`); }
  async inspectBase(project) {
    this.calls.push('inspectBase'); this.fail('inspectBase');
    return { provider: 'github', status: 'ok', repository: `${project.repository.owner}/${project.repository.name}`, defaultBranch: project.defaultBranch, head: this.baseHead };
  }
  async commit(_project, context) {
    this.calls.push('commit'); this.fail('commit');
    this.onCommit?.(this.commitHead);
    return { message: 'agent: fixture', finalHead: this.commitHead, committedPaths: [...this.changeSet.paths], committedChangeSetFingerprint: context.changeSetFingerprint };
  }
  async push(_project, context) {
    this.calls.push('push'); this.fail('push');
    return { branch: context.branch, finalHead: context.commitHead };
  }
  async verifyRemoteBranch(_project, branch, expectedHead) {
    this.calls.push('verifyRemoteBranch'); this.fail('verifyRemoteBranch');
    return { branch, head: expectedHead, ok: true };
  }
  async createPullRequest(_project, context) {
    this.calls.push('createPullRequest'); this.fail('createPullRequest');
    return { number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'open', branch: context.branch };
  }
  async verifyPullRequest(project, number, context) {
    this.calls.push('verifyPullRequest'); this.fail('verifyPullRequest');
    return { number, url: 'https://github.com/owner/repo/pull/42', state: 'open', headSha: context.commitHead, headRef: context.branch, baseRef: project.defaultBranch, ok: true };
  }
  async waitForCi() { this.calls.push('waitForCi'); this.fail('waitForCi'); return this.ci; }
  async waitForPreview(_project, context) {
    this.calls.push('waitForPreview'); this.fail('waitForPreview');
    return this.preview.provider === 'none' ? this.preview : { ...this.preview, commitSha: context.commitSha, branch: context.branch };
  }
}


test('business brief normalization is bounded, deterministic, and safe for website workflows', () => {
  const normalized = normalizeBusinessBrief({
    businessName: '  Fontanería Ejemplo  ',
    category: 'Fontanería',
    locations: [' Madrid '],
    services: ['Fugas'],
    contact: {},
    brand: {},
    website: {},
    facts: ['Authorization: Bearer top-secret-token-value'],
    assets: {}
  });
  assert.equal(normalized.businessName, 'Fontanería Ejemplo');
  assert.deepEqual(normalized.services, [{ name: 'Fugas', description: null }]);
  assert.equal(normalized.website.language, 'es');
  assert.equal(normalized.facts[0].includes('top-secret-token-value'), false);
  assert.throws(() => normalizeBusinessBrief({ businessName: 'X', category: 'Y', locations: ['Z'], services: ['S'], unknown: true }), /unknown fields/);
  assert.throws(() => normalizeBusinessBrief({ businessName: 'X', category: 'Y', locations: [], services: ['S'] }), /locations must contain between 1 and 12 items/);
  assert.throws(() => normalizeBusinessBrief({ businessName: 'X', category: 'Y', locations: ['Z'], services: ['S'], assets: { logoPath: '../secret.txt' } }), /relative path/);
});

test('website workflow persists normalized input fingerprint and rejects business brief tampering', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'website-build', project: configured, goal: 'Build business website', input: { businessBrief: businessBrief() } });
  assert.match(plan.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(validateWorkflowPlan(plan, new Map([[configured.id, configured]])).ok, true);
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.input.businessBrief.businessName = 'Otro negocio';
  assert.throws(() => validateWorkflowPlan(tampered, new Map([[configured.id, configured]])), /input fingerprint does not match/);
});

test('workflow profiles create validated deterministic plans', () => {
  for (const profile of ['website-build', 'app-improvement', 'data-analysis']) {
    const configured = project();
    const plan = createWorkflowPlan({
      profile,
      project: configured,
      goal: `Exercise ${profile}`,
      ...(profile === 'website-build' ? { input: { businessBrief: businessBrief() } } : {})
    });
    assert.equal(validateWorkflowPlan(plan, new Map([[configured.id, configured]])).ok, true);
    assert.ok(plan.steps.length > 3);
    assert.ok(plan.definitionOfDone.length > 0);
  }
});

test('website-build refuses to start unless test, typecheck, lint, and build are all configured', () => {
  const configured = configFrom({
    id: 'website-missing-build',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version' },
    execution: { provider: 'local-sanitized' }
  });
  assert.throws(
    () => createWorkflowPlan({
      profile: 'website-build',
      project: configured,
      goal: 'Do not silently skip build',
      input: { businessBrief: businessBrief() }
    }),
    /website-build requires configured quality commands: build/
  );
});

test('website planner fails cleanly when SEO location is not supplied by the business brief', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-context-invalid-'));
  const configured = managedProject('website-context-invalid', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const invalidPlan = websitePlanFixture({ seo: { primaryLocation: 'Barcelona', keywords: ['fontanería Barcelona'] } });
  const skillExecutor = {
    supports: (skill) => skill === 'website.plan',
    async execute() { return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: invalidPlan } }; }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, skillExecutor });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Reject invented local SEO',
    input: { businessBrief: businessBrief({ locations: ['Madrid'] }) }
  });

  const failed = await instance.run(created.id);
  const requirements = failed.steps.find((step) => step.id === 'requirements');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(requirements.status, WorkflowStepStatus.FAILED);
  assert.equal(requirements.error, 'website_plan_context_invalid');
  assert.match(requirements.evidence.error, /primary_location_not_supplied/);
  assert.equal(failed.steps.find((step) => step.id === 'design').status, WorkflowStepStatus.PENDING);
  assert.equal(failed.modelUsage.calls, 1);
  assert.equal(failed.modelUsage.entries[0].status, 'failed');
});

test('website planner verifies repository assets before spending a model call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-assets-'));
  const configured = managedProject('website-assets', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'website.plan',
    async execute(request) {
      calls += 1;
      assert.equal(request.context.businessBrief.businessName, 'Fontanería Ejemplo');
      assert.match(request.context.businessBriefFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(request.context.websiteBlueprint.id, 'home-services');
      assert.match(request.context.websiteBlueprintFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(request.context.assetEvidence.assets.length, 2);
      assert.ok(request.context.assetEvidence.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)));
      return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, skillExecutor });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Build a factual local website',
    input: { businessBrief: businessBrief({ assets: { logoPath: 'public/logo.png', photoPaths: ['public/equipo.jpg'] } }) }
  });
  const workspace = manager.describe(configured, created.id).workspace;
  await mkdir(join(workspace, 'public'), { recursive: true });
  await writeFile(join(workspace, 'public/logo.png'), 'logo-bytes');
  await writeFile(join(workspace, 'public/equipo.jpg'), 'photo-bytes');

  const waiting = await instance.run(created.id);
  const requirements = waiting.steps.find((step) => step.id === 'requirements');
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(requirements.status, WorkflowStepStatus.COMPLETED);
  assert.equal(requirements.evidence.businessBriefFingerprint, waiting.inputFingerprint);
  assert.equal(requirements.evidence.websiteBlueprint.id, 'home-services');
  assert.match(requirements.evidence.websiteBlueprintFingerprint, /^[a-f0-9]{64}$/);
  assert.match(requirements.evidence.assetEvidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(requirements.evidence.websitePlanFingerprint, /^[a-f0-9]{64}$/);

  const tamperedBlueprint = JSON.parse(JSON.stringify(waiting));
  tamperedBlueprint.steps.find((step) => step.id === 'requirements').evidence.websiteBlueprint.id = 'beauty-salon';
  assert.throws(
    () => validateWorkflowPlan(tamperedBlueprint, new Map([[configured.id, configured]])),
    /business brief, blueprint, and verified assets/
  );

  const approved = await instance.approve(created.id, 'design');
  const design = approved.steps.find((step) => step.id === 'design');
  assert.equal(design.evidence.approvedWebsiteBlueprintFingerprint, requirements.evidence.websiteBlueprintFingerprint);
  assert.equal(design.evidence.approvedWebsitePlanFingerprint, requirements.evidence.websitePlanFingerprint);
  assert.equal(calls, 1);
  assert.equal(waiting.modelUsage.calls, 1);
});

test('missing or symlinked website assets fail before the planner model is invoked', async () => {
  for (const kind of ['missing', 'symlink']) {
    const root = await mkdtemp(join(tmpdir(), `agent-website-asset-${kind}-`));
    const configured = managedProject(`website-asset-${kind}`, root, {
      skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval'], deny: [] }
    });
    const manager = new FakeWorkflowWorkspaceManager();
    let calls = 0;
    const skillExecutor = { supports: (skill) => skill === 'website.plan', async execute() { calls += 1; throw new Error('planner must not run'); } };
    const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, skillExecutor });
    const created = await instance.create({
      profile: 'website-build',
      projectId: configured.id,
      goal: 'Reject unsafe asset',
      input: { businessBrief: businessBrief({ assets: { logoPath: 'public/logo.png', photoPaths: [] } }) }
    });
    const workspace = manager.describe(configured, created.id).workspace;
    await mkdir(join(workspace, 'public'), { recursive: true });
    if (kind === 'symlink') {
      await writeFile(join(workspace, 'real-logo.png'), 'logo');
      await symlink(join(workspace, 'real-logo.png'), join(workspace, 'public/logo.png'));
    }

    const failed = await instance.run(created.id);
    const requirements = failed.steps.find((step) => step.id === 'requirements');
    assert.equal(failed.status, WorkflowStepStatus.FAILED);
    assert.equal(requirements.error, 'website_asset_validation_failed');
    assert.equal(calls, 0);
    assert.equal(failed.modelUsage.calls, 0);
  }
});

test('website asset changes after design approval block implementation before Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-asset-stale-'));
  const configured = managedProject('website-asset-stale', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const skillExecutor = {
    supports: (skill) => skill === 'website.plan',
    async execute() { return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } }; }
  };
  let workerCalls = 0;
  const codingWorker = { async execute() { workerCalls += 1; throw new Error('worker must not run for stale assets'); } };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, skillExecutor, codingWorker });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Bind design to assets',
    input: { businessBrief: businessBrief({ assets: { logoPath: 'public/logo.png', photoPaths: [] } }) }
  });
  const workspace = manager.describe(configured, created.id).workspace;
  await mkdir(join(workspace, 'public'), { recursive: true });
  await writeFile(join(workspace, 'public/logo.png'), 'logo-v1');

  const designWait = await instance.run(created.id);
  assert.equal(designWait.status, WorkflowStepStatus.AWAITING_APPROVAL);
  const approved = await instance.approve(created.id, 'design');
  assert.equal(approved.steps.find((step) => step.id === 'design').status, WorkflowStepStatus.COMPLETED);
  await writeFile(join(workspace, 'public/logo.png'), 'logo-v2');

  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.error, 'website_assets_changed_after_plan');
  assert.equal(workerCalls, 0);
  assert.equal(blocked.modelUsage.calls, 1);
});

test('website implementation fails if Codex mutates a previously verified business asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-asset-worker-mutation-'));
  const configured = managedProject('website-asset-worker-mutation', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const skillExecutor = {
    supports: (skill) => skill === 'website.plan',
    async execute() { return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } }; }
  };
  let workerCalls = 0;
  let workspace;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      await writeFile(join(workspace, 'public/logo.png'), 'logo-replaced-by-worker');
      return { status: 'completed', summary: 'implemented website', output: '', outputBytes: 0 };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, skillExecutor, codingWorker });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Do not allow verified asset replacement',
    input: { businessBrief: businessBrief({ assets: { logoPath: 'public/logo.png', photoPaths: [] } }) }
  });
  workspace = manager.describe(configured, created.id).workspace;
  await mkdir(join(workspace, 'public'), { recursive: true });
  await writeFile(join(workspace, 'public/logo.png'), 'logo-original');

  const designWait = await instance.run(created.id);
  assert.equal(designWait.status, WorkflowStepStatus.AWAITING_APPROVAL);
  await instance.approve(created.id, 'design');

  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'website_assets_modified_during_implementation');
  assert.match(implementation.evidence.error, /website_assets_modified_during_implementation/);
  assert.equal(workerCalls, 1);
  assert.equal(failed.modelUsage.calls, 2);
  assert.equal(failed.steps.find((step) => step.id === 'review').status, WorkflowStepStatus.PENDING);
});

test('workflow model usage state is persisted and fails closed on tampering', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Persist model budget' });
  assert.equal(plan.modelUsage.maxCalls, configured.budgets.maxModelCalls);
  assert.equal(plan.modelUsage.calls, 0);
  const missing = JSON.parse(JSON.stringify(plan));
  delete missing.modelUsage;
  assert.throws(() => validateWorkflowPlan(missing, new Map([[configured.id, configured]])), /workflow\.modelUsage is missing/);
  const exceeded = JSON.parse(JSON.stringify(plan));
  exceeded.modelUsage.calls = exceeded.modelUsage.maxCalls + 1;
  exceeded.modelUsage.entries = Array.from({ length: exceeded.modelUsage.calls }, (_, index) => ({
    id: `model-call-${index + 1}`, status: 'started', surface: 'workflow', skill: 'code.inspect', stepId: 'inspect-project', specialist: 'code-inspector', attempt: 1,
    startedAt: '2026-09-11T00:00:00.000Z', completedAt: null, usage: null
  }));
  assert.throws(() => validateWorkflowPlan(exceeded, new Map([[configured.id, configured]])), /calls exceeds maxCalls/);

  const summaryTampered = JSON.parse(JSON.stringify(plan));
  summaryTampered.modelUsage.calls = 1;
  summaryTampered.modelUsage.inputTokens = 999;
  summaryTampered.modelUsage.outputTokens = 1;
  summaryTampered.modelUsage.totalTokens = 1000;
  summaryTampered.modelUsage.entries = [{
    id: 'model-call-1', status: 'completed', surface: 'workflow', skill: 'code.inspect', stepId: 'inspect-project', specialist: 'code-inspector', attempt: 1,
    startedAt: '2026-09-11T00:00:00.000Z', completedAt: '2026-09-11T00:00:01.000Z', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
  }];
  assert.throws(() => validateWorkflowPlan(summaryTampered, new Map([[configured.id, configured]])), /token totals do not match entries/);
});

test('workflow resume fails closed when the configured model-call budget changes', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Freeze workflow model budget' });
  const changed = configFrom({
    id: configured.id,
    repository: configured.repository,
    defaultBranch: configured.defaultBranch,
    protectedBranches: configured.protectedBranches,
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    budgets: { maxModelCalls: configured.budgets.maxModelCalls + 1 },
    skills: configured.skills
  });
  assert.throws(
    () => validateWorkflowPlan(plan, new Map([[changed.id, changed]])),
    /workflow\.modelUsage\.maxCalls does not match the active project budget/
  );
});

test('malformed SDK usage evidence never reduces a consumed workflow model call', async () => {
  const configured = configFrom({
    id: 'malformed-model-usage',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    budgets: { maxModelCalls: 2 },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      return { ok: false, status: 'failed', usage: { input_tokens: -10, output_tokens: 'bad' }, outputBytes: 1, error: 'fixture failure' };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Do not trust malformed usage', budgets: { maxAttempts: 1 } });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.modelUsage.calls, 1);
  assert.equal(failed.modelUsage.totalTokens, 0);
  assert.equal(failed.modelUsage.unknownUsageCalls, 1);
  assert.equal(failed.modelUsage.entries[0].usage, null);
  assert.equal(failed.modelUsage.entries[0].status, 'failed');
});

test('workflow state cannot advance a step before every dependency is completed', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Reject skipped prerequisites' });
  const release = plan.steps.find((step) => step.id === 'release-readiness');
  release.status = WorkflowStepStatus.READY;
  assert.throws(
    () => validateWorkflowPlan(plan, new Map([[configured.id, configured]])),
    /advanced before dependency completed: release-readiness -> verification/
  );

  const running = createWorkflowPlan({ profile: 'data-analysis', project: configured, goal: 'Reject running skip' });
  running.steps.find((step) => step.id === 'analysis').status = WorkflowStepStatus.RUNNING;
  running.status = WorkflowStepStatus.RUNNING;
  assert.throws(
    () => validateWorkflowPlan(running, new Map([[configured.id, configured]])),
    /advanced before dependency completed: analysis -> validate-data/
  );
});

test('workflow validation rejects duplicate ids, missing dependencies, cycles, and budgets', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  plan.steps[1].id = plan.steps[0].id;
  assert.throws(() => validateWorkflowPlan(plan, new Set(['workflow-project'])), /unique/);
  const missing = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  missing.steps[0].dependsOn = ['missing'];
  assert.throws(() => validateWorkflowPlan(missing, new Set(['workflow-project'])), /does not exist/);
  const cycle = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate' });
  cycle.steps[0].dependsOn = [cycle.steps.at(-1).id];
  assert.throws(() => validateWorkflowPlan(cycle, new Set(['workflow-project'])), /cycle/);
  assert.throws(() => createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Validate', budgets: { maxSteps: 1 } }), /maxSteps/);
});

test('reviewed publication prepares and revalidates the exact managed review branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-branch-'));
  const configured = managedProject('publication-branch', root, {
    skills: { allow: ['workspace.prepare', 'release.publish-reviewed-workflow', 'human.approval', 'project.verify'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const baseHead = 'a'.repeat(40);
  let branch = configured.defaultBranch;
  let head = baseHead;
  let prepareCalls = 0;
  const localGit = stableLocalGit({
    async inspect(project) {
      return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' };
    },
    async prepareWorkingBranch(_project, runId, expectedBaseHead) {
      prepareCalls += 1;
      assert.equal(expectedBaseHead, baseHead);
      branch = `agent/${runId}`;
      return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead };
    }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Prepare exact review branch' });

  await instance.workspaceProject(created.id, configured);
  const persisted = await instance.get(created.id);
  assert.equal(prepareCalls, 1);
  assert.equal(persisted.workspace.managed, true);
  assert.equal(persisted.workspace.workingBranch, `agent/${created.id}`);
  assert.equal(persisted.workspace.baseHead, baseHead);
  assert.equal(persisted.workspace.remote, remote);

  await instance.workspaceProject(created.id, configured);
  assert.equal(prepareCalls, 1);

  branch = 'agent/unexpected';
  await assert.rejects(instance.workspaceProject(created.id, configured), /Unexpected current branch/);
});

test('reviewed workflow publication refuses an unmanaged workspace before Git mutation', async () => {
  const configured = configFrom({
    id: 'publication-unmanaged',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['release.publish-reviewed-workflow', 'human.approval', 'project.verify'], deny: [] }
  });
  let gitCalls = 0;
  const localGit = stableLocalGit({
    async inspect() { gitCalls += 1; throw new Error('git should not be touched'); },
    async prepareWorkingBranch() { gitCalls += 1; throw new Error('branch should not be prepared'); }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject unmanaged publication' });
  await assert.rejects(instance.workspaceProject(created.id, configured), /requires a managed workspace/);
  assert.equal(gitCalls, 0);
});

test('workflow placeholders block honestly instead of claiming unimplemented work completed', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Improve safely' });
  const current = await instance.run(created.id);
  const inspect = current.steps.find((step) => step.id === 'inspect-project');
  assert.equal(current.status, WorkflowStepStatus.BLOCKED);
  assert.equal(current.result.error, 'skill_not_allowed');
  assert.equal(inspect.status, WorkflowStepStatus.BLOCKED);
  assert.equal(inspect.error, 'skill_not_allowed');
  assert.equal(evaluateDefinitionOfDone(current).ok, false);
  await assert.rejects(instance.approve(created.id, 'inspect-project'), /not awaiting human approval/);
});

test('workflow dry-run reports executable steps without invoking the command executor', async () => {
  let calls = 0;
  const instance = await engine({ runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Analyze' });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(calls, 0);
  assert.equal(dryRun.specialistRegistryFingerprint.length, 64);
  assert.equal(dryRun.plannedSteps[0].specialist, 'data-inspector');
  assert.equal(dryRun.plannedSteps[0].specialistMode, 'reserved');
  assert.equal(dryRun.plannedSteps[0].specialistAuthority, 'unavailable');
  assert.equal((await instance.get(created.id)).steps[0].status, WorkflowStepStatus.READY);
});

test('app-improvement dry-run discloses future reviewed publication without executing Git or external writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-dry-run-'));
  const configured = managedProject('publication-dry-run', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  let gitCalls = 0;
  const localGit = stableLocalGit({
    async inspect() { gitCalls += 1; throw new Error('dry-run must not touch git'); },
    async prepareWorkingBranch() { gitCalls += 1; throw new Error('dry-run must not create a branch'); }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ changeSet: changedChangeSet(['src/feature.js']) });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: new FakeWorkflowWorkspaceManager(), localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Show full reviewed workflow' });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plannedSteps.length, 10);
  const publication = dryRun.plannedSteps.find((step) => step.id === 'publication');
  assert.equal(publication.skill, 'release.publish-reviewed-workflow');
  assert.equal(publication.specialist, 'release-manager');
  assert.equal(publication.specialistAuthority, 'external-write');
  assert.equal(publication.capability.available, true);
  assert.deepEqual(dryRun.plannedExternalWrites, [{ id: 'publication', skill: 'release.publish-reviewed-workflow', specialist: 'release-manager' }]);
  assert.equal(gitCalls, 0);
  assert.deepEqual(publicationBridge.calls, []);
});

test('website-build dry-run exposes the full governed factory path with zero project or external writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-build-dry-run-'));
  const configured = managedProject('website-build-dry-run', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  let gitCalls = 0;
  let workerCalls = 0;
  let commandCalls = 0;
  const localGit = stableLocalGit({
    async inspect() { gitCalls += 1; throw new Error('website dry-run must not inspect or mutate git'); },
    async prepareWorkingBranch() { gitCalls += 1; throw new Error('website dry-run must not prepare branch'); }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ changeSet: changedChangeSet(['src/app/page.js']) });
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: new FakeWorkflowWorkspaceManager(),
    localGit,
    skillExecutor: { supports: () => true, async execute() { workerCalls += 1; throw new Error('dry-run must not invoke read-only model'); } },
    codingWorker: { async execute() { workerCalls += 1; throw new Error('dry-run must not invoke coding model'); } },
    publicationBridge,
    runner: async () => { commandCalls += 1; throw new Error('dry-run must not execute commands'); }
  });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Preview the website factory plan',
    input: { businessBrief: businessBrief() }
  });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plannedSteps.length, 9);
  assert.deepEqual(dryRun.plannedSteps.map((step) => step.id), [
    'requirements', 'design', 'implementation', 'dependency-refresh', 'review', 'quality', 'release-readiness', 'publication', 'visual-verification'
  ]);
  assert.equal(dryRun.plannedSteps.find((step) => step.id === 'requirements').specialist, 'requirements-engineer');
  assert.equal(dryRun.plannedSteps.find((step) => step.id === 'requirements').specialistAuthority, 'workspace-read');
  assert.equal(dryRun.plannedSteps.find((step) => step.id === 'visual-verification').specialist, 'human-supervisor');
  const publication = dryRun.plannedSteps.find((step) => step.id === 'publication');
  assert.equal(publication.specialist, 'release-manager');
  assert.equal(publication.specialistAuthority, 'external-write');
  assert.deepEqual(dryRun.plannedExternalWrites, [{ id: 'publication', skill: 'release.publish-reviewed-workflow', specialist: 'release-manager' }]);
  assert.equal(gitCalls, 0);
  assert.equal(workerCalls, 0);
  assert.equal(commandCalls, 0);
  assert.deepEqual(publicationBridge.calls, []);
  assert.equal((await instance.get(created.id)).steps[0].status, WorkflowStepStatus.READY);
});

test('read-only workflow retries carry the previous validation error into the next model context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-readonly-retry-feedback-'));
  const configured = managedProject('readonly-retry-feedback', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval'], deny: [] }
  });
  const contexts = [];
  let calls = 0;
  const skillExecutor = {
    supports: () => true,
    async prepareContext() { return null; },
    async execute(request) {
      contexts.push(request.context);
      calls += 1;
      if (calls === 1) {
        return {
          status: 'failed',
          ok: false,
          timedOut: false,
          outputBytes: 0,
          usage: {},
          error: 'websitePlan.implementation.priorities[0] exceeds 240 characters'
        };
      }
      return {
        status: 'completed',
        ok: true,
        timedOut: false,
        outputBytes: 64,
        usage: {},
        result: { websitePlan: websitePlanFixture() }
      };
    }
  };
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: new FakeWorkflowWorkspaceManager(),
    skillExecutor
  });
  const created = await instance.create({
    profile: 'website-build',
    projectId: configured.id,
    goal: 'Plan a valid website',
    input: { businessBrief: businessBrief() },
    budgets: { maxAttempts: 2 }
  });
  const waiting = await instance.run(created.id);
  assert.equal(calls, 2);
  assert.equal(contexts[0].retryFeedback, undefined);
  assert.deepEqual(contexts[0].configuredQualityCommands, {
    test: 'node --version',
    typecheck: 'node --version',
    lint: 'node --version',
    build: 'node --version'
  });
  assert.deepEqual(contexts[1].configuredQualityCommands, contexts[0].configuredQualityCommands);
  assert.deepEqual(contexts[1].retryFeedback, {
    previousAttempt: 1,
    previousError: 'websitePlan.implementation.priorities[0] exceeds 240 characters'
  });
  assert.equal(waiting.steps.find((step) => step.id === 'requirements').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'requirements').attempts, 2);
  assert.equal(waiting.steps.find((step) => step.id === 'design').status, WorkflowStepStatus.AWAITING_APPROVAL);
});

test('workflow limits retries and persists failure evidence', async () => {
  const instance = await engine({ runner: async (project, name) => ({ name, ok: false, exitCode: 1, stdout: '', stderr: `${project.id}:${name}` }) });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Fail safely', budgets: { maxAttempts: 2 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await instance.run(created.id);
  const failed = await instance.get(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.steps.find((step) => step.id === 'validate-data').attempts, 2);
});

test('workflow stops command execution as soon as accumulated output exceeds its budget', async () => {
  const calls = [];
  const instance = await engine({ runner: async (_project, name) => { calls.push(name); return { name, ok: true, exitCode: 0, stdout: 'x'.repeat(2_000), stderr: '' }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Bound output', budgets: { maxOutputBytes: 1_024 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_output_budget_exhausted');
  assert.deepEqual(calls, ['test']);
});

test('release-readiness approval is bound to the exact reviewed implementation fingerprint', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Bind release approval' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSet = changedChangeSet(['src/feature.js']);
    implementation.evidence.changeSetFingerprint = implementation.evidence.changeSet.changeSetFingerprint;
    completeStep(plan, 'dependency-refresh');
  const review = completeStep(plan, 'review');
    review.evidence.reviewedChangeSetFingerprint = implementation.evidence.changeSetFingerprint;
    completeStep(plan, 'tests');
    completeStep(plan, 'verification');
    const release = plan.steps.find((step) => step.id === 'release-readiness');
    release.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.pausedAt = plan.deadlineAt - 1;
  });

  const approved = await instance.approve(created.id, 'release-readiness');
  const implementation = approved.steps.find((step) => step.id === 'implementation');
  const release = approved.steps.find((step) => step.id === 'release-readiness');
  assert.equal(release.status, WorkflowStepStatus.COMPLETED);
  assert.equal(release.evidence.approvedChangeSetFingerprint, implementation.evidence.changeSetFingerprint);
  assert.equal(release.evidence.reviewedChangeSetFingerprint, implementation.evidence.changeSetFingerprint);

  const tampered = JSON.parse(JSON.stringify(approved));
  tampered.steps.find((step) => step.id === 'release-readiness').evidence.approvedChangeSetFingerprint = 'f'.repeat(64);
  assert.throws(
    () => validateWorkflowPlan(tampered, new Map([['workflow-project', project()]])),
    /release-readiness approval is not bound/
  );
});

test('interrupted reviewed publication is non-approvable because external-write state is uncertain', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Do not replay publication writes' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSet = changedChangeSet(['src/feature.js']);
    implementation.evidence.changeSetFingerprint = implementation.evidence.changeSet.changeSetFingerprint;
    completeStep(plan, 'dependency-refresh');
  const review = completeStep(plan, 'review');
    review.evidence.reviewedChangeSetFingerprint = implementation.evidence.changeSetFingerprint;
    completeStep(plan, 'tests');
    completeStep(plan, 'verification');
    const release = completeStep(plan, 'release-readiness');
    release.evidence.approvedChangeSetFingerprint = implementation.evidence.changeSetFingerprint;
    release.evidence.reviewedChangeSetFingerprint = implementation.evidence.changeSetFingerprint;
    const publication = plan.steps.find((step) => step.id === 'publication');
    publication.status = WorkflowStepStatus.RUNNING;
    publication.attempts = 1;
    publication.evidence = {
      type: 'publication-start',
      skill: publication.skill,
      specialist: publication.specialist,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      specialistRegistryFingerprint: plan.specialistRegistryFingerprint
    };
    plan.status = WorkflowStepStatus.RUNNING;
  });

  const blocked = await instance.resume(created.id);
  const publication = blocked.steps.find((step) => step.id === 'publication');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.pausedAt, null);
  assert.equal(publication.error, 'interrupted_publication_state_uncertain');
  await assert.rejects(instance.approve(created.id, 'publication'), /not awaiting human approval/);
});

test('workflow resume blocks an interrupted executable step until a human approves it', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Recover safely' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  await instance.approve(created.id, 'validate-data');
  const resumed = await instance.run(created.id);
  assert.equal(resumed.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.COMPLETED);
  assert.equal(resumed.status, WorkflowStepStatus.BLOCKED);
  assert.equal(resumed.result.error, 'skill_not_allowed');
});

test('Definition of Done and malformed persisted workflow state are enforced', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Validate done' });
  assert.equal(evaluateDefinitionOfDone(created).ok, false);
  await instance.store.mutate((data) => { data.workflows.bad = { id: 'bad', projectId: 'workflow-project', profile: 'data-analysis', budgets: {}, steps: [] }; });
  await assert.rejects(instance.run('bad'), /must contain steps/);
});

test('Definition of Done requires completed steps and never accepts skipped mandatory work', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Strict DoD' });
  for (const step of plan.steps) completeStep(plan, step.id);
  const required = plan.steps.find((step) => step.id === 'validate-data');
  required.status = WorkflowStepStatus.SKIPPED;
  assert.equal(evaluateDefinitionOfDone(plan).ok, false);
  required.status = WorkflowStepStatus.COMPLETED;
  assert.equal(evaluateDefinitionOfDone(plan).ok, true);
});

test('Callflow and LeadFinder workflows bind every command to their selected managed workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-projects-'));
  const callflow = managedProject('callflow', root);
  const leadfinder = managedProject('leadfinder', root);
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[callflow.id, callflow], [leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (boundProject, name) => {
    calls.push({ id: boundProject.id, workspace: boundProject.workspace, name });
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const callflowWorkflow = await instance.create({ profile: 'data-analysis', projectId: 'callflow', goal: 'Isolate Callflow' });
  const leadfinderWorkflow = await instance.create({ profile: 'data-analysis', projectId: 'leadfinder', goal: 'Isolate LeadFinder' });
  await instance.update(callflowWorkflow.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await instance.update(leadfinderWorkflow.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const callflowCompleted = await instance.run(callflowWorkflow.id);
  const leadfinderCompleted = await instance.run(leadfinderWorkflow.id);
  const expectedCallflow = manager.describe(callflow, callflowWorkflow.id).workspace;
  const expectedLeadfinder = manager.describe(leadfinder, leadfinderWorkflow.id).workspace;
  assert.equal(callflowCompleted.workspace.path, expectedCallflow);
  assert.deepEqual(callflowCompleted.workspace.repository, callflow.repository);
  assert.equal(leadfinderCompleted.workspace.path, expectedLeadfinder);
  assert.equal(leadfinderCompleted.workspace.managed, true);
  assert.deepEqual(leadfinderCompleted.workspace.repository, leadfinder.repository);
  assert.ok(calls.length > 0);
  assert.ok(calls.filter((call) => call.id === 'callflow').every((call) => call.workspace === expectedCallflow));
  assert.ok(calls.filter((call) => call.id === 'leadfinder').every((call) => call.workspace === expectedLeadfinder));
  assert.equal(calls.some((call) => call.id === 'callflow' && call.name === 'install'), false);
  assert.notEqual(expectedCallflow, expectedLeadfinder);
  assert.equal(manager.prepared.length, 2);
});

test('workflow rejects persisted workspace escape, cross-project substitution, and managed symlink before commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-escape-'));
  const callflow = managedProject('callflow', root);
  const leadfinder = managedProject('leadfinder', root);
  const projects = new Map([[callflow.id, callflow], [leadfinder.id, leadfinder]]);
  const manager = new FakeWorkflowWorkspaceManager();
  let calls = 0;
  const instance = await engine({ projects, workspaceManager: manager, runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'leadfinder', goal: 'Reject workspace tampering' });
  await instance.update(created.id, (plan) => {
    plan.workspace = { path: manager.describe(callflow, created.id).workspace, managed: true, projectId: leadfinder.id, repository: leadfinder.repository, initializedAt: new Date().toISOString() };
  });
  await assert.rejects(instance.run(created.id), /outside the managed workspace root/);
  await instance.update(created.id, (plan) => { plan.workspace.path = resolve(leadfinder.managedWorkspaceRoot, '..', 'outside'); });
  await assert.rejects(instance.run(created.id), /outside the managed workspace root/);
  await instance.update(created.id, (plan) => {
    plan.workspace = null;
    completeStep(plan, 'inspect-data');
  });
  await mkdir(leadfinder.managedWorkspaceRoot, { recursive: true });
  const external = await mkdtemp(join(tmpdir(), 'agent-workflow-external-'));
  await symlink(external, join(leadfinder.managedWorkspaceRoot, leadfinder.id), 'junction');
  await assert.rejects(instance.run(created.id), /cannot contain a symlink/);
  assert.equal(calls, 0);
});

test('workflow fails closed when persisted state introduces arbitrary commands or invalid fields', async () => {
  let calls = 0;
  const instance = await engine({ runner: async () => { calls += 1; return { ok: true }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Reject corruption' });
  await instance.update(created.id, (plan) => { plan.steps.find((step) => step.id === 'validate-data').commands = ['curl']; });
  await assert.rejects(instance.run(created.id), /not allowlisted/);
  await instance.update(created.id, (plan) => { plan.steps.find((step) => step.id === 'validate-data').commands = ['test', 'typecheck', 'lint', 'build']; plan.outputBytes = -1; });
  await assert.rejects(instance.run(created.id), /outputBytes/);
  assert.equal(calls, 0);
});

test('workflow global deadline is enforced before start, between steps, between commands, and retries', async () => {
  let clock = 0;
  let calls = 0;
  const expired = await engine({ now: () => clock, runner: async () => { calls += 1; return { ok: true }; } });
  const expiredPlan = await expired.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Expired', budgets: { timeoutMs: 1_000 } });
  clock = 1_000;
  assert.equal((await expired.run(expiredPlan.id)).result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(calls, 0);

  clock = 0;
  const betweenSteps = await engine({ now: () => clock, runner: async (_project, name) => { calls += 1; clock = 1_000; return { name, ok: true, stdout: '', stderr: '' }; } });
  const stepPlan = await betweenSteps.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Between steps', budgets: { timeoutMs: 1_000 } });
  await betweenSteps.update(stepPlan.id, (plan) => { completeStep(plan, 'inspect-data'); });
  assert.equal((await betweenSteps.run(stepPlan.id)).result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(calls, 1);

  clock = 0;
  const commandTimeouts = [];
  const betweenCommands = await engine({ now: () => clock, runner: async (_project, name, options) => { calls += 1; commandTimeouts.push(options.timeoutMs); clock = 1_000; return { name, ok: false, stdout: '', stderr: '' }; } });
  const commandPlan = await betweenCommands.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Between commands', budgets: { timeoutMs: 1_000, maxAttempts: 2 } });
  await betweenCommands.update(commandPlan.id, (plan) => {
    for (const id of ['inspect-project', 'diagnose', 'plan-change', 'implementation', 'dependency-refresh', 'review', 'tests']) completeStep(plan, id);
  });
  const deadlineFailed = await betweenCommands.run(commandPlan.id);
  assert.equal(deadlineFailed.result.error, 'workflow_budget_deadline_exceeded');
  assert.equal(commandTimeouts.at(-1), 1_000);
  assert.equal(calls, 2);
  assert.equal(deadlineFailed.steps.find((step) => step.id === 'verification').attempts, 1);
});

test('crash and resume preserve a managed workspace and never repeat completed steps before approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-resume-'));
  const leadfinder = managedProject('leadfinder', root);
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (boundProject, name) => {
    calls.push({ workspace: boundProject.workspace, name });
    return { name, ok: true, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Resume safely' });
  const expectedWorkspace = (await instance.workspaceProject(created.id, leadfinder)).workspace;
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  assert.equal(calls.length, 0);
  await instance.approve(created.id, 'validate-data');
  const resumed = await instance.run(created.id);
  assert.equal(resumed.steps.find((step) => step.id === 'inspect-data').status, WorkflowStepStatus.COMPLETED);
  assert.equal(resumed.workspace.path, expectedWorkspace);
  assert.equal(manager.prepared.length, 1);
  assert.ok(calls.length > 0 && calls.every((call) => call.workspace === expectedWorkspace));
});

test('a new LeadFinder-like workspace bootstraps once before its verification commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const order = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name, options) => {
    order.push(`${options.stage}:${name}`);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bootstrap dependencies' });
  const dryRun = await instance.run(created.id, { dryRun: true });
  assert.equal(dryRun.plannedBootstrap, 'install');
  assert.equal(manager.prepared.length, 0);
  assert.deepEqual(order, []);
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const completed = await instance.run(created.id);
  assert.deepEqual(order, ['bootstrap:install', 'post-worker:test']);
  assert.equal(order.filter((entry) => entry === 'bootstrap:install').length, 1);
  assert.equal(manager.prepared.length, 1);
  assert.equal(completed.bootstrap.status, 'completed');
  assert.equal(completed.bootstrap.workspacePath, completed.workspace.path);
  await instance.resume(created.id);
  assert.equal(order.filter((entry) => entry === 'bootstrap:install').length, 1);
});

test('bootstrap failure or output exhaustion stops managed workflow verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-failure-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build' } });
  const attempts = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => {
    attempts.push(name);
    return { name, ok: name !== 'install', exitCode: name === 'install' ? 1 : 0, stdout: '', stderr: 'install failed' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Stop on install failure' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'workflow_bootstrap_failed');
  assert.deepEqual(attempts, ['install']);

  const exhausted = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => ({ name, ok: true, exitCode: 0, stdout: 'x'.repeat(2_000), stderr: '' }) });
  const outputPlan = await exhausted.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound install output', budgets: { maxOutputBytes: 1_024 } });
  await exhausted.update(outputPlan.id, (plan) => { completeStep(plan, 'inspect-data'); });
  assert.equal((await exhausted.run(outputPlan.id)).result.error, 'workflow_output_budget_exhausted');
});

test('bootstrap respects the global deadline and uses only remaining command time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-deadline-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' }, budgets: { commandTimeoutMs: 120_000 } });
  let clock = 0;
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), now: () => clock, runner: async (_project, name, options) => {
    calls.push({ name, timeoutMs: options.timeoutMs, stage: options.stage });
    clock = 1_000;
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound install time', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  clock = 300;
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'workflow_budget_deadline_exceeded');
  assert.deepEqual(calls, [{ name: 'install', timeoutMs: 700, stage: 'bootstrap' }]);
});

test('bootstrap state tampering and crash resume fail closed without reinstalling a completed workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-resume-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name) => {
    calls.push(name);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Resume bootstrap safely' });
  const workspaceProject = await instance.workspaceProject(created.id, leadfinder);
  await instance.bootstrapWorkspace(created.id, leadfinder, workspaceProject);
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.steps.find((step) => step.id === 'validate-data').status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  assert.deepEqual(calls, ['install']);
  await instance.approve(created.id, 'validate-data');
  await instance.run(created.id);
  assert.equal(calls.filter((name) => name === 'install').length, 1);
  assert.equal(manager.prepared.length, 1);

  const callsBeforeTampering = calls.length;
  const falseCompleted = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject false bootstrap' });
  await instance.update(falseCompleted.id, (plan) => { plan.bootstrap.status = 'completed'; });
  await assert.rejects(instance.run(falseCompleted.id), /completion evidence is invalid/);
  const arbitraryCommand = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject bootstrap command' });
  await instance.update(arbitraryCommand.id, (plan) => { plan.bootstrap.command = 'curl'; });
  await assert.rejects(instance.run(arbitraryCommand.id), /bootstrap state is invalid/);
  const otherProject = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject foreign bootstrap' });
  await instance.update(otherProject.id, (plan) => { plan.bootstrap.projectId = 'callflow'; });
  await assert.rejects(instance.run(otherProject.id), /bootstrap project is invalid/);
  const otherWorkspace = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Reject foreign workspace bootstrap' });
  await instance.workspaceProject(otherWorkspace.id, leadfinder);
  await instance.update(otherWorkspace.id, (plan) => { plan.bootstrap.workspacePath = `${plan.workspace.path}-other`; });
  await assert.rejects(instance.run(otherWorkspace.id), /bootstrap does not match its workspace/);
  assert.equal(calls.length, callsBeforeTampering);
});

test('an interrupted bootstrap is never treated as completed and is retried only after resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-interrupted-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const manager = new FakeWorkflowWorkspaceManager();
  const calls = [];
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, runner: async (_project, name) => {
    calls.push(name);
    return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Recover interrupted install' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const workspaceProject = await instance.workspaceProject(created.id, leadfinder);
  await instance.update(created.id, (plan) => {
    plan.bootstrap.status = 'running';
    plan.bootstrap.workspacePath = workspaceProject.workspace;
    plan.bootstrap.attempts = 1;
  });
  const resumed = await instance.resume(created.id);
  assert.equal(resumed.bootstrap.status, 'completed');
  assert.equal(resumed.bootstrap.attempts, 2);
  assert.equal(calls.filter((name) => name === 'install').length, 1);
  assert.equal(manager.prepared.length, 1);
});

test('workflow persists only bounded masked bootstrap and verification output while budgeting real bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-masked-output-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const bootstrapSecret = 'SUPER_SECRET_TOKEN_123456789';
  const verificationSecret = 'VERIFICATION_SECRET_TOKEN_987654321';
  const largeBootstrapOutput = `Authorization: Bearer ${bootstrapSecret}\n${'x'.repeat(2_000)}`;
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager(), runner: async (_project, name) => ({
    name, ok: true, exitCode: 0,
    stdout: name === 'install' ? largeBootstrapOutput : '',
    stderr: name === 'test' ? `Authorization: Bearer ${verificationSecret}` : ''
  }) });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Mask workflow output', budgets: { maxOutputBytes: 8_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const completed = await instance.run(created.id);
  const persisted = JSON.stringify(await instance.get(created.id));
  const bootstrapEvidence = completed.bootstrap.evidence;
  const verificationEvidence = completed.steps.find((step) => step.id === 'validate-data').evidence.commands.find((command) => command.name === 'test');
  assert.equal(persisted.includes(bootstrapSecret), false);
  assert.equal(persisted.includes(verificationSecret), false);
  assert.match(bootstrapEvidence.stdout, /\[REDACTED\]/);
  assert.match(verificationEvidence.stderr, /\[REDACTED\]/);
  assert.ok(bootstrapEvidence.stdout.length <= 1_000);
  assert.ok(completed.outputBytes >= Buffer.byteLength(largeBootstrapOutput));
});


test('human checkpoint wait time pauses the workflow execution deadline', async () => {
  let clock = 0;
  const instance = await engine({ now: () => clock });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Pause while waiting', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    const diagnosis = completeStep(plan, 'diagnose');
    diagnosis.evidence.result = {
      diagnosis: {
        summary: 'fixture diagnosis',
        cause: 'fixture cause',
        relevantPaths: ['src/core.js'],
        recommendedChange: 'fixture approved change',
        risks: []
      }
    };
  });
  clock = 200;
  const waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.pausedAt, 200);
  const originalDeadline = waiting.deadlineAt;
  clock = 10_200;
  const stillWaiting = await instance.run(created.id);
  assert.equal(stillWaiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  await instance.approve(created.id, 'plan-change');
  const approved = await instance.get(created.id);
  assert.equal(approved.pausedAt, null);
  assert.equal(approved.deadlineAt, originalDeadline + 10_000);
  assert.ok(approved.deadlineAt > clock);
});

test('managed workspace clone receives only the workflow remaining time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-clone-deadline-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { test: 'pnpm test' }, budgets: { commandTimeoutMs: 120_000 } });
  let clock = 0;
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, now: () => clock });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound clone time', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  clock = 300;
  await instance.run(created.id);
  assert.equal(manager.prepared.length, 1);
  assert.equal(manager.prepared[0].options.timeoutMs, 700);
});

test('bootstrap attempt budget prevents unlimited retry after repeated interrupted installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-attempts-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' } });
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: new FakeWorkflowWorkspaceManager() });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Bound bootstrap attempts', budgets: { maxAttempts: 2 } });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-data');
    plan.bootstrap.status = 'pending';
    plan.bootstrap.attempts = 2;
  });
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_bootstrap_attempt_budget_exhausted');
});


test('verification steps use profile-specific command sets instead of repeating the full suite', () => {
  const app = createWorkflowPlan({ profile: 'app-improvement', project: project(), goal: 'Map checks' });
  assert.deepEqual(app.steps.find((step) => step.id === 'tests').commands, ['test']);
  assert.deepEqual(app.steps.find((step) => step.id === 'verification').commands, ['typecheck', 'lint', 'build']);
  const website = createWorkflowPlan({ profile: 'website-build', project: project(), goal: 'Map checks', input: { businessBrief: businessBrief() } });
  assert.deepEqual(website.steps.find((step) => step.id === 'quality').commands, ['test', 'typecheck', 'lint', 'build']);
  assert.deepEqual(website.steps.find((step) => step.id === 'release-readiness').commands, []);
});

test('terminal workflows do not execute again', async () => {
  let calls = 0;
  const instance = await engine({ runner: async (_project, name) => { calls += 1; return { name, ok: true, stdout: '', stderr: '' }; } });
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Stay terminal' });
  await instance.update(created.id, (plan) => {
    plan.status = WorkflowStepStatus.FAILED;
    plan.result = { error: 'fixture_failure' };
  });
  const failed = await instance.run(created.id);
  assert.equal(failed.result.error, 'fixture_failure');
  assert.equal(calls, 0);
});

test('workflow state validation ties checkpoint pause state to awaiting approval', () => {
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: project(), goal: 'Validate pause state', nowMs: 100 });
  for (const id of ['inspect-project', 'diagnose']) completeStep(plan, id);
  const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
  checkpoint.status = WorkflowStepStatus.AWAITING_APPROVAL;
  plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
  assert.throws(() => validateWorkflowPlan(plan, new Map([['workflow-project', project()]])), /paused checkpoint/);
  plan.pausedAt = 150;
  assert.equal(validateWorkflowPlan(plan, new Map([['workflow-project', project()]])).ok, true);
});


test('workspace clone timeout is distinct from exhausting the global workflow deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-clone-timeout-'));
  const leadfinder = managedProject('leadfinder', root, { commands: { test: 'pnpm test' }, budgets: { commandTimeoutMs: 200 } });
  const manager = new FakeWorkflowWorkspaceManager();
  manager.prepare = async () => {
    const error = new Error('workspace_clone_timeout');
    error.code = 'WORKSPACE_CLONE_TIMEOUT';
    throw error;
  };
  const instance = await engine({ projects: new Map([[leadfinder.id, leadfinder]]), workspaceManager: manager, now: () => 100 });
  const created = await instance.create({ profile: 'data-analysis', projectId: leadfinder.id, goal: 'Distinguish clone timeout', budgets: { timeoutMs: 1_000 } });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  await assert.rejects(instance.run(created.id), /workspace_clone_timeout/);
  const failed = await instance.get(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workspace_clone_timeout');
});


test('workflow approval cannot bypass non-human capability blocks', async () => {
  const limited = configFrom({ id: 'limited', repository: { owner: 'owner', name: 'limited' }, defaultBranch: 'main', protectedBranches: ['main'], workspace: '.', commands: { lint: 'node --version' }, execution: { provider: 'local-sanitized' } });
  const instance = await engine({ projects: new Map([[limited.id, limited]]) });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Require a configured validator' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.result.error, 'verification_command_not_configured');
  assert.equal(blocked.steps.find((step) => step.id === 'validate-data').status, WorkflowStepStatus.BLOCKED);
  await assert.rejects(instance.approve(created.id, 'validate-data'), /not awaiting human approval/);
});


test('persisted completed steps require type-appropriate evidence', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'data-analysis', projectId: 'workflow-project', goal: 'Reject forged completion' });
  await instance.update(created.id, (plan) => {
    for (const step of plan.steps) {
      step.status = WorkflowStepStatus.COMPLETED;
      step.error = null;
      step.evidence = null;
    }
    plan.status = WorkflowStepStatus.PENDING;
  });
  await assert.rejects(instance.run(created.id), /evidence/);
});


test('managed workflow denies workspace preparation before clone when capability is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-workspace-capability-'));
  const limited = managedProject('limited-workspace', root, {
    skills: {
      allow: ['project.verify', 'human.approval'],
      deny: []
    }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[limited.id, limited]]), workspaceManager: manager });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Do not clone' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.result.error, 'skill_not_allowed');
  assert.equal(blocked.result.skill, 'workspace.prepare');
  assert.equal(manager.prepared.length, 0);
});

test('managed workflow denies bootstrap before clone when install capability is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-bootstrap-capability-'));
  const limited = managedProject('limited-bootstrap', root, {
    commands: { install: 'node --version', test: 'node --version' },
    skills: {
      allow: ['workspace.prepare', 'project.verify', 'human.approval'],
      deny: []
    }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const instance = await engine({ projects: new Map([[limited.id, limited]]), workspaceManager: manager });
  const created = await instance.create({ profile: 'data-analysis', projectId: limited.id, goal: 'Do not install' });
  await instance.update(created.id, (plan) => { completeStep(plan, 'inspect-data'); });
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.result.error, 'skill_not_allowed');
  assert.equal(blocked.result.skill, 'project.bootstrap');
  assert.equal(manager.prepared.length, 0);
});


test('completed workflow evidence cannot be replayed under a different skill or capability fingerprint', () => {
  const plan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Bind evidence context' });
  const step = completeStep(plan, 'inspect-data');
  step.evidence.skill = 'project.verify';
  assert.throws(() => validateWorkflowPlan(plan, new Map([['workflow-project', project()]])), /capability context/);

  const fingerprintPlan = createWorkflowPlan({ profile: 'data-analysis', project: project(), goal: 'Bind evidence fingerprint' });
  const fingerprintStep = completeStep(fingerprintPlan, 'inspect-data');
  fingerprintStep.evidence.registryFingerprint = '0'.repeat(64);
  assert.throws(() => validateWorkflowPlan(fingerprintPlan, new Map([['workflow-project', project()]])), /capability context/);
});


test('stale capability context blocks workflow approval and resume before mutation', async () => {
  const instance = await engine();
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Freeze capability context' });
  await instance.update(created.id, (plan) => {
    for (const id of ['inspect-project', 'diagnose']) completeStep(plan, id);
    const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
    checkpoint.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.status = WorkflowStepStatus.AWAITING_APPROVAL;
    plan.pausedAt = plan.deadlineAt - plan.budgets.timeoutMs + 1;
  });
  const beforeApproval = await instance.get(created.id);
  const originalRegistryFingerprint = beforeApproval.registryFingerprint;
  const originalPausedAt = beforeApproval.pausedAt;
  await instance.update(created.id, (plan) => { plan.registryFingerprint = '0'.repeat(64); });
  await assert.rejects(instance.approve(created.id, 'plan-change'), /registry fingerprint/);
  const afterApproval = await instance.get(created.id);
  assert.equal(afterApproval.steps.find((step) => step.id === 'plan-change').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(afterApproval.pausedAt, originalPausedAt);

  await instance.update(created.id, (plan) => {
    plan.registryFingerprint = originalRegistryFingerprint;
    const checkpoint = plan.steps.find((step) => step.id === 'plan-change');
    checkpoint.status = WorkflowStepStatus.COMPLETED;
    checkpoint.evidence = {
      skill: checkpoint.skill,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      approvedAt: '2026-09-11T00:00:00.000Z'
    };
    const implementation = plan.steps.find((step) => step.id === 'implementation');
    implementation.status = WorkflowStepStatus.RUNNING;
    plan.status = WorkflowStepStatus.RUNNING;
    plan.pausedAt = null;
  });
  const beforeResume = await instance.get(created.id);
  const originalPolicyFingerprint = beforeResume.projectSkillPolicyFingerprint;
  await instance.update(created.id, (plan) => { plan.projectSkillPolicyFingerprint = 'f'.repeat(64); });
  await assert.rejects(instance.resume(created.id), /project skill policy fingerprint/);
  const afterResume = await instance.get(created.id);
  assert.equal(afterResume.steps.find((step) => step.id === 'implementation').status, WorkflowStepStatus.RUNNING);
  assert.equal(afterResume.status, WorkflowStepStatus.RUNNING);
  assert.notEqual(afterResume.projectSkillPolicyFingerprint, originalPolicyFingerprint);
});


test('app-improvement executes read-only inspection and diagnosis in one run before the human checkpoint', async () => {
  const configured = configFrom({
    id: 'readonly-app',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: {
      allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'],
      deny: []
    }
  });
  const calls = [];
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async execute(request) {
      calls.push(request);
      if (request.skill === 'code.inspect') {
        return { ok: true, status: 'completed', outputBytes: 120, codexThreadId: 'inspect-thread', result: { inspectionEvidence: { summary: 'inspected', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
      }
      return { ok: true, status: 'completed', outputBytes: 100, codexThreadId: 'diagnose-thread', result: { diagnosis: { summary: 'diagnosed', cause: 'fixture', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Improve one app behavior' });
  const waiting = await instance.run(created.id);

  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.steps.find((step) => step.id === 'inspect-project').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'diagnose').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'plan-change').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].contract.outputs, ['inspectionEvidence']);
  assert.deepEqual(calls[1].contract.outputs, ['diagnosis']);
  assert.equal(calls[1].context.priorEvidence['inspect-project'].inspectionEvidence.summary, 'inspected');
  assert.equal(waiting.outputBytes, 220);
  assert.equal(waiting.steps.find((step) => step.id === 'inspect-project').evidence.codexThreadId, 'inspect-thread');
  assert.equal(waiting.steps.find((step) => step.id === 'diagnose').evidence.codexThreadId, 'diagnose-thread');

  const approved = await instance.approve(created.id, 'plan-change');
  const checkpoint = approved.steps.find((step) => step.id === 'plan-change');
  assert.equal(checkpoint.evidence.approvedRecommendedChange, 'fixture change');
  assert.match(checkpoint.evidence.approvedDiagnosisFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(instance.completedContext(approved)['plan-change'].recommendedChange, 'fixture change');
  assert.equal(
    instance.completedContext(approved)['plan-change'].approvedDependencyEvidenceFingerprint,
    checkpoint.evidence.approvedDependencyEvidenceFingerprint
  );
});

test('workflow fails closed if orchestrator repository context drifts during analysis', async () => {
  const configured = configFrom({
    id: 'context-drift', repository: { owner: 'owner', name: 'repo' }, defaultBranch: 'main',
    protectedBranches: ['main'], workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  const content = 'export const fixture = true;\n';
  const file = { path: 'src/core.js', content, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
  const repositoryContext = { version: 1, files: [file], fingerprint: createHash('sha256').update(JSON.stringify([{ path: file.path, sha256: file.sha256, bytes: file.bytes }])).digest('hex') };
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async prepareContext() { return repositoryContext; },
    async revalidateContext() { throw new Error('repository_context_changed_during_analysis'); },
    async execute(request) {
      calls += 1;
      assert.equal(request.context.repositoryContext.fingerprint, repositoryContext.fingerprint);
      return { ok: true, status: 'completed', outputBytes: 20, result: { inspectionEvidence: { summary: 'grounded', relevantPaths: ['src/core.js'], findings: ['fixture'] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'reject drift', scope: { allowedPaths: ['src/core.js'], forbiddenPaths: [] } });
  const failed = await instance.run(created.id);
  const inspect = failed.steps.find((step) => step.id === 'inspect-project');
  assert.equal(failed.result.error, 'read_only_repository_context_changed');
  assert.equal(inspect.status, WorkflowStepStatus.FAILED);
  assert.match(inspect.evidence.error, /repository_context_changed_during_analysis/);
  assert.notEqual(failed.steps.find((step) => step.id === 'plan-change').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(calls, 1);
});

test('workflow model-call budget stops before invoking another specialist', async () => {
  const configured = configFrom({
    id: 'model-budget-workflow',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    budgets: { maxModelCalls: 1 },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async execute(request) {
      calls += 1;
      if (request.skill === 'code.inspect') return { ok: true, status: 'completed', usage: { input_tokens: 10, output_tokens: 4 }, outputBytes: 10, result: { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
      return { ok: true, status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, outputBytes: 10, result: { diagnosis: { summary: 'fixture', cause: 'fixture cause', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Bound model calls' });
  const failed = await instance.run(created.id);

  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'workflow_model_call_budget_exhausted');
  assert.equal(failed.result.stepId, 'diagnose');
  assert.equal(calls, 1);
  assert.equal(failed.modelUsage.calls, 1);
  assert.equal(failed.modelUsage.maxCalls, 1);
  assert.equal(failed.modelUsage.inputTokens, 10);
  assert.equal(failed.modelUsage.outputTokens, 4);
  assert.equal(failed.modelUsage.totalTokens, 14);
  assert.equal(failed.modelUsage.entries[0].specialist, 'code-inspector');
  assert.equal(failed.modelUsage.entries[0].status, 'completed');
});

test('deterministic diagnose does not consume model budget and approval remains fingerprint-bound', async () => {
  const configured = configFrom({
    id: 'deterministic-diagnose-workflow',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    budgets: { maxModelCalls: 6 },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  const goal = 'Apply the bounded deterministic diagnosis change';
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    usesModel: (skill) => skill !== 'code.diagnose',
    async execute(request) {
      if (request.skill === 'code.inspect') {
        return {
          ok: true,
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
          outputBytes: 10,
          result: {
            inspectionEvidence: {
              summary: 'The requested change is isolated to src/core.js.',
              relevantPaths: ['src/core.js'],
              findings: ['The current workflow has a separate diagnosis stage after validated inspection.']
            }
          }
        };
      }
      assert.equal(request.skill, 'code.diagnose');
      const inspection = request.context.priorEvidence['inspect-project'].inspectionEvidence;
      const pathBinding = inspection.relevantPaths.join(', ');
      return {
        ok: true,
        status: 'completed',
        usage: null,
        outputBytes: 10,
        executionMode: 'deterministic',
        result: {
          diagnosis: {
            summary: 'Deterministic diagnosis from validated inspection',
            cause: inspection.findings.join(' | '),
            relevantPaths: [...inspection.relevantPaths],
            recommendedChange: `Apply the authorized goal only within validated inspected paths [${pathBinding}]: ${request.goal}`,
            risks: [
              `Scope drift: implementation must remain within validated inspected paths [${pathBinding}] and the request scope.`,
              'Governance drift: preserve existing approval, review, verification, publication, secret, merge, and deployment gates.'
            ]
          }
        }
      };
    }
  };

  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal });
  const waiting = await instance.run(created.id);
  const inspect = waiting.steps.find((step) => step.id === 'inspect-project');
  const diagnose = waiting.steps.find((step) => step.id === 'diagnose');
  const checkpoint = waiting.steps.find((step) => step.id === 'plan-change');

  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(inspect.status, WorkflowStepStatus.COMPLETED);
  assert.equal(diagnose.status, WorkflowStepStatus.COMPLETED);
  assert.equal(diagnose.attempts, 1);
  assert.match(diagnose.evidence.result.diagnosis.recommendedChange, /validated inspected paths \[src\/core\.js\]/);
  assert.match(diagnose.evidence.result.diagnosis.recommendedChange, new RegExp(goal));
  assert.deepEqual(diagnose.evidence.result.diagnosis.relevantPaths, ['src/core.js']);
  assert.equal(diagnose.evidence.result.diagnosis.risks.length, 2);
  assert.equal(waiting.modelUsage.calls, 1);
  assert.equal(waiting.modelUsage.inputTokens, 10);
  assert.equal(waiting.modelUsage.outputTokens, 5);
  assert.equal(waiting.modelUsage.totalTokens, 15);
  assert.deepEqual(waiting.modelUsage.entries.map((entry) => [entry.skill, entry.specialist, entry.status]), [
    ['code.inspect', 'code-inspector', 'completed']
  ]);
  assert.equal(checkpoint.status, WorkflowStepStatus.AWAITING_APPROVAL);

  const diagnosisFingerprint = fixtureEvidenceFingerprint(diagnose.evidence.result.diagnosis);
  const approved = await instance.approve(created.id, 'plan-change');
  const approvedCheckpoint = approved.steps.find((step) => step.id === 'plan-change');
  assert.equal(approvedCheckpoint.status, WorkflowStepStatus.COMPLETED);
  assert.equal(
    approvedCheckpoint.evidence.approvedRecommendedChange,
    diagnose.evidence.result.diagnosis.recommendedChange
  );
  assert.notEqual(approvedCheckpoint.evidence.approvedRecommendedChange, goal);
  assert.equal(approvedCheckpoint.evidence.approvedDiagnosisFingerprint, diagnosisFingerprint);
  assert.equal(approved.modelUsage.calls, 1);
});

test('workflow model usage is attributed across read-only specialists', async () => {
  const configured = configFrom({
    id: 'model-usage-workflow',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    budgets: { maxModelCalls: 6 },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async execute(request) {
      if (request.skill === 'code.inspect') return { ok: true, status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, outputBytes: 10, result: { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
      return { ok: true, status: 'completed', usage: { input_tokens: 7, output_tokens: 3 }, outputBytes: 10, result: { diagnosis: { summary: 'fixture', cause: 'fixture cause', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Attribute model usage' });
  const waiting = await instance.run(created.id);

  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.modelUsage.calls, 2);
  assert.equal(waiting.modelUsage.inputTokens, 17);
  assert.equal(waiting.modelUsage.outputTokens, 8);
  assert.equal(waiting.modelUsage.totalTokens, 25);
  assert.equal(waiting.modelUsage.unknownUsageCalls, 0);
  assert.deepEqual(waiting.modelUsage.entries.map((entry) => [entry.skill, entry.specialist, entry.status]), [
    ['code.inspect', 'code-inspector', 'completed'],
    ['code.diagnose', 'diagnostician', 'completed']
  ]);
});

test('workflow rejects superficially successful but ungrounded inspect evidence before any human checkpoint', async () => {
  const configured = configFrom({
    id: 'ungrounded-readonly',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => ['code.inspect', 'code.diagnose'].includes(skill),
    async execute(request) {
      calls += 1;
      if (request.skill !== 'code.inspect') throw new Error('diagnose must not run after ungrounded inspection');
      return {
        ok: true,
        status: 'completed',
        outputBytes: 20,
        result: {
          inspectionEvidence: {
            status: 'blocked',
            filesInspected: [],
            findings: [],
            limitations: ['repository listing blocked'],
            goalAssessment: 'unable to inspect'
          }
        }
      };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Ground inspection', budgets: { maxAttempts: 2 } });
  const failed = await instance.run(created.id);
  const inspect = failed.steps.find((step) => step.id === 'inspect-project');
  const checkpoint = failed.steps.find((step) => step.id === 'plan-change');

  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.result.error, 'skill_executor_attempt_budget_exhausted');
  assert.equal(failed.result.stepId, 'inspect-project');
  assert.equal(inspect.attempts, 2);
  assert.match(inspect.evidence.error, /inspectionEvidence contains unknown fields/);
  assert.notEqual(checkpoint.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(calls, 2);
});

test('read-only hard billing failure blocks after one model call without retrying', async () => {
  const configured = configFrom({
    id: 'readonly-hard-billing',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      calls += 1;
      return {
        ok: false,
        status: 'failed',
        timedOut: false,
        outputBytes: 0,
        error: 'stream disconnected before completion: You have no credits remaining. Add credits to continue using the API.'
      };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: configured.id,
    goal: 'Block hard billing failure',
    budgets: { maxAttempts: 2 }
  });
  const blocked = await instance.run(created.id);
  const step = blocked.steps.find((item) => item.id === 'inspect-project');

  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(step.status, WorkflowStepStatus.BLOCKED);
  assert.equal(step.attempts, 1);
  assert.equal(step.error, 'model_billing_unavailable');
  assert.equal(blocked.result.error, 'model_billing_unavailable');
  assert.equal(calls, 1);
  assert.equal(blocked.modelUsage.calls, 1);
  assert.equal(blocked.modelUsage.entries[0].status, 'failed');
});

test('read-only transient model failure remains retryable within the configured attempt budget', async () => {
  const configured = configFrom({
    id: 'readonly-transient-model',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      calls += 1;
      return {
        ok: false,
        status: 'failed',
        timedOut: false,
        outputBytes: 0,
        error: 'rate limit exceeded, retry later'
      };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: configured.id,
    goal: 'Retry transient failure',
    budgets: { maxAttempts: 2 }
  });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');

  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.status, WorkflowStepStatus.FAILED);
  assert.equal(step.attempts, 2);
  assert.equal(step.error, 'skill_executor_attempt_budget_exhausted');
  assert.equal(calls, 2);
  assert.equal(failed.modelUsage.calls, 2);
});

test('read-only skill executor retries within workflow attempt budget and persists bounded failure evidence', async () => {
  const configured = configFrom({
    id: 'readonly-retry',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let calls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      calls += 1;
      return { ok: false, status: 'failed', outputBytes: 25, error: 'invalid structured output from fixture' };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Retry inspection', budgets: { maxAttempts: 2 } });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');

  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.status, WorkflowStepStatus.FAILED);
  assert.equal(step.attempts, 2);
  assert.equal(step.error, 'skill_executor_attempt_budget_exhausted');
  assert.equal(calls, 2);
  assert.equal(failed.outputBytes, 50);
  assert.equal(step.evidence.error, 'invalid structured output from fixture');
});


function changedChangeSet(paths, overrides = {}) {
  const base = {
    paths,
    changedFiles: paths.length,
    additions: overrides.additions ?? paths.length,
    deletions: overrides.deletions ?? 0,
    diffLines: overrides.diffLines ?? paths.length,
    changedBytes: overrides.changedBytes ?? Math.max(1, paths.length * 32),
    maxFileBytes: overrides.maxFileBytes ?? 32,
    sensitiveContent: overrides.sensitiveContent ?? false,
    contentFingerprint: overrides.contentFingerprint ?? '1'.repeat(64)
  };
  return { ...base, changeSetFingerprint: fingerprintChangeSet(base) };
}

async function prepareImplementation(instance, workflowId) {
  const current = await instance.get(workflowId);
  const configured = instance.projects.get(current.projectId);
  if (!current.workspace) await instance.workspaceProject(workflowId, configured);
  await instance.update(workflowId, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture inspection', relevantPaths: ['src/core.js'] } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture diagnosis', cause: 'fixture cause' } };
    completeStep(plan, 'plan-change');
  });
}

async function prepareApprovedDependencyChange(instance, workflowId, changeSet, { branch = 'main', head = 'deadbeef', remote = 'https://github.com/owner/repo.git' } = {}) {
  await instance.update(workflowId, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture inspection', relevantPaths: changeSet.paths } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture diagnosis', cause: 'fixture dependency change' } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.workspacePath = plan.workspace?.path ?? null;
    implementation.evidence.repositoryState = { branch, head, remote };
    implementation.evidence.changeSet = changeSet;
    implementation.evidence.changeSetFingerprint = changeSet.changeSetFingerprint;
    implementation.evidence.changePolicy = { ok: true, classification: 'sensitive', reason: 'sensitive_change:package.json' };
    implementation.evidence.workerEvidence = { status: 'completed', summary: 'fixture dependency implementation' };
    implementation.evidence.protectedIgnoredFingerprint = emptyProtectedIgnoredState().fingerprint;
    implementation.evidence.repositoryControlFingerprint = emptyRepositoryControlState().fingerprint;
    implementation.evidence.sensitiveApproval = {
      approvedAt: '2026-09-11T00:00:00.000Z',
      changeSetFingerprint: changeSet.changeSetFingerprint,
      approvedDependencyEvidenceFingerprint: humanApprovalDependencyFingerprint(plan, 'implementation')
    };
    const dependencyRefresh = plan.steps.find((step) => step.id === 'dependency-refresh');
    dependencyRefresh.status = WorkflowStepStatus.PENDING;
    dependencyRefresh.error = null;
    dependencyRefresh.evidence = null;
    plan.status = WorkflowStepStatus.PENDING;
    plan.pausedAt = null;
    plan.result = null;
  });
}


async function prepareReviewedPublication(instance, workflowId, changeSet) {
  await instance.update(workflowId, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture inspection', relevantPaths: changeSet.paths } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture diagnosis', cause: 'fixture cause' } };
    completeStep(plan, 'plan-change');

    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.workspacePath = plan.workspace.path;
    implementation.evidence.repositoryState = { branch: plan.workspace.workingBranch, head: plan.workspace.baseHead, remote: plan.workspace.remote };
    implementation.evidence.changeSet = changeSet;
    implementation.evidence.changeSetFingerprint = changeSet.changeSetFingerprint;
    implementation.evidence.changePolicy = { ok: true, classification: 'normal' };
    implementation.evidence.workerEvidence = { status: 'completed', summary: 'fixture implementation' };
    implementation.evidence.protectedIgnoredFingerprint = emptyProtectedIgnoredState().fingerprint;
    implementation.evidence.repositoryControlFingerprint = emptyRepositoryControlState().fingerprint;

    completeStep(plan, 'dependency-refresh');
  const review = completeStep(plan, 'review');
    review.evidence.reviewedChangeSetFingerprint = changeSet.changeSetFingerprint;
    review.evidence.result = { reviewEvidence: { verdict: 'PASS', summary: 'fixture critic pass', findings: [] } };

    completeStep(plan, 'tests');
    completeStep(plan, 'verification');

    const release = completeStep(plan, 'release-readiness');
    release.evidence.approvedChangeSetFingerprint = changeSet.changeSetFingerprint;
    release.evidence.reviewedChangeSetFingerprint = changeSet.changeSetFingerprint;

    const publication = plan.steps.find((step) => step.id === 'publication');
    publication.status = WorkflowStepStatus.PENDING;
    publication.error = null;
    publication.evidence = null;
    plan.status = WorkflowStepStatus.PENDING;
    plan.pausedAt = null;
    plan.result = null;
  });
}


test('reviewed workflow publication completes only with exact commit, push, PR, CI, and preview evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-happy-'));
  const configured = managedProject('publication-happy', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js'], { additions: 4, diffLines: 4 });
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId, expectedBaseHead) {
      assert.equal(expectedBaseHead, baseHead);
      branch = `agent/${runId}`;
      return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead };
    },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; } });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Publish reviewed change' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);

  const completed = await instance.run(created.id);
  const publication = completed.steps.find((step) => step.id === 'publication');
  assert.equal(completed.status, WorkflowStepStatus.COMPLETED);
  assert.equal(publication.status, WorkflowStepStatus.COMPLETED);
  assert.equal(publication.evidence.ok, true);
  assert.equal(publication.evidence.phase, 'completed');
  assert.equal(publication.evidence.commit.finalHead, commitHead);
  assert.equal(publication.evidence.commit.committedChangeSetFingerprint, changeSet.changeSetFingerprint);
  assert.equal(publication.evidence.push.remoteBranchHead, commitHead);
  assert.equal(publication.evidence.pullRequest.number, 42);
  assert.equal(publication.evidence.pullRequest.headSha, commitHead);
  assert.equal(publication.evidence.ci.state, 'success');
  assert.equal(publication.evidence.preview.state, 'NOT_REQUIRED');
  assert.deepEqual(publicationBridge.calls, ['inspectBase', 'commit', 'push', 'verifyRemoteBranch', 'inspectBase', 'createPullRequest', 'verifyPullRequest', 'waitForCi', 'waitForPreview', 'inspectBase', 'verifyRemoteBranch', 'verifyPullRequest']);
  assert.equal(typeof publicationBridge.merge, 'undefined');
  assert.equal(typeof publicationBridge.deployProduction, 'undefined');
  assert.equal(typeof WorkflowPublicationBridge.prototype.merge, 'undefined');
  assert.equal(typeof WorkflowPublicationBridge.prototype.deployProduction, 'undefined');
  assert.equal(typeof WorkflowPublicationBridge.prototype.promote, 'undefined');

  const tampered = JSON.parse(JSON.stringify(completed));
  tampered.steps.find((step) => step.id === 'publication').evidence.pullRequest.headSha = 'f'.repeat(40);
  assert.throws(
    () => validateWorkflowPlan(tampered, new Map([[configured.id, configured]])),
    /publication pull request evidence is invalid/
  );

  const ciTampered = JSON.parse(JSON.stringify(completed));
  const ciEvidence = ciTampered.steps.find((step) => step.id === 'publication').evidence.ci;
  ciEvidence.state = 'success';
  ciEvidence.checks = [{ name: 'CI', status: 'completed', conclusion: 'failure' }];
  ciEvidence.statuses = [];
  assert.throws(
    () => validateWorkflowPlan(ciTampered, new Map([[configured.id, configured]])),
    /internally consistent successful CI evidence/
  );

  const previewTampered = JSON.parse(JSON.stringify(completed));
  previewTampered.steps.find((step) => step.id === 'publication').evidence.preview = {
    provider: 'vercel', ok: true, state: 'READY', environment: 'preview',
    commitSha: 'f'.repeat(40), branch: completed.workspace.workingBranch
  };
  assert.throws(
    () => validateWorkflowPlan(previewTampered, new Map([[configured.id, configured]])),
    /READY preview is not bound/
  );

  const baseTampered = JSON.parse(JSON.stringify(completed));
  baseTampered.steps.find((step) => step.id === 'publication').evidence.finalBaseObservation.repository = 'owner/other';
  assert.throws(
    () => validateWorkflowPlan(baseTampered, new Map([[configured.id, configured]])),
    /does not match the managed workflow workspace/
  );
});

test('reviewed publication blocks before external writes when default branch head changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-base-drift-'));
  const configured = managedProject('publication-base-drift', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: baseHead, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead: 'c'.repeat(40), changeSet });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject base drift' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const blocked = await instance.run(created.id);
  const publication = blocked.steps.find((step) => step.id === 'publication');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(publication.error, 'workflow_publication_base_head_changed');
  assert.deepEqual(publicationBridge.calls, ['inspectBase']);
});

test('reviewed publication rejects a diff changed after critic and release approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-diff-drift-'));
  const configured = managedProject('publication-diff-drift', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const approved = changedChangeSet(['src/feature.js']);
  const mutated = changedChangeSet(['src/feature.js', 'src/unapproved.js']);
  const baseHead = 'a'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let observed = approved;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: baseHead, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return observed; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, changeSet: approved });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject changed diff' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, approved);
  observed = mutated;
  const failed = await instance.run(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_change_set_changed_during_verification');
  assert.equal(publication.evidence.expectedChangeSetFingerprint, approved.changeSetFingerprint);
  assert.equal(publication.evidence.observedChangeSetFingerprint, mutated.changeSetFingerprint);
  assert.deepEqual(publicationBridge.calls, []);
});

for (const fixture of [
  { failAt: 'commit', error: 'workflow_publication_commit_state_uncertain', forbidden: ['push', 'createPullRequest'] },
  { failAt: 'push', error: 'workflow_publication_push_state_uncertain', forbidden: ['createPullRequest'] },
  { failAt: 'createPullRequest', error: 'workflow_publication_pr_state_uncertain', forbidden: ['waitForCi'] }
]) {
  test(`reviewed publication blocks uncertain external write at ${fixture.failAt} without replaying later stages`, async () => {
    const root = await mkdtemp(join(tmpdir(), `agent-workflow-publication-${fixture.failAt}-`));
    const fixtureId = `publication-${fixture.failAt.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    const configured = managedProject(fixtureId, root, {
      skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
    });
    const manager = new FakeWorkflowWorkspaceManager();
    const changeSet = changedChangeSet(['src/feature.js']);
    const baseHead = 'a'.repeat(40);
    const commitHead = 'b'.repeat(40);
    const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
    let branch = configured.defaultBranch;
    let head = baseHead;
    const localGit = stableLocalGit({
      async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
      async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
      async inspectChangeSet() { return changeSet; }
    });
    const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, commitHead, changeSet, failAt: fixture.failAt, onCommit: (nextHead) => { head = nextHead; } });
    const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
    const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Fail external write safely' });
    await instance.workspaceProject(created.id, configured);
    await prepareReviewedPublication(instance, created.id, changeSet);
    const blocked = await instance.run(created.id);
    const publication = blocked.steps.find((step) => step.id === 'publication');
    assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
    assert.equal(publication.error, fixture.error);
    for (const name of fixture.forbidden) assert.equal(publicationBridge.calls.includes(name), false);
    const resumed = await instance.resume(created.id);
    assert.equal(resumed.status, WorkflowStepStatus.BLOCKED);
    assert.equal(resumed.steps.find((step) => step.id === 'publication').error, fixture.error);
  });
}

test('reviewed publication records CI failure after PR and never attempts preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-ci-fail-'));
  const configured = managedProject('publication-ci-fail', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; },
    ci: { state: 'failure', checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }], statuses: [], durationMs: 1 }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Observe CI failure' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const failed = await instance.run(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_publication_ci_failed');
  assert.equal(publication.evidence.pullRequest.number, 42);
  assert.equal(publication.evidence.ci.state, 'failure');
  assert.equal(publicationBridge.calls.includes('waitForPreview'), false);
});

test('reviewed publication requires a ready preview when deployment acceptance requires it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-preview-fail-'));
  const configured = managedProject('publication-preview-fail', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] },
    acceptance: { require: ['test', 'ci', 'deployment'] },
    deployment: { provider: 'vercel', projectId: 'prj_fixture', teamId: 'team_fixture', requirePreviewReady: true }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; },
    preview: { provider: 'vercel', state: 'ERROR', ok: false, environment: 'preview', url: 'https://preview.example' }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Require preview' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const failed = await instance.run(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_publication_preview_failed');
  assert.equal(publication.evidence.ci.state, 'success');
  assert.equal(publication.evidence.preview.state, 'ERROR');
});

test('CI observation timeout resumes from the persisted PR without repeating commit, push, or PR creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-ci-resume-'));
  const configured = managedProject('publication-ci-resume', root, {
    budgets: { maxModelCalls: 6 },
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  let clock = Date.now();
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; },
    ci: { state: 'timeout', checks: [], statuses: [], durationMs: 1 }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge, now: () => clock });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Resume CI observation' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.steps.find((step) => step.id === 'publication').error, 'workflow_publication_ci_timeout');
  assert.equal(publicationBridge.calls.filter((name) => name === 'commit').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'push').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'createPullRequest').length, 1);

  publicationBridge.ci = { state: 'success', checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], statuses: [], durationMs: 1 };
  clock += 5_000;
  const completed = await instance.resume(created.id);
  assert.equal(completed.status, WorkflowStepStatus.COMPLETED);
  assert.equal(publicationBridge.calls.filter((name) => name === 'commit').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'push').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'createPullRequest').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'waitForCi').length, 2);
});

test('reviewed publication blocks if default branch advances after push but before PR creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-base-race-'));
  const configured = managedProject('publication-base-race', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const advancedHead = 'c'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; } });
  let baseChecks = 0;
  publicationBridge.inspectBase = async (project) => {
    publicationBridge.calls.push('inspectBase');
    baseChecks += 1;
    return { provider: 'github', status: 'ok', repository: `${project.repository.owner}/${project.repository.name}`, defaultBranch: project.defaultBranch, head: baseChecks === 1 ? baseHead : advancedHead };
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject base race' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const blocked = await instance.run(created.id);
  const publication = blocked.steps.find((step) => step.id === 'publication');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(publication.error, 'workflow_publication_base_head_changed_after_push');
  assert.equal(publication.evidence.commit.finalHead, commitHead);
  assert.equal(publication.evidence.push.remoteBranchHead, commitHead);
  assert.equal(publicationBridge.calls.includes('createPullRequest'), false);
});

test('preview observation timeout resumes without repeating commit, push, PR, or CI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-preview-resume-'));
  const configured = managedProject('publication-preview-resume', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] },
    acceptance: { require: ['test', 'ci', 'deployment'] },
    deployment: { provider: 'vercel', projectId: 'prj_fixture', teamId: 'team_fixture', requirePreviewReady: true }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  let clock = Date.now();
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; },
    preview: { provider: 'vercel', state: 'TIMEOUT', ok: false, environment: 'preview', durationMs: 1 }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge, now: () => clock });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Resume preview observation' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);

  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.steps.find((step) => step.id === 'publication').error, 'workflow_publication_preview_timeout');
  assert.equal(publicationBridge.calls.filter((name) => name === 'commit').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'push').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'createPullRequest').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'waitForCi').length, 1);

  publicationBridge.preview = { provider: 'vercel', state: 'READY', ok: true, environment: 'preview', url: 'https://preview.example' };
  clock += 5_000;
  const completed = await instance.resume(created.id);
  assert.equal(completed.status, WorkflowStepStatus.COMPLETED);
  assert.equal(publicationBridge.calls.filter((name) => name === 'commit').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'push').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'createPullRequest').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'waitForCi').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'waitForPreview').length, 2);
});

test('publication observation resume fails closed if the remote review branch changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-remote-tamper-'));
  const configured = managedProject('publication-remote-tamper', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  let clock = Date.now();
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; },
    ci: { state: 'timeout', checks: [], statuses: [], durationMs: 1 }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge, now: () => clock });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject remote tamper' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const blocked = await instance.run(created.id);
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);

  publicationBridge.verifyRemoteBranch = async (_project, currentBranch) => {
    publicationBridge.calls.push('verifyRemoteBranch');
    return { branch: currentBranch, head: 'd'.repeat(40), ok: false };
  };
  publicationBridge.ci = { state: 'success', checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }], statuses: [], durationMs: 1 };
  clock += 1_000;
  const failed = await instance.resume(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_publication_remote_state_changed');
  assert.equal(publicationBridge.calls.filter((name) => name === 'commit').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'push').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'createPullRequest').length, 1);
  assert.equal(publicationBridge.calls.filter((name) => name === 'waitForCi').length, 1);
});

test('reviewed publication blocks a PR whose observed head does not match the governed commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-pr-mismatch-'));
  const configured = managedProject('publication-pr-mismatch', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; } });
  publicationBridge.verifyPullRequest = async (project, number, context) => {
    publicationBridge.calls.push('verifyPullRequest');
    return { number, url: 'https://github.com/owner/repo/pull/42', state: 'open', headSha: 'e'.repeat(40), headRef: context.branch, baseRef: project.defaultBranch, ok: false };
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject wrong PR head' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const blocked = await instance.run(created.id);
  const publication = blocked.steps.find((step) => step.id === 'publication');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(publication.error, 'workflow_publication_pr_mismatch');
  assert.equal(publicationBridge.calls.includes('waitForCi'), false);
});

test('reviewed publication fails if default branch advances while CI or preview is being observed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-publication-final-base-drift-'));
  const configured = managedProject('publication-final-base-drift', root, {
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['src/feature.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const advancedHead = 'c'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return changeSet; }
  });
  const publicationBridge = new FakeWorkflowPublicationBridge({ baseHead, commitHead, changeSet, onCommit: (nextHead) => { head = nextHead; } });
  let baseChecks = 0;
  publicationBridge.inspectBase = async (project) => {
    publicationBridge.calls.push('inspectBase');
    baseChecks += 1;
    return {
      provider: 'github',
      status: 'ok',
      repository: `${project.repository.owner}/${project.repository.name}`,
      defaultBranch: project.defaultBranch,
      head: baseChecks < 3 ? baseHead : advancedHead
    };
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, publicationBridge });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject late base drift' });
  await instance.workspaceProject(created.id, configured);
  await prepareReviewedPublication(instance, created.id, changeSet);
  const failed = await instance.run(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_publication_base_head_changed_after_review');
  assert.equal(publication.evidence.ci.state, 'success');
  assert.equal(publication.evidence.pullRequest.number, 42);
});

test('website-build runs brief to reviewed PR-ready publication with three bounded model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-build-e2e-'));
  const configured = managedProject('website-e2e', root, {
    deployment: { provider: 'vercel', projectId: 'prj_website_e2e', teamId: 'team_website_e2e', requirePreviewReady: true },
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const brief = businessBrief();
  const websitePlan = websitePlanFixture();
  const governed = changedChangeSet(['src/app/page.js', 'src/app/servicios/page.js', 'src/app/contacto/page.js'], { additions: 120, diffLines: 120, changedBytes: 6_000 });
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  let implemented = false;

  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId, expectedBaseHead) {
      assert.equal(expectedBaseHead, baseHead);
      branch = `agent/${runId}`;
      return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead };
    },
    async inspectChangeSet() { return implemented ? governed : emptyChangeSet(); }
  });

  const skillCalls = [];
  let requirementsPlanFingerprint = null;
  let requirementsBlueprintFingerprint = null;
  const skillExecutor = {
    supports: (skill) => ['website.plan', 'code.review'].includes(skill),
    async execute(request) {
      skillCalls.push(request.skill);
      if (request.skill === 'website.plan') {
        assert.equal(request.context.businessBrief.businessName, brief.businessName);
        assert.match(request.context.businessBriefFingerprint, /^[a-f0-9]{64}$/);
        assert.equal(request.context.websiteBlueprint.id, 'home-services');
        assert.match(request.context.websiteBlueprintFingerprint, /^[a-f0-9]{64}$/);
        assert.deepEqual(request.context.assetEvidence.assets, []);
        return { ok: true, status: 'completed', usage: { input_tokens: 50, output_tokens: 30 }, outputBytes: 50, result: { websitePlan } };
      }
      assert.equal(request.context.priorEvidence.implementation.changeSetFingerprint, governed.changeSetFingerprint);
      assert.equal(request.context.websiteReview.businessBrief.businessName, brief.businessName);
      assert.deepEqual(request.context.websiteReview.websitePlan, websitePlan);
      assert.equal(request.context.websiteReview.websitePlanFingerprint, requirementsPlanFingerprint);
      assert.equal(request.context.websiteReview.websiteBlueprint.id, 'home-services');
      assert.equal(request.context.websiteReview.websiteBlueprintFingerprint, requirementsBlueprintFingerprint);
      assert.deepEqual(request.context.websiteReview.assetEvidence.assets, []);
      return { ok: true, status: 'completed', usage: { input_tokens: 20, output_tokens: 10 }, outputBytes: 30, result: { reviewEvidence: { verdict: 'PASS', summary: 'No blocking issue.', findings: [] } } };
    }
  };

  const codingWorker = {
    async execute(task) {
      assert.equal(task.websiteBuild.businessBrief.businessName, brief.businessName);
      assert.deepEqual(task.websiteBuild.websitePlan, websitePlan);
      assert.equal(task.websiteBuild.approvedWebsitePlanFingerprint, task.websiteBuild.websitePlanFingerprint);
      assert.equal(task.websiteBuild.websiteBlueprint.id, 'home-services');
      assert.equal(task.websiteBuild.approvedWebsiteBlueprintFingerprint, task.websiteBuild.websiteBlueprintFingerprint);
      assert.equal(task.websiteBuild.assetEvidence.assets.length, 0);
      implemented = true;
      return { status: 'completed', summary: 'website implemented', output: 'done', outputBytes: 4, usage: { input_tokens: 100, output_tokens: 60 } };
    }
  };

  const previewUrl = 'https://website-e2e-preview.vercel.app';
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead,
    commitHead,
    changeSet: governed,
    preview: { provider: 'vercel', state: 'READY', ok: true, environment: 'preview', url: previewUrl },
    onCommit: (nextHead) => { head = nextHead; }
  });
  const commandCalls = [];
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    skillExecutor,
    codingWorker,
    publicationBridge,
    runner: async (_project, name) => { commandCalls.push(name); return { name, ok: true, exitCode: 0, stdout: 'ok', stderr: '' }; }
  });

  const created = await instance.create({ profile: 'website-build', projectId: configured.id, goal: 'Crear web profesional', input: { businessBrief: brief } });
  let waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  const requirements = waiting.steps.find((step) => step.id === 'requirements');
  assert.equal(requirements.status, WorkflowStepStatus.COMPLETED);
  assert.deepEqual(requirements.evidence.result.websitePlan, websitePlan);
  assert.match(requirements.evidence.websitePlanFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(requirements.evidence.websiteBlueprint.id, 'home-services');
  assert.match(requirements.evidence.websiteBlueprintFingerprint, /^[a-f0-9]{64}$/);
  requirementsPlanFingerprint = requirements.evidence.websitePlanFingerprint;
  requirementsBlueprintFingerprint = requirements.evidence.websiteBlueprintFingerprint;
  assert.equal(waiting.steps.find((step) => step.id === 'design').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.modelUsage.calls, 1);

  waiting = await instance.approve(created.id, 'design');
  const approvedDesign = waiting.steps.find((step) => step.id === 'design');
  assert.equal(approvedDesign.evidence.approvedWebsitePlanFingerprint, requirements.evidence.websitePlanFingerprint);
  assert.equal(approvedDesign.evidence.approvedWebsiteBlueprintFingerprint, requirements.evidence.websiteBlueprintFingerprint);
  const tamperedDesign = JSON.parse(JSON.stringify(waiting));
  tamperedDesign.steps.find((step) => step.id === 'design').evidence.approvedWebsiteBlueprintFingerprint = 'f'.repeat(64);
  assert.throws(
    () => validateWorkflowPlan(tamperedDesign, new Map([[configured.id, configured]])),
    /website design approval is not bound/
  );

  waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.steps.find((step) => step.id === 'implementation').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'dependency-refresh').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'dependency-refresh').evidence.required, false);
  assert.equal(waiting.steps.find((step) => step.id === 'review').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'quality').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'release-readiness').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.steps.find((step) => step.id === 'publication').status, WorkflowStepStatus.PENDING);
  assert.equal(waiting.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.PENDING);
  assert.deepEqual(commandCalls, ['test', 'typecheck', 'lint', 'build']);
  assert.equal(waiting.modelUsage.calls, 3);
  assert.deepEqual(skillCalls, ['website.plan', 'code.review']);

  waiting = await instance.approve(created.id, 'release-readiness');
  const release = waiting.steps.find((step) => step.id === 'release-readiness');
  assert.equal(release.evidence.approvedChangeSetFingerprint, governed.changeSetFingerprint);
  const tamperedRelease = JSON.parse(JSON.stringify(waiting));
  tamperedRelease.steps.find((step) => step.id === 'release-readiness').evidence.approvedChangeSetFingerprint = 'd'.repeat(64);
  assert.throws(
    () => validateWorkflowPlan(tamperedRelease, new Map([[configured.id, configured]])),
    /release-readiness approval is not bound/
  );

  waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  const publication = waiting.steps.find((step) => step.id === 'publication');
  assert.equal(publication.status, WorkflowStepStatus.COMPLETED);
  assert.equal(publication.evidence.commit.committedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(publication.evidence.pullRequest.headSha, commitHead);
  assert.equal(publication.evidence.preview.state, 'READY');
  assert.equal(publication.evidence.preview.url, previewUrl);
  assert.equal(publication.evidence.preview.commitSha, commitHead);
  assert.equal(waiting.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.AWAITING_APPROVAL);

  waiting = await instance.approve(created.id, 'visual-verification');
  const visual = waiting.steps.find((step) => step.id === 'visual-verification');
  assert.equal(visual.evidence.approvedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(visual.evidence.approvedCommitSha, commitHead);
  assert.equal(visual.evidence.approvedPreviewUrl, previewUrl);
  const tamperedVisual = JSON.parse(JSON.stringify(waiting));
  tamperedVisual.steps.find((step) => step.id === 'visual-verification').evidence.approvedPreviewUrl = 'https://wrong-preview.example';
  assert.throws(
    () => validateWorkflowPlan(tamperedVisual, new Map([[configured.id, configured]])),
    /visual verification is not bound to the published preview/
  );

  const completed = await instance.run(created.id);
  assert.equal(completed.status, WorkflowStepStatus.COMPLETED);
  assert.equal(completed.steps.find((step) => step.id === 'visual-verification').evidence.approvedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(completed.steps.find((step) => step.id === 'release-readiness').evidence.approvedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(completed.modelUsage.calls, 3);
  assert.equal(typeof publicationBridge.merge, 'undefined');
  assert.equal(typeof publicationBridge.deployProduction, 'undefined');
});

test('website-build dependency change requires one fingerprint approval and one frozen refresh before critic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-build-dependency-'));
  const configured = managedProject('website-dependency', root, {
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'project.dependencies.refresh', 'code.review', 'project.verify'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const sensitive = changedChangeSet(['package.json', 'package-lock.json', 'src/app/page.js']);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let implemented = false;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return implemented ? sensitive : emptyChangeSet(); }
  });
  const skillExecutor = {
    supports: (skill) => ['website.plan', 'code.review'].includes(skill),
    async execute(request) {
      if (request.skill === 'website.plan') return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } };
      assert.equal(request.context.priorEvidence.implementation.changeSetFingerprint, sensitive.changeSetFingerprint);
      return { ok: true, status: 'completed', outputBytes: 1, result: { reviewEvidence: { verdict: 'PASS', summary: 'dependency change reviewed', findings: [] } } };
    }
  };
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      implemented = true;
      return { status: 'completed', summary: 'website plus dependency implemented', output: '', outputBytes: 0 };
    }
  };
  const commandCalls = [];
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    skillExecutor,
    codingWorker,
    runner: async (_project, name, options) => {
      commandCalls.push({ name, stage: options?.stage });
      if (name === 'dependencyRefresh') {
        return {
          name, ok: true, exitCode: 0, stdout: '', stderr: '',
          execution: { provider: 'container', stage: 'dependency-refresh', postWorkerNetwork: 'dependency-refresh-network-enabled' }
        };
      }
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });

  const created = await instance.create({ profile: 'website-build', projectId: configured.id, goal: 'Build website with approved dependency', input: { businessBrief: businessBrief() } });
  await instance.run(created.id);
  await instance.approve(created.id, 'design');

  let waiting = await instance.run(created.id);
  const implementation = waiting.steps.find((step) => step.id === 'implementation');
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(implementation.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(implementation.evidence.changePolicy.classification, 'sensitive');
  assert.equal(workerCalls, 1);
  assert.equal(commandCalls.length, 0);
  assert.equal(waiting.modelUsage.calls, 2);

  waiting = await instance.approve(created.id, 'implementation');
  assert.equal(waiting.steps.find((step) => step.id === 'implementation').status, WorkflowStepStatus.COMPLETED);
  assert.equal(workerCalls, 1);

  waiting = await instance.run(created.id);
  const refresh = waiting.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(refresh.status, WorkflowStepStatus.COMPLETED);
  assert.equal(refresh.evidence.required, true);
  assert.equal(refresh.evidence.command.name, 'dependencyRefresh');
  assert.equal(refresh.evidence.execution.provider, 'container');
  assert.equal(refresh.evidence.execution.stage, 'dependency-refresh');
  assert.equal(refresh.evidence.execution.postWorkerNetwork, 'dependency-refresh-network-enabled');
  assert.equal(commandCalls.filter((call) => call.name === 'dependencyRefresh').length, 1);
  assert.deepEqual(commandCalls.filter((call) => call.name !== 'dependencyRefresh').map((call) => call.name), ['test', 'typecheck', 'lint', 'build']);
  assert.equal(workerCalls, 1);
  assert.equal(waiting.modelUsage.calls, 3);
  assert.equal(waiting.steps.find((step) => step.id === 'review').status, WorkflowStepStatus.COMPLETED);
  assert.equal(waiting.steps.find((step) => step.id === 'release-readiness').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(waiting.steps.find((step) => step.id === 'publication').status, WorkflowStepStatus.PENDING);
  assert.equal(waiting.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.PENDING);
});

test('website-build cannot reach visual approval without a usable READY preview URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-preview-required-'));
  const configured = managedProject('website-preview-required', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const governed = changedChangeSet(['src/app/page.js']);
  const baseHead = 'a'.repeat(40);
  const commitHead = 'b'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let head = baseHead;
  let implemented = false;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: head, status: '' }; },
    async prepareWorkingBranch(_project, runId) {
      branch = `agent/${runId}`;
      return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead };
    },
    async inspectChangeSet() { return implemented ? governed : emptyChangeSet(); }
  });
  const skillExecutor = {
    supports: (skill) => ['website.plan', 'code.review'].includes(skill),
    async execute(request) {
      if (request.skill === 'website.plan') return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } };
      return { ok: true, status: 'completed', outputBytes: 1, result: { reviewEvidence: { verdict: 'PASS', summary: 'reviewed', findings: [] } } };
    }
  };
  const publicationBridge = new FakeWorkflowPublicationBridge({
    baseHead,
    commitHead,
    changeSet: governed,
    preview: { provider: 'none', state: 'NOT_REQUIRED', ok: true, durationMs: 0 },
    onCommit: (nextHead) => { head = nextHead; }
  });
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    skillExecutor,
    codingWorker: { async execute() { implemented = true; return { status: 'completed', summary: 'implemented', output: '', outputBytes: 0 }; } },
    publicationBridge
  });
  const created = await instance.create({ profile: 'website-build', projectId: configured.id, goal: 'Require preview before visual review', input: { businessBrief: businessBrief() } });
  await instance.run(created.id);
  await instance.approve(created.id, 'design');
  let waiting = await instance.run(created.id);
  assert.equal(waiting.steps.find((step) => step.id === 'release-readiness').status, WorkflowStepStatus.AWAITING_APPROVAL);
  await instance.approve(created.id, 'release-readiness');

  const failed = await instance.run(created.id);
  const publication = failed.steps.find((step) => step.id === 'publication');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.status, WorkflowStepStatus.FAILED);
  assert.equal(publication.error, 'workflow_publication_preview_not_configured');
  assert.equal(failed.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.PENDING);
  await assert.rejects(instance.approve(created.id, 'visual-verification'), /not awaiting human approval/);
});

test('website-build critic FAIL stops before quality and visual approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-build-critic-fail-'));
  const configured = managedProject('website-critic-fail', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const governed = changedChangeSet(['src/app/page.js']);
  const baseHead = 'a'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let implemented = false;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: baseHead, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return implemented ? governed : emptyChangeSet(); }
  });
  const skillExecutor = {
    supports: (skill) => ['website.plan', 'code.review'].includes(skill),
    async execute(request) {
      if (request.skill === 'website.plan') return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } };
      return { ok: true, status: 'completed', outputBytes: 1, result: { reviewEvidence: { verdict: 'FAIL', summary: 'Blocking accessibility regression.', findings: [{ severity: 'high', message: 'Missing accessible navigation.', path: 'src/app/page.js' }] } } };
    }
  };
  let commandCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, skillExecutor,
    codingWorker: { async execute() { implemented = true; return { status: 'completed', summary: 'implemented', output: '', outputBytes: 0 }; } },
    publicationBridge: new FakeWorkflowPublicationBridge({ baseHead, changeSet: governed }),
    runner: async (_project, name) => { commandCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'website-build', projectId: configured.id, goal: 'Build safely', input: { businessBrief: businessBrief() } });
  await instance.run(created.id);
  await instance.approve(created.id, 'design');
  const failed = await instance.run(created.id);
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(failed.steps.find((step) => step.id === 'review').error, 'workflow_change_review_failed');
  assert.equal(failed.steps.find((step) => step.id === 'quality').status, WorkflowStepStatus.PENDING);
  assert.equal(failed.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.PENDING);
  assert.equal(commandCalls, 0);
});

test('website-build quality fails closed if verified diff changes after critic PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-website-build-quality-drift-'));
  const configured = managedProject('website-quality-drift', root, {
    skills: { allow: ['workspace.prepare', 'website.plan', 'human.approval', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const governed = changedChangeSet(['src/app/page.js']);
  const mutated = changedChangeSet(['src/app/page.js', 'src/app/unapproved.js']);
  const baseHead = 'a'.repeat(40);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  let branch = configured.defaultBranch;
  let state = 'clean';
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: branch, initialHead: baseHead, status: '' }; },
    async prepareWorkingBranch(_project, runId) { branch = `agent/${runId}`; return { remote, workingBranch: branch, initialHead: baseHead, remoteBaseHead: baseHead }; },
    async inspectChangeSet() { return state === 'clean' ? emptyChangeSet() : state === 'governed' ? governed : mutated; }
  });
  const skillExecutor = {
    supports: (skill) => ['website.plan', 'code.review'].includes(skill),
    async execute(request) {
      if (request.skill === 'website.plan') return { ok: true, status: 'completed', outputBytes: 1, result: { websitePlan: websitePlanFixture() } };
      return { ok: true, status: 'completed', outputBytes: 1, result: { reviewEvidence: { verdict: 'PASS', summary: 'pass', findings: [] } } };
    }
  };
  let commandCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit, skillExecutor,
    codingWorker: { async execute() { state = 'governed'; return { status: 'completed', summary: 'implemented', output: '', outputBytes: 0 }; } },
    publicationBridge: new FakeWorkflowPublicationBridge({ baseHead, changeSet: governed }),
    runner: async (_project, name) => {
      commandCalls += 1;
      if (commandCalls === 1) state = 'mutated';
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'website-build', projectId: configured.id, goal: 'Detect quality drift', input: { businessBrief: businessBrief() } });
  await instance.run(created.id);
  await instance.approve(created.id, 'design');
  const failed = await instance.run(created.id);
  const quality = failed.steps.find((step) => step.id === 'quality');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(quality.error, 'workflow_change_set_changed_during_verification');
  assert.equal(commandCalls, 1);
  assert.equal(failed.steps.find((step) => step.id === 'visual-verification').status, WorkflowStepStatus.PENDING);
});

test('read-only workflow step fails closed if workspace changes despite read-only sandbox', async () => {
  const configured = configFrom({
    id: 'readonly-integrity',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let snapshots = 0;
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      snapshots += 1;
      return snapshots === 1 ? emptyChangeSet() : changedChangeSet(['src/unexpected.js']);
    }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 20, result: { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Inspect only' });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.status, WorkflowStepStatus.FAILED);
  assert.equal(step.error, 'read_only_skill_modified_workspace');
  assert.equal(step.evidence.ok, false);
  assert.notEqual(step.evidence.workspaceBeforeFingerprint, step.evidence.workspaceAfterFingerprint);
});

test('app-improvement implementation completes only after critic PASS and normal governed verification', async () => {
  let changeCalls = 0;
  const normalChange = changedChangeSet(['src/feature.js'], { additions: 3, diffLines: 3, changedBytes: 96 });
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : normalChange;
    }
  });
  const codingWorker = {
    async execute(task, options) {
      assert.equal(task.objective, 'Implement safely');
      assert.equal(task.workflow.profile, 'app-improvement');
      assert.ok(task.inspectionEvidence);
      assert.ok(task.diagnosis);
      assert.ok(task.approvedPlanChange?.approvedAt);
      assert.equal(options.workspace.length > 0, true);
      return { status: 'completed', summary: 'implemented', codexThreadId: 'write-thread', output: 'done', outputBytes: 4 };
    }
  };
  let reviewCalls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.review',
    async execute(request) {
      reviewCalls += 1;
      assert.equal(request.skill, 'code.review');
      assert.equal(request.context.priorEvidence.implementation.changeSetFingerprint, normalChange.changeSetFingerprint);
      assert.deepEqual(request.context.priorEvidence.implementation.changeSet.paths, ['src/feature.js']);
      return { ok: true, status: 'completed', outputBytes: 16, result: { reviewEvidence: { verdict: 'PASS', summary: 'change is safe', findings: [] } } };
    }
  };
  const configured = configFrom({
    id: 'review-happy-path',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.implement', 'code.review', 'human.approval', 'project.verify'], deny: [] }
  });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, codingWorker, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Implement safely' });
  await prepareImplementation(instance, created.id);
  const result = await instance.run(created.id);
  const implementation = result.steps.find((step) => step.id === 'implementation');
  const review = result.steps.find((step) => step.id === 'review');
  assert.equal(implementation.status, WorkflowStepStatus.COMPLETED);
  assert.equal(implementation.evidence.ok, true);
  assert.equal(implementation.evidence.workerEvidence.status, 'completed');
  assert.equal(implementation.evidence.changePolicy.classification, 'normal');
  assert.equal(implementation.evidence.changeSetFingerprint, normalChange.changeSetFingerprint);
  assert.equal(review.status, WorkflowStepStatus.COMPLETED);
  assert.equal(review.evidence.result.reviewEvidence.verdict, 'PASS');
  assert.equal(review.evidence.reviewedChangeSetFingerprint, normalChange.changeSetFingerprint);
  assert.equal(reviewCalls, 1);
  assert.equal(result.steps.find((step) => step.id === 'tests').status, WorkflowStepStatus.COMPLETED);
  assert.equal(result.steps.find((step) => step.id === 'verification').status, WorkflowStepStatus.COMPLETED);
  assert.equal(result.steps.find((step) => step.id === 'release-readiness').status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(result.status, WorkflowStepStatus.AWAITING_APPROVAL);
});

test('app-improvement critic FAIL stops before deterministic verification', async () => {
  let changeCalls = 0;
  const normalChange = changedChangeSet(['src/feature.js']);
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : normalChange;
    }
  });
  const configured = configFrom({
    id: 'review-fail-path',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.implement', 'code.review', 'human.approval', 'project.verify'], deny: [] }
  });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'implemented', output: '', outputBytes: 0 }; } };
  const skillExecutor = {
    supports: (skill) => skill === 'code.review',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 18, result: { reviewEvidence: { verdict: 'FAIL', summary: 'regression found', findings: [{ severity: 'high', message: 'unsafe regression', path: 'src/feature.js' }] } } };
    }
  };
  let verificationCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    codingWorker,
    skillExecutor,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject flawed change' });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const review = failed.steps.find((step) => step.id === 'review');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(review.status, WorkflowStepStatus.FAILED);
  assert.equal(review.error, 'workflow_change_review_failed');
  assert.equal(review.evidence.reviewedChangeSetFingerprint, normalChange.changeSetFingerprint);
  assert.equal(failed.result.reviewEvidence.verdict, 'FAIL');
  assert.equal(verificationCalls, 0);
});

test('persisted critic PASS must retain structurally valid review evidence', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Validate persisted review' });
  completeStep(plan, 'inspect-project');
  completeStep(plan, 'diagnose');
  completeStep(plan, 'plan-change');
  completeStep(plan, 'implementation');
  completeStep(plan, 'dependency-refresh');
  const review = completeStep(plan, 'review');
  review.evidence.result.reviewEvidence = { verdict: 'PASS', summary: '', findings: [] };
  assert.throws(
    () => validateWorkflowPlan(plan, new Map([[configured.id, configured]])),
    /review_evidence_summary_invalid/
  );
});

test('completed critic PASS cannot be replayed against a different implementation fingerprint', () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Bind review evidence' });
  completeStep(plan, 'inspect-project');
  completeStep(plan, 'diagnose');
  completeStep(plan, 'plan-change');
  const implementation = completeStep(plan, 'implementation');
  completeStep(plan, 'dependency-refresh');
  completeStep(plan, 'review');
  implementation.evidence.changeSetFingerprint = 'f'.repeat(64);
  plan.steps.find((step) => step.id === 'dependency-refresh').evidence.changeSetFingerprint = implementation.evidence.changeSetFingerprint;
  assert.throws(
    () => validateWorkflowPlan(plan, new Map([[configured.id, configured]])),
    /Completed change review is not bound to the governed implementation/
  );
});

test('change critic is never invoked if the governed diff drifted before review starts', async () => {
  const governed = changedChangeSet(['src/feature.js']);
  const mutated = changedChangeSet(['src/feature.js', 'src/pre-review-drift.js'], { contentFingerprint: '9'.repeat(64) });
  const localGit = stableLocalGit({ async inspectChangeSet() { return mutated; } });
  const configured = configFrom({
    id: 'pre-review-drift',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.implement', 'code.review', 'human.approval', 'project.verify'], deny: [] }
  });
  let criticCalls = 0;
  const skillExecutor = {
    supports: (skill) => skill === 'code.review',
    async execute() {
      criticCalls += 1;
      return { ok: true, status: 'completed', outputBytes: 1, result: { reviewEvidence: { verdict: 'PASS', summary: 'must not run', findings: [] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject pre-review drift' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSet = governed;
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    completeStep(plan, 'dependency-refresh');
  });

  const failed = await instance.run(created.id);
  const review = failed.steps.find((step) => step.id === 'review');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(review.status, WorkflowStepStatus.FAILED);
  assert.equal(review.error, 'workflow_change_set_changed_during_verification');
  assert.equal(review.evidence.phase, 'before-review');
  assert.equal(review.evidence.expectedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(review.evidence.observedChangeSetFingerprint, mutated.changeSetFingerprint);
  assert.equal(criticCalls, 0);
  assert.equal(failed.modelUsage.calls, 0);
});

test('change critic that mutates the workspace is rejected even if it returns PASS', async () => {
  const governed = changedChangeSet(['src/feature.js']);
  const mutated = changedChangeSet(['src/feature.js', 'src/reviewer-side-effect.js']);
  let changeCalls = 0;
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls <= 2 ? governed : mutated;
    }
  });
  const configured = configFrom({
    id: 'review-workspace-integrity',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.review', 'project.verify', 'human.approval', 'code.implement'], deny: [] }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.review',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 12, result: { reviewEvidence: { verdict: 'PASS', summary: 'claimed safe', findings: [] } } };
    }
  };
  let verificationCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    skillExecutor,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Reject critic side effects' });
  const workspaceProject = await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture', cause: 'fixture cause', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSet = governed;
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.workspacePath = workspaceProject.workspace;
  });
  const failed = await instance.run(created.id);
  const review = failed.steps.find((step) => step.id === 'review');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(review.status, WorkflowStepStatus.FAILED);
  assert.equal(review.error, 'read_only_skill_modified_workspace');
  assert.equal(review.evidence.ok, false);
  assert.equal(review.evidence.reviewedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(verificationCalls, 0);
});

test('sensitive implementation waits for fingerprint-bound approval without rerunning the worker', async () => {
  let changeCalls = 0;
  let workerCalls = 0;
  const sensitiveChange = changedChangeSet(['package.json']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : sensitiveChange; } });
  const codingWorker = { async execute() { workerCalls += 1; return { status: 'completed', summary: 'changed package', output: '', outputBytes: 0 }; } };
  let verificationCalls = 0;
  const instance = await engine({
    localGit,
    codingWorker,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Sensitive change' });
  await prepareImplementation(instance, created.id);
  const waiting = await instance.run(created.id);
  const implementation = waiting.steps.find((step) => step.id === 'implementation');
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(implementation.status, WorkflowStepStatus.AWAITING_APPROVAL);
  assert.equal(implementation.error, 'workflow_sensitive_change_requires_approval');
  assert.equal(implementation.evidence.changePolicy.classification, 'sensitive');
  assert.equal(implementation.evidence.changeSetFingerprint, sensitiveChange.changeSetFingerprint);
  assert.equal(workerCalls, 1);
  assert.equal(verificationCalls, 0);

  const approved = await instance.approve(created.id, 'implementation');
  const approvedImplementation = approved.steps.find((step) => step.id === 'implementation');
  assert.equal(approved.status, WorkflowStepStatus.PENDING);
  assert.equal(approvedImplementation.status, WorkflowStepStatus.COMPLETED);
  assert.equal(approvedImplementation.evidence.sensitiveApproval.changeSetFingerprint, sensitiveChange.changeSetFingerprint);
  assert.equal(workerCalls, 1);
  assert.equal(verificationCalls, 0);
});

test('sensitive approval becomes stale if any governed diff changes while waiting', async () => {
  let changeCalls = 0;
  let observed = changedChangeSet(['package.json']);
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : observed;
    }
  });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'changed package', output: '', outputBytes: 0 }; } };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Reject stale sensitive approval' });
  await prepareImplementation(instance, created.id);
  const waiting = await instance.run(created.id);
  assert.equal(waiting.status, WorkflowStepStatus.AWAITING_APPROVAL);

  observed = changedChangeSet(['package.json', 'src/unapproved.js'], { contentFingerprint: '2'.repeat(64) });
  const stale = await instance.approve(created.id, 'implementation');
  const implementation = stale.steps.find((step) => step.id === 'implementation');
  assert.equal(stale.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.error, 'workflow_sensitive_approval_stale');
  assert.equal(implementation.evidence.sensitiveApproval, undefined);
  assert.equal(implementation.evidence.approvalCheck.observedChangeSetFingerprint, observed.changeSetFingerprint);
});

test('package-manager control files are immutable even for an otherwise approvable dependency change', () => {
  const configured = project();
  for (const path of ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.yarnrc', '.yarnrc.yml', 'apps/web/.npmrc']) {
    const decision = evaluateChangePolicy(configured, changedChangeSet([path]));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /forbidden_path/);
  }
});

test('normal implementation dependency stage is a no-op and requests no network capability', async () => {
  const configured = configFrom({
    id: 'dependency-noop',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.implement', 'human.approval'], deny: [] }
  });
  let runnerCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    runner: async () => { runnerCalls += 1; throw new Error('normal dependency no-op must not execute a command'); }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'No dependency refresh' });
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    const changeSet = changedChangeSet(['src/feature.js']);
    implementation.evidence.changeSet = changeSet;
    implementation.evidence.changeSetFingerprint = changeSet.changeSetFingerprint;
    implementation.evidence.changePolicy = { ok: true, classification: 'normal' };
  });
  const blockedAtReview = await instance.run(created.id);
  const dependencyRefresh = blockedAtReview.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(dependencyRefresh.status, WorkflowStepStatus.COMPLETED);
  assert.equal(dependencyRefresh.evidence.required, false);
  assert.deepEqual(dependencyRefresh.evidence.dependencyPaths, []);
  assert.equal(runnerCalls, 0);
  assert.equal(blockedAtReview.steps.find((step) => step.id === 'review').error, 'skill_not_allowed');
});

test('approved dependency change runs exactly one frozen refresh and preserves the reviewed diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-dependency-refresh-happy-'));
  const configured = managedProject('dependency-refresh-happy', root, {
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'project.dependencies.refresh', 'code.implement', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['package.json', 'package-lock.json']);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return changeSet; }
  });
  const calls = [];
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    runner: async (_project, name, options) => {
      calls.push({ name, options });
      return {
        name, ok: true, exitCode: 0, stdout: 'dependencies ready', stderr: '',
        execution: { provider: 'container', stage: 'dependency-refresh', postWorkerNetwork: 'dependency-refresh-network-enabled' }
      };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Refresh approved dependencies' });
  await instance.workspaceProject(created.id, configured);
  await prepareApprovedDependencyChange(instance, created.id, changeSet, { remote });
  const blockedAtReview = await instance.run(created.id);
  const dependencyRefresh = blockedAtReview.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(dependencyRefresh.status, WorkflowStepStatus.COMPLETED);
  assert.equal(dependencyRefresh.evidence.required, true);
  assert.equal(dependencyRefresh.evidence.command.name, 'dependencyRefresh');
  assert.equal(dependencyRefresh.evidence.command.ok, true);
  assert.equal(dependencyRefresh.evidence.execution.provider, 'container');
  assert.equal(dependencyRefresh.evidence.execution.stage, 'dependency-refresh');
  assert.equal(dependencyRefresh.evidence.execution.postWorkerNetwork, 'dependency-refresh-network-enabled');
  assert.equal(dependencyRefresh.evidence.lifecycleScripts, 'disabled');
  assert.deepEqual(dependencyRefresh.evidence.dependencyPaths, ['package-lock.json', 'package.json']);
  assert.equal(dependencyRefresh.evidence.changeSetFingerprint, changeSet.changeSetFingerprint);
  assert.deepEqual(calls.map((call) => call.name), ['dependencyRefresh']);
  assert.equal(calls[0].options.stage, 'dependency-refresh');
  assert.equal(blockedAtReview.steps.find((step) => step.id === 'review').error, 'skill_not_allowed');
});

test('nested workspace manifests and lockfiles still require governed dependency refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-nested-dependency-refresh-'));
  const configured = managedProject('nested-dependency-refresh', root, {
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'project.dependencies.refresh', 'code.implement', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['apps/web/package.json', 'packages/ui/package-lock.json']);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return changeSet; }
  });
  const calls = [];
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    runner: async (_project, name, options) => {
      calls.push({ name, options });
      return {
        name, ok: true, exitCode: 0, stdout: '', stderr: '',
        execution: { provider: 'container', stage: 'dependency-refresh', postWorkerNetwork: 'dependency-refresh-network-enabled' }
      };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Refresh nested workspace dependencies' });
  await instance.workspaceProject(created.id, configured);
  await prepareApprovedDependencyChange(instance, created.id, changeSet, { remote });
  const blockedAtReview = await instance.run(created.id);
  const dependencyRefresh = blockedAtReview.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(dependencyRefresh.status, WorkflowStepStatus.COMPLETED);
  assert.equal(dependencyRefresh.evidence.required, true);
  assert.deepEqual(dependencyRefresh.evidence.dependencyPaths, ['apps/web/package.json', 'packages/ui/package-lock.json']);
  assert.deepEqual(calls.map((call) => call.name), ['dependencyRefresh']);
});

test('approved dependency change blocks safely when no frozen refresh command is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-dependency-refresh-missing-'));
  const configured = managedProject('dependency-refresh-missing', root, {
    commands: { test: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'project.dependencies.refresh', 'code.implement', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['package.json']);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return changeSet; }
  });
  let runnerCalls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    runner: async () => { runnerCalls += 1; throw new Error('missing refresh command must block before execution'); }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Block unsupported dependency refresh' });
  await instance.workspaceProject(created.id, configured);
  await prepareApprovedDependencyChange(instance, created.id, changeSet, { remote });
  const blocked = await instance.run(created.id);
  const dependencyRefresh = blocked.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(dependencyRefresh.error, 'workflow_dependency_refresh_not_configured');
  assert.equal(runnerCalls, 0);
});

test('dependency refresh fails closed if the networked package-manager command changes governed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-dependency-refresh-mutates-'));
  const configured = managedProject('dependency-refresh-mutates', root, {
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'project.dependencies.refresh', 'code.implement', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const approved = changedChangeSet(['package.json', 'package-lock.json']);
  const mutated = changedChangeSet(['package.json', 'package-lock.json', 'src/install-side-effect.js'], { contentFingerprint: '3'.repeat(64) });
  let current = approved;
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return current; }
  });
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    runner: async (_project, name) => {
      assert.equal(name, 'dependencyRefresh');
      current = mutated;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Detect install mutation' });
  await instance.workspaceProject(created.id, configured);
  await prepareApprovedDependencyChange(instance, created.id, approved, { remote });
  const failed = await instance.run(created.id);
  const dependencyRefresh = failed.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(dependencyRefresh.error, 'workflow_dependency_refresh_modified_governed_state');
  assert.match(dependencyRefresh.evidence.error, /dependency_refresh_modified_governed_state/);
});

test('failed dependency refresh retries only within the workflow attempt budget and never calls a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-dependency-refresh-retry-'));
  const configured = managedProject('dependency-refresh-retry', root, {
    commands: { dependencyRefresh: 'npm ci --ignore-scripts', test: 'node --version' },
    execution: { provider: 'container-required', image: 'node:test' },
    toolchain: { command: 'npm' },
    skills: { allow: ['workspace.prepare', 'project.dependencies.refresh', 'code.implement', 'human.approval'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changeSet = changedChangeSet(['package.json', 'package-lock.json']);
  const remote = `https://github.com/${configured.repository.owner}/${configured.repository.name}.git`;
  const localGit = stableLocalGit({
    async inspect(project) { return { repository: project.workspace, remote, currentBranch: 'main', initialHead: 'deadbeef', status: '' }; },
    async inspectChangeSet() { return changeSet; }
  });
  let calls = 0;
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    workspaceManager: manager,
    localGit,
    runner: async (_project, name) => {
      calls += 1;
      return { name, ok: false, exitCode: 1, stdout: '', stderr: 'registry unavailable' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Bound dependency retries', budgets: { maxAttempts: 2 } });
  await instance.workspaceProject(created.id, configured);
  await prepareApprovedDependencyChange(instance, created.id, changeSet, { remote });
  const failed = await instance.run(created.id);
  const dependencyRefresh = failed.steps.find((step) => step.id === 'dependency-refresh');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(dependencyRefresh.attempts, 2);
  assert.equal(dependencyRefresh.error, 'workflow_dependency_refresh_attempt_budget_exhausted');
  assert.equal(calls, 2);
  assert.equal(failed.modelUsage.calls, 0);
});

test('implementation forbidden path and budget excess fail closed before verification', async () => {
  for (const fixture of [
    { name: 'forbidden', change: changedChangeSet(['.env']), expectedReason: /forbidden_path/ },
    { name: 'budget', change: changedChangeSet(Array.from({ length: 9 }, (_, index) => `src/file-${index}.js`)), expectedReason: /change_budget_exceeded/ }
  ]) {
    let changeCalls = 0;
    const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : fixture.change; } });
    const codingWorker = { async execute() { return { status: 'completed', summary: fixture.name, output: '', outputBytes: 0 }; } };
    let verificationCalls = 0;
    const instance = await engine({
      localGit,
      codingWorker,
      runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
    });
    const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: fixture.name });
    await prepareImplementation(instance, created.id);
    const failed = await instance.run(created.id);
    const implementation = failed.steps.find((step) => step.id === 'implementation');
    assert.equal(failed.status, WorkflowStepStatus.FAILED);
    assert.equal(implementation.error, 'workflow_change_policy_rejected');
    assert.match(failed.result.reason, fixture.expectedReason);
    assert.equal(verificationCalls, 0);
  }
});

test('implementation hard billing failure with a clean workspace blocks after one model call', async () => {
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return {
        status: 'failed',
        summary: 'billing unavailable',
        output: 'You have no credits remaining. Add credits to continue using the API.',
        outputBytes: 67
      };
    }
  };
  const instance = await engine({ localGit: stableLocalGit(), codingWorker });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'Block clean hard billing implementation failure',
    budgets: { maxAttempts: 2 }
  });
  await prepareImplementation(instance, created.id);
  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');

  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.attempts, 1);
  assert.equal(implementation.error, 'model_billing_unavailable');
  assert.equal(blocked.result.error, 'model_billing_unavailable');
  assert.equal(workerCalls, 1);
  assert.equal(blocked.modelUsage.calls, 1);
});

test('partial implementation changes still take precedence over hard billing classification', async () => {
  let changeCalls = 0;
  const partial = changedChangeSet(['src/partial-hard-billing.js']);
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : partial;
    }
  });
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return {
        status: 'failed',
        summary: 'billing unavailable after partial edit',
        output: 'You have no credits remaining. Add credits to continue using the API.',
        outputBytes: 67
      };
    }
  };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'Protect partial changes on hard billing failure',
    budgets: { maxAttempts: 2 }
  });
  await prepareImplementation(instance, created.id);
  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');

  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.attempts, 1);
  assert.equal(implementation.error, 'workflow_failed_implementation_left_changes');
  assert.equal(blocked.result.error, 'workflow_failed_implementation_left_changes');
  assert.equal(workerCalls, 1);
  assert.equal(blocked.modelUsage.calls, 1);
});

test('failed implementation that leaves changes blocks instead of retrying', async () => {
  let changeCalls = 0;
  const partial = changedChangeSet(['src/partial.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : partial; } });
  let workerCalls = 0;
  const codingWorker = { async execute() { workerCalls += 1; return { status: 'failed', summary: 'failed', output: 'worker error', outputBytes: 12 }; } };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Partial failure' });
  await prepareImplementation(instance, created.id);
  const blocked = await instance.run(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(implementation.error, 'workflow_failed_implementation_left_changes');
  assert.equal(implementation.attempts, 1);
  assert.equal(workerCalls, 1);
});

test('interrupted implementation with observed changes cannot be silently retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-interrupted-implementation-'));
  const configured = managedProject('interrupted-implementation', root, {
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'human.approval', 'project.verify'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const changed = changedChangeSet(['src/already-written.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { return changed; } });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Recover safely' });
  await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = plan.steps.find((step) => step.id === 'implementation');
    implementation.status = WorkflowStepStatus.RUNNING;
    implementation.attempts = 1;
    implementation.evidence = {
      type: 'executor-start',
      skill: implementation.skill,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      workspacePath: plan.workspace.path,
      repositoryState: { branch: configured.defaultBranch, head: 'deadbeef', remote: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` },
      workspaceBeforeFingerprint: emptyChangeSet().changeSetFingerprint,
      protectedIgnoredFingerprint: emptyProtectedIgnoredState().fingerprint,
      repositoryControlFingerprint: emptyRepositoryControlState().fingerprint
    };
    plan.status = WorkflowStepStatus.RUNNING;
  });
  const blocked = await instance.resume(created.id);
  const implementation = blocked.steps.find((step) => step.id === 'implementation');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.pausedAt, null);
  assert.equal(implementation.error, 'interrupted_implementation_changes_detected');
  assert.equal(implementation.evidence.changeSetFingerprint, changed.changeSetFingerprint);
  await assert.rejects(instance.approve(created.id, 'implementation'), /not awaiting human approval/);
});


test('interrupted change critic with observed changes cannot be approved or retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-interrupted-critic-'));
  const configured = managedProject('interrupted-critic', root, {
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    skills: { allow: ['workspace.prepare', 'code.inspect', 'code.diagnose', 'code.implement', 'code.review', 'human.approval', 'project.verify'], deny: [] }
  });
  const manager = new FakeWorkflowWorkspaceManager();
  const governed = changedChangeSet(['src/feature.js']);
  const mutated = changedChangeSet(['src/feature.js', 'src/reviewer-side-effect.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { return mutated; } });
  const instance = await engine({ projects: new Map([[configured.id, configured]]), workspaceManager: manager, localGit });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Recover critic safely' });
  await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    completeStep(plan, 'inspect-project');
    completeStep(plan, 'diagnose');
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.workspacePath = plan.workspace.path;
    implementation.evidence.repositoryState = { branch: configured.defaultBranch, head: 'deadbeef', remote: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` };
    implementation.evidence.changeSet = governed;
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.changePolicy = { ok: true, classification: 'normal' };
    implementation.evidence.workerEvidence = { status: 'completed', summary: 'fixture' };
    implementation.evidence.protectedIgnoredFingerprint = emptyProtectedIgnoredState().fingerprint;
    implementation.evidence.repositoryControlFingerprint = emptyRepositoryControlState().fingerprint;

    completeStep(plan, 'dependency-refresh');
    const review = plan.steps.find((step) => step.id === 'review');
    review.status = WorkflowStepStatus.RUNNING;
    review.attempts = 1;
    review.evidence = {
      type: 'executor-start',
      skill: review.skill,
      specialist: review.specialist,
      registryFingerprint: plan.registryFingerprint,
      projectSkillPolicyFingerprint: plan.projectSkillPolicyFingerprint,
      specialistRegistryFingerprint: plan.specialistRegistryFingerprint,
      workspacePath: plan.workspace.path,
      repositoryState: implementation.evidence.repositoryState,
      workspaceBeforeFingerprint: governed.changeSetFingerprint,
      protectedIgnoredFingerprint: emptyProtectedIgnoredState().fingerprint,
      repositoryControlFingerprint: emptyRepositoryControlState().fingerprint
    };
    plan.status = WorkflowStepStatus.RUNNING;
  });

  const blocked = await instance.resume(created.id);
  const review = blocked.steps.find((step) => step.id === 'review');
  assert.equal(blocked.status, WorkflowStepStatus.BLOCKED);
  assert.equal(blocked.pausedAt, null);
  assert.equal(review.error, 'interrupted_read_only_changes_detected');
  assert.equal(review.evidence.changeSetFingerprint, mutated.changeSetFingerprint);
  await assert.rejects(instance.approve(created.id, 'review'), /not awaiting human approval/);
});

test('implementation with no changes retries only within the workflow attempt budget', async () => {
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return { status: 'completed', summary: 'no-op', output: '', outputBytes: 0 };
    }
  };
  const instance = await engine({ localGit: stableLocalGit(), codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Require a real change', budgets: { maxAttempts: 2 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_no_changes');
  assert.equal(implementation.attempts, 2);
  assert.equal(workerCalls, 2);
});

test('implementation timeout without changes retries only within the workflow attempt budget', async () => {
  let workerCalls = 0;
  const codingWorker = {
    async execute() {
      workerCalls += 1;
      return { status: 'failed', timedOut: true, summary: 'timeout', output: 'timeout', outputBytes: 7 };
    }
  };
  const instance = await engine({ localGit: stableLocalGit(), codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Timeout safely', budgets: { maxAttempts: 2 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_timeout');
  assert.equal(implementation.attempts, 2);
  assert.equal(workerCalls, 2);
});

test('implementation output budget exhaustion stops before verification', async () => {
  let changeCalls = 0;
  const normalChange = changedChangeSet(['src/output-budget.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : normalChange; } });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'large output', output: 'x'.repeat(2_000), outputBytes: 2_000 }; } };
  let verificationCalls = 0;
  const instance = await engine({
    localGit,
    codingWorker,
    runner: async (_project, name) => { verificationCalls += 1; return { name, ok: true, exitCode: 0, stdout: '', stderr: '' }; }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Respect output budget', budgets: { maxOutputBytes: 1_024 } });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_output_budget_exhausted');
  assert.equal(verificationCalls, 0);
});

test('workflow implementation enforces allowed path scope', async () => {
  let changeCalls = 0;
  const outsideScope = changedChangeSet(['src/other/outside.js']);
  const localGit = stableLocalGit({ async inspectChangeSet() { changeCalls += 1; return changeCalls === 1 ? emptyChangeSet() : outsideScope; } });
  const codingWorker = { async execute() { return { status: 'completed', summary: 'outside scope', output: '', outputBytes: 0 }; } };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'Stay scoped',
    scope: { allowedPaths: ['src/feature'], forbiddenPaths: [] }
  });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_change_policy_rejected');
  assert.match(failed.result.reason, /scope_violation/);
});


test('verification command that mutates governed implementation diff fails closed', async () => {
  const governed = changedChangeSet(['src/feature.js'], { additions: 2, diffLines: 2, changedBytes: 64 });
  const mutated = changedChangeSet(['src/feature.js', 'src/generated.js'], { additions: 3, diffLines: 3, changedBytes: 96 });
  let changeCalls = 0;
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? governed : mutated;
    }
  });
  let commandCalls = 0;
  const configured = project();
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    runner: async (_project, name) => {
      commandCalls += 1;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Guard verification diff' });
  const workspaceProject = await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture', cause: 'fixture cause', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.changeSet = governed;
    implementation.evidence.workspacePath = workspaceProject.workspace;
    completeStep(plan, 'dependency-refresh');
  completeStep(plan, 'review');
  });
  const failed = await instance.run(created.id);
  const testsStep = failed.steps.find((step) => step.id === 'tests');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(testsStep.error, 'workflow_change_set_changed_during_verification');
  assert.equal(testsStep.evidence.expectedChangeSetFingerprint, governed.changeSetFingerprint);
  assert.equal(testsStep.evidence.observedChangeSetFingerprint, mutated.changeSetFingerprint);
  assert.equal(commandCalls, 1);
});


test('verification command that changes repository state fails closed even when the diff fingerprint is unchanged', async () => {
  const governed = changedChangeSet(['src/feature.js'], { additions: 2, diffLines: 2, changedBytes: 64 });
  let commandCalls = 0;
  const localGit = stableLocalGit({
    async inspect(project) {
      return {
        repository: project.workspace,
        remote: `https://github.com/${project.repository.owner}/${project.repository.name}.git`,
        currentBranch: commandCalls === 0 ? project.defaultBranch : 'unexpected-branch',
        initialHead: 'deadbeef',
        status: ''
      };
    },
    async inspectChangeSet() { return governed; }
  });
  const configured = project();
  const instance = await engine({
    projects: new Map([[configured.id, configured]]),
    localGit,
    runner: async (_project, name) => {
      commandCalls += 1;
      return { name, ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Guard repository identity' });
  const workspaceProject = await instance.workspaceProject(created.id, configured);
  await instance.update(created.id, (plan) => {
    const inspect = completeStep(plan, 'inspect-project');
    inspect.evidence.result = { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } };
    const diagnose = completeStep(plan, 'diagnose');
    diagnose.evidence.result = { diagnosis: { summary: 'fixture', cause: 'fixture cause', relevantPaths: ['src/core.js'], recommendedChange: 'fixture change', risks: [] } };
    completeStep(plan, 'plan-change');
    const implementation = completeStep(plan, 'implementation');
    implementation.evidence.changeSetFingerprint = governed.changeSetFingerprint;
    implementation.evidence.changeSet = governed;
    implementation.evidence.workspacePath = workspaceProject.workspace;
    implementation.evidence.repositoryState = { branch: configured.defaultBranch, head: 'deadbeef', remote: `https://github.com/${configured.repository.owner}/${configured.repository.name}.git` };
    completeStep(plan, 'dependency-refresh');
  completeStep(plan, 'review');
  });
  const failed = await instance.run(created.id);
  const testsStep = failed.steps.find((step) => step.id === 'tests');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(testsStep.error, 'workflow_change_set_integrity_failed_during_verification');
  assert.match(testsStep.evidence.error, /Unexpected current branch/);
  assert.equal(commandCalls, 1);
});


test('read-only workflow detects ignored protected-file mutation even when normal git diff is unchanged', async () => {
  const configured = configFrom({
    id: 'readonly-ignored-secret',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let ignoredCalls = 0;
  const localGit = stableLocalGit({
    async inspectProtectedIgnoredState() {
      ignoredCalls += 1;
      return ignoredCalls === 1
        ? { paths: ['.env'], fingerprint: '1'.repeat(64) }
        : { paths: ['.env'], fingerprint: '2'.repeat(64) };
    }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 12, result: { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Do not touch ignored secrets' });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.error, 'read_only_skill_modified_workspace');
  assert.equal(step.evidence.protectedIgnoredBeforeFingerprint, '1'.repeat(64));
  assert.equal(step.evidence.protectedIgnoredAfterFingerprint, '2'.repeat(64));
});

test('implementation fails if an ignored protected file changes even when normal git diff is empty', async () => {
  let ignoredCalls = 0;
  const localGit = stableLocalGit({
    async inspectProtectedIgnoredState() {
      ignoredCalls += 1;
      return ignoredCalls === 1
        ? { paths: ['.env'], fingerprint: '3'.repeat(64) }
        : { paths: ['.env'], fingerprint: '4'.repeat(64) };
    }
  });
  const codingWorker = {
    async execute() {
      return { status: 'completed', summary: 'attempted hidden change', output: '', outputBytes: 0 };
    }
  };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Protect ignored files' });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_repository_state_changed');
  assert.match(implementation.evidence.error, /protected_ignored_state_changed/);
});


test('read-only workflow detects git control-state mutation even when worktree diff is unchanged', async () => {
  const configured = configFrom({
    id: 'readonly-git-control',
    repository: { owner: 'owner', name: 'repo' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' },
    skills: { allow: ['code.inspect', 'code.diagnose', 'human.approval', 'project.verify'], deny: [] }
  });
  let controlCalls = 0;
  const localGit = stableLocalGit({
    async inspectRepositoryControlState() {
      controlCalls += 1;
      return controlCalls === 1
        ? { paths: ['config', 'info/exclude'], fingerprint: '5'.repeat(64) }
        : { paths: ['config', 'info/exclude'], fingerprint: '6'.repeat(64) };
    }
  });
  const skillExecutor = {
    supports: (skill) => skill === 'code.inspect',
    async execute() {
      return { ok: true, status: 'completed', outputBytes: 8, result: { inspectionEvidence: { summary: 'fixture', relevantPaths: ['src/core.js'], findings: ['fixture finding'] } } };
    }
  };
  const instance = await engine({ projects: new Map([[configured.id, configured]]), localGit, skillExecutor });
  const created = await instance.create({ profile: 'app-improvement', projectId: configured.id, goal: 'Do not alter git controls' });
  const failed = await instance.run(created.id);
  const step = failed.steps.find((item) => item.id === 'inspect-project');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(step.error, 'read_only_skill_modified_workspace');
  assert.equal(step.evidence.repositoryControlBeforeFingerprint, '5'.repeat(64));
  assert.equal(step.evidence.repositoryControlAfterFingerprint, '6'.repeat(64));
});

test('implementation fails if git control state changes even when normal diff is acceptable', async () => {
  let changeCalls = 0;
  let controlCalls = 0;
  const normalChange = changedChangeSet(['src/feature.js']);
  const localGit = stableLocalGit({
    async inspectChangeSet() {
      changeCalls += 1;
      return changeCalls === 1 ? emptyChangeSet() : normalChange;
    },
    async inspectRepositoryControlState() {
      controlCalls += 1;
      return controlCalls === 1
        ? { paths: ['config'], fingerprint: '7'.repeat(64) }
        : { paths: ['config'], fingerprint: '8'.repeat(64) };
    }
  });
  const codingWorker = {
    async execute() {
      return { status: 'completed', summary: 'changed git controls', output: '', outputBytes: 0 };
    }
  };
  const instance = await engine({ localGit, codingWorker });
  const created = await instance.create({ profile: 'app-improvement', projectId: 'workflow-project', goal: 'Protect git controls' });
  await prepareImplementation(instance, created.id);
  const failed = await instance.run(created.id);
  const implementation = failed.steps.find((step) => step.id === 'implementation');
  assert.equal(failed.status, WorkflowStepStatus.FAILED);
  assert.equal(implementation.error, 'workflow_implementation_repository_state_changed');
  assert.match(implementation.evidence.error, /repository_control_state_changed/);
});


test('completed human checkpoints remain bound to predecessor evidence', async () => {
  const configured = project();
  const plan = createWorkflowPlan({ profile: 'app-improvement', project: configured, goal: 'Bind human approval context' });
  completeStep(plan, 'inspect-project');
  const diagnosis = completeStep(plan, 'diagnose');
  diagnosis.evidence.result = {
    diagnosis: {
      summary: 'original',
      cause: 'fixture cause',
      relevantPaths: ['src/core.js'],
      recommendedChange: 'fixture approved change',
      risks: []
    }
  };
  const checkpoint = completeStep(plan, 'plan-change');
  assert.equal(
    checkpoint.evidence.approvedDependencyEvidenceFingerprint,
    humanApprovalDependencyFingerprint(plan, 'plan-change')
  );
  assert.equal(validateWorkflowPlan(plan, new Map([[configured.id, configured]])).ok, true);

  diagnosis.evidence.result.diagnosis.summary = 'tampered later';
  assert.throws(
    () => validateWorkflowPlan(plan, new Map([[configured.id, configured]])),
    /checkpoint approval is not bound to its predecessor evidence/
  );
});

test('approved-start deadline refresh works only for an untouched pristine workflow', async () => {
  let clock = 1_000;
  const configured = project();
  const instance = await engine({ projects: new Map([[configured.id, configured]]), now: () => clock });
  const created = await instance.create({
    profile: 'data-analysis',
    projectId: configured.id,
    goal: 'Refresh only the initial supervised wait',
    budgets: { timeoutMs: 1_000 }
  });
  clock = created.deadlineAt + 60_000;
  const refreshed = await instance.run(created.id, { refreshPristineDeadline: true });
  assert.notEqual(refreshed.result?.error, 'workflow_budget_deadline_exceeded');

  const second = await instance.create({
    profile: 'data-analysis',
    projectId: configured.id,
    goal: 'Reject non-pristine refresh',
    budgets: { timeoutMs: 1_000 }
  });
  await instance.update(second.id, (saved) => { saved.outputBytes = 1; });
  await assert.rejects(
    () => instance.run(second.id, { refreshPristineDeadline: true }),
    /workflow_start_deadline_refresh_not_pristine/
  );
});


test('workflow cancellation terminalizes a pristine workflow without executing any step', async () => {
  const workflowEngine = await engine();
  const created = await workflowEngine.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'cancel fixture'
  });

  const cancelled = await workflowEngine.cancel(created.id, { reason: 'fixture_cancelled' });
  assert.equal(cancelled.status, WorkflowStepStatus.BLOCKED);
  assert.equal(cancelled.result.error, 'fixture_cancelled');
  assert.equal(cancelled.result.stepId, 'inspect-project');
  assert.equal(cancelled.steps[0].status, WorkflowStepStatus.BLOCKED);
  assert.equal(cancelled.steps[0].error, 'fixture_cancelled');
  assert.equal(cancelled.steps[0].attempts, 0);
  assert.equal(cancelled.steps[1].status, WorkflowStepStatus.PENDING);
  assert.equal(cancelled.pausedAt, null);
  assert.deepEqual(validateWorkflowPlan(cancelled, workflowEngine.projects), { ok: true, stepCount: cancelled.steps.length, budgets: cancelled.budgets });

  const repeated = await workflowEngine.cancel(created.id, { reason: 'different_reason' });
  assert.equal(repeated.status, WorkflowStepStatus.BLOCKED);
  assert.equal(repeated.result.error, 'fixture_cancelled');
});

test('workflow cancellation reason is strictly bounded', async () => {
  const workflowEngine = await engine();
  const created = await workflowEngine.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'cancel fixture'
  });
  await assert.rejects(() => workflowEngine.cancel(created.id, { reason: '../unsafe reason' }), /workflow cancellation reason is invalid/);
});


test('historical pristine workflow can be terminalized despite registry fingerprint drift', async () => {
  const workflowEngine = await engine();
  const created = await workflowEngine.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'historical pristine recovery'
  });

  await workflowEngine.store.mutate((data) => {
    data.workflows[created.id].registryFingerprint = '1'.repeat(64);
  });

  const recovered = await workflowEngine.cancel(created.id, { reason: 'historical_fixture_cancelled' });
  assert.equal(recovered.status, WorkflowStepStatus.BLOCKED);
  assert.equal(recovered.result.error, 'historical_fixture_cancelled');
  assert.equal(recovered.result.historicalRecovery, true);
  assert.equal(recovered.steps[0].status, WorkflowStepStatus.BLOCKED);
  assert.equal(recovered.steps[0].attempts, 0);
  assert.equal(recovered.steps[0].evidence.type, 'historical-cancellation');
  assert.equal(recovered.executionLease?.kind, 'workflow');

  const persisted = await workflowEngine.get(created.id);
  assert.equal(persisted.status, WorkflowStepStatus.BLOCKED);
  assert.equal(persisted.executionLease, null);
});

test('historical workflow recovery fails closed once any execution attempt exists', async () => {
  const workflowEngine = await engine();
  const created = await workflowEngine.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'historical non-pristine recovery'
  });

  await workflowEngine.store.mutate((data) => {
    const workflow = data.workflows[created.id];
    workflow.registryFingerprint = '2'.repeat(64);
    workflow.steps[0].attempts = 1;
  });

  await assert.rejects(
    () => workflowEngine.cancel(created.id, { reason: 'historical_fixture_cancelled' }),
    /Workflow capability registry fingerprint does not match the active registry/
  );

  const unchanged = await workflowEngine.get(created.id);
  assert.equal(unchanged.status, WorkflowStepStatus.PENDING);
  assert.equal(unchanged.steps[0].status, WorkflowStepStatus.READY);
  assert.equal(unchanged.steps[0].attempts, 1);
  assert.equal(unchanged.executionLease, null);
});

test('historical workflow recovery fails closed after any model call reservation', async () => {
  const workflowEngine = await engine();
  const created = await workflowEngine.create({
    profile: 'app-improvement',
    projectId: 'workflow-project',
    goal: 'historical model-usage recovery'
  });

  await workflowEngine.store.mutate((data) => {
    const workflow = data.workflows[created.id];
    workflow.registryFingerprint = '3'.repeat(64);
    workflow.modelUsage.calls = 1;
    workflow.modelUsage.entries = [{
      id: 'model-call-1',
      status: 'failed',
      surface: 'workflow',
      skill: 'code.inspect',
      stepId: 'inspect-project',
      specialist: 'code-inspector',
      attempt: 1,
      startedAt: '2026-09-13T00:00:00.000Z',
      completedAt: '2026-09-13T00:00:01.000Z',
      usage: null
    }];
    workflow.modelUsage.unknownUsageCalls = 1;
  });

  await assert.rejects(
    () => workflowEngine.cancel(created.id, { reason: 'historical_fixture_cancelled' }),
    /Workflow capability registry fingerprint does not match the active registry/
  );

  const unchanged = await workflowEngine.get(created.id);
  assert.equal(unchanged.status, WorkflowStepStatus.PENDING);
  assert.equal(unchanged.executionLease, null);
});
