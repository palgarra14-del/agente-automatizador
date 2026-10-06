import test from 'node:test'; import assert from 'node:assert/strict'; import { URL } from 'node:url';
import { BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION, BrowserQaCoordinator, browserQaFingerprint, browserQaNavigationPlan, classifyBrowserQaSnapshot, createBrowserQaRequest, normalizeBrowserQaPreviewUrl, unavailableBrowserQaEvidence, validateBrowserQaEvidence } from '../src/browser-qa.js';
function blueprint({ contactPage = true, external = null } = {}) {
  const pages = contactPage
    ? [{ id: 'home', route: '/', source: 'fixture', sections: ['hero', 'services', 'primary-cta'] }, { id: 'contacto', route: '/contacto', source: 'fixture', sections: ['contact'] }]
    : [{ id: 'home', route: '/', source: 'fixture', sections: ['hero', 'services', 'contact', 'primary-cta'] }];
  const cta = external
    ? { id: 'primary', kind: external, destination: 'provided-contact', source: `businessBrief.contact.${external}` }
    : { id: 'primary', kind: contactPage ? 'route' : 'section', destination: contactPage ? '/contacto' : '#contact', source: null };
  return {
    version: 1,
    profileId: 'beauty-salon',
    sourceBriefFingerprint: 'a'.repeat(64),
    pages,
    requiredFeatures: [],
    contentSources: { services: [], facts: [], locations: [] },
    ctas: [cta],
    navigation: {
      routes: pages.map((page) => ({ id: page.id, route: page.route })),
      homeAnchors: pages[0].sections.map((section) => `#${section}`)
    },
    responsiveRequirements: [],
    accessibilityRequirements: [],
    seoRequirements: { locationSources: [], serviceSources: [], requirements: [] },
    assets: { allowedProvenance: ['missing'], slots: [] },
    forbiddenClaims: [],
    missingFactSources: []
  };
}
function requestFor(siteBlueprint = blueprint(), overrides = {}) {
  return createBrowserQaRequest({
    workflowId: 'workflow-12345678',
    websiteBlueprintFingerprint: browserQaFingerprint(siteBlueprint),
    reviewedChangeSetFingerprint: 'b'.repeat(64),
    publishedCommitSha: 'c'.repeat(40),
    previewUrl: 'https://Preview.Example.com:443/?token=strip-me#fragment',
    acceptanceSchemaVersion: BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION,
    websiteBlueprint: siteBlueprint,
    ...overrides
  });
}
function previewUrlForRoute(request, route) {
  const preview = new URL(request.previewUrl);
  const basePath = preview.pathname === '/' ? '' : preview.pathname.replace(/\/+$/, '');
  preview.pathname = route === '/' ? (basePath || '/') : `${basePath}${route}`;
  preview.search = '';
  preview.hash = '';
  return preview.toString();
}
function hrefFor(target, request) {
  if (target.semantics === 'route') return new URL(previewUrlForRoute(request, target.destination)).pathname;
  if (target.semantics === 'anchor') return target.destination;
  if (target.destination === 'phone') return 'tel:+34123456789';
  if (target.destination === 'email') return 'mailto:demo@example.com';
  if (target.destination === 'booking') return target.expectedHref;
  return 'https://wa.me/34123456789';
}
function passingSnapshot(request, overrides = {}) {
  const homeAnchors = request.acceptance.targets
    .filter((target) => target.fromRoute === '/' && target.semantics === 'anchor')
    .map((target) => target.destination.slice(1));
  const pages = request.acceptance.pages.map((expected) => ({
    route: expected.route,
    finalUrl: previewUrlForRoute(request, expected.route),
    status: 200,
    bodyTextLength: 200,
    errorOverlay: false,
    horizontalOverflow: false,
    sections: expected.requiredSections,
    anchors: expected.route === '/' ? homeAnchors : [],
    metadata: { title: 'Demo title', description: 'Demo description' },
    interactiveControls: [{ id: 'menu', required: true, accessibleName: 'Abrir menú' }],
    targets: request.acceptance.targets
      .filter((target) => target.fromRoute === expected.route)
      .map((target) => ({ id: target.id, href: hrefFor(target, request), accessibleName: target.id }))
  }));
  return {
    previewUrl: request.previewUrl,
    publishedCommitSha: request.publishedCommitSha,
    viewport: { ...request.acceptance.mobileViewport },
    externalNavigations: [],
    pages,
    observations: [],
    ...overrides
  };
}
test('preview identity is canonical, credential-free, HTTPS-only and stable', () => {
  assert.equal(normalizeBrowserQaPreviewUrl('https://EXAMPLE.com:443/demo///?token=secret#frag'), 'https://example.com/demo');
  assert.equal(browserQaFingerprint({ b: 2, a: 1 }), browserQaFingerprint({ a: 1, b: 2 }));
  assert.throws(() => normalizeBrowserQaPreviewUrl('http://example.com'), /preview_url_unsafe/);
  assert.throws(() => normalizeBrowserQaPreviewUrl('https://user:secret@example.com/demo'), /preview_url_unsafe/);
});
test('request binds exact blueprint, reviewed change, commit, preview and schema', () => {
  const siteBlueprint = blueprint();
  const request = requestFor(siteBlueprint);
  assert.equal(request.previewUrl, 'https://preview.example.com/');
  assert.equal(request.websiteBlueprintFingerprint, browserQaFingerprint(siteBlueprint)); assert.equal(request.reviewedChangeSetFingerprint, 'b'.repeat(64));
  assert.equal(request.publishedCommitSha, 'c'.repeat(40));
  assert.equal(request.acceptanceSchemaVersion, BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION);
  assert.match(request.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => request.acceptance.pages.push({}), TypeError);
  assert.throws(() => requestFor(siteBlueprint, { websiteBlueprintFingerprint: 'd'.repeat(64) }), /blueprint_fingerprint_mismatch/);
});
test('dedicated contact route is resolved and must actually load', () => {
  const request = requestFor(blueprint({ contactPage: true }));
  const evidence = classifyBrowserQaSnapshot(request, passingSnapshot(request));
  assert.equal(evidence.status, 'pass');
  assert.deepEqual(evidence.deterministicDefects, []);
  const broken = passingSnapshot(request);
  broken.pages = broken.pages.filter((page) => page.route !== '/contacto');
  const failed = classifyBrowserQaSnapshot(request, broken);
  assert.equal(failed.status, 'defects');
  assert.ok(failed.deterministicDefects.some((item) => item.kind === 'load_failure' && item.route === '/contacto'));
  assert.ok(failed.deterministicDefects.some((item) => item.kind === 'broken_required_target' && item.subject === 'cta:primary'));
});
test('home contact anchor passes only when the anchor really exists', () => {
  const request = requestFor(blueprint({ contactPage: false }));
  assert.equal(classifyBrowserQaSnapshot(request, passingSnapshot(request)).status, 'pass');
  const broken = passingSnapshot(request);
  broken.pages[0].anchors = broken.pages[0].anchors.filter((anchor) => anchor !== 'contact');
  const evidence = classifyBrowserQaSnapshot(request, broken);
  assert.ok(evidence.deterministicDefects.some((item) => item.kind === 'broken_required_target' && item.subject === 'cta:primary'));
});
test('deterministic defects stay separate from judgment-only observations', () => {
  const request = requestFor();
  const snapshot = passingSnapshot(request, { observations: [{ code: 'z-density', summary: 'Hero feels visually dense.' }, { code: 'a-spacing', summary: 'Spacing observation.' }] });
  const evidence = classifyBrowserQaSnapshot(request, snapshot);
  assert.equal(evidence.status, 'pass');
  assert.deepEqual(evidence.deterministicDefects, []);
  assert.deepEqual(evidence.observations.map((item) => item.code), ['a-spacing', 'z-density']);
  assert.equal(classifyBrowserQaSnapshot(request, passingSnapshot(request, { observations: [...snapshot.observations].reverse() })).evidenceFingerprint, evidence.evidenceFingerprint);
  const broken = passingSnapshot(request);
  broken.pages[0].horizontalOverflow = true;
  broken.pages[0].interactiveControls[0].accessibleName = '';
  const failed = classifyBrowserQaSnapshot(request, broken);
  assert.ok(failed.deterministicDefects.some((item) => item.kind === 'horizontal_overflow'));
  assert.ok(failed.deterministicDefects.some((item) => item.kind === 'missing_accessible_name'));
});
test('snapshot must attest the exact required mobile viewport', () => {
  const request = requestFor();
  const missing = passingSnapshot(request); delete missing.viewport;
  assert.throws(() => classifyBrowserQaSnapshot(request, missing), /snapshot_viewport_invalid/);
  const wrong = passingSnapshot(request); wrong.viewport = { width: 1440, height: 900 };
  assert.throws(() => classifyBrowserQaSnapshot(request, wrong), /snapshot_viewport_mismatch/);
  const malformed = passingSnapshot(request); malformed.viewport = { width: '390', height: 844 };
  assert.throws(() => classifyBrowserQaSnapshot(request, malformed), /snapshot_viewport_invalid/);
});

