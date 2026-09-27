import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUvNotificationState,
  diffUvNotifications,
  parseUvNotifications
} from '../src/university-notifications.js';

const courses = [
  { code: '34156', name: '2026-27 Análisis Matemático II Gr.B-T (34156)' },
  { code: '34670', name: '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670)' }
];

test('notification parser keeps current-course items and marks expired deadlines', () => {
  const page = { text: [
    'Notificaciones',
    'Vence el miércoles, 23 de septiembre de 2026, 11:30: Ejercicios Tema 1',
    'hace 6 días 7 horas',
    '2026-27 Anàlisi matemàtica II Gr.B-T (34156) contenido nuevo',
    'hace 9 días 2 horas',
    '2025-26 Informática Gr.A-T (34653) contenido nuevo',
    'hace 10 días',
    'Seleccione desde la lista lateral de notificaciones para ver más detalles'
  ].join('\n') };
  const parsed = parseUvNotifications(page, courses, { today: '2026-09-27' });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].expired, true);
  assert.equal(parsed[1].subjectId, '34156');
  assert.equal(parsed[1].expired, false);
});

test('first scan is baseline only; later only new non-expired notifications surface', () => {
  const current = [
    { id: 'a', title: 'old', subjectId: '34156', dueDate: null, expired: false },
    { id: 'b', title: 'expired', subjectId: null, dueDate: '2026-09-20', expired: true }
  ];
  assert.deepEqual(diffUvNotifications(null, current), []);
  const state = createUvNotificationState(current, '2026-09-27T17:00:00Z');
  const next = [...current, { id: 'c', title: 'new', subjectId: '34670', dueDate: null, expired: false }];
  assert.deepEqual(diffUvNotifications(state, next).map((item) => item.id), ['c']);
});
