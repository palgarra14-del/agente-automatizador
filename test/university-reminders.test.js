import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAcademicReminders } from '../src/university-reminders.js';

test('reminders skip ambiguous source identities without suppressing valid events', () => {
  const invalidIds = [undefined, null, '', '   ', 42, true, {}, []];
  const signal = { kind: 'assessment', dates: ['2026-10-02'] };
  const assignment = { status: 'open', dueAt: '2026-10-02T09:30:00Z' };
  const reminders = buildAcademicReminders({
    today: '2026-10-01',
    signals: [...invalidIds.map((id) => ({ ...signal, id })), { ...signal, id: 'valid-signal' }],
    assignments: [...invalidIds.map((id) => ({ ...assignment, id })), { ...assignment, id: 'valid-assignment' }]
  });
  assert.deepEqual(reminders.map((item) => item.id), [
    'reminder:assignment:valid-assignment:2026-10-02:tomorrow',
    'reminder:signal:valid-signal:2026-10-02:assessment-soon'
  ]);
});

test('reminders reject impossible calendar days instead of normalizing them', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01']) {
    assert.throws(
      () => buildAcademicReminders({ today: date }),
      /academic_reminder_day_invalid/
    );
    assert.throws(
      () => buildAcademicReminders({
        today: '2026-02-28',
        signals: [{ id: 'invalid-date', kind: 'assessment', dates: [date] }]
      }),
      /academic_reminder_day_invalid/
    );
  }
});

test('assessment reminders preserve valid leap-day and month-boundary timing', () => {
  const reminders = buildAcademicReminders({
    today: '2028-02-28',
    signals: [{
      id: 'leap-year',
      kind: 'assessment',
      dates: ['2028-02-29', '2028-03-01']
    }]
  });
  assert.deepEqual(
    reminders.map(({ date, daysRemaining }) => ({ date, daysRemaining })),
    [{ date: '2028-02-29', daysRemaining: 1 }, { date: '2028-03-01', daysRemaining: 2 }]
  );
});

test('assessment reminder becomes active once inside the 48 hour window', () => {
  const reminders = buildAcademicReminders({
    today: '2026-09-30',
    signals: [{
      id: 'uv-mail:772',
      subjectId: '34670',
      subject: 'EDA',
      title: 'Test Tema 1',
      kind: 'assessment',
      dates: ['2026-10-02']
    }]
  });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].daysRemaining, 2);
  assert.match(reminders[0].id, /assessment-soon$/);
});

test('the same assessment reminder keeps the same id the next day', () => {
  const signal = {
    id: 'uv-mail:772',
    subjectId: '34670',
    subject: 'EDA',
    title: 'Test Tema 1',
    kind: 'assessment',
    dates: ['2026-10-02']
  };
  const atTwoDays = buildAcademicReminders({ today: '2026-09-30', signals: [signal] });
  const atOneDay = buildAcademicReminders({ today: '2026-10-01', signals: [signal] });
  assert.equal(atTwoDays[0].id, atOneDay[0].id);
});

test('repeated signal dates remind once while distinct dates and signals remain separate', () => {
  const reminders = buildAcademicReminders({
    today: '2026-09-30',
    signals: [
      { id: 'exam-a', kind: 'assessment', dates: ['2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02'] },
      { id: 'exam-b', kind: 'assessment', dates: ['2026-10-01'] },
      { id: 'coursework', kind: 'coursework', dates: ['2026-10-01', '2026-10-01'] }
    ]
  });
  assert.deepEqual(reminders.map((item) => item.id), [
    'reminder:signal:coursework:2026-10-01:tomorrow',
    'reminder:signal:exam-a:2026-10-01:assessment-soon',
    'reminder:signal:exam-b:2026-10-01:assessment-soon',
    'reminder:signal:exam-a:2026-10-02:assessment-soon'
  ]);
});