test('required page booleans must be explicit before evidence can pass', () => {
  const request = requestFor();
  const missingOverlay = passingSnapshot(request); delete missingOverlay.pages[0].errorOverlay;
  assert.throws(() => classifyBrowserQaSnapshot(request, missingOverlay), /snapshot_error_overlay_invalid/);
  const missingOverflow = passingSnapshot(request); delete missingOverflow.pages[0].horizontalOverflow;
  assert.throws(() => classifyBrowserQaSnapshot(request, missingOverflow), /snapshot_horizontal_overflow_invalid/);
  const nonBoolean = passingSnapshot(request); nonBoolean.pages[0].horizontalOverflow = 0;
  assert.throws(() => classifyBrowserQaSnapshot(request, nonBoolean), /snapshot_horizontal_overflow_invalid/);
});

test('external navigation audit is mandatory and cannot be omitted', () => {
  const request = requestFor();
  const missing = passingSnapshot(request); delete missing.externalNavigations;
  assert.throws(() => classifyBrowserQaSnapshot(request, missing), /external_navigations_invalid/);
  const malformed = passingSnapshot(request); malformed.externalNavigations = {};
  assert.throws(() => classifyBrowserQaSnapshot(request, malformed), /external_navigations_invalid/);
});

test('serialized request acceptance cannot be weakened after fingerprinting', () => {
  const original = requestFor();
  const serialized = JSON.parse(JSON.stringify(original));
  serialized.acceptance.pages = [];
  serialized.acceptance.targets = [];
  serialized.acceptance.mobileViewport = { width: 1440, height: 900 };
  const snapshot = passingSnapshot(original);
  snapshot.pages = [];
  const evidence = classifyBrowserQaSnapshot(serialized, snapshot);
  assert.equal(evidence.status, 'defects');
  assert.ok(evidence.deterministicDefects.some((item) => item.kind === 'load_failure' && item.route === '/'));
  const desktopSnapshot = passingSnapshot(original); desktopSnapshot.viewport = { width: 1440, height: 900 };
  assert.throws(() => classifyBrowserQaSnapshot(serialized, desktopSnapshot), /snapshot_viewport_mismatch/);
});

