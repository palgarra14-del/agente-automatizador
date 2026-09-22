import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserQaAutocorrectionCoordinator,
  createBrowserQaCorrectionPublicationEvidence,
  createBrowserQaSourceAuthorization,
  validateBrowserQaAutocorrectionState,
  validateBrowserQaCorrectionPublicationEvidence
} from '../src/browser-qa-autocorrection.js';
import {
  browserQaFingerprint,
  classifyBrowserQaSnapshot,
  createBrowserQaRequest,
  unavailableBrowserQaEvidence
} from '../src/browser-qa.js';

function blueprint({ section = 'hero' } = {}) {
  return {
    version: 1,
    profileId: 'autocorrection-test',
    sourceBriefFingerprint: 'a'.repeat(64),
    pages: [{ id: 'home', route: '/', source: 'fixture', sections: [section] }],
    requiredFeatures: [],
    contentSources: { services: [], facts: [], locations: [] },
    ctas: [],
    navigation: { routes: [], homeAnchors: [] },
    responsiveRequirements: [],
    accessibilityRequirements: [],
    seoRequirements: { locationSources: [], serviceSources: [], requirements: [] },
    assets: { allowedProvenance: ['missing'], slots: [] },
    forbiddenClaims: [],
    missingFactSources: []
  };
}

function requestFor({
  commit = '1'.repeat(40),
  change = 'b'.repeat(64),
  preview = 'https://preview.example.com/build-1',
  siteBlueprint = blueprint()
} = {}) {
  return createBrowserQaRequest({
    workflowId: 'workflow-autocorrect123',
    websiteBlueprintFingerprint: browserQaFingerprint(siteBlueprint),
    reviewedChangeSetFingerprint: change,
    publishedCommitSha: commit,
    previewUrl: preview,
    websiteBlueprint: siteBlueprint
  });
}

function snapshotFor(request, { missingSection = false, overflow = false, observations = [] } = {}) {
  const required = request.acceptance.pages[0].requiredSections;
  return {
    previewUrl: request.previewUrl,
    publishedCommitSha: request.publishedCommitSha,
    viewport: { ...request.acceptance.mobileViewport },
    externalNavigations: [],
    pages: [{
      route: '/',
      finalUrl: request.previewUrl,
      status: 200,
      bodyTextLength: 200,
      errorOverlay: false,
      horizontalOverflow: overflow,
      sections: missingSection ? [] : required,
      anchors: [],
      metadata: { title: 'Fixture title', description: 'Fixture description' },
      interactiveControls: [{ id: 'menu', accessibleName: 'Menu' }],
      targets: []
    }],
    observations
  };
}

const defectEvidence = (request, options = { missingSection: true }) =>
  classifyBrowserQaSnapshot(request, snapshotFor(request, options));
const passEvidence = (request, observations = []) =>
  classifyBrowserQaSnapshot(request, snapshotFor(request, { observations }));
const mutable = (value) => JSON.parse(JSON.stringify(value));
const allowedPaths = ['site/assets/site.css', 'site/index.html'];

function authorizationFor(request, paths = allowedPaths) {
  return createBrowserQaSourceAuthorization({
    workflowId: request.workflowId,
    sourceRequestFingerprint: request.requestFingerprint,
    allowedPaths: paths
  });
}

function startCycle() {
  const request = requestFor();
  const evidence = defectEvidence(request);
  const sourceAuthorization = authorizationFor(request);
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({ request, evidence, sourceAuthorization });
  return { request, evidence, sourceAuthorization, coordinator, scheduled };
}

function correctedBinding(cycle, {
  commit = '2'.repeat(40),
  change = 'c'.repeat(64),
  preview = 'https://preview.example.com/build-2',
  changedPaths = ['site/index.html'],
  ancestor = true
} = {}) {
  const request = requestFor({ commit, change, preview });
  const publicationEvidence = createBrowserQaCorrectionPublicationEvidence({
    correctionRequest: cycle.scheduled.correctionRequest,
    correctedCommitSha: request.publishedCommitSha,
    correctedRequestFingerprint: request.requestFingerprint,
    reviewedChangeSetFingerprint: request.reviewedChangeSetFingerprint,
    changedPaths,
    sourceAncestorVerified: ancestor
  });
  return { request, publicationEvidence };
}

