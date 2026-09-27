import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUvSnapshot,
  parseUvAssignmentPage,
  parseUvCalendarAssignmentLinks,
  parseUvCourseActivities,
  parseUvCourseRegistry,
  parseUvMoodleDate,
  parseUvVisiblePracticalGroups
} from '../src/uv-moodle.js';

test('UV date parser converts Moodle Spanish dates to Europe/Madrid UTC', () => {
  assert.equal(parseUvMoodleDate('miércoles, 23 de septiembre de 2026, 11:30'), '2026-09-23T09:30:00.000Z');
  assert.equal(parseUvMoodleDate('domingo, 25 de octubre de 2026, 11:30'), '2026-10-25T10:30:00.000Z');
});

test('UV dashboard parser deduplicates course cards and marks academic subjects', () => {
  const page = {
    links: [
      { url: 'https://aulavirtual.uv.es/course/view.php?id=101', text: '2026-27 Curso de Prueba A Gr.B-T (12345)' },
      { url: 'https://aulavirtual.uv.es/course/view.php?id=101', text: 'Nombre del curso 2026-27 Curso de Prueba A Gr.B-T (12345)' },
      { url: 'https://aulavirtual.uv.es/course/view.php?id=102', text: '2026-27 Espacio General de Prueba' }
    ]
  };
  const courses = parseUvCourseRegistry(page);
  assert.equal(courses.length, 2);
  assert.equal(courses.find((course) => course.id === '101').code, '12345');
  assert.equal(courses.find((course) => course.id === '102').academic, false);
});

test('UV course page discovers personalized practical subgroup sections', () => {
  const groups = parseUvVisiblePracticalGroups({
    text: 'Prácticas semanales de Análisis Matemático II (Subgrupo B-P2)\nPràctiques del Subgrup B-P2',
    links: [{ text: 'S2. Problemas', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8' }]
  });
  assert.deepEqual(groups, ['B-P2']);
});

test('UV course activities keep only bounded read-view activity types', () => {
  const activities = parseUvCourseActivities({
    links: [
      { url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7', text: 'Ejercicio Tarea' },
      { url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8', text: 'Tema 1 Archivo' },
      { url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7', text: 'Ejercicio Tarea' },
      { url: 'https://evil.example/mod/assign/view.php?id=9', text: 'Bad' }
    ]
  });
  assert.deepEqual(activities.map((item) => item.id), ['assign:7', 'resource:8']);
});

test('UV assignment parser recognizes a submitted closed task', () => {
  const page = {
    url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7',
    title: '2026-27 Curso de Prueba A Gr.B-T (12345): Ejercicios Tema 1 | AulaVirtual',
    text: [
      'Ejercicios Tema 1',
      'Apertura: viernes, 18 de septiembre de 2026, 00:00',
      'Cierre: miércoles, 23 de septiembre de 2026, 11:30',
      '',
      'Ejercicios: 1 d - m, 2 d - i, 3, 5, 7, 9.',
      '',
      'Estado de la entrega',
      'Estado de la entrega\tEnviado para calificar',
      'Estado de la calificación\tSin calificar'
    ].join('\n')
  };
  const parsed = parseUvAssignmentPage(page, { id: '101', code: '12345', name: 'Curso A' });
  assert.equal(parsed.status, 'done');
  assert.equal(parsed.dueAt, '2026-09-23T09:30:00.000Z');
  assert.match(parsed.instructions, /Ejercicios: 1 d/);
});

test('UV calendar parser extracts assignment deadline links without navigation actions', () => {
  const events = parseUvCalendarAssignmentLinks({
    links: [
      { url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7', text: 'Vencimiento de Ejercicio Bucle' },
      { url: 'https://aulavirtual.uv.es/calendar/view.php?view=month', text: '23' }
    ]
  });
  assert.deepEqual(events, [{
    providerId: '7',
    url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7',
    title: 'Ejercicio Bucle'
  }]);
});

test('UV snapshot includes academic subjects and normalized assignments only', () => {
  const snapshot = buildUvSnapshot({
    capturedAt: '2026-09-27T12:00:00Z',
    courses: [
      { id: '101', code: '12345', name: 'Curso A', academic: true },
      { id: '102', code: null, name: 'General', academic: false }
    ],
    assignments: [
      { id: 'uv:assign:7', subjectId: '12345', title: 'Task', dueAt: null, status: 'open', url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7' }
    ],
    materials: [
      { id: 'uv:resource:8', subjectId: '12345', title: 'Tema 1', firstSeenAt: '2026-09-27T12:00:00Z', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8' }
    ]
  });
  assert.deepEqual(snapshot.subjects, [{ id: '12345', name: 'Curso A' }]);
  assert.equal(snapshot.assignments.length, 1);
  assert.equal(snapshot.materials.length, 1);
});
