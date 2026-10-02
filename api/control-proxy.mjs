const DEFAULT_LOCATOR_GIST_ID = 'ff6ce9c386d30eafb61f649d1285b2b1';
const LOCATOR_FILE = 'tunnel-url';
const LOCATOR_CACHE_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 12_000;

let locatorCache = { value: null, at: 0 };

export function validateTunnelOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('control_locator_empty');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) {
    throw new Error('control_locator_origin_invalid');
  }
  if (url.username || url.password || url.port || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('control_locator_origin_invalid');
  }
  return url.origin;
}

export function proxyTarget(reqUrl, upstreamOrigin) {
  const incoming = new URL(reqUrl || '/', 'https://agent-control.invalid');
  const captured = String(incoming.searchParams.get('__path') || '').replace(/^\/+/, '');
  incoming.searchParams.delete('__path');
  const target = new URL('/' + captured, upstreamOrigin);
  target.search = incoming.searchParams.toString();
  return target;
}

export async function resolveTunnelOrigin({
  fetchImpl = fetch,
  now = Date.now(),
  gistId = process.env.AGENT_CONTROL_LOCATOR_GIST_ID || DEFAULT_LOCATOR_GIST_ID
} = {}) {
  if (!/^[a-f0-9]{20,64}$/i.test(gistId)) throw new Error('control_locator_gist_invalid');
  if (locatorCache.value && now - locatorCache.at < LOCATOR_CACHE_MS) return locatorCache.value;

  const response = await fetchImpl(`https://api.github.com/gists/${gistId}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-control-vercel-proxy'
    },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`control_locator_fetch_failed:${response.status}`);
  const gist = await response.json();
  const file = gist?.files?.[LOCATOR_FILE];
  let raw = typeof file?.content === 'string' ? file.content : '';
  if (!raw && typeof file?.raw_url === 'string') {
    const rawResponse = await fetchImpl(file.raw_url, {
      headers: { 'user-agent': 'agent-control-vercel-proxy' },
      signal: AbortSignal.timeout(5_000)
    });
    if (!rawResponse.ok) throw new Error(`control_locator_raw_fetch_failed:${rawResponse.status}`);
    raw = await rawResponse.text();
  }

  const value = validateTunnelOrigin(raw);
  locatorCache = { value, at: now };
  return value;
}

export function resetLocatorCache() {
  locatorCache = { value: null, at: 0 };
}

function requestHeaders(req) {
  const blocked = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
    'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto',
    'x-vercel-id', 'x-vercel-deployment-url', 'x-vercel-forwarded-for'
  ]);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    const key = name.toLowerCase();
    if (blocked.has(key) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

function requestBody(req) {
  if (['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) return undefined;
  if (req.body === undefined || req.body === null) return undefined;
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

function sendOffline(res) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08111f"><title>Agent Control</title><style>body{margin:0;background:#08111f;color:#eef4ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}.card{max-width:520px;background:#111d31;border:1px solid #293b58;border-radius:22px;padding:28px;box-shadow:0 24px 80px #0007}h1{margin:0 0 10px;font-size:26px}p{color:#b8c7dd;line-height:1.5}button{border:0;border-radius:12px;padding:12px 16px;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1>MSI no accesible ahora</h1><p>El enlace remoto estable funciona, pero el túnel local no está respondiendo. Si el MSI está encendido, vuelve a intentarlo en unos segundos.</p><button onclick="location.reload()">Reintentar</button></main></body></html>`;
  res.statusCode = 503;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(html);
}

export default async function handler(req, res) {
  try {
    const upstreamOrigin = await resolveTunnelOrigin();
    const target = proxyTarget(req.url, upstreamOrigin);
    const headers = requestHeaders(req);
    const body = requestBody(req);
    const response = await fetch(target, {
      method: req.method || 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    res.statusCode = response.status;
    const blockedResponse = new Set(['content-length', 'transfer-encoding', 'connection']);
    for (const [name, value] of response.headers.entries()) {
      const key = name.toLowerCase();
      if (blockedResponse.has(key) || key === 'set-cookie' || key === 'location') continue;
      res.setHeader(name, value);
    }

    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    if (cookies.length) res.setHeader('set-cookie', cookies);
    else {
      const cookie = response.headers.get('set-cookie');
      if (cookie) res.setHeader('set-cookie', cookie);
    }

    const location = response.headers.get('location');
    if (location) {
      const resolved = new URL(location, target);
      if (resolved.origin === upstreamOrigin) {
        res.setHeader('location', resolved.pathname + resolved.search + resolved.hash);
      }
    }

    res.setHeader('x-agent-control-proxy', 'vercel');
    if (String(req.method || '').toUpperCase() === 'HEAD') return res.end();
    const payload = Buffer.from(await response.arrayBuffer());
    res.end(payload);
  } catch {
    sendOffline(res);
  }
}
