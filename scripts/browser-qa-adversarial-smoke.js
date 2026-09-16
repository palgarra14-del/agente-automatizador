import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { launchChromeCdpBrowser } from '../src/browser-qa-runner.js';

let speculativeConnections = 0;
let speculativeOrigin = 'http://127.0.0.1:1';
const speculativeServer = createServer((request, response) => {
  response.writeHead(204);
  response.end();
});
speculativeServer.on('connection', () => { speculativeConnections += 1; });

const server = createServer((request, response) => {
  if (request.url === '/hidden') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Hidden fixture</title><meta name="description" content="Fixture description">
<style>.ancestor-hidden{display:none}</style></head>
<body>
  <section id="hero">Hero</section>
  <a id="visible-target" href="#contact">Contact</a>
  <section id="contact" hidden>Contact</section>
  <a id="transparent-target" href="#transparent">Transparent</a>
  <div style="opacity:0"><section id="transparent">Invisible by opacity</section></div>
  <div class="ancestor-hidden">
    <a id="hidden-target" href="#contact"></a>
    <input id="hidden-control" value="secret">
  </div>
  <div aria-hidden="true"><button id="aria-hidden-control"></button></div>
  <button id="alt-button" alt="Save"></button>
  <button id="hidden-text-button"><span aria-hidden="true">Save</span></button>
  <input id="empty-button" type="button">
  <input id="default-submit" type="submit">
  <input id="default-reset" type="reset">
  <input id="name" type="text" value="Jane">
  <div id="programmatic-focus" tabindex="-1"></div>
</body></html>`);
    return;
  }
  if (request.url === '/websocket') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>WebSocket fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>
try { window.__socket = new WebSocket('ws://127.0.0.1:9/private'); } catch {}
</script>
</body></html>`);
    return;
  }
  if (request.url === '/webrtc') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>WebRTC fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>
try { window.__rtc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:9' }] }); } catch {}
</script>
</body></html>`);
    return;
  }
  if (request.url === '/webtransport') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>WebTransport fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>
try { window.__transport = new WebTransport('https://127.0.0.1:9/private'); } catch {}
</script>
</body></html>`);
    return;
  }
  if (request.url === '/history-hash') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>History hash fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>history.replaceState({}, '', '/history-hash#qa');</script>
</body></html>`);
    return;
  }
  if (request.url === '/route-link') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Route link fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><a href="/target?variant=1">Target</a></body></html>`);
    return;
  }
  if (request.url === '/target') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Target</title><meta name="description" content="Fixture description"></head><body><section id="hero">Target</section></body></html>');
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/redirected' });
    response.end();
    return;
  }
  if (request.url === '/redirected') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Redirected</title><meta name="description" content="Fixture description"></head><body><section id="hero">Redirected</section></body></html>');
    return;
  }
  if (request.url === '/history') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>History fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>history.replaceState({}, '', '/history?qa=1');</script>
</body></html>`);
    return;
  }
  if (request.url === '/closed-shadow') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Closed shadow fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><div id="closed-host"></div>
<script>
const root = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
root.innerHTML = '<button></button>';
</script></body></html>`);
    return;
  }
  if (request.url === '/frame-host') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Frame host</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><iframe src="/nested/"></iframe></body></html>`);
    return;
  }
  if (request.url === '/nested/' || request.url === '/nested') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Nested</title></head><body><a href="contact">Contact</a></body></html>');
    return;
  }
  if (request.url === '/fragment-scope') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Fragment scope</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><a href="#contact">Contact</a>
<iframe srcdoc="<div id='contact'>Nested contact only</div>"></iframe></body></html>`);
    return;
  }
  if (request.url === '/monkey-patch') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Monkey patch fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><button id="monkey-button"></button>
<script>
Document.prototype.querySelectorAll = () => [];
Document.prototype.querySelector = () => null;
Element.prototype.querySelectorAll = () => [];
Element.prototype.querySelector = () => null;
Element.prototype.getClientRects = () => [];
</script></body></html>`);
    return;
  }
  if (request.url === '/shadow-frame') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Shadow frame fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section><div id="shadow-host"></div>
<iframe id="qa-frame" srcdoc="<button id='frame-button'></button>"></iframe>
<script>
const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
root.innerHTML = '<button id="shadow-button"></button>';
</script></body></html>`);
    return;
  }
  if (request.url === '/preconnect') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Preconnect fixture</title><meta name="description" content="Fixture description">
