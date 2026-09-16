import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { browserQaNavigationPlan } from './browser-qa.js';

const defaultChromeNames = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const defaultChromePaths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const blockedHostSuffixes = ['.localhost', '.local', '.internal'];

function abortError(message = 'browser_qa_runner_aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortableDelay(ms, signal) {
  if (!Number.isInteger(ms) || ms < 0) throw new Error('browser_qa_runner_delay_invalid');
  if (ms === 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => finish(resolvePromise), ms);
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitWithDeadline(promise, { timeoutMs, signal, label }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('browser_qa_runner_timeout_invalid');
  return new Promise((resolvePromise, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, new Error(`${label}_timeout`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    Promise.resolve(promise).then(
      (value) => finish(resolvePromise, value),
      (error) => finish(reject, error)
    );
  });
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function inIpv4Cidr(value, base, bits) {
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

export function isUnsafeNetworkAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return true;
  const normalized = address.trim().toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const value = ipv4Number(normalized);
    if (value === null) return true;
    const cidrs = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ];
    return cidrs.some(([base, bits]) => inIpv4Cidr(value, ipv4Number(base), bits));
  }
  if (version === 6) return true;
  return true;
}

function hostnameLooksLocal(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || blockedHostSuffixes.some((suffix) => normalized.endsWith(suffix));
}

export async function resolvePublicNetworkUrl(value, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new Error('browser_qa_runner_url_invalid');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('browser_qa_runner_url_unsafe');
  }
  if (hostnameLooksLocal(url.hostname)) throw new Error('browser_qa_runner_private_network_forbidden');
  const ipVersion = isIP(url.hostname);
  if (ipVersion) {
    if (ipVersion !== 4 || isUnsafeNetworkAddress(url.hostname)) throw new Error('browser_qa_runner_private_network_forbidden');
    return { url, addresses: [{ address: url.hostname, family: 4 }] };
  }
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error('browser_qa_runner_dns_failed', { cause: error });
  }
  const normalized = Array.isArray(addresses)
    ? addresses
        .map((entry) => ({ address: entry.address, family: Number(entry.family) }))
        .filter((entry) => entry.family === 4 && !isUnsafeNetworkAddress(entry.address))
    : [];
  if (!normalized.length) throw new Error('browser_qa_runner_private_network_forbidden');
  return { url, addresses: normalized };
}

