import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAcademicReminders } from '../src/university-reminders.js';
import {
  alertToAcademicSignal,
  extractAcademicDates,
  mergeAcademicSignals,
  selectAttentionAcademicSignals
} from '../src/university-signals.js';

test('extracts named and numeric academic dates without confusing the academic year', () => {
  const dates = extractAcademicDates(
    'El próximo viernes 2 de Octubre. La clase del 1-10 pasa al 7-10 y la práctica del 16-12 pasa al 15-12. Curso 2026-27.',
    '2026-09-27T16:00:00Z'
  );
  assert.deepEqual(dates, ['2026-10-02', '2026-10-07', '2026-12-15']);
});

test('Valencian elided month dates produce timely assessment reminders', () => {
  for (const apostrophe of ["'", '’']) {
    const signal = alertToAcademicSignal({
      id: 'uv-mail:valencian-assessment',
      subject: 'Test Tema 1',
      body: `El test serà el 2 d${apostrophe}octubre de 2026.`,
      course: { subjectId: '34670', shortName: 'EDA' }
    }, { capturedAt: '2026-09-27T16:00:00Z' });
    assert.deepEqual(signal.dates, ['2026-10-02']);
    const reminders = buildAcademicReminders({ today: '2026-09-30', signals: [signal] });
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].date, '2026-10-02');
    assert.equal(reminders[0].daysRemaining, 2);
  }
});

test('Valencian elided dates preserve explicit years and reject impossible days', () => {
  assert.deepEqual(extractAcademicDates(
    "2 d'octubre de 2025; 3 d’abril de 2027; 31 d'abril de 2027; 32 d’agost de 2027.",
    '2026-09-27T16:00:00Z'
  ), ['2025-10-02', '2027-04-03']);
});

test('numeric academic dates preserve explicit years and reject invalid leap days', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  assert.deepEqual(extractAcademicDates(
    'Fechas: 2-10-2025, 2-10-2027, 29-2-2028, 29-2-2027.', capturedAt
  ), ['2025-10-02', '2027-10-02', '2028-02-29']);

  const state = mergeAcademicSignals(null, [{
    id: 'uv-mail:old-assessment',
    subject: 'Test Tema 1',
    body: 'El test fue el 2-10-2025.',
    course: { subjectId: '34670', shortName: 'EDA' }
  }], { capturedAt });
  assert.deepEqual(state.signals, []);
});

test('named dates reject unsupported explicit years without inventing assessment reminders', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  for (const value of ['2 de octubre de 25', '2 de octubre de 20250', "2 d’octubre de 1999"]) {
    const signal = alertToAcademicSignal({
      id: 'uv-mail:ambiguous-year',
      subject: 'Test Tema 1',
      body: value
    }, { capturedAt });
    assert.deepEqual(signal.dates, [], value);
    assert.deepEqual(buildAcademicReminders({ today: '2026-09-30', signals: [signal] }), [], value);
    assert.deepEqual(extractAcademicDates(
      value + '. El test será el 3 de octubre de 2026.', capturedAt
    ), ['2026-10-03'], value);
  }
});

test('named dates preserve years introduced by del without creating false reminders', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  for (const month of ['de octubre', 'd’octubre']) {
    for (const [year, expected] of [
      ['2025', ['2025-10-02']],
      ['2027', ['2027-10-02']],
      ['25', []],
      ['20250', []],
      ['1999', []]
    ]) {
      const body = `El test: 2 ${month} del ${year}.`;
      const signal = alertToAcademicSignal({
        id: 'uv-mail:explicit-year', subject: 'Test Tema 1', body
      }, { capturedAt });
      assert.deepEqual(signal.dates, expected, body);
      assert.deepEqual(buildAcademicReminders({ today: '2026-09-30', signals: [signal] }), [], body);
      assert.deepEqual(extractAcademicDates(
        body + ' El siguiente test: 3 de octubre de 2026.', capturedAt
      ), [...expected, '2026-10-03'].sort(), body);
    }
    const state = mergeAcademicSignals(null, [{
      id: 'uv-mail:past-year', subject: 'Test Tema 1', body: `2 ${month} del 2025.`
    }], { capturedAt });
    assert.deepEqual(state.signals, []);
  }
});

