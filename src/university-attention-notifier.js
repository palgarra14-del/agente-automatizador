import { createHash } from 'node:crypto';

function cleanItems(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))].sort();
}

export function attentionFingerprint(attention) {
  if (!attention || attention.version !== 1 || attention.required !== true) return null;
  const items = cleanItems(attention.items);
  if (!items.length) return null;
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export function decideAcademicNotification(attention, previousState = null) {
  const fingerprint = attentionFingerprint(attention);
  const previous = typeof previousState?.lastFingerprint === 'string'
    ? previousState.lastFingerprint
    : null;
  return {
    notify: Boolean(fingerprint && fingerprint !== previous),
    fingerprint,
    state: {
      version: 1,
      lastFingerprint: fingerprint ?? previous,
      lastNotifiedAt: previousState?.lastNotifiedAt ?? null
    }
  };
}

export function notifiedAcademicState(decision, notifiedAt) {
  if (!decision?.notify || typeof decision.fingerprint !== 'string' || Number.isNaN(Date.parse(notifiedAt))) {
    throw new Error('university_notification_state_invalid');
  }
  return {
    version: 1,
    lastFingerprint: decision.fingerprint,
    lastNotifiedAt: notifiedAt
  };
}
