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

test('bounded notification history retains new events regardless of alphabetical order', () => {
  const previousState = {
    version: 2,
    notifiedItems: Array.from({ length: 1000 }, (_, index) => 'old:' + String(index).padStart(4, '0'))
  };
  const attention = { version: 1, required: true, items: ['aaa:new'] };
  const sent = notifiedAcademicState(
    decideAcademicNotification(attention, previousState),
    '2026-09-27T18:00:00Z'
  );
  assert.equal(sent.notifiedItems.length, 1000);
  assert.equal(sent.notifiedItems.includes('old:0000'), false);
  assert.equal(decideAcademicNotification(attention, sent).notify, false);

  const next = notifiedAcademicState(
    decideAcademicNotification({ ...attention, items: ['zzz:new'] }, sent),
    '2026-09-27T19:00:00Z'
  );
  assert.equal(next.notifiedItems.length, 1000);
  assert.equal(next.notifiedItems.includes('old:0001'), false);
  assert.equal(decideAcademicNotification(attention, next).notify, false);
});

test('attention fingerprints remain independent of event order', () => {
  const attention = { version: 1, required: true, items: ['event:b', 'event:a'] };
  assert.equal(
    attentionFingerprint(attention),
    attentionFingerprint({ ...attention, items: ['event:a', 'event:b', 'event:a'] })
  );
});
