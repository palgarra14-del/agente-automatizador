import {
  browserQaFingerprint,
  browserQaNavigationPlan,
  validateBrowserQaEvidence
} from './browser-qa.js';

export const BROWSER_QA_CORRECTION_SCHEMA_VERSION = 'browser-qa-correction/v3';
export const BROWSER_QA_SOURCE_AUTHORIZATION_VERSION = 'browser-qa-source-authorization/v1';
export const BROWSER_QA_CORRECTION_PROVENANCE_VERSION = 'browser-qa-correction-provenance/v1';
export const BROWSER_QA_CORRECTION_STATE_VERSION = 'browser-qa-correction-state/v1';

const fingerprintPattern = /^[a-f0-9]{64}$/;
const workflowPattern = /^workflow-[A-Za-z0-9-]{8,120}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const controlSegmentPattern = /^(?:\.git|\.github|config|configs|scripts?|deploy|deployment|releases?|api|auth|security|secrets?|credentials?|creds?)$/i;
const controlFilePattern = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|\.yarnrc(?:\.yml)?|vercel\.json|Dockerfile[^/]*|(?:vite|next|nuxt|astro|svelte|eslint|postcss|tailwind)\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|\.env(?:\..*)?)$/i;
const forbiddenAuthority = Object.freeze([
  'dependency-change',
  'package-change',
  'config-change',
  'merge',
  'production-deploy',
  'external-communication'
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(code);
}

function assertFingerprint(value, code) {
  if (!fingerprintPattern.test(value ?? '')) throw new Error(code);
  return value;
}

function canonicalFilePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) throw new Error('browser_qa_correction_scope_invalid');
  const normalized = paths.map((path) => {
    if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') ||
        path.includes('\\') || /[\0\r\n*?\[\]{}]/.test(path)) {
      throw new Error('browser_qa_correction_scope_path_invalid');
    }
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('browser_qa_correction_scope_path_invalid');
    if (parts.some((part) => controlSegmentPattern.test(part) || part.startsWith('.'))) {
      throw new Error('browser_qa_correction_sensitive_path_forbidden');
    }
    const leaf = parts.at(-1);
    if (!leaf.includes('.')) throw new Error('browser_qa_correction_broad_scope_forbidden');
    if (controlFilePattern.test(leaf)) throw new Error('browser_qa_correction_sensitive_path_forbidden');
    return parts.join('/');
  });
  return [...new Set(normalized)].sort();
}

