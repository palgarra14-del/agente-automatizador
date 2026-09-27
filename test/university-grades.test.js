import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUvGradeState,
  diffUvGrades,
  parseUvGradeOverview
} from '../src/university-grades.js';

const courses = [
  { code: '34154', name: '2026-27 Programación Matemática Gr.B-T (34154)' },
  { code: '34670', name: '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670)' }
];

test('grade overview keeps only current registered subjects', () => {
  const page = {
    text: [
      'Nombre del curso\tCalificación',
      '2025-26 Programación Matemática Gr.B-T (34154)\t8,20',
      '2026-27 Programación Matemática Gr.B-T (34154)\t-',
      '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670)\t7,50',
      '2026-27 Otro curso (99999)\t10'
    ].join('\n')
  };
  assert.deepEqual(parseUvGradeOverview(page, courses), [
    { subjectId: '34154', grade: '-', available: false },
    { subjectId: '34670', grade: '7,50', available: true }
  ]);
});

test('first grade scan establishes baseline without emitting changes', () => {
  const grades = [
    { subjectId: '34154', grade: '-', available: false },
    { subjectId: '34670', grade: '-', available: false }
  ];
  assert.deepEqual(diffUvGrades(null, grades), []);
  const state = createUvGradeState(grades, '2026-09-27T17:00:00.000Z');
  assert.equal(state.version, 1);
  assert.equal(state.grades.length, 2);
});

test('grade changes emit only changed current subjects', () => {
  const previous = {
    version: 1,
    grades: [
      { subjectId: '34154', grade: '-', available: false },
      { subjectId: '34670', grade: '-', available: false }
    ]
  };
  const current = [
    { subjectId: '34154', grade: '-', available: false },
    { subjectId: '34670', grade: '8,25', available: true }
  ];
  assert.deepEqual(diffUvGrades(previous, current), [
    {
      subjectId: '34670',
      previousGrade: '-',
      grade: '8,25',
      available: true
    }
  ]);
});
