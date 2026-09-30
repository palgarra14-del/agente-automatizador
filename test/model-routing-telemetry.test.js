import assert from 'node:assert/strict';
import test from 'node:test';
import { MultiModelGatewayClient } from '../src/core.js';

test('multi-model gateway forwards provider capacity policy but keeps paid routing disabled', async () => {
  let captured = null;
  const gateway = new MultiModelGatewayClient({
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MODEL_PROVIDER_SLOT_WAIT_SECONDS: '30',
      MODEL_PROVIDER_MAX_ANTIGRAVITY: '2',
      MODEL_PROVIDER_MAX_OLLAMA: '1',
      PAID_MODELS_EXPLICITLY_ENABLED: '1',
      OPENAI_API_KEY: 'must-not-leak'
    },
    processRunner: async (_command, _args, options) => {
      captured = options;
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          candidate: 'ag-gemini-3.8-flash',
          family: 'google',
          provider: 'antigravity',
          model: 'gemini-3.8-flash-high',
          resourceClass: 'workhorse_free',
          providerSlot: {
            provider: 'antigravity',
            slot: 1,
            limit: 2,
            coordinated: true
          },
          routingScore: 1.01,
          fallbackErrors: []
        }),
        stderr: ''
      };
    }
  });

  const result = await gateway.structured({
    role: 'research_and_audit',
    prompt: 'inspect',
    schema: { type: 'object' }
  }, {
    workspace: process.cwd(),
    timeoutMs: 60_000
  });

  assert.equal(captured.env.MODEL_COST_POLICY, 'free_only');
  assert.equal(captured.env.PAID_MODELS_EXPLICITLY_ENABLED, '0');
  assert.equal(captured.env.MODEL_PROVIDER_SLOT_WAIT_SECONDS, '30');
  assert.equal(captured.env.MODEL_PROVIDER_MAX_ANTIGRAVITY, '2');
  assert.equal(captured.env.MODEL_PROVIDER_MAX_OLLAMA, '1');
  assert.equal(captured.env.OPENAI_API_KEY, '');
  assert.equal(result.modelRouting.resourceClass, 'workhorse_free');
  assert.deepEqual(result.modelRouting.providerSlot, {
    provider: 'antigravity',
    slot: 1,
    limit: 2,
    coordinated: true
  });
});
