import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attentionFingerprint,
  decideAcademicNotification,
  notifiedAcademicState
} from '../src/university-attention-notifier.js';

test('no attention means no desktop notification', () => {
  const decision = decideAcademicNotification({
    version: 1,
    required: false,
    items: []
  });
  assert.equal(decision.notify, false);
  assert.equal(decision.fingerprint, null);
});

test('same academic event is notified only once', () => {
  const attention = {
    version: 1,
    required: true,
    items: ['uv-mail:10', 'grade:34670:8,25']
  };
  const first = decideAcademicNotification(attention);
  assert.equal(first.notify, true);
  const sent = notifiedAcademicState(first, '2026-09-27T18:00:00Z');
  const second = decideAcademicNotification(attention, sent);
  assert.equal(second.notify, false);
});

test('removing an already-notified event does not create a duplicate notification', () => {
  const firstAttention = {
    version: 1,
    required: true,
    items: ['due:test:2d', 'uv-mail:new']
  };
  const first = decideAcademicNotification(firstAttention);
  const sent = notifiedAcademicState(first, '2026-09-27T18:00:00Z');
  const reduced = decideAcademicNotification({
    version: 1,
    required: true,
    items: ['due:test:2d']
  }, sent);
  assert.equal(reduced.notify, false);
});

test('a changed relevant event set creates a fresh notification', () => {
  const before = {
    version: 1,
    required: true,
    items: ['uv-mail:10']
  };
  const first = decideAcademicNotification(before);
  const sent = notifiedAcademicState(first, '2026-09-27T18:00:00Z');
  const after = {
    version: 1,
    required: true,
    items: ['uv-mail:10', 'uv-notification:new']
  };
  const second = decideAcademicNotification(after, sent);
  assert.equal(second.notify, true);
  assert.notEqual(second.fingerprint, attentionFingerprint(before));
});