test('repeated source records remind once while distinct obligations remain separate', () => {
  const signal = { id: 'shared-id', kind: 'assessment', dates: ['2026-10-01', '2026-10-02'] };
  const assignment = { id: 'shared-id', status: 'open', dueAt: '2026-10-01T09:30:00Z' };
  const reminders = buildAcademicReminders({
    today: '2026-09-30',
    signals: [signal, { ...signal, dates: [...signal.dates] }, { ...signal, id: 'other-signal' }],
    assignments: [assignment, { ...assignment }, { ...assignment, id: 'other-assignment' }]
  });
  assert.deepEqual(reminders.map((item) => item.id), [
    'reminder:assignment:other-assignment:2026-10-01:tomorrow',
    'reminder:assignment:shared-id:2026-10-01:tomorrow',
    'reminder:signal:other-signal:2026-10-01:assessment-soon',
    'reminder:signal:shared-id:2026-10-01:assessment-soon',
    'reminder:signal:other-signal:2026-10-02:assessment-soon',
    'reminder:signal:shared-id:2026-10-02:assessment-soon'
  ]);
});

test('coursework and schedule changes remind only the day before', () => {
  const reminders = buildAcademicReminders({
    today: '2026-09-30',
    signals: [
      { id: 'cw', subjectId: '34156', kind: 'coursework', dates: ['2026-10-01'], title: 'S2 Problemas' },
      { id: 'sc', subjectId: '34168', kind: 'schedule_change', dates: ['2026-10-01'], title: 'Cambio de clase' }
    ]
  });
  assert.deepEqual(reminders.map((item) => item.kind).sort(), ['coursework', 'schedule_change']);
});

test('conflicting signal subjects suppress reminders regardless of record order', () => {
  const signal = { id: 'conflicting', subjectId: '34670', kind: 'assessment', dates: ['2026-10-01'] };
  const other = { ...signal, id: 'other' };
  for (const subjectId of ['34156', undefined, null, '']) {
    const conflicting = { ...signal, subjectId };
    for (const records of [[signal, conflicting], [conflicting, signal]]) {
      const signals = [...records, other, { ...other }];
      const snapshot = structuredClone(signals);
      const reminders = buildAcademicReminders({ today: '2026-09-30', signals });
      assert.deepEqual(reminders.map((item) => [item.id, item.subjectId]), [
        ['reminder:signal:other:2026-10-01:assessment-soon', '34670']
      ], `conflicting subject: ${String(subjectId)}`);
      assert.deepEqual(signals, snapshot);
    }
  }
});

test('conflicting signal dates fail closed while equivalent date sets still remind', () => {
  const signal = { id: 'conflicting', kind: 'assessment', dates: ['2026-10-01', '2026-10-02'] };
  const other = { ...signal, id: 'other' };
  for (const dates of [['2026-10-01'], ['2026-10-02'], ['2026-10-03'], [], undefined, null]) {
    const conflicting = { ...signal, dates };
    for (const records of [[signal, conflicting], [conflicting, signal]]) {
      const signals = [...records, other, { ...other, dates: ['2026-10-02', '2026-10-01', '2026-10-02'] }];
      const snapshot = structuredClone(signals);
      const reminders = buildAcademicReminders({ today: '2026-09-30', signals });
      assert.deepEqual(reminders.map((item) => item.id), [
        'reminder:signal:other:2026-10-01:assessment-soon',
        'reminder:signal:other:2026-10-02:assessment-soon'
      ], `conflicting dates: ${JSON.stringify(dates)}`);
      assert.deepEqual(signals, snapshot);
    }
  }
});

test('mandatory attendance sessions remind only the day before with a stable identity', () => {
  const signal = {
    id: 'uv-mail:required-session',
    subjectId: '34670',
    subject: 'EDA',
    title: 'Sesión de asistencia obligatoria',
    kind: 'required_session',
    dates: ['2026-10-02']
  };
  for (const today of ['2026-09-30', '2026-10-02', '2026-10-03']) {
    assert.deepEqual(buildAcademicReminders({ today, signals: [signal] }), [], today);
  }
  const reminders = buildAcademicReminders({ today: '2026-10-01', signals: [signal] });
  assert.deepEqual(reminders, [{
    id: 'reminder:signal:uv-mail:required-session:2026-10-02:tomorrow',
    source: 'signal',
    subjectId: '34670',
    subject: 'EDA',
    title: 'Sesión de asistencia obligatoria',
    date: '2026-10-02',
    daysRemaining: 1,
    kind: 'required_session'
  }]);
  assert.deepEqual(buildAcademicReminders({ today: '2026-10-01', signals: [signal] }), reminders);
});

