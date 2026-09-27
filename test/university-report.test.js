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

test('daily report shows only confirmed practical subgroups', () => {
  const output = formatUniversityDailyReport({
    version: 1,
    today: '2026-09-27',
    summary: { subjects: 2, openAssignments: 0, newMaterials: 0, suggestedMinutes: 0 },
    academicProfile: [
      { subject: 'Análisis Matemático II', practicalGroups: ['B-P2'] },
      { subject: 'Estructuras Algebraicas', practicalGroups: [] }
    ],
    tasks: []
  });
  assert.match(output, /Subgrupos prácticos confirmados:.*Análisis Matemático II.*B-P2/);
  assert.doesNotMatch(output, /Estructuras Algebraicas.*P/);
});

test('daily report shows focused preparation resources below an assessment', () => {
  const output = formatUniversityDailyReport({
    version: 1,
    today: '2026-09-27',
    summary: { subjects: 9, openAssignments: 0, newMaterials: 0, suggestedMinutes: 50 },
    tasks: [{
      subject: 'EDA',
      title: 'Preparar: Test Tema 1',
      targetDate: '2026-10-02',
      suggestedMinutes: 50,
      reason: 'Evaluación próxima detectada en correo UV',
      resources: [
        { title: 'tema1', reason: 'mismo tema + teoría' },
        { title: 'Ejer1eda', reason: 'mismo tema + práctica' },
        { title: 'Ejer1eda resueltos', reason: 'mismo tema + comprobación' }
      ]
    }]
  });
  assert.match(output, /Test Tema 1/);
  assert.match(output, /tema1.*teoría/);
  assert.match(output, /Ejer1eda.*práctica/);
  assert.match(output, /Ejer1eda resueltos.*comprobación/);
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
