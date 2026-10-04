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

test('preparation does not mistake word endings for session markers', () => {
  const resources = recommendAcademicPreparation({
    subjectId: '34670',
    title: 'Test Tema 1',
    kind: 'assessment'
  }, [
    materials[0],
    { id: 'practice', subjectId: '34670', title: 'Problemas 2 — Tema 1', url: materials[1].url },
    { id: 'unrelated', subjectId: '34670', title: 'Problemas 1 — Tema 2', url: materials[4].url }
  ]);
  assert.deepEqual(resources.map((item) => item.id), ['m1', 'practice']);
});

test('preparation does not truncate longer topic numbers into the assessment focus', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 10', kind: 'assessment' };
  const matching = [
    { id: 'theory', subjectId: '34670', title: 'Tema 10' },
    { id: 'practice', subjectId: '34670', title: 'Ejer10eda' }
  ];
  for (const title of ['Tema 100', 'Ejer101eda', 'Pr1000', 'Sesión 100']) {
    const unrelated = { id: 'unrelated', subjectId: '34670', title };
    assert.deepEqual(recommendAcademicPreparation(signal, [unrelated]), [], title);
    assert.deepEqual(
      recommendAcademicPreparation(signal, [unrelated, ...matching]).map((item) => item.id),
      ['theory', 'practice'],
      title
    );
  }
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

test('focused preparation excludes other topics even when scoring bonuses favor them', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 1', kind: 'assessment' };
  const general = { id: 'general', subjectId: '34670', title: 'Apuntes generales' };
  for (const title of ['Ejer2eda resueltos', 'Tema 2 ejercicios resueltos', 'Pr2 soluciones']) {
    const unrelated = { id: 'unrelated', subjectId: '34670', title };
    assert.deepEqual(recommendAcademicPreparation(signal, [unrelated]), [], title);
    assert.deepEqual(
      recommendAcademicPreparation(signal, [unrelated, general]).map((item) => item.id),
      ['general'],
      title
    );
    assert.deepEqual(
      recommendAcademicPreparation(signal, [unrelated, ...materials]).map((item) => item.id),
      ['m1', 'm2', 'm3'],
      title
    );
  }
});

test('preparation requires explicit course identities before matching materials', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 1', kind: 'assessment' };
  const ambiguousIds = [undefined, null, '', '   ', {}, [], true, 34670];
  const ambiguousMaterials = ambiguousIds.map((subjectId, index) => ({
    ...materials[0], id: 'ambiguous-' + index, subjectId
  }));

  for (const subjectId of ambiguousIds) {
    assert.deepEqual(recommendAcademicPreparation(
      { ...signal, subjectId }, [...ambiguousMaterials, ...materials]
    ), []);
  }
  assert.deepEqual(
    recommendAcademicPreparation(signal, [...ambiguousMaterials, ...materials]).map((item) => item.id),
    ['m1', 'm2', 'm3']
  );
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

test('preparation skips unidentifiable resources without displacing valid study material', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 1', kind: 'assessment' };
  for (const id of [undefined, null, '', '   ', 42, true, {}, []]) {
    const inputs = [{ ...materials[0], id }, ...materials];
    const snapshot = structuredClone(inputs);
    assert.deepEqual(
      recommendAcademicPreparation(signal, inputs).map((item) => item.id),
      ['m1', 'm2', 'm3'],
      `invalid resource identity: ${String(id)}`
    );
    assert.deepEqual(inputs, snapshot);
    assert.deepEqual(recommendAcademicPreparation(signal, [{ ...materials[0], id }]), []);
  }
});

test('preparation skips unusable titles without blocking valid recommendations', () => {
  const signal = { subjectId: '34670', title: 'Examen parcial', kind: 'assessment' };
  const valid = { id: 'valid', subjectId: '34670', title: 'Lectura complementaria' };
  for (const title of [undefined, null, '', '   ', 42, true, {}, []]) {
    const invalid = { id: 'invalid', subjectId: '34670', title };
    assert.deepEqual(recommendAcademicPreparation(signal, [invalid]), [], String(title));
    for (const inputs of [[valid, invalid], [invalid, valid]]) {
      const snapshot = structuredClone(inputs);
      assert.deepEqual(
        recommendAcademicPreparation(signal, inputs).map((item) => item.id),
        ['valid'],
        String(title)
      );
      assert.deepEqual(inputs, snapshot);
    }
  }
});

test('preparation skips conflicting resource course identities in either record order', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 1', kind: 'assessment' };
  for (const subjectId of ['34156', undefined, null, '', '   ', 34670]) {
    const conflicting = { ...materials[0], subjectId };
    for (const records of [[materials[0], conflicting], [conflicting, materials[0]]]) {
      const inputs = [...records, materials[1], { ...materials[1] }, materials[2]];
      const snapshot = structuredClone(inputs);
      assert.deepEqual(
        recommendAcademicPreparation(signal, inputs).map((item) => item.id),
        ['m2', 'm3'],
        `conflicting course: ${String(subjectId)}`
      );
      assert.deepEqual(inputs, snapshot);
    }
  }
});

test('preparation rejects conflicting resource titles while retaining equivalent duplicates', () => {
  const signal = { subjectId: '34670', title: 'Test Tema 1', kind: 'assessment' };
  for (const title of ['Tema 2', 'Guía docente', undefined, null, '', '   ', ['tema1']]) {
    const conflicting = { ...materials[0], title };
    for (const records of [[materials[0], conflicting], [conflicting, materials[0]]]) {
      const inputs = [...records, materials[1], { ...materials[1], title: '  Ejer1eda\n ' }, materials[2]];
      const snapshot = structuredClone(inputs);
      assert.deepEqual(
        recommendAcademicPreparation(signal, inputs).map((item) => item.id),
        ['m2', 'm3'],
        `conflicting title: ${String(title)}`
      );
      assert.deepEqual(inputs, snapshot);
    }
  }
});
