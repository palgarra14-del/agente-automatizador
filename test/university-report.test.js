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
