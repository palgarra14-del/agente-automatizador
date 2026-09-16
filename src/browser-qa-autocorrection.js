import {
  browserQaFingerprint,
  browserQaNavigationPlan,
  validateBrowserQaEvidence
} from './browser-qa.js';

export const BROWSER_QA_CORRECTION_SCHEMA_VERSION = 'browser-qa-correction/v1';
const fingerprintPattern = /^[a-f0-9]{64}$/;
const workflowPattern = /^workflow-[A-Za-z0-9-]{8,120}$/;

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function canonicalPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) throw new Error('browser_qa_correction_scope_invalid');
  const normalized = paths.map((path) => {
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 500 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\0\r\n]/.test(path)
    ) throw new Error('browser_qa_correction_scope_path_invalid');
    return path;
  });
  return [...new Set(normalized)].sort();
}

function defectFingerprint(evidence) {
  const defects = [...evidence.deterministicDefects]
    .map((item) => ({ kind: item.kind, route: item.route, subject: item.subject }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return browserQaFingerprint({ version: 1, defects });
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('browser_qa_correction_request_binding_invalid');
  browserQaNavigationPlan(request);
  if (!workflowPattern.test(request.workflowId ?? '')) throw new Error('browser_qa_correction_workflow_invalid');
  return request;
}

function validateEvidence(request, evidence) {
  validateRequest(request);
  validateBrowserQaEvidence(request, evidence);
  return evidence;
}

function correctionFingerprintBase(input) {
  return {
    schemaVersion: BROWSER_QA_CORRECTION_SCHEMA_VERSION,
    workflowId: input.workflowId,
    websiteBlueprintFingerprint: input.websiteBlueprintFingerprint,
    sourceRequestFingerprint: input.sourceRequestFingerprint,
    sourceEvidenceFingerprint: input.sourceEvidenceFingerprint,
    sourcePublishedCommitSha: input.sourcePublishedCommitSha,
    sourceReviewedChangeSetFingerprint: input.sourceReviewedChangeSetFingerprint,
    defectFingerprint: input.defectFingerprint,
    scopeFingerprint: input.scopeFingerprint,
    iteration: 1
  };
}

export function createBrowserQaCorrectionRequest({ request, evidence, allowedPaths } = {}) {
  validateEvidence(request, evidence);
  if (evidence.status !== 'defects' || !evidence.deterministicDefects.length) {
    throw new Error('browser_qa_correction_defects_required');
  }
  const paths = canonicalPaths(allowedPaths);
  const scopeFingerprint = browserQaFingerprint({ version: 1, allowedPaths: paths });
  const base = correctionFingerprintBase({
    workflowId: request.workflowId,
    websiteBlueprintFingerprint: request.websiteBlueprintFingerprint,
    sourceRequestFingerprint: request.requestFingerprint,
    sourceEvidenceFingerprint: evidence.evidenceFingerprint,
    sourcePublishedCommitSha: request.publishedCommitSha,
    sourceReviewedChangeSetFingerprint: request.reviewedChangeSetFingerprint,
    defectFingerprint: defectFingerprint(evidence),
    scopeFingerprint
  });
  const correction = {
    ...base,
    allowedPaths: paths,
    forbiddenAuthority: [
      'dependency-change',
      'package-change',
      'config-change',
      'merge',
      'production-deploy',
      'external-communication'
    ],
    correctionFingerprint: browserQaFingerprint(base)
  };
  return freeze(correction);
}

export function validateBrowserQaCorrectionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser_qa_correction_invalid');
  if (value.schemaVersion !== BROWSER_QA_CORRECTION_SCHEMA_VERSION || value.iteration !== 1) throw new Error('browser_qa_correction_schema_invalid');
  if (!workflowPattern.test(value.workflowId ?? '')) throw new Error('browser_qa_correction_workflow_invalid');
  for (const key of [
    'websiteBlueprintFingerprint',
    'sourceRequestFingerprint',
    'sourceEvidenceFingerprint',
    'defectFingerprint',
    'scopeFingerprint',
    'correctionFingerprint'
  ]) {
    if (!fingerprintPattern.test(value[key] ?? '')) throw new Error(`browser_qa_correction_${key}_invalid`);
  }
  const paths = canonicalPaths(value.allowedPaths);
  if (browserQaFingerprint({ version: 1, allowedPaths: paths }) !== value.scopeFingerprint) {
    throw new Error('browser_qa_correction_scope_fingerprint_mismatch');
  }
  const expected = browserQaFingerprint(correctionFingerprintBase(value));
  if (expected !== value.correctionFingerprint) throw new Error('browser_qa_correction_fingerprint_mismatch');
  return true;
}

function initialDecision(request, evidence) {
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

export class BrowserQaAutocorrectionCoordinator {
  constructor() {
    this.cycles = new Map();
  }

  considerInitial({ request, evidence, allowedPaths } = {}) {
    validateEvidence(request, evidence);
    const trivial = initialDecision(request, evidence);
    if (trivial) return trivial;

    const correctionRequest = createBrowserQaCorrectionRequest({ request, evidence, allowedPaths });
    const existing = this.cycles.get(request.workflowId);
    if (existing) {
      if (
        existing.correctionRequest.sourceRequestFingerprint === request.requestFingerprint &&
        existing.correctionRequest.sourceEvidenceFingerprint === evidence.evidenceFingerprint &&
        existing.correctionRequest.scopeFingerprint === correctionRequest.scopeFingerprint
      ) {
        return freeze({ status: 'correction_requested', duplicate: true, correctionRequest: existing.correctionRequest });
      }
      throw new Error('browser_qa_correction_cycle_already_started');
    }

    const cycle = {
      correctionRequest,
      sourceRequest: request,
      sourceDefectFingerprint: correctionRequest.defectFingerprint,
      correctedRequestFingerprint: null,
      correctedRequest: null,
      finalEvidenceFingerprint: null,
      finalDecision: null
    };
    this.cycles.set(request.workflowId, cycle);
    return freeze({ status: 'correction_requested', duplicate: false, correctionRequest });
  }

  bindCorrectedPreview({ correctionRequest, request } = {}) {
    validateBrowserQaCorrectionRequest(correctionRequest);
    validateRequest(request);
    const cycle = this.cycles.get(correctionRequest.workflowId);
    if (!cycle || cycle.correctionRequest.correctionFingerprint !== correctionRequest.correctionFingerprint) {
      throw new Error('browser_qa_correction_cycle_missing');
    }
    if (request.workflowId !== cycle.sourceRequest.workflowId) throw new Error('browser_qa_correction_workflow_changed');
    if (request.websiteBlueprintFingerprint !== cycle.sourceRequest.websiteBlueprintFingerprint) {
      throw new Error('browser_qa_correction_blueprint_changed');
    }
    if (request.requestFingerprint === cycle.sourceRequest.requestFingerprint || request.publishedCommitSha === cycle.sourceRequest.publishedCommitSha) {
      throw new Error('browser_qa_correction_preview_not_changed');
    }
    if (request.reviewedChangeSetFingerprint === cycle.sourceRequest.reviewedChangeSetFingerprint) {
      throw new Error('browser_qa_correction_change_fingerprint_not_changed');
    }
    if (cycle.correctedRequestFingerprint && cycle.correctedRequestFingerprint !== request.requestFingerprint) {
      throw new Error('browser_qa_correction_preview_already_bound');
    }
    cycle.correctedRequestFingerprint = request.requestFingerprint;
    cycle.correctedRequest = request;
    return freeze({
      status: 'correction_bound',
      correctionFingerprint: correctionRequest.correctionFingerprint,
      correctedRequestFingerprint: request.requestFingerprint,
      publishedCommitSha: request.publishedCommitSha
    });
  }

  considerCorrected({ correctionFingerprint, request, evidence } = {}) {
    if (!fingerprintPattern.test(correctionFingerprint ?? '')) throw new Error('browser_qa_correction_fingerprint_invalid');
    validateEvidence(request, evidence);
    const cycle = this.cycles.get(request.workflowId);
    if (!cycle || cycle.correctionRequest.correctionFingerprint !== correctionFingerprint) {
      throw new Error('browser_qa_correction_cycle_missing');
    }
    if (!cycle.correctedRequestFingerprint || cycle.correctedRequestFingerprint !== request.requestFingerprint) {
      throw new Error('browser_qa_correction_evidence_stale');
    }
    if (cycle.finalEvidenceFingerprint) {
      if (cycle.finalEvidenceFingerprint === evidence.evidenceFingerprint) return cycle.finalDecision;
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
      const currentDefectFingerprint = defectFingerprint(evidence);
      decision = currentDefectFingerprint === cycle.sourceDefectFingerprint
        ? { status: 'blocked', reason: 'identical_defects_after_correction', defectFingerprint: currentDefectFingerprint }
        : { status: 'blocked', reason: 'correction_iteration_limit', defectFingerprint: currentDefectFingerprint };
    }

    cycle.finalEvidenceFingerprint = evidence.evidenceFingerprint;
    cycle.finalDecision = freeze({
      ...decision,
      evidenceFingerprint: evidence.evidenceFingerprint,
      correctionFingerprint
    });
    return cycle.finalDecision;
  }
}
