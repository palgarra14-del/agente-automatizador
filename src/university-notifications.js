import { createHash } from 'node:crypto';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function currentSubjects(courses) {
  if (!Array.isArray(courses) || !courses.length) throw new Error('uv_notifications_courses_invalid');
  const map = new Map();
  const ambiguousCodes = new Set();
  for (const course of courses) {
    const code = clean(course?.code);
    if (!/^\d{5}$/.test(code)) continue;
    const academicYear = clean(course?.name).match(/^(\d{4}-\d{2})\b/)?.[1] ?? null;
    if (map.has(code) && map.get(code) !== academicYear) ambiguousCodes.add(code);
    map.set(code, academicYear);
  }
  // Conflicting course evidence cannot establish current-year membership.
  for (const code of ambiguousCodes) map.delete(code);
  return map;
}

function fold(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchingAssignment(title, assignments) {
  const label = clean(title).replace(/^(?:Vence|Venciment)\b[^:]*:\s*/i, '');
  const target = fold(label);
  if (!target) return null;
  const matches = assignments.filter((assignment) => {
    const candidate = fold(assignment?.title);
    if (!candidate || candidate.length < 5) return false;
    // Match complete folded words so Tema 1 cannot identify Tema 10.
    return (` ${candidate} `).includes(` ${target} `) || (` ${target} `).includes(` ${candidate} `);
  });
  return matches.length === 1 ? matches[0] : null;
}

function notificationId(title) {
  return 'uv-notification:' + createHash('sha256').update(clean(title)).digest('hex').slice(0, 24);
}

export function parseUvNotifications(page, courses, { today, assignments = [] } = {}) {
  if (!page || typeof page.text !== 'string') throw new Error('uv_notifications_page_invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))) throw new Error('uv_notifications_today_invalid');
  const referenceDay = new Date(today + 'T12:00:00Z');
  // Reject impossible days before using the reference date to suppress expired alerts.
  if (!Number.isFinite(referenceDay.getTime()) || referenceDay.toISOString().slice(0, 10) !== today) {
    throw new Error('uv_notifications_today_invalid');
  }
  if (!Array.isArray(assignments)) throw new Error('uv_notifications_assignments_invalid');
  const subjects = currentSubjects(courses);
  const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const start = lines.indexOf('Notificaciones');
  if (start < 0) return [];
  const body = lines.slice(start + 1);
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const title = clean(body[i]);
    if (!title || /^hace\b/i.test(title) || /^Seleccione\b/i.test(title)) continue;
    if (/^(Página Principal|Área personal|Mis cursos|Cursos archivados|Más)$/i.test(title)) continue;
    const codes = [...new Set([...title.matchAll(/\((\d{5})\)/g)].map((match) => match[1]))];
    // Multiple distinct course codes cannot establish one notification's subject.
    if (codes.length > 1) continue;
    const code = codes[0] ?? null;
    const years = [...new Set([...title.matchAll(/\b(20\d{2}-\d{2})\b/g)].map((match) => match[1]))];
    // Conflicting years cannot establish current-course membership.
    if (years.length > 1) continue;
    const year = years[0] ?? null;
    const deadlines = [...title.matchAll(/(\d{1,2})\s+(?:de\s+|d['’])([a-záéíóúàèòç]+)\s+de\s+(20\d{2})/gi)];
    const dueDates = deadlines.map((deadline) => {
      const months = {
        enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11,
        gener:0,febrer:1,'març':2,maig:4,juny:5,juliol:6,agost:7,setembre:8,novembre:10,desembre:11
      };
      const month = months[deadline[2].toLowerCase()];
      if (!Number.isInteger(month)) return null;
      const day = Number(deadline[1]);
      const parsed = new Date(Date.UTC(Number(deadline[3]), month, day, 12));
      // Date.UTC normalizes impossible days into a different month.
      if (parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return null;
      return parsed.toISOString().slice(0,10);
    });
    // Every explicit date must be valid and agree before determining expiry.
    if (dueDates.includes(null) || new Set(dueDates).size > 1) continue;
    const dueDate = dueDates[0] ?? null;
    const currentYear = code ? subjects.get(code) : null;
    const codedBelongs = Boolean(code && currentYear !== undefined && (!year || year === currentYear));
    const matchedAssignment = !code && /^(Vence|Venciment)\b/i.test(title)
      ? matchingAssignment(title, assignments)
      : null;
    const matchedSubjectId = clean(matchedAssignment?.subjectId);
    // A title match cannot override an explicit conflicting or unverified academic year.
    const belongs = codedBelongs || Boolean(matchedAssignment && subjects.has(matchedSubjectId) &&
      (!year || year === subjects.get(matchedSubjectId)));
    if (!belongs) continue;
    out.push({
      id: notificationId(title),
      title,
      subjectId: code ?? (clean(matchedAssignment?.subjectId) || null),
      dueDate,
      expired: Boolean(dueDate && dueDate < today)
    });
  }
  return out;
}

export function diffUvNotifications(previousState, current) {
  if (!Array.isArray(current)) throw new Error('uv_notifications_current_invalid');
  if (!previousState) return [];
  const seen = new Set((previousState.notifications ?? []).map((item) => item.id));
  // Expired evidence must suppress every copy, regardless of row order.
  const expiredIds = new Set(current.filter((item) => item.expired).map((item) => item.id));
  return current.filter((item) => {
    if (seen.has(item.id) || expiredIds.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function createUvNotificationState(notifications, capturedAt) {
  if (!Array.isArray(notifications) || Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('uv_notifications_state_invalid');
  }
  return { version: 1, capturedAt, notifications };
}
