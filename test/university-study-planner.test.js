import assert from 'node:assert/strict';
import test from 'node:test';
import { planUniversityStudyDay } from '../src/university-study-planner.js';

function snapshot() {
  return {
    version: 1,
    source: 'uv-aulavirtual',
    capturedAt: '2026-09-27T12:00:00Z',
    subjects: [
      { id: 'A', name: 'Análisis' },
      { id: 'E', name: 'EDA' },
      { id: 'T', name: 'Topología' }
    ],
    announcements: [],
    assignments: [],
    materials: [
      { id: 'm1', subjectId: 'A', title: 'S2. Problemas - Corrección 1 de octubre de 2026', publishedAt: '2026-09-27T12:00:00Z', url: 'https://campus.example/m1' },
      { id: 'm2', subjectId: 'A', title: 'Examen parcial enero 2024-2025', publishedAt: '2026-09-27T12:00:00Z', url: 'https://campus.example/m2' },
      { id: 'm3', subjectId: 'E', title: 'Ejer2eda', publishedAt: '2026-09-27T12:00:00Z', url: 'https://campus.example/m3' },
      { id: 'm4', subjectId: 'T', title: 'Seminario 1', publishedAt: '2026-09-27T12:00:00Z', url: 'https://campus.example/m4' }
    ]
  };
}

function changes() {
  return {
    announcements: { added: [], updated: [], removed: [] },
    assignments: { added: [], updated: [], removed: [] },
    materials: { added: [], updated: [], removed: [] }
  };
}

test('study planner fills an empty deadline day with diverse useful work', () => {
  const result = planUniversityStudyDay({
    snapshot: snapshot(),
    changes: changes(),
    today: '2026-09-27',
    targetTasks: 3
  });
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(new Set(result.tasks.map((item) => item.subjectId)), new Set(['A', 'E', 'T']));
  assert.equal(result.tasks.some((item) => /Examen parcial/.test(item.title)), false);
  assert.equal(result.tasks.every((item) => item.kind === 'study'), true);
});

test('study planner rotates away from material recommended yesterday', () => {
  const source = snapshot();
  source.materials.push({
    id: 'm5',
    subjectId: 'E',
    title: 'Tema 2',
    publishedAt: '2026-09-27T12:00:00Z',
    url: 'https://campus.example/m5'
  });
  const result = planUniversityStudyDay({
    snapshot: source,
    changes: changes(),
    history: { lastRecommendedByMaterial: { m3: '2026-09-26' } },
    today: '2026-09-27',
    targetTasks: 3
  });
  assert.equal(result.tasks.some((item) => item.id === 'study:m3'), false);
  assert.equal(result.tasks.some((item) => item.id === 'study:m5'), true);
});

test('deadline tasks keep precedence over study filler', () => {
  const source = snapshot();
  source.assignments = [{
    id: 'a1',
    subjectId: 'E',
    title: 'Entrega mañana',
    dueAt: '2026-09-28T20:00:00Z',
    status: 'open',
    url: 'https://campus.example/a1'
  }];
  const result = planUniversityStudyDay({
    snapshot: source,
    changes: changes(),
    today: '2026-09-27',
    targetTasks: 3
  });
  assert.equal(result.tasks[0].kind, 'assignment');
  assert.equal(result.tasks.length, 3);
});
