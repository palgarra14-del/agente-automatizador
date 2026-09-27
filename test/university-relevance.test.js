import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAcademicProfile,
  classifyAcademicMail,
  mergeMailBody,
  selectRelevantAcademicMail,
  summarizeAcademicProfile
} from '../src/university-relevance.js';

const profile = buildAcademicProfile([
  {
    code: '34156',
    name: '2026-27 Análisis Matemático II Gr.B-T (34156)'
  },
  {
    code: '34168',
    name: '2026-27 Estructuras Algebraicas Gr.B-T (34168)'
  },
  {
    code: '34670',
    name: '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670)'
  },
  {
    code: '34164',
    name: '2026-27 Topología Gr.B-T (34164)'
  }
]);

test('academic profile extracts the exact theory group per subject', () => {
  const summary = summarizeAcademicProfile(profile);
  assert.deepEqual(summary.map((item) => [item.subjectId, item.theoryGroup]), [
    ['34156', 'B-T'],
    ['34168', 'B-T'],
    ['34670', 'A-T'],
    ['34164', 'B-T']
  ]);
});
test('course-coded evaluation and schedule messages are actionable', () => {
  const eda = classifyAcademicMail({
    uid: '772',
    subject: '2026-27 Estructures de dades i algorismes Gr.A-T (34670): Test Tema 1'
  }, profile);
  assert.equal(eda.decision, 'notify');
  assert.equal(eda.course.subjectId, '34670');

  const algebra = classifyAcademicMail({
    uid: '771',
    subject: '[2026-27 Estructures algebraiques Gr.B-T (34168)] cambios de horas y semanas 3 y 4'
  }, profile);
  assert.equal(algebra.decision, 'notify');
  assert.equal(algebra.reason, 'aviso_accionable_asignatura');
});

test('generic UV broadcasts and unrelated seminar mail are ignored', () => {
  const newsletter = classifyAcademicMail({
    uid: '773',
    subject: '[PREGON tit0000] AgendaUV | UVinvestigación | Te interesa'
  }, profile);
  assert.equal(newsletter.decision, 'ignore');

  const seminar = classifyAcademicMail({
    uid: '760',
    subject: '[PREGON tit1936] Seminari topologia algebraica'
  }, profile);
  assert.equal(seminar.decision, 'ignore');
});
test('mail from a previous academic year is discarded even with the same subject code', () => {
  const result = classifyAcademicMail({
    uid: '702',
    subject: '[2025-26 Estructures de dades i algorismes Gr.A-T (34670)] examen final'
  }, profile);
  assert.equal(result.decision, 'ignore');
  assert.equal(result.reason, 'curso_academico_anterior');
});

test('wrong theory group is discarded even if the subject code matches', () => {
  const result = classifyAcademicMail({
    uid: '700',
    subject: '2026-27 Análisis Matemático II Gr.A-T (34156): cambio de aula'
  }, profile);
  assert.equal(result.decision, 'ignore');
  assert.equal(result.reason, 'otro_grupo_teoria');
});

test('known practical subgroup confirms relevant mail and rejects another subgroup', () => {
  const groupProfile = buildAcademicProfile([
    {
      code: '34156',
      name: '2026-27 Análisis Matemático II Gr.B-T (34156)',
      practicalGroups: ['B-P2']
    }
  ]);
  const own = classifyAcademicMail({
    uid: '770',
    subject: '2026-27 Anàlisi matemàtica II Gr.B-T (34156): Sesión 2 - Subgrupo B-P2'
  }, groupProfile);
  assert.notEqual(own.decision, 'ignore');
  assert.notEqual(own.decision, 'needs_context');
  const other = classifyAcademicMail({
    uid: '771',
    subject: '2026-27 Anàlisi matemàtica II Gr.B-T (34156): Sesión 2 - Subgrupo B-P1'
  }, groupProfile);
  assert.equal(other.decision, 'ignore');
  assert.equal(other.reason, 'otro_grupo_practicas');
});

test('unknown practical subgroup is not treated as confirmed relevance', () => {
  const result = classifyAcademicMail({
    uid: '769',
    subject: '2026-27 Anàlisi matemàtica II Gr.B-T (34156): Sesión 2 de Problemas - Subgrupo B-P2'
  }, profile);
  assert.equal(result.decision, 'needs_context');
  assert.equal(result.reason, 'subgrupo_practicas_por_confirmar');
});

test('practical subgroup filtering does not require a known theory group', () => {
  for (const practicalGroups of [[], ['B-P2']]) {
    const groupProfile = buildAcademicProfile([{
      code: '34156',
      name: '2026-27 Análisis Matemático II (34156)',
      practicalGroups
    }]);
    for (const subgroup of ['B-P1', 'B-P2']) {
      const result = classifyAcademicMail({
        uid: '769',
        subject: `2026-27 Análisis Matemático II (34156): Test Subgrupo ${subgroup}`
      }, groupProfile);
      if (!practicalGroups.length) {
        assert.equal(result.decision, 'needs_context');
        assert.equal(result.reason, 'subgrupo_practicas_por_confirmar');
      } else if (subgroup === 'B-P2') {
        assert.equal(result.decision, 'notify');
      } else {
        assert.equal(result.decision, 'ignore');
        assert.equal(result.reason, 'otro_grupo_practicas');
      }
    }
  }
});

test('body enrichment keeps a relevant course message and adds body context', () => {
  const [alert] = selectRelevantAcademicMail([{
    uid: '772',
    fromName: 'Fernando',
    fromEmail: 'noreply@uv.es',
    subject: '2026-27 Estructures de dades i algorismes Gr.A-T (34670): Test Tema 1',
    relativeDate: 'Viernes 15:27',
    isRead: false
  }], profile);
  const enriched = mergeMailBody(
    alert,
    'El próximo viernes 2 de Octubre haremos un pequeño test. Puntuará como parte de la evaluación continua.',
    profile
  );
  assert.equal(enriched.decision, 'notify');
  assert.match(enriched.body, /evaluación continua/);
});
test('mail selection returns only personal academic signals and tracks seen items', () => {
  const messages = [
    {
      uid: '772',
      subject: '2026-27 Estructures de dades i algorismes Gr.A-T (34670): Test Tema 1',
      fromName: 'Fernando',
      isRead: false
    },
    {
      uid: '773',
      subject: '[PREGON tit0000] AgendaUV | Noticias | Te interesa',
      fromName: 'UVinformación',
      isRead: false
    }
  ];
  const alerts = selectRelevantAcademicMail(messages, profile, { seenIds: ['uv-mail:772'] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].uid, '772');
  assert.equal(alerts[0].isNew, false);
  assert.equal(alerts[0].unread, true);
});
