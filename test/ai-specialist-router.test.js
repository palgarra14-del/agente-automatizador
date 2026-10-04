import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIProviderRegistry,
  defaultAIProviderRegistry,
  routeSpecialistTasks
} from '../src/ai-specialist-router.js';

test('AI provider registry is deterministic and keeps adapters explicit', () => {
  const one = new AIProviderRegistry({
    providers: [
      { id: 'beta', capabilities: ['code.review'], adapter: null },
      { id: 'alpha', capabilities: ['code.implement'], adapter: 'Worker' }
    ]
  });
  const two = new AIProviderRegistry({
    providers: [
      { id: 'alpha', capabilities: ['code.implement'], adapter: 'Worker' },
      { id: 'beta', capabilities: ['code.review'], adapter: null }
    ]
  });
  assert.equal(one.fingerprint, two.fingerprint);
  assert.equal(one.get('beta').adapter, null);
});

test('router assigns different specialist tasks to capable available providers', () => {
  const result = routeSpecialistTasks([
    { id: 'plan', requiredCapabilities: ['task.decompose'] },
    { id: 'implement', requiredCapabilities: ['code.implement'], preferredProviders: ['codex'] },
    { id: 'prototype', requiredCapabilities: ['prototype.build'] }
  ], {
    registry: defaultAIProviderRegistry,
    states: {
      chatgpt: { state: 'available' },
      codex: { state: 'available' },
      replit: { state: 'available' },
      claude: { state: 'unavailable' },
      cursor: { state: 'unavailable' },
      gemini: { state: 'unavailable' }
    }
  });
  assert.deepEqual(result.assignments.map(({ taskId, providerId }) => [taskId, providerId]), [
    ['plan', 'chatgpt'],
    ['implement', 'codex'],
    ['prototype', 'replit']
  ]);
  assert.equal(result.unassigned.length, 0);
});

test('router fails closed when a required specialist is unavailable or cooling down', () => {
  const result = routeSpecialistTasks([
    { id: 'challenge', requiredCapabilities: ['architecture.review'] }
  ], {
    registry: defaultAIProviderRegistry,
    states: {
      claude: { state: 'cooldown', untilEpochMs: 2_000 }
    },
    nowEpochMs: 1_000
  });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unassigned[0].taskId, 'challenge');
  assert.ok(result.unassigned[0].rejected.some((item) =>
    item.providerId === 'claude' && item.reason === 'cooldown'
  ));
});

test('router uses measured evidence only after enough samples exist', () => {
  const registry = new AIProviderRegistry({
    providers: [
      { id: 'alpha', capabilities: ['code.review'], adapter: null },
      { id: 'beta', capabilities: ['code.review'], adapter: null }
    ]
  });
  const task = [{ id: 'review', requiredCapabilities: ['code.review'] }];
  const states = { alpha: { state: 'available' }, beta: { state: 'available' } };

  const sparse = routeSpecialistTasks(task, {
    registry,
    states,
    metrics: {
      alpha: { samples: 1, quality: 2, successRate: 0.2 },
      beta: { samples: 1, quality: 10, successRate: 1 }
    }
  });
  assert.equal(sparse.assignments[0].providerId, 'alpha');

  const measured = routeSpecialistTasks(task, {
    registry,
    states,
    metrics: {
      alpha: { samples: 8, quality: 7, successRate: 0.8, normalizedLatency: 0.4, normalizedCost: 0.4 },
      beta: { samples: 8, quality: 9.5, successRate: 0.95, normalizedLatency: 0.4, normalizedCost: 0.4 }
    }
  });
  assert.equal(measured.assignments[0].providerId, 'beta');
});

test('router respects provider concurrency instead of over-assigning one AI', () => {
  const registry = new AIProviderRegistry({
    providers: [
      { id: 'solo', capabilities: ['code.review'], adapter: null, maxConcurrency: 1 }
    ]
  });
  const result = routeSpecialistTasks([
    { id: 'review-a', requiredCapabilities: ['code.review'] },
    { id: 'review-b', requiredCapabilities: ['code.review'] }
  ], {
    registry,
    states: { solo: { state: 'available' } }
  });
  assert.equal(result.assignments.length, 1);
  assert.equal(result.unassigned.length, 1);
  assert.ok(result.unassigned[0].rejected.some((item) => item.reason === 'capacity'));
});
