/* global require, WebSocket */
const { URL } = require('node:url');

function fail(message) {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('cdp_endpoint_invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) fail('cdp_endpoint_unsafe');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('cdp_port_invalid');
  if (url.pathname !== '/' && url.pathname !== '') fail('cdp_endpoint_unsafe');
  return 'http://' + url.hostname + ':' + port;
}

function origins(value) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length || items.length > 10) fail('origins_invalid');
  const result = new Set();
  for (const item of items) {
    let url;
    try { url = new URL(item); } catch { fail('origin_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('origin_unsafe');
    result.add(url.origin);
  }
  return [...result].sort();
}

function allowedUrl(value, allowedOrigins) {
  let url;
  try { url = new URL(value); } catch { fail('url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('url_unsafe');
  if (!allowedOrigins.includes(url.origin)) fail('origin_forbidden');
  url.hash = '';
  return url.toString();
}

async function getJson(url) {
  const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store' });
  if (!response.ok) fail('cdp_http_' + response.status);
  return response.json();
}

function pageTarget(raw, allowedOrigins) {
  if (!raw || raw.type !== 'page' || typeof raw.id !== 'string' || typeof raw.url !== 'string') return null;
  let url;
  try { url = allowedUrl(raw.url, allowedOrigins); } catch { return null; }
  if (typeof raw.webSocketDebuggerUrl !== 'string' ||
      !/^ws:\/\/127\.0\.0\.1:\d+\//.test(raw.webSocketDebuggerUrl)) return null;
  return {
    id: raw.id,
    url,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
    webSocketDebuggerUrl: raw.webSocketDebuggerUrl
  };
}

async function readDom(wsUrl) {
  const expression = "(() => ({url: location.href, title: document.title || '', text: document.body ? document.body.innerText : ''}))()";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* best effort */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('cdp_timeout')), 10000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false, userGesture: false }
    })), { once: true });
    ws.addEventListener('error', () => finish(reject, new Error('cdp_socket_error')), { once: true });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== 1) return;
      const value = msg && msg.result && msg.result.result && msg.result.result.value;
      if (!value || typeof value !== 'object') return finish(reject, new Error('cdp_result_invalid'));
      finish(resolve, value);
    });
  });
}

async function main() {
  const base = endpoint(process.env.UNIVERSITY_CDP_ENDPOINT || 'http://127.0.0.1:9223');
  const allowedOrigins = origins(process.env.UNIVERSITY_ALLOWED_ORIGINS);
  const action = process.env.UNIVERSITY_BRIDGE_ACTION || 'status';

  if (action === 'status') {
    const version = await getJson(base + '/json/version');
    return {
      ok: true,
      status: {
        ready: true,
        browser: typeof version.Browser === 'string' ? version.Browser.slice(0, 200) : '',
        protocolVersion: typeof version['Protocol-Version'] === 'string' ? version['Protocol-Version'].slice(0, 50) : ''
      }
    };
  }

  const rawTargets = await getJson(base + '/json/list');
  if (!Array.isArray(rawTargets)) fail('targets_invalid');
  const targets = rawTargets.map((item) => pageTarget(item, allowedOrigins)).filter(Boolean);

  if (action === 'list') {
    return { ok: true, pages: targets.map((item) => ({ id: item.id, url: item.url, title: item.title })) };
  }

  if (action === 'read') {
    const targetId = String(process.env.UNIVERSITY_TARGET_ID || '');
    if (!targetId || targetId.length > 300) fail('target_id_invalid');
    const target = targets.find((item) => item.id === targetId);
    if (!target) fail('target_forbidden_or_missing');
    const raw = await readDom(target.webSocketDebuggerUrl);
    const url = allowedUrl(raw.url, allowedOrigins);
    return {
      ok: true,
      page: {
        targetId,
        url,
        title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
        text: typeof raw.text === 'string' ? raw.text.slice(0, 100000) : ''
      }
    };
  }

  fail('action_invalid');
}

main()
  .then((value) => process.stdout.write(JSON.stringify(value) + '\n'))
  .catch((error) => fail(error && error.message ? error.message : 'bridge_failed'));
