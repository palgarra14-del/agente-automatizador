import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserQaFingerprint, createBrowserQaRequest } from '../src/browser-qa.js';
import { JsonStore, WorkflowEngine, configFrom } from '../src/core.js';
import { planBrowserQaAutocorrection } from '../src/browser-qa-autocorrection.js';

const fp = char => char.repeat(64);
const commit = char => char.repeat(40);

function blueprint() {
  return {
    version: 1,
    profileId: 'beauty-salon',
    sourceBriefFingerprint: fp('a'),
    pages: [{ id: 'home', route: '/', source: 'fixture', sections: ['hero', 'services'] }],
    requiredFeatures: [],
    contentSources: { services: [], facts: [], locations: [] },
    ctas: [],
    navigation: { routes: [{ id: 'home', route: '/' }], homeAnchors: [] },
    responsiveRequirements: [], accessibilityRequirements: [],
    seoRequirements: { locationSources: [], serviceSources: [], requirements: [] },
    assets: { allowedProvenance: ['missing'], slots: [] }, forbiddenClaims: [], missingFactSources: []
  };
}

function fixture() {
  const siteBlueprint = blueprint();
  const reviewed = fp('b');
  const published = commit('c');
  const previewUrl = 'https://preview.example.test/demo';
  const request = createBrowserQaRequest({
    workflowId: 'workflow-source-12345678',
    websiteBlueprintFingerprint: browserQaFingerprint(siteBlueprint),
    reviewedChangeSetFingerprint: reviewed,
    publishedCommitSha: published,
    previewUrl,
    websiteBlueprint: siteBlueprint
  });
  const sourceWorkflow = {
    id: request.workflowId, projectId: 'website-pilot', profile: 'website-build',
    scope: { allowedPaths: ['src/app'], forbiddenPaths: ['package.json'] },
    budgets: { maxSteps: 20, maxAttempts: 2, timeoutMs: 300000, maxOutputBytes: 64000 },
    steps: [
      { id: 'requirements', status: 'completed', evidence: { websiteBlueprintFingerprint: request.websiteBlueprintFingerprint } },
      { id: 'implementation', status: 'completed', evidence: { changeSetFingerprint: reviewed } },
      { id: 'review', status: 'completed', evidence: { reviewedChangeSetFingerprint: reviewed, result: { reviewEvidence: { verdict: 'PASS' } } } },
      { id: 'publication', status: 'completed', evidence: { commit: { finalHead: published }, preview: { state: 'READY', ok: true, environment: 'preview', url: previewUrl, commitSha: published } } }
    ]
  };
  return { sourceWorkflow, request };
}

function evidenceFor(request, { status = 'defects', defects, observations = [] } = {}) {
  const base = {
    workflowId: request.workflowId,
    websiteBlueprintFingerprint: request.websiteBlueprintFingerprint,
    reviewedChangeSetFingerprint: request.reviewedChangeSetFingerprint,
    publishedCommitSha: request.publishedCommitSha,
    previewUrl: request.previewUrl,
    acceptanceSchemaVersion: request.acceptanceSchemaVersion,
    requestFingerprint: request.requestFingerprint,
    status,
    deterministicDefects: defects ?? (status === 'defects' ? [{ kind: 'horizontal_overflow', route: '/', subject: 'mobile-viewport' }] : []),
    observations
  };
  if (status === 'unavailable') base.unavailableReason = 'browser_runner_unavailable';
  return { ...base, evidenceFingerprint: browserQaFingerprint(base) };
}

test('deterministic Browser QA defects produce one bounded correction workflow spec', () => {
  const { sourceWorkflow, request } = fixture();
  const evidence = evidenceFor(request, { observations: [{ code: 'visual_taste', summary: 'Subjective spacing preference' }] });
  const decision = planBrowserQaAutocorrection({ sourceWorkflow, request, evidence });
  assert.equal(decision.status, 'create');
  assert.equal(decision.workflowInput.profile, 'app-improvement');
  assert.equal(decision.workflowInput.projectId, sourceWorkflow.projectId);
  assert.deepEqual(decision.workflowInput.scope, sourceWorkflow.scope);
  assert.match(decision.workflowInput.goal, /horizontal_overflow@\/:mobile-viewport/);
  assert.doesNotMatch(decision.workflowInput.goal, /Subjective spacing preference|visual_taste/);
  assert.match(decision.defectFingerprint, /^[a-f0-9]{64}$/);
});

test('pass, unavailable, and observation-only evidence cannot authorize correction', () => {
  const { sourceWorkflow, request } = fixture();
  assert.equal(planBrowserQaAutocorrection({ sourceWorkflow, request, evidence: evidenceFor(request, { status: 'pass', observations: [{ code: 'taste', summary: 'Could be prettier' }] }) }).reason, 'browser_qa_passed');
  assert.equal(planBrowserQaAutocorrection({ sourceWorkflow, request, evidence: evidenceFor(request, { status: 'unavailable' }) }).reason, 'deterministic_defects_required');
});

