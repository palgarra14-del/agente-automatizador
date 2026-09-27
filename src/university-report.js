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
  const why = reason ? ' — ' + reason : '';
  return index + 1 + '. **' + subject + '** — ' + title + minutes + deadline + why;
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

  if (Number.isInteger(report.summary.suggestedMinutes) && report.summary.suggestedMinutes > 0) {
    lines.push('**Carga sugerida:** ' + report.summary.suggestedMinutes + ' min');
  }

  lines.push('', '## Qué conviene hacer hoy', '');

  if (!report.tasks.length) {
    lines.push('No hay trabajo académico priorizado por el agente para hoy.');
  } else {
    report.tasks.forEach((task, index) => lines.push(taskLine(task, index)));
  }

  lines.push(
    '',
    '_Plan generado desde Aula Virtual en modo de solo lectura. Las entregas y demás acciones siguen requiriendo intervención humana._',
    ''
  );
  return lines.join('\n');
}
