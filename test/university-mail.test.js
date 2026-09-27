import assert from 'node:assert/strict';
import test from 'node:test';
import { scanRelevantUniversityMail } from '../src/university-mail.js';

const courses = [
  { code: '34156', name: '2026-27 Análisis Matemático II Gr.B-T (34156)' },
  { code: '34670', name: '2026-27 Estructuras de datos y algoritmos Gr.A-T (34670)' }
];

function bridge({ restore = true } = {}) {
  const reads = [];
  return {
    reads,
    async listReadablePages() {
      return [
        { id: 'm1', url: 'https://sogo.uv.es/SOGo/so/test/Mail/view', title: 'Correo' },
        { id: 'c1', url: 'https://aulavirtual.uv.es/my/courses.php', title: 'Cursos' }
      ];
    },
    async scanMail() {
      return {
        ready: true,
        total: 300,
        unread: 10,
        messages: [
          {
            uid: '10',
            subject: '2026-27 Estructures de dades i algorismes Gr.A-T (34670): Test Tema 1',
            fromName: 'Profesor',
            fromEmail: 'noreply@uv.es',
            relativeDate: 'Viernes 15:27',
            isRead: false
          },
          {
            uid: '11',
            subject: '[PREGON tit0000] AgendaUV | Noticias',
            fromName: 'UVinformación',
            fromEmail: 'no-reply@alumni.uv.es',
            relativeDate: 'Viernes 15:10',
            isRead: false
          }
        ]
      };
    },
    async readMailMessage(targetId, uid) {
      reads.push({ targetId, uid });
      return {
        found: true,
        uid,
        subject: 'Test Tema 1',
        wasRead: false,
        isRead: !restore,
        readStateRestored: restore,
        body: 'El próximo viernes haremos un test. Puntuará como parte de la evaluación continua.'
      };
    }
  };
}

test('mail intelligence reads bodies only for relevant candidates', async () => {
  const fake = bridge();
  const result = await scanRelevantUniversityMail({ bridge: fake, courses });
  assert.equal(result.inbox.scanned, 2);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].uid, '10');
  assert.match(result.alerts[0].body, /evaluación continua/);
  assert.deepEqual(fake.reads, [{ targetId: 'm1', uid: '10' }]);
  assert.ok(result.seenIds.includes('uv-mail:10'));
  assert.ok(result.seenIds.includes('uv-mail:11'));
});

test('mail intelligence does not reopen already-seen relevant mail', async () => {
  const fake = bridge();
  const result = await scanRelevantUniversityMail({
    bridge: fake,
    courses,
    seenIds: ['uv-mail:10']
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].isNew, false);
  assert.equal(fake.reads.length, 0);
});

test('mail intelligence fails closed if unread state cannot be restored', async () => {
  await assert.rejects(
    () => scanRelevantUniversityMail({ bridge: bridge({ restore: false }), courses }),
    /read_state_not_restored/
  );
});

test('mail intelligence rejects missing SOGo session', async () => {
  const fake = bridge();
  fake.listReadablePages = async () => [{ id: 'c1', url: 'https://aulavirtual.uv.es/my/courses.php' }];
  await assert.rejects(
    () => scanRelevantUniversityMail({ bridge: fake, courses }),
    /page_missing/
  );
});
