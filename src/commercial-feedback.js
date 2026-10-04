const ALLOWED_KEYS = new Set([
  'version',
  'source',
  'niche',
  'city',
  'salesSegment',
  'websiteQuality',
  'evidenceBucket',
  'opportunityScore',
  'leadScore',
  'salesFitScore',
  'businessStrengthScore',
  'contactabilityScore',
  'discovered',
  'contacted',
  'interested',
  'demo',
  'proposal',
  'won',
  'lost'
]);

const STAGE_KEYS = Object.freeze(['discovered', 'contacted', 'interested', 'demo', 'proposal', 'won', 'lost']);

export const COMMERCIAL_EVIDENCE_BUCKETS = Object.freeze([
  'no_owned_website',
  'marketplace_owned_gap',
  'weak_mobile',
  'weak_conversion',
  'outdated_live_site',
  'strong_business_web_gap',
  'other_verified_gap',
  'unknown'
]);

function boundedDimension(value, field, max = 120) {
  if (value == null || value === '') return 'unknown';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return 'unknown';
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function boundedScore(value, field) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) throw new Error(`${field} must be between 0 and 100`);
  return Math.round(numeric);
}

function explicitBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`${field} must be an explicit boolean`);
  return value;
}

export function scoreBucket(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'unknown';
  const score = Math.max(0, Math.min(100, Math.round(Number(value))));
  if (score < 50) return '0-49';
  if (score < 60) return '50-59';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  if (score < 90) return '80-89';
  return '90-100';
}

export function normalizeCommercialFeedbackSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('commercial feedback snapshot must be an object');
  const keys = Object.keys(value);
  const forbidden = keys.filter((key) => !ALLOWED_KEYS.has(key));
  if (forbidden.length) throw new Error(`commercial feedback contains forbidden fields: ${forbidden.join(', ')}`);

  const version = value.version ?? 1;
  if (version !== 1) throw new Error('commercial feedback version must be 1');

  const stages = Object.fromEntries(STAGE_KEYS.map((key) => [key, explicitBoolean(value[key], key)]));
  if (!stages.discovered) throw new Error('discovered must be true for LeadFinder feedback snapshots');
  if (stages.won && stages.lost) throw new Error('won and lost cannot both be true');

  const evidenceBucket = boundedDimension(value.evidenceBucket, 'evidenceBucket', 64);
  if (!COMMERCIAL_EVIDENCE_BUCKETS.includes(evidenceBucket)) throw new Error('evidenceBucket is not allowed');

  return Object.freeze({
    version: 1,
    source: boundedDimension(value.source, 'source', 64),
    niche: boundedDimension(value.niche, 'niche', 80),
    city: boundedDimension(value.city, 'city', 100),
    salesSegment: boundedDimension(value.salesSegment, 'salesSegment', 80),
    websiteQuality: boundedDimension(value.websiteQuality, 'websiteQuality', 64),
    evidenceBucket,
    opportunityScore: boundedScore(value.opportunityScore, 'opportunityScore'),
    leadScore: boundedScore(value.leadScore, 'leadScore'),
    salesFitScore: boundedScore(value.salesFitScore, 'salesFitScore'),
    businessStrengthScore: boundedScore(value.businessStrengthScore, 'businessStrengthScore'),
    contactabilityScore: boundedScore(value.contactabilityScore, 'contactabilityScore'),
    ...stages
  });
}

export function normalizeCommercialFeedbackSnapshots(values, { maxItems = 5000 } = {}) {
  if (!Array.isArray(values)) throw new Error('commercial feedback snapshots must be an array');
  const limit = Math.max(0, Math.min(5000, Math.round(Number(maxItems) || 0)));
  return values.slice(0, limit).map(normalizeCommercialFeedbackSnapshot);
}