test('source authorization is canonical, exact-file bounded and rejects control/broad paths', () => {
  const request = requestFor();
  const a = authorizationFor(request, [...allowedPaths].reverse());
  const b = authorizationFor(request);
  assert.deepEqual(a, b);
  for (const path of [
    'src', 'package.json', 'apps/site/package.json', '.github/workflows/ci.yml',
    'vite.config.js', 'next.config.mjs', 'tsconfig.json', 'deploy/release.sh',
    'scripts/release.mjs', 'config/site.json', '.env.production', '../escape'
  ]) {
    assert.throws(() => authorizationFor(request, [path]), /scope|sensitive|broad/);
  }
});

test('correction scope comes only from immutable source authorization and input widening is rejected', () => {
  const request = requestFor();
  const evidence = defectEvidence(request);
  const sourceAuthorization = authorizationFor(request);
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  assert.throws(() => coordinator.considerInitial({
    request, evidence, sourceAuthorization, allowedPaths: ['evil.js']
  }), /initial_input_invalid/);
  const scheduled = coordinator.considerInitial({ request, evidence, sourceAuthorization });
  assert.deepEqual(scheduled.correctionRequest.allowedPaths, allowedPaths);
  assert.equal(scheduled.correctionRequest.sourceAuthorizationFingerprint, sourceAuthorization.authorizationFingerprint);
});

test('PASS, unavailable and judgment-only evidence schedule nothing before a cycle exists', () => {
  for (const [evidence, expected] of [
    [passEvidence(requestFor()), 'no_correction'],
    [passEvidence(requestFor(), [{ code: 'visual', summary: 'Review taste.' }]), 'review_only'],
    [unavailableBrowserQaEvidence(requestFor(), 'runner_unavailable'), 'blocked']
  ]) {
    const request = requestFor();
    const normalizedEvidence = evidence.requestFingerprint === request.requestFingerprint ? evidence :
      (evidence.status === 'unavailable' ? unavailableBrowserQaEvidence(request, 'runner_unavailable') :
        passEvidence(request, evidence.observations));
    const decision = new BrowserQaAutocorrectionCoordinator().considerInitial({
      request,
      evidence: normalizedEvidence,
      sourceAuthorization: authorizationFor(request)
    });
    assert.equal(decision.status, expected);
  }
});

test('active cycle is checked before late PASS/review/unavailable fast paths', () => {
  const cycle = startCycle();
  assert.throws(() => cycle.coordinator.considerInitial({
    request: cycle.request,
    evidence: passEvidence(cycle.request),
    sourceAuthorization: cycle.sourceAuthorization
  }), /cycle_already_started/);
  assert.throws(() => cycle.coordinator.considerInitial({
    request: cycle.request,
    evidence: unavailableBrowserQaEvidence(cycle.request, 'late'),
    sourceAuthorization: cycle.sourceAuthorization
  }), /cycle_already_started/);
});

test('caller mutation after scheduling cannot rewrite source bindings', () => {
  const original = requestFor();
  const request = mutable(original);
  const evidence = mutable(defectEvidence(original));
  const sourceAuthorization = mutable(authorizationFor(original));
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({ request, evidence, sourceAuthorization });
  request.websiteBlueprintFingerprint = 'f'.repeat(64);
  request.publishedCommitSha = '9'.repeat(40);
  evidence.deterministicDefects[0].subject = 'mutated';
  sourceAuthorization.allowedPaths[0] = 'evil.js';
  assert.equal(scheduled.correctionRequest.websiteBlueprintFingerprint, original.websiteBlueprintFingerprint);
  assert.equal(scheduled.correctionRequest.sourcePublishedCommitSha, original.publishedCommitSha);
  assert.deepEqual(scheduled.correctionRequest.allowedPaths, allowedPaths);
});

test('one-iteration state survives restart and tampered serialized state fails closed', () => {
  const cycle = startCycle();
  const state = cycle.coordinator.exportState();
  assert.equal(validateBrowserQaAutocorrectionState(state), true);
  const restored = new BrowserQaAutocorrectionCoordinator({ state });
  const duplicate = restored.considerInitial({
    request: cycle.request,
    evidence: cycle.evidence,
    sourceAuthorization: cycle.sourceAuthorization
  });
  assert.equal(duplicate.status, 'correction_requested');
  assert.equal(duplicate.duplicate, true);

  const tampered = mutable(state);
  tampered.cycles[0].correctionRequest.allowedPaths[0] = 'evil.js';
  assert.throws(() => new BrowserQaAutocorrectionCoordinator({ state: tampered }), /state|scope|fingerprint|authorization/);
});

