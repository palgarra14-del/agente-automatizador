import { createHash } from 'node:crypto';

export const UNIVERSITY_STATE_VERSION = 1;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const itemKinds = ['announcements', 'assignments', 'materials'];
const forbiddenKeys = new Set(['password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'cookie', 'cookies', 'authorization', 'credentials']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`university_${label}_invalid`);
  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (forbiddenKeys.has(normalizedKey)) throw new Error('university_secret_material_forbidden');
  }
  return value;
}

function textValue(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`university_${label}_invalid`);
  }
  return value.trim();
}

function timestamp(value, label) {
  const normalized = textValue(value, label, 40);
  if (!isoDateTime.test(normalized) || Number.isNaN(Date.parse(normalized))) throw new Error(`university_${label}_invalid`);
  return normalized;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return timestamp(value, label);
}

function safeUrl(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = textValue(value, label, 2_000);
  let url;
  try { url = new URL(normalized); } catch { throw new Error(`university_${label}_invalid`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`university_${label}_unsafe`);
  return url.toString();
}

function uniqueById(items, label, max) {
  if (!Array.isArray(items) || items.length > max) throw new Error(`university_${label}_invalid`);
  const seen = new Set();
  const normalized = [];
  for (const [index, item] of items.entries()) {
    const value = item(index);
    if (seen.has(value.id)) throw new Error(`university_${label}_duplicate_id`);
    seen.add(value.id);
    normalized.push(value);
  }
  return normalized;
}

function normalizeSubjects(value) {
  const raw = Array.isArray(value) ? value : [];
  return uniqueById(raw.map((entry) => (index) => {
    const item = assertObject(entry, `subject_${index}`);
    return { id: textValue(item.id, 'subject_id', 120), name: textValue(item.name, 'subject_name', 240) };
  }), 'subjects', 40);
}

function normalizeAnnouncement(entry, index, subjectIds) {
  const item = assertObject(entry, `announcement_${index}`);
  const subjectId = textValue(item.subjectId, 'announcement_subject_id', 120);
  if (!subjectIds.has(subjectId)) throw new Error('university_announcement_unknown_subject');
  return {
    id: textValue(item.id, 'announcement_id', 160),
    subjectId,
    title: textValue(item.title, 'announcement_title', 500),
    publishedAt: timestamp(item.publishedAt, 'announcement_published_at'),
    url: safeUrl(item.url, 'announcement_url')
  };
}

function normalizeAssignment(entry, index, subjectIds) {
  const item = assertObject(entry, `assignment_${index}`);
  const subjectId = textValue(item.subjectId, 'assignment_subject_id', 120);
  if (!subjectIds.has(subjectId)) throw new Error('university_assignment_unknown_subject');
  const status = item.status ?? 'open';
  if (!['open', 'done'].includes(status)) throw new Error('university_assignment_status_invalid');
  return {
    id: textValue(item.id, 'assignment_id', 160),
    subjectId,
    title: textValue(item.title, 'assignment_title', 500),
    dueAt: optionalTimestamp(item.dueAt, 'assignment_due_at'),
    status,
    url: safeUrl(item.url, 'assignment_url')
  };
}

function normalizeMaterial(entry, index, subjectIds) {
  const item = assertObject(entry, `material_${index}`);
  const subjectId = textValue(item.subjectId, 'material_subject_id', 120);
  if (!subjectIds.has(subjectId)) throw new Error('university_material_unknown_subject');
  return {
    id: textValue(item.id, 'material_id', 160),
    subjectId,
    title: textValue(item.title, 'material_title', 500),
    publishedAt: timestamp(item.publishedAt, 'material_published_at'),
    url: safeUrl(item.url, 'material_url')
  };
}

export function normalizeUniversitySnapshot(input) {
  const value = assertObject(input, 'snapshot');
  if (value.version !== UNIVERSITY_STATE_VERSION) throw new Error('university_snapshot_version_invalid');
  const subjects = normalizeSubjects(value.subjects);
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const announcements = uniqueById((value.announcements ?? []).map((entry) => (index) => normalizeAnnouncement(entry, index, subjectIds)), 'announcements', 200);
  const assignments = uniqueById((value.assignments ?? []).map((entry) => (index) => normalizeAssignment(entry, index, subjectIds)), 'assignments', 200);
  const materials = uniqueById((value.materials ?? []).map((entry) => (index) => normalizeMaterial(entry, index, subjectIds)), 'materials', 400);
  return {
    version: UNIVERSITY_STATE_VERSION,
    source: textValue(value.source, 'source', 160),
    capturedAt: timestamp(value.capturedAt, 'captured_at'),
    subjects,
    announcements,
    assignments,
    materials
  };
}

function fingerprint(value) {
  const canonical = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function diffCollection(previous, current) {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  return {
    added: current.filter((item) => !before.has(item.id)),
    updated: current.filter((item) => before.has(item.id) && fingerprint(before.get(item.id)) !== fingerprint(item)),
    removed: previous.filter((item) => !after.has(item.id))
  };
}

export function detectUniversityChanges(previousInput, currentInput) {
  const current = normalizeUniversitySnapshot(currentInput);
  if (previousInput === null || previousInput === undefined) {
    return Object.fromEntries(itemKinds.map((kind) => [kind, { added: current[kind], updated: [], removed: [] }]));
  }
  const previous = normalizeUniversitySnapshot(previousInput);
  if (previous.source !== current.source) throw new Error('university_snapshot_source_changed');
  return Object.fromEntries(itemKinds.map((kind) => [kind, diffCollection(previous[kind], current[kind])]));
}

function dayDistance(today, dueAt) {
  if (!dueAt) return null;
  const base = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((Date.parse(dueAt) - base) / 86_400_000);
}

function assignmentPriority(assignment, today) {
  const days = dayDistance(today, assignment.dueAt);
  if (days === null) return { score: 500, reason: 'Sin fecha: conviene planificarla' };
  if (days < 0) return { score: 1_000 + Math.min(100, Math.abs(days)), reason: 'Entrega vencida' };
  if (days === 0) return { score: 950, reason: 'Entrega hoy' };
  if (days <= 2) return { score: 850 - days, reason: `Entrega en ${days} día${days === 1 ? '' : 's'}` };
  if (days <= 7) return { score: 700 - days, reason: `Entrega esta semana (${days} días)` };
  return { score: 400 - Math.min(days, 300), reason: `Entrega en ${days} días` };
}

export function planUniversityDay(snapshotInput, changesInput, { today, maxTasks = 20 } = {}) {
  const snapshot = normalizeUniversitySnapshot(snapshotInput);
  if (typeof today !== 'string' || !isoDate.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`))) throw new Error('university_today_invalid');
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 50) throw new Error('university_max_tasks_invalid');
  const subjects = new Map(snapshot.subjects.map((subject) => [subject.id, subject.name]));
  const changes = changesInput ?? detectUniversityChanges(null, snapshot);
  const tasks = [];

  for (const assignment of snapshot.assignments.filter((item) => item.status === 'open')) {
    const priority = assignmentPriority(assignment, today);
    tasks.push({
      id: `assignment:${assignment.id}`, kind: 'assignment', subjectId: assignment.subjectId,
      subject: subjects.get(assignment.subjectId), title: assignment.title, dueAt: assignment.dueAt,
      url: assignment.url, priority: priority.score, reason: priority.reason
    });
  }
  for (const item of changes.announcements?.added ?? []) {
    tasks.push({ id: `announcement:${item.id}`, kind: 'announcement', subjectId: item.subjectId, subject: subjects.get(item.subjectId), title: item.title, dueAt: null, url: item.url, priority: 620, reason: 'Aviso nuevo: revisar' });
  }
  for (const item of changes.materials?.added ?? []) {
    tasks.push({ id: `material:${item.id}`, kind: 'material', subjectId: item.subjectId, subject: subjects.get(item.subjectId), title: item.title, dueAt: null, url: item.url, priority: 520, reason: 'Material nuevo: revisar' });
  }
  return tasks.sort((a, b) => b.priority - a.priority || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title)).slice(0, maxTasks);
}

export function createUniversityReadOnlyAdapter({ source, readSnapshot }) {
  const sourceId = textValue(source, 'adapter_source', 160);
  if (typeof readSnapshot !== 'function') throw new Error('university_adapter_reader_invalid');
  return Object.freeze({
    source: sourceId,
    async read() {
      const snapshot = normalizeUniversitySnapshot(await readSnapshot());
      if (snapshot.source !== sourceId) throw new Error('university_adapter_source_mismatch');
      return snapshot;
    }
  });
}
