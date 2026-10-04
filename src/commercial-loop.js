import { normalizeCommercialFeedbackSnapshots, scoreBucket } from './commercial-feedback.js';

const DIMENSIONS = Object.freeze([
  'source',
  'niche',
  'city',
  'salesSegment',
  'websiteQuality',
  'evidenceBucket',
  'opportunityBucket',
  'leadScoreBucket',
  'salesFitBucket',
  'businessStrengthBucket',
  'contactabilityBucket'
]);

const rate = (numerator, denominator) => denominator > 0
  ? Math.round((numerator / denominator) * 1000) / 1000
  : null;

function aggregateRows(rows) {
  const counts = {
    discovered: rows.filter((row) => row.discovered).length,
    contacted: rows.filter((row) => row.contacted).length,
    interested: rows.filter((row) => row.interested).length,
    demo: rows.filter((row) => row.demo).length,
    proposal: rows.filter((row) => row.proposal).length,
    won: rows.filter((row) => row.won).length,
    lost: rows.filter((row) => row.lost).length
  };
  return {
    sampleSize: rows.length,
    counts,
    rates: {
      contactPerDiscovered: rate(counts.contacted, counts.discovered),
      interestPerContact: rate(counts.interested, counts.contacted),
      demoPerContact: rate(counts.demo, counts.contacted),
      proposalPerInterest: rate(counts.proposal, counts.interested),
      winPerProposal: rate(counts.won, counts.proposal),
      lossPerContact: rate(counts.lost, counts.contacted)
    }
  };
}

function enriched(snapshot) {
  return {
    ...snapshot,
    opportunityBucket: scoreBucket(snapshot.opportunityScore),
    leadScoreBucket: scoreBucket(snapshot.leadScore),
    salesFitBucket: scoreBucket(snapshot.salesFitScore),
    businessStrengthBucket: scoreBucket(snapshot.businessStrengthScore),
    contactabilityBucket: scoreBucket(snapshot.contactabilityScore)
  };
}

function groupBy(rows, dimension, minGroupSampleSize) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[dimension] ?? 'unknown';
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([value, members]) => {
      const aggregate = aggregateRows(members);
      return {
        value,
        ...aggregate,
        sufficientSample: aggregate.sampleSize >= minGroupSampleSize
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize || String(a.value).localeCompare(String(b.value), 'es'));
}

export function aggregateCommercialFeedback(values, {
  minSampleSize = 20,
  minGroupSampleSize = 8,
  maxItems = 5000
} = {}) {
  const snapshots = normalizeCommercialFeedbackSnapshots(values, { maxItems }).map(enriched);
  const overall = aggregateRows(snapshots);
  const groups = Object.fromEntries(DIMENSIONS.map((dimension) => [
    dimension,
    groupBy(snapshots, dimension, Math.max(1, Math.round(minGroupSampleSize)))
  ]));

  return Object.freeze({
    version: 1,
    privacy: Object.freeze({
      piiAllowed: false,
      freeTextAllowed: false,
      storesLeadIdentity: false
    }),
    sampleSize: snapshots.length,
    overall,
    groups,
    calibration: Object.freeze({
      minimumSampleSize: Math.max(1, Math.round(minSampleSize)),
      readyForReview: snapshots.length >= Math.max(1, Math.round(minSampleSize)),
      automaticWeightChanges: false
    })
  });
}
