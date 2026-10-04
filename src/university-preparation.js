function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function fold(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function focusNumbers(signal) {
  const text = fold([signal?.title, signal?.body].filter(Boolean).join(' '));
  const values = new Set();
  for (const match of text.matchAll(/\b(?:tema|practica|seminario|sesion|s)\s*[-_. ]?(\d{1,2})\b/g)) {
    values.add(Number(match[1]));
  }
  return [...values].filter((value) => value >= 0 && value <= 20);
}

function materialNumber(title) {
  const match = fold(title).match(/\b(?:tema|ejer(?:cicios?)?|pr(?:actica)?|seminario|sesion|s)\s*[-_. ]?(\d+)/);
  return match ? Number(match[1]) : null;
}

function kind(title) {
  const text = fold(title);
  if (/resuelt|solucion|correccion/.test(text)) return 'solution';
  if (/problema|ejercicio|\bejer\w*|\bpr(?:actica)?\s*[-_. ]?\d+|practica|seminario/.test(text)) return 'practice';
  if (/\btema\s*\d+|apuntes|clase|teoria/.test(text)) return 'theory';
  if (/examen|convocatoria|parcial/.test(text)) return 'exam';
  return 'reference';
}

function scoreMaterial(material, signal) {
  // Recommendations and deduplication require an explicit resource identity.
  if (typeof material?.id !== 'string' || !clean(material.id)) return null;
  // A missing or coerced title cannot establish useful preparation content.
  if (typeof material.title !== 'string' || !clean(material.title)) return null;
  // Missing or coerced identities cannot establish that a resource belongs to the course.
  if (typeof signal?.subjectId !== 'string' || !clean(signal.subjectId)) return null;
  if (typeof material?.subjectId !== 'string' || !clean(material.subjectId)) return null;
  if (clean(material?.subjectId) !== clean(signal?.subjectId)) return null;
  const title = clean(material.title);
  const lower = fold(title);
  let score = 100;
  const reasons = [];
  const focus = focusNumbers(signal);
  const number = materialNumber(title);
  const signalText = fold([signal?.title, signal?.body].filter(Boolean).join(' '));

  const matchesFocus = Boolean(focus.length && number !== null && focus.includes(number));
  if (focus.length && number !== null) {
    if (matchesFocus) {
      score += 420;
      reasons.push('mismo tema');
      if (new RegExp('^(?:tema\\s*' + number + '|ejer\\s*' + number + '|pr(?:actica)?\\s*' + number + '|s\\s*' + number + '\\b)', 'i').test(lower)) {
        score += 100;
      }
      if (/\bpractica\s*[-_. ]?\d{1,2}\b/.test(signalText) &&
          new RegExp('^pr(?:actica)?\\s*[-_. ]?' + number + '(?!\\d)', 'i').test(lower)) {
        score += 220;
        reasons.unshift('misma práctica');
      }
    } else {
      // Explicit topic mismatches cannot be outweighed by practice/solution bonuses.
      return null;
    }
  }
  if (/problema|ejercicio|\bejer\w*|\bpr(?:actica)?\s*[-_. ]?\d+/.test(lower)) {
    score += 100;
    reasons.push('práctica');
  }
  if (/\btema\s*\d+|apuntes|teoria/.test(lower)) {
    score += 90;
    reasons.push('teoría');
  }
  if (/resuelt|solucion|correccion/.test(lower)) {
    score += 35;
    reasons.push('comprobación');
  }
  if (/examen|convocatoria|parcial|años anteriores|anys anteriors/.test(lower)) {
    score += signal?.kind === 'assessment' && !focus.length ? 90 : -130;
  }
  if (/presentaci[oó]n|informaci[oó]n|normativa|gu[ií]a|manual|cheat|bibliograf/.test(lower)) {
    score -= 180;
  }

  return {
    material,
    score,
    matchesFocus,
    category: kind(title),
    reason: reasons.slice(0, 2).join(' + ') || 'material relacionado'
  };
}

export function recommendAcademicPreparation(signal, materials, { limit = 3 } = {}) {
  if (!signal || typeof signal !== 'object') throw new Error('academic_preparation_signal_invalid');
  if (!Array.isArray(materials)) throw new Error('academic_preparation_materials_invalid');
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('academic_preparation_limit_invalid');

  // Conflicting course or title evidence cannot establish a resource's relevance.
  const subjectsById = new Map();
  const titlesById = new Map();
  const ambiguousIds = new Set();
  for (const material of materials) {
    const subjectId = typeof material?.subjectId === 'string' ? clean(material.subjectId) : null;
    if (subjectsById.has(material?.id) && subjectsById.get(material?.id) !== subjectId) {
      ambiguousIds.add(material?.id);
    }
    subjectsById.set(material?.id, subjectId);
    const title = clean(material?.title);
    if (titlesById.has(material?.id) && titlesById.get(material?.id) !== title) {
      ambiguousIds.add(material?.id);
    }
    titlesById.set(material?.id, title);
  }

  let candidates = materials
    .filter((material) => !ambiguousIds.has(material?.id))
    .map((material) => scoreMaterial(material, signal))
    .filter((item) => item && item.score > 0)
    .sort((a, b) => b.score - a.score || a.material.title.localeCompare(b.material.title, 'es'));
  if (candidates.some((item) => item.matchesFocus)) {
    candidates = candidates.filter((item) => item.matchesFocus);
  }

  const selected = [];
  const used = new Set();
  const signalText = fold([signal?.title, signal?.body].filter(Boolean).join(' '));
  const categoryOrder = /\bpractica\s*[-_. ]?\d{1,2}\b/.test(signalText)
    ? ['practice', 'theory', 'solution']
    : ['theory', 'practice', 'solution'];
  for (const category of categoryOrder) {
    if (selected.length >= limit) break;
    const item = candidates.find((candidate) => candidate.category === category && !used.has(candidate.material.id));
    if (!item) continue;
    selected.push(item);
    used.add(item.material.id);
  }
  for (const item of candidates) {
    if (selected.length >= limit) break;
    if (used.has(item.material.id)) continue;
    selected.push(item);
    used.add(item.material.id);
  }

  return selected.map(({ material, category, reason }) => ({
    id: material.id,
    title: clean(material.title),
    url: clean(material.url),
    category,
    reason
  }));
}
