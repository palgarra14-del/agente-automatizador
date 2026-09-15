import { createHash } from 'node:crypto';

const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const fingerprintPattern = /^[a-f0-9]{64}$/i;
const workflowIdPattern = /^workflow-[A-Za-z0-9-]{8,120}$/;
const defectCodes = new Set([
  'preview-load-failed',
  'blank-body',
  'framework-error-overlay',
  'missing-required-route',
  'missing-required-section',
  'missing-required-cta-target',
  'broken-required-target',
  'horizontal-overflow',
  'missing-required-metadata',
  'accessibility-contract-failure'
]);
const observationCodes = new Set([
  'visual-hierarchy',
  'spacing',
  'imagery',
  'brand-fit',
  'readability',
  'responsive-polish',
  'other'
]);
const observationSeverities = new Set(['low', 'medium', 'high']);

function boundedString(value, label, { max = 500, required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${label}_required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\0\r\n]/.test(text)) throw new Error(`${label}_invalid`);
  return text || null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stableFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function cleanPreviewUrl(value) {
  const text = boundedString(value, 'browser_qa_preview_url', { max: 2_000 });
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error('browser_qa_preview_url_invalid'); }
  if (parsed.protocol !== 'https:') throw new Error('browser_qa_preview_url_https_required');
  if (parsed.username || parsed.password) throw new Error('browser_qa_preview_url_credentials_forbidden');
  if (parsed.search || parsed.hash) throw new Error('browser_qa_preview_url_query_fragment_forbidden');
  if (!parsed.hostname || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('browser_qa_preview_url_public_host_required');
  }
  if (parsed.port && parsed.port !== '443') throw new Error('browser_qa_preview_url_port_forbidden');
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.toString();
}

export function normalizeBrowserQaTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('browser_qa_target_invalid');
  const allowed = new Set([
    'version',
    'workflowId',
    'websiteBlueprintFingerprint',
    'reviewedChangeSetFingerprint',
    'commitSha',
    'previewUrl',
    'previewState',
    'acceptanceSchemaVersion'
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('browser_qa_target_unknown_field');
  if (input.version !== 1 || input.acceptanceSchemaVersion !== 1) throw new Error('browser_qa_target_version_invalid');
  const workflowId = boundedString(input.workflowId, 'browser_qa_workflow_id', { max: 140 });
  if (!workflowIdPattern.test(workflowId)) throw new Error('browser_qa_workflow_id_invalid');
  const websiteBlueprintFingerprint = boundedString(input.websiteBlueprintFingerprint, 'browser_qa_blueprint_fingerprint', { max: 64 });
  const reviewedChangeSetFingerprint = boundedString(input.reviewedChangeSetFingerprint, 'browser_qa_changeset_fingerprint', { max: 64 });
  const commitSha = boundedString(input.commitSha, 'browser_qa_commit_sha', { max: 64 });
  if (!fingerprintPattern.test(websiteBlueprintFingerprint)) throw new Error('browser_qa_blueprint_fingerprint_invalid');
  if (!fingerprintPattern.test(reviewedChangeSetFingerprint)) throw new Error('browser_qa_changeset_fingerprint_invalid');
  if (!shaPattern.test(commitSha)) throw new Error('browser_qa_commit_sha_invalid');
  if (input.previewState !== 'READY') throw new Error('browser_qa_preview_not_ready');
  return {
    version: 1,
    workflowId,
    websiteBlueprintFingerprint: websiteBlueprintFingerprint.toLowerCase(),
    reviewedChangeSetFingerprint: reviewedChangeSetFingerprint.toLowerCase(),
    commitSha: commitSha.toLowerCase(),
    previewUrl: cleanPreviewUrl(input.previewUrl),
    previewState: 'READY',
    acceptanceSchemaVersion: 1
  };
}

function normalizeViewport(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser_qa_viewport_invalid');
  const allowed = new Set(['width', 'height']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('browser_qa_viewport_unknown_field');
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width < 240 || width > 8_000 || !Number.isInteger(height) || height < 240 || height > 8_000) {
    throw new Error('browser_qa_viewport_invalid');
  }
  return { width, height };
}

function normalizeDefect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser_qa_defect_invalid');
  const allowed = new Set(['code', 'route', 'subject', 'viewport', 'detail']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('browser_qa_defect_unknown_field');
  const code = boundedString(value.code, 'browser_qa_defect_code', { max: 80 });
  if (!defectCodes.has(code)) throw new Error('browser_qa_defect_code_invalid');
  const route = boundedString(value.route, 'browser_qa_defect_route', { max: 300, required: false });
  if (route !== null && !route.startsWith('/')) throw new Error('browser_qa_defect_route_invalid');
  return {
    code,
    route,
    subject: boundedString(value.subject, 'browser_qa_defect_subject', { max: 300, required: false }),
    viewport: normalizeViewport(value.viewport),
    detail: boundedString(value.detail, 'browser_qa_defect_detail', { max: 700, required: false })
  };
}

function normalizeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser_qa_observation_invalid');
  const allowed = new Set(['code', 'severity', 'route', 'viewport', 'message']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('browser_qa_observation_unknown_field');
  const code = boundedString(value.code, 'browser_qa_observation_code', { max: 80 });
  const severity = boundedString(value.severity, 'browser_qa_observation_severity', { max: 20 });
  if (!observationCodes.has(code)) throw new Error('browser_qa_observation_code_invalid');
  if (!observationSeverities.has(severity)) throw new Error('browser_qa_observation_severity_invalid');
  const route = boundedString(value.route, 'browser_qa_observation_route', { max: 300, required: false });
  if (route !== null && !route.startsWith('/')) throw new Error('browser_qa_observation_route_invalid');
  return {
    code,
    severity,
    route,
    viewport: normalizeViewport(value.viewport),
    message: boundedString(value.message, 'browser_qa_observation_message', { max: 700 })
  };
}

function sortCanonicalItems(items) {
  return [...items].sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))));
}