test('interactive-control audit is mandatory', () => {
  const request = requestFor();
  const missing = passingSnapshot(request); delete missing.pages[0].interactiveControls;
  assert.throws(() => classifyBrowserQaSnapshot(request, missing), /snapshot_interactive_controls_invalid/);
  const malformed = passingSnapshot(request); malformed.pages[0].interactiveControls = {};
  assert.throws(() => classifyBrowserQaSnapshot(request, malformed), /snapshot_interactive_controls_invalid/);
});

test('every reported interactive control requires an accessible name regardless of runner flags', () => {
  const request = requestFor();
  const snapshot = passingSnapshot(request);
  snapshot.pages[0].interactiveControls = [{ id: 'optional-looking', required: false, accessibleName: '' }];
  const evidence = classifyBrowserQaSnapshot(request, snapshot);
  assert.equal(evidence.status, 'defects');
  assert.ok(evidence.deterministicDefects.some((item) => item.kind === 'missing_accessible_name' && item.subject === 'optional-looking'));
});

test('malformed route href becomes a deterministic broken-target defect', () => {
  const request = requestFor(blueprint({ contactPage: true }));
  const snapshot = passingSnapshot(request);
  const target = snapshot.pages[0].targets.find((item) => item.id === 'cta:primary');
  target.href = '/bad%2Froute';
  const evidence = classifyBrowserQaSnapshot(request, snapshot);
  assert.equal(evidence.status, 'defects');
  assert.ok(evidence.deterministicDefects.some((item) => item.kind === 'broken_required_target' && item.subject === 'cta:primary'));
});

