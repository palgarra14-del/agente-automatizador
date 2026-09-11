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
  if (typeof tool.kind !== 'string' || !tool.kind.trim()) throw new Error(`Tool kind is required: ${tool.id}`);
  if (tool.binding !== null && tool.binding !== undefined && (typeof tool.binding !== 'string' || !tool.binding.trim())) throw new Error(`Tool binding is invalid: ${tool.id}`);
  if (typeof (tool.risk ?? 'unknown') !== 'string' || !(tool.risk ?? 'unknown').trim()) throw new Error(`Tool risk is invalid: ${tool.id}`);
  if (!Array.isArray(tool.surfaces) || tool.surfaces.some((surface) => !['workflow', 'orchestrator'].includes(surface))) throw new Error(`Tool surfaces are invalid: ${tool.id}`);
  return Object.freeze({
    id: tool.id,
    kind: tool.kind.trim(),
    binding: tool.binding?.trim() ?? null,
    bound: Boolean(tool.binding),
    surfaces: Object.freeze([...new Set(tool.surfaces)].sort()),
    risk: (tool.risk ?? 'unknown').trim(),
    description: tool.description ?? ''
  });
}

function normalizeContract(contract, id) {
  if (!contract || typeof contract !== 'object' || !Number.isInteger(contract.version) || contract.version < 1) throw new Error(`Skill contract version is invalid: ${id}`);
  const fieldPattern = /^[a-z][a-zA-Z0-9]*$/;
  const normalizeFields = (fields, label) => {
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string' || !fieldPattern.test(field))) throw new Error(`Skill contract ${label} is invalid: ${id}`);
    return Object.freeze([...new Set(fields)].sort());
  };
  return Object.freeze({
    version: contract.version,
    inputs: normalizeFields(contract.inputs, 'inputs'),
    outputs: normalizeFields(contract.outputs, 'outputs')
  });
}

function normalizeSkill(skill, tools) {
  if (!skill || !idPattern.test(skill.id ?? '')) throw new Error('Skill id is invalid');
  if (!Array.isArray(skill.requiresTools) || !skill.requiresTools.length) throw new Error(`Skill requiresTools is invalid: ${skill.id}`);
  const requiresTools = [...new Set(skill.requiresTools)].sort();
  for (const toolId of requiresTools) if (!tools.has(toolId)) throw new Error(`Skill references unknown tool: ${skill.id} -> ${toolId}`);
  if (!Array.isArray(skill.surfaces) || skill.surfaces.some((surface) => !['workflow', 'orchestrator'].includes(surface))) throw new Error(`Skill surfaces are invalid: ${skill.id}`);
  if (typeof (skill.risk ?? 'unknown') !== 'string' || !(skill.risk ?? 'unknown').trim()) throw new Error(`Skill risk is invalid: ${skill.id}`);
  return Object.freeze({
    id: skill.id,
    requiresTools: Object.freeze(requiresTools),
    surfaces: Object.freeze([...new Set(skill.surfaces)].sort()),
    contract: normalizeContract(skill.contract, skill.id),
    risk: (skill.risk ?? 'unknown').trim(),
    description: skill.description ?? ''
  });
}

export class ToolSkillRegistry {
  #tools = new Map();
  #skills = new Map();

