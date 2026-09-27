import { createHash } from 'node:crypto';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function courseRecord(course) {
  const name = clean(course?.name);
  const explicitCode = clean(course?.code);
  const code = /^\d{5}$/.test(explicitCode)
    ? explicitCode
    : (name.match(/\((\d{5})\)\s*$/)?.[1] ?? '');
  if (!code || !name) throw new Error('academic_profile_course_invalid');
  const groupMatch = name.match(/\bGr\.?\s*([A-Z])\s*-\s*T\b/i);
  const theoryGroup = groupMatch ? groupMatch[1].toUpperCase() + '-T' : null;
  const academicYear = name.match(/^(\d{4}-\d{2})\b/)?.[1] ?? null;
  const practicalGroups = Array.isArray(course?.practicalGroups)
    ? [...new Set(course.practicalGroups
      .map((group) => clean(group).toUpperCase())
      .filter((group) => /^[A-Z]-P\d+$/.test(group)))].sort()
    : [];
  const shortName = name
    .replace(/^\d{4}-\d{2}\s+/, '')
    .replace(/\s+Gr\.?\s*[A-Z]\s*-\s*T\s*\(\d{5}\)\s*$/i, '')
    .replace(/\s*\(\d{5}\)\s*$/, '')
    .trim();
  return { subjectId: code, name, shortName, theoryGroup, practicalGroups, academicYear };
}

export function buildAcademicProfile(courses) {
  if (!Array.isArray(courses) || !courses.length || courses.length > 40) {
    throw new Error('academic_profile_courses_invalid');
  }
  const normalized = courses.map(courseRecord);
  const ids = new Set();
  for (const course of normalized) {
    if (ids.has(course.subjectId)) throw new Error('academic_profile_course_duplicate');
    ids.add(course.subjectId);
  }
  return Object.freeze({ version: 1, courses: normalized });
}

