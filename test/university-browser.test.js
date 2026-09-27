import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniversityUrlAllowed,
  createUniversityBrowserBridge,
  normalizeUniversityCdpEndpoint,
  normalizeUniversityOrigins
} from '../src/university-browser.js';

test('CDP control surface is loopback-only and bounded', () => {
  assert.equal(normalizeUniversityCdpEndpoint('http://127.0.0.1:9223/'), 'http://127.0.0.1:9223');
  assert.throws(() => normalizeUniversityCdpEndpoint('http://192.168.1.10:9223/'), /unsafe/);
  assert.throws(() => normalizeUniversityCdpEndpoint('https://127.0.0.1:9223/'), /unsafe/);
});

test('university page origins are HTTPS allowlisted', () => {
  assert.deepEqual(normalizeUniversityOrigins(['https://campus.example/a', 'https://campus.example/b']), ['https://campus.example']);
  assert.equal(assertUniversityUrlAllowed('https://campus.example/course#top', ['https://campus.example']), 'https://campus.example/course');
  assert.throws(() => assertUniversityUrlAllowed('https://evil.example/', ['https://campus.example']), /forbidden/);
  assert.throws(() => assertUniversityUrlAllowed('https://user:pass@campus.example/', ['https://campus.example']), /unsafe/);
});

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    Promise.resolve().then(() => this.emit('open', {}));
  }
  addEventListener(name, fn) {
    const values = this.listeners.get(name) || [];
    values.push(fn);
    this.listeners.set(name, values);
  }
  emit(name, event) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  send(payload) {
    const parsed = JSON.parse(payload);
    assert.equal(parsed.method, 'Runtime.evaluate');
    assert.doesNotMatch(parsed.params.expression, /cookie|localStorage|sessionStorage|input\.value/i);
    Promise.resolve().then(() => this.emit('message', {
      data: JSON.stringify({
        id: parsed.id,
        result: { result: { value: { url: 'https://campus.example/course/1', title: 'Course 1', text: 'Assignments and notices' } } }
      })
    }));
  }
  close() {}
}

function fakeFetch(url) {
  if (url.endsWith('/json/version')) {
    return Promise.resolve({ ok: true, json: async () => ({ Browser: 'Chrome/Test', 'Protocol-Version': '1.3' }) });
  }
  if (url.endsWith('/json/list')) {
    return Promise.resolve({
      ok: true,
      json: async () => [
        { id: 'campus', type: 'page', url: 'https://campus.example/course/1', title: 'Course 1', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/campus' },
        { id: 'foreign', type: 'page', url: 'https://mail.example/', title: 'Mail', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/mail' }
      ]
    });
  }
  throw new Error('unexpected URL');
}

test('bridge sees only allowlisted university tabs and reads fixed DOM text only', async () => {
  const bridge = createUniversityBrowserBridge({
    cdpEndpoint: 'http://127.0.0.1:9223',
    allowedOrigins: ['https://campus.example'],
    fetchImpl: fakeFetch,
    WebSocketImpl: FakeSocket,
    now: () => '2026-09-27T12:00:00Z'
  });
  assert.deepEqual(await bridge.status(), { ready: true, browser: 'Chrome/Test', protocolVersion: '1.3' });
  assert.deepEqual(await bridge.listReadablePages(), [{ id: 'campus', url: 'https://campus.example/course/1', title: 'Course 1' }]);
  const page = await bridge.readPage('campus');
  assert.equal(page.text, 'Assignments and notices');
  assert.equal(page.capturedAt, '2026-09-27T12:00:00Z');
  await assert.rejects(() => bridge.readPage('foreign'), /forbidden_or_missing/);
});

test('malformed CDP page data fails closed', async () => {
  class BadSocket extends FakeSocket {
    send(payload) {
      const parsed = JSON.parse(payload);
      Promise.resolve().then(() => this.emit('message', { data: JSON.stringify({ id: parsed.id, result: { result: { value: null } } }) }));
    }
  }
  const bridge = createUniversityBrowserBridge({
    cdpEndpoint: 'http://127.0.0.1:9223',
    allowedOrigins: ['https://campus.example'],
    fetchImpl: fakeFetch,
    WebSocketImpl: BadSocket
  });
  await assert.rejects(() => bridge.readPage('campus'), /result_invalid/);
});
