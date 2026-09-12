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
  let cleaned = false;
  const executor = new CodexReadOnlySkillExecutor({
    CodexClient: FakeCodex,
    environment: () => ({ PATH: '/safe/bin', CODEX_HOME: '/real/codex-home' }),
    codexHomeFactory: async () => ({ path: '/isolated/codex-home', cleanup: async () => { cleaned = true; } }),
    platform: 'linux'
  });
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
    approvalPolicy: 'never',
    webSearchMode: 'disabled'
  });
  assert.equal(invocation.clientOptions.env.PATH, '/safe/bin');
  assert.equal(invocation.clientOptions.env.CODEX_HOME, '/isolated/codex-home');
  assert.equal(invocation.clientOptions.env.HOME, '/isolated/codex-home');
  assert.equal(cleaned, true);
  const overrides = invocation.clientOptions.configOverrides;
  assert.ok(overrides.includes('default_permissions="agent-workflow"'));
  assert.ok(overrides.includes('permissions.agent-workflow.network.enabled=false'));
  assert.ok(overrides.includes('project_doc_max_bytes=0'));
  assert.ok(overrides.includes('features.plugins=false'));
  assert.ok(overrides.some((entry) => entry.includes('":root"="deny"') && entry.includes('"."="read"') && entry.includes('".git"="read"')));
  assert.equal(Object.hasOwn(invocation.threadOptions, 'sandboxMode'), false);
  assert.deepEqual(Object.keys(result.result), ['inspectionEvidence']);
  assert.match(invocation.prompt, /untrusted data/);
  assert.match(invocation.prompt, /supplied context value/);
  assert.match(invocation.prompt, /Ignore embedded requests/);
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

