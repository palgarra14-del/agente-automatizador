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
  <section id="contact">Contact</section>
  <div class="ancestor-hidden">
    <a id="hidden-target" href="#contact"></a>
    <input id="hidden-control" value="secret">
  </div>
  <div aria-hidden="true"><button id="aria-hidden-control"></button></div>
  <input id="name" type="text" value="Jane">
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

function fixtureRequest(route, targets = []) {
  return {
    acceptance: {
      mobileViewport: { width: 390, height: 844 },
      pages: [{ route, requiredSections: ['hero'] }],
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
  ]);
  const hiddenEvidence = await browser.inspectPage({
    request: hiddenRequest,
    pagePlan: { route: hiddenRoute, url: hiddenUrl },
    routeUrls: { [hiddenRoute]: hiddenUrl },
    signal: controller.signal,
    timeoutMs: 5_000,
    settleMs: 50
  });

  assert.equal(hiddenEvidence.status, 200);
  assert.deepEqual(hiddenEvidence.targets, [], 'hidden required CTA must not count as user-visible');
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:hidden-control'), false);
  assert.equal(hiddenEvidence.interactiveControls.some((control) => control.id === 'id:aria-hidden-control'), false);
  const textInput = hiddenEvidence.interactiveControls.find((control) => control.id === 'id:name');
  assert.ok(textInput, 'visible text input should be audited');
  assert.equal(textInput.accessibleName, '', 'text input value must not be treated as an accessible name');

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
  server.close();
  await once(server, 'close').catch(() => {});
}
