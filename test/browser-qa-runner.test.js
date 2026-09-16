import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChromeBrowserQaRunner,
  assertPublicNetworkUrl,
  isUnsafeNetworkAddress
} from '../src/browser-qa-runner.js';
import {
  BrowserQaCoordinator,
  browserQaFingerprint,
  browserQaNavigationPlan,
  createBrowserQaRequest
} from '../src/browser-qa.js';

function blueprint({ contactPage = true } = {}) {
  const pages = contactPage
    ? [
        { id: 'home', route: '/', source: 'fixture', sections: ['hero', 'contact'] },
        { id: 'contacto', route: '/contacto', source: 'fixture', sections: ['contact'] }
      ]
    : [{ id: 'home', route: '/', source: 'fixture', sections: ['hero', 'contact'] }];
  return {
    version: 1,
    profileId: 'runner-test',
    sourceBriefFingerprint: 'a'.repeat(64),
    pages,
    requiredFeatures: [],
    contentSources: { services: [], facts: [], locations: [] },
    ctas: [{ id: 'primary', kind: contactPage ? 'route' : 'section', destination: contactPage ? '/contacto' : '#contact', source: null }],
    navigation: {
      routes: pages.map((page) => ({ id: page.id, route: page.route })),
      homeAnchors: ['#hero', '#contact']
    },
    responsiveRequirements: [],
    accessibilityRequirements: [],
    seoRequirements: { locationSources: [], serviceSources: [], requirements: [] },
    assets: { allowedProvenance: ['missing'], slots: [] },
    forbiddenClaims: [],
    missingFactSources: []
  };
}

function requestFor({ previewUrl = 'https://preview.example.com/previews/build-1', contactPage = true } = {}) {
  const websiteBlueprint = blueprint({ contactPage });
  return createBrowserQaRequest({
    workflowId: 'workflow-runner123',
    websiteBlueprintFingerprint: browserQaFingerprint(websiteBlueprint),
    reviewedChangeSetFingerprint: 'b'.repeat(64),
    publishedCommitSha: 'c'.repeat(40),
    previewUrl,
    websiteBlueprint
  });
}

function fakePageEvidence(request, pagePlan) {
  const expected = request.acceptance.pages.find((page) => page.route === pagePlan.route);
  const targets = request.acceptance.targets
    .filter((target) => target.fromRoute === pagePlan.route)
    .map((target) => ({
      id: target.id,
      href: target.semantics === 'route'
        ? new URL(target.destination === '/' ? request.previewUrl : `${request.previewUrl.replace(/\/+$/, '')}${target.destination}`).pathname
        : target.destination,
      accessibleName: target.id
    }));
  return {
    route: pagePlan.route,
    finalUrl: pagePlan.url,
    status: 200,
    bodyTextLength: 200,
    errorOverlay: false,
    horizontalOverflow: false,
    sections: expected.requiredSections,
    anchors: request.acceptance.targets
      .filter((target) => target.fromRoute === pagePlan.route && target.semantics === 'anchor')
      .map((target) => target.destination.slice(1)),
    metadata: { title: 'Fixture', description: 'Fixture description' },
    interactiveControls: [{ id: 'control-0', accessibleName: 'Open menu' }],
    targets
  };
}

test('private, loopback, link-local and documentation addresses are rejected', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1'
  ]) assert.equal(isUnsafeNetworkAddress(address), true, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isUnsafeNetworkAddress(address), false, address);
  }
});

test('network guard resolves DNS and fails closed on private answers', async () => {
  const publicUrl = await assertPublicNetworkUrl('https://public.example/path', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }]
  });
  assert.equal(publicUrl.hostname, 'public.example');

  await assert.rejects(
    assertPublicNetworkUrl('https://private.example/path', {
      lookup: async () => [{ address: '10.0.0.2', family: 4 }]
    }),
    /private_network_forbidden/
  );
  await assert.rejects(
    assertPublicNetworkUrl('https://localhost/path', { lookup: async () => [{ address: '8.8.8.8', family: 4 }] }),
    /private_network_forbidden/
  );
  await assert.rejects(assertPublicNetworkUrl('file:///etc/passwd'), /url_unsafe/);
});

test('runner visits only coordinator-planned pages and never emits external navigations', async () => {
  const request = requestFor();
  const navigationPlan = browserQaNavigationPlan(request);
  const inspected = [];
  const guarded = [];
  let closed = false;
  const runner = new ChromeBrowserQaRunner({
    networkGuard: async (url) => { guarded.push(url); },
    browserFactory: async () => ({
      async inspectPage(args) {
        inspected.push({ route: args.pagePlan.route, url: args.pagePlan.url, routeUrls: args.routeUrls });
        return fakePageEvidence(args.request, args.pagePlan);
      },
      async close() { closed = true; }
    })
  });

  const snapshot = await runner.verify({
    request,
    navigationPlan,
    signal: new AbortController().signal,
    timeoutMs: 5_000
  });

  assert.deepEqual(inspected.map(({ route, url }) => ({ route, url })), navigationPlan.sameOriginPages);
  assert.deepEqual(guarded, navigationPlan.sameOriginPages.map((page) => page.url));
  assert.deepEqual(snapshot.externalNavigations, []);
  assert.equal(snapshot.previewUrl, request.previewUrl);
  assert.equal(snapshot.publishedCommitSha, request.publishedCommitSha);
  assert.deepEqual(snapshot.viewport, { width: 390, height: 844 });
  assert.equal(snapshot.pages.length, navigationPlan.sameOriginPages.length);
  assert.equal(closed, true);
});

test('runner rejects plan entries that escape a non-root preview base path', async () => {
  const request = requestFor();
  const plan = JSON.parse(JSON.stringify(browserQaNavigationPlan(request)));
  plan.sameOriginPages[0].url = 'https://preview.example.com/';
  let factoryCalls = 0;
  const runner = new ChromeBrowserQaRunner({
    networkGuard: async () => {},
    browserFactory: async () => {
      factoryCalls += 1;
      return { close: async () => {}, inspectPage: async () => ({}) };
    }
  });
  await assert.rejects(
    runner.verify({ request, navigationPlan: plan, signal: new AbortController().signal, timeoutMs: 5_000 }),
    /page_plan_invalid/
  );
  assert.equal(factoryCalls, 0);
});

test('coordinator timeout aborts runner and closes the ephemeral browser', async () => {
  const request = requestFor();
  let closed = false;
  let sawAbort = false;
  const runner = new ChromeBrowserQaRunner({
    networkGuard: async () => {},
    browserFactory: async () => ({
      async inspectPage({ signal }) {
        return new Promise((resolvePromise, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      async close() { closed = true; }
    })
  });
  const coordinator = new BrowserQaCoordinator({ runner, timeoutMs: 20 });
  const result = await coordinator.verify(request);
  assert.equal(result.evidence.status, 'unavailable');
  assert.equal(result.evidence.unavailableReason, 'browser_runner_timeout');
  assert.equal(sawAbort, true);
  assert.equal(closed, true);
});