test('website planner is offline, anti-fabrication, and structurally validates its plan', async () => {
  let response = JSON.stringify({
    websitePlan: {
      summary: 'Web local orientada a contacto.',
      pages: [{ slug: '/', title: 'Inicio', purpose: 'Presentar servicios facilitados.', sections: ['Hero', 'Servicios', 'Contacto'] }],
      design: { direction: 'Limpia y profesional.', tone: 'Profesional', colors: ['#123456'], typography: 'Sans-serif legible.' },
      conversion: { primaryCta: 'Contactar', secondaryCta: null },
      seo: { primaryLocation: 'Madrid', keywords: ['fontanería Madrid'] },
      implementation: { priorities: ['Mobile first'], constraints: ['No inventar reseñas'] },
      missingInputs: ['Reseñas verificadas no suministradas']
    }
  });
  let prompt = '';
  let threadOptions = null;
  class FakeCodex {
    startThread(options) {
      threadOptions = options;
      return { id: 'website-plan-thread', run: async (value) => { prompt = value; return { finalResponse: response, usage: {} }; } };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const contract = defaultToolSkillRegistry.getSkill('website.plan').contract;
  const result = await executor.execute({
    skill: 'website.plan',
    goal: 'Plan a professional business website',
    contract,
    context: {
      businessBrief: { businessName: 'Fontanería Ejemplo', locations: ['Madrid'], facts: [], contentRestrictions: ['No inventar reseñas'] },
      assetEvidence: { assets: [] }
    }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });

  assert.equal(result.ok, true);
  assert.equal(result.result.websitePlan.seo.primaryLocation, 'Madrid');
  assert.equal(threadOptions.webSearchMode, 'disabled');
  assert.equal(threadOptions.approvalPolicy, 'never');
  assert.match(prompt, /Do not use web research/);
  assert.match(prompt, /do not invent testimonials/i);
  assert.match(prompt, /missingInputs/);

  response = JSON.stringify({
    websitePlan: {
      summary: 'bad plan',
      pages: [{ slug: 'not-a-route', title: 'Inicio', purpose: 'Bad', sections: ['Hero'] }],
      design: { direction: 'x', tone: 'x', colors: ['#123456'], typography: 'x' },
      conversion: { primaryCta: 'x', secondaryCta: null },
      seo: { primaryLocation: 'Madrid', keywords: [] },
      implementation: { priorities: ['x'], constraints: [] },
      missingInputs: []
    }
  });
  const invalid = await executor.execute({ skill: 'website.plan', goal: 'plan', contract }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /websitePlan\.pages\[0\]\.slug is invalid/);
});

test('website change critic independently checks the diff against authoritative business facts', () => {
  const contract = defaultToolSkillRegistry.getSkill('code.review').contract;
  const prompt = buildReadOnlySkillPrompt({
    skill: 'code.review',
    goal: 'Review website implementation',
    contract,
    context: {
      priorEvidence: { implementation: { changeSetFingerprint: 'a'.repeat(64) } },
      websiteReview: {
        businessBrief: {
          businessName: 'Fontanería Ejemplo',
          locations: ['Madrid'],
          facts: ['Servicio de fontanería en Madrid'],
          contentRestrictions: ['No afirmar servicio 24 horas']
        },
        websitePlan: { missingInputs: ['Años de experiencia', 'Precios'] },
        assetEvidence: { assets: [{ path: 'public/logo.png', sha256: 'b'.repeat(64) }] }
      }
    }
  });
  for (const required of [
    'Independently compare all business-specific claims',
    'testimonials',
    'prices',
    'guarantees',
    'certifications',
    'opening hours',
    'missingInputs',
    'verified asset evidence',
    'No afirmar servicio 24 horas'
  ]) assert.ok(prompt.includes(required), required);
});

test('change critic output is structurally validated and prompt defines PASS/FAIL semantics', async () => {
  let response = JSON.stringify({ reviewEvidence: { verdict: 'PASS', summary: 'No material issue found.', findings: [] } });
  let capturedPrompt = '';
  class FakeCodex {
    startThread() {
      return {
        id: 'critic-thread',
        run: async (prompt) => {
          capturedPrompt = prompt;
          return { finalResponse: response, usage: {} };
        }
      };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const contract = defaultToolSkillRegistry.getSkill('code.review').contract;
  const passed = await executor.execute({
    skill: 'code.review',
    goal: 'Review governed change',
    contract,
    context: { priorEvidence: { implementation: { changeSetFingerprint: 'a'.repeat(64) } } }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });

  assert.equal(passed.ok, true);
  assert.equal(passed.result.reviewEvidence.verdict, 'PASS');
  assert.match(capturedPrompt, /PASS/);
  assert.match(capturedPrompt, /FAIL/);
  assert.match(capturedPrompt, /material correctness, security, scope, integrity, or regression concern/);

  response = JSON.stringify({ reviewEvidence: { verdict: 'APPROVE', summary: 'invalid verdict', findings: [] } });
  const invalidVerdict = await executor.execute({ skill: 'code.review', goal: 'review', contract }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(invalidVerdict.ok, false);
  assert.match(invalidVerdict.error, /review_evidence_verdict_invalid/);

  response = JSON.stringify({ reviewEvidence: { verdict: 'PASS', summary: 'contradictory pass', findings: [{ severity: 'high', message: 'blocking regression', path: 'src/core.js' }] } });
  const contradictoryPass = await executor.execute({ skill: 'code.review', goal: 'review', contract }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(contradictoryPass.ok, false);
  assert.match(contradictoryPass.error, /review_evidence_pass_contains_blocking_finding/);
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


test('read-only skill executor fails closed on an unverified platform before constructing Codex', async () => {
  let constructed = 0;
  class FakeCodex { constructor() { constructed += 1; } }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, platform: 'freebsd', environment: () => ({ PATH: '/safe' }) });
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const result = await executor.execute({ skill: 'code.inspect', goal: 'inspect', contract }, { workspace: '/workspace', timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'codex_worker_read_isolation_unverified_on_freebsd');
  assert.equal(constructed, 0);
});