export async function assertPublicNetworkUrl(value, options = {}) {
  return (await resolvePublicNetworkUrl(value, options)).url;
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findChromeExecutable({ explicitPath = null, environment = process.env } = {}) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (environment.BROWSER_QA_CHROME_PATH) candidates.push(environment.BROWSER_QA_CHROME_PATH);
  candidates.push(...defaultChromePaths);
  for (const name of defaultChromeNames) {
    for (const root of String(environment.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(root, name));
  }
  for (const candidate of [...new Set(candidates.map((item) => resolve(item)))]) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error('browser_qa_chrome_unavailable');
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.#message(event));
    socket.addEventListener('close', () => this.#closed());
    socket.addEventListener('error', () => this.#closed(new Error('browser_qa_cdp_socket_error')));
  }

  static async connect(url, { WebSocketImpl = globalThis.WebSocket, signal, timeoutMs = 10_000 } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('browser_qa_websocket_unavailable');
    throwIfAborted(signal);
    const socket = new WebSocketImpl(url);
    try {
      await waitWithDeadline(new Promise((resolvePromise, reject) => {
        const onOpen = () => {
          cleanup();
          resolvePromise();
        };
        const onError = () => {
          cleanup();
          reject(new Error('browser_qa_cdp_connect_failed'));
        };
        const cleanup = () => {
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
        };
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
      }), { timeoutMs, signal, label: 'browser_qa_cdp_connect' });
      return new CdpConnection(socket);
    } catch (error) {
      try { socket.close(); } catch { /* best-effort socket cleanup */ }
      throw error;
    }
  }

  #key(method, sessionId = '') {
    return `${sessionId}::${method}`;
  }

  #closed(error = new Error('browser_qa_cdp_closed')) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  #message(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`browser_qa_cdp_error:${message.error.message ?? 'unknown'}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const keys = [this.#key(message.method, message.sessionId ?? ''), this.#key(message.method, '*')];
    for (const key of keys) {
      for (const listener of this.listeners.get(key) ?? []) {
        Promise.resolve(listener(message.params ?? {}, message)).catch(() => {});
      }
    }
  }

  on(method, listener, sessionId = '') {
    const key = this.#key(method, sessionId);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  waitFor(method, { sessionId = '', predicate = () => true, timeoutMs = 10_000, signal } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('browser_qa_runner_timeout_invalid'));
    return new Promise((resolvePromise, reject) => {
      throwIfAborted(signal);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const off = this.on(method, (params, message) => {
        let matches;
        try { matches = predicate(params, message); } catch (error) { return finish(reject, error); }
        if (matches) finish(resolvePromise, params);
      }, sessionId);
      const onAbort = () => finish(reject, abortError());
      const timer = setTimeout(() => finish(reject, new Error(`browser_qa_cdp_event_${method.replaceAll('.', '_')}_timeout`)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('browser_qa_cdp_not_open'));
    const id = ++this.sequence;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.#closed();
    try { this.socket.close(); } catch { /* best-effort socket cleanup */ }
  }
}

async function waitForDevtoolsActivePort(userDataDir, child, { signal, timeoutMs }) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal);
    if (child.exitCode !== null) throw new Error(`browser_qa_chrome_exited:${child.exitCode}`);
    try {
      const [port, path] = String(await readFile(file, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith('/')) return { port: Number(port), path };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await abortableDelay(25, signal);
  }
  throw new Error('browser_qa_devtools_port_timeout');
}

async function bestEffortCdp(connection, method, params = {}, sessionId = undefined, timeoutMs = 250) {
  try {
    await waitWithDeadline(connection.send(method, params, sessionId), {
      timeoutMs,
      label: `browser_qa_cleanup_${method.replaceAll('.', '_')}`
    });
  } catch {
    // Cleanup is best-effort; socket/process teardown follows.
  }
}

async function waitForChildExit(child, timeoutMs = 750) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
  ]);
}

function chromeHostResolverRule(hostPin) {
  if (!hostPin) return null;
  const hostname = String(hostPin.hostname ?? '').toLowerCase();
  const address = String(hostPin.address ?? '').toLowerCase();
  if (!hostname || hostnameLooksLocal(hostname) || !isIP(address) || isUnsafeNetworkAddress(address)) throw new Error('browser_qa_host_pin_invalid');
  const target = isIP(address) === 6 ? `[${address}]` : address;
  return `--host-resolver-rules=MAP ${hostname} ${target}`;
}

function chromeArguments(userDataDir, hostPin = null) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--safebrowsing-disable-auto-update',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...(chromeHostResolverRule(hostPin) ? [chromeHostResolverRule(hostPin)] : []),
    'about:blank'
  ];
}

export function browserQaDocumentUrlMatches(candidate, expected) {
  try {
    const a = new URL(candidate);
    const b = new URL(expected);
    return a.protocol === b.protocol &&
      a.host === b.host &&
      a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') &&
      a.search === b.search;
  } catch {
    return false;
  }
}

function expectedAnchors(request, route) {
  return request.acceptance.targets
    .filter((target) => target.fromRoute === route && target.semantics === 'anchor')
    .map((target) => target.destination.slice(1));
}

