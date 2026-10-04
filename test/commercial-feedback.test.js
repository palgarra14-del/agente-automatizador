import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommercialFeedbackSnapshot,
  normalizeCommercialFeedbackSnapshots,
  scoreBucket
} from '../src/commercial-feedback.js';

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
  demo: true,
  proposal: false,
  won: false,
  lost: false,
  ...overrides
});

test('commercial feedback contract rejects PII and free text fields', () => {
  for (const field of ['phone', 'email', 'name', 'businessName', 'notes', 'observations', 'message']) {
    assert.throws(() => normalizeCommercialFeedbackSnapshot({ ...snapshot(), [field]: 'secret' }), /forbidden fields/);
  }
});

test('commercial feedback requires explicit outcomes and never infers stages', () => {
  const missing = snapshot();
  delete missing.contacted;
  assert.throws(() => normalizeCommercialFeedbackSnapshot(missing), /contacted must be an explicit boolean/);

  const wonWithoutIntermediateStages = normalizeCommercialFeedbackSnapshot(snapshot({
    contacted: false,
    interested: false,
    demo: false,
    proposal: false,
    won: true
  }));
  assert.equal(wonWithoutIntermediateStages.won, true);
  assert.equal(wonWithoutIntermediateStages.contacted, false);
  assert.equal(wonWithoutIntermediateStages.proposal, false);
});

test('commercial feedback validates mutually exclusive terminal outcomes and evidence taxonomy', () => {
  assert.throws(() => normalizeCommercialFeedbackSnapshot(snapshot({ won: true, lost: true })), /cannot both be true/);
  assert.throws(() => normalizeCommercialFeedbackSnapshot(snapshot({ evidenceBucket: 'great-looking-business' })), /not allowed/);
  assert.throws(() => normalizeCommercialFeedbackSnapshot(snapshot({ discovered: false })), /discovered must be true/);
});

test('score buckets are deterministic and bounded', () => {
  assert.equal(scoreBucket(null), 'unknown');
  assert.equal(scoreBucket(0), '0-49');
  assert.equal(scoreBucket(59), '50-59');
  assert.equal(scoreBucket(70), '70-79');
  assert.equal(scoreBucket(100), '90-100');
});

test('commercial feedback batches are bounded', () => {
  const rows = Array.from({ length: 10 }, () => snapshot());
  assert.equal(normalizeCommercialFeedbackSnapshots(rows, { maxItems: 3 }).length, 3);
});
