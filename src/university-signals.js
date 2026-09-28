export const ACADEMIC_SIGNAL_STATE_VERSION = 4;

const MONTHS = Object.freeze({
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
  gener: 0, febrer: 1, 'març': 2, maig: 4, juny: 5,
  juliol: 6, agost: 7, setembre: 8, novembre: 10, desembre: 11
});
const SHORT_MONTHS = Object.freeze({
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
});

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function dayIso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const date = new Date(iso + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return dayIso(date);
}

function receivedDay(relativeDate, capturedAt) {
  const text = clean(relativeDate);
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (match && Number.isInteger(SHORT_MONTHS[match[2].toLowerCase()])) {
    return dayIso(new Date(Date.UTC(
      2000 + Number(match[3]),
      SHORT_MONTHS[match[2].toLowerCase()],
      Number(match[1]),
      12
    )));
  }
  const weekdays = {
    domingo: 0, diumenge: 0, lunes: 1, dilluns: 1, martes: 2, dimarts: 2,
    miercoles: 3, miércoles: 3, dimecres: 3, jueves: 4, dijous: 4,
    viernes: 5, divendres: 5, sabado: 6, sábado: 6, dissabte: 6
  };
  const weekday = text.toLowerCase().split(/\s+/)[0];
  if (Number.isInteger(weekdays[weekday])) {
    const date = new Date(capturedAt);
    const delta = (date.getUTCDay() - weekdays[weekday] + 7) % 7;
    date.setUTCDate(date.getUTCDate() - delta);
    return dayIso(date);
  }
  return dayIso(new Date(capturedAt));
}
function inferredDate(day, month, year, capturedAt) {
  const base = new Date(capturedAt);
  let candidateYear = year ?? base.getUTCFullYear();
  let candidate = new Date(Date.UTC(candidateYear, month, day, 12));
  if (!year && candidate.getTime() < base.getTime() - 60 * 86_400_000) {
    candidateYear += 1;
    candidate = new Date(Date.UTC(candidateYear, month, day, 12));
  }
  if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;
  return dayIso(candidate);
}

