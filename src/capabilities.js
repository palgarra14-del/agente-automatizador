import { createHash } from 'node:crypto';

const idPattern = /^[a-z][a-z0-9.-]*$/;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

function normalizeTool(tool) {
  if (!tool || !idPattern.test(tool.id ?? '')) throw new Error('Tool id is invalid');
  if (typeof tool.kind !== 'string' || !tool.kind) throw new Error(`Tool kind is required: ${tool.id}`);
  if (!Array.isArray(tool.surfaces) || tool.surfaces.some((surface) => !['workflow', 'orchestrator'].includes(surface))) throw new Error(`Tool surfaces are invalid: ${tool.id}`);
  return Object.freeze({
    id: tool.id,
    kind: tool.kind,
    binding: tool.binding ?? null,
    bound: Boolean(tool.binding),
    surfaces: Object.freeze([...new Set(tool.surfaces)].sort()),
    risk: tool.risk ?? 'unknown',
    description: tool.description ?? ''
  });
}

function normalizeSkill(skill, tools) {
  if (!skill || !idPattern.test(skill.id ?? '')) throw new Error('Skill id is invalid');
  if (!Array.isArray(skill.requiresTools) || !skill.requiresTools.length) throw new Error(`Skill requiresTools is invalid: ${skill.id}`);
  const requiresTools = [...new Set(skill.requiresTools)].sort();
  for (const toolId of requiresTools) if (!tools.has(toolId)) throw new Error(`Skill references unknown tool: ${skill.id} -> ${toolId}`);
  if (!Array.isArray(skill.surfaces) || skill.surfaces.some((surface) => !['workflow', 'orchestrator'].includes(surface))) throw new Error(`Skill surfaces are invalid: ${skill.id}`);
  return Object.freeze({
    id: skill.id,
    requiresTools: Object.freeze(requiresTools),
    surfaces: Object.freeze([...new Set(skill.surfaces)].sort()),
    risk: skill.risk ?? 'unknown',
    description: skill.description ?? ''
  });
}

