import assert from 'node:assert/strict';
import test from 'node:test';
import {
  proxyTarget,
  resetLocatorCache,
  resolveTunnelOrigin,
  responseHeaderAllowed,
  validateTunnelOrigin
} from '../api/control-proxy.mjs';

test('stable control proxy accepts only exact quick-tunnel HTTPS origins', () => {
  assert.equal(
    validateTunnelOrigin('https://agent-control-example.trycloudflare.com\n'),
    'https://agent-control-example.trycloudflare.com'
  );
  for (const value of [
    'http://agent-control-example.trycloudflare.com',
    'https://trycloudflare.com.evil.example',
    'https://user:pass@agent-control-example.trycloudflare.com',
    'https://agent-control-example.trycloudflare.com/path',
    'https://127.0.0.1'
  ]) assert.throws(() => validateTunnelOrigin(value), /control_locator_origin_invalid/);
});

test('stable control proxy resolves the locator gist without credentials and caches it briefly', async () => {
  resetLocatorCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return { files: { 'tunnel-url': { content: 'https://fresh-control.trycloudflare.com\n' } } };
      }
    };
  };
  const options = { fetchImpl, now: 10_000, gistId: 'a'.repeat(32) };
  assert.equal(await resolveTunnelOrigin(options), 'https://fresh-control.trycloudflare.com');
  assert.equal(await resolveTunnelOrigin({ ...options, now: 15_000 }), 'https://fresh-control.trycloudflare.com');
  assert.equal(calls, 1);
});

test('stable control proxy preserves path and query while removing its internal route parameter', () => {
  const target = proxyTarget(
    '/api/status?refresh=1&__path=api/status',
    'https://fresh-control.trycloudflare.com'
  );
  assert.equal(target.toString(), 'https://fresh-control.trycloudflare.com/api/status?refresh=1');
});

test('stable control proxy strips transport encoding after fetch has decoded the upstream body', () => {
  for (const header of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) {
    assert.equal(responseHeaderAllowed(header), false);
  }
  assert.equal(responseHeaderAllowed('content-type'), true);
  assert.equal(responseHeaderAllowed('cache-control'), true);
});
