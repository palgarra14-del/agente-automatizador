import { createHash } from 'node:crypto';

const idPattern = /^[a-z][a-z0-9.-]*$/;
const validStates = new Set(['available', 'cooldown', 'unavailable']);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

function normalizeProvider(input) {
  if (!input || !idPattern.test(input.id ?? '')) throw new Error('AI provider id is invalid');
  if (!Array.isArray(input.capabilities) || !input.capabilities.length) {
    throw new Error(`AI provider capabilities are required: ${input.id}`);
  }
  const capabilities = [...new Set(input.capabilities.map(String))].sort();
  if (capabilities.some((capability) => !idPattern.test(capability))) {
    throw new Error(`AI provider capability is invalid: ${input.id}`);
  }
  const maxConcurrency = input.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`AI provider maxConcurrency is invalid: ${input.id}`);
  }
  return Object.freeze({
    id: input.id,
    capabilities: Object.freeze(capabilities),
    adapter: input.adapter?.trim() || null,
    maxConcurrency,
    description: input.description ?? ''
  });
}

function normalizeTask(task) {
  if (!task || !idPattern.test(task.id ?? '')) throw new Error('AI specialist task id is invalid');
  const requiredCapabilities = [...new Set((task.requiredCapabilities ?? []).map(String))].sort();
  if (!requiredCapabilities.length || requiredCapabilities.some((capability) => !idPattern.test(capability))) {
    throw new Error(`AI specialist task requiredCapabilities are invalid: ${task.id}`);
  }
  const preferredCapabilities = [...new Set((task.preferredCapabilities ?? []).map(String))].sort();
  if (preferredCapabilities.some((capability) => !idPattern.test(capability))) {
    throw new Error(`AI specialist task preferredCapabilities are invalid: ${task.id}`);
  }
  const preferredProviders = [...new Set((task.preferredProviders ?? []).map(String))];
  return Object.freeze({
    id: task.id,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    preferredCapabilities: Object.freeze(preferredCapabilities),
    preferredProviders: Object.freeze(preferredProviders)
  });
}

function providerState(states, providerId, nowEpochMs) {
  const raw = states?.[providerId] ?? { state: 'unavailable' };
  const state = raw.state ?? 'unavailable';
  if (!validStates.has(state)) throw new Error(`Invalid AI provider state: ${providerId}`);
  if (state === 'cooldown') {
    const until = Number(raw.untilEpochMs ?? 0);
    if (Number.isFinite(until) && until > nowEpochMs) return { state, untilEpochMs: until };
    return { state: 'available' };
  }
  return { state };
}

function evidenceScore(metrics = {}) {
  const samples = Number(metrics.samples ?? 0);
  if (!Number.isFinite(samples) || samples < 3) return 0;
  const quality = Math.max(0, Math.min(10, Number(metrics.quality ?? 0)));
  const successRate = Math.max(0, Math.min(1, Number(metrics.successRate ?? 0)));
  const normalizedLatency = Math.max(0, Math.min(1, Number(metrics.normalizedLatency ?? 0.5)));
  const normalizedCost = Math.max(0, Math.min(1, Number(metrics.normalizedCost ?? 0.5)));
  return quality * 4 + successRate * 20 - normalizedLatency * 4 - normalizedCost * 4;
}

function scoreCandidate(provider, task, metrics = {}) {
  let score = 100;
  score += task.preferredCapabilities.filter((capability) => provider.capabilities.includes(capability)).length * 3;
  const preferredIndex = task.preferredProviders.indexOf(provider.id);
  if (preferredIndex >= 0) score += Math.max(1, 8 - preferredIndex);
  score += evidenceScore(metrics);
  return score;
}

export class AIProviderRegistry {
  #providers = new Map();

