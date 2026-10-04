import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCommercialFeedback } from '../src/commercial-loop.js';

const snapshot = (overrides = {}) => ({
  version: 1,
  source: 'overture',
  niche: 'Peluquerías',
  city: 'Valencia',
  salesSegment: 'marketplace_owned_gap',
  websiteQuality: 'no_website',
  evidenceBucket: 'marketplace_owned_gap',
  opportunityScore: 80,
  leadScore: 78,
  salesFitScore: 79,
  businessStrengthScore: 60,
  contactabilityScore: 68,
  discovered: true,
  contacted: true,
  interested: false,
  demo: false,
  proposal: false,
  won: false,
  lost: false,
  ...overrides
});

test('commercial loop aggregates explicit funnel stages without PII', () => {
  const result = aggregateCommercialFeedback([
    snapshot({ demo: true, interested: true, proposal: true, won: true }),
    snapshot({ city: 'Madrid', salesSegment: 'strong_business_web_gap', evidenceBucket: 'strong_business_web_gap', contacted: true, interested: true, demo: true, lost: true }),
    snapshot({ city: 'Madrid', contacted: false })
  ], { minSampleSize: 5, minGroupSampleSize: 2 });

  assert.equal(result.sampleSize, 3);
  assert.deepEqual(result.overall.counts, {
    discovered: 3,
    contacted: 2,
    interested: 2,
    demo: 2,
    proposal: 1,
    won: 1,
    lost: 1
  });
  assert.equal(result.overall.rates.contactPerDiscovered, 0.667);
  assert.equal(result.overall.rates.winPerProposal, 1);
  assert.equal(result.calibration.readyForReview, false);
  assert.equal(result.calibration.automaticWeightChanges, false);
  assert.deepEqual(result.privacy, { piiAllowed: false, freeTextAllowed: false, storesLeadIdentity: false });

  const madrid = result.groups.city.find((group) => group.value === 'Madrid');
  assert.equal(madrid.sampleSize, 2);
  assert.equal(madrid.sufficientSample, true);
  assert.equal(result.groups.salesFitBucket[0].value, '70-79');

  const serialized = JSON.stringify(result);
  for (const forbidden of ['phone', 'email', 'businessName', 'notes', 'observations']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false);
  }
});

test('commercial loop never promotes later outcomes into missing intermediate stages', () => {
  const result = aggregateCommercialFeedback([
    snapshot({ contacted: false, proposal: false, won: true })
  ]);
  assert.equal(result.overall.counts.contacted, 0);
  assert.equal(result.overall.counts.proposal, 0);
  assert.equal(result.overall.counts.won, 1);
  assert.equal(result.overall.rates.winPerProposal, null);
});

test('commercial loop exposes review readiness only after enough observations', () => {
  const rows = Array.from({ length: 20 }, (_, index) => snapshot({
    city: index % 2 ? 'Madrid' : 'Valencia',
    contacted: index % 3 !== 0
  }));
  const result = aggregateCommercialFeedback(rows, { minSampleSize: 20 });
  assert.equal(result.calibration.readyForReview, true);
  assert.equal(result.calibration.automaticWeightChanges, false);
});