export function extractAcademicDates(value, capturedAt) {
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error('academic_signal_captured_at_invalid');
  const text = clean(value).toLowerCase();
  const dates = new Set();
  const monthPattern = Object.keys(MONTHS).join('|');
  const named = new RegExp(
    "\\b(\\d{1,2})\\s+(?:de\\s+|d['’])(" + monthPattern + ')(?:\\s+de\\s+(20\\d{2}))?',
    'gi'
  );
  for (const match of text.matchAll(named)) {
    const date = inferredDate(
      Number(match[1]),
      MONTHS[match[2].toLowerCase()],
      match[3] ? Number(match[3]) : null,
      capturedAt
    );
    if (date) dates.add(date);
  }
  const superseded = new Set();
  for (const match of text.matchAll(/\b(?:del?|de)\s+(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\s+(?:pasa|passa)\s+al?\s+(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\b(?![\d-])/g)) {
    const from = inferredDate(Number(match[1]), Number(match[2]) - 1, match[3] ? Number(match[3]) : null, capturedAt);
    const to = inferredDate(Number(match[4]), Number(match[5]) - 1, match[6] ? Number(match[6]) : null, capturedAt);
    if (from) superseded.add(from);
    if (to) dates.add(to);
  }
  // Do not reinterpret fragments of ISO dates or unsupported year formats.
  for (const match of text.matchAll(/(?<![\d-])\b(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\b(?![\d-])/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    if (month < 0 || month > 11) continue;
    const date = inferredDate(day, month, match[3] ? Number(match[3]) : null, capturedAt);
    if (date && !superseded.has(date)) dates.add(date);
  }
  return [...dates].sort();
}
function signalKind(headline, text) {
  if (/\b(test|examen|parcial|cuestionario|control|evaluaci[oó]n continua|avaluaci[oó])\b/i.test(headline)) {
    return { kind: 'assessment', importance: 100 };
  }
  if (/asistencia\s+(?:es\s+)?obligatoria|assist[eè]ncia\s+(?:[eé]s\s+)?obligat[oò]ria/i.test(text)) {
    return { kind: 'required_session', importance: 95 };
  }
  const scheduleHeadline = /\b(cambios?|canvis?|suspensi[oó]n|aula|horario|horari|clases? online)\b/i.test(headline);
  const scheduleBody = /pasa al|passa al|cambio de|canvi de|en sustituci[oó]n|no habr[aá] clase/i.test(text);
  if (scheduleHeadline || scheduleBody) {
    return { kind: 'schedule_change', importance: 90 };
  }
  if (/\b(pr[aá]cticas?|seminarios?|seminaris?|entregas?|lliuraments?|problemas?)\b/i.test(headline)) {
    return { kind: 'coursework', importance: 75 };
  }
  return { kind: 'academic_notice', importance: 60 };
}

function scopeRelevantBody(body, course) {
  const text = clean(body);
  if (!text) return '';
  const practicalGroups = Array.isArray(course?.practicalGroups) ? course.practicalGroups : [];
  const theoryPrefix = clean(course?.theoryGroup).match(/^([A-Z])-T$/)?.[1] ?? null;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const explicit = sentence.match(/\b(?:subgrupo|grupo)\s+([A-Z])?-?P(\d+)\b/i);
      if (!explicit) return true;
      const prefix = explicit[1]?.toUpperCase() ?? theoryPrefix;
      if (!prefix) return false;
      return practicalGroups.includes(prefix + '-P' + explicit[2]);
    })
    .join(' ');
}

export function alertToAcademicSignal(alert, { capturedAt } = {}) {
  if (!alert || typeof alert !== 'object' || !clean(alert.id)) {
    throw new Error('academic_signal_alert_invalid');
  }
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error('academic_signal_captured_at_invalid');
  const headline = clean(alert.subject);
  const scopedBody = scopeRelevantBody(alert.body, alert.course);
  const text = [headline, scopedBody].filter(Boolean).join(' ');
  const dates = extractAcademicDates(text, capturedAt);
  const today = dayIso(new Date(capturedAt));
  const futureDates = dates.filter((date) => date >= today);
  const received = receivedDay(alert.relativeDate, capturedAt);
  const activeUntil = futureDates.length
    ? addDays(futureDates.at(-1), 1)
    : (dates.length ? addDays(dates.at(-1), 1) : addDays(received, 7));
  const type = signalKind(headline, text);
  return {
    id: clean(alert.id),
    source: 'uv-mail',
    subjectId: clean(alert.course?.subjectId) || null,
    subject: clean(alert.course?.shortName) || 'Universidad',
    title: clean(alert.subject),
    body: clean(alert.body).slice(0, 4_000),
    kind: type.kind,
    importance: type.importance,
    dates,
    receivedAt: received,
    activeUntil
  };
}
export function mergeAcademicSignals(previousState, alerts, { capturedAt } = {}) {
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error('academic_signal_captured_at_invalid');
  if (!Array.isArray(alerts)) throw new Error('academic_signal_alerts_invalid');
  const currentDay = dayIso(new Date(capturedAt));
  const map = new Map();
  const previousSignals = previousState?.version === ACADEMIC_SIGNAL_STATE_VERSION
    ? previousState.signals ?? []
    : [];
  for (const signal of previousSignals) {
    if (!signal?.id || !signal?.activeUntil || signal.activeUntil < currentDay) continue;
    map.set(signal.id, signal);
  }
  for (const alert of alerts) {
    const signal = alertToAcademicSignal(alert, { capturedAt });
    if (signal.activeUntil >= currentDay) map.set(signal.id, signal);
    else map.delete(signal.id);
  }
  const signals = [...map.values()].sort((a, b) =>
    b.importance - a.importance ||
    (a.dates[0] ?? a.activeUntil).localeCompare(b.dates[0] ?? b.activeUntil) ||
    a.title.localeCompare(b.title, 'es')
  );
  return { version: ACADEMIC_SIGNAL_STATE_VERSION, capturedAt, signals };
}

export function selectAttentionAcademicSignals(state, { capturedAt, horizonDays = 14 } = {}) {
  if (!state || state.version !== ACADEMIC_SIGNAL_STATE_VERSION || !Array.isArray(state.signals)) {
    throw new Error('academic_signal_state_invalid');
  }
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error('academic_signal_horizon_invalid');
  }
  const today = dayIso(new Date(capturedAt));
  const horizon = addDays(today, horizonDays);
  return state.signals.filter((signal) => {
    const future = (signal.dates ?? []).filter((date) => date >= today);
    if (future.length) return future[0] <= horizon;
    return signal.activeUntil >= today;
  });
}
