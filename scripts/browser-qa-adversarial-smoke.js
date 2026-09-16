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
  <div class="ancestor-hidden">
    <a id="hidden-target" href="#contact"></a>
    <input id="hidden-control" value="secret">
  </div>
  <div aria-hidden="true"><button id="aria-hidden-control"></button></div>
  <button id="alt-button" alt="Save"></button>
  <input id="name" type="text" value="Jane">
</body></html>`);
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
    { id: 'primary', fromRoute: hiddenRoute, semantics: 'anchor', destination: '#contact' }
  ], ['hero', 'contact']);
  const hiddenEvidence = await browser.inspectPage({
    request: hiddenRequest,
    pagePlan: { route: hiddenRoute, url: hiddenUrl },
    routeUrls: { [hiddenRoute]: hiddenUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 50
  });

  assert.equal(hiddenEvidence.status, 200);
  assert.deepEqual(hiddenEvidence.sections, ['hero'], 'hidden required section must not count as rendered');
  assert.deepEqual(hiddenEvidence.anchors, [], 'hidden anchor destination must not count as reachable');
  assert.deepEqual(hiddenEvidence.targets, [], 'visible CTA to hidden destination must not count as usable');
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:hidden-control'), false);
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:aria-hidden-control'), false);
  const altButton = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:alt-button');
  assert.ok(altButton, 'visible button should be audited');
  assert.equal(altButton.accessibleName, '', 'button alt attribute must not be treated as an accessible name');
  const textInput = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:name');
  assert.ok(textInput, 'visible text input should be audited');
  assert.equal(textInput.accessibleName, '', 'text input value must not be treated as an accessible name');

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
