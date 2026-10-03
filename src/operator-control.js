const TRUE_VALUES = new Set(['1','true','yes','on','paused']);

export function globalPauseEnabled(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function parsePausedLanes(value, allowedLanes = []) {
  const allowed = new Set(allowedLanes);
  return [...new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item && allowed.has(item))
  )].sort();
}

export function applyOperatorControl(lanes, {
  globalPause = false,
  pausedLanes = []
} = {}) {
  if (globalPauseEnabled(globalPause)) return [];
  const paused = new Set(pausedLanes);
  return lanes.filter((lane) => !paused.has(lane));
}

export function serializePausedLanes(lanes = []) {
  return [...new Set(lanes.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].sort().join(',');
}
