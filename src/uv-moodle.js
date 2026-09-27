import { normalizeUniversitySnapshot } from './university.js';

const UV_ORIGIN = 'https://aulavirtual.uv.es';
const SPANISH_MONTHS = new Map([
  ['enero', 1], ['febrero', 2], ['marzo', 3], ['abril', 4],
  ['mayo', 5], ['junio', 6], ['julio', 7], ['agosto', 8],
  ['septiembre', 9], ['setiembre', 9], ['octubre', 10],
  ['noviembre', 11], ['diciembre', 12]
]);
const VALENCIAN_MONTHS = new Map([
  ['gener', 1], ['febrer', 2], ['març', 3], ['abril', 4],
  ['maig', 5], ['juny', 6], ['juliol', 7], ['agost', 8],
  ['setembre', 9], ['octubre', 10], ['novembre', 11], ['desembre', 12]
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function urlOf(value) {
  const url = new URL(value);
  if (url.origin !== UV_ORIGIN || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('uv_moodle_url_forbidden');
  }
  url.hash = '';
  return url;
}

function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
}

function zonedDateToIso({ year, month, day, hour, minute }, timeZone = 'Europe/Madrid') {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = datePartsInZone(new Date(guess), timeZone);
    const observed = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    guess -= observed - desired;
  }
  return new Date(guess).toISOString();
}

export function parseUvMoodleDate(value) {
  const text = clean(value).toLowerCase();
  const match = text.match(
    /(\d{1,2})\s+de\s+([a-záéíóúüçñ]+)\s+de\s+(\d{4}),\s*(\d{1,2}):(\d{2})/i
  );
  if (!match) return null;
  const monthName = match[2].normalize('NFC');
  const month = SPANISH_MONTHS.get(monthName) ?? VALENCIAN_MONTHS.get(monthName);
  if (!month) return null;
  return zonedDateToIso({
    day: Number(match[1]),
    month,
    year: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  });
}

export function parseUvCourseRegistry(page) {
  if (!page || !Array.isArray(page.links)) throw new Error('uv_moodle_page_links_required');
  const courses = new Map();
  for (const link of page.links) {
    let url;
    try { url = urlOf(link.url); } catch { continue; }
    if (url.pathname !== '/course/view.php') continue;
    const id = url.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) continue;
    const name = clean(link.text).replace(/^Nombre del curso\s+/i, '');
    if (!name) continue;
    const codeMatch = name.match(/\((\d{5})\)\s*$/);
    const record = {
      id,
      url: url.toString(),
      name,
      code: codeMatch ? codeMatch[1] : null,
      academic: Boolean(codeMatch)
    };
    const existing = courses.get(id);
    if (!existing || record.name.length < existing.name.length) courses.set(id, record);
  }
  return [...courses.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export function parseUvVisiblePracticalGroups(page) {
  if (!page || typeof page !== 'object') throw new Error('uv_moodle_page_invalid');
  const sources = [String(page.text ?? '')];
  if (Array.isArray(page.links)) {
    sources.push(...page.links.map((link) => String(link?.text ?? '')));
  }
  const groups = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:Pr[aá]cticas?[^\n]{0,120})?\bSubgrupo\s+([A-Z])\s*-\s*P(\d+)\b/gi)) {
      groups.add(match[1].toUpperCase() + '-P' + match[2]);
    }
  }
  return [...groups].sort();
}

export function parseUvCourseActivities(page) {
  if (!page || !Array.isArray(page.links)) throw new Error('uv_moodle_page_links_required');
  const seen = new Set();
  const activities = [];
  for (const link of page.links) {
    let url;
    try { url = urlOf(link.url); } catch { continue; }
    const match = url.pathname.match(
      /^\/mod\/(assign|quiz|forum|resource|folder|page|book)\/view\.php$/
    );
    if (!match) continue;
    const id = url.searchParams.get('id') ?? url.searchParams.get('f');
    if (!id || !/^\d+$/.test(id)) continue;
    const key = match[1] + ':' + id;
    if (seen.has(key)) continue;
    seen.add(key);
    activities.push({
      id: key,
      type: match[1],
      url: url.toString(),
      title: clean(link.text).replace(/\s+(Tarea|Archivo|Carpeta|Foro)$/i, '')
    });
  }
  return activities;
}