test('named dates preserve bare explicit years instead of inventing upcoming reminders', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  for (const month of ['de octubre', 'd’octubre']) {
    for (const [year, expected] of [
      ['2025', ['2025-10-02']],
      ['2027', ['2027-10-02']],
      ['25', []],
      ['20250', []],
      ['1999', []]
    ]) {
      const body = `El test: 2 ${month} ${year}.`;
      const signal = alertToAcademicSignal({
        id: 'uv-mail:bare-year', subject: 'Test Tema 1', body
      }, { capturedAt });
      assert.deepEqual(signal.dates, expected, body);
      assert.deepEqual(buildAcademicReminders({ today: '2026-09-30', signals: [signal] }), [], body);
      assert.deepEqual(extractAcademicDates(
        body + ' El siguiente test: 3 de octubre.', capturedAt
      ), [...expected, '2026-10-03'].sort(), body);
    }
  }
});

test('numeric academic dates reject partial matches inside unsupported date formats', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  for (const value of ['2026-10-02', '2-10-25', '2-10-20250', '2-10-2026-01']) {
    assert.deepEqual(extractAcademicDates('Test: ' + value, capturedAt), [], value);
    assert.deepEqual(extractAcademicDates(
      'Referencia: ' + value + '. El test será el 3-10-2026.', capturedAt
    ), ['2026-10-03'], value);
  }
});

test('rescheduled numeric dates preserve explicit years without creating phantom reminders', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  for (const [body, expected] of [
    ['La clase del 1-10 pasa al 7-10-2025.', ['2025-10-07']],
    ['La clase del 1-10-2026 pasa al 7-10-2026.', ['2026-10-07']],
    ['La clase del 1-10-2026 passa al 7-10.', ['2026-10-07']],
    ['La clase del 1-10 pasa al 7-10-25.', ['2026-10-01']],
    ['La clase del 1-10 pasa al 7-10-20250.', ['2026-10-01']],
    ['La clase del 1-10 pasa al 7-10-2026-01.', ['2026-10-01']]
  ]) {
    assert.deepEqual(extractAcademicDates(body, capturedAt), expected, body);
  }
  const signal = alertToAcademicSignal({
    id: 'uv-mail:past-reschedule',
    subject: 'Cambio de clase',
    body: 'La clase del 1-10 pasa al 7-10-2025.'
  }, { capturedAt });
  assert.deepEqual(buildAcademicReminders({ today: '2026-10-06', signals: [signal] }), []);
});