test('same-page anchors are compared by URL semantics instead of raw spelling', () => {
  const request = requestFor(blueprint({ contactPage: false }));
  const absolute = passingSnapshot(request);
  absolute.pages[0].targets.find((item) => item.id === 'cta:primary').href = 'https://preview.example.com/#contact';
  assert.equal(classifyBrowserQaSnapshot(request, absolute).status, 'pass');
  const rooted = passingSnapshot(request);
  rooted.pages[0].targets.find((item) => item.id === 'cta:primary').href = '/#contact';
  assert.equal(classifyBrowserQaSnapshot(request, rooted).status, 'pass');
  const wrongRoute = passingSnapshot(request);
  wrongRoute.pages[0].targets.find((item) => item.id === 'cta:primary').href = '/other#contact';
  assert.ok(classifyBrowserQaSnapshot(request, wrongRoute).deterministicDefects.some((item) => item.subject === 'cta:primary'));
});



test('page snapshots bind the observed final URL to the expected same-origin route', () => {
  const request = requestFor(blueprint({ contactPage: true }));
  const fallback = passingSnapshot(request);
  const contact = fallback.pages.find((page) => page.route === '/contacto');
  contact.finalUrl = 'https://preview.example.com/';
  assert.throws(() => classifyBrowserQaSnapshot(request, fallback), /snapshot_final_url_route_mismatch/);

  const crossOrigin = passingSnapshot(request);
  crossOrigin.pages[0].finalUrl = 'https://evil.example/';
  assert.throws(() => classifyBrowserQaSnapshot(request, crossOrigin), /snapshot_final_url_origin_mismatch/);

  const missing = passingSnapshot(request);
  delete missing.pages[0].finalUrl;
  assert.throws(() => classifyBrowserQaSnapshot(request, missing), /snapshot_final_url_invalid/);
});

test('non-root preview base path is retained in navigation and final URL bindings', () => {
  const request = requestFor(blueprint({ contactPage: true }), {
    previewUrl: 'https://preview.example.com/previews/build-1/?token=strip#frag'
  });
  assert.equal(request.previewUrl, 'https://preview.example.com/previews/build-1');
  const plan = browserQaNavigationPlan(request);
  assert.equal(plan.previewBaseUrl, request.previewUrl);
  assert.deepEqual(plan.sameOriginPages, [
    { route: '/', url: 'https://preview.example.com/previews/build-1' },
    { route: '/contacto', url: 'https://preview.example.com/previews/build-1/contacto' }
  ]);
  assert.equal(classifyBrowserQaSnapshot(request, passingSnapshot(request)).status, 'pass');

  const rootFallback = passingSnapshot(request);
  rootFallback.pages.find((page) => page.route === '/').finalUrl = 'https://preview.example.com/';
  assert.throws(() => classifyBrowserQaSnapshot(request, rootFallback), /snapshot_final_url_route_mismatch/);

  const outsideBase = passingSnapshot(request);
  outsideBase.pages.find((page) => page.route === '/contacto').finalUrl = 'https://preview.example.com/contacto';
  assert.throws(() => classifyBrowserQaSnapshot(request, outsideBase), /snapshot_final_url_route_mismatch/);

  const escapedTarget = passingSnapshot(request);
  escapedTarget.pages[0].targets.find((target) => target.id === 'cta:primary').href = '/contacto';
  const evidence = classifyBrowserQaSnapshot(request, escapedTarget);
  assert.ok(evidence.deterministicDefects.some((item) => item.kind === 'broken_required_target' && item.subject === 'cta:primary'));
});