test('publication provenance must prove ancestry and exact changed-path scope', () => {
  const cycle = startCycle();
  const corrected = requestFor({ commit: '2'.repeat(40), change: 'c'.repeat(64), preview: 'https://preview.example.com/build-2' });
  assert.throws(() => createBrowserQaCorrectionPublicationEvidence({
    correctionRequest: cycle.scheduled.correctionRequest,
    correctedCommitSha: corrected.publishedCommitSha,
    correctedRequestFingerprint: corrected.requestFingerprint,
    reviewedChangeSetFingerprint: corrected.reviewedChangeSetFingerprint,
    changedPaths: ['site/index.html'],
    sourceAncestorVerified: false
  }), /ancestry_unverified/);
  assert.throws(() => createBrowserQaCorrectionPublicationEvidence({
    correctionRequest: cycle.scheduled.correctionRequest,
    correctedCommitSha: corrected.publishedCommitSha,
    correctedRequestFingerprint: corrected.requestFingerprint,
    reviewedChangeSetFingerprint: corrected.reviewedChangeSetFingerprint,
    changedPaths: ['site/other.html'],
    sourceAncestorVerified: true
  }), /out_of_scope/);
});

test('corrected preview requires correction-specific provenance and rejects unrelated bindings', () => {
  const cycle = startCycle();
  const { request, publicationEvidence } = correctedBinding(cycle);
  assert.equal(validateBrowserQaCorrectionPublicationEvidence(cycle.scheduled.correctionRequest, publicationEvidence), true);
  const unrelated = mutable(publicationEvidence);
  unrelated.correctedCommitSha = '8'.repeat(40);
  unrelated.provenanceFingerprint = browserQaFingerprint({
    version: unrelated.version,
    workflowId: unrelated.workflowId,
    correctionFingerprint: unrelated.correctionFingerprint,
    sourceCommitSha: unrelated.sourceCommitSha,
    correctedCommitSha: unrelated.correctedCommitSha,
    correctedRequestFingerprint: unrelated.correctedRequestFingerprint,
    reviewedChangeSetFingerprint: unrelated.reviewedChangeSetFingerprint,
    changedPaths: unrelated.changedPaths,
    sourceAncestorVerified: true
  });
  assert.throws(() => cycle.coordinator.bindCorrectedPreview({
    correctionRequest: cycle.scheduled.correctionRequest,
    request,
    publicationEvidence: unrelated
  }), /provenance_request_mismatch/);

  const binding = cycle.coordinator.bindCorrectedPreview({
    correctionRequest: cycle.scheduled.correctionRequest,
    request,
    publicationEvidence
  });
  assert.equal(binding.status, 'correction_bound');
  assert.equal(binding.duplicate, false);
});

test('bound cycle can be serialized, rehydrated and resolved exactly once', () => {
  const cycle = startCycle();
  const bound = correctedBinding(cycle);
  cycle.coordinator.bindCorrectedPreview({
    correctionRequest: cycle.scheduled.correctionRequest,
    request: bound.request,
    publicationEvidence: bound.publicationEvidence
  });
  const restored = new BrowserQaAutocorrectionCoordinator({ state: cycle.coordinator.exportState() });
  const evidence = passEvidence(bound.request);
  const result = restored.considerCorrected({
    correctionFingerprint: cycle.scheduled.correctionRequest.correctionFingerprint,
    request: bound.request,
    evidence
  });
  assert.equal(result.status, 'resolved');
  const duplicate = restored.considerCorrected({
    correctionFingerprint: cycle.scheduled.correctionRequest.correctionFingerprint,
    request: bound.request,
    evidence
  });
  assert.deepEqual(duplicate, result);
  assert.throws(() => restored.considerCorrected({
    correctionFingerprint: cycle.scheduled.correctionRequest.correctionFingerprint,
    request: bound.request,
    evidence: passEvidence(bound.request, [{ code: 'late', summary: 'Different evidence.' }])
  }), /cycle_finalized/);
});

test('identical and changed defects after correction both block without a second iteration', () => {
  for (const [options, reason] of [
    [{ missingSection: true }, 'identical_defects_after_correction'],
    [{ missingSection: false, overflow: true }, 'correction_iteration_limit']
  ]) {
    const cycle = startCycle();
    const bound = correctedBinding(cycle, { commit: reason.startsWith('identical') ? '3'.repeat(40) : '4'.repeat(40) });
    cycle.coordinator.bindCorrectedPreview({
      correctionRequest: cycle.scheduled.correctionRequest,
      request: bound.request,
      publicationEvidence: bound.publicationEvidence
    });
    const result = cycle.coordinator.considerCorrected({
      correctionFingerprint: cycle.scheduled.correctionRequest.correctionFingerprint,
      request: bound.request,
      evidence: defectEvidence(bound.request, options)
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, reason);
  }
});
