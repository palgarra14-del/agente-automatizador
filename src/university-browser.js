const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const MAX_PAGE_TEXT = 100000;

function boundedString(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error('university_browser_' + label + '_invalid');
  }
  return value.trim();
}

export function normalizeUniversityCdpEndpoint(value) {
  let url;
  try { url = new URL(boundedString(value, 'cdp_endpoint')); }
  catch { throw new Error('university_browser_cdp_endpoint_invalid'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('university_browser_cdp_endpoint_unsafe');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('university_browser_cdp_port_invalid');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('university_browser_cdp_endpoint_unsafe');
  return 'http://' + url.hostname + ':' + port;
}

export function normalizeUniversityOrigins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) throw new Error('university_browser_origins_invalid');
  const result = new Set();
  for (const value of values) {
    let url;
    try { url = new URL(boundedString(value, 'origin')); }
    catch { throw new Error('university_browser_origin_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('university_browser_origin_unsafe');
    result.add(url.origin);
  }
  return [...result].sort();
}

export function assertUniversityUrlAllowed(value, allowedOrigins) {
  let url;
  try { url = new URL(boundedString(value, 'url')); }
  catch { throw new Error('university_browser_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('university_browser_url_unsafe');
  const origins = new Set(normalizeUniversityOrigins(allowedOrigins));
  if (!origins.has(url.origin)) throw new Error('university_browser_origin_forbidden');
  url.hash = '';
  return url.toString();
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store' });
  if (!response || !response.ok) throw new Error('university_browser_' + label + '_failed');
  return response.json();
}

function validateTarget(target, origins) {
  if (!target || target.type !== 'page' || typeof target.id !== 'string' || typeof target.url !== 'string') return null;
  let url;
  try { url = assertUniversityUrlAllowed(target.url, origins); } catch { return null; }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(target.webSocketDebuggerUrl)) return null;
  return {
    id: target.id,
    url,
    title: typeof target.title === 'string' ? target.title.slice(0, 500) : '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl
  };
}

function evaluateReadOnlyPage(webSocketUrl, { WebSocketImpl, timeoutMs = 10000 } = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('university_browser_websocket_unavailable');
  const expression = "(() => ({url: location.href, title: document.title || '', text: document.body ? document.body.innerText : ''}))()";
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketUrl);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* best-effort cleanup */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('university_browser_cdp_timeout')), timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false, userGesture: false }
      }));
    }, { once: true });
    socket.addEventListener('error', () => finish(reject, new Error('university_browser_cdp_error')), { once: true });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== 1) return;
      const value = message && message.result && message.result.result && message.result.result.value;
      if (!value || typeof value !== 'object') return finish(reject, new Error('university_browser_cdp_result_invalid'));
      finish(resolve, value);
    });
  });
}

export function createUniversityBrowserBridge({
  cdpEndpoint,
  allowedOrigins,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => new Date().toISOString()
} = {}) {
  const endpoint = normalizeUniversityCdpEndpoint(cdpEndpoint);
  const origins = normalizeUniversityOrigins(allowedOrigins);
  if (typeof fetchImpl !== 'function') throw new Error('university_browser_fetch_unavailable');

  async function targets() {
    const raw = await fetchJson(fetchImpl, endpoint + '/json/list', 'targets');
    if (!Array.isArray(raw)) throw new Error('university_browser_targets_invalid');
    return raw.map((target) => validateTarget(target, origins)).filter(Boolean);
  }

  return Object.freeze({
    endpoint,
    origins,
    async status() {
      const version = await fetchJson(fetchImpl, endpoint + '/json/version', 'status');
      return {
        ready: true,
        browser: typeof version.Browser === 'string' ? version.Browser.slice(0, 200) : '',
        protocolVersion: typeof version['Protocol-Version'] === 'string' ? version['Protocol-Version'].slice(0, 50) : ''
      };
    },
    async listReadablePages() {
      return (await targets()).map((target) => ({ id: target.id, url: target.url, title: target.title }));
    },
    async readPage(targetId) {
      const id = boundedString(targetId, 'target_id', 300);
      const target = (await targets()).find((item) => item.id === id);
      if (!target) throw new Error('university_browser_target_forbidden_or_missing');
      const raw = await evaluateReadOnlyPage(target.webSocketDebuggerUrl, { WebSocketImpl });
      const url = assertUniversityUrlAllowed(raw.url, origins);
      return {
        capturedAt: boundedString(now(), 'captured_at', 50),
        targetId: id,
        url,
        title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
        text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_PAGE_TEXT) : ''
      };
    }
  });
}
