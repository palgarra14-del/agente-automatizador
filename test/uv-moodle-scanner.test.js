import assert from 'node:assert/strict';
import test from 'node:test';
import { scanUvMoodle } from '../src/uv-moodle-scanner.js';

const course = {
  id: '116386',
  code: '34670',
  name: 'Estructuras de datos y algoritmos',
  url: 'https://aulavirtual.uv.es/course/view.php?id=116386'
};

function fakeBridge({ expired = false } = {}) {
  const calls = [];
  return {
    calls,
    async listReadablePages() {
      return [{ id: 'tab-1', url: 'https://aulavirtual.uv.es/my/courses.php', title: 'Mis cursos' }];
    },
    async navigatePage(targetId, url) {
      calls.push({ targetId, url });
      if (expired) return { url: 'https://aulavirtual.uv.es/login/index.php', title: 'Login', text: 'Inicia sesión', links: [] };
      if (url.includes('/course/view.php')) {
        return {
          url,
          title: 'EDA',
          text: 'Tema 1',
          links: [
            { url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8', text: 'Tema 1 Archivo' },
            { url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7', text: 'Ejercicio Tarea' }
          ]
        };
      }
      if (url.includes('/calendar/view.php')) {
        return {
          url,
          title: 'Calendario',
          text: '27',
          links: [{ url: 'https://aulavirtual.uv.es/mod/assign/view.php?id=7', text: 'Vencimiento de Ejercicio' }]
        };
      }
      if (url.includes('/mod/assign/view.php')) {
        return {
          url,
          title: '2026-27 Estructures de dades i algorismes Gr.A-T (34670): Ejercicio | AulaVirtual',
          text: [
            'Ejercicio',
            'Apertura: viernes, 18 de septiembre de 2026, 00:00',
            'Cierre: lunes, 28 de septiembre de 2026, 11:30',
            '',
            'Resolver ejercicio.',
            '',
            'Estado de la entrega',
            'Estado de la entrega\tNo se ha realizado ninguna entrega'
          ].join('\n'),
          links: []
        };
      }
      return { url, title: 'Mis cursos', text: 'Dashboard', links: [] };
    }
  };
}

test('UV scanner builds a private academic snapshot and restores the dashboard', async () => {
  const bridge = fakeBridge();
  const result = await scanUvMoodle({
    bridge,
    courses: [course],
    capturedAt: '2026-09-27T12:00:00Z'
  });
  assert.equal(result.snapshot.assignments.length, 1);
  assert.equal(result.snapshot.assignments[0].status, 'open');
  assert.equal(result.snapshot.materials.length, 1);
  assert.equal(result.snapshot.materials[0].publishedAt, '2026-09-27T12:00:00Z');
  assert.equal(bridge.calls.at(-1).url, 'https://aulavirtual.uv.es/my/courses.php');
});

test('UV scanner preserves first-seen material time across scans', async () => {
  const bridge = fakeBridge();
  const result = await scanUvMoodle({
    bridge,
    courses: [course],
    capturedAt: '2026-09-28T12:00:00Z',
    previousObservations: {
      materials: [{
        id: 'uv:resource:8',
        subjectId: '34670',
        title: 'Tema 1',
        url: 'https://aulavirtual.uv.es/mod/resource/view.php?id=8',
        firstSeenAt: '2026-09-27T12:00:00Z'
      }]
    }
  });
  assert.equal(result.snapshot.materials[0].publishedAt, '2026-09-27T12:00:00Z');
});

test('UV scanner fails closed on expired university session', async () => {
  const bridge = fakeBridge({ expired: true });
  await assert.rejects(
    () => scanUvMoodle({ bridge, courses: [course], capturedAt: '2026-09-27T12:00:00Z' }),
    /session_expired/
  );
  assert.equal(bridge.calls.at(-1).url, 'https://aulavirtual.uv.es/my/courses.php');
});