test('authority-bearing route strings are rejected instead of normalized to same-origin paths', () => {
  const siteBlueprint = blueprint();
  siteBlueprint.pages[1].route = '//evil.example/contacto';
  siteBlueprint.navigation.routes[1].route = '//evil.example/contacto';
  assert.throws(() => requestFor(siteBlueprint), /browser_qa_route_invalid/);

  const request = requestFor();
  const snapshot = passingSnapshot(request);
  snapshot.pages[0].route = '//evil.example/';
  assert.throws(() => classifyBrowserQaSnapshot(request, snapshot), /browser_qa_route_invalid/);
});

test('stale URL, commit and evidence binding are rejected', () => {
  const request = requestFor();
  assert.throws(() => classifyBrowserQaSnapshot(request, { ...passingSnapshot(request), previewUrl: 'https://other.example.com/' }), /snapshot_preview_mismatch/);
  assert.throws(() => classifyBrowserQaSnapshot(request, { ...passingSnapshot(request), publishedCommitSha: 'd'.repeat(40) }), /snapshot_commit_mismatch/);
  const duplicated = passingSnapshot(request); duplicated.pages.push({ ...duplicated.pages[0] });
  assert.throws(() => classifyBrowserQaSnapshot(request, duplicated), /snapshot_duplicate_route/);
  const evidence = classifyBrowserQaSnapshot(request, passingSnapshot(request));
  assert.equal(validateBrowserQaEvidence(request, evidence), true);
  assert.throws(() => validateBrowserQaEvidence(request, { ...evidence, status: 'defects' }), /status_inconsistent/);
  assert.throws(() => validateBrowserQaEvidence(request, { ...evidence, reviewedChangeSetFingerprint: 'e'.repeat(64) }), /reviewedChangeSetFingerprint_mismatch/);
});
test('duplicate evidence is idempotent and a changed commit invalidates prior active evidence', () => {
  const first = requestFor();
  const coordinator = new BrowserQaCoordinator();
  const firstEvidence = unavailableBrowserQaEvidence(first);
  assert.equal(coordinator.record(first, firstEvidence).duplicate, false);
  assert.equal(coordinator.record(first, firstEvidence).duplicate, true);
  const second = requestFor(first.websiteBlueprint, { publishedCommitSha: 'd'.repeat(40) });
  const secondEvidence = unavailableBrowserQaEvidence(second);
  const recorded = coordinator.record(second, secondEvidence);
  assert.equal(recorded.duplicate, false);
  assert.deepEqual(recorded.invalidated, [firstEvidence.evidenceFingerprint]);
});
test('verify normalizes serialized acceptance before invoking the runner', async () => {
  const original = requestFor();
  const serialized = JSON.parse(JSON.stringify(original));
  serialized.acceptance.pages.push({ route: '/private', requiredSections: [], requiredMetadata: [] });
  serialized.acceptance.targets.push({ id: 'nav-route:private', kind: 'navigation', fromRoute: '/', semantics: 'route', destination: '/private' });
  serialized.acceptance.mobileViewport = { width: 1440, height: 900 };
  let seen = null;
  const coordinator = new BrowserQaCoordinator({ runner: { async verify(args) {
    seen = args;
    return passingSnapshot(args.request);
  } } });
  const result = await coordinator.verify(serialized);
  assert.equal(result.evidence.status, 'pass');
  assert.deepEqual(seen.request.acceptance.mobileViewport, { width: 390, height: 844 });
  assert.ok(!seen.request.acceptance.pages.some((page) => page.route === '/private'));
  assert.ok(!seen.navigationPlan.sameOriginPages.some((page) => page.route === '/private'));
});