export class ToolSkillRegistry {
  constructor({ tools = [], skills = [] } = {}) {
    this.tools = new Map();
    for (const input of tools) {
      const tool = normalizeTool(input);
      if (this.tools.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
      this.tools.set(tool.id, tool);
    }
    this.skills = new Map();
    for (const input of skills) {
      const skill = normalizeSkill(input, this.tools);
      if (this.skills.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
      this.skills.set(skill.id, skill);
    }
    this.fingerprint = fingerprint(this.snapshot());
  }

  snapshot() {
    return {
      tools: [...this.tools.values()].sort((a, b) => a.id.localeCompare(b.id)),
      skills: [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  getTool(id) { return this.tools.get(id); }
  getSkill(id) { return this.skills.get(id); }

  validateProjectPolicy(policy = {}) {
    const allow = policy.allow ?? defaultProjectSkillAllow;
    if (!Array.isArray(allow) || allow.some((id) => typeof id !== 'string' || !this.skills.has(id))) throw new Error('Project skill allowlist contains an unknown skill');
    const deny = policy.deny ?? [];
    if (!Array.isArray(deny) || deny.some((id) => typeof id !== 'string' || !this.skills.has(id))) throw new Error('Project skill denylist contains an unknown skill');
    if (allow.some((id) => deny.includes(id))) throw new Error('Project skill cannot be both allowed and denied');
    return Object.freeze({ allow: Object.freeze([...new Set(allow)].sort()), deny: Object.freeze([...new Set(deny)].sort()) });
  }

  policyFingerprint(policy = {}) {
    return fingerprint(this.validateProjectPolicy(policy));
  }

  resolve(project, skillId, { surface = 'workflow' } = {}) {
    if (!['workflow', 'orchestrator'].includes(surface)) throw new Error('Unknown capability surface');
    const skill = this.skills.get(skillId);
    if (!skill) return { id: skillId, exists: false, allowed: false, available: false, surface, reason: 'unknown_skill', tools: [] };
    const policy = project?.skills ?? this.validateProjectPolicy();
    const allowed = policy.allow.includes(skillId) && !policy.deny.includes(skillId);
    const tools = skill.requiresTools.map((toolId) => {
      const tool = this.tools.get(toolId);
      const surfaceBound = tool.bound && tool.surfaces.includes(surface);
      return { id: tool.id, bound: tool.bound, surfaceBound, binding: tool.binding, kind: tool.kind, risk: tool.risk };
    });
    const skillSurface = skill.surfaces.includes(surface);
    const available = allowed && skillSurface && tools.every((tool) => tool.surfaceBound);
    let reason = null;
    if (!allowed) reason = 'skill_not_allowed';
    else if (!skillSurface) reason = 'skill_not_bound_to_surface';
    else if (tools.some((tool) => !tool.bound)) reason = 'tool_unbound';
    else if (tools.some((tool) => !tool.surfaceBound)) reason = 'tool_not_bound_to_surface';
    return { id: skillId, exists: true, allowed, available, surface, reason, risk: skill.risk, tools };
  }

  report(project, { surface = 'workflow' } = {}) {
    return {
      registryFingerprint: this.fingerprint,
      projectPolicyFingerprint: this.policyFingerprint(project?.skills ?? {}),
      projectId: project?.id ?? null,
      surface,
      skills: [...this.skills.keys()].sort().map((id) => this.resolve(project, id, { surface }))
    };
  }
}

export const defaultTools = Object.freeze([
  { id: 'project-command', kind: 'executor', binding: 'ProjectCommandRunner', surfaces: ['workflow', 'orchestrator'], risk: 'workspace-execution', description: 'Runs project-allowlisted commands through the configured execution provider.' },
  { id: 'coding-worker', kind: 'executor', binding: 'CodingWorker', surfaces: ['orchestrator'], risk: 'workspace-write', description: 'Performs governed coding work inside a prepared workspace.' },
  { id: 'github-observe', kind: 'observer', binding: 'GitHubAdapter', surfaces: ['orchestrator'], risk: 'external-read', description: 'Observes repository, pull request, and CI state.' },
  { id: 'github-publish', kind: 'publisher', binding: 'GitHubAdapter', surfaces: ['orchestrator'], risk: 'external-write', description: 'Creates governed branches, pushes, and pull requests.' },
  { id: 'vercel-observe', kind: 'observer', binding: 'VercelDeploymentProvider', surfaces: ['orchestrator'], risk: 'external-read', description: 'Observes preview deployment readiness.' },
  { id: 'human-approval', kind: 'human', binding: 'WorkflowApproval', surfaces: ['workflow', 'orchestrator'], risk: 'approval', description: 'Requires an explicit human decision.' },
  { id: 'web-research', kind: 'research', binding: null, surfaces: [], risk: 'network-read', description: 'Reserved for future reviewed web research integration.' },
  { id: 'browser-visual', kind: 'browser', binding: null, surfaces: [], risk: 'network-read', description: 'Reserved for future reviewed browser and visual verification integration.' }
]);

export const defaultSkills = Object.freeze([
  { id: 'project.verify', requiresTools: ['project-command'], surfaces: ['workflow', 'orchestrator'], risk: 'workspace-execution', description: 'Run bounded project verification commands.' },
  { id: 'human.approval', requiresTools: ['human-approval'], surfaces: ['workflow', 'orchestrator'], risk: 'approval', description: 'Pause until explicit human approval.' },
  { id: 'code.inspect', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-read', description: 'Inspect a codebase using the governed coding-worker path.' },
  { id: 'code.implement', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-write', description: 'Implement a bounded code change using the governed coding-worker path.' },
  { id: 'release.observe-ci', requiresTools: ['github-observe'], surfaces: ['orchestrator'], risk: 'external-read', description: 'Observe CI/check status.' },
  { id: 'release.publish-pr', requiresTools: ['github-publish'], surfaces: ['orchestrator'], risk: 'external-write', description: 'Publish a governed pull request.' },
  { id: 'release.observe-preview', requiresTools: ['vercel-observe'], surfaces: ['orchestrator'], risk: 'external-read', description: 'Observe a preview deployment.' },
  { id: 'research.web', requiresTools: ['web-research'], surfaces: [], risk: 'network-read', description: 'Research public web sources.' },
  { id: 'business.analyze', requiresTools: ['web-research'], surfaces: [], risk: 'network-read', description: 'Analyze a business using reviewed research evidence.' },
  { id: 'requirements.define', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-read', description: 'Turn inspected context into bounded implementation requirements.' },
  { id: 'visual.review', requiresTools: ['browser-visual'], surfaces: [], risk: 'network-read', description: 'Review rendered output with a browser/visual tool.' },
  { id: 'data.inspect', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-read', description: 'Inspect data/code context with a governed worker.' },
  { id: 'data.analyze', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-read', description: 'Perform bounded analysis with a governed worker.' },
  { id: 'data.summarize', requiresTools: ['coding-worker'], surfaces: ['orchestrator'], risk: 'workspace-read', description: 'Produce a bounded analysis output.' }
]);

export const defaultToolSkillRegistry = new ToolSkillRegistry({ tools: defaultTools, skills: defaultSkills });

export const defaultProjectSkillAllow = Object.freeze(['project.verify', 'human.approval']);
