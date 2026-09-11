import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexReadOnlySkillExecutor, buildReadOnlySkillPrompt } from '../src/core.js';
import { defaultToolSkillRegistry } from '../src/capabilities.js';

test('read-only skill executor uses a read-only offline Codex thread and validates strict JSON', async () => {
  const invocation = {};
  class FakeCodex {
    constructor(options) { invocation.clientOptions = options; }
    startThread(options) {
      invocation.threadOptions = options;
      return {
        id: 'readonly-thread-1',
        run: async (prompt, turnOptions) => {
          invocation.prompt = prompt;
          invocation.turnOptions = turnOptions;
          return {
            finalResponse: JSON.stringify({
              inspectionEvidence: {
                summary: 'Inspected the requested code path.',
                relevantPaths: ['src/core.js'],
                findings: ['WorkflowEngine owns execution flow.']
              }
            }),
            usage: { input_tokens: 10, output_tokens: 20 }
          };
        }
      };
    }
  }
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({ PATH: '/safe/bin' }) });
  const result = await executor.execute({
    skill: 'code.inspect',
    goal: 'Inspect workflow execution',
    contract,
    context: { projectId: 'fixture' }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.codexThreadId, 'readonly-thread-1');
  assert.deepEqual(invocation.threadOptions, {
    workingDirectory: '/safe/workspace',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled'
  });
  assert.equal(invocation.clientOptions.env.PATH, '/safe/bin');
  assert.deepEqual(Object.keys(result.result), ['inspectionEvidence']);
  assert.match(invocation.prompt, /untrusted data/);
  assert.match(invocation.prompt, /exactly one JSON object/);
});

test('read-only skill prompt redacts sensitive request fields', () => {
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const prompt = buildReadOnlySkillPrompt({
    skill: 'code.inspect',
    goal: 'inspect',
    contract,
    context: { token: 'ghp_shouldNeverAppear', nested: { password: 'hidden-password' } }
  });
  assert.equal(prompt.includes('ghp_shouldNeverAppear'), false);
  assert.equal(prompt.includes('hidden-password'), false);
  assert.match(prompt, /\[REDACTED\]/);
});

test('read-only skill executor fails closed on malformed or contract-mismatched output and counts bytes', async () => {
  let response = '{"wrongKey":{"value":1}}';
  class FakeCodex {
    startThread() {
      return { id: 'readonly-thread-2', run: async () => ({ finalResponse: response, usage: {} }) };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const mismatched = await executor.execute({ skill: 'code.inspect', goal: 'inspect', contract }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /skill_output_contract_mismatch/);
  assert.equal(mismatched.outputBytes, Buffer.byteLength(response));

  response = 'not json';
  const malformed = await executor.execute({ skill: 'code.inspect', goal: 'inspect', contract }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.outputBytes > 0);
});

test('read-only skill executor rejects unsupported skills before starting Codex', async () => {
  let started = 0;
  class FakeCodex {
    startThread() { started += 1; return { run: async () => ({ finalResponse: '{}' }) }; }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex });
  await assert.rejects(
    executor.execute({ skill: 'research.web', goal: 'research', contract: { outputs: ['researchEvidence'] } }, { workspace: '/safe/workspace', timeoutMs: 500 }),
    /skill_executor_unsupported/
  );
  assert.equal(started, 0);
});