function canonicalDefects(value) {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error('browser_qa_correction_defects_invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.kind !== 'string' || typeof item.route !== 'string' || typeof item.subject !== 'string' ||
        !item.kind || !item.route || !item.subject ||
        item.kind.length > 120 || item.route.length > 500 || item.subject.length > 500 ||
        /[\0\r\n]/.test(item.kind + item.route + item.subject)) {
      throw new Error('browser_qa_correction_defect_invalid');
    }
    return { kind: item.kind, route: item.route, subject: item.subject };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function defectFingerprintFromDefects(defects) {
  return browserQaFingerprint({ version: 1, defects });
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('browser_qa_correction_request_binding_invalid');
  browserQaNavigationPlan(request);
  if (!workflowPattern.test(request.workflowId ?? '')) throw new Error('browser_qa_correction_workflow_invalid');
  if (!fingerprintPattern.test(request.requestFingerprint ?? '')) throw new Error('browser_qa_correction_request_fingerprint_invalid');
  if (!fingerprintPattern.test(request.websiteBlueprintFingerprint ?? '')) throw new Error('browser_qa_correction_blueprint_fingerprint_invalid');
  if (!fingerprintPattern.test(request.reviewedChangeSetFingerprint ?? '')) throw new Error('browser_qa_correction_reviewed_change_fingerprint_invalid');
  if (!commitPattern.test(request.publishedCommitSha ?? '')) throw new Error('browser_qa_correction_commit_invalid');
  return request;
}

function validateEvidence(request, evidence) {
  validateRequest(request);
  validateBrowserQaEvidence(request, evidence);
  return evidence;
}

function sourceAuthorizationBase({ workflowId, sourceRequestFingerprint, allowedPaths }) {
  return {
    version: BROWSER_QA_SOURCE_AUTHORIZATION_VERSION,
    workflowId,
    sourceRequestFingerprint,
    allowedPaths,
    scopeFingerprint: browserQaFingerprint({ version: 1, workflowId, sourceRequestFingerprint, allowedPaths })
  };
}

export function createBrowserQaSourceAuthorization(input = {}) {
  exactKeys(input, ['workflowId', 'sourceRequestFingerprint', 'allowedPaths'], 'browser_qa_source_authorization_input_invalid');
  if (!workflowPattern.test(input.workflowId ?? '')) throw new Error('browser_qa_source_authorization_workflow_invalid');
  assertFingerprint(input.sourceRequestFingerprint, 'browser_qa_source_authorization_request_invalid');
  const allowedPaths = canonicalFilePaths(input.allowedPaths);
  const base = sourceAuthorizationBase({
    workflowId: input.workflowId,
    sourceRequestFingerprint: input.sourceRequestFingerprint,
    allowedPaths
  });
  return freeze({ ...base, authorizationFingerprint: browserQaFingerprint(base) });
}

export function validateBrowserQaSourceAuthorization(value) {
  exactKeys(value, ['version', 'workflowId', 'sourceRequestFingerprint', 'allowedPaths', 'scopeFingerprint', 'authorizationFingerprint'], 'browser_qa_source_authorization_shape_invalid');
  if (value.version !== BROWSER_QA_SOURCE_AUTHORIZATION_VERSION) throw new Error('browser_qa_source_authorization_version_invalid');
  if (!workflowPattern.test(value.workflowId ?? '')) throw new Error('browser_qa_source_authorization_workflow_invalid');
  assertFingerprint(value.sourceRequestFingerprint, 'browser_qa_source_authorization_request_invalid');
  assertFingerprint(value.scopeFingerprint, 'browser_qa_source_authorization_scope_invalid');
  assertFingerprint(value.authorizationFingerprint, 'browser_qa_source_authorization_fingerprint_invalid');
  const paths = canonicalFilePaths(value.allowedPaths);
  if (JSON.stringify(paths) !== JSON.stringify(value.allowedPaths)) throw new Error('browser_qa_source_authorization_paths_not_canonical');
  const base = sourceAuthorizationBase({
    workflowId: value.workflowId,
    sourceRequestFingerprint: value.sourceRequestFingerprint,
    allowedPaths: paths
  });
  if (base.scopeFingerprint !== value.scopeFingerprint || browserQaFingerprint(base) !== value.authorizationFingerprint) {
    throw new Error('browser_qa_source_authorization_fingerprint_mismatch');
  }
  return true;
}

function correctionBase({ request, evidence, sourceAuthorization }) {
  const defects = canonicalDefects(evidence.deterministicDefects);
  return {
    schemaVersion: BROWSER_QA_CORRECTION_SCHEMA_VERSION,
    workflowId: request.workflowId,
    websiteBlueprintFingerprint: request.websiteBlueprintFingerprint,
    sourceRequestFingerprint: request.requestFingerprint,
    sourceEvidenceFingerprint: evidence.evidenceFingerprint,
    sourcePublishedCommitSha: request.publishedCommitSha,
    sourceReviewedChangeSetFingerprint: request.reviewedChangeSetFingerprint,
    sourceAuthorizationFingerprint: sourceAuthorization.authorizationFingerprint,
    deterministicDefects: defects,
    defectFingerprint: defectFingerprintFromDefects(defects),
    allowedPaths: [...sourceAuthorization.allowedPaths],
    scopeFingerprint: sourceAuthorization.scopeFingerprint,
    iteration: 1,
    forbiddenAuthority
  };
}

export function createBrowserQaCorrectionRequest(input = {}) {
  exactKeys(input, ['request', 'evidence', 'sourceAuthorization'], 'browser_qa_correction_input_invalid');
  const { request, evidence, sourceAuthorization } = input;
  validateEvidence(request, evidence);
  validateBrowserQaSourceAuthorization(sourceAuthorization);
  if (sourceAuthorization.workflowId !== request.workflowId ||
      sourceAuthorization.sourceRequestFingerprint !== request.requestFingerprint) {
    throw new Error('browser_qa_correction_source_authorization_mismatch');
  }
  if (evidence.status !== 'defects' || !evidence.deterministicDefects.length) {
    throw new Error('browser_qa_correction_defects_required');
  }
  const base = correctionBase({ request, evidence, sourceAuthorization });
  return freeze({ ...base, correctionFingerprint: browserQaFingerprint(base) });
}

export function validateBrowserQaCorrectionRequest(value) {
  exactKeys(value, [
    'schemaVersion', 'workflowId', 'websiteBlueprintFingerprint', 'sourceRequestFingerprint',
    'sourceEvidenceFingerprint', 'sourcePublishedCommitSha', 'sourceReviewedChangeSetFingerprint',
    'sourceAuthorizationFingerprint', 'deterministicDefects', 'defectFingerprint', 'allowedPaths',
    'scopeFingerprint', 'iteration', 'forbiddenAuthority', 'correctionFingerprint'
  ], 'browser_qa_correction_shape_invalid');
  if (value.schemaVersion !== BROWSER_QA_CORRECTION_SCHEMA_VERSION || value.iteration !== 1) {
    throw new Error('browser_qa_correction_schema_invalid');
  }
  if (!workflowPattern.test(value.workflowId ?? '')) throw new Error('browser_qa_correction_workflow_invalid');
  if (!commitPattern.test(value.sourcePublishedCommitSha ?? '')) throw new Error('browser_qa_correction_source_commit_invalid');
  for (const [key, code] of [
    ['websiteBlueprintFingerprint', 'browser_qa_correction_blueprint_fingerprint_invalid'],
    ['sourceRequestFingerprint', 'browser_qa_correction_source_request_invalid'],
    ['sourceEvidenceFingerprint', 'browser_qa_correction_source_evidence_invalid'],
    ['sourceReviewedChangeSetFingerprint', 'browser_qa_correction_source_reviewed_change_invalid'],
    ['sourceAuthorizationFingerprint', 'browser_qa_correction_source_authorization_invalid'],
    ['defectFingerprint', 'browser_qa_correction_defect_fingerprint_invalid'],
    ['scopeFingerprint', 'browser_qa_correction_scope_fingerprint_invalid'],
    ['correctionFingerprint', 'browser_qa_correction_fingerprint_invalid']
  ]) assertFingerprint(value[key], code);

  const allowedPaths = canonicalFilePaths(value.allowedPaths);
  if (JSON.stringify(allowedPaths) !== JSON.stringify(value.allowedPaths)) throw new Error('browser_qa_correction_scope_not_canonical');
  const defects = canonicalDefects(value.deterministicDefects);
  if (JSON.stringify(defects) !== JSON.stringify(value.deterministicDefects)) throw new Error('browser_qa_correction_defects_not_canonical');
  if (defectFingerprintFromDefects(defects) !== value.defectFingerprint) throw new Error('browser_qa_correction_defect_fingerprint_mismatch');
  if (JSON.stringify(value.forbiddenAuthority) !== JSON.stringify(forbiddenAuthority)) throw new Error('browser_qa_correction_authority_invalid');

  const authBase = sourceAuthorizationBase({
    workflowId: value.workflowId,
    sourceRequestFingerprint: value.sourceRequestFingerprint,
    allowedPaths
  });
  if (authBase.scopeFingerprint !== value.scopeFingerprint ||
      browserQaFingerprint(authBase) !== value.sourceAuthorizationFingerprint) {
    throw new Error('browser_qa_correction_source_authorization_mismatch');
  }

  const expectedBase = {
    schemaVersion: value.schemaVersion,
    workflowId: value.workflowId,
    websiteBlueprintFingerprint: value.websiteBlueprintFingerprint,
    sourceRequestFingerprint: value.sourceRequestFingerprint,
    sourceEvidenceFingerprint: value.sourceEvidenceFingerprint,
    sourcePublishedCommitSha: value.sourcePublishedCommitSha,
    sourceReviewedChangeSetFingerprint: value.sourceReviewedChangeSetFingerprint,
    sourceAuthorizationFingerprint: value.sourceAuthorizationFingerprint,
    deterministicDefects: defects,
    defectFingerprint: value.defectFingerprint,
    allowedPaths,
    scopeFingerprint: value.scopeFingerprint,
    iteration: 1,
    forbiddenAuthority
  };
  if (browserQaFingerprint(expectedBase) !== value.correctionFingerprint) throw new Error('browser_qa_correction_fingerprint_mismatch');
  return true;
}

function publicationBase(value) {
  return {
    version: BROWSER_QA_CORRECTION_PROVENANCE_VERSION,
    workflowId: value.workflowId,
    correctionFingerprint: value.correctionFingerprint,
    sourceCommitSha: value.sourceCommitSha,
    correctedCommitSha: value.correctedCommitSha,
    correctedRequestFingerprint: value.correctedRequestFingerprint,
    reviewedChangeSetFingerprint: value.reviewedChangeSetFingerprint,
    changedPaths: value.changedPaths,
    sourceAncestorVerified: value.sourceAncestorVerified
  };
}

export function createBrowserQaCorrectionPublicationEvidence(input = {}) {
  exactKeys(input, [
    'correctionRequest', 'correctedCommitSha', 'correctedRequestFingerprint',
    'reviewedChangeSetFingerprint', 'changedPaths', 'sourceAncestorVerified'
  ], 'browser_qa_correction_provenance_input_invalid');
  validateBrowserQaCorrectionRequest(input.correctionRequest);
  if (!commitPattern.test(input.correctedCommitSha ?? '') ||
      input.correctedCommitSha === input.correctionRequest.sourcePublishedCommitSha) {
    throw new Error('browser_qa_correction_corrected_commit_invalid');
  }
  assertFingerprint(input.correctedRequestFingerprint, 'browser_qa_correction_corrected_request_invalid');
  assertFingerprint(input.reviewedChangeSetFingerprint, 'browser_qa_correction_corrected_review_invalid');
  if (input.sourceAncestorVerified !== true) throw new Error('browser_qa_correction_source_ancestry_unverified');
  const changedPaths = canonicalFilePaths(input.changedPaths);
  if (!changedPaths.length || changedPaths.some((path) => !input.correctionRequest.allowedPaths.includes(path))) {
    throw new Error('browser_qa_correction_changed_paths_out_of_scope');
  }
  const base = publicationBase({
    workflowId: input.correctionRequest.workflowId,
    correctionFingerprint: input.correctionRequest.correctionFingerprint,
    sourceCommitSha: input.correctionRequest.sourcePublishedCommitSha,
    correctedCommitSha: input.correctedCommitSha,
    correctedRequestFingerprint: input.correctedRequestFingerprint,
    reviewedChangeSetFingerprint: input.reviewedChangeSetFingerprint,
    changedPaths,
    sourceAncestorVerified: true
  });
  return freeze({ ...base, provenanceFingerprint: browserQaFingerprint(base) });
}

export function validateBrowserQaCorrectionPublicationEvidence(correctionRequest, value) {
  validateBrowserQaCorrectionRequest(correctionRequest);
  exactKeys(value, [
    'version', 'workflowId', 'correctionFingerprint', 'sourceCommitSha', 'correctedCommitSha',
    'correctedRequestFingerprint', 'reviewedChangeSetFingerprint', 'changedPaths',
    'sourceAncestorVerified', 'provenanceFingerprint'
  ], 'browser_qa_correction_provenance_shape_invalid');
  if (value.version !== BROWSER_QA_CORRECTION_PROVENANCE_VERSION ||
      value.workflowId !== correctionRequest.workflowId ||
      value.correctionFingerprint !== correctionRequest.correctionFingerprint ||
      value.sourceCommitSha !== correctionRequest.sourcePublishedCommitSha ||
      value.sourceAncestorVerified !== true) {
    throw new Error('browser_qa_correction_provenance_binding_invalid');
  }
  if (!commitPattern.test(value.correctedCommitSha ?? '') || value.correctedCommitSha === value.sourceCommitSha) {
    throw new Error('browser_qa_correction_corrected_commit_invalid');
  }
  assertFingerprint(value.correctedRequestFingerprint, 'browser_qa_correction_corrected_request_invalid');
  assertFingerprint(value.reviewedChangeSetFingerprint, 'browser_qa_correction_corrected_review_invalid');
  assertFingerprint(value.provenanceFingerprint, 'browser_qa_correction_provenance_fingerprint_invalid');
  const paths = canonicalFilePaths(value.changedPaths);
  if (JSON.stringify(paths) !== JSON.stringify(value.changedPaths) ||
      paths.some((path) => !correctionRequest.allowedPaths.includes(path))) {
    throw new Error('browser_qa_correction_changed_paths_out_of_scope');
  }
  const base = publicationBase({ ...value, changedPaths: paths });
  if (browserQaFingerprint(base) !== value.provenanceFingerprint) {
    throw new Error('browser_qa_correction_provenance_fingerprint_mismatch');
  }
  return true;
}

function initialDecision(evidence) {
  if (evidence.status === 'unavailable') {
    return freeze({ status: 'blocked', reason: 'browser_qa_unavailable', evidenceFingerprint: evidence.evidenceFingerprint });
  }
  if (evidence.status === 'pass' && evidence.observations.length) {
    return freeze({ status: 'review_only', reason: 'judgment_observations', evidenceFingerprint: evidence.evidenceFingerprint });
  }
  if (evidence.status === 'pass') {
    return freeze({ status: 'no_correction', reason: 'browser_qa_pass', evidenceFingerprint: evidence.evidenceFingerprint });
  }
  return null;
}

function cycleState(correctionRequest) {
  return {
    workflowId: correctionRequest.workflowId,
    correctionRequest: clone(correctionRequest),
    phase: 'requested',
    correctedRequestFingerprint: null,
    correctedCommitSha: null,
    correctedReviewedChangeSetFingerprint: null,
    provenanceFingerprint: null,
    finalEvidenceFingerprint: null,
    finalDecision: null
  };
}

function validateCycle(value) {
  exactKeys(value, [
    'workflowId', 'correctionRequest', 'phase', 'correctedRequestFingerprint',
    'correctedCommitSha', 'correctedReviewedChangeSetFingerprint', 'provenanceFingerprint',
    'finalEvidenceFingerprint', 'finalDecision'
  ], 'browser_qa_correction_cycle_state_invalid');
  validateBrowserQaCorrectionRequest(value.correctionRequest);
  if (value.workflowId !== value.correctionRequest.workflowId || !['requested', 'bound', 'finalized'].includes(value.phase)) {
    throw new Error('browser_qa_correction_cycle_state_invalid');
  }
  const nullableFingerprint = (item) => item === null || fingerprintPattern.test(item);
  const nullableCommit = (item) => item === null || commitPattern.test(item);
  if (!nullableFingerprint(value.correctedRequestFingerprint) ||
      !nullableCommit(value.correctedCommitSha) ||
      !nullableFingerprint(value.correctedReviewedChangeSetFingerprint) ||
      !nullableFingerprint(value.provenanceFingerprint) ||
      !nullableFingerprint(value.finalEvidenceFingerprint)) {
    throw new Error('browser_qa_correction_cycle_state_invalid');
  }
  if (value.phase === 'requested') {
    if ([value.correctedRequestFingerprint, value.correctedCommitSha, value.correctedReviewedChangeSetFingerprint,
      value.provenanceFingerprint, value.finalEvidenceFingerprint, value.finalDecision].some((item) => item !== null)) {
      throw new Error('browser_qa_correction_cycle_state_invalid');
    }
  }
  if (value.phase === 'bound') {
    if (!value.correctedRequestFingerprint || !value.correctedCommitSha || !value.correctedReviewedChangeSetFingerprint ||
        !value.provenanceFingerprint || value.finalEvidenceFingerprint !== null || value.finalDecision !== null) {
      throw new Error('browser_qa_correction_cycle_state_invalid');
    }
  }
  if (value.phase === 'finalized') {
    if (!value.correctedRequestFingerprint || !value.correctedCommitSha || !value.correctedReviewedChangeSetFingerprint ||
        !value.provenanceFingerprint || !value.finalEvidenceFingerprint || !value.finalDecision ||
        typeof value.finalDecision !== 'object' || Array.isArray(value.finalDecision)) {
      throw new Error('browser_qa_correction_cycle_state_invalid');
    }
  }
  return true;
}

function stateBase(cycles) {
  return {
    version: BROWSER_QA_CORRECTION_STATE_VERSION,
    cycles: cycles.map((cycle) => canonical(cycle)).sort((a, b) => a.workflowId.localeCompare(b.workflowId))
  };
}

export function validateBrowserQaAutocorrectionState(value) {
  exactKeys(value, ['version', 'cycles', 'stateFingerprint'], 'browser_qa_correction_state_shape_invalid');
  if (value.version !== BROWSER_QA_CORRECTION_STATE_VERSION || !Array.isArray(value.cycles) || value.cycles.length > 500) {
    throw new Error('browser_qa_correction_state_invalid');
  }
  const seen = new Set();
  for (const cycle of value.cycles) {
    validateCycle(cycle);
    if (seen.has(cycle.workflowId)) throw new Error('browser_qa_correction_state_duplicate_workflow');
    seen.add(cycle.workflowId);
  }
  const base = stateBase(value.cycles);
  if (browserQaFingerprint(base) !== value.stateFingerprint) throw new Error('browser_qa_correction_state_fingerprint_mismatch');
  return true;
}

export class BrowserQaAutocorrectionCoordinator {
  constructor({ state = null } = {}) {
    this.cycles = new Map();
    if (state !== null) {
      validateBrowserQaAutocorrectionState(state);
      for (const cycle of state.cycles) this.cycles.set(cycle.workflowId, clone(cycle));
    }
  }

  exportState() {
    const base = stateBase([...this.cycles.values()]);
    return freeze({ ...base, stateFingerprint: browserQaFingerprint(base) });
  }

  considerInitial(input = {}) {
    exactKeys(input, ['request', 'evidence', 'sourceAuthorization'], 'browser_qa_correction_initial_input_invalid');
    const { request, evidence, sourceAuthorization } = input;
    validateEvidence(request, evidence);
    validateBrowserQaSourceAuthorization(sourceAuthorization);
    if (sourceAuthorization.workflowId !== request.workflowId ||
        sourceAuthorization.sourceRequestFingerprint !== request.requestFingerprint) {
      throw new Error('browser_qa_correction_source_authorization_mismatch');
    }

    const existing = this.cycles.get(request.workflowId);
    if (existing) {
      const correction = existing.correctionRequest;
      if (correction.sourceRequestFingerprint === request.requestFingerprint &&
          correction.sourceEvidenceFingerprint === evidence.evidenceFingerprint &&
          correction.sourceAuthorizationFingerprint === sourceAuthorization.authorizationFingerprint &&
          evidence.status === 'defects') {
        return freeze({ status: 'correction_requested', duplicate: true, correctionRequest: freeze(clone(correction)) });
      }
      throw new Error('browser_qa_correction_cycle_already_started');
    }

    const trivial = initialDecision(evidence);
    if (trivial) return trivial;
    const correctionRequest = createBrowserQaCorrectionRequest({ request, evidence, sourceAuthorization });
    this.cycles.set(request.workflowId, cycleState(correctionRequest));
    return freeze({ status: 'correction_requested', duplicate: false, correctionRequest });
  }

  bindCorrectedPreview(input = {}) {
    exactKeys(input, ['correctionRequest', 'request', 'publicationEvidence'], 'browser_qa_correction_bind_input_invalid');
    const { correctionRequest, request, publicationEvidence } = input;
    validateBrowserQaCorrectionRequest(correctionRequest);
    validateRequest(request);
    validateBrowserQaCorrectionPublicationEvidence(correctionRequest, publicationEvidence);
    const cycle = this.cycles.get(correctionRequest.workflowId);
    if (!cycle || cycle.correctionRequest.correctionFingerprint !== correctionRequest.correctionFingerprint) {
      throw new Error('browser_qa_correction_cycle_missing');
    }
    if (cycle.phase === 'finalized') throw new Error('browser_qa_correction_cycle_finalized');
    if (request.workflowId !== correctionRequest.workflowId) throw new Error('browser_qa_correction_workflow_changed');
    if (request.websiteBlueprintFingerprint !== correctionRequest.websiteBlueprintFingerprint) {
      throw new Error('browser_qa_correction_blueprint_changed');
    }
    if (request.requestFingerprint === correctionRequest.sourceRequestFingerprint ||
        request.publishedCommitSha === correctionRequest.sourcePublishedCommitSha) {
      throw new Error('browser_qa_correction_preview_not_changed');
    }
    if (request.requestFingerprint !== publicationEvidence.correctedRequestFingerprint ||
        request.publishedCommitSha !== publicationEvidence.correctedCommitSha ||
        request.reviewedChangeSetFingerprint !== publicationEvidence.reviewedChangeSetFingerprint) {
      throw new Error('browser_qa_correction_provenance_request_mismatch');
    }
    if (cycle.phase === 'bound') {
      if (cycle.correctedRequestFingerprint === request.requestFingerprint &&
          cycle.provenanceFingerprint === publicationEvidence.provenanceFingerprint) {
        return freeze({
          status: 'correction_bound',
          duplicate: true,
          correctionFingerprint: correctionRequest.correctionFingerprint,
          correctedRequestFingerprint: request.requestFingerprint,
          publishedCommitSha: request.publishedCommitSha
        });
      }
      throw new Error('browser_qa_correction_preview_already_bound');
    }
    cycle.phase = 'bound';
    cycle.correctedRequestFingerprint = request.requestFingerprint;
    cycle.correctedCommitSha = request.publishedCommitSha;
    cycle.correctedReviewedChangeSetFingerprint = request.reviewedChangeSetFingerprint;
    cycle.provenanceFingerprint = publicationEvidence.provenanceFingerprint;
    return freeze({
      status: 'correction_bound',
      duplicate: false,
      correctionFingerprint: correctionRequest.correctionFingerprint,
      correctedRequestFingerprint: request.requestFingerprint,
      publishedCommitSha: request.publishedCommitSha
    });
  }

  considerCorrected(input = {}) {
    exactKeys(input, ['correctionFingerprint', 'request', 'evidence'], 'browser_qa_correction_corrected_input_invalid');
    const { correctionFingerprint, request, evidence } = input;
    assertFingerprint(correctionFingerprint, 'browser_qa_correction_fingerprint_invalid');
    validateEvidence(request, evidence);
    const cycle = this.cycles.get(request.workflowId);
    if (!cycle || cycle.correctionRequest.correctionFingerprint !== correctionFingerprint) {
      throw new Error('browser_qa_correction_cycle_missing');
    }
    if (cycle.phase === 'requested') throw new Error('browser_qa_correction_preview_not_bound');
    if (cycle.correctedRequestFingerprint !== request.requestFingerprint ||
        cycle.correctedCommitSha !== request.publishedCommitSha ||
        cycle.correctedReviewedChangeSetFingerprint !== request.reviewedChangeSetFingerprint) {
      throw new Error('browser_qa_correction_evidence_stale');
    }
    if (cycle.phase === 'finalized') {
      if (cycle.finalEvidenceFingerprint === evidence.evidenceFingerprint) return freeze(clone(cycle.finalDecision));
      throw new Error('browser_qa_correction_cycle_finalized');
    }

    let decision;
    if (evidence.status === 'unavailable') {
      decision = { status: 'blocked', reason: 'corrected_browser_qa_unavailable' };
    } else if (evidence.status === 'pass') {
      decision = {
        status: evidence.observations.length ? 'resolved_review_required' : 'resolved',
        reason: evidence.observations.length ? 'judgment_observations' : 'browser_qa_pass'
      };
    } else {
      const currentDefects = canonicalDefects(evidence.deterministicDefects);
      const currentDefectFingerprint = defectFingerprintFromDefects(currentDefects);
      decision = currentDefectFingerprint === cycle.correctionRequest.defectFingerprint
        ? { status: 'blocked', reason: 'identical_defects_after_correction', defectFingerprint: currentDefectFingerprint }
        : { status: 'blocked', reason: 'correction_iteration_limit', defectFingerprint: currentDefectFingerprint };
    }
    const finalDecision = freeze({
      ...decision,
      evidenceFingerprint: evidence.evidenceFingerprint,
      correctionFingerprint
    });
    cycle.phase = 'finalized';
    cycle.finalEvidenceFingerprint = evidence.evidenceFingerprint;
    cycle.finalDecision = clone(finalDecision);
    return finalDecision;
  }
}