test('verify rejects fingerprint-changing request tampering before runner navigation', async () => {
  const original = requestFor();
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.previewUrl = 'https://127.0.0.1/private';
  let calls = 0;
  const coordinator = new BrowserQaCoordinator({ runner: { async verify() {
    calls += 1;
    return passingSnapshot(original);
  } } });
  await assert.rejects(() => coordinator.verify(tampered), /browser_qa_request_changed/);
  assert.equal(calls, 0);
});

test('record rejects a serialized request whose fingerprinted fields changed', () => {
  const original = requestFor();
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.publishedCommitSha = 'd'.repeat(40);
  const coordinator = new BrowserQaCoordinator();
  assert.throws(() => coordinator.record(tampered, unavailableBrowserQaEvidence(tampered)), /browser_qa_request_changed/);
});

test('record retains a defensive deep-frozen evidence copy', () => {
  const request = requestFor();
  const coordinator = new BrowserQaCoordinator();
  const mutable = JSON.parse(JSON.stringify(unavailableBrowserQaEvidence(request)));
  const recorded = coordinator.record(request, mutable);
  assert.equal(recorded.evidence.status, 'unavailable');
  assert.ok(Object.isFrozen(recorded.evidence));
  assert.ok(Object.isFrozen(recorded.evidence.deterministicDefects));
  assert.ok(Object.isFrozen(recorded.evidence.observations));
  mutable.status = 'pass';
  mutable.unavailableReason = 'mutated-after-validation';
  assert.equal(recorded.evidence.status, 'unavailable');
  assert.equal(recorded.evidence.unavailableReason, 'browser_runner_unavailable');
  assert.throws(() => { recorded.evidence.status = 'pass'; }, TypeError);

  const duplicate = coordinator.record(request, JSON.parse(JSON.stringify(unavailableBrowserQaEvidence(request))));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.evidence.status, 'unavailable');
});

test('runner unavailability fails closed and can never produce PASS', async () => {
  const request = requestFor();
  const coordinator = new BrowserQaCoordinator();
  const result = await coordinator.verify(request);
  assert.equal(result.evidence.status, 'unavailable'); assert.notEqual(result.evidence.status, 'pass');
  const throwing = new BrowserQaCoordinator({ runner: { async verify() { throw new Error('browser down'); } } });
  const failed = await throwing.verify(request);
  assert.equal(failed.evidence.status, 'unavailable');
  assert.equal(failed.evidence.unavailableReason, 'browser_runner_error');
});

test('runner verification is bounded and receives cancellation', async () => {
  const request = requestFor();
  let seenSignal = null;
  let seenTimeoutMs = null;
  const coordinator = new BrowserQaCoordinator({
    timeoutMs: 10,
    runner: {
      async verify({ signal, timeoutMs }) {
        seenSignal = signal;
        seenTimeoutMs = timeoutMs;
        return new Promise(() => {});
      }
    }
  });
  const result = await coordinator.verify(request);
  assert.equal(result.evidence.status, 'unavailable');
  assert.equal(result.evidence.unavailableReason, 'browser_runner_timeout');
  assert.equal(seenTimeoutMs, 10);
  assert.equal(seenSignal.aborted, true);
  assert.throws(() => new BrowserQaCoordinator({ timeoutMs: 0 }), /runner_timeout_invalid/);
  assert.throws(() => new BrowserQaCoordinator({ timeoutMs: 120001 }), /runner_timeout_invalid/);
});
test('verified booking CTA is exact, syntax-only, and never navigated', () => {
  const siteBlueprint = blueprint({ contactPage: false });
  siteBlueprint.ctas = [{
    id: 'primary',
    kind: 'booking',
    destination: 'https://booksy.com/es-es/12345?ref=demo',
    source: 'businessBrief.contact.bookingUrl'
  }];
  const request = requestFor(siteBlueprint);
  const plan = browserQaNavigationPlan(request);
  assert.deepEqual(plan.externalTargets, [{ id: 'cta:primary', syntaxOnly: true }]);
  assert.equal(classifyBrowserQaSnapshot(request, passingSnapshot(request)).status, 'pass');

  const wrong = passingSnapshot(request);
  wrong.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'https://booksy.com/es-es/99999?ref=demo';
  assert.ok(classifyBrowserQaSnapshot(request, wrong).deterministicDefects.some((item) =>
    item.kind === 'broken_required_target' && item.subject === 'cta:primary'
  ));
});