  constructor({ providers = [] } = {}) {
    for (const input of providers) {
      const provider = normalizeProvider(input);
      if (this.#providers.has(provider.id)) throw new Error(`Duplicate AI provider id: ${provider.id}`);
      this.#providers.set(provider.id, provider);
    }
    this.fingerprint = fingerprint(this.contractSnapshot());
    Object.freeze(this);
  }

  get(id) { return this.#providers.get(id); }

  snapshot() {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  contractSnapshot() {
    return this.snapshot().map(({ id, capabilities, adapter, maxConcurrency }) => ({
      id, capabilities, adapter, maxConcurrency
    }));
  }
}

export function routeSpecialistTasks(tasks, {
  registry = defaultAIProviderRegistry,
  states = {},
  metrics = {},
  nowEpochMs = Date.now()
} = {}) {
  if (!Array.isArray(tasks)) throw new Error('AI specialist tasks must be an array');
  const normalizedTasks = tasks.map(normalizeTask);
  const usage = new Map();
  const assignments = [];
  const unassigned = [];

  for (const task of normalizedTasks) {
    const candidates = [];
    const rejected = [];
    for (const provider of registry.snapshot()) {
      const state = providerState(states, provider.id, nowEpochMs);
      if (state.state !== 'available') {
        rejected.push({ providerId: provider.id, reason: state.state });
        continue;
      }
      if (task.requiredCapabilities.some((capability) => !provider.capabilities.includes(capability))) {
        rejected.push({ providerId: provider.id, reason: 'missing_capability' });
        continue;
      }
      const used = usage.get(provider.id) ?? 0;
      if (used >= provider.maxConcurrency) {
        rejected.push({ providerId: provider.id, reason: 'capacity' });
        continue;
      }
      candidates.push({
        provider,
        score: scoreCandidate(provider, task, metrics?.[provider.id]?.[task.id] ?? metrics?.[provider.id] ?? {})
      });
    }

    candidates.sort((left, right) =>
      right.score - left.score || left.provider.id.localeCompare(right.provider.id)
    );

    const winner = candidates[0];
    if (!winner) {
      unassigned.push({ taskId: task.id, rejected });
      continue;
    }
    usage.set(winner.provider.id, (usage.get(winner.provider.id) ?? 0) + 1);
    assignments.push({
      taskId: task.id,
      providerId: winner.provider.id,
      score: Number(winner.score.toFixed(3)),
      requiredCapabilities: task.requiredCapabilities
    });
  }

  return {
    assignments,
    unassigned,
    providerRegistryFingerprint: registry.fingerprint
  };
}

export const defaultAIProviders = Object.freeze([
  {
    id: 'chatgpt',
    capabilities: ['architecture.plan', 'evidence.synthesize', 'task.decompose'],
    adapter: null,
    maxConcurrency: 2,
    description: 'Coordinator profile for decomposition, synthesis, and architecture planning.'
  },
  {
    id: 'claude',
    capabilities: ['architecture.review', 'code.review', 'spec.challenge'],
    adapter: null,
    maxConcurrency: 1,
    description: 'Review/challenge profile; runtime adapter must be explicitly connected.'
  },
  {
    id: 'codex',
    capabilities: ['code.debug', 'code.implement', 'code.review', 'test.author'],
    adapter: 'CodexSdkWorker',
    maxConcurrency: 1,
    description: 'Governed repository implementation and debugging profile.'
  },
  {
    id: 'cursor',
    capabilities: ['code.implement', 'code.refactor', 'multi-model.gateway', 'repo.navigate'],
    adapter: null,
    maxConcurrency: 1,
    description: 'Repository and multi-model gateway profile; runtime adapter must be explicitly connected.'
  },
  {
    id: 'gemini',
    capabilities: ['evidence.synthesize', 'research.review', 'spec.challenge'],
    adapter: null,
    maxConcurrency: 1,
    description: 'Synthesis/challenge profile; runtime adapter must be explicitly connected.'
  },
  {
    id: 'replit',
    capabilities: ['prototype.build', 'ui.prototype'],
    adapter: null,
    maxConcurrency: 1,
    description: 'Rapid executable prototyping profile; runtime adapter must be explicitly connected.'
  }
]);

export const defaultAIProviderRegistry = new AIProviderRegistry({ providers: defaultAIProviders });
