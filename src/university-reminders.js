function dayNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) {
    throw new Error('academic_reminder_day_invalid');
  }
  const parsed = Date.parse(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error('academic_reminder_day_invalid');
  }
  return Math.floor(parsed / 86_400_000);
}

function daysUntil(today, target) {
  return dayNumber(target) - dayNumber(today);
}

function madridDay(value) {
  // Assignment state uses explicit UTC timestamps; reject parser normalization.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return map.year + '-' + map.month + '-' + map.day;
}

export function buildAcademicReminders({
  signals = [],
  assignments = [],
  today
} = {}) {
  dayNumber(today);
  if (!Array.isArray(signals) || !Array.isArray(assignments)) {
    throw new Error('academic_reminder_inputs_invalid');
  }
  const reminders = [];

  // A source cannot safely identify an obligation with conflicting subjects, dates, kinds or titles.
  const ambiguousSignalIds = new Set();
  const signalSubjectsById = new Map();
  const signalDatesById = new Map();
  const signalKindsById = new Map();
  const signalTitlesById = new Map();
  for (const signal of signals) {
    if (typeof signal?.id !== 'string' || !signal.id.trim()) continue;
    const title = typeof signal.title === 'string' ? signal.title.replace(/\s+/g, ' ').trim() : null;
    if (signalTitlesById.has(signal.id) && signalTitlesById.get(signal.id) !== title) {
      ambiguousSignalIds.add(signal.id);
    }
    signalTitlesById.set(signal.id, title);
    if (signalKindsById.has(signal.id) && signalKindsById.get(signal.id) !== signal.kind) {
      ambiguousSignalIds.add(signal.id);
    }
    signalKindsById.set(signal.id, signal.kind);
    const subjectId = signal.subjectId ?? null;
    if (signalSubjectsById.has(signal.id) && signalSubjectsById.get(signal.id) !== subjectId) {
      ambiguousSignalIds.add(signal.id);
    }
    signalSubjectsById.set(signal.id, subjectId);
    const dates = Array.isArray(signal.dates) ? signal.dates : [];
    const dateKey = JSON.stringify([...new Set(dates)].sort());
    if (signalDatesById.has(signal.id) && signalDatesById.get(signal.id) !== dateKey) {
      ambiguousSignalIds.add(signal.id);
    }
    signalDatesById.set(signal.id, dateKey);
  }
  for (const signal of signals) {
    if (typeof signal?.id !== 'string' || !signal.id.trim()) continue;
    if (ambiguousSignalIds.has(signal.id)) continue;
    const dates = Array.isArray(signal?.dates) ? signal.dates : [];
    for (const date of new Set(dates)) {
      const remaining = daysUntil(today, date);
      let stage = null;
      if (signal.kind === 'assessment' && remaining >= 1 && remaining <= 2) stage = 'assessment-soon';
      else if (['coursework', 'schedule_change', 'required_session'].includes(signal.kind) && remaining === 1) stage = 'tomorrow';
      if (!stage) continue;
      reminders.push({
        id: 'reminder:signal:' + signal.id + ':' + date + ':' + stage,
        source: 'signal',
        subjectId: signal.subjectId ?? null,
        subject: signal.subject ?? 'Universidad',
        title: signal.title ?? 'Aviso académico',
        date,
        daysRemaining: remaining,
        kind: signal.kind
      });
    }
  }

  // Conflicting status, deadline, subject or title evidence makes the obligation ambiguous.
  const ambiguousAssignmentIds = new Set(assignments
    .filter((assignment) => assignment?.status !== 'open')
    .map((assignment) => assignment?.id));
  const deadlinesById = new Map();
  const subjectsById = new Map();
  const titlesById = new Map();
  for (const assignment of assignments) {
    if (typeof assignment?.id !== 'string' || !assignment.id.trim()) continue;
    const title = typeof assignment.title === 'string' ? assignment.title.replace(/\s+/g, ' ').trim() : null;
    if (titlesById.has(assignment.id) && titlesById.get(assignment.id) !== title) {
      ambiguousAssignmentIds.add(assignment.id);
    }
    titlesById.set(assignment.id, title);
    const deadline = madridDay(assignment.dueAt) ? Date.parse(assignment.dueAt) : null;
    if (deadlinesById.has(assignment.id) && deadlinesById.get(assignment.id) !== deadline) {
      ambiguousAssignmentIds.add(assignment.id);
    }
    deadlinesById.set(assignment.id, deadline);
    const subjectId = assignment.subjectId ?? null;
    if (subjectsById.has(assignment.id) && subjectsById.get(assignment.id) !== subjectId) {
      ambiguousAssignmentIds.add(assignment.id);
    }
    subjectsById.set(assignment.id, subjectId);
  }
  for (const assignment of assignments) {
    if (typeof assignment?.id !== 'string' || !assignment.id.trim()) continue;
    if (ambiguousAssignmentIds.has(assignment.id)) continue;
    if (assignment?.status !== 'open' || !assignment?.dueAt) continue;
    const date = madridDay(assignment.dueAt);
    if (!date || daysUntil(today, date) !== 1) continue;
    reminders.push({
      id: 'reminder:assignment:' + assignment.id + ':' + date + ':tomorrow',
      source: 'assignment',
      subjectId: assignment.subjectId ?? null,
      subject: assignment.subject ?? assignment.subjectId ?? 'Universidad',
      title: assignment.title ?? 'Entrega',
      date,
      daysRemaining: 1,
      kind: 'assignment'
    });
  }

  const seen = new Set();
  return reminders.filter((reminder) => {
    if (seen.has(reminder.id)) return false;
    seen.add(reminder.id);
    return true;
  }).sort((a, b) =>
    a.date.localeCompare(b.date) ||
    String(a.subjectId ?? '').localeCompare(String(b.subjectId ?? '')) ||
    a.id.localeCompare(b.id)
  );
}