function messageId(message) {
  const providerId = clean(message?.uid ?? message?.providerId);
  if (/^\d+$/.test(providerId)) return 'uv-mail:' + providerId;
  const raw = [
    clean(message?.fromEmail ?? message?.providerFrom ?? message?.fromName ?? message?.sender),
    clean(message?.subject),
    clean(message?.relativeDate ?? message?.date)
  ].join('\n');
  return 'uv-mail:sha256:' + createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function groupSignals(text) {
  const theory = [...text.matchAll(/\bGr\.?\s*([A-Z])\s*-\s*T\b/gi)]
    .map((match) => match[1].toUpperCase() + '-T');
  const practical = [...text.matchAll(/\b(?:subgrupo|subgrup)\s+([A-Z])\s*-\s*P(\d+)\b/gi)]
    .map((match) => match[1].toUpperCase() + '-P' + match[2]);
  return { theory: [...new Set(theory)], practical: [...new Set(practical)] };
}

const HIGH_IMPACT = /\b(ex[aá]menes?|tests?|parciales?|evaluaci[oó]n|avaluaci[oó]|entregas?|lliuraments?|pr[aá]cticas?|cambios?|canvis?|horas?|hores?|horaris?|aulas?|setmanes?|semanas?|fechas?|dates?|cancel\w*|suspensi[oó]\w*|aplaz\w*|correcci[oó]\w*|informaci[oó]n importante)\b/i;
const GLOBAL_CRITICAL = /\b(matr[ií]cula|expediente|beca|convocatoria|secretar[ií]a|tasas?|pagos?|cierre de actas|tancament d'actes|suspensi[oó]n de clases|suspensi[oó] de classes)\b/i;
const BROADCAST = /^\[PREGON\s+tit(?:0000|1936)\]/i;
function courseForText(text, profile) {
  for (const course of profile.courses) {
    if (new RegExp('\\(' + course.subjectId + '\\)').test(text)) return course;
  }
  return null;
}

function wrongTheoryGroup(signals, course) {
  return Boolean(
    course?.theoryGroup &&
    signals.theory.length &&
    !signals.theory.includes(course.theoryGroup)
  );
}

function practicalGroupStatus(signals, course) {
  if (!signals.practical.length || !course) return 'none';
  const base = course?.theoryGroup?.[0];
  if (base && !signals.practical.some((group) => group.startsWith(base + '-P'))) return 'wrong';
  if (Array.isArray(course.practicalGroups) && course.practicalGroups.length) {
    return signals.practical.some((group) => course.practicalGroups.includes(group))
      ? 'match'
      : 'wrong';
  }
  return 'unresolved';
}

export function classifyAcademicMail(message, profile, { body = '' } = {}) {
  if (!profile || profile.version !== 1 || !Array.isArray(profile.courses)) {
    throw new Error('academic_profile_invalid');
  }
  const subject = clean(message?.subject);
  if (!subject) throw new Error('academic_mail_subject_invalid');
  const combined = [subject, clean(body)].filter(Boolean).join(' ');
  const course = courseForText(combined, profile);
  const groups = groupSignals(combined);
  const id = messageId(message);
  const subjectYears = [...subject.matchAll(/\b(20\d{2}-\d{2})\b/g)].map((match) => match[1]);
  // Body references must not change the academic year of a dated subject.
  const statedYears = subjectYears.length
    ? subjectYears
    : [...combined.matchAll(/\b(20\d{2}-\d{2})\b/g)].map((match) => match[1]);
  const currentYears = new Set(profile.courses.map((item) => item.academicYear).filter(Boolean));
  if (statedYears.length && !statedYears.some((year) => currentYears.has(year))) {
    return { id, decision: 'ignore', priority: 0, course, reason: 'curso_academico_anterior' };
  }
  if (course?.academicYear && statedYears.length && !statedYears.includes(course.academicYear)) {
    return { id, decision: 'ignore', priority: 0, course, reason: 'curso_academico_anterior' };
  }
  if (course && wrongTheoryGroup(groups, course)) {
    return { id, decision: 'ignore', priority: 0, course, reason: 'otro_grupo_teoria' };
  }
  const practical = practicalGroupStatus(groups, course);
  if (course && practical === 'wrong') {
    return { id, decision: 'ignore', priority: 0, course, reason: 'otro_grupo_practicas' };
  }
  if (course && practical === 'unresolved') {
    return {
      id, decision: 'needs_context', priority: 650, course,
      reason: 'subgrupo_practicas_por_confirmar', needsBody: !body
    };
  }
  if (course) {
    const high = HIGH_IMPACT.test(combined);
    return {
      id,
      decision: high ? 'notify' : 'digest',
      priority: high ? 900 : 620,
      course,
      reason: high ? 'aviso_accionable_asignatura' : 'aviso_asignatura',
      needsBody: !body
    };
  }

  if (GLOBAL_CRITICAL.test(combined)) {
    return {
      id, decision: 'notify', priority: 820, course: null,
      reason: 'aviso_administrativo_critico', needsBody: !body
    };
  }
  if (BROADCAST.test(subject)) {
    return { id, decision: 'ignore', priority: 0, course: null, reason: 'difusion_general' };
  }
  return { id, decision: 'ignore', priority: 0, course: null, reason: 'sin_vinculo_academico_personal' };
}

export function selectRelevantAcademicMail(messages, profile, { seenIds = [] } = {}) {
  if (!Array.isArray(messages) || messages.length > 500) throw new Error('academic_mail_list_invalid');
  const seen = new Set(Array.isArray(seenIds) ? seenIds : []);
  return messages
    .map((message) => ({ message, classification: classifyAcademicMail(message, profile) }))
    .filter(({ classification }) => classification.decision !== 'ignore')
    .map(({ message, classification }) => ({
      id: classification.id,
      uid: clean(message.uid ?? message.providerId),
      fromName: clean(message.fromName ?? message.sender),
      fromEmail: clean(message.fromEmail ?? message.providerFrom),
      subject: clean(message.subject),
      relativeDate: clean(message.relativeDate ?? message.date),
      unread: message.isRead === false || message.unread === true,
      isNew: !seen.has(classification.id),
      decision: classification.decision,
      priority: classification.priority,
      reason: classification.reason,
      course: classification.course,
      needsBody: classification.needsBody === true
    }))
    .sort((a, b) => b.priority - a.priority || Number(b.unread) - Number(a.unread) || a.subject.localeCompare(b.subject, 'es'));
}
export function mergeMailBody(alert, body, profile) {
  if (!alert || typeof alert !== 'object') throw new Error('academic_mail_alert_invalid');
  const classification = classifyAcademicMail({
    uid: alert.uid,
    fromName: alert.fromName,
    fromEmail: alert.fromEmail,
    subject: alert.subject,
    relativeDate: alert.relativeDate
  }, profile, { body });
  return {
    ...alert,
    decision: classification.decision,
    priority: classification.priority,
    reason: classification.reason,
    course: classification.course,
    body: clean(body).slice(0, 20_000),
    needsBody: false
  };
}

export function summarizeAcademicProfile(profile) {
  if (!profile || profile.version !== 1) throw new Error('academic_profile_invalid');
  return profile.courses.map((course) => ({
    subjectId: course.subjectId,
    subject: course.shortName,
    theoryGroup: course.theoryGroup,
    practicalGroups: [...(course.practicalGroups ?? [])]
  }));
}
