import {
  buildUvSnapshot,
  parseUvAssignmentPage,
  parseUvCalendarAssignmentLinks,
  parseUvCourseActivities,
  parseUvVisiblePracticalGroups
} from './uv-moodle.js';

const UV_ORIGIN = 'https://aulavirtual.uv.es';
const HOME_URL = UV_ORIGIN + '/my/courses.php';
const CALENDAR_URL = UV_ORIGIN + '/calendar/view.php?view=month';
const MATERIAL_TYPES = new Set(['resource', 'folder', 'page', 'book']);

function courseList(value) {
  if (!Array.isArray(value) || !value.length || value.length > 40) {
    throw new Error('uv_scanner_courses_invalid');
  }
  const seen = new Set();
  return value.map((course) => {
    if (!course || typeof course !== 'object') throw new Error('uv_scanner_course_invalid');
    const id = String(course.id ?? '');
    const code = String(course.code ?? '');
    const name = String(course.name ?? '').trim();
    const url = String(course.url ?? '');
    if (!/^\d+$/.test(id) || !/^\d{5}$/.test(code) || !name || name.length > 300) {
      throw new Error('uv_scanner_course_invalid');
    }
    const parsed = new URL(url);
    if (
      parsed.origin !== UV_ORIGIN ||
      parsed.pathname !== '/course/view.php' ||
      parsed.searchParams.get('id') !== id
    ) {
      throw new Error('uv_scanner_course_url_invalid');
    }
    if (seen.has(code)) throw new Error('uv_scanner_course_duplicate');
    seen.add(code);
    return { id, code, name, url: parsed.toString(), academic: true };
  });
}

function authenticatedPage(page) {
  let url;
  try { url = new URL(page.url); } catch { throw new Error('uv_scanner_page_invalid'); }
  const text = String(page.text ?? '');
  if (
    url.origin !== UV_ORIGIN ||
    url.pathname.startsWith('/login/') ||
    /Inicia sesión|Usuaris de la Universitat|Usuarios de la Universidad/i.test(text)
  ) {
    throw new Error('uv_scanner_session_expired');
  }
  return page;
}

function taskCourseFromPage(page, courses) {
  const haystack = [page.title, page.text].filter(Boolean).join('\n');
  const match = haystack.match(/\((\d{5})\)/);
  if (!match) return null;
  return courses.find((course) => course.code === match[1]) ?? null;
}

function materialRecord(activity, course, capturedAt, previousById) {
  const id = 'uv:' + activity.id;
  return {
    id,
    subjectId: course.code,
    title: activity.title || activity.type,
    url: activity.url,
    firstSeenAt: previousById.get(id)?.firstSeenAt ?? capturedAt
  };
}

export async function scanUvMoodle({
  bridge,
  courses: rawCourses,
  capturedAt = new Date().toISOString(),
  previousObservations = null
} = {}) {
  if (
    !bridge ||
    typeof bridge.listReadablePages !== 'function' ||
    typeof bridge.navigatePage !== 'function'
  ) {
    throw new Error('uv_scanner_bridge_invalid');
  }
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error('uv_scanner_captured_at_invalid');

  const courses = courseList(rawCourses);
  const previousById = new Map(
    (previousObservations?.materials ?? []).map((item) => [item.id, item])
  );
  const pages = await bridge.listReadablePages();
  const target = pages.find((page) => {
    try { return new URL(page.url).origin === UV_ORIGIN; } catch { return false; }
  });
  if (!target) throw new Error('uv_scanner_browser_page_missing');

  const materialMap = new Map();
  const assignmentTargets = new Map();
  const courseActivityCounts = [];
  const courseGroups = [];

  try {
    for (const course of courses) {
      const page = authenticatedPage(await bridge.navigatePage(target.id, course.url));
      const activities = parseUvCourseActivities(page);
      courseActivityCounts.push({ subjectId: course.code, count: activities.length });
      courseGroups.push({
        subjectId: course.code,
        practicalGroups: parseUvVisiblePracticalGroups(page)
      });

      for (const activity of activities) {
        if (MATERIAL_TYPES.has(activity.type)) {
          const material = materialRecord(activity, course, capturedAt, previousById);
          materialMap.set(material.id, material);
        }
        if (activity.type === 'assign') {
          assignmentTargets.set(activity.url, { url: activity.url, course });
        }
      }
    }

    const calendar = authenticatedPage(
      await bridge.navigatePage(target.id, CALENDAR_URL)
    );
    for (const event of parseUvCalendarAssignmentLinks(calendar)) {
      if (!assignmentTargets.has(event.url)) {
        assignmentTargets.set(event.url, { url: event.url, course: null });
      }
    }

    const assignments = [];
    for (const task of assignmentTargets.values()) {
      const page = authenticatedPage(await bridge.navigatePage(target.id, task.url));
      const course = task.course ?? taskCourseFromPage(page, courses);
      if (!course) continue;
      assignments.push(parseUvAssignmentPage(page, course));
    }

    const materials = [...materialMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const observations = {
      version: 1,
      source: 'uv-aulavirtual',
      capturedAt,
      materials,
      courseActivityCounts: courseActivityCounts.sort((a, b) =>
        a.subjectId.localeCompare(b.subjectId)
      ),
      courseGroups: courseGroups.sort((a, b) => a.subjectId.localeCompare(b.subjectId))
    };

    return {
      snapshot: buildUvSnapshot({ capturedAt, courses, assignments, materials }),
      observations
    };
  } finally {
    try {
      await bridge.navigatePage(target.id, HOME_URL);
    } catch {
      // Restoration is best-effort; scan failures must preserve their original cause.
    }
  }
}

export { HOME_URL as UV_HOME_URL };