function buildDomProbeExpression({ request, pagePlan, routeUrls }) {
  const sections = request.acceptance.pages.find((page) => page.route === pagePlan.route)?.requiredSections ?? [];
  const anchors = expectedAnchors(request, pagePlan.route);
  const targets = request.acceptance.targets.filter((target) => target.fromRoute === pagePlan.route);
  return `(() => {
    const expectedSections = ${JSON.stringify(sections)};
    const expectedAnchors = ${JSON.stringify(anchors)};
    const expectedTargets = ${JSON.stringify(targets)};
    const routeUrls = ${JSON.stringify(routeUrls)};
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const nameFor = (element) => {
      const aria = clean(element.getAttribute?.('aria-label'));
      if (aria) return aria.slice(0, 500);
      const labelledBy = clean(element.getAttribute?.('aria-labelledby'));
      if (labelledBy) {
        const value = labelledBy.split(/\\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
        if (value) return value.slice(0, 500);
      }
      if (element.labels?.length) {
        const value = [...element.labels].map((label) => clean(label.textContent)).filter(Boolean).join(' ');
        if (value) return value.slice(0, 500);
      }
      const tag = String(element.tagName ?? '').toUpperCase();
      const type = String(element.type ?? '').toLowerCase();
      if (tag === 'AREA' || (tag === 'INPUT' && type === 'image')) {
        const alt = clean(element.getAttribute?.('alt'));
        if (alt) return alt.slice(0, 500);
      }
      if ((tag === 'INPUT' && !['button', 'reset', 'submit', 'image', 'hidden'].includes(type)) || tag === 'TEXTAREA') {
        const placeholder = clean(element.getAttribute?.('placeholder'));
        if (placeholder) return placeholder.slice(0, 500);
      }
      if (tag === 'INPUT' && ['button', 'reset', 'submit'].includes(type)) {
        const value = clean(element.value);
        if (value) return value.slice(0, 500);
      }
      const title = clean(element.getAttribute?.('title'));
      if (title) return title.slice(0, 500);
      const descendantAlt = clean(element.querySelector?.('img[alt]')?.getAttribute('alt'));
      if (descendantAlt) return descendantAlt.slice(0, 500);
      const svgTitle = clean(element.querySelector?.('svg title')?.textContent);
      if (svgTitle) return svgTitle.slice(0, 500);
      return clean(element.innerText || element.textContent).slice(0, 500);
    };
    const isRendered = (element) => {
      if (!element || element.hidden || element.hasAttribute('disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      return element.getClientRects().length > 0;
    };
    const hrefElements = [...document.querySelectorAll('a[href], area[href]')].filter(isRendered);
    const targetFor = (target) => {
      let element = null;
      if (target.semantics === 'route') {
        const expected = routeUrls[target.destination];
        element = hrefElements.find((candidate) => {
          try {
            const resolved = new URL(candidate.getAttribute('href'), location.href);
            resolved.search = ''; resolved.hash = '';
            const wanted = new URL(expected); wanted.search = ''; wanted.hash = '';
            return resolved.href.replace(/\\/$/, '') === wanted.href.replace(/\\/$/, '');
          } catch { return false; }
        }) ?? null;
      } else if (target.semantics === 'anchor') {
        const destination = document.getElementById(target.destination.slice(1));
        if (!isRendered(destination)) return null;
        element = hrefElements.find((candidate) => {
          try {
            const resolved = new URL(candidate.getAttribute('href'), location.href);
            return resolved.origin === location.origin && resolved.pathname.replace(/\\/$/, '') === location.pathname.replace(/\\/$/, '') && resolved.hash === target.destination;
          } catch { return false; }
        }) ?? null;
      } else if (target.destination === 'phone') {
        element = hrefElements.find((candidate) => /^tel:/i.test(candidate.getAttribute('href') ?? '')) ?? null;
      } else if (target.destination === 'email') {
        element = hrefElements.find((candidate) => /^mailto:/i.test(candidate.getAttribute('href') ?? '')) ?? null;
      } else if (target.destination === 'whatsapp') {
        element = hrefElements.find((candidate) => {
          try {
            const resolved = new URL(candidate.getAttribute('href'), location.href);
            return resolved.hostname === 'wa.me' || resolved.hostname === 'whatsapp.com' || resolved.hostname.endsWith('.whatsapp.com');
          } catch { return false; }
        }) ?? null;
      }
      return element ? { id: target.id, href: element.getAttribute('href'), accessibleName: nameFor(element) } : null;
    };
    const sectionNodes = [...document.querySelectorAll('[id], [data-section], [data-section-id]')];
    const observedSections = expectedSections.filter((section) => sectionNodes.some((node) =>
      isRendered(node) && (node.id === section || node.getAttribute('data-section') === section || node.getAttribute('data-section-id') === section)
    ));
    const observedAnchors = expectedAnchors.filter((anchor) => isRendered(document.getElementById(anchor)));
    const interactiveNodes = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')].filter(isRendered);
    if (interactiveNodes.length > 500) throw new Error('browser_qa_interactive_control_limit_exceeded');
    const interactive = interactiveNodes
      .map((element, index) => ({ id: element.id ? 'id:' + String(element.id).slice(0, 100) : 'control-' + index, accessibleName: nameFor(element) }));
    const overlaySelectors = ['nextjs-portal', '[data-nextjs-dialog-overlay]', 'vite-error-overlay', 'webpack-dev-server-client-overlay', '#webpack-dev-server-client-overlay'];
    return {
      finalUrl: location.href,
      bodyTextLength: clean(document.body?.innerText).length,
      errorOverlay: overlaySelectors.some((selector) => Boolean(document.querySelector(selector))),
      horizontalOverflow: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0) > window.innerWidth + 1,
      sections: observedSections,
      anchors: observedAnchors,
      metadata: {
        title: clean(document.title),
        description: clean(document.querySelector('meta[name="description"]')?.getAttribute('content'))
      },
      interactiveControls: interactive,
      targets: expectedTargets.map(targetFor).filter(Boolean)
    };
  })()`;
}

