import { createHash } from 'node:crypto';
import { defaultToolSkillRegistry } from './capabilities.js';

const idPattern = /^[a-z][a-z0-9.-]*$/;
const modes = new Set(['read-only', 'workspace-write', 'verification', 'human', 'reserved']);

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
  for (const skill of skills) if (!capabilityRegistry.getSkill(skill)) throw new Error(`Specialist references unknown skill: ${input.id} -> ${skill}`);
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
  { id: 'human-supervisor', mode: 'human', skills: ['human.approval'], authority: 'human-approval', executor: 'WorkflowApproval', description: 'Provides explicit human checkpoints.' },
  { id: 'researcher', mode: 'reserved', skills: ['research.web'], authority: 'unavailable', executor: null, description: 'Reserved for future reviewed web research.' },
  { id: 'business-analyst', mode: 'reserved', skills: ['business.analyze'], authority: 'unavailable', executor: null, description: 'Reserved for future business analysis.' },
  { id: 'requirements-engineer', mode: 'reserved', skills: ['requirements.define'], authority: 'unavailable', executor: null, description: 'Reserved for future requirements definition.' },
  { id: 'data-inspector', mode: 'reserved', skills: ['data.inspect'], authority: 'unavailable', executor: null, description: 'Reserved for future data inspection.' },
  { id: 'data-analyst', mode: 'reserved', skills: ['data.analyze'], authority: 'unavailable', executor: null, description: 'Reserved for future data analysis.' },
  { id: 'data-reporter', mode: 'reserved', skills: ['data.summarize'], authority: 'unavailable', executor: null, description: 'Reserved for future data reporting.' }
]);

export const defaultSpecialistRegistry = new SpecialistRegistry({ specialists: defaultSpecialists, capabilityRegistry: defaultToolSkillRegistry });
