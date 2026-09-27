import { createHash } from 'node:crypto';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function currentSubjects(courses) {
  if (!Array.isArray(courses) || !courses.length) throw new Error('uv_notifications_courses_invalid');
  const map = new Map();
  for (const course of courses) {
    const code = clean(course?.code);
    if (!/^\d{5}$/.test(code)) continue;
    const academicYear = clean(course?.name).match(/^(\d{4}-\d{2})\b/)?.[1] ?? null;
    map.set(code, academicYear);
  }
  return map;
}

function fold(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchingAssignment(title, assignments) {
  const label = clean(title).replace(/^(?:Vence|Venciment)\b[^:]*:\s*/i, '');
  const target = fold(label);
  if (!target) return null;
  return assignments.find((assignment) => {
    const candidate = fold(assignment?.title);
    if (!candidate || candidate.length < 5) return false;
    return candidate === target || candidate.includes(target) || target.includes(candidate);
  }) ?? null;
}

function notificationId(title) {
  return 'uv-notification:' + createHash('sha256').update(clean(title)).digest('hex').slice(0, 24);
}

export function parseUvNotifications(page, courses, { today, assignments = [] } = {}) {
  if (!page || typeof page.text !== 'string') throw new Error('uv_notifications_page_invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))) throw new Error('uv_notifications_today_invalid');
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
    const code = title.match(/\((\d{5})\)/)?.[1] ?? null;
    const year = title.match(/\b(20\d{2}-\d{2})\b/)?.[1] ?? null;
    const deadline = title.match(/(\d{1,2}) de ([a-záéíóú]+) de (20\d{2})/i);
    let dueDate = null;
    if (deadline) {
      const months = { enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11 };
      const month = months[deadline[2].toLowerCase()];
      if (Number.isInteger(month)) dueDate = new Date(Date.UTC(Number(deadline[3]), month, Number(deadline[1]), 12)).toISOString().slice(0,10);
    }
    const currentYear = code ? subjects.get(code) : null;
    const codedBelongs = Boolean(code && currentYear !== undefined && (!year || !currentYear || year === currentYear));
    const matchedAssignment = !code && /^(Vence|Venciment)\b/i.test(title)
      ? matchingAssignment(title, assignments)
      : null;
    const belongs = codedBelongs || Boolean(matchedAssignment);
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
  return current.filter((item) => !seen.has(item.id) && !item.expired);
}

export function createUvNotificationState(notifications, capturedAt) {
  if (!Array.isArray(notifications) || Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('uv_notifications_state_invalid');
  }
  return { version: 1, capturedAt, notifications };
}
