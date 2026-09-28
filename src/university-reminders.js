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

  for (const signal of signals) {
    const dates = Array.isArray(signal?.dates) ? signal.dates : [];
    for (const date of dates) {
      const remaining = daysUntil(today, date);
      let stage = null;
      if (signal.kind === 'assessment' && remaining >= 1 && remaining <= 2) stage = 'assessment-soon';
      else if (['coursework', 'schedule_change'].includes(signal.kind) && remaining === 1) stage = 'tomorrow';
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

  for (const assignment of assignments) {
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

  return reminders.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    String(a.subjectId ?? '').localeCompare(String(b.subjectId ?? '')) ||
    a.id.localeCompare(b.id)
  );
}
