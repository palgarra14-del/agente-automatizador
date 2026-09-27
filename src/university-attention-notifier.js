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
  const items = attention?.version === 1 && attention.required === true
    ? cleanItems(attention.items)
    : [];
  const notifiedItems = cleanItems(previousState?.notifiedItems);
  const seen = new Set(notifiedItems);
  const unseenItems = items.filter((item) => !seen.has(item));
  const fingerprint = attentionFingerprint(attention);
  return {
    notify: unseenItems.length > 0,
    fingerprint,
    unseenItems,
    state: {
      version: 2,
      notifiedItems,
      lastFingerprint: previousState?.lastFingerprint ?? null,
      lastNotifiedAt: previousState?.lastNotifiedAt ?? null
    }
  };
}

export function notifiedAcademicState(decision, notifiedAt) {
  if (!decision?.notify || Number.isNaN(Date.parse(notifiedAt))) {
    throw new Error('university_notification_state_invalid');
  }
  const notifiedItems = cleanItems([
    ...(decision.state?.notifiedItems ?? []),
    ...(decision.unseenItems ?? [])
  ]).slice(-1000);
  return {
    version: 2,
    notifiedItems,
    lastFingerprint: decision.fingerprint ?? null,
    lastNotifiedAt: new Date(notifiedAt).toISOString()
  };
}
