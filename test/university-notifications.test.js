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
  const parsed = parseUvNotifications(page, courses, {
    today: '2026-09-27',
    assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].expired, true);
  assert.equal(parsed[1].subjectId, '34156');
  assert.equal(parsed[1].expired, false);
});

test('notification parser ignores unmatched deadlines and old-year notifications even with a current subject code', () => {
  const page = { text: [
    'Notificaciones',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Trabajo de otro curso',
    'hace 1 hora',
    '2025-26 Anàlisi matemàtica II Gr.B-T (34156) contenido nuevo',
    'hace 1 hora'
  ].join('\n') };
  const parsed = parseUvNotifications(page, courses, {
    today: '2026-09-27',
    assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
  });
  assert.deepEqual(parsed, []);
});

test('a matching current assignment gives a code-less deadline its real subject', () => {
  const page = { text: [
    'Notificaciones',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Ejercicios Tema 1',
    'hace 1 hora'
  ].join('\n') };
  const parsed = parseUvNotifications(page, courses, {
    today: '2026-09-27',
    assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].subjectId, '34670');
  assert.equal(parsed[0].expired, false);
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

test('repeated notification rows surface each new non-expired alert only once', () => {
  const title = '2026-27 Anàlisi matemàtica II Gr.B-T (34156) contenido nuevo';
  const current = parseUvNotifications({ text: [
    'Notificaciones',
    title,
    title,
    '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670) contenido nuevo',
    'Vence el 20 de septiembre de 2026: Entrega (34156)',
    'Vence el 20 de septiembre de 2026: Entrega (34156)'
  ].join('\n') }, courses, { today: '2026-09-27' });
  const snapshot = structuredClone(current);
  assert.equal(current.length, 5);
  assert.deepEqual(diffUvNotifications(null, current), []);
  assert.deepEqual(diffUvNotifications({ notifications: [] }, current), [current[0], current[2]]);
  const previous = createUvNotificationState([current[0]], '2026-09-26T17:00:00Z');
  assert.deepEqual(diffUvNotifications(previous, current), [current[2]]);
  assert.deepEqual(current, snapshot);
});

test('code-less deadlines require a matching assignment from a current course', () => {
  const page = { text: [
    'Notificaciones',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Ejercicios Tema 1',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Práctica de árboles'
  ].join('\n') };
  for (const subjectId of [undefined, null, '', '   ', '34653', '34670']) {
    const parsed = parseUvNotifications(page, courses, {
      today: '2026-09-27',
      assignments: [
        { subjectId, title: 'Ejercicios Tema 1' },
        { subjectId: '34156', title: 'Práctica de árboles' }
      ]
    });
    assert.deepEqual(parsed.map((item) => item.subjectId),
      subjectId === '34670' ? ['34670', '34156'] : ['34156']);
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
  }
});

test('invalid explicit notification dates fail closed without suppressing valid deadlines', () => {
  const dates = [
    '31 de septiembre de 2026',
    '29 de febrero de 2026',
    '00 de octubre de 2026',
    '28 de octubree de 2026',
    '28 de septiembre de 2026',
    '29 de febrero de 2028'
  ];
  for (const coded of [false, true]) {
    const page = { text: ['Notificaciones', ...dates.map((date) =>
      `Vence el ${date}, 11:30: Ejercicios Tema 1${coded ? ' (34670)' : ''}`
    )].join('\n') };
    const parsed = parseUvNotifications(page, courses, {
      today: '2026-09-27',
      assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
    });
    assert.deepEqual(parsed.map((item) => item.dueDate), ['2026-09-28', '2028-02-29']);
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
  }
});

test('code-less deadlines fail closed when multiple assignments match regardless of order', () => {
  const page = { text: [
    'Notificaciones',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Ejercicios Tema 1',
    'Vence el lunes, 28 de septiembre de 2026, 11:30: Práctica de árboles'
  ].join('\n') };
  for (const secondTitle of ['Ejercicios Tema 1', 'Ejercicios Tema']) {
    const assignments = [
      { subjectId: '34670', title: 'Ejercicios Tema 1' },
      { subjectId: '34156', title: secondTitle },
      { subjectId: '34670', title: 'Práctica de árboles' }
    ];
    for (const ordered of [assignments, [...assignments].reverse()]) {
      const parsed = parseUvNotifications(page, courses, {
        today: '2026-09-27',
        assignments: ordered
      });
      assert.equal(parsed.length, 1);
      assert.match(parsed[0].title, /Práctica de árboles$/);
      assert.equal(parsed[0].subjectId, '34670');
    }
  }
});

test('code-less deadlines do not confuse numbered assignment title prefixes', () => {
  for (const [notificationTitle, assignmentTitle] of [
    ['Ejercicios Tema 10', 'Ejercicios Tema 1'],
    ['Ejercicios Tema 1', 'Ejercicios Tema 10']
  ]) {
    const page = { text: [
      'Notificaciones',
      `Vence el lunes, 28 de septiembre de 2026, 11:30: ${notificationTitle}`,
      'Vence el lunes, 28 de septiembre de 2026, 11:30: Práctica de árboles'
    ].join('\n') };
    const parsed = parseUvNotifications(page, courses, {
      today: '2026-09-27',
      assignments: [
        { subjectId: '34670', title: assignmentTitle },
        { subjectId: '34156', title: 'Práctica de árboles' }
      ]
    });
    assert.deepEqual(parsed.map((item) => item.subjectId), ['34156']);
    assert.match(parsed[0].title, /Práctica de árboles$/);
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
  }
});
