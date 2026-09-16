import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserQaAutocorrectionCoordinator,
  createBrowserQaCorrectionRequest,
  validateBrowserQaCorrectionRequest
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

function snapshotFor(request, {
  missingSection = false,
  overflow = false,
  observations = []
} = {}) {
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

function defectEvidence(request, options = { missingSection: true }) {
  return classifyBrowserQaSnapshot(request, snapshotFor(request, options));
}

function passEvidence(request, observations = []) {
  return classifyBrowserQaSnapshot(request, snapshotFor(request, { observations }));
}

const allowedPaths = ['site/assets/site.css', 'site/index.html'];

test('correction request is stable, canonical and preserves the original allowed paths exactly', () => {
  const request = requestFor();
  const evidence = defectEvidence(request);
  const a = createBrowserQaCorrectionRequest({
    request,
    evidence,
    allowedPaths: ['site/assets/site.css', 'site/index.html', 'site/index.html']
  });
  const b = createBrowserQaCorrectionRequest({ request, evidence, allowedPaths });
  assert.deepEqual(a, b);
  assert.deepEqual(a.allowedPaths, allowedPaths);
  assert.equal(a.iteration, 1);
  assert.equal(a.forbiddenAuthority.includes('merge'), true);
  assert.equal(a.forbiddenAuthority.includes('production-deploy'), true);
  assert.equal(a.forbiddenAuthority.includes('dependency-change'), true);
  assert.equal(validateBrowserQaCorrectionRequest(a), true);
  assert.throws(() => createBrowserQaCorrectionRequest({
    request,
    evidence,
    allowedPaths: ['../escape']
  }), /scope_path_invalid/);
});

test('PASS, unavailable and judgment-only initial evidence never schedule autocorrection', () => {
  const request = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();

  assert.deepEqual(coordinator.considerInitial({
    request,
    evidence: passEvidence(request),
    allowedPaths
  }), {
    status: 'no_correction',
    reason: 'browser_qa_pass',
    evidenceFingerprint: passEvidence(request).evidenceFingerprint
  });

  const reviewEvidence = passEvidence(request, [{ code: 'visual-balance', summary: 'Human review recommended.' }]);
  assert.deepEqual(coordinator.considerInitial({
    request,
    evidence: reviewEvidence,
    allowedPaths
  }), {
    status: 'review_only',
    reason: 'judgment_observations',
    evidenceFingerprint: reviewEvidence.evidenceFingerprint
  });

  const unavailable = unavailableBrowserQaEvidence(request, 'browser_runner_error');
  assert.deepEqual(coordinator.considerInitial({
    request,
    evidence: unavailable,
    allowedPaths
  }), {
    status: 'blocked',
    reason: 'browser_qa_unavailable',
    evidenceFingerprint: unavailable.evidenceFingerprint
  });
});

test('deterministic defects schedule exactly one idempotent correction request', () => {
  const request = requestFor();
  const evidence = defectEvidence(request);
  const coordinator = new BrowserQaAutocorrectionCoordinator();

  const first = coordinator.considerInitial({ request, evidence, allowedPaths });
  assert.equal(first.status, 'correction_requested');
  assert.equal(first.duplicate, false);
  assert.equal(first.correctionRequest.iteration, 1);

  const duplicate = coordinator.considerInitial({
    request,
    evidence,
    allowedPaths: [...allowedPaths].reverse()
  });
  assert.equal(duplicate.status, 'correction_requested');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.correctionRequest, first.correctionRequest);

  const changedEvidence = defectEvidence(request, { missingSection: false, overflow: true });
  assert.throws(() => coordinator.considerInitial({
    request,
    evidence: changedEvidence,
    allowedPaths
  }), /cycle_already_started/);
});

test('forged correction fingerprint and stale preview binding fail closed', () => {
  const request = requestFor();
  const evidence = defectEvidence(request);
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({ request, evidence, allowedPaths });

  const forged = JSON.parse(JSON.stringify(scheduled.correctionRequest));
  forged.correctionFingerprint = 'f'.repeat(64);
  assert.throws(() => validateBrowserQaCorrectionRequest(forged), /fingerprint_mismatch/);

  assert.throws(() => coordinator.bindCorrectedPreview({
    correctionRequest: scheduled.correctionRequest,
    request
  }), /preview_not_changed/);
});

