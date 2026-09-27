import {
  buildAcademicProfile,
  mergeMailBody,
  selectRelevantAcademicMail
} from './university-relevance.js';

const SOGO_ORIGIN = 'https://sogo.uv.es';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function safeBody(value) {
  return clean(value).slice(0, 20_000);
}

export async function scanRelevantUniversityMail({
  bridge,
  courses,
  seenIds = [],
  maxMessages = 120,
  maxBodies = 20
} = {}) {
  if (!bridge || typeof bridge.listReadablePages !== 'function' ||
      typeof bridge.scanMail !== 'function' ||
      typeof bridge.readMailMessage !== 'function') {
    throw new Error('university_mail_bridge_invalid');
  }
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 200) {
    throw new Error('university_mail_max_messages_invalid');
  }
  if (!Number.isInteger(maxBodies) || maxBodies < 0 || maxBodies > 50) {
    throw new Error('university_mail_max_bodies_invalid');
  }

  const profile = buildAcademicProfile(courses);
  const pages = await bridge.listReadablePages();
  const mailPage = pages.find((page) => {
    try {
      return new URL(page.url).origin === SOGO_ORIGIN;
    } catch {
      return false;
    }
  });
  if (!mailPage) throw new Error('university_mail_page_missing');

  const inbox = await bridge.scanMail(mailPage.id, { maxMessages });
  if (!inbox?.ready || !Array.isArray(inbox.messages)) {
    throw new Error('university_mail_inbox_unavailable');
  }

  const headerAlerts = selectRelevantAcademicMail(inbox.messages, profile, { seenIds });
  const enriched = [];
  for (const alert of headerAlerts) {
    if (!alert.isNew || enriched.length >= maxBodies) {
      enriched.push(alert);
      continue;
    }
    const message = await bridge.readMailMessage(mailPage.id, alert.uid);
    if (!message?.found) continue;
    if (message.wasRead === false && message.isRead === true && message.readStateRestored !== true) {
      throw new Error('university_mail_read_state_not_restored');
    }
    enriched.push(mergeMailBody(alert, safeBody(message.body), profile));
  }

  const finalAlerts = enriched
    .filter((alert) => alert.decision !== 'ignore')
    .sort((a, b) => b.priority - a.priority || Number(b.unread) - Number(a.unread));

  return {
    version: 1,
    source: 'uv-sogo',
    profile,
    inbox: {
      total: Number(inbox.total) || inbox.messages.length,
      unread: Number(inbox.unread) || 0,
      scanned: inbox.messages.length
    },
    alerts: finalAlerts,
    seenIds: [...new Set([
      ...seenIds,
      ...inbox.messages
        .map((message) => clean(message.uid))
        .filter((uid) => /^\d+$/.test(uid))
        .map((uid) => 'uv-mail:' + uid)
    ])]
  };
}