test('assessment email becomes a durable high-priority academic signal', () => {
  const signal = alertToAcademicSignal({
    id: 'uv-mail:772',
    relativeDate: 'Viernes 15:27',
    subject: '2026-27 EDA Gr.A-T (34670): Test Tema 1',
    body: 'El próximo viernes 2 de Octubre haremos un test. Puntuará como evaluación continua.',
    course: { subjectId: '34670', shortName: 'EDA' }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.equal(signal.kind, 'assessment');
  assert.equal(signal.importance, 100);
  assert.deepEqual(signal.dates, ['2026-10-02']);
  assert.equal(signal.activeUntil, '2026-10-03');
});
test('past Valencian Moodle deadline expires instead of lingering as current work', () => {
  const signal = alertToAcademicSignal({
    id: 'uv-mail:765',
    relativeDate: 'Miércoles 10:30',
    subject: '(2026-27 EDA Gr.A-T (34670)-Tasca) Venciment de Ejercicios Tema 1',
    body: 'Data límit dimecres, 23 de setembre de 2026 09:30 UTC',
    course: { subjectId: '34670', shortName: 'EDA' }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.deepEqual(signal.dates, ['2026-09-23']);
  assert.equal(signal.activeUntil, '2026-09-24');
});

test('general practice guidance is coursework, while mandatory seminar is elevated', () => {
  const practice = alertToAcademicSignal({
    id: 'uv-mail:760',
    relativeDate: 'Lunes 17:34',
    subject: '[2026-27 MNAL] Algunos comentarios generales sobre las prácticas',
    body: 'Habrá cuestionarios individuales al final de cada práctica y un examen final.',
    course: { subjectId: '34161', shortName: 'MNAL' }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.equal(practice.kind, 'coursework');
  const seminar = alertToAcademicSignal({
    id: 'uv-mail:769',
    relativeDate: 'Miércoles 16:48',
    subject: '[2026-27 ANII] Información importante Seminarios ANII',
    body: 'La semana que viene comienzan los seminarios y la asistencia es obligatoria.',
    course: { subjectId: '34156', shortName: 'Análisis II' }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.equal(seminar.kind, 'required_session');
});

test('mixed mail drops practical-group dates unless that subgroup is known to belong to the student', () => {
  const unknown = alertToAcademicSignal({
    id: 'uv-mail:771',
    relativeDate: 'Jueves 18:00',
    subject: '[2026-27 Estructuras Algebraicas Gr.B-T (34168)] cambios de horas y semanas 3 y 4',
    body: 'La clase de teoría del 1-10 pasa al 7-10. La practica del grupo P2 del 16-12 pasa al 15-12.',
    course: { subjectId: '34168', shortName: 'Estructuras Algebraicas', theoryGroup: 'B-T', practicalGroups: [] }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.deepEqual(unknown.dates, ['2026-10-07']);

  const own = alertToAcademicSignal({
    id: 'uv-mail:771',
    relativeDate: 'Jueves 18:00',
    subject: '[2026-27 Estructuras Algebraicas Gr.B-T (34168)] cambios de horas y semanas 3 y 4',
    body: 'La clase de teoría del 1-10 pasa al 7-10. La practica del grupo P2 del 16-12 pasa al 15-12.',
    course: { subjectId: '34168', shortName: 'Estructuras Algebraicas', theoryGroup: 'B-T', practicalGroups: ['B-P2'] }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.deepEqual(own.dates, ['2026-10-07', '2026-12-15']);
});

test('mixed practical-group sentences fail closed regardless of group order', () => {
  for (const body of [
    'El grupo B-P2 entrega el 1-10 y el grupo B-P3 entrega el 2-10.',
    'El grupo B-P3 entrega el 2-10 y el grupo B-P2 entrega el 1-10.',
    'El grupo P2 entrega el 1-10 y el subgrupo P3 entrega el 2-10.'
  ]) {
    const signal = alertToAcademicSignal({
      id: 'uv-mail:mixed-groups',
      subject: 'Entregas de prácticas',
      body: body + ' El grupo B-P2 entrega el 3-10.',
      course: { theoryGroup: 'B-T', practicalGroups: ['B-P2'] }
    }, { capturedAt: '2026-09-27T16:00:00Z' });
    assert.deepEqual(signal.dates, ['2026-10-03'], body);
    assert.deepEqual(buildAcademicReminders({ today: '2026-10-01', signals: [signal] }), [], body);
    assert.equal(buildAcademicReminders({ today: '2026-10-02', signals: [signal] }).length, 1, body);
  }
  const own = alertToAcademicSignal({
    id: 'uv-mail:own-groups',
    subject: 'Entregas de prácticas',
    body: 'El grupo B-P2 entrega el 1-10 y el subgrupo P2 entrega el 2-10.',
    course: { theoryGroup: 'B-T', practicalGroups: ['B-P2'] }
  }, { capturedAt: '2026-09-27T16:00:00Z' });
  assert.deepEqual(own.dates, ['2026-10-01', '2026-10-02']);
});

test('Valencian practical-group notices only remind for confirmed own groups', () => {
  for (const label of ['grup', 'subgrup']) {
    for (const practicalGroups of [[], ['B-P2']]) {
      const signal = alertToAcademicSignal({
        id: 'uv-mail:valencian-groups',
        subject: 'Lliuraments de pràctiques',
        body: `El ${label} B-P3 entrega el 2 d’octubre. El ${label} P2 entrega el 3 d’octubre.`,
        course: { theoryGroup: 'B-T', practicalGroups }
      }, { capturedAt: '2026-09-27T16:00:00Z' });
      assert.deepEqual(signal.dates, practicalGroups.length ? ['2026-10-03'] : []);
      assert.deepEqual(buildAcademicReminders({ today: '2026-10-01', signals: [signal] }), []);
      assert.equal(buildAcademicReminders({ today: '2026-10-02', signals: [signal] }).length,
        practicalGroups.length ? 1 : 0);
    }
  }
});

test('plural practical-group labels preserve only confirmed own-group reminders', () => {
  for (const label of ['grupos', 'subgrupos', 'grups', 'subgrups']) {
    for (const practicalGroups of [[], ['B-P2']]) {
      const signal = alertToAcademicSignal({
        id: 'uv-mail:plural-groups',
        subject: 'Entregas de prácticas',
        body: `Los ${label} B-P3 entregan el 2-10. Los ${label} P2 entregan el 3-10.`,
        course: { theoryGroup: 'B-T', practicalGroups }
      }, { capturedAt: '2026-09-27T16:00:00Z' });
      assert.deepEqual(signal.dates, practicalGroups.length ? ['2026-10-03'] : [], label);
      assert.deepEqual(buildAcademicReminders({ today: '2026-10-01', signals: [signal] }), [], label);
      assert.equal(buildAcademicReminders({ today: '2026-10-02', signals: [signal] }).length,
        practicalGroups.length ? 1 : 0, label);
    }
  }
});

test('merge keeps future obligations while expiring stale undated mail', () => {
  const state = mergeAcademicSignals({
    version: 4,
    signals: [
      {
        id: 'old',
        title: 'Old',
        importance: 60,
        dates: [],
        activeUntil: '2026-09-20'
      },
      {
        id: 'future',
        title: 'Future',
        importance: 90,
        dates: ['2026-10-01'],
        activeUntil: '2026-10-02'
      }
    ]
  }, [], { capturedAt: '2026-09-27T16:00:00Z' });
  assert.deepEqual(state.signals.map((item) => item.id), ['future']);
});

test('refreshed expired evidence removes a cached obligation while retaining other future work', () => {
  const capturedAt = '2026-09-27T16:00:00Z';
  const alert = {
    id: 'uv-mail:refreshed',
    subject: 'Test Tema 1',
    body: 'El test será el 2-10-2026.',
    course: { subjectId: '34670', shortName: 'EDA' }
  };
  const previous = mergeAcademicSignals(null, [
    alert,
    { ...alert, id: 'uv-mail:other' }
  ], { capturedAt });
  assert.equal(previous.signals.length, 2);

  const state = mergeAcademicSignals(previous, [{
    ...alert,
    body: 'El test fue el 23-9-2026.'
  }], { capturedAt });

  assert.deepEqual(state.signals, previous.signals.filter((signal) => signal.id === 'uv-mail:other'));
  assert.deepEqual(selectAttentionAcademicSignals(state, { capturedAt }).map((signal) => signal.id), [
    'uv-mail:other'
  ]);
});

test('attention view hides distant obligations until they approach', () => {
  const state = {
    version: 4,
    signals: [
      {
        id: 'soon',
        title: 'Soon',
        importance: 100,
        dates: ['2026-10-02'],
        activeUntil: '2026-10-03'
      },
      {
        id: 'later',
        title: 'Later',
        importance: 90,
        dates: ['2026-12-15'],
        activeUntil: '2026-12-16'
      }
    ]
  };
  const attention = selectAttentionAcademicSignals(state, {
    capturedAt: '2026-09-27T16:00:00Z',
    horizonDays: 14
  });
  assert.deepEqual(attention.map((item) => item.id), ['soon']);
});