async function evaluateJson(connection, sessionId, expression) {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: false
  }, sessionId);
  if (result.exceptionDetails) throw new Error('browser_qa_runtime_probe_failed');
  return result.result?.value;
}

class ChromeCdpBrowser {
  constructor({ child, connection, userDataDir, allowedOrigin }) {
    Object.assign(this, { child, connection, userDataDir, allowedOrigin });
    this.closed = false;
  }

  async version() {
    return this.connection.send('Browser.getVersion');
  }

  #allowedUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== this.allowedOrigin) throw new Error('browser_qa_cross_origin_resource_forbidden');
    return url;
  }

  async inspectPage({ request, pagePlan, routeUrls, signal, timeoutMs, settleMs = 150 }) {
    throwIfAborted(signal);
    this.#allowedUrl(pagePlan.url);
    const context = await this.connection.send('Target.createBrowserContext', { disposeOnDetach: true });
    const target = await this.connection.send('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId });
    const attached = await this.connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    const documentResponses = [];
    let interceptionFailure = null;
    let secondaryTargetFailure = null;

    const offResponse = this.connection.on('Network.responseReceived', (params) => {
      if (params.type === 'Document' && Number.isFinite(params.response?.status)) {
        documentResponses.push({
          frameId: params.frameId ?? null,
          loaderId: params.loaderId ?? null,
          status: Math.round(params.response.status)
        });
      }
    }, sessionId);

    const offFetch = this.connection.on('Fetch.requestPaused', async (params) => {
      const requestData = params.request ?? {};
      console.error('DOGFOOD_FETCH', JSON.stringify({ url: requestData.url, method: requestData.method, resourceType: params.resourceType, pagePlan: pagePlan.url }));
      const fail = async () => {
        console.error('DOGFOOD_FAIL_REQUEST', JSON.stringify({ url: requestData.url, resourceType: params.resourceType }));
        return this.connection.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }, sessionId).catch(() => {});
      };
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(String(requestData.method ?? '').toUpperCase())) return fail();
        const url = new URL(requestData.url);
        if (params.resourceType === 'Document' && !browserQaDocumentUrlMatches(url, pagePlan.url)) return fail();
        if (['http:', 'https:'].includes(url.protocol)) this.#allowedUrl(url);
        else if (!['data:', 'blob:', 'about:'].includes(url.protocol)) return fail();
        await this.connection.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
      } catch (error) {
        console.error('DOGFOOD_INTERCEPTION_ERROR', error?.stack || error?.message || String(error));
        interceptionFailure = interceptionFailure ?? error;
        await fail();
      }
    }, sessionId);

    const offSecondaryTarget = this.connection.on('Target.attachedToTarget', async (params) => {
      const info = params.targetInfo ?? {};
      secondaryTargetFailure = secondaryTargetFailure ?? new Error(`browser_qa_secondary_target_forbidden:${String(info.type ?? 'unknown')}`);
      if (info.targetId) await bestEffortCdp(this.connection, 'Target.closeTarget', { targetId: info.targetId }, undefined, 250);
    }, sessionId);

    try {
      await Promise.all([
        this.connection.send('Page.enable', {}, sessionId),
        this.connection.send('Runtime.enable', {}, sessionId),
        this.connection.send('Network.enable', {}, sessionId),
        this.connection.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId),
        this.connection.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true
        }, sessionId),
        this.connection.send('Emulation.setDeviceMetricsOverride', {
          width: request.acceptance.mobileViewport.width,
          height: request.acceptance.mobileViewport.height,
          deviceScaleFactor: 1,
          mobile: true
        }, sessionId)
      ]);

      const load = this.connection.waitFor('Page.loadEventFired', { sessionId, signal, timeoutMs });
      console.error('DOGFOOD_NAVIGATE', pagePlan.url);
      const navigation = await this.connection.send('Page.navigate', { url: pagePlan.url, transitionType: 'typed' }, sessionId);
      console.error('DOGFOOD_NAVIGATION_RESULT', JSON.stringify(navigation));
      if (navigation.errorText) throw new Error(`browser_qa_navigation_failed:${navigation.errorText}`);
      await load;
      if (interceptionFailure) throw interceptionFailure;
      if (secondaryTargetFailure) throw secondaryTargetFailure;
      await abortableDelay(settleMs, signal);
      if (interceptionFailure) throw interceptionFailure;
      if (secondaryTargetFailure) throw secondaryTargetFailure;
      const probe = await evaluateJson(this.connection, sessionId, buildDomProbeExpression({ request, pagePlan, routeUrls }));
      if (!probe || typeof probe !== 'object') throw new Error('browser_qa_probe_invalid');
      if (!browserQaDocumentUrlMatches(probe.finalUrl, pagePlan.url)) throw new Error('browser_qa_final_url_mismatch');
      if (secondaryTargetFailure) throw secondaryTargetFailure;
      const response = [...documentResponses].reverse().find((item) =>
        (navigation.loaderId && item.loaderId === navigation.loaderId) ||
        (!navigation.loaderId && navigation.frameId && item.frameId === navigation.frameId)
      );
      return { route: pagePlan.route, status: response?.status ?? 0, ...probe };
    } finally {
      offResponse();
      offFetch();
      offSecondaryTarget();
      await bestEffortCdp(this.connection, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true
      }, sessionId, 150);
      await bestEffortCdp(this.connection, 'Target.closeTarget', { targetId: target.targetId }, undefined, 250);
      await bestEffortCdp(this.connection, 'Target.disposeBrowserContext', { browserContextId: context.browserContextId }, undefined, 250);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await bestEffortCdp(this.connection, 'Browser.close', {}, undefined, 250);
    this.connection.close();
    await waitForChildExit(this.child, 500);
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await waitForChildExit(this.child, 500);
    }
    await rm(this.userDataDir, { recursive: true, force: true });
  }
}