test('stale preview/commit bindings block instead of creating a correction', () => {
  const { sourceWorkflow, request } = fixture();
  const staleRequest = { ...request, publishedCommitSha: commit('d') };
  const base = evidenceFor(request);
  const staleBase = { ...base, publishedCommitSha: staleRequest.publishedCommitSha };
  delete staleBase.evidenceFingerprint;
  const staleEvidence = { ...staleBase, evidenceFingerprint: browserQaFingerprint(staleBase) };
  assert.equal(planBrowserQaAutocorrection({ sourceWorkflow, request: staleRequest, evidence: staleEvidence }).reason, 'stale_source_binding');
});

test('duplicate evidence is idempotent while any second iteration is blocked', () => {
  const { sourceWorkflow, request } = fixture();
  const evidence = evidenceFor(request);
  const first = planBrowserQaAutocorrection({ sourceWorkflow, request, evidence });
  const record = { evidenceFingerprint: evidence.evidenceFingerprint, correctionWorkflowId: 'workflow-fix-12345678' };
  assert.deepEqual(planBrowserQaAutocorrection({ sourceWorkflow, request, evidence, existingRecord: record }), { status: 'duplicate', reason: 'duplicate_evidence', correctionWorkflowId: record.correctionWorkflowId });
  const changed = evidenceFor(request, { defects: [{ kind: 'missing_required_metadata', route: '/', subject: 'description' }] });
  assert.equal(planBrowserQaAutocorrection({ sourceWorkflow, request, evidence: changed, existingRecord: record }).reason, 'second_iteration_forbidden');
  assert.equal(planBrowserQaAutocorrection({ sourceWorkflow, request, evidence, sourceIsCorrection: true }).reason, 'second_iteration_forbidden');
  assert.equal(first.status, 'create');
});

test('oversized deterministic evidence fails closed', () => {
  const { sourceWorkflow, request } = fixture();
  const defects = Array.from({ length: 17 }, (_, index) => ({ kind: 'missing_required_section', route: '/', subject: `section-${index}` }));
  assert.throws(() => planBrowserQaAutocorrection({ sourceWorkflow, request, evidence: evidenceFor(request, { defects }) }), /defects_unbounded/);
});

test('WorkflowEngine creates exactly one persisted correction under concurrent duplicate evidence', async () => {
  const { sourceWorkflow, request } = fixture();
  const evidence = evidenceFor(request, { observations: [{ code: 'taste', summary: 'Do not pass this to correction' }] });
  const root = await mkdtemp(join(tmpdir(), 'browser-qa-autocorrect-'));
  const store = new JsonStore(join(root, 'state.json'));
  const configured = configFrom({
    id: 'website-pilot',
    repository: { owner: 'owner', name: 'website' },
    defaultBranch: 'main', protectedBranches: ['main'], workspace: '..',
    commands: { test: 'node --version', typecheck: 'node --version', lint: 'node --version', build: 'node --version' },
    execution: { provider: 'local-sanitized' }
  }, join(root, 'config'));
  const instance = new WorkflowEngine({ store, projects: new Map([[configured.id, configured]]) });
  await store.mutate(data => { data.workflows = { [sourceWorkflow.id]: sourceWorkflow }; });
  const [left, right] = await Promise.all([
    instance.createBrowserQaAutocorrection({ sourceWorkflowId: sourceWorkflow.id, request, evidence }),
    instance.createBrowserQaAutocorrection({ sourceWorkflowId: sourceWorkflow.id, request, evidence })
  ]);
  assert.deepEqual([left.status, right.status].sort(), ['created', 'duplicate']);
  const created = left.status === 'created' ? left : right;
  assert.equal(created.correctionWorkflow.profile, 'app-improvement');
  assert.equal(created.correctionWorkflow.projectId, sourceWorkflow.projectId);
  assert.deepEqual(created.correctionWorkflow.scope, sourceWorkflow.scope);
  assert.doesNotMatch(created.correctionWorkflow.goal, /Do not pass this to correction|taste/);
  const saved = await store.load();
  const corrections = Object.values(saved.workflows).filter(workflow => workflow.profile === 'app-improvement');
  assert.equal(corrections.length, 1);
  assert.equal(saved.browserQaAutocorrections[sourceWorkflow.id].correctionWorkflowId, corrections[0].id);
  const changed = evidenceFor(request, { defects: [{ kind: 'blank_body', route: '/', subject: '/' }] });
  const blocked = await instance.createBrowserQaAutocorrection({ sourceWorkflowId: sourceWorkflow.id, request, evidence: changed });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'second_iteration_forbidden');
});