export function normalizeBrowserQaEvidence(input, expectedTarget) {
  const target = normalizeBrowserQaTarget(expectedTarget);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('browser_qa_evidence_invalid');
  const allowed = new Set(['version', 'target', 'availability', 'deterministicDefects', 'observations']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('browser_qa_evidence_unknown_field');
  if (input.version !== 1) throw new Error('browser_qa_evidence_version_invalid');
  const observedTarget = normalizeBrowserQaTarget(input.target);
  if (JSON.stringify(observedTarget) !== JSON.stringify(target)) throw new Error('browser_qa_target_binding_mismatch');
  if (!['available', 'unavailable'].includes(input.availability)) throw new Error('browser_qa_availability_invalid');

  const defects = Array.isArray(input.deterministicDefects) ? input.deterministicDefects.map(normalizeDefect) : null;
  const observations = Array.isArray(input.observations) ? input.observations.map(normalizeObservation) : null;
  if (defects === null || observations === null) throw new Error('browser_qa_evidence_arrays_required');
  if (defects.length > 100 || observations.length > 100) throw new Error('browser_qa_evidence_too_many_items');

  const deterministicDefects = sortCanonicalItems(defects);
  const normalizedObservations = sortCanonicalItems(observations);
  if (input.availability === 'unavailable' && (deterministicDefects.length || normalizedObservations.length)) {
    throw new Error('browser_qa_unavailable_cannot_claim_evidence');
  }

  const status = input.availability === 'unavailable'
    ? 'UNAVAILABLE'
    : deterministicDefects.length
      ? 'FAIL'
      : normalizedObservations.length
        ? 'REVIEW_REQUIRED'
        : 'PASS';

  const material = {
    version: 1,
    target,
    availability: input.availability,
    status,
    deterministicDefects,
    observations: normalizedObservations
  };
  return {
    ...material,
    evidenceFingerprint: stableFingerprint(material),
    deterministicDefectFingerprint: stableFingerprint({
      target,
      deterministicDefects
    })
  };
}

export function assertBrowserQaEvidenceBound(evidence, expectedTarget) {
  const normalized = normalizeBrowserQaEvidence(evidence, expectedTarget);
  if (evidence.evidenceFingerprint !== undefined && evidence.evidenceFingerprint !== normalized.evidenceFingerprint) {
    throw new Error('browser_qa_evidence_fingerprint_mismatch');
  }
  if (
    evidence.deterministicDefectFingerprint !== undefined &&
    evidence.deterministicDefectFingerprint !== normalized.deterministicDefectFingerprint
  ) {
    throw new Error('browser_qa_defect_fingerprint_mismatch');
  }
  return normalized;
}

export function browserQaUnavailableEvidence(target) {
  return normalizeBrowserQaEvidence({
    version: 1,
    target: normalizeBrowserQaTarget(target),
    availability: 'unavailable',
    deterministicDefects: [],
    observations: []
  }, target);
}

export const browserQaDeterministicDefectCodes = Object.freeze([...defectCodes].sort());
export const browserQaObservationCodes = Object.freeze([...observationCodes].sort());
