import { defaultToolSkillRegistry } from './capabilities.js';
import { defaultSpecialistRegistry } from './specialists.js';

const DESIRED_SKILLS = Object.freeze({
  self: Object.freeze(['research.web', 'business.analyze', 'visual.review', 'data.inspect', 'data.analyze', 'data.summarize']),
  leadfinder: Object.freeze(['research.web', 'data.inspect', 'data.analyze', 'data.summarize']),
  callflow: Object.freeze(['data.inspect', 'data.analyze', 'data.summarize']),
  'website-pilot': Object.freeze(['visual.review', 'research.web'])
});

const FAILURE_CLASSES = Object.freeze([
  ['github-state', /(cloud_state|github_request_failed|secondary rate limit|rate limit|403)/i],
  ['runtime-timeout', /(timeout|deadline|timed out)/i],
  ['workspace', /(workspace|clone|bootstrap|install)/i],
  ['model-availability', /(billing|quota|credit|auth|api[_-]?key|provider.*unavailable|model.*unavailable)/i],
  ['verification', /(test|lint|build|verification|typecheck|ci_failed)/i],
  ['human-gate', /(human_gate|approval|required)/i]
]);

function failureClass(error) {
  const value = String(error ?? '');
  return FAILURE_CLASSES.find(([, pattern]) => pattern.test(value))?.[0] ?? (value ? 'other' : null);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function clip(value, max = 900) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function unavailableDesiredSkills(project, capabilityRegistry) {
  const desired = DESIRED_SKILLS[project?.id] ?? [];
  return desired.flatMap((skillId) => {
    const resolved = capabilityRegistry.resolve(project, skillId, { surface: 'workflow' });
    return resolved.available ? [] : [{
      skillId,
      reason: resolved.reason ?? 'unavailable',
      actionable: false
    }];
  });
}

function reservedSpecialistsForSkills(skillIds, specialistRegistry) {
  const wanted = new Set(skillIds);
  return specialistRegistry.snapshot()
    .filter((specialist) => specialist.mode === 'reserved' && specialist.skills.some((skill) => wanted.has(skill)))
    .map((specialist) => specialist.id)
    .sort();
}

export class AutonomousGapIntelligence {
  constructor({
    project,
    capabilityRegistry = defaultToolSkillRegistry,
    specialistRegistry = defaultSpecialistRegistry
  } = {}) {
    if (!project?.id) throw new Error('autonomous_gap_intelligence_project_required');
    this.project = project;
    this.capabilityRegistry = capabilityRegistry;
    this.specialistRegistry = specialistRegistry;
  }

  analyze({ history = [], recentProposalPaths = [] } = {}) {
    const recent = Array.isArray(history) ? history.slice(-12) : [];
    const failures = recent.filter((entry) => entry?.status !== 'completed');
    const classes = failures.map((entry) => failureClass(entry?.error)).filter(Boolean);
    const classCounts = countBy(classes);
    const completed = recent.filter((entry) => entry?.status === 'completed');
    const pathCounts = countBy(completed.flatMap((entry) => Array.isArray(entry?.changedPaths) ? entry.changedPaths : []));
    const repeatedPaths = [...pathCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);

    const signals = [];
    for (const [kind, count] of [...classCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      signals.push({
        kind: `reliability:${kind}`,
        score: 70 + Math.min(24, count * 6),
        actionable: true,
        evidence: `${count} recent non-successful cycle(s) classified as ${kind}`
      });
    }

    if (recent.length >= 3 && completed.length === 0) {
      signals.push({
        kind: 'throughput:no-recent-success',
        score: 68,
        actionable: true,
        evidence: `0 successful autonomous cycles across the last ${recent.length} recorded outcomes`
      });
    } else if (recent.length >= 6 && completed.length / recent.length < 0.4) {
      signals.push({
        kind: 'throughput:low-success-rate',
        score: 58,
        actionable: true,
        evidence: `${completed.length}/${recent.length} recent autonomous cycles completed successfully`
      });
    }

    if (repeatedPaths.length) {
      signals.push({
        kind: 'learning:local-minimum',
        score: 34,
        actionable: true,
        evidence: `recent successful changes repeatedly touched ${repeatedPaths.map(([path, count]) => `${path}×${count}`).join(', ')}`
      });
    }

    const missingSkills = unavailableDesiredSkills(this.project, this.capabilityRegistry);
    if (missingSkills.length) {
      signals.push({
        kind: 'capability:missing',
        score: 28,
        actionable: false,
        evidence: `desired but unavailable workflow skills: ${missingSkills.map((item) => `${item.skillId}(${item.reason})`).join(', ')}`,
        skills: missingSkills.map((item) => item.skillId),
        specialists: reservedSpecialistsForSkills(missingSkills.map((item) => item.skillId), this.specialistRegistry)
      });
    }

    if (!signals.length) {
      signals.push({
        kind: 'continuous-improvement:opportunity',
        score: 20,
        actionable: true,
        evidence: 'no dominant recent failure class; inspect current business flow for the highest-evidence bounded improvement'
      });
    }

    signals.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
    const primary = signals.find((signal) => signal.actionable) ?? signals[0];
    const secondary = signals.filter((signal) => signal !== primary).slice(0, 3);
    const avoid = [...new Set(recentProposalPaths)].slice(0, 12);

    const directive = [
      `Autonomous gap intelligence priority: ${primary.kind} (score ${primary.score}). Evidence: ${clip(primary.evidence)}.`,
      secondary.length
        ? `Secondary detected gaps: ${secondary.map((signal) => `${signal.kind}: ${clip(signal.evidence, 260)}`).join(' | ')}.`
        : '',
      avoid.length ? `Avoid reworking these recently proposed paths unless new evidence proves a regression: ${avoid.join(', ')}.` : '',
      'Choose exactly one bounded, evidence-backed improvement that is implementable inside the current scope. If the highest-ranked gap requires a forbidden root-of-trust change, secret, external communication, merge/production action, or human approval, do not weaken policy: skip to the next implementable gap and leave the blocked capability visible for a future governed change.'
    ].filter(Boolean).join(' ');

    return {
      version: 1,
      projectId: this.project.id,
      primary: primary.kind,
      signals: signals.slice(0, 6),
      directive: clip(directive, 3_500)
    };
  }
}
