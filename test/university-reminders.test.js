import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAcademicReminders } from '../src/university-reminders.js';

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
