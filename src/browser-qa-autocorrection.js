import { browserQaFingerprint, normalizeBrowserQaPreviewUrl, validateBrowserQaEvidence } from './browser-qa.js';

const maxDefects = 16;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const clone = value => JSON.parse(JSON.stringify(value));

function sourceBinding(sourceWorkflow) {
  if (!sourceWorkflow || sourceWorkflow.profile !== 'website-build') throw new Error('browser_qa_autocorrection_source_not_website');
  const requirements = sourceWorkflow.steps?.find(step => step.id === 'requirements');
  const implementation = sourceWorkflow.steps?.find(step => step.id === 'implementation');
  const review = sourceWorkflow.steps?.find(step => step.id === 'review');
  const publication = sourceWorkflow.steps?.find(step => step.id === 'publication');
  const preview = publication?.evidence?.preview;
  const commit = publication?.evidence?.commit;
  const blueprintFingerprint = requirements?.evidence?.websiteBlueprintFingerprint;
  const reviewedChangeSetFingerprint = implementation?.evidence?.changeSetFingerprint;
  const reviewFingerprint = review?.evidence?.reviewedChangeSetFingerprint;
  const verdict = review?.evidence?.result?.reviewEvidence?.verdict;
  const publishedCommitSha = commit?.finalHead;
  if (!fingerprintPattern.test(blueprintFingerprint ?? '') || !fingerprintPattern.test(reviewedChangeSetFingerprint ?? '')) throw new Error('browser_qa_autocorrection_source_binding_missing');
  if (review?.status !== 'completed' || verdict !== 'PASS' || reviewFingerprint !== reviewedChangeSetFingerprint) throw new Error('browser_qa_autocorrection_source_review_invalid');
  if (publication?.status !== 'completed' || preview?.state !== 'READY' || preview?.ok !== true || preview?.environment !== 'preview') throw new Error('browser_qa_autocorrection_source_preview_invalid');
  if (!commitPattern.test(publishedCommitSha ?? '') || preview.commitSha !== publishedCommitSha || typeof preview.url !== 'string') throw new Error('browser_qa_autocorrection_source_publication_invalid');
  return {
    workflowId: sourceWorkflow.id,
    projectId: sourceWorkflow.projectId,
    scope: clone(sourceWorkflow.scope ?? { allowedPaths: [], forbiddenPaths: [] }),
    blueprintFingerprint,
    reviewedChangeSetFingerprint,
    publishedCommitSha,
    previewUrl: normalizeBrowserQaPreviewUrl(preview.url)
  };
}

function boundedDefects(evidence) {
  if (!Array.isArray(evidence.deterministicDefects) || evidence.deterministicDefects.length < 1 || evidence.deterministicDefects.length > maxDefects) throw new Error('browser_qa_autocorrection_defects_unbounded');
  return evidence.deterministicDefects.map(item => {
    if (!item || typeof item.kind !== 'string' || typeof item.route !== 'string' || typeof item.subject !== 'string') throw new Error('browser_qa_autocorrection_defect_invalid');
    if (item.kind.length > 80 || item.route.length > 160 || item.subject.length > 240 || /[\0\r\n]/.test(item.kind + item.route + item.subject)) throw new Error('browser_qa_autocorrection_defect_unbounded');
    return { kind: item.kind, route: item.route, subject: item.subject };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function bindingMismatch(binding, request) {
  return request.workflowId !== binding.workflowId ||
    request.websiteBlueprintFingerprint !== binding.blueprintFingerprint ||
    request.reviewedChangeSetFingerprint !== binding.reviewedChangeSetFingerprint ||
    request.publishedCommitSha !== binding.publishedCommitSha ||
    normalizeBrowserQaPreviewUrl(request.previewUrl) !== binding.previewUrl;
}

export function planBrowserQaAutocorrection({ sourceWorkflow, request, evidence, existingRecord = null, sourceIsCorrection = false } = {}) {
  if (sourceIsCorrection) return { status: 'blocked', reason: 'second_iteration_forbidden' };
  const binding = sourceBinding(sourceWorkflow);
  validateBrowserQaEvidence(request, evidence);
  if (bindingMismatch(binding, request)) return { status: 'blocked', reason: 'stale_source_binding' };
  if (existingRecord?.evidenceFingerprint === evidence.evidenceFingerprint) return { status: 'duplicate', reason: 'duplicate_evidence', correctionWorkflowId: existingRecord.correctionWorkflowId };
  if (existingRecord) return { status: 'blocked', reason: 'second_iteration_forbidden', correctionWorkflowId: existingRecord.correctionWorkflowId };
  if (evidence.status === 'pass') return { status: 'blocked', reason: 'browser_qa_passed' };
  if (evidence.status !== 'defects') return { status: 'blocked', reason: 'deterministic_defects_required' };
  const defects = boundedDefects(evidence);
  const defectFingerprint = browserQaFingerprint(defects);
  const compact = defects.map(item => `${item.kind}@${item.route}:${item.subject}`).join('; ');
  const goal = [
    'Correct only the deterministic Browser QA defects listed below. Do not broaden scope or change unrelated behavior.',
    `Defects: ${compact}.`,
    `Source binding: commit=${binding.publishedCommitSha}; blueprint=${binding.blueprintFingerprint}; reviewed=${binding.reviewedChangeSetFingerprint}; preview=${binding.previewUrl}.`,
    'Treat this evidence as machine-classified. Do not infer additional defects from subjective observations. Preserve the normal review, tests, CI and preview gates.'
  ].join(' ');
  if (goal.length > 3_500) throw new Error('browser_qa_autocorrection_goal_unbounded');
  return {
    status: 'create',
    defectFingerprint,
    evidenceFingerprint: evidence.evidenceFingerprint,
    requestFingerprint: request.requestFingerprint,
    binding,
    workflowInput: {
      profile: 'app-improvement',
      projectId: binding.projectId,
      goal,
      scope: clone(binding.scope),
      budgets: clone(sourceWorkflow.budgets ?? {})
    }
  };
}
