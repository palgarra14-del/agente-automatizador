import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUniversityDailyReport } from '../src/university-report.js';

test('daily university report is concise and actionable', () => {
  const output = formatUniversityDailyReport({
    version: 1,
    today: '2026-09-27',
    summary: {
      subjects: 9,
      openAssignments: 1,
      newMaterials: 2,
      suggestedMinutes: 80
    },
    tasks: [
      {
        subject: 'Curso A',
        title: 'Entrega próxima',
        dueAt: '2026-09-28T09:30:00.000Z',
        reason: 'Entrega en 1 día'
      },
      {
        subject: 'Curso B',
        title: 'Trabajar: Práctica 1',
        dueAt: null,
        reason: 'práctica o problemas',
        suggestedMinutes: 45
      }
    ]
  });
  assert.match(output, /9 asignaturas/);
  assert.match(output, /Entrega próxima/);
  assert.match(output, /45 min/);
  assert.match(output, /modo de solo lectura/);
});

test('daily report surfaces grade changes without exposing unrelated history', () => {
  const output = formatUniversityDailyReport({
    version: 1,
    today: '2026-09-27',
    summary: {
      subjects: 9,
      openAssignments: 0,
      newMaterials: 0,
      newRelevantMail: 0,
      mailStatus: 'ready',
      gradeStatus: 'ready',
      changedGrades: 1,
      suggestedMinutes: 0
    },
    gradeChanges: [
      { subject: 'EDA', previousGrade: '-', grade: '8,25' }
    ],
    academicSignals: [],
    mailAlerts: [],
    tasks: []
  });
  assert.match(output, /Calificaciones UV:.*1 cambios/);
  assert.match(output, /EDA.*- → 8,25/);
});
