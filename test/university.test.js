import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUniversityReadOnlyAdapter,
  detectUniversityChanges,
  normalizeUniversitySnapshot,
  planUniversityDay
} from '../src/university.js';

function snapshot(overrides = {}) {
  return {
    version: 1,
    source: 'campus-test',
    capturedAt: '2026-09-27T10:00:00Z',
    subjects: [
      { id: 'mat', name: 'Matemáticas' },
      { id: 'prog', name: 'Programación' }
    ],
    announcements: [],
    assignments: [],
    materials: [],
    ...overrides
  };
}

test('normalizes a bounded read-only university snapshot', () => {
  const value = normalizeUniversitySnapshot(snapshot({
    assignments: [{ id: 'a1', subjectId: 'mat', title: 'Hoja 4', dueAt: '2026-09-29T22:00:00Z', status: 'open', url: 'https://campus.example/a1' }]
  }));
  assert.equal(value.assignments[0].title, 'Hoja 4');
  assert.equal(value.assignments[0].status, 'open');
});

test('rejects secrets and cross-subject academic records', () => {
  assert.throws(() => normalizeUniversitySnapshot({ ...snapshot(), token: 'secret' }), /secret_material_forbidden/);
  assert.throws(() => normalizeUniversitySnapshot(snapshot({
    materials: [{ id: 'm1', subjectId: 'unknown', title: 'Tema', publishedAt: '2026-09-27T09:00:00Z' }]
  })), /unknown_subject/);
});

test('detects added updated and removed records deterministically', () => {
  const previous = snapshot({
    assignments: [{ id: 'a1', subjectId: 'mat', title: 'Hoja 4', dueAt: '2026-10-02T20:00:00Z', status: 'open' }],
    materials: [{ id: 'm-old', subjectId: 'prog', title: 'Tema antiguo', publishedAt: '2026-09-20T10:00:00Z' }]
  });
  const current = snapshot({
    capturedAt: '2026-09-27T11:00:00Z',
    assignments: [
      { id: 'a1', subjectId: 'mat', title: 'Hoja 4 revisada', dueAt: '2026-10-02T20:00:00Z', status: 'open' },
      { id: 'a2', subjectId: 'prog', title: 'Práctica 2', dueAt: '2026-09-28T20:00:00Z', status: 'open' }
    ],
    announcements: [{ id: 'n1', subjectId: 'mat', title: 'Cambio de aula', publishedAt: '2026-09-27T10:30:00Z' }]
  });
  const changes = detectUniversityChanges(previous, current);
  assert.deepEqual(changes.assignments.added.map((item) => item.id), ['a2']);
  assert.deepEqual(changes.assignments.updated.map((item) => item.id), ['a1']);
  assert.deepEqual(changes.materials.removed.map((item) => item.id), ['m-old']);
  assert.deepEqual(changes.announcements.added.map((item) => item.id), ['n1']);
});

test('daily planning prioritizes overdue and imminent assignments before new reading', () => {
  const current = snapshot({
    assignments: [
      { id: 'late', subjectId: 'mat', title: 'Entrega atrasada', dueAt: '2026-09-26T20:00:00Z', status: 'open' },
      { id: 'soon', subjectId: 'prog', title: 'Práctica mañana', dueAt: '2026-09-28T20:00:00Z', status: 'open' },
      { id: 'done', subjectId: 'prog', title: 'Ya terminada', dueAt: '2026-09-28T20:00:00Z', status: 'done' }
    ],
    announcements: [{ id: 'n1', subjectId: 'mat', title: 'Aviso', publishedAt: '2026-09-27T10:30:00Z' }],
    materials: [{ id: 'm1', subjectId: 'prog', title: 'Tema nuevo', publishedAt: '2026-09-27T10:30:00Z' }]
  });
  const changes = detectUniversityChanges(snapshot(), current);
  const tasks = planUniversityDay(current, changes, { today: '2026-09-27' });
  assert.deepEqual(tasks.map((task) => task.id), ['assignment:late', 'assignment:soon', 'announcement:n1', 'material:m1']);
  assert.equal(tasks.some((task) => task.id === 'assignment:done'), false);
});

test('read-only adapter exposes only normalized reading and binds the source', async () => {
  const adapter = createUniversityReadOnlyAdapter({ source: 'campus-test', readSnapshot: async () => snapshot() });
  assert.deepEqual(Object.keys(adapter).sort(), ['read', 'source']);
  const value = await adapter.read();
  assert.equal(value.source, 'campus-test');
  assert.throws(() => createUniversityReadOnlyAdapter({ source: 'campus-test', readSnapshot: null }), /reader_invalid/);
});

test('different providers cannot silently replace the stored source identity', () => {
  assert.throws(() => detectUniversityChanges(snapshot(), snapshot({ source: 'other-campus' })), /source_changed/);
});