export async function launchChromeCdpBrowser({
  signal,
  timeoutMs = 10_000,
  chromePath = null,
  environment = process.env,
  spawnImpl = spawn,
  WebSocketImpl = globalThis.WebSocket,
  hostPin = null,
  allowedOrigin = null
} = {}) {
  throwIfAborted(signal);
  const executablePath = await findChromeExecutable({ explicitPath: chromePath, environment });
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-browser-qa-'));
  let child = null;
  let connection = null;
  try {
    child = spawnImpl(executablePath, chromeArguments(userDataDir, hostPin), {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: Object.fromEntries(Object.entries({
        PATH: environment.PATH,
        HOME: environment.HOME,
        LANG: environment.LANG ?? 'C.UTF-8'
      }).filter(([, value]) => value !== undefined))
    });
    await new Promise((resolvePromise, reject) => {
      let handled = false;
      const onSpawn = () => {
        if (handled) return;
        handled = true;
        child.removeListener('error', onError);
        resolvePromise();
      };
      const onError = (error) => {
        if (handled) return;
        handled = true;
        child.removeListener('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    const devtools = await waitForDevtoolsActivePort(userDataDir, child, { signal, timeoutMs });
    connection = await CdpConnection.connect(`ws://127.0.0.1:${devtools.port}${devtools.path}`, { WebSocketImpl, signal, timeoutMs });
    const browser = new ChromeCdpBrowser({ child, connection, userDataDir, allowedOrigin });
    await waitWithDeadline(browser.version(), { timeoutMs, signal, label: 'browser_qa_browser_version' });
    return browser;
  } catch (error) {
    connection?.close();
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 500);
    }
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

function validateRunnerPlan(request, navigationPlan) {
  if (!request || !navigationPlan || !Array.isArray(navigationPlan.sameOriginPages) || !navigationPlan.sameOriginPages.length) {
    throw new Error('browser_qa_runner_plan_invalid');
  }
  const expectedPlan = browserQaNavigationPlan(request);
  if (JSON.stringify(navigationPlan) !== JSON.stringify(expectedPlan)) throw new Error('browser_qa_runner_plan_binding_mismatch');
  const preview = new URL(navigationPlan.previewBaseUrl);
  if (preview.protocol !== 'https:' || preview.username || preview.password) throw new Error('browser_qa_runner_preview_invalid');
  const routeUrls = {};
  const basePath = preview.pathname === '/' ? '/' : preview.pathname.replace(/\/+$/, '');
  for (const page of navigationPlan.sameOriginPages) {
    if (!page || typeof page.route !== 'string' || typeof page.url !== 'string' || Object.hasOwn(routeUrls, page.route)) throw new Error('browser_qa_runner_page_plan_invalid');
    const url = new URL(page.url);
    const withinBase = basePath === '/' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    if (url.protocol !== 'https:' || url.origin !== preview.origin || !withinBase || url.search || url.hash) throw new Error('browser_qa_runner_page_plan_invalid');
    routeUrls[page.route] = page.url;
  }
  return routeUrls;
}

export class ChromeBrowserQaRunner {
  constructor({ browserFactory = launchChromeCdpBrowser, networkResolver = resolvePublicNetworkUrl, settleMs = 150 } = {}) {
    if (typeof browserFactory !== 'function') throw new Error('browser_qa_runner_factory_invalid');
    if (typeof networkResolver !== 'function') throw new Error('browser_qa_runner_network_resolver_invalid');
    if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 2_000) throw new Error('browser_qa_runner_settle_invalid');
    this.browserFactory = browserFactory;
    this.networkResolver = networkResolver;
    this.settleMs = settleMs;
  }

  async verify({ request, navigationPlan, signal, timeoutMs }) {
    throwIfAborted(signal);
    const routeUrls = validateRunnerPlan(request, navigationPlan);
    const resolvedPreview = await this.networkResolver(navigationPlan.previewBaseUrl);
    if (!resolvedPreview?.url || !Array.isArray(resolvedPreview.addresses) || !resolvedPreview.addresses.length) throw new Error('browser_qa_runner_network_resolution_invalid');
    const preview = new URL(navigationPlan.previewBaseUrl);
    if (resolvedPreview.url.origin !== preview.origin) throw new Error('browser_qa_runner_network_resolution_invalid');
    const preferred = resolvedPreview.addresses.find((entry) => Number(entry.family) === 4) ?? resolvedPreview.addresses[0];
    if (!preferred || isUnsafeNetworkAddress(preferred.address)) throw new Error('browser_qa_runner_private_network_forbidden');
    const hostPin = { hostname: preview.hostname, address: preferred.address };
    const browser = await this.browserFactory({ signal, timeoutMs, hostPin, allowedOrigin: preview.origin });
    const onAbort = () => { Promise.resolve(browser.close()).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const pages = [];
      for (const pagePlan of navigationPlan.sameOriginPages) {
        throwIfAborted(signal);
        pages.push(await browser.inspectPage({
          request,
          pagePlan,
          routeUrls,
          signal,
          timeoutMs,
          settleMs: this.settleMs
        }));
      }
      return {
        previewUrl: request.previewUrl,
        publishedCommitSha: request.publishedCommitSha,
        viewport: { ...request.acceptance.mobileViewport },
        externalNavigations: [],
        pages,
        observations: []
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await browser.close();
    }
  }
}
