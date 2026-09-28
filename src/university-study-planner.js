import { planUniversityDay } from './university.js';
import { recommendAcademicPreparation } from './university-preparation.js';

function dayNumber(value) {
  const parsed = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(parsed)) throw new Error('university_study_today_invalid');
  return Math.floor(parsed / 86_400_000);
}

function daysSince(today, earlier) {
  if (!earlier) return null;
  const parsed = Date.parse(String(earlier) + 'T00:00:00Z');
  if (Number.isNaN(parsed)) return null;
  return dayNumber(today) - Math.floor(parsed / 86_400_000);
}

function numericTopic(title) {
  const match = title.match(/(?:tema|ejer|pr[aá]ctica|seminario|s)\s*[-_. ]?(\d+)/i);
  return match ? Math.min(Number(match[1]), 20) : 0;
}

function materialScore(material, addedIds, history, today) {
  const title = String(material.title ?? '').trim();
  const lower = title.toLowerCase();
  let score = 100;
  const reasons = [];

  if (addedIds.has(material.id)) {
    score += 220;
    reasons.push('material nuevo');
  }
  if (/problemas|ejercicios|\bejer\w*|pr[aá]ctica|seminario/i.test(title)) {
    score += 120;
    reasons.push('práctica o problemas');
  }
  if (/\btema\s*\d+|apuntes|clase\s+\d/i.test(title)) {
    score += 70;
    reasons.push('contenido de tema');
  }
  if (/correcci[oó]n/i.test(title)) {
    score += 80;
    reasons.push('corrección próxima');
  }
  if (/2026/.test(title)) score += 15;
  score += numericTopic(title) * 8;

  if (/resueltos|soluciones/i.test(title)) score -= 90;
  if (/examen|convocatoria|años anteriores|anys anteriors|e20(24|25)|2024-2025|2025-2026/i.test(lower)) {
    score -= 260;
  }
  if (/presentaci[oó]n|informaci[oó]n|normativa|gu[ií]a|manual|cheat|bibliograf/i.test(lower)) {
    score -= 90;
  }

  const last = history?.lastRecommendedByMaterial?.[material.id] ?? null;
  const age = daysSince(today, last);
  if (age !== null && age <= 1) score -= 600;
  else if (age !== null && age <= 3) score -= 260;
  else if (age !== null && age <= 7) score -= 100;

  let reason = reasons[0] ?? 'material activo del curso';
  if (reasons.length > 1) reason = reasons.slice(0, 2).join(' + ');
  return { score, reason };
}

function suggestedMinutes(title) {
  if (/problemas|ejercicios|\bejer\w*|pr[aá]ctica|seminario/i.test(title)) return 45;
  if (/\btema\s*\d+|apuntes|clase/i.test(title)) return 35;
  return 25;
}

export function planUniversityStudyDay({
  snapshot,
  changes,
  history = {},
  today,
  targetTasks = 6
} = {}) {
  if (!Number.isInteger(targetTasks) || targetTasks < 1 || targetTasks > 20) {
    throw new Error('university_study_target_invalid');
  }
  dayNumber(today);

  const mandatory = planUniversityDay(snapshot, changes, { today, maxTasks: targetTasks }).map((task) => {
    if (task.kind !== 'assignment') return task;
    const resources = recommendAcademicPreparation({
      subjectId: task.subjectId,
      title: task.title,
      kind: 'coursework'
    }, snapshot.materials, { limit: 2 });
    return resources.length ? { ...task, resources } : task;
  });
  if (mandatory.length >= targetTasks) {
    return {
      tasks: mandatory.slice(0, targetTasks),
      history: {
        ...history,
        version: 1,
        lastPlannedDay: today,
        lastRecommendedByMaterial: { ...(history.lastRecommendedByMaterial ?? {}) }
      }
    };
  }

  const subjectNames = new Map(snapshot.subjects.map((item) => [item.id, item.name]));
  const addedIds = new Set((changes?.materials?.added ?? []).map((item) => item.id));
  const alreadyUsed = new Set(
    mandatory
      .filter((item) => item.kind === 'material' && String(item.id).startsWith('material:'))
      .map((item) => String(item.id).slice('material:'.length))
  );
  const candidates = snapshot.materials
    .filter((material) => !alreadyUsed.has(material.id))
    .map((material) => {
      const scored = materialScore(material, addedIds, history, today);
      return { material, ...scored };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      a.material.subjectId.localeCompare(b.material.subjectId) ||
      a.material.title.localeCompare(b.material.title, 'es')
    );

  const selected = [];
  const selectedIds = new Set();
  const selectedSubjects = new Set();
  const slots = targetTasks - mandatory.length;

  for (const candidate of candidates) {
    if (selected.length >= slots) break;
    if (selectedSubjects.has(candidate.material.subjectId)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.material.id);
    selectedSubjects.add(candidate.material.subjectId);
  }
  for (const candidate of candidates) {
    if (selected.length >= slots) break;
    if (selectedIds.has(candidate.material.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.material.id);
  }

  const studyTasks = selected.map(({ material, score, reason }) => ({
    id: 'study:' + material.id,
    kind: 'study',
    subjectId: material.subjectId,
    subject: subjectNames.get(material.subjectId) ?? material.subjectId,
    title: 'Trabajar: ' + material.title,
    dueAt: null,
    url: material.url,
    priority: 300 + Math.max(0, score),
    reason,
    suggestedMinutes: suggestedMinutes(material.title)
  }));

  const lastRecommendedByMaterial = { ...(history.lastRecommendedByMaterial ?? {}) };
  for (const item of selected) lastRecommendedByMaterial[item.material.id] = today;

  return {
    tasks: [...mandatory, ...studyTasks],
    history: {
      version: 1,
      lastPlannedDay: today,
      lastRecommendedByMaterial
    }
  };
}
