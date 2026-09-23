import { createHash } from 'node:crypto';
import { defaultToolSkillRegistry } from './capabilities.js';

const idPattern = /^[a-z][a-z0-9.-]*$/;
const modes = new Set(['read-only', 'workspace-write', 'verification', 'publication', 'human', 'reserved']);
const modeSkillRisks = new Map([
  ['read-only', new Set(['workspace-read', 'network-read'])],
  ['workspace-write', new Set(['workspace-write'])],
  ['verification', new Set(['workspace-execution', 'network-workspace-execution'])],
  ['publication', new Set(['external-write'])],
  ['human', new Set(['approval'])]
]);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

function normalizeSpecialist(input, capabilityRegistry) {
  if (!input || !idPattern.test(input.id ?? '')) throw new Error('Specialist id is invalid');
  if (!modes.has(input.mode)) throw new Error(`Specialist mode is invalid: ${input.id}`);
  if (!Array.isArray(input.skills) || !input.skills.length) throw new Error(`Specialist skills are required: ${input.id}`);
  const skills = [...new Set(input.skills)].sort();
  const skillDefinitions = skills.map((skillId) => {
    const skill = capabilityRegistry.getSkill(skillId);
    if (!skill) throw new Error(`Specialist references unknown skill: ${input.id} -> ${skillId}`);
    return skill;
  });
  if (input.mode === 'reserved') {
    if (skillDefinitions.some((skill) => skill.surfaces.length > 0)) throw new Error(`Reserved specialist may only own unavailable skills: ${input.id}`);
    if (input.executor !== null && input.executor !== undefined) throw new Error(`Reserved specialist cannot declare an executor: ${input.id}`);
  } else {
    const allowedRisks = modeSkillRisks.get(input.mode);
    for (const skill of skillDefinitions) {
      if (!skill.surfaces.includes('workflow') || !allowedRisks?.has(skill.risk)) throw new Error(`Specialist mode is incompatible with skill authority: ${input.id} -> ${skill.id}`);
    }
    if (typeof input.executor !== 'string' || !input.executor.trim()) throw new Error(`Active specialist executor is required: ${input.id}`);
  }
  if (typeof input.authority !== 'string' || !input.authority.trim()) throw new Error(`Specialist authority is required: ${input.id}`);
  if (input.executor !== null && input.executor !== undefined && (typeof input.executor !== 'string' || !input.executor.trim())) throw new Error(`Specialist executor is invalid: ${input.id}`);
  return Object.freeze({
    id: input.id,
    mode: input.mode,
    skills: Object.freeze(skills),
    authority: input.authority.trim(),
    executor: input.executor?.trim() ?? null,
    description: input.description ?? ''
  });
}

export class SpecialistRegistry {
  #specialists = new Map();

  constructor({ specialists = [], capabilityRegistry = defaultToolSkillRegistry } = {}) {
    for (const input of specialists) {
      const specialist = normalizeSpecialist(input, capabilityRegistry);
      if (this.#specialists.has(specialist.id)) throw new Error(`Duplicate specialist id: ${specialist.id}`);
      this.#specialists.set(specialist.id, specialist);
    }
    this.fingerprint = fingerprint(this.contractSnapshot());
    Object.freeze(this);
  }

  get(id) { return this.#specialists.get(id); }

  contractSnapshot() {
    return [...this.#specialists.values()]
      .map(({ id, mode, skills, authority, executor }) => ({ id, mode, skills, authority, executor }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshot() {
    return [...this.#specialists.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  validateAssignment(specialistId, skillId) {
    const specialist = this.#specialists.get(specialistId);
    if (!specialist) throw new Error(`Unknown specialist: ${specialistId}`);
    if (!specialist.skills.includes(skillId)) throw new Error(`Specialist is not authorized for skill: ${specialistId} -> ${skillId}`);
    return specialist;
  }

  report(project, { capabilityRegistry = defaultToolSkillRegistry, surface = 'workflow' } = {}) {
    return {
      specialistRegistryFingerprint: this.fingerprint,
      projectId: project?.id ?? null,
      specialists: this.snapshot().map((specialist) => ({
        ...specialist,
        skills: specialist.skills.map((skillId) => ({
          skillId,
          capability: capabilityRegistry.resolve(project, skillId, { surface })
        }))
      }))
    };
  }
}

export const defaultSpecialists = Object.freeze([
  { id: 'code-inspector', mode: 'read-only', skills: ['code.inspect'], authority: 'workspace-read', executor: 'CodexReadOnlySkillExecutor', description: 'Inspects implementation context without writes.' },
  { id: 'diagnostician', mode: 'read-only', skills: ['code.diagnose'], authority: 'workspace-read', executor: 'CodexReadOnlySkillExecutor', description: 'Diagnoses the requested improvement from inspected evidence.' },
  { id: 'implementer', mode: 'workspace-write', skills: ['code.implement'], authority: 'workspace-write', executor: 'CodexSdkWorker', description: 'Makes one bounded governed implementation change.' },
  { id: 'change-critic', mode: 'read-only', skills: ['code.review'], authority: 'workspace-read', executor: 'CodexReadOnlySkillExecutor', description: 'Reviews the governed diff independently before verification.' },
  { id: 'verifier', mode: 'verification', skills: ['project.verify'], authority: 'configured-command-execution', executor: 'ProjectCommandRunner', description: 'Runs deterministic allowlisted project verification.' },
  { id: 'dependency-manager', mode: 'verification', skills: ['project.dependencies.refresh'], authority: 'network-workspace-execution', executor: 'ProjectCommandRunner', description: 'Runs one approved frozen dependency refresh without lifecycle scripts, then proves the governed diff is unchanged.' },
  { id: 'release-manager', mode: 'publication', skills: ['release.publish-reviewed-workflow'], authority: 'external-write', executor: 'WorkflowPublicationBridge', description: 'Publishes a verified change for human review without merge or production deployment.' },
  { id: 'human-supervisor', mode: 'human', skills: ['human.approval'], authority: 'human-approval', executor: 'WorkflowApproval', description: 'Provides explicit human checkpoints.' },
  { id: 'visual-reviewer', mode: 'read-only', skills: ['visual.review'], authority: 'network-read', executor: 'BrowserQaCoordinator', description: 'Runs bounded deterministic browser QA against the exact published preview.' },
  { id: 'researcher', mode: 'reserved', skills: ['research.web'], authority: 'unavailable', executor: null, description: 'Reserved for future reviewed web research.' },
  { id: 'business-analyst', mode: 'reserved', skills: ['business.analyze'], authority: 'unavailable', executor: null, description: 'Reserved for future business analysis.' },
  { id: 'requirements-engineer', mode: 'read-only', skills: ['website.plan'], authority: 'workspace-read', executor: 'CodexReadOnlySkillExecutor', description: 'Turns a validated business brief and repository context into a factual structured website plan without writes or web research.' },
  { id: 'data-inspector', mode: 'reserved', skills: ['data.inspect'], authority: 'unavailable', executor: null, description: 'Reserved for future data inspection.' },
  { id: 'data-analyst', mode: 'reserved', skills: ['data.analyze'], authority: 'unavailable', executor: null, description: 'Reserved for future data analysis.' },
  { id: 'data-reporter', mode: 'reserved', skills: ['data.summarize'], authority: 'unavailable', executor: null, description: 'Reserved for future data reporting.' }
]);

export const defaultSpecialistRegistry = new SpecialistRegistry({ specialists: defaultSpecialists, capabilityRegistry: defaultToolSkillRegistry });
