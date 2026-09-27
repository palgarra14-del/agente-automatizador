import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendAcademicPreparation } from '../src/university-preparation.js';

const materials = [
  { id: 'm1', subjectId: '34670', title: 'tema1', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=1' },
  { id: 'm2', subjectId: '34670', title: 'Ejer1eda', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=2' },
  { id: 'm3', subjectId: '34670', title: 'Ejer1eda resueltos', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=3' },
  { id: 'm4', subjectId: '34670', title: 'git-cheat-sheet', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=4' },
  { id: 'm5', subjectId: '34670', title: 'tema2', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=5' },
  { id: 'x1', subjectId: '34156', title: 'Tema 1', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=6' }
];

test('assessment preparation picks matching theory, exercise and solution for the same topic', () => {
  const resources = recommendAcademicPreparation({
    subjectId: '34670',
    title: 'Test Tema 1',
    body: 'El test será sobre el Tema 1.',
    kind: 'assessment'
  }, materials);
  assert.deepEqual(resources.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(resources.map((item) => item.category), ['theory', 'practice', 'solution']);
});

test('preparation never crosses subject boundaries or prefers unrelated admin resources', () => {
  const resources = recommendAcademicPreparation({
    subjectId: '34670',
    title: 'Test Tema 1',
    kind: 'assessment'
  }, materials, { limit: 2 });
  assert.ok(resources.every((item) => ['m1', 'm2', 'm3'].includes(item.id)));
  assert.ok(resources.every((item) => item.id !== 'x1'));
  assert.ok(resources.every((item) => item.id !== 'm4'));
});

test('generic assessment can fall back to exam material when no topic is known', () => {
  const resources = recommendAcademicPreparation({
    subjectId: '34670',
    title: 'Examen parcial',
    kind: 'assessment'
  }, [
    { id: 'e1', subjectId: '34670', title: 'Examen parcial 2025', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8' },
    { id: 'g1', subjectId: '34670', title: 'Guia de estilo', url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=9' }
  ], { limit: 1 });
  assert.equal(resources[0].id, 'e1');
});
