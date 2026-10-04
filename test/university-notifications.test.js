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

test('notification expiry rejects impossible reference days and accepts real calendar boundaries', () => {
  const page = { text: 'Notificaciones\nVence el 1 de octubre de 2026: Entrega (34156)' };
  for (const today of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-09-31', '2026-13-01', '2026-10-00']) {
    assert.throws(() => parseUvNotifications(page, courses, { today }),
      /uv_notifications_today_invalid/, today);
  }
  for (const [today, expired] of [
    ['2026-09-30', false],
    ['2026-10-01', false],
    ['2026-10-02', true],
    ['2028-02-29', true]
  ]) {
    const parsed = parseUvNotifications(page, courses, { today });
    assert.equal(parsed.length, 1, today);
    assert.equal(parsed[0].expired, expired, today);
  }
});

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

test('conflicting course years fail closed for coded and matched deadlines in either order', () => {
  const page = { text: [
    'Notificaciones',
    '2026-27 Análisis Matemático II (34156) contenido nuevo',
    '2025-26 Análisis Matemático II (34156) contenido nuevo',
    'Análisis Matemático II (34156) contenido nuevo',
    'Vence el 28 de septiembre de 2026: Ejercicios Tema 1',
    '2026-27 Estructuras de datos y algoritmos (34670) contenido nuevo'
  ].join('\n') };
  for (const name of ['2025-26 Análisis Matemático II', 'Análisis Matemático II']) {
    const conflicting = { code: '34156', name };
    for (const records of [[...courses, conflicting], [conflicting, ...courses]]) {
      const snapshot = structuredClone(records);
      const parsed = parseUvNotifications(page, records, {
        today: '2026-09-27',
        assignments: [{ subjectId: '34156', title: 'Ejercicios Tema 1' }]
      });
      assert.deepEqual(parsed.map((item) => item.subjectId), ['34670']);
      assert.deepEqual(records, snapshot);
    }
  }
  const parsed = parseUvNotifications(page, [...courses, { ...courses[0] }], {
    today: '2026-09-27',
    assignments: [{ subjectId: '34156', title: 'Ejercicios Tema 1' }]
  });
  assert.deepEqual(parsed.map((item) => item.subjectId), ['34156', '34156', '34156', '34670']);
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

test('coded notifications reject explicit academic years when the course year is unknown', () => {
  const titles = [
    '2025-26 Análisis Matemático II (34156) contenido nuevo',
    '2026-27 Análisis Matemático II (34156) contenido nuevo',
    'Análisis Matemático II (34156) contenido nuevo',
    '2026-27 Estructuras de datos y algoritmos (34670) contenido nuevo'
  ];
  for (const name of [undefined, null, '', 'Análisis Matemático II']) {
    const parsed = parseUvNotifications({ text: ['Notificaciones', ...titles].join('\n') }, [
      { code: '34156', name },
      courses[1]
    ], { today: '2026-09-27' });
    assert.deepEqual(parsed.map((item) => item.title), titles.slice(2));
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
  }
});

test('code-less deadlines reject explicit years that do not match their assigned course', () => {
  const titles = [
    'Vence el 28 de septiembre de 2026: Ejercicios Tema 1 2025-26',
    'Vence el 28 de septiembre de 2026: Ejercicios Tema 1 2026-27',
    'Vence el 28 de septiembre de 2026: Ejercicios Tema 1'
  ];
  for (const name of [courses[1].name, 'Estructuras de datos y algoritmos']) {
    const parsed = parseUvNotifications({ text: ['Notificaciones', ...titles].join('\n') },
      [{ ...courses[1], name }], {
        today: '2026-09-27',
        assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
      });
    assert.deepEqual(parsed.map((item) => item.title),
      name === courses[1].name ? titles.slice(1) : titles.slice(2));
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
  }
});

test('notifications with conflicting course codes fail closed regardless of code order', () => {
  const validTitle = '2026-27 Análisis Matemático II (34156) contenido nuevo';
  const repeatedTitle = '2026-27 Análisis Matemático II (34156) aviso para (34156)';
  for (const otherCode of ['34670', '34653']) {
    for (const codes of [['34156', otherCode], [otherCode, '34156']]) {
      const page = { text: [
        'Notificaciones',
        `Vence el 28 de septiembre de 2026: Ejercicios Tema 1 (${codes[0]}) (${codes[1]})`,
        validTitle,
        repeatedTitle
      ].join('\n') };
      const parsed = parseUvNotifications(page, courses, {
        today: '2026-09-27',
        assignments: [{ subjectId: '34156', title: 'Ejercicios Tema 1' }]
      });
      assert.deepEqual(parsed.map((item) => item.title), [validTitle, repeatedTitle]);
      assert.deepEqual(parsed.map((item) => item.subjectId), ['34156', '34156']);
      assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
    }
  }
});

test('notification titles with conflicting academic years fail closed in either order', () => {
  const validTitle = '2026-27 Análisis Matemático II (34156) contenido nuevo';
  const repeatedTitle = '2026-27 Análisis Matemático II (34156) aviso de 2026-27';
  for (const years of [['2026-27', '2025-26'], ['2025-26', '2026-27']]) {
    for (const coded of [false, true]) {
      const page = { text: [
        'Notificaciones',
        `Vence el 28 de septiembre de 2026: Ejercicios Tema 1 ${years.join(' / ')}${coded ? ' (34156)' : ''}`,
        validTitle,
        repeatedTitle
      ].join('\n') };
      const parsed = parseUvNotifications(page, courses, {
        today: '2026-09-27',
        assignments: [{ subjectId: '34156', title: 'Ejercicios Tema 1' }]
      });
      assert.deepEqual(parsed.map((item) => item.title), [validTitle, repeatedTitle]);
      assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
    }
  }
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

test('conflicting notification expiry suppresses the alert regardless of record order', () => {
  const active = { id: 'conflicting', title: 'Entrega', expired: false };
  const expired = { ...active, expired: true };
  const other = { id: 'other', title: 'Otra entrega', expired: false };
  for (const records of [[active, expired], [expired, active]]) {
    const current = [...records, other, { ...other }];
    const snapshot = structuredClone(current);
    assert.deepEqual(diffUvNotifications({ notifications: [] }, current), [other]);
    assert.deepEqual(current, snapshot);
  }
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

test('Valencian deadlines preserve expiry and reject invalid or conflicting dates', () => {
  const dates = [
    '23 de setembre de 2026',
    "23 d’octubre de 2026",
    "23 d'abril de 2026",
    '23 de març de 2026',
    '29 de febrer de 2026',
    "31 d'abril de 2026",
    "23 d'octubree de 2026",
    "23 d'octubre de 2026 (24 de octubre de 2026)"
  ];
  for (const coded of [false, true]) {
    const parsed = parseUvNotifications({ text: ['Notificaciones', ...dates.map((date) =>
      `Venciment ${date}: Ejercicios Tema 1${coded ? ' (34670)' : ''}`
    )].join('\n') }, courses, {
      today: '2026-10-01',
      assignments: [{ subjectId: '34670', title: 'Ejercicios Tema 1' }]
    });
    assert.deepEqual(parsed.map(({ dueDate, expired }) => ({ dueDate, expired })), [
      { dueDate: '2026-09-23', expired: true },
      { dueDate: '2026-10-23', expired: false },
      { dueDate: '2026-04-23', expired: true },
      { dueDate: '2026-03-23', expired: true }
    ]);
    assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), [parsed[1]]);
  }
});

test('conflicting notification dates fail closed regardless of order', () => {
  const validTitle = 'Vence el 28 de septiembre de 2026: Práctica de árboles';
  const repeatedTitle = 'Vence el 28 de septiembre de 2026: Práctica de árboles (28 de septiembre de 2026)';
  for (const otherDate of ['20 de septiembre de 2026', '29 de septiembre de 2026', '31 de septiembre de 2026']) {
    for (const dates of [[otherDate, '28 de septiembre de 2026'], ['28 de septiembre de 2026', otherDate]]) {
      for (const coded of [false, true]) {
        const page = { text: [
          'Notificaciones',
          `Vence el ${dates[0]}: Ejercicios Tema 1 (${dates[1]})${coded ? ' (34670)' : ''}`,
          validTitle,
          repeatedTitle
        ].join('\n') };
        const parsed = parseUvNotifications(page, courses, {
          today: '2026-09-27',
          assignments: [
            { subjectId: '34670', title: 'Ejercicios Tema 1' },
            { subjectId: '34156', title: 'Práctica de árboles' }
          ]
        });
        assert.deepEqual(parsed.map((item) => item.title), [validTitle, repeatedTitle]);
        assert.deepEqual(parsed.map((item) => item.dueDate), ['2026-09-28', '2026-09-28']);
        assert.deepEqual(diffUvNotifications({ notifications: [] }, parsed), parsed);
      }
    }
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
