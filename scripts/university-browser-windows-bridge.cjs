/* global require, WebSocket */
const { URL: NodeURL } = require('node:url');

function fail(message) {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

function endpoint(value) {
  let url;
  try { url = new NodeURL(value); } catch { fail('cdp_endpoint_invalid'); }
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
    try { url = new NodeURL(item); } catch { fail('origin_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('origin_unsafe');
    result.add(url.origin);
  }
  return [...result].sort();
}

function allowedUrl(value, allowedOrigins) {
  let url;
  try { url = new NodeURL(value); } catch { throw new Error('url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('url_unsafe');
  if (!allowedOrigins.includes(url.origin)) throw new Error('origin_forbidden');
  url.hash = '';
  return url.toString();
}

function readNavigationUrl(value, allowedOrigins) {
  const safe = allowedUrl(value, allowedOrigins);
  const url = new NodeURL(safe);
  if (url.searchParams.has('sesskey')) throw new Error('navigation_state_token_forbidden');
  const readPaths = [
    /^\/my\/courses\.php$/,
    /^\/course\/view\.php$/,
    /^\/calendar\/view\.php$/,
    /^\/mod\/(assign|forum|resource|folder|page|book|quiz)\/view\.php$/
  ];
  if (!readPaths.some((pattern) => pattern.test(url.pathname))) {
    throw new Error('navigation_path_forbidden');
  }
  return url.toString();
}

async function getJson(url, { method = 'GET' } = {}) {
  const response = await fetch(url, { method, redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('cdp_http_' + response.status);
  return response.json();
}

async function bestEffortClose(base, id) {
  try {
    await fetch(base + '/json/close/' + encodeURIComponent(id), {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store'
    });
  } catch {
    // Best-effort temporary-tab cleanup.
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateDom(wsUrl) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(wsUrl)) throw new Error('cdp_ws_unsafe');
  const expression = "(() => ({url: location.href, title: document.title || '', readyState: document.readyState || '', text: document.body ? document.body.innerText : '', links: Array.from(document.querySelectorAll('a[href]')).slice(0,1000).map(a => ({href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim()}))}))()";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {
        // Best-effort socket cleanup.
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('cdp_timeout')), 10_000);
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

async function readLoadedDom(wsUrl, allowedOrigins) {
  let last = null;
  let signature = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await evaluateDom(wsUrl);
    let allowed = false;
    try {
      allowedUrl(last.url, allowedOrigins);
      allowed = true;
    } catch {
      // Navigation can briefly be about:blank or another intermediate page.
    }
    if (allowed && last.readyState === 'complete') {
      const nextSignature = [
        typeof last.text === 'string' ? last.text.length : 0,
        Array.isArray(last.links) ? last.links.length : 0,
        typeof last.title === 'string' ? last.title : ''
      ].join(':');
      if (nextSignature === signature) stableReads += 1;
      else {
        signature = nextSignature;
        stableReads = 0;
      }
      if (stableReads >= 2) return last;
    }
    await delay(250);
  }
  if (!last) throw new Error('cdp_page_unavailable');
  throw new Error('cdp_allowed_page_timeout');
}

function navigateCdp(wsUrl, url) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(wsUrl)) throw new Error('cdp_ws_unsafe');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {
        // Best-effort socket cleanup.
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('cdp_navigation_timeout')), 10_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1,
      method: 'Page.navigate',
      params: { url }
    })), { once: true });
    ws.addEventListener('error', () => finish(reject, new Error('cdp_navigation_error')), { once: true });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error || (msg.result && msg.result.errorText)) {
        return finish(reject, new Error('cdp_navigation_failed'));
      }
      finish(resolve);
    });
  });
}

function sanitizeLinks(rawLinks, allowedOrigins) {
  if (!Array.isArray(rawLinks)) return [];
  const seen = new Set();
  const links = [];
  for (const item of rawLinks) {
    if (!item || typeof item.href !== 'string') continue;
    let url;
    try { url = allowedUrl(item.href, allowedOrigins); } catch { continue; }
    const linkText = typeof item.text === 'string'
      ? item.text.replace(/\s+/g, ' ').trim().slice(0, 500)
      : '';
    const key = url + '\n' + linkText;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, text: linkText });
    if (links.length >= 500) break;
  }
  return links;
}

function sanitizePage(raw, targetId, allowedOrigins) {
  const url = allowedUrl(raw.url, allowedOrigins);
  return {
    targetId,
    url,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
    text: typeof raw.text === 'string' ? raw.text.slice(0, 100_000) : '',
    links: sanitizeLinks(raw.links, allowedOrigins)
  };
}

async function openTemporaryPage(base, url, allowedOrigins) {
  const safeUrl = readNavigationUrl(url, allowedOrigins);
  const created = await getJson(base + '/json/new?' + encodeURIComponent(safeUrl), { method: 'PUT' });
  const target = pageTarget(created, allowedOrigins);
  if (!target) throw new Error('temporary_target_invalid');
  try {
    await fetch(base + '/json/activate/' + encodeURIComponent(target.id), {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store'
    });
    const raw = await readLoadedDom(target.webSocketDebuggerUrl, allowedOrigins);
    return sanitizePage(raw, target.id, allowedOrigins);
  } finally {
    await bestEffortClose(base, target.id);
  }
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
        protocolVersion: typeof version['Protocol-Version'] === 'string'
          ? version['Protocol-Version'].slice(0, 50)
          : ''
      }
    };
  }

  if (action === 'read_url') {
    const url = String(process.env.UNIVERSITY_URL || '');
    if (!url || url.length > 2_000) fail('url_invalid');
    return { ok: true, page: await openTemporaryPage(base, url, allowedOrigins) };
  }

  const rawTargets = await getJson(base + '/json/list');
  if (!Array.isArray(rawTargets)) fail('targets_invalid');
  const targets = rawTargets.map((item) => pageTarget(item, allowedOrigins)).filter(Boolean);

  if (action === 'list') {
    return { ok: true, pages: targets.map((item) => ({ id: item.id, url: item.url, title: item.title })) };
  }

  if (action === 'navigate') {
    const targetId = String(process.env.UNIVERSITY_TARGET_ID || '');
    const url = String(process.env.UNIVERSITY_URL || '');
    if (!targetId || targetId.length > 300) fail('target_id_invalid');
    if (!url || url.length > 2_000) fail('url_invalid');
    const target = targets.find((item) => item.id === targetId);
    if (!target) fail('target_forbidden_or_missing');
    const safeUrl = readNavigationUrl(url, allowedOrigins);
    await navigateCdp(target.webSocketDebuggerUrl, safeUrl);
    const raw = await readLoadedDom(target.webSocketDebuggerUrl, allowedOrigins);
    return { ok: true, page: sanitizePage(raw, targetId, allowedOrigins) };
  }

  if (action === 'read') {
    const targetId = String(process.env.UNIVERSITY_TARGET_ID || '');
    if (!targetId || targetId.length > 300) fail('target_id_invalid');
    const target = targets.find((item) => item.id === targetId);
    if (!target) fail('target_forbidden_or_missing');
    const raw = await readLoadedDom(target.webSocketDebuggerUrl, allowedOrigins);
    return { ok: true, page: sanitizePage(raw, targetId, allowedOrigins) };
  }

  fail('action_invalid');
}

main()
  .then((value) => process.stdout.write(JSON.stringify(value) + '\n'))
  .catch((error) => fail(error && error.message ? error.message : 'bridge_failed'));