function lineValue(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp('(?:^|\\n)' + label + ':?\\s*([^\\n]+)', 'im'));
    if (match) return clean(match[1]);
  }
  return null;
}

function assignmentInstructions(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim());
  const closeIndex = lines.findIndex((line) =>
    /^(Cierre|Tancament|Data de venciment):/i.test(line)
  );
  const stateIndex = lines.findIndex((line, index) =>
    index > closeIndex && /^(Estado de la entrega|Estat de la tramesa)/i.test(line)
  );
  if (closeIndex < 0 || stateIndex <= closeIndex + 1) return null;
  return clean(lines.slice(closeIndex + 1, stateIndex).filter(Boolean).join(' '))
    .slice(0, 3000) || null;
}

export function parseUvAssignmentPage(page, course) {
  const url = urlOf(page.url);
  if (url.pathname !== '/mod/assign/view.php') {
    throw new Error('uv_moodle_assignment_url_invalid');
  }
  const id = url.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) throw new Error('uv_moodle_assignment_id_invalid');
  const text = String(page.text ?? '');
  const close = lineValue(text, ['Cierre', 'Tancament', 'Data de venciment']);
  const open = lineValue(text, ['Apertura', 'Obertura']);
  const deliveryState = lineValue(text, ['Estado de la entrega', 'Estat de la tramesa']);
  const gradeState = lineValue(text, ['Estado de la calificación', 'Estat de la qualificació']);
  const submitted = /Enviado para calificar|Enviat per qualificar|Tramesa per qualificar|Calificado|Qualificat/i.test(
    [deliveryState, gradeState, text].filter(Boolean).join(' ')
  );
  const titleFromPage = clean(page.title)
    .replace(/\s*\|\s*AulaVirtual.*$/i, '')
    .replace(/^.*?:\s*/, '');
  return {
    id: 'uv:assign:' + id,
    providerId: id,
    subjectId: course.code ?? course.id,
    title: titleFromPage || clean(course.name) || 'Tarea',
    dueAt: close ? parseUvMoodleDate(close) : null,
    openAt: open ? parseUvMoodleDate(open) : null,
    status: submitted ? 'done' : 'open',
    deliveryState,
    gradeState,
    instructions: assignmentInstructions(text),
    url: url.toString()
  };
}

export function parseUvCalendarAssignmentLinks(page) {
  if (!page || !Array.isArray(page.links)) throw new Error('uv_moodle_page_links_required');
  const events = [];
  const seen = new Set();
  for (const link of page.links) {
    let url;
    try { url = urlOf(link.url); } catch { continue; }
    if (url.pathname !== '/mod/assign/view.php') continue;
    const id = url.searchParams.get('id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    events.push({
      providerId: id,
      url: url.toString(),
      title: clean(link.text).replace(/^(Venciment|Vencimiento)\s+de\s+/i, '')
    });
  }
  return events;
}

export function buildUvSnapshot({
  capturedAt,
  courses,
  assignments,
  materials = []
}) {
  const academic = courses.filter((course) => course.academic);
  const subjectIds = new Set(academic.map((course) => course.code));
  const snapshot = {
    version: 1,
    source: 'uv-aulavirtual',
    capturedAt,
    subjects: academic.map((course) => ({ id: course.code, name: course.name })),
    announcements: [],
    assignments: assignments
      .filter((assignment) => subjectIds.has(assignment.subjectId))
      .map((assignment) => ({
        id: assignment.id,
        subjectId: assignment.subjectId,
        title: assignment.title,
        dueAt: assignment.dueAt,
        status: assignment.status,
        url: assignment.url
      })),
    materials: materials
      .filter((material) => subjectIds.has(material.subjectId))
      .map((material) => ({
        id: material.id,
        subjectId: material.subjectId,
        title: material.title,
        publishedAt: material.firstSeenAt,
        url: material.url
      }))
  };
  return normalizeUniversitySnapshot(snapshot);
}