<link rel="preconnect" href="${speculativeOrigin}">
<link rel="dns-prefetch" href="//browser-qa-blocked.invalid">
</head><body><section id="hero">Hero</section></body></html>`);
    return;
  }
  if (request.url === '/client-nav') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Client navigation fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>setTimeout(() => { location.href = '/redirected'; }, 25);</script>
</body></html>`);
    return;
  }
  if (request.url === '/frame-network') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Frame network fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<iframe srcdoc="<script>try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:9' }] }); } catch {}<\/script>"></iframe>
</body></html>`);
    return;
  }
  if (request.url === '/worker') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html><head><title>Worker fixture</title><meta name="description" content="Fixture description"></head>
<body><section id="hero">Hero</section>
<script>
const source = 'setInterval(() => {}, 1000)';
const blob = new Blob([source], { type: 'text/javascript' });
window.__qaWorker = new Worker(URL.createObjectURL(blob));
</script></body></html>`);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

speculativeServer.listen(0, '127.0.0.1');
await once(speculativeServer, 'listening');
const speculativeAddress = speculativeServer.address();
if (!speculativeAddress || typeof speculativeAddress === 'string') throw new Error('browser_qa_speculative_server_address_invalid');
speculativeOrigin = `http://127.0.0.1:${speculativeAddress.port}`;

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('browser_qa_smoke_server_address_invalid');
const origin = `http://127.0.0.1:${address.port}`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);
let browser = null;

function fixtureRequest(route, targets = [], requiredSections = ['hero']) {
  return {
    acceptance: {
      mobileViewport: { width: 390, height: 844 },
      pages: [{ route, requiredSections }],
      targets
    }
  };
}

