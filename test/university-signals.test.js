import assert from 'node:assert/strict';
import test from 'node:test';
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
