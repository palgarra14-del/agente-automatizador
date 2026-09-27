import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWindowsUniversityBrowserBridge } from '../src/university-browser-windows.js';
import { detectUniversityChanges } from '../src/university.js';
import { planUniversityStudyDay } from '../src/university-study-planner.js';
import { parseUvCourseRegistry } from '../src/uv-moodle.js';
import { scanUvMoodle } from '../src/uv-moodle-scanner.js';

const stateDir = resolve(
  process.env.UNIVERSITY_STATE_DIR ??
  join(homedir(), '.local', 'state', 'engineering-orchestrator', 'university')
);
const registryFile = join(stateDir, 'uv-registry.json');
const observationsFile = join(stateDir, 'uv-observations.json');
const snapshotFile = join(stateDir, 'uv-snapshot.json');
const historyFile = join(stateDir, 'uv-study-history.json');
const reportFile = join(stateDir, 'uv-daily-report.json');

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

function emptyChanges() {
  return {
    announcements: { added: [], updated: [], removed: [] },
    assignments: { added: [], updated: [], removed: [] },
    materials: { added: [], updated: [], removed: [] }
  };
}

function madridDay(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return values.year + '-' + values.month + '-' + values.day;
}

function taskTarget() {
  const raw = process.env.UNIVERSITY_DAILY_TASK_TARGET ?? '6';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('UNIVERSITY_DAILY_TASK_TARGET must be an integer from 1 to 20');
  }
  return value;
}

async function loadOrBootstrapRegistry(bridge, capturedAt) {
  const existing = await readJson(registryFile);
  if (
    existing?.version === 1 &&
    Array.isArray(existing.courses) &&
    existing.courses.length
  ) {
    return existing;
  }

  const pages = await bridge.listReadablePages();
  const page = pages.find((item) => {
    try {
      return new URL(item.url).origin === 'https://aulavirtual.uv.es';
    } catch {
      return false;
    }
  });
  if (!page) throw new Error('uv_registry_browser_page_missing');

  const dashboard = await bridge.readPage(page.id);
  const courses = parseUvCourseRegistry(dashboard).filter((course) => course.academic);
  if (!courses.length) {
    throw new Error('uv_registry_bootstrap_requires_loaded_course_dashboard');
  }

  const registry = {
    version: 1,
    source: 'uv-aulavirtual',
    capturedAt,
    courses
  };
  await writePrivateJson(registryFile, registry);
  return registry;
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);

const capturedAt = new Date().toISOString();
const bridge = createWindowsUniversityBrowserBridge({
  allowedOrigins: ['https://aulavirtual.uv.es']
});
const registry = await loadOrBootstrapRegistry(bridge, capturedAt);
const previousObservations = await readJson(observationsFile);
const previousSnapshot = await readJson(snapshotFile);
const previousHistory = await readJson(historyFile, { version: 1, lastRecommendedByMaterial: {} });

const current = await scanUvMoodle({
  bridge,
  courses: registry.courses,
  capturedAt,
  previousObservations
});
const changes = previousSnapshot
  ? detectUniversityChanges(previousSnapshot, current.snapshot)
  : emptyChanges();
const today = madridDay(capturedAt);
const planned = planUniversityStudyDay({
  snapshot: current.snapshot,
  changes,
  history: previousHistory,
  today,
  targetTasks: taskTarget()
});

const report = {
  version: 1,
  source: 'uv-aulavirtual',
  capturedAt,
  today,
  bootstrap: previousSnapshot === null,
  summary: {
    subjects: current.snapshot.subjects.length,
    assignments: current.snapshot.assignments.length,
    openAssignments: current.snapshot.assignments.filter((item) => item.status === 'open').length,
    materials: current.snapshot.materials.length,
    newMaterials: changes.materials.added.length,
    changedAssignments: changes.assignments.added.length + changes.assignments.updated.length,
    suggestedMinutes: planned.tasks.reduce(
      (total, item) => total + (Number.isInteger(item.suggestedMinutes) ? item.suggestedMinutes : 0),
      0
    )
  },
  tasks: planned.tasks
};

await writePrivateJson(observationsFile, current.observations);
await writePrivateJson(snapshotFile, current.snapshot);
await writePrivateJson(historyFile, planned.history);
await writePrivateJson(reportFile, report);
console.log(JSON.stringify(report, null, 2));
