import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexReadOnlySkillExecutor, buildReadOnlySkillPrompt, collectReadOnlyRepositoryContext, collectReadOnlyReviewDiff } from '../src/core.js';
import { defaultToolSkillRegistry } from '../src/capabilities.js';

function repositoryContextFixture(entries = [{ path: 'src/core.js', content: 'export const fixture = true;\n' }], reviewDiff = null) {
  const files = entries.map(({ path, content }) => ({
    path,
    content,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex')
  }));
  const fileMetadata = files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  const fingerprint = reviewDiff
    ? createHash('sha256').update(JSON.stringify({ files: fileMetadata, reviewDiff: { sha256: reviewDiff.sha256, bytes: reviewDiff.bytes } })).digest('hex')
    : createHash('sha256').update(JSON.stringify(fileMetadata)).digest('hex');
  return { version: 1, files, ...(reviewDiff ? { reviewDiff } : {}), fingerprint };
}

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
  assert.match(invocation.prompt, /relevantPaths/);
  assert.match(invocation.prompt, /If repository access is blocked/);
});

test('orchestrator repository context is scope-bounded, size-bounded, secret-masked, and fingerprinted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-readonly-context-'));
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    await writeFile(join(workspace, 'src', 'a.js'), `export const value = "${secret}";\n`);
    await writeFile(join(workspace, 'src', 'b.js'), 'export const other = 2;\n');
    let observed = null;
    const processRunner = async (command, args, options) => {
      observed = { command, args, options };
      return {
        exitCode: 0,
        timedOut: false,
        stdout: 'src/a.js\nsrc/b.js\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false
      };
    };
    const project = { changePolicy: { forbiddenPaths: [] }, budgets: { commandTimeoutMs: 1_000 } };
    const context = await collectReadOnlyRepositoryContext({
      workspace,
      project,
      scope: { allowedPaths: ['src/a.js', 'src/b.js'], forbiddenPaths: [] },
      processRunner,
      timeoutMs: 500
    });
    assert.equal(observed.command, 'git');
    assert.deepEqual(observed.args, ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/a.js', 'src/b.js']);
    assert.equal(context.version, 1);
    assert.deepEqual(context.files.map((file) => file.path), ['src/a.js', 'src/b.js']);
    assert.match(context.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(context.files[0].content.includes(secret), false);
    assert.match(context.files[0].content, /\[REDACTED\]/);

    await assert.rejects(
      collectReadOnlyRepositoryContext({
        workspace,
        project,
        scope: { allowedPaths: ['src/a.js', 'src/b.js'], forbiddenPaths: [] },
        processRunner,
        timeoutMs: 500,
        limits: { maxFiles: 1 }
      }),
      /repository_context_file_limit_exceeded/
    );

    await assert.rejects(
      collectReadOnlyRepositoryContext({
        workspace,
        project,
        scope: { allowedPaths: ['src'], forbiddenPaths: [] },
        processRunner: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: 'outside.js\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false
        }),
        timeoutMs: 500
      }),
      /repository_context_scope_violation/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('orchestrator repository context rejects multiply-linked files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-readonly-links-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-readonly-outside-'));
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    const external = join(outside, 'shared.js');
    await writeFile(external, 'export const outside = true;\n');
    await link(external, join(workspace, 'src', 'shared.js'));
    const processRunner = async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: 'src/shared.js\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false
    });
    await assert.rejects(
      collectReadOnlyRepositoryContext({
        workspace,
        project: { changePolicy: { forbiddenPaths: [] } },
        scope: { allowedPaths: ['src/shared.js'], forbiddenPaths: [] },
        processRunner,
        timeoutMs: 500
      }),
      /repository context file link count is not one/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('orchestrator-supplied repository context removes filesystem discovery from read-only analysis and binds cited paths', async () => {
  const context = repositoryContextFixture();
  let response = JSON.stringify({
    inspectionEvidence: {
      summary: 'Grounded in supplied source.',
      relevantPaths: ['src/core.js'],
      findings: ['The supplied file exports a fixture value.']
    }
  });
  let prompt = '';
  class FakeCodex {
    startThread() {
      return {
        id: 'context-thread',
        run: async (value) => {
          prompt = value;
          return { finalResponse: response, usage: {} };
        }
      };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const grounded = await executor.execute({
    skill: 'code.inspect',
    goal: 'Inspect supplied context',
    contract,
    context: { repositoryContext: context }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(grounded.ok, true);
  assert.match(prompt, /trusted orchestrator supplied repositoryContext/);
  assert.match(prompt, /Do not invoke shell, filesystem, git, browser, network, or discovery tools/);

  response = JSON.stringify({
    inspectionEvidence: {
      summary: 'Invented path.',
      relevantPaths: ['src/not-supplied.js'],
      findings: ['Unsupported path.']
    }
  });
  const invented = await executor.execute({
    skill: 'code.inspect',
    goal: 'Inspect supplied context',
    contract,
    context: { repositoryContext: context }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(invented.ok, false);
  assert.match(invented.error, /inspection_references_unsupplied_path/);
});

test('bounded review diff is supplied by the orchestrator and fingerprint changes fail closed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-review-context-'));
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'core.js'), 'export const fixture = 2;\n');
    let diffText = 'diff --git a/src/core.js b/src/core.js\n-old\n+new\n';
    const contextProcessRunner = async (_command, args) => {
      if (args[0] === 'ls-files') {
        return { exitCode: 0, timedOut: false, stdout: 'src/core.js\n', stderr: '', stdoutTruncated: false, stderrTruncated: false };
      }
      if (args[0] === 'diff') {
        return {
          exitCode: 0,
          timedOut: false,
          stdout: diffText,
          stderr: '',
          stdoutBytes: Buffer.byteLength(diffText),
          stdoutDigest: createHash('sha256').update(diffText).digest('hex'),
          stdoutTruncated: false,
          stderrTruncated: false
        };
      }
      throw new Error('unexpected command');
    };
    const project = { changePolicy: { forbiddenPaths: [] }, budgets: { commandTimeoutMs: 1_000 } };
    const executor = new CodexReadOnlySkillExecutor({ contextProcessRunner });
    const context = await executor.prepareContext({
      skill: 'code.review',
      project,
      scope: { allowedPaths: ['src/core.js'], forbiddenPaths: [] }
    }, { workspace, timeoutMs: 500 });

    assert.equal(context.files[0].path, 'src/core.js');
    assert.equal(context.reviewDiff.content, diffText);
    assert.match(context.reviewDiff.sha256, /^[a-f0-9]{64}$/);
    assert.match(context.fingerprint, /^[a-f0-9]{64}$/);

    const directDiff = await collectReadOnlyReviewDiff({
      workspace,
      scope: { allowedPaths: ['src/core.js'], forbiddenPaths: [] },
      processRunner: contextProcessRunner,
      timeoutMs: 500
    });
    assert.equal(directDiff.sha256, context.reviewDiff.sha256);

    await executor.revalidateContext(context, {
      workspace,
      project,
      scope: { allowedPaths: ['src/core.js'], forbiddenPaths: [] },
      timeoutMs: 500
    });

    diffText = 'diff --git a/src/core.js b/src/core.js\n-old\n+different\n';
    await assert.rejects(
      executor.revalidateContext(context, {
        workspace,
        project,
        scope: { allowedPaths: ['src/core.js'], forbiddenPaths: [] },
        timeoutMs: 500
      }),
      /repository_context_changed_during_analysis/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('review specialist uses supplied diff without filesystem discovery and cannot cite unsupplied paths', async () => {
  const diffContent = 'diff --git a/src/core.js b/src/core.js\n-old\n+new\n';
  const reviewDiff = {
    content: diffContent,
    bytes: Buffer.byteLength(diffContent),
    sha256: createHash('sha256').update(diffContent).digest('hex')
  };
  const context = repositoryContextFixture(undefined, reviewDiff);
  let response = JSON.stringify({
    reviewEvidence: {
      verdict: 'PASS',
      summary: 'Supplied diff is consistent with the goal.',
      findings: []
    }
  });
  let prompt = '';
  class FakeCodex {
    startThread() {
      return {
        id: 'review-context-thread',
        run: async (value) => {
          prompt = value;
          return { finalResponse: response, usage: {} };
        }
      };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const contract = defaultToolSkillRegistry.getSkill('code.review').contract;
  const passed = await executor.execute({
    skill: 'code.review',
    goal: 'Review supplied diff',
    contract,
    context: { repositoryContext: context }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(passed.ok, true);
  assert.match(prompt, /repositoryContext\.reviewDiff as the trusted bounded Git diff/);
  assert.match(prompt, /Do not invoke shell, filesystem, git, browser, network, or discovery tools/);

  response = JSON.stringify({
    reviewEvidence: {
      verdict: 'FAIL',
      summary: 'Invented path.',
      findings: [{ severity: 'high', message: 'Unsupported finding.', path: 'src/not-supplied.js' }]
    }
  });
  const invented = await executor.execute({
    skill: 'code.review',
    goal: 'Review supplied diff',
    contract,
    context: { repositoryContext: context }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(invented.ok, false);
  assert.match(invented.error, /review_references_unsupplied_path/);
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

test('read-only inspect and diagnose evidence fail closed when repository grounding is absent or inconsistent', async () => {
  let response = JSON.stringify({
    inspectionEvidence: {
      status: 'blocked',
      filesInspected: [],
      findings: [],
      limitations: ['repository listing blocked']
    }
  });
  class FakeCodex {
    startThread() {
      return { id: 'grounding-thread', run: async () => ({ finalResponse: response, usage: {} }) };
    }
  }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, environment: () => ({}) });
  const inspectContract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const blockedInspection = await executor.execute(
    { skill: 'code.inspect', goal: 'inspect', contract: inspectContract, context: {} },
    { workspace: '/safe/workspace', timeoutMs: 500 }
  );
  assert.equal(blockedInspection.ok, false);
  assert.match(blockedInspection.error, /inspectionEvidence contains unknown fields|inspectionEvidence\.relevantPaths/);

  response = JSON.stringify({
    inspectionEvidence: {
      summary: 'Could not inspect repository.',
      relevantPaths: [],
      findings: ['Access was blocked.']
    }
  });
  const emptyInspection = await executor.execute(
    { skill: 'code.inspect', goal: 'inspect', contract: inspectContract, context: {} },
    { workspace: '/safe/workspace', timeoutMs: 500 }
  );
  assert.equal(emptyInspection.ok, false);
  assert.match(emptyInspection.error, /inspectionEvidence\.relevantPaths must contain between 1 and 30 items/);

  const diagnoseContract = defaultToolSkillRegistry.getSkill('code.diagnose').contract;
  response = JSON.stringify({
    diagnosis: {
      summary: 'Diagnosis',
      cause: 'Cause',
      relevantPaths: ['src/other.js'],
      recommendedChange: 'Change one bounded behavior.',
      risks: []
    }
  });
  const ungroundedDiagnosis = await executor.execute({
    skill: 'code.diagnose',
    goal: 'diagnose',
    contract: diagnoseContract,
    context: {
      priorEvidence: {
        'inspect-project': {
          inspectionEvidence: {
            summary: 'Inspected',
            relevantPaths: ['src/core.js'],
            findings: ['Grounded finding']
          }
        }
      }
    }
  }, { workspace: '/safe/workspace', timeoutMs: 500 });
  assert.equal(ungroundedDiagnosis.ok, false);
  assert.match(ungroundedDiagnosis.error, /diagnosis_references_uninspected_path/);
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


test('read-only skill executor blocks native Windows and requires WSL before constructing Codex', async () => {
  let constructed = 0;
  class FakeCodex { constructor() { constructed += 1; } }
  const executor = new CodexReadOnlySkillExecutor({ CodexClient: FakeCodex, platform: 'win32', environment: () => ({ PATH: 'C:\\safe' }) });
  const contract = defaultToolSkillRegistry.getSkill('code.inspect').contract;
  const result = await executor.execute({ skill: 'code.inspect', goal: 'inspect', contract }, { workspace: 'C:\\workspace', timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'codex_worker_native_windows_isolation_unverified_use_wsl');
  assert.equal(constructed, 0);
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