test('external CTA is syntax-checked but excluded from navigation and execution', async () => {
  const siteBlueprint = blueprint({ contactPage: false, external: 'whatsapp' });
  const request = requestFor(siteBlueprint);
  const plan = browserQaNavigationPlan(request);
  assert.ok(plan.externalTargets.some((target) => target.id === 'cta:primary' && target.syntaxOnly)); assert.ok(plan.sameOriginPages.some((page) => page.route === '/'));
  const snapshot = passingSnapshot(request);
  assert.equal(classifyBrowserQaSnapshot(request, snapshot).status, 'pass');
  const wrongHost = passingSnapshot(request); wrongHost.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'https://example.com/chat';
  assert.ok(classifyBrowserQaSnapshot(request, wrongHost).deterministicDefects.some((item) => item.subject === 'cta:primary'));
  const unsafe = passingSnapshot(request, { externalNavigations: ['https://wa.me/34123456789'] }); assert.throws(() => classifyBrowserQaSnapshot(request, unsafe), /external_navigation_executed/);
  const coordinator = new BrowserQaCoordinator({ runner: { async verify() { return unsafe; } } });
  const result = await coordinator.verify(request);
  assert.equal(result.evidence.status, 'unavailable');
});

test('external phone and WhatsApp CTAs require actionable recipients', () => {
  const whatsappRequest = requestFor(blueprint({ contactPage: false, external: 'whatsapp' }));

  const emptyWa = passingSnapshot(whatsappRequest);
  emptyWa.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'https://wa.me/';
  assert.ok(classifyBrowserQaSnapshot(whatsappRequest, emptyWa).deterministicDefects.some((item) => item.kind === 'broken_required_target' && item.subject === 'cta:primary'));

  const queryWa = passingSnapshot(whatsappRequest);
  queryWa.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'https://api.whatsapp.com/send?phone=34123456789';
  assert.equal(classifyBrowserQaSnapshot(whatsappRequest, queryWa).status, 'pass');

  const emptyQueryWa = passingSnapshot(whatsappRequest);
  emptyQueryWa.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'https://api.whatsapp.com/send?phone=';
  assert.ok(classifyBrowserQaSnapshot(whatsappRequest, emptyQueryWa).deterministicDefects.some((item) => item.subject === 'cta:primary'));

  const phoneRequest = requestFor(blueprint({ contactPage: false, external: 'phone' }));
  const punctuationOnly = passingSnapshot(phoneRequest);
  punctuationOnly.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'tel:---';
  assert.ok(classifyBrowserQaSnapshot(phoneRequest, punctuationOnly).deterministicDefects.some((item) => item.subject === 'cta:primary'));

  const tooShort = passingSnapshot(phoneRequest);
  tooShort.pages[0].targets.find((target) => target.id === 'cta:primary').href = 'tel:123';
  assert.ok(classifyBrowserQaSnapshot(phoneRequest, tooShort).deterministicDefects.some((item) => item.subject === 'cta:primary'));

  assert.equal(classifyBrowserQaSnapshot(phoneRequest, passingSnapshot(phoneRequest)).status, 'pass');
});
test('missing sections, metadata, blank bodies and runtime overlays are deterministic defects', () => {
  const request = requestFor();
  const snapshot = passingSnapshot(request);
  snapshot.pages[0].sections = [];
  snapshot.pages[0].metadata.title = '';
  snapshot.pages[0].bodyTextLength = 0;
  snapshot.pages[0].errorOverlay = true;
  const evidence = classifyBrowserQaSnapshot(request, snapshot);
  const kinds = new Set(evidence.deterministicDefects.map((item) => item.kind));
  for (const kind of ['missing_required_section', 'missing_required_metadata', 'blank_body', 'runtime_error_overlay']) assert.ok(kinds.has(kind), kind);
});