  constructor({ tools = [], skills = [] } = {}) {
    for (const input of tools) {
      const tool = normalizeTool(input);
      if (this.#tools.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
      this.#tools.set(tool.id, tool);
    }
    for (const input of skills) {
      const skill = normalizeSkill(input, this.#tools);
      if (this.#skills.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
      this.#skills.set(skill.id, skill);
    }
    this.fingerprint = fingerprint(this.contractSnapshot());
    Object.freeze(this);
  }

  snapshot() {
    return {
      tools: [...this.#tools.values()].sort((a, b) => a.id.localeCompare(b.id)),
      skills: [...this.#skills.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  contractSnapshot() {
    return {
      tools: [...this.#tools.values()]
        .map(({ id, kind, binding, surfaces, risk }) => ({ id, kind, binding, surfaces, risk }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      skills: [...this.#skills.values()]
        .map(({ id, requiresTools, surfaces, contract, risk }) => ({ id, requiresTools, surfaces, contract, risk }))
        .sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  getTool(id) { return this.#tools.get(id); }
  getSkill(id) { return this.#skills.get(id); }

  validateProjectPolicy(policy = {}) {
    const allow = policy.allow ?? defaultProjectSkillAllow;
    if (!Array.isArray(allow) || allow.some((id) => typeof id !== 'string' || !this.#skills.has(id))) throw new Error('Project skill allowlist contains an unknown skill');
    const deny = policy.deny ?? [];
    if (!Array.isArray(deny) || deny.some((id) => typeof id !== 'string' || !this.#skills.has(id))) throw new Error('Project skill denylist contains an unknown skill');
    return Object.freeze({ allow: Object.freeze([...new Set(allow)].sort()), deny: Object.freeze([...new Set(deny)].sort()) });
  }

  policyFingerprint(policy = {}) {
    return fingerprint(this.validateProjectPolicy(policy));
  }

  resolve(project, skillId, { surface = 'workflow' } = {}) {
    if (!['workflow', 'orchestrator'].includes(surface)) throw new Error('Unknown capability surface');
    const skill = this.#skills.get(skillId);
    if (!skill) return { id: skillId, exists: false, allowed: false, available: false, surface, reason: 'unknown_skill', tools: [] };
    const policy = this.validateProjectPolicy(project?.skills ?? {});
    const allowed = policy.allow.includes(skillId) && !policy.deny.includes(skillId);
    const tools = skill.requiresTools.map((toolId) => {
      const tool = this.#tools.get(toolId);
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
    return { id: skillId, exists: true, allowed, available, surface, reason, risk: skill.risk, contract: skill.contract, tools };
  }

  report(project, { surface = 'workflow' } = {}) {
    return {
      registryFingerprint: this.fingerprint,
      projectPolicyFingerprint: this.policyFingerprint(project?.skills ?? {}),
      projectId: project?.id ?? null,
      surface,
      skills: [...this.#skills.keys()].sort().map((id) => this.resolve(project, id, { surface }))
    };
  }
}

export const defaultTools = Object.freeze([
  { id: 'project-command', kind: 'executor', binding: 'ProjectCommandRunner', surfaces: ['workflow', 'orchestrator'], risk: 'workspace-execution', description: 'Runs project-allowlisted commands through the configured execution provider.' },
  { id: 'workspace-manager', kind: 'executor', binding: 'WorkspaceManager', surfaces: ['workflow', 'orchestrator'], risk: 'network-workspace-write', description: 'Prepares an isolated project workspace from the configured repository.' },
  { id: 'coding-worker', kind: 'executor', binding: 'CodingWorker', surfaces: ['workflow', 'orchestrator'], risk: 'workspace-write', description: 'Performs governed coding work inside a prepared workspace.' },
  { id: 'analysis-worker', kind: 'executor', binding: 'CodexReadOnlySkillExecutor', surfaces: ['workflow'], risk: 'workspace-read', description: 'Runs reviewed read-only workflow analysis skills without network access.' },
  { id: 'github-observe', kind: 'observer', binding: 'GitHubAdapter', surfaces: ['workflow', 'orchestrator'], risk: 'external-read', description: 'Observes repository, pull request, and CI state.' },
  { id: 'git-publish', kind: 'publisher', binding: 'LocalGitAdapter', surfaces: ['workflow', 'orchestrator'], risk: 'external-write', description: 'Pushes a governed commit to the configured review branch.' },
  { id: 'github-publish', kind: 'publisher', binding: 'GitHubAdapter', surfaces: ['workflow', 'orchestrator'], risk: 'external-write', description: 'Creates governed pull requests.' },
  { id: 'vercel-observe', kind: 'observer', binding: 'VercelDeploymentProvider', surfaces: ['workflow', 'orchestrator'], risk: 'external-read', description: 'Observes preview deployment readiness.' },
  { id: 'human-approval', kind: 'human', binding: 'WorkflowApproval', surfaces: ['workflow', 'orchestrator'], risk: 'approval', description: 'Requires an explicit human decision.' },
  { id: 'web-research', kind: 'research', binding: null, surfaces: [], risk: 'network-read', description: 'Reserved for future reviewed web research integration.' },
  { id: 'browser-visual', kind: 'browser', binding: null, surfaces: [], risk: 'network-read', description: 'Reserved for future reviewed browser and visual verification integration.' }
]);

export const defaultSkills = Object.freeze([
  { id: 'workspace.prepare', requiresTools: ['workspace-manager'], surfaces: ['workflow', 'orchestrator'], contract: { version: 1, inputs: ['project', 'runId'], outputs: ['workspaceEvidence'] }, risk: 'network-workspace-write', description: 'Prepare or recover the isolated project workspace.' },
  { id: 'project.bootstrap', requiresTools: ['project-command'], surfaces: ['workflow', 'orchestrator'], contract: { version: 1, inputs: ['project', 'workspace'], outputs: ['commandEvidence'] }, risk: 'network-workspace-execution', description: 'Run the allowlisted project bootstrap/install command.' },
  { id: 'project.verify', requiresTools: ['project-command'], surfaces: ['workflow', 'orchestrator'], contract: { version: 1, inputs: ['project', 'workspace', 'checks'], outputs: ['commandEvidence'] }, risk: 'workspace-execution', description: 'Run bounded project verification commands.' },
  { id: 'repository.observe', requiresTools: ['github-observe'], surfaces: ['orchestrator'], contract: { version: 1, inputs: ['project'], outputs: ['repositoryEvidence'] }, risk: 'external-read', description: 'Inspect registered repository state.' },
  { id: 'repository.publish', requiresTools: ['git-publish'], surfaces: ['orchestrator'], contract: { version: 1, inputs: ['project', 'workspace', 'commit'], outputs: ['pushEvidence'] }, risk: 'external-write', description: 'Push governed commits to the configured review branch.' },
  { id: 'human.approval', requiresTools: ['human-approval'], surfaces: ['workflow', 'orchestrator'], contract: { version: 1, inputs: ['decisionContext'], outputs: ['approvalEvidence'] }, risk: 'approval', description: 'Pause until explicit human approval.' },
  { id: 'code.inspect', requiresTools: ['analysis-worker'], surfaces: ['workflow'], contract: { version: 1, inputs: ['project', 'workspace', 'goal'], outputs: ['inspectionEvidence'] }, risk: 'workspace-read', description: 'Inspect project structure and relevant implementation context without writes.' },
  { id: 'code.diagnose', requiresTools: ['analysis-worker'], surfaces: ['workflow'], contract: { version: 1, inputs: ['project', 'workspace', 'goal', 'inspectionEvidence'], outputs: ['diagnosis'] }, risk: 'workspace-read', description: 'Diagnose a requested app improvement from read-only project evidence.' },
  { id: 'code.implement', requiresTools: ['coding-worker'], surfaces: ['workflow', 'orchestrator'], contract: { version: 1, inputs: ['project', 'workspace', 'codingTask'], outputs: ['workerEvidence', 'changeSet'] }, risk: 'workspace-write', description: 'Implement a bounded code change using the governed coding-worker path.' },
  { id: 'code.review', requiresTools: ['analysis-worker'], surfaces: ['workflow'], contract: { version: 1, inputs: ['project', 'workspace', 'goal', 'changeSet'], outputs: ['reviewEvidence'] }, risk: 'workspace-read', description: 'Critically review the governed implementation diff without modifying it.' },
  { id: 'release.observe-ci', requiresTools: ['github-observe'], surfaces: ['orchestrator'], contract: { version: 1, inputs: ['project', 'commit'], outputs: ['ciEvidence'] }, risk: 'external-read', description: 'Observe CI/check status.' },
  { id: 'release.publish-pr', requiresTools: ['github-publish'], surfaces: ['orchestrator'], contract: { version: 1, inputs: ['project', 'branch', 'commit'], outputs: ['pullRequestEvidence'] }, risk: 'external-write', description: 'Publish a governed pull request.' },
  { id: 'release.observe-preview', requiresTools: ['vercel-observe'], surfaces: ['orchestrator'], contract: { version: 1, inputs: ['project', 'commit', 'branch'], outputs: ['previewEvidence'] }, risk: 'external-read', description: 'Observe a preview deployment.' },
  { id: 'release.publish-reviewed-workflow', requiresTools: ['git-publish', 'github-publish', 'github-observe', 'vercel-observe'], surfaces: ['workflow'], contract: { version: 1, inputs: ['project', 'workspace', 'workflowEvidence'], outputs: ['publicationEvidence'] }, risk: 'external-write', description: 'Publish an already reviewed and verified workflow change to a review branch and pull request, then observe CI and optional preview without merge or production deployment.' },
  { id: 'research.web', requiresTools: ['web-research'], surfaces: [], contract: { version: 1, inputs: ['researchQuestion'], outputs: ['researchEvidence'] }, risk: 'network-read', description: 'Research public web sources.' },
  { id: 'business.analyze', requiresTools: ['web-research'], surfaces: [], contract: { version: 1, inputs: ['businessContext', 'researchEvidence'], outputs: ['businessAnalysis'] }, risk: 'network-read', description: 'Analyze a business using reviewed research evidence.' },
  { id: 'requirements.define', requiresTools: ['coding-worker'], surfaces: [], contract: { version: 1, inputs: ['project', 'inspectionEvidence', 'goal'], outputs: ['requirements'] }, risk: 'workspace-read', description: 'Reserved for a future reviewed requirements executor.' },
  { id: 'visual.review', requiresTools: ['browser-visual'], surfaces: [], contract: { version: 1, inputs: ['previewTarget', 'acceptanceCriteria'], outputs: ['visualEvidence'] }, risk: 'network-read', description: 'Review rendered output with a browser/visual tool.' },
  { id: 'data.inspect', requiresTools: ['coding-worker'], surfaces: [], contract: { version: 1, inputs: ['project', 'workspace'], outputs: ['dataInspection'] }, risk: 'workspace-read', description: 'Reserved for a future reviewed data-inspection executor.' },
  { id: 'data.analyze', requiresTools: ['coding-worker'], surfaces: [], contract: { version: 1, inputs: ['dataInspection', 'analysisGoal'], outputs: ['analysisEvidence'] }, risk: 'workspace-read', description: 'Reserved for a future reviewed data-analysis executor.' },
  { id: 'data.summarize', requiresTools: ['coding-worker'], surfaces: [], contract: { version: 1, inputs: ['analysisEvidence'], outputs: ['analysisOutput'] }, risk: 'workspace-read', description: 'Reserved for a future reviewed data-output executor.' }
]);

export const defaultToolSkillRegistry = new ToolSkillRegistry({ tools: defaultTools, skills: defaultSkills });

export const defaultProjectSkillAllow = Object.freeze([
  'workspace.prepare',
  'project.bootstrap',
  'project.verify',
  'human.approval',
  'repository.observe',
  'repository.publish',
  'code.implement',
  'release.observe-ci',
  'release.publish-pr',
  'release.observe-preview'
]);