test('corrected PASS resolves and duplicate final evidence is idempotent', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({
    request: initial,
    evidence: defectEvidence(initial),
    allowedPaths
  });
  const corrected = requestFor({
    commit: '2'.repeat(40),
    change: 'c'.repeat(64),
    preview: 'https://preview.example.com/build-2'
  });
  const binding = coordinator.bindCorrectedPreview({
    correctionRequest: scheduled.correctionRequest,
    request: corrected
  });
  assert.equal(binding.status, 'correction_bound');

  const evidence = passEvidence(corrected);
  const decision = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence
  });
  assert.equal(decision.status, 'resolved');
  assert.equal(decision.reason, 'browser_qa_pass');

  const duplicate = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence
  });
  assert.deepEqual(duplicate, decision);
});

test('corrected PASS with judgment observations remains review-required without another correction', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({
    request: initial,
    evidence: defectEvidence(initial),
    allowedPaths
  });
  const corrected = requestFor({
    commit: '3'.repeat(40),
    change: 'd'.repeat(64),
    preview: 'https://preview.example.com/build-3'
  });
  coordinator.bindCorrectedPreview({ correctionRequest: scheduled.correctionRequest, request: corrected });
  const decision = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence: passEvidence(corrected, [{ code: 'visual-review', summary: 'Needs human taste review.' }])
  });
  assert.equal(decision.status, 'resolved_review_required');
  assert.equal(decision.reason, 'judgment_observations');
});

test('identical defects after correction block instead of looping', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const initialEvidence = defectEvidence(initial);
  const scheduled = coordinator.considerInitial({ request: initial, evidence: initialEvidence, allowedPaths });
  const corrected = requestFor({
    commit: '4'.repeat(40),
    change: 'e'.repeat(64),
    preview: 'https://preview.example.com/build-4'
  });
  coordinator.bindCorrectedPreview({ correctionRequest: scheduled.correctionRequest, request: corrected });
  const decision = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence: defectEvidence(corrected)
  });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.reason, 'identical_defects_after_correction');
});

test('changed defects after correction block at the one-iteration limit', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({
    request: initial,
    evidence: defectEvidence(initial),
    allowedPaths
  });
  const corrected = requestFor({
    commit: '5'.repeat(40),
    change: 'f'.repeat(64),
    preview: 'https://preview.example.com/build-5'
  });
  coordinator.bindCorrectedPreview({ correctionRequest: scheduled.correctionRequest, request: corrected });
  const decision = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence: defectEvidence(corrected, { missingSection: false, overflow: true })
  });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.reason, 'correction_iteration_limit');
});

test('corrected unavailable evidence blocks and old evidence cannot satisfy the rebound phase', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const initialEvidence = defectEvidence(initial);
  const scheduled = coordinator.considerInitial({ request: initial, evidence: initialEvidence, allowedPaths });
  const corrected = requestFor({
    commit: '6'.repeat(40),
    change: '1'.repeat(64),
    preview: 'https://preview.example.com/build-6'
  });
  coordinator.bindCorrectedPreview({ correctionRequest: scheduled.correctionRequest, request: corrected });

  assert.throws(() => coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: initial,
    evidence: initialEvidence
  }), /evidence_stale/);

  const unavailable = unavailableBrowserQaEvidence(corrected, 'browser_runner_error');
  const decision = coordinator.considerCorrected({
    correctionFingerprint: scheduled.correctionRequest.correctionFingerprint,
    request: corrected,
    evidence: unavailable
  });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.reason, 'corrected_browser_qa_unavailable');
});

test('correction preview cannot change workflow/blueprint identity or reuse the reviewed change fingerprint', () => {
  const initial = requestFor();
  const coordinator = new BrowserQaAutocorrectionCoordinator();
  const scheduled = coordinator.considerInitial({
    request: initial,
    evidence: defectEvidence(initial),
    allowedPaths
  });

  const sameChange = requestFor({
    commit: '7'.repeat(40),
    change: initial.reviewedChangeSetFingerprint,
    preview: 'https://preview.example.com/build-7'
  });
  assert.throws(() => coordinator.bindCorrectedPreview({
    correctionRequest: scheduled.correctionRequest,
    request: sameChange
  }), /change_fingerprint_not_changed/);

  const changedBlueprint = blueprint({ section: 'different' });
  const differentBlueprintRequest = requestFor({
    commit: '8'.repeat(40),
    change: '8'.repeat(64),
    preview: 'https://preview.example.com/build-8',
    siteBlueprint: changedBlueprint
  });
  assert.throws(() => coordinator.bindCorrectedPreview({
    correctionRequest: scheduled.correctionRequest,
    request: differentBlueprintRequest
  }), /blueprint_changed/);
});
