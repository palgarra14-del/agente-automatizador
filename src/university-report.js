function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function taskLine(task, index) {
  const subject = clean(task.subject) || clean(task.subjectId) || 'Universidad';
  const title = clean(task.title) || 'Tarea';
  const reason = clean(task.reason);
  const minutes = Number.isInteger(task.suggestedMinutes) && task.suggestedMinutes > 0
    ? ' · ' + task.suggestedMinutes + ' min'
    : '';
  const deadline = task.dueAt
    ? ' · vence ' + new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(task.dueAt))
    : '';
  const target = !task.dueAt && /^\d{4}-\d{2}-\d{2}$/.test(String(task.targetDate ?? ''))
    ? ' · fecha ' + task.targetDate
    : '';
  const why = reason ? ' — ' + reason : '';
  const main = index + 1 + '. **' + subject + '** — ' + title + minutes + deadline + target + why;
  const resources = Array.isArray(task.resources)
    ? task.resources.slice(0, 4).map((item) => '   - ' + clean(item.title) + ' · ' + clean(item.reason)).join('\n')
    : '';
  return resources ? main + '\n' + resources : main;
}

function signalLine(signal, today) {
  const subject = clean(signal?.subject) || 'Universidad';
  const title = clean(signal?.title) || 'Aviso académico';
  const futureDates = Array.isArray(signal?.dates)
    ? signal.dates.filter((date) => date >= today)
    : [];
  const dates = futureDates.length
    ? ' · ' + futureDates.join(', ')
    : '';
  const labels = {
    assessment: 'evaluación',
    required_session: 'asistencia obligatoria',
    schedule_change: 'cambio de horario/clase',
    coursework: 'trabajo de clase',
    academic_notice: 'aviso académico'
  };
  const kind = labels[signal?.kind] ?? clean(signal?.kind).replace(/_/g, ' ');
  const label = kind ? ' · ' + kind : '';
  return '- **' + subject + '** — ' + title + dates + label;
}

function mailLine(alert) {
  const subject = clean(alert?.course?.shortName) || 'Universidad';
  const title = clean(alert?.subject) || 'Aviso académico';
  const status = alert?.decision === 'needs_context'
    ? ' · subgrupo por confirmar'
    : (alert?.decision === 'notify' ? ' · importante' : '');
  const freshness = alert?.isNew ? ' · nuevo' : '';
  const body = clean(alert?.body);
  const detail = body ? '\n  - ' + body.slice(0, 260) + (body.length > 260 ? '…' : '') : '';
  return '- **' + subject + '** — ' + title + status + freshness + detail;
}

export function formatUniversityDailyReport(report) {
  if (!report || report.version !== 1 || !Array.isArray(report.tasks) || !report.summary) {
    throw new Error('university_report_invalid');
  }
  const lines = [
    '# Universidad · ' + clean(report.today),
    '',
    '**Estado:** ' +
      report.summary.subjects + ' asignaturas · ' +
      report.summary.openAssignments + ' entregas pendientes · ' +
      report.summary.newMaterials + ' materiales nuevos'
  ];

  const confirmedGroups = Array.isArray(report.academicProfile)
    ? report.academicProfile.flatMap((course) =>
        Array.isArray(course.practicalGroups) && course.practicalGroups.length === 1
          ? [clean(course.subject) + ' · ' + course.practicalGroups[0]]
          : []
      )
    : [];
  if (confirmedGroups.length) {
    lines.push('**Subgrupos prácticos confirmados:** ' + confirmedGroups.join(' · '));
  }

  if (report.summary.mailStatus) {
    const newRelevant = Number.isInteger(report.summary.newRelevantMail) ? report.summary.newRelevantMail : 0;
    lines.push('**Correo UV:** ' + report.summary.mailStatus + ' · ' + newRelevant + ' correos nuevos relevantes');
  }
  if (report.summary.gradeStatus) {
    const changedGrades = Number.isInteger(report.summary.changedGrades) ? report.summary.changedGrades : 0;
    lines.push('**Calificaciones UV:** ' + report.summary.gradeStatus + ' · ' + changedGrades + ' cambios');
  }
  if (report.summary.notificationStatus) {
    const newNotifications = Number.isInteger(report.summary.newRelevantNotifications)
      ? report.summary.newRelevantNotifications
      : 0;
    lines.push('**Notificaciones UV:** ' + report.summary.notificationStatus + ' · ' + newNotifications + ' nuevas relevantes');
  }
  if (Number.isInteger(report.summary.upcomingReminders) && report.summary.upcomingReminders > 0) {
    lines.push('**Recordatorios próximos:** ' + report.summary.upcomingReminders);
  }
  if (Number.isInteger(report.summary.suggestedMinutes) && report.summary.suggestedMinutes > 0) {
    lines.push('**Carga sugerida:** ' + report.summary.suggestedMinutes + ' min');
  }

  if (Array.isArray(report.gradeChanges) && report.gradeChanges.length) {
    lines.push('', '## Cambios de calificación', '');
    report.gradeChanges.forEach((item) => {
      const before = item.previousGrade ?? 'sin calificación';
      const after = item.grade ?? 'sin calificación';
      lines.push('- **' + clean(item.subject) + '** — ' + before + ' → ' + after);
    });
  }

  if (Array.isArray(report.notificationChanges) && report.notificationChanges.length) {
    lines.push('', '## Notificaciones nuevas relevantes', '');
    report.notificationChanges.forEach((item) => lines.push('- ' + clean(item.title)));
  }

  if (Array.isArray(report.reminders) && report.reminders.length) {
    lines.push('', '## Requiere atención pronto', '');
    report.reminders.forEach((item) => {
      const when = item.daysRemaining === 1 ? 'mañana' : 'en ' + item.daysRemaining + ' días';
      lines.push('- **' + clean(item.subject) + '** — ' + clean(item.title) + ' · ' + when);
    });
  }

  if (Array.isArray(report.academicSignals) && report.academicSignals.length) {
    lines.push('', '## Lo que sigue vigente', '');
    report.academicSignals.forEach((signal) => lines.push(signalLine(signal, report.today)));
  }

  if (Array.isArray(report.mailAlerts) && report.mailAlerts.length) {
    lines.push('', '## Correos nuevos que sí te afectan', '');
    report.mailAlerts.forEach((alert) => lines.push(mailLine(alert)));
  }

  lines.push('', '## Qué conviene hacer hoy', '');

  if (!report.tasks.length) {
    lines.push('No hay trabajo académico priorizado por el agente para hoy.');
  } else {
    report.tasks.forEach((task, index) => lines.push(taskLine(task, index)));
  }

  lines.push(
    '',
    '_Plan generado en modo de solo lectura desde Aula Virtual y correo UV. El agente preserva el estado leído/no leído y no envía mensajes ni realiza entregas._',
    ''
  );
  return lines.join('\n');
}