try {
  browser = await launchChromeCdpBrowser({
    signal: controller.signal,
    timeoutMs: 10_000,
    allowedOrigin: origin
  });

  const hiddenRoute = '/hidden';
  const hiddenUrl = `${origin}${hiddenRoute}`;
  const hiddenRequest = fixtureRequest(hiddenRoute, [
    { id: 'primary', fromRoute: hiddenRoute, semantics: 'anchor', destination: '#contact' },
    { id: 'transparent', fromRoute: hiddenRoute, semantics: 'anchor', destination: '#transparent' }
  ], ['hero', 'contact', 'transparent']);
  const hiddenEvidence = await browser.inspectPage({
    request: hiddenRequest,
    pagePlan: { route: hiddenRoute, url: hiddenUrl },
    routeUrls: { [hiddenRoute]: hiddenUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 50
  });

  assert.equal(hiddenEvidence.status, 200);
  assert.deepEqual(hiddenEvidence.sections, ['hero'], 'hidden or fully transparent required sections must not count as rendered');
  assert.deepEqual(hiddenEvidence.anchors, [], 'hidden or fully transparent anchor destinations must not count as reachable');
  assert.deepEqual(hiddenEvidence.targets, [], 'visible CTA to hidden or fully transparent destination must not count as usable');
  const hiddenButtons = hiddenEvidence.interactiveControls.filter((control) => control.role === 'button');
  const hiddenTextboxes = hiddenEvidence.interactiveControls.filter((control) => control.role === 'textbox');
  assert.equal(hiddenButtons.length, 5, 'hidden ancestor/aria-hidden buttons must be absent from the accessibility audit');
  assert.ok(hiddenButtons.filter((control) => !control.accessibleName).length >= 3, 'alt-only, hidden-text and empty buttons must remain unnamed');
  assert.ok(hiddenButtons.some((control) => control.accessibleName === 'Submit'), 'default submit control should use Chrome accessible name');
  assert.ok(hiddenButtons.some((control) => control.accessibleName === 'Reset'), 'default reset control should use Chrome accessible name');
  assert.ok(hiddenTextboxes.some((control) => !control.accessibleName), 'text input value must not become its accessible name');
  assert.equal(
    hiddenEvidence.interactiveControls.some((control) => control.role === 'generic'),
    false,
    'programmatic-only tabindex=-1 generic focus target must not be treated as an interactive control'
  );

  const websocketRoute = '/websocket';
  const websocketUrl = `${origin}${websocketRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(websocketRoute),
      pagePlan: { route: websocketRoute, url: websocketUrl },
      routeUrls: { [websocketRoute]: websocketUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 50
    }),
    /browser_qa_direct_network_forbidden|browser_qa_websocket_forbidden/
  );

  const webrtcRoute = '/webrtc';
  const webrtcUrl = `${origin}${webrtcRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(webrtcRoute),
      pagePlan: { route: webrtcRoute, url: webrtcUrl },
      routeUrls: { [webrtcRoute]: webrtcUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 50
    }),
    /browser_qa_direct_network_forbidden|browser_qa_webrtc_forbidden/
  );

  const webTransportRoute = '/webtransport';
  const webTransportUrl = `${origin}${webTransportRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(webTransportRoute),
      pagePlan: { route: webTransportRoute, url: webTransportUrl },
      routeUrls: { [webTransportRoute]: webTransportUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 50
    }),
    /browser_qa_direct_network_forbidden|browser_qa_webtransport_forbidden/
  );

  const historyHashRoute = '/history-hash';
  const historyHashUrl = `${origin}${historyHashRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(historyHashRoute),
      pagePlan: { route: historyHashRoute, url: historyHashUrl },
      routeUrls: { [historyHashRoute]: historyHashUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 50
    }),
    /browser_qa_final_url_mismatch/
  );

  const routeLinkRoute = '/route-link';
  const routeLinkUrl = `${origin}${routeLinkRoute}`;
  const targetUrl = `${origin}/target`;
  const routeLinkEvidence = await browser.inspectPage({
    request: fixtureRequest(routeLinkRoute, [
      { id: 'route-target', fromRoute: routeLinkRoute, semantics: 'route', destination: '/target' }
    ]),
    pagePlan: { route: routeLinkRoute, url: routeLinkUrl },
    routeUrls: { [routeLinkRoute]: routeLinkUrl, '/target': targetUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 50
  });
  assert.deepEqual(routeLinkEvidence.targets, [], 'query-bearing required route link must not match canonical target');

  const redirectRoute = '/redirect';
  const redirectUrl = `${origin}${redirectRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(redirectRoute),
      pagePlan: { route: redirectRoute, url: redirectUrl },
      routeUrls: { [redirectRoute]: redirectUrl },
      signal: controller.signal,
      timeoutMs: 250,
      settleMs: 50
    }),
    /browser_qa_navigation_failed|browser_qa_final_url_mismatch|browser_qa_document_url_mismatch|browser_qa_runner_origin_forbidden/
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));

  const historyRoute = '/history';
  const historyUrl = `${origin}${historyRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(historyRoute),
      pagePlan: { route: historyRoute, url: historyUrl },
      routeUrls: { [historyRoute]: historyUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 50
    }),
    /browser_qa_final_url_mismatch/
  );

  const monkeyRoute = '/monkey-patch';
  const monkeyUrl = `${origin}${monkeyRoute}`;
  const monkeyEvidence = await browser.inspectPage({
    request: fixtureRequest(monkeyRoute),
    pagePlan: { route: monkeyRoute, url: monkeyUrl },
    routeUrls: { [monkeyRoute]: monkeyUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 50
  });
  assert.ok(
    monkeyEvidence.interactiveControls.some((control) => control.role === 'button' && !control.accessibleName),
    'isolated-world/Accessibility audit must ignore page monkey patches and still expose the unnamed rendered button'
  );

  const shadowFrameRoute = '/shadow-frame';
  const shadowFrameUrl = `${origin}${shadowFrameRoute}`;
  const shadowFrameEvidence = await browser.inspectPage({
    request: fixtureRequest(shadowFrameRoute),
    pagePlan: { route: shadowFrameRoute, url: shadowFrameUrl },
    routeUrls: { [shadowFrameRoute]: shadowFrameUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 150
  });
  assert.ok(
    shadowFrameEvidence.interactiveControls.filter((control) => control.role === 'button' && !control.accessibleName).length >= 2,
    'open shadow-root and same-origin iframe unnamed buttons must both be audited'
  );

  const closedShadowRoute = '/closed-shadow';
  const closedShadowUrl = `${origin}${closedShadowRoute}`;
  const closedShadowEvidence = await browser.inspectPage({
    request: fixtureRequest(closedShadowRoute),
    pagePlan: { route: closedShadowRoute, url: closedShadowUrl },
    routeUrls: { [closedShadowRoute]: closedShadowUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 100
  });
  assert.ok(
    closedShadowEvidence.interactiveControls.some((control) => control.role === 'button' && !control.accessibleName),
    'closed shadow-root unnamed button must be visible in Chrome Accessibility Tree'
  );

  const frameHostRoute = '/frame-host';
  const frameHostUrl = `${origin}${frameHostRoute}`;
  const frameHostEvidence = await browser.inspectPage({
    request: fixtureRequest(frameHostRoute, [
      { id: 'framed-route', fromRoute: frameHostRoute, semantics: 'route', destination: '/contact' }
    ]),
    pagePlan: { route: frameHostRoute, url: frameHostUrl },
    routeUrls: { [frameHostRoute]: frameHostUrl, '/contact': `${origin}/contact` },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 150
  });
  assert.deepEqual(frameHostEvidence.targets, [], 'iframe-relative href=contact must resolve to /nested/contact, not top-level /contact');

  const fragmentScopeRoute = '/fragment-scope';
  const fragmentScopeUrl = `${origin}${fragmentScopeRoute}`;
  const fragmentScopeEvidence = await browser.inspectPage({
    request: fixtureRequest(fragmentScopeRoute, [
      { id: 'fragment-target', fromRoute: fragmentScopeRoute, semantics: 'anchor', destination: '#contact' }
    ]),
    pagePlan: { route: fragmentScopeRoute, url: fragmentScopeUrl },
    routeUrls: { [fragmentScopeRoute]: fragmentScopeUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 100
  });
  assert.deepEqual(fragmentScopeEvidence.anchors, [], 'iframe-only fragment destination must not satisfy top-page anchor');
  assert.deepEqual(fragmentScopeEvidence.targets, [], 'top-page href=#contact must not resolve to iframe-only destination');

  const preconnectRoute = '/preconnect';
  const preconnectUrl = `${origin}${preconnectRoute}`;
  speculativeConnections = 0;
  const preconnectEvidence = await browser.inspectPage({
    request: fixtureRequest(preconnectRoute),
    pagePlan: { route: preconnectRoute, url: preconnectUrl },
    routeUrls: { [preconnectRoute]: preconnectUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 250
  });
  assert.equal(preconnectEvidence.status, 200);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  assert.equal(speculativeConnections, 0, 'cross-origin preconnect must not establish a speculative socket');

  const clientNavRoute = '/client-nav';
  const clientNavUrl = `${origin}${clientNavRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(clientNavRoute),
      pagePlan: { route: clientNavRoute, url: clientNavUrl },
      routeUrls: { [clientNavRoute]: clientNavUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 150
    }),
    /browser_qa_document_navigation_forbidden/,
    'blocked client-side top-frame navigation must fail Browser QA instead of leaving the original page eligible for PASS'
  );

  const frameNetworkRoute = '/frame-network';
  const frameNetworkUrl = `${origin}${frameNetworkRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(frameNetworkRoute),
      pagePlan: { route: frameNetworkRoute, url: frameNetworkUrl },
      routeUrls: { [frameNetworkRoute]: frameNetworkUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 150
    }),
    /browser_qa_direct_network_forbidden/,
    'direct-network attempt markers inside same-origin/srcdoc iframe must fail the whole run'
  );

  const workerRoute = '/worker';
  const workerUrl = `${origin}${workerRoute}`;
  await assert.rejects(
    browser.inspectPage({
      request: fixtureRequest(workerRoute),
      pagePlan: { route: workerRoute, url: workerUrl },
      routeUrls: { [workerRoute]: workerUrl },
      signal: controller.signal,
      timeoutMs: 5_000,
      settleMs: 250
    }),
    /browser_qa_secondary_target_forbidden:worker/
  );

  console.log('Browser QA adversarial Chrome smoke PASS');
} finally {
  clearTimeout(timer);
  await browser?.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await new Promise((resolvePromise) => speculativeServer.close(resolvePromise));
}
