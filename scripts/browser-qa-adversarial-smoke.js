import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { launchChromeCdpBrowser } from '../src/browser-qa-runner.js';

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
  <input id="empty-button" type="button">
  <input id="default-submit" type="submit">
  <input id="default-reset" type="reset">
  <input id="name" type="text" value="Jane">
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
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:hidden-control'), false);
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:aria-hidden-control'), false);
  const altButton = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:alt-button');
  assert.ok(altButton, 'visible button should be audited');
  assert.equal(altButton.accessibleName, '', 'button alt attribute must not be treated as an accessible name');
  const emptyButton = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:empty-button');
  assert.ok(emptyButton, 'empty type=button should be audited');
  assert.equal(emptyButton.accessibleName, '', 'empty type=button must remain unnamed');
  const defaultSubmit = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:default-submit');
  const defaultReset = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:default-reset');
  assert.ok(defaultSubmit?.accessibleName, 'default submit control should have a UA default accessible name');
  assert.ok(defaultReset?.accessibleName, 'default reset control should have a UA default accessible name');
  const textInput = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:name');
  assert.ok(textInput, 'visible text input should be audited');
  assert.equal(textInput.accessibleName, '', 'text input value must not be treated as an accessible name');

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
    /browser_qa_websocket_forbidden/
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
}
