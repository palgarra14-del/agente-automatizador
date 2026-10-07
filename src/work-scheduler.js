const BUSINESS_LANES = new Set(['callflow', 'leadfinder', 'website-pilot']);
const VALID_LANES = new Set(['self', ...BUSINESS_LANES]);

const BAND_SCORE = Object.freeze({
  operator: 400,
  business: 300,
  reliability: 200,
  maintenance: 100
});

const LANE_SCORE = Object.freeze({
  callflow: 30,
  leadfinder: 25,
  'website-pilot': 20,
  self: 0
});

function normalizeWork(item) {
  if (!item || typeof item.id !== 'string' || !item.id.trim()) throw new Error('work_item_id_invalid');
  if (!VALID_LANES.has(item.lane)) throw new Error('work_item_lane_invalid');
  const source = item.source ?? (item.lane === 'self' ? 'autonomous' : 'business');
  const band =
    item.operatorRequested === true || ['mobile', 'operator', 'human'].includes(source) ? 'operator' :
    BUSINESS_LANES.has(item.lane) ? 'business' :
    item.reliability === true ? 'reliability' :
    'maintenance';
  const createdAtMs = Number.isFinite(Date.parse(item.createdAt ?? ''))
    ? Date.parse(item.createdAt)
    : 0;
  return Object.freeze({
    ...item,
    source,
    band,
    createdAtMs,
    heavy: item.heavy !== false,
    blocked: Boolean(item.blocked),
    humanGate: Boolean(item.humanGate)
  });
}

function scoreWork(item) {
  const urgency = Number.isFinite(item.urgency) ? Math.max(0, Math.min(20, item.urgency)) : 0;
  const businessImpact = Number.isFinite(item.businessImpact)
    ? Math.max(0, Math.min(20, item.businessImpact))
    : 0;
  return BAND_SCORE[item.band] + LANE_SCORE[item.lane] + urgency + businessImpact;
}

export function rankWork(items = []) {
  if (!Array.isArray(items)) throw new Error('work_items_invalid');
  return items.map(normalizeWork).sort((left, right) =>
    scoreWork(right) - scoreWork(left) ||
    left.createdAtMs - right.createdAtMs ||
    left.id.localeCompare(right.id)
  );
}

export function planWork(items = [], {
  running = [],
  maxHeavy = 3,
  maxBusinessHeavy = 3,
  maxSelfHeavy = 1
} = {}) {
  if (!Number.isInteger(maxHeavy) || maxHeavy < 1) throw new Error('max_heavy_invalid');
  if (!Number.isInteger(maxBusinessHeavy) || maxBusinessHeavy < 1 || maxBusinessHeavy > maxHeavy) {
    throw new Error('max_business_heavy_invalid');
  }
  if (!Number.isInteger(maxSelfHeavy) || maxSelfHeavy < 0 || maxSelfHeavy > maxHeavy) {
    throw new Error('max_self_heavy_invalid');
  }

  const normalizedRunning = running.map(normalizeWork);
  let heavy = normalizedRunning.filter((item) => item.heavy).length;
  let businessHeavy = normalizedRunning.filter((item) => item.heavy && BUSINESS_LANES.has(item.lane)).length;
  let selfHeavy = normalizedRunning.filter((item) => item.heavy && item.lane === 'self').length;
  const selected = [];
  const deferred = [];
  const ranked = rankWork(items);

  for (const item of ranked) {
    if (item.blocked || item.humanGate) {
      deferred.push({ item, reason: item.humanGate ? 'human_gate' : 'blocked' });
      continue;
    }
    if (!item.heavy) {
      selected.push(item);
      continue;
    }
    if (heavy >= maxHeavy) {
      deferred.push({ item, reason: 'global_capacity' });
      continue;
    }
    if (BUSINESS_LANES.has(item.lane) && businessHeavy >= maxBusinessHeavy) {
      deferred.push({ item, reason: 'business_capacity' });
      continue;
    }
    if (item.lane === 'self' && selfHeavy >= maxSelfHeavy) {
      deferred.push({ item, reason: 'self_capacity' });
      continue;
    }

    selected.push(item);
    heavy += 1;
    if (BUSINESS_LANES.has(item.lane)) businessHeavy += 1;
    if (item.lane === 'self') selfHeavy += 1;
  }

  const waitingPriorityWork = deferred.find(({ item, reason }) =>
    reason === 'global_capacity' &&
    (item.band === 'operator' || BUSINESS_LANES.has(item.lane))
  );
  const yieldCandidates = waitingPriorityWork
    ? normalizedRunning
        .filter((item) => item.lane === 'self' && item.heavy)
        .sort((a, b) => scoreWork(a) - scoreWork(b) || a.createdAtMs - b.createdAtMs)
        .map((item) => ({
          id: item.id,
          lane: item.lane,
          reason: waitingPriorityWork.item.band === 'operator'
            ? 'yield_at_next_safe_checkpoint_for_operator_work'
            : 'yield_at_next_safe_checkpoint_for_business_work'
        }))
    : [];

  return {
    version: 1,
    limits: { maxHeavy, maxBusinessHeavy, maxSelfHeavy },
    running: normalizedRunning,
    ranking: ranked.map((item, index) => ({
      rank: index + 1,
      id: item.id,
      lane: item.lane,
      band: item.band,
      score: scoreWork(item),
      blocked: item.blocked,
      humanGate: item.humanGate
    })),
    selected,
    deferred,
    yieldCandidates
  };
}

export function schedulingPolicySnapshot() {
  return {
    version: 1,
    priorityBands: BAND_SCORE,
    laneWeights: LANE_SCORE,
    businessLanes: [...BUSINESS_LANES].sort(),
    principles: [
      'operator work outranks autonomous work',
      'runnable work is re-ranked from current evidence at every dispatch boundary',
      'business throughput outranks self-improvement',
      'self-improvement consumes only spare capacity after runnable business work',
      'human gates never block independent runnable work',
      'running work yields only at a safe checkpoint'
    ]
  };
}
