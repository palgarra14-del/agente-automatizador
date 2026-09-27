import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWindowsUniversityBrowserBridge } from '../src/university-browser-windows.js';
import { detectUniversityChanges } from '../src/university.js';
import { planUniversityStudyDay } from '../src/university-study-planner.js';
import { formatUniversityDailyReport } from '../src/university-report.js';
import { recommendAcademicPreparation } from '../src/university-preparation.js';
import {
  createUvGradeState,
  diffUvGrades,
  parseUvGradeOverview
} from '../src/university-grades.js';
import {
  createUvNotificationState,
  diffUvNotifications,
  parseUvNotifications
} from '../src/university-notifications.js';
import {
  ACADEMIC_SIGNAL_STATE_VERSION,
  mergeAcademicSignals,
  selectAttentionAcademicSignals
} from '../src/university-signals.js';
import {
  buildAcademicProfile,
  mergeMailBody,
  selectRelevantAcademicMail,
  summarizeAcademicProfile
} from '../src/university-relevance.js';
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
const reportMarkdownFile = join(stateDir, 'uv-daily-report.md');
const profileFile = join(stateDir, 'uv-academic-profile.json');
const mailStateFile = join(stateDir, 'uv-mail-state.json');
const signalStateFile = join(stateDir, 'uv-academic-signals.json');
const gradeStateFile = join(stateDir, 'uv-grades.json');
const notificationStateFile = join(stateDir, 'uv-notifications.json');
const attentionFile = join(stateDir, 'uv-attention.json');
const gradeOverviewUrl = 'https://aulavirtual.uv.es/grade/report/overview/index.php';
const notificationsUrl = 'https://aulavirtual.uv.es/message/output/popup/notifications.php';

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

