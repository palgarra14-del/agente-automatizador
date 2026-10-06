import { createHash } from 'node:crypto';
import { URL } from 'node:url';
export const BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION = 'browser-qa/v1';
const fingerprintPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const workflowPattern = /^workflow-[A-Za-z0-9-]{8,120}$/;
const defectKinds = new Set(['load_failure', 'blank_body', 'runtime_error_overlay', 'missing_required_section', 'broken_required_target', 'horizontal_overflow', 'missing_required_metadata', 'missing_accessible_name']);
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
export function browserQaFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); Object.values(value).forEach(deepFreeze); return value;
}
function assertString(value, label, { max = 500 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`browser_qa_${label}_invalid`);
  }
  return value.trim();
}
function assertFingerprint(value, label) {
  if (!fingerprintPattern.test(value ?? '')) throw new Error(`browser_qa_${label}_invalid`);
  return value;
}
function normalizeRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || /[\0\r\n\\]/.test(value)) {
    throw new Error('browser_qa_route_invalid');
  }
  const sentinelOrigin = 'https://qa.invalid';
  const url = new URL(value, sentinelOrigin);
  if (url.origin !== sentinelOrigin || /%2f|%5c/i.test(url.pathname)) throw new Error('browser_qa_route_invalid');
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}
export function normalizeBrowserQaPreviewUrl(value) {
  const input = assertString(value, 'preview_url', { max: 2_000 });
  let url;
  try { url = new URL(input); } catch { throw new Error('browser_qa_preview_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('browser_qa_preview_url_unsafe');
  if (!url.hostname || /[\0\r\n]/.test(url.hostname) || /%2f|%5c/i.test(url.pathname)) throw new Error('browser_qa_preview_url_unsafe');
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path || '/';
  return url.toString();
}
function previewUrlForRoute(previewUrl, route) {
  const base = new URL(normalizeBrowserQaPreviewUrl(previewUrl));
  const logicalRoute = normalizeRoute(route);
  const basePath = normalizeRoute(base.pathname);
  base.pathname = logicalRoute === '/'
    ? basePath
    : `${basePath === '/' ? '' : basePath}${logicalRoute}`;
  return normalizeBrowserQaPreviewUrl(base.toString());
}
function logicalRouteFromPreviewUrl(previewUrl, candidate) {
  const preview = new URL(normalizeBrowserQaPreviewUrl(previewUrl));
  const observed = candidate instanceof URL ? candidate : new URL(candidate);
  if (observed.origin !== preview.origin) return null;
  const basePath = normalizeRoute(preview.pathname);
  const observedPath = normalizeRoute(observed.pathname);
  if (basePath === '/') return observedPath;
  if (observedPath === basePath) return '/';
  if (!observedPath.startsWith(`${basePath}/`)) return null;
  return normalizeRoute(observedPath.slice(basePath.length));
}
function normalizeSections(value) {
  if (!Array.isArray(value)) throw new Error('browser_qa_sections_invalid');
  return [...new Set(value.map((item) => assertString(item, 'section', { max: 120 })))].sort();
}
function blueprintAcceptance(blueprint) {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint) || blueprint.version !== 1) {
    throw new Error('browser_qa_blueprint_invalid');
  }
  if (!Array.isArray(blueprint.pages) || !blueprint.pages.length || !Array.isArray(blueprint.ctas)) {
    throw new Error('browser_qa_blueprint_invalid');
  }
  const pages = blueprint.pages.map((page) => ({
    route: normalizeRoute(page.route),
    requiredSections: normalizeSections(page.sections ?? []),
    requiredMetadata: ['description', 'title']
  })).sort((a, b) => a.route.localeCompare(b.route));
  const pageRoutes = new Set(pages.map((page) => page.route));
  if (!pageRoutes.has('/')) throw new Error('browser_qa_blueprint_home_missing');
  const targets = [];
  for (const item of blueprint.navigation?.routes ?? []) {
    const route = normalizeRoute(item.route);
    if (!pageRoutes.has(route)) throw new Error('browser_qa_blueprint_navigation_route_missing');
    targets.push({ id: `nav-route:${assertString(item.id, 'target_id', { max: 120 })}`, kind: 'navigation', fromRoute: '/', semantics: 'route', destination: route });
  }
  for (const anchor of blueprint.navigation?.homeAnchors ?? []) {
    if (typeof anchor !== 'string' || !/^#[A-Za-z0-9_-]{1,120}$/.test(anchor)) throw new Error('browser_qa_blueprint_anchor_invalid');
    targets.push({ id: `nav-anchor:${anchor.slice(1)}`, kind: 'navigation', fromRoute: '/', semantics: 'anchor', destination: anchor });
  }
  for (const cta of blueprint.ctas) {
    const id = assertString(cta.id, 'target_id', { max: 120 });
    if (cta.kind === 'route') {
      targets.push({ id: `cta:${id}`, kind: 'cta', fromRoute: '/', semantics: 'route', destination: normalizeRoute(cta.destination) });
    } else if (cta.kind === 'section') {
      if (typeof cta.destination !== 'string' || !/^#[A-Za-z0-9_-]{1,120}$/.test(cta.destination)) throw new Error('browser_qa_blueprint_anchor_invalid');
      targets.push({ id: `cta:${id}`, kind: 'cta', fromRoute: '/', semantics: 'anchor', destination: cta.destination });
    } else if (['email', 'phone', 'whatsapp'].includes(cta.kind) && cta.destination === 'provided-contact') {
      targets.push({ id: `cta:${id}`, kind: 'cta', fromRoute: '/', semantics: 'external', destination: cta.kind });
    } else if (cta.kind === 'booking') {
      let expectedHref;
      try {
        const url = new URL(cta.destination);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
        expectedHref = url.href;
      } catch {
        throw new Error('browser_qa_blueprint_cta_invalid');
      }
      targets.push({ id: `cta:${id}`, kind: 'cta', fromRoute: '/', semantics: 'external', destination: 'booking', expectedHref });
    } else {
      throw new Error('browser_qa_blueprint_cta_invalid');
    }
  }
  return { pages, targets: targets.sort((a, b) => a.id.localeCompare(b.id)), mobileViewport: { width: 390, height: 844 } };
}
export function createBrowserQaRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('browser_qa_request_invalid');
  const workflowId = assertString(input.workflowId, 'workflow_id', { max: 160 });
  if (!workflowPattern.test(workflowId)) throw new Error('browser_qa_workflow_id_invalid');
  const websiteBlueprintFingerprint = assertFingerprint(input.websiteBlueprintFingerprint, 'blueprint_fingerprint');
  const reviewedChangeSetFingerprint = assertFingerprint(input.reviewedChangeSetFingerprint, 'change_fingerprint');
  if (!commitPattern.test(input.publishedCommitSha ?? '')) throw new Error('browser_qa_commit_sha_invalid');
  const acceptanceSchemaVersion = input.acceptanceSchemaVersion ?? BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION;
  if (acceptanceSchemaVersion !== BROWSER_QA_ACCEPTANCE_SCHEMA_VERSION) throw new Error('browser_qa_schema_version_invalid');
  if (browserQaFingerprint(input.websiteBlueprint) !== websiteBlueprintFingerprint) throw new Error('browser_qa_blueprint_fingerprint_mismatch');
  const request = {
    workflowId,
    websiteBlueprintFingerprint,
    reviewedChangeSetFingerprint,
    publishedCommitSha: input.publishedCommitSha,
    previewUrl: normalizeBrowserQaPreviewUrl(input.previewUrl),
    acceptanceSchemaVersion,
    websiteBlueprint: canonicalValue(input.websiteBlueprint),
    acceptance: blueprintAcceptance(input.websiteBlueprint)
  };
  return deepFreeze({ ...request, requestFingerprint: browserQaFingerprint(request) });
}
function normalizeBoundBrowserQaRequest(request) {
  const normalized = createBrowserQaRequest({ ...request, websiteBlueprint: request?.websiteBlueprint });
  if (normalized.requestFingerprint !== request?.requestFingerprint) throw new Error('browser_qa_request_changed');
  return normalized;
}
function normalizePage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('browser_qa_snapshot_page_invalid');
  const route = normalizeRoute(raw.route);
  const finalUrl = assertString(raw.finalUrl, 'snapshot_final_url', { max: 2_000 });
  const status = Number(raw.status);
  if (!Number.isInteger(status) || status < 0 || status > 599) throw new Error('browser_qa_snapshot_status_invalid');
  if (typeof raw.errorOverlay !== 'boolean') throw new Error('browser_qa_snapshot_error_overlay_invalid');
  if (typeof raw.horizontalOverflow !== 'boolean') throw new Error('browser_qa_snapshot_horizontal_overflow_invalid');
  const sections = normalizeSections(raw.sections ?? []);
  const anchors = normalizeSections(raw.anchors ?? []);
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {};
  if (!Array.isArray(raw.interactiveControls)) throw new Error('browser_qa_snapshot_interactive_controls_invalid');
  const controls = raw.interactiveControls.map((control) => ({
    id: assertString(control.id, 'control_id', { max: 120 }),
    accessibleName: typeof control.accessibleName === 'string' ? control.accessibleName.trim().slice(0, 500) : ''
  }));
  const targets = Array.isArray(raw.targets) ? raw.targets.map((target) => ({
    id: assertString(target.id, 'target_id', { max: 160 }),
    href: assertString(target.href, 'target_href', { max: 2_000 }),
    accessibleName: typeof target.accessibleName === 'string' ? target.accessibleName.trim().slice(0, 500) : ''
  })) : [];
  return {
    route,
    finalUrl,
    status,
    bodyTextLength: Number.isInteger(raw.bodyTextLength) && raw.bodyTextLength >= 0 ? raw.bodyTextLength : 0,
    errorOverlay: raw.errorOverlay,
    horizontalOverflow: raw.horizontalOverflow,
    sections,
    anchors,
    metadata: {
      title: typeof metadata.title === 'string' ? metadata.title.trim() : '',
      description: typeof metadata.description === 'string' ? metadata.description.trim() : ''
    },
    interactiveControls: controls,
    targets
  };
}
function snapshotBindings(request, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('browser_qa_snapshot_invalid');
  if (normalizeBrowserQaPreviewUrl(snapshot.previewUrl) !== request.previewUrl) throw new Error('browser_qa_snapshot_preview_mismatch');
  if (snapshot.publishedCommitSha !== request.publishedCommitSha) throw new Error('browser_qa_snapshot_commit_mismatch');
  if (!snapshot.viewport || typeof snapshot.viewport !== 'object' || Array.isArray(snapshot.viewport)) throw new Error('browser_qa_snapshot_viewport_invalid');
  const { width, height } = snapshot.viewport;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('browser_qa_snapshot_viewport_invalid');
  if (width !== request.acceptance.mobileViewport.width || height !== request.acceptance.mobileViewport.height) throw new Error('browser_qa_snapshot_viewport_mismatch');
  if (!Array.isArray(snapshot.externalNavigations)) throw new Error('browser_qa_external_navigations_invalid');
  if (snapshot.externalNavigations.length) throw new Error('browser_qa_external_navigation_executed');
  if (!Array.isArray(snapshot.pages)) throw new Error('browser_qa_snapshot_pages_invalid');
  const pages = new Map();
  const previewOrigin = new URL(request.previewUrl).origin;
  for (const raw of snapshot.pages) {
    const page = normalizePage(raw);
    let normalizedFinalUrl;
    try { normalizedFinalUrl = normalizeBrowserQaPreviewUrl(page.finalUrl); } catch { throw new Error('browser_qa_snapshot_final_url_invalid'); }
    const finalUrl = new URL(normalizedFinalUrl);
    if (finalUrl.origin !== previewOrigin) throw new Error('browser_qa_snapshot_final_url_origin_mismatch');
    if (logicalRouteFromPreviewUrl(request.previewUrl, finalUrl) !== page.route) throw new Error('browser_qa_snapshot_final_url_route_mismatch');
    page.finalUrl = normalizedFinalUrl;
    if (pages.has(page.route)) throw new Error('browser_qa_snapshot_duplicate_route');
    pages.set(page.route, page);
  }
  return pages;
}
function targetHrefRoute(href, request, fromRoute) {
  try {
    const base = new URL(previewUrlForRoute(request.previewUrl, fromRoute));
    const url = new URL(href, base);
    return logicalRouteFromPreviewUrl(request.previewUrl, url);
  } catch {
    return null;
  }
}
function targetHrefAnchor(href, request, fromRoute) {
  try {
    const base = new URL(previewUrlForRoute(request.previewUrl, fromRoute));
    const url = new URL(href, base);
    const route = logicalRouteFromPreviewUrl(request.previewUrl, url);
    return route ? { route, hash: url.hash } : null;
  } catch {
    return null;
  }
}
function externalTargetSyntax(kind, href, expectedHref = null) {
  const validRecipient = (value) => /^[0-9]{7,15}$/.test(String(value ?? '').replace(/^\+/, ''));
  if (kind === 'phone') {
    if (!/^tel:\+?[0-9(). -]{3,80}$/i.test(href)) return false;
    return validRecipient(href.slice(4).replace(/\D/g, ''));
  }
  if (kind === 'email') return /^mailto:[^\s@]+@[^\s@]+$/i.test(href);
  if (kind === 'whatsapp') {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      if (url.hostname === 'wa.me') return validRecipient(url.pathname.replace(/^\/+|\/+$/g, ''));
      if (url.hostname === 'whatsapp.com' || url.hostname.endsWith('.whatsapp.com')) {
        return validRecipient(url.searchParams.get('phone'));
      }
      return false;
    } catch {
      return false;
    }
  }
  if (kind === 'booking' && typeof expectedHref === 'string') {
    try {
      const actual = new URL(href);
      const expected = new URL(expectedHref);
      return actual.protocol === 'https:' && !actual.username && !actual.password && actual.href === expected.href;
    } catch {
      return false;
    }
  }
  return false;
}
function defect(kind, route, subject) {
  if (!defectKinds.has(kind)) throw new Error('browser_qa_defect_kind_invalid');
  return { kind, route, subject };
}
function normalizeObservations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('browser_qa_observations_invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('browser_qa_observation_invalid');
    return {
      code: assertString(item.code, 'observation_code', { max: 80 }),
      summary: assertString(item.summary, 'observation_summary', { max: 500 })
    };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function evidenceBase(request) {
  return {
    workflowId: request.workflowId,
    websiteBlueprintFingerprint: request.websiteBlueprintFingerprint,
    reviewedChangeSetFingerprint: request.reviewedChangeSetFingerprint,
    publishedCommitSha: request.publishedCommitSha,
    previewUrl: request.previewUrl,
    acceptanceSchemaVersion: request.acceptanceSchemaVersion,
    requestFingerprint: request.requestFingerprint
  };
}
export function classifyBrowserQaSnapshot(request, snapshot) {
  const normalizedRequest = normalizeBoundBrowserQaRequest({ ...request, websiteBlueprint: snapshot.websiteBlueprint ?? request.websiteBlueprint });
  const pages = snapshotBindings(normalizedRequest, snapshot);
  const defects = [];
  for (const expected of normalizedRequest.acceptance.pages) {
    const page = pages.get(expected.route);
    if (!page || page.status < 200 || page.status >= 300) {
      defects.push(defect('load_failure', expected.route, expected.route));
      continue;
    }
    if (page.bodyTextLength < 20) defects.push(defect('blank_body', expected.route, expected.route));
    if (page.errorOverlay) defects.push(defect('runtime_error_overlay', expected.route, expected.route));
    if (page.horizontalOverflow) defects.push(defect('horizontal_overflow', expected.route, 'mobile-viewport'));
    for (const section of expected.requiredSections) {
      if (!page.sections.includes(section)) defects.push(defect('missing_required_section', expected.route, section));
    }
    for (const field of expected.requiredMetadata) {
      if (!page.metadata[field]) defects.push(defect('missing_required_metadata', expected.route, field));
    }
    for (const control of page.interactiveControls) {
      if (!control.accessibleName) defects.push(defect('missing_accessible_name', expected.route, control.id));
    }
  }
  for (const expected of normalizedRequest.acceptance.targets) {
    const page = pages.get(expected.fromRoute);
    const observed = page?.targets.find((target) => target.id === expected.id);
    let ok = Boolean(observed);
    if (observed && expected.semantics === 'route') {
      ok = targetHrefRoute(observed.href, normalizedRequest, expected.fromRoute) === expected.destination && pages.get(expected.destination)?.status >= 200 && pages.get(expected.destination)?.status < 300;
    } else if (observed && expected.semantics === 'anchor') {
      const resolved = targetHrefAnchor(observed.href, normalizedRequest, expected.fromRoute);
      ok = resolved?.route === expected.fromRoute && resolved?.hash === expected.destination && page?.anchors.includes(expected.destination.slice(1));
    } else if (observed && expected.semantics === 'external') {
      ok = externalTargetSyntax(expected.destination, observed.href, expected.expectedHref);
    }
    if (!ok) defects.push(defect('broken_required_target', expected.fromRoute, expected.id));
    if (observed && !observed.accessibleName) defects.push(defect('missing_accessible_name', expected.fromRoute, expected.id));
  }
  const observations = normalizeObservations(snapshot.observations);
  const canonicalDefects = defects.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const base = {
    ...evidenceBase(normalizedRequest),
    status: canonicalDefects.length ? 'defects' : 'pass',
    deterministicDefects: canonicalDefects,
    observations
  };
  return deepFreeze({ ...base, evidenceFingerprint: browserQaFingerprint(base) });
}
export function unavailableBrowserQaEvidence(request, reason = 'browser_runner_unavailable') {
  const base = {
    ...evidenceBase(request),
    status: 'unavailable',
    deterministicDefects: [],
    observations: [],
    unavailableReason: assertString(reason, 'unavailable_reason', { max: 160 })
  };
  return deepFreeze({ ...base, evidenceFingerprint: browserQaFingerprint(base) });
}
export function validateBrowserQaEvidence(request, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('browser_qa_evidence_invalid');
  for (const key of ['workflowId', 'websiteBlueprintFingerprint', 'reviewedChangeSetFingerprint', 'publishedCommitSha', 'previewUrl', 'acceptanceSchemaVersion', 'requestFingerprint']) {
    if (evidence[key] !== request[key]) throw new Error(`browser_qa_evidence_${key}_mismatch`);
  }
  if (!['pass', 'defects', 'unavailable'].includes(evidence.status)) throw new Error('browser_qa_evidence_status_invalid');
  if (!Array.isArray(evidence.deterministicDefects) || !Array.isArray(evidence.observations)) throw new Error('browser_qa_evidence_shape_invalid');
  if (evidence.deterministicDefects.some((item) => !item || !defectKinds.has(item.kind) || typeof item.route !== 'string' || typeof item.subject !== 'string')) throw new Error('browser_qa_evidence_defect_invalid');
  normalizeObservations(evidence.observations);
  if ((evidence.status === 'pass' && evidence.deterministicDefects.length) || (evidence.status === 'defects' && !evidence.deterministicDefects.length) || (evidence.status === 'unavailable' && (evidence.deterministicDefects.length || evidence.observations.length || typeof evidence.unavailableReason !== 'string'))) throw new Error('browser_qa_evidence_status_inconsistent');
  const copy = { ...evidence };
  delete copy.evidenceFingerprint;
  if (browserQaFingerprint(copy) !== evidence.evidenceFingerprint) throw new Error('browser_qa_evidence_fingerprint_mismatch');
  return true;
}
export function browserQaNavigationPlan(request) {
  const normalizedRequest = normalizeBoundBrowserQaRequest(request);
  const routes = [...new Set(normalizedRequest.acceptance.pages.map((page) => page.route))].sort();
  return deepFreeze({
    previewBaseUrl: normalizedRequest.previewUrl,
    sameOriginPages: routes.map((route) => ({ route, url: previewUrlForRoute(normalizedRequest.previewUrl, route) })),
    externalTargets: normalizedRequest.acceptance.targets.filter((target) => target.semantics === 'external').map((target) => ({ id: target.id, syntaxOnly: true }))
  });
}
export class BrowserQaCoordinator {
  constructor({ runner = null, timeoutMs = 30_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('browser_qa_runner_timeout_invalid');
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.latestByWorkflow = new Map();
  }
  record(request, evidence) {
    const normalizedRequest = normalizeBoundBrowserQaRequest(request);
    validateBrowserQaEvidence(normalizedRequest, evidence);
    const retainedEvidence = deepFreeze(canonicalValue(evidence));
    const prior = this.latestByWorkflow.get(normalizedRequest.workflowId) ?? null;
    if (prior?.evidenceFingerprint === retainedEvidence.evidenceFingerprint) return { evidence: prior, duplicate: true, invalidated: [] };
    const invalidated = prior && prior.requestFingerprint !== retainedEvidence.requestFingerprint ? [prior.evidenceFingerprint] : [];
    this.latestByWorkflow.set(normalizedRequest.workflowId, retainedEvidence);
    return { evidence: retainedEvidence, duplicate: false, invalidated };
  }
  async verify(request) {
    const normalizedRequest = normalizeBoundBrowserQaRequest(request);
    if (!this.runner || typeof this.runner.verify !== 'function') return this.record(normalizedRequest, unavailableBrowserQaEvidence(normalizedRequest));
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('browser_runner_timeout');
        error.code = 'BROWSER_RUNNER_TIMEOUT';
        reject(error);
      }, this.timeoutMs);
    });
    try {
      const runnerVerification = Promise.resolve().then(() => this.runner.verify({
        request: normalizedRequest,
        navigationPlan: browserQaNavigationPlan(normalizedRequest),
        signal: controller.signal,
        timeoutMs: this.timeoutMs
      }));
      const snapshot = await Promise.race([runnerVerification, timeout]);
      return this.record(normalizedRequest, classifyBrowserQaSnapshot(normalizedRequest, snapshot));
    } catch (error) {
      const reason = error?.code === 'BROWSER_RUNNER_TIMEOUT' ? 'browser_runner_timeout' : 'browser_runner_error';
      return this.record(normalizedRequest, unavailableBrowserQaEvidence(normalizedRequest, reason));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
