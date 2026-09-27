function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function courseIdentity(course) {
  const name = clean(course?.name);
  const code = /^\d{5}$/.test(clean(course?.code))
    ? clean(course.code)
    : (name.match(/\((\d{5})\)\s*$/)?.[1] ?? '');
  const academicYear = name.match(/^(\d{4}-\d{2})\b/)?.[1] ?? null;
  if (!code || !academicYear) throw new Error('uv_grade_course_invalid');
  return { subjectId: code, academicYear, name };
}

export function parseUvGradeOverview(page, courses) {
  if (!page || typeof page.text !== 'string') throw new Error('uv_grade_page_invalid');
  if (!Array.isArray(courses) || !courses.length || courses.length > 40) {
    throw new Error('uv_grade_courses_invalid');
  }
  const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = [];

  for (const course of courses.map(courseIdentity)) {
    const marker = '(' + course.subjectId + ')';
    const line = lines.find((entry) => entry.includes(course.academicYear) && entry.includes(marker));
    if (!line) {
      records.push({ subjectId: course.subjectId, grade: null, available: false });
      continue;
    }
    const markerIndex = line.lastIndexOf(marker);
    const rawGrade = markerIndex >= 0 ? line.slice(markerIndex + marker.length).trim() : '';
    const grade = clean(rawGrade || '-').slice(0, 80);
    records.push({
      subjectId: course.subjectId,
      grade,
      available: grade !== '-' && grade !== ''
    });
  }

  return records.sort((a, b) => a.subjectId.localeCompare(b.subjectId));
}

export function diffUvGrades(previousState, currentGrades) {
  if (!Array.isArray(currentGrades) || currentGrades.length > 40) {
    throw new Error('uv_grade_current_invalid');
  }
  const previous = new Map(
    Array.isArray(previousState?.grades)
      ? previousState.grades.map((item) => [item.subjectId, item])
      : []
  );
  if (!previousState) return [];

  return currentGrades
    .filter((item) => {
      const before = previous.get(item.subjectId);
      return before && before.grade !== item.grade;
    })
    .map((item) => ({
      subjectId: item.subjectId,
      previousGrade: previous.get(item.subjectId)?.grade ?? null,
      grade: item.grade,
      available: item.available
    }))
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId));
}

export function createUvGradeState(grades, capturedAt) {
  if (!Array.isArray(grades) || Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('uv_grade_state_invalid');
  }
  return {
    version: 1,
    capturedAt,
    grades: grades.map((item) => ({
      subjectId: clean(item.subjectId),
      grade: item.grade === null ? null : clean(item.grade),
      available: item.available === true
    }))
  };
}