function academicSignalTasks(signals, materials, today) {
  return signals.flatMap((signal) => {
    if (!['assessment', 'coursework'].includes(signal.kind)) return [];
    const targetDate = (signal.dates ?? []).find((date) => date >= today);
    if (!targetDate) return [];
    const rawTitle = String(signal.title ?? 'Aviso académico');
    const shortTitle = rawTitle.includes(': ') ? rawTitle.split(': ').at(-1) : rawTitle;
    const assessment = signal.kind === 'assessment';
    const resources = recommendAcademicPreparation(signal, materials, {
      limit: assessment ? 3 : 2
    });
    return [{
      id: 'signal:' + signal.id,
      kind: 'academic_signal',
      subjectId: signal.subjectId,
      subject: signal.subject,
      title: (assessment ? 'Preparar: ' : 'Revisar: ') + shortTitle,
      targetDate,
      priority: assessment ? 980 : 760,
      reason: assessment ? 'Evaluación próxima detectada en correo UV' : 'Trabajo próximo detectado en correo UV',
      suggestedMinutes: assessment ? 50 : 35,
      resources
    }];
  }).sort((a, b) => b.priority - a.priority || a.targetDate.localeCompare(b.targetDate));
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

const MAIL_MONTHS = Object.freeze({
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
});

function recentAcademicMail(messages, capturedAt, maxAgeDays = 8) {
  const now = new Date(capturedAt);
  return messages.filter((message) => {
    const text = String(message?.relativeDate ?? '').trim();
    const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
    if (!match) return true;
    const month = MAIL_MONTHS[match[2].toLowerCase()];
    if (!Number.isInteger(month)) return true;
    const date = new Date(Date.UTC(2000 + Number(match[3]), month, Number(match[1]), 12));
    const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
    return ageDays >= -1 && ageDays <= maxAgeDays;
  });
}

function coursesWithObservedGroups(courses, observations) {
  const groups = new Map(
    (observations?.courseGroups ?? []).map((entry) => [entry.subjectId, entry.practicalGroups ?? []])
  );
  return courses.map((course) => {
    const observed = groups.get(course.code) ?? [];
    return {
      ...course,
      practicalGroups: observed.length === 1 ? observed : []
    };
  });
}

async function scanAcademicMail(bridge, courses, capturedAt, previousState) {
  const profile = buildAcademicProfile(courses);
  const pages = await bridge.listReadablePages();
  const mailPage = pages.find((item) => {
    try {
      return new URL(item.url).origin === 'https://sogo.uv.es';
    } catch {
      return false;
    }
  });
  if (!mailPage) {
    return {
      profile,
      status: 'mail_page_missing',
      alerts: [],
      state: previousState ?? { version: 1, seenIds: [] }
    };
  }

  const inbox = await bridge.scanMail(mailPage.id, { maxMessages: 160 });
  const scannedIds = inbox.messages
    .map((message) => /^\d+$/.test(String(message.uid)) ? 'uv-mail:' + message.uid : null)
    .filter(Boolean);
  const seenIds = previousState?.seenIds ?? scannedIds;
  const recentMessages = recentAcademicMail(inbox.messages, capturedAt);
  const candidates = selectRelevantAcademicMail(recentMessages, profile, { seenIds });
  const actionableCandidates = previousState
    ? candidates.filter((candidate) => candidate.isNew)
    : candidates;
  const alerts = [];
  for (const candidate of actionableCandidates.slice(0, 30)) {
    let alert = candidate;
    if (candidate.uid && candidate.needsBody && (candidate.unread || candidate.isNew)) {
      const full = await bridge.readMailMessage(mailPage.id, candidate.uid);
      if (full?.found) {
        if (full.wasRead === false && full.isRead !== false) {
          throw new Error('uv_mail_read_state_not_restored');
        }
        alert = mergeMailBody(candidate, full.body, profile);
      }
    }
    if (alert.decision !== 'ignore') alerts.push(alert);
  }
  const uniqueAlerts = [];
  const alertKeys = new Set();
  for (const alert of alerts) {
    const key = (alert.course?.subjectId ?? 'general') + '\n' + alert.subject.toLowerCase();
    if (alertKeys.has(key)) continue;
    alertKeys.add(key);
    uniqueAlerts.push(alert);
  }

  return {
    profile,
    status: 'ready',
    inbox: { total: inbox.total, unread: inbox.unread, scanned: inbox.messages.length },
    alerts: uniqueAlerts,
    state: {
      version: 1,
      capturedAt,
      seenIds: [...new Set([...scannedIds, ...(previousState?.seenIds ?? [])])].slice(0, 1000)
    }
  };
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);

const capturedAt = new Date().toISOString();
const bridge = createWindowsUniversityBrowserBridge({
  allowedOrigins: ['https://aulavirtual.uv.es', 'https://sogo.uv.es']
});
const registry = await loadOrBootstrapRegistry(bridge, capturedAt);
const previousObservations = await readJson(observationsFile);
const previousSnapshot = await readJson(snapshotFile);
const previousHistory = await readJson(historyFile, { version: 1, lastRecommendedByMaterial: {} });
const previousMailState = await readJson(mailStateFile);
const previousSignalState = await readJson(signalStateFile);
const previousGradeState = await readJson(gradeStateFile);
const previousNotificationState = await readJson(notificationStateFile);

const current = await scanUvMoodle({
  bridge,
  courses: registry.courses,
  capturedAt,
  previousObservations
});
const changes = previousSnapshot
  ? detectUniversityChanges(previousSnapshot, current.snapshot)
  : emptyChanges();
const academicCourses = coursesWithObservedGroups(registry.courses, current.observations);
const today = madridDay(capturedAt);
const dailyTarget = taskTarget();
let planned;

let mail;
try {
  mail = await scanAcademicMail(bridge, academicCourses, capturedAt, previousMailState);
} catch (error) {
  mail = {
    profile: buildAcademicProfile(academicCourses),
    status: 'degraded',
    error: String(error?.message || 'uv_mail_scan_failed').slice(0, 200),
    alerts: [],
    state: previousMailState ?? { version: 1, seenIds: [] }
  };
}

let signalMail = mail;
if (previousSignalState?.version !== ACADEMIC_SIGNAL_STATE_VERSION) {
  try {
    signalMail = await scanAcademicMail(bridge, academicCourses, capturedAt, null);
  } catch {
    signalMail = mail;
  }
}
const signalState = mergeAcademicSignals(previousSignalState, signalMail.alerts, { capturedAt });
const attentionSignals = selectAttentionAcademicSignals(signalState, {
  capturedAt,
  horizonDays: 14
});
const signalTasks = academicSignalTasks(attentionSignals, current.snapshot.materials, today).slice(0, dailyTarget);
const studySlots = Math.max(0, dailyTarget - signalTasks.length);
planned = studySlots > 0
  ? planUniversityStudyDay({
      snapshot: current.snapshot,
      changes,
      history: previousHistory,
      today,
      targetTasks: studySlots
    })
  : { tasks: [], history: previousHistory };
const finalTasks = [...signalTasks, ...planned.tasks].slice(0, dailyTarget);

let gradeStatus = 'ready';
let gradeError = null;
let gradeChanges = [];
let gradeState = previousGradeState;
try {
  const gradePage = await bridge.readUrl(gradeOverviewUrl);
  const grades = parseUvGradeOverview(gradePage, academicCourses);
  gradeChanges = diffUvGrades(previousGradeState, grades);
  gradeState = createUvGradeState(grades, capturedAt);
} catch (error) {
  gradeStatus = 'degraded';
  gradeError = String(error?.message || 'uv_grade_scan_failed').slice(0, 200);
}

let notificationStatus = 'ready';
let notificationError = null;
let notificationChanges = [];
let notificationState = previousNotificationState;
try {
  const notificationPage = await bridge.readUrl(notificationsUrl);
  const notifications = parseUvNotifications(notificationPage, academicCourses, { today });
  notificationChanges = diffUvNotifications(previousNotificationState, notifications);
  notificationState = createUvNotificationState(notifications, capturedAt);
} catch (error) {
  notificationStatus = 'degraded';
  notificationError = String(error?.message || 'uv_notification_scan_failed').slice(0, 200);
}

const profileSummary = summarizeAcademicProfile(mail.profile);
const subjectNames = new Map(profileSummary.map((item) => [item.subjectId, item.subject]));
const enrichedGradeChanges = gradeChanges.map((item) => ({
  ...item,
  subject: subjectNames.get(item.subjectId) ?? item.subjectId
}));

const attentionReasons = [];
const attentionItems = [];
const newMail = mail.alerts.filter((item) => item.isNew);
if (newMail.length) {
  attentionReasons.push('new_relevant_mail');
  attentionItems.push(...newMail.map((item) => item.id));
}
if (enrichedGradeChanges.length) {
  attentionReasons.push('grade_changed');
  attentionItems.push(...enrichedGradeChanges.map((item) => 'grade:' + item.subjectId + ':' + item.grade));
}
if (notificationChanges.length) {
  attentionReasons.push('new_relevant_notification');
  attentionItems.push(...notificationChanges.map((item) => item.id));
}
const changedAssignments = [...changes.assignments.added, ...changes.assignments.updated];
if (changedAssignments.length) {
  attentionReasons.push('assignment_changed');
  attentionItems.push(...changedAssignments.map((item) => 'assignment:' + item.id));
}
const attention = {
  version: 1,
  capturedAt,
  required: attentionItems.length > 0,
  reasons: attentionReasons,
  items: [...new Set(attentionItems)].sort()
};

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
    mailStatus: mail.status,
    mailScanned: mail.inbox?.scanned ?? 0,
    mailUnread: mail.inbox?.unread ?? null,
    relevantMail: mail.alerts.length,
    newRelevantMail: mail.alerts.filter((item) => item.isNew).length,
    activeAcademicSignals: signalState.signals.length,
    attentionAcademicSignals: attentionSignals.length,
    gradeStatus,
    changedGrades: enrichedGradeChanges.length,
    notificationStatus,
    newRelevantNotifications: notificationChanges.length,
    attentionRequired: attention.required,
    suggestedMinutes: finalTasks.reduce(
      (total, item) => total + (Number.isInteger(item.suggestedMinutes) ? item.suggestedMinutes : 0),
      0
    )
  },
  academicProfile: profileSummary,
  mailAlerts: mail.alerts,
  academicSignals: attentionSignals,
  gradeChanges: enrichedGradeChanges,
  gradeError,
  notificationChanges,
  notificationError,
  attention,
  tasks: finalTasks
};

await writePrivateJson(observationsFile, current.observations);
await writePrivateJson(snapshotFile, current.snapshot);
await writePrivateJson(historyFile, planned.history);
await writePrivateJson(profileFile, { version: 1, capturedAt, courses: summarizeAcademicProfile(mail.profile) });
await writePrivateJson(mailStateFile, mail.state);
await writePrivateJson(signalStateFile, signalState);
if (gradeState) await writePrivateJson(gradeStateFile, gradeState);
if (notificationState) await writePrivateJson(notificationStateFile, notificationState);
await writePrivateJson(attentionFile, attention);
await writePrivateJson(reportFile, report);
await writeFile(reportMarkdownFile, formatUniversityDailyReport(report), { mode: 0o600 });
await chmod(reportMarkdownFile, 0o600);
console.log(JSON.stringify(report, null, 2));