test('open assignments remind one day before but completed assignments do not', () => {
  const reminders = buildAcademicReminders({
    today: '2026-09-27',
    assignments: [
      { id: 'a1', subjectId: '34670', title: 'Entrega', status: 'open', dueAt: '2026-09-28T09:30:00.000Z' },
      { id: 'a2', subjectId: '34156', title: 'Hecha', status: 'done', dueAt: '2026-09-28T09:30:00.000Z' }
    ]
  });
  assert.deepEqual(reminders.map((item) => item.id), ['reminder:assignment:a1:2026-09-28:tomorrow']);
});

test('assignment reminders fail closed for normalized or ambiguous deadlines', () => {
  for (const [today, dueAt] of [
    ['2026-03-01', '2026-02-30T09:30:00.000Z'],
    ['2026-02-28', '2026-02-29T09:30:00Z'],
    ['2026-04-30', '2026-04-31T09:30:00Z'],
    ['2026-09-27', '2026-09-27T24:00:00Z'],
    ['2026-09-27', '2026-09-28T09:30:00'],
    ['2026-09-27', '2026-09-28']
  ]) {
    assert.deepEqual(buildAcademicReminders({
      today,
      assignments: [{ id: 'invalid', status: 'open', dueAt }]
    }), [], dueAt);
  }
});

test('conflicting assignment statuses suppress reminders regardless of record order', () => {
  const open = { id: 'conflicting', status: 'open', dueAt: '2026-10-01T09:30:00Z' };
  const other = { ...open, id: 'other' };
  for (const status of ['done', 'submitted', undefined, null, '']) {
    const conflicting = { ...open, status };
    for (const records of [[open, conflicting], [conflicting, open]]) {
      const reminders = buildAcademicReminders({
        today: '2026-09-30',
        assignments: [...records, other, { ...other }]
      });
      assert.deepEqual(reminders.map((item) => item.id), [
        'reminder:assignment:other:2026-10-01:tomorrow'
      ], `conflicting status: ${String(status)}`);
    }
  }
});

test('conflicting assignment deadlines suppress reminders regardless of record order', () => {
  const open = { id: 'conflicting', status: 'open', dueAt: '2026-10-01T09:30:00Z' };
  const other = { ...open, id: 'other' };
  for (const dueAt of ['2026-10-02T09:30:00Z', '2026-10-01T10:30:00Z', undefined, null, '', 'invalid', '2026-10-01T09:30:00']) {
    const conflicting = { ...open, dueAt };
    for (const records of [[open, conflicting], [conflicting, open]]) {
      const reminders = buildAcademicReminders({
        today: '2026-09-30',
        assignments: [...records, other, { ...other, dueAt: '2026-10-01T09:30:00.000Z' }]
      });
      assert.deepEqual(reminders.map((item) => item.id), [
        'reminder:assignment:other:2026-10-01:tomorrow'
      ], `conflicting deadline: ${String(dueAt)}`);
    }
  }
});

test('conflicting assignment subjects suppress reminders regardless of record order', () => {
  const open = { id: 'conflicting', subjectId: '34670', status: 'open', dueAt: '2026-10-01T09:30:00Z' };
  const other = { ...open, id: 'other' };
  for (const subjectId of ['34156', undefined, null, '']) {
    const conflicting = { ...open, subjectId };
    for (const records of [[open, conflicting], [conflicting, open]]) {
      const assignments = [...records, other, { ...other }];
      const snapshot = structuredClone(assignments);
      const reminders = buildAcademicReminders({ today: '2026-09-30', assignments });
      assert.deepEqual(reminders.map((item) => [item.id, item.subjectId]), [
        ['reminder:assignment:other:2026-10-01:tomorrow', '34670']
      ], `conflicting subject: ${String(subjectId)}`);
      assert.deepEqual(assignments, snapshot);
    }
  }
});

test('valid assignment deadlines retain leap-day and Madrid midnight timing', () => {
  for (const [today, dueAt, expectedDate] of [
    ['2028-02-28', '2028-02-29T09:30:00Z', '2028-02-29'],
    ['2026-09-27', '2026-09-27T22:30:00.000Z', '2026-09-28'],
    ['2026-12-31', '2026-12-31T23:30:00Z', '2027-01-01']
  ]) {
    const reminders = buildAcademicReminders({
      today,
      assignments: [{ id: 'valid', status: 'open', dueAt }]
    });
    assert.equal(reminders.length, 1, dueAt);
    assert.equal(reminders[0].date, expectedDate);
    assert.equal(reminders[0].daysRemaining, 1);
  }
});
