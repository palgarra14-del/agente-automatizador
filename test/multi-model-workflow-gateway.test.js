import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  MultiModelCodingWorker,
  MultiModelGatewayClient,
  MultiModelReadOnlySkillExecutor
} from '../src/core.js';

test('multi-model gateway hardens child environment to free-only and strips orchestrator credentials', async () => {
  let observed = null;
  const client = new MultiModelGatewayClient({
    environment: {
      HOME: '/home/test',
      PATH: '/usr/bin:/bin',
      GITHUB_TOKEN: 'ghs_should_never_cross_boundary_1234567890',
      AGENT_GITHUB_TOKEN: 'ghs_agent_should_never_cross_boundary_1234567890',
      OPENAI_API_KEY: 'sk-should-never-cross-boundary-1234567890',
      CODEX_API_KEY: 'codex-should-never-cross-boundary-1234567890',
      OLLAMA_MODEL: 'qwen2.5-coder:3b'
    },
    gatewayPath: '/repo/scripts/model-gateway.py',
    processRunner: async (command, args, options) => {
      observed = { command, args, options };
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          candidate: 'ag-gemini-3.8-flash',
          family: 'google',
          provider: 'antigravity',
          model: 'gemini-3.8-flash-high',
          routingScore: 1,
          fallbackErrors: [],
          result: { stdout: 'done' }
        }),
        stderr: '',
        timedOut: false
      };
    }
  });

  const result = await client.edit({
    role: 'long_horizon_implementation',
    prompt: 'Implement one bounded change.'
  }, {
    workspace: '/tmp/workspace',
    timeoutMs: 120_000
  });

  assert.equal(result.modelRouting.candidate, 'ag-gemini-3.8-flash');
  assert.equal(observed.command, 'python3');
  assert.deepEqual(observed.args, ['/repo/scripts/model-gateway.py']);
  assert.equal(observed.options.cwd, '/tmp/workspace');
  assert.equal(observed.options.restrictEnvironment, true);
  assert.equal(observed.options.env.MODEL_COST_POLICY, 'free_only');
  assert.equal(observed.options.env.PAID_MODELS_EXPLICITLY_ENABLED, '0');
  assert.equal(observed.options.env.OPENAI_API_KEY, '');
  assert.equal(observed.options.env.CODEX_API_KEY, '');
  assert.equal(Object.hasOwn(observed.options.env, 'GITHUB_TOKEN'), false);
  assert.equal(Object.hasOwn(observed.options.env, 'AGENT_GITHUB_TOKEN'), false);
  assert.equal(observed.options.env.OLLAMA_MODEL, 'qwen2.5-coder:3b');
  const request = JSON.parse(observed.options.input);
  assert.equal(request.action, 'edit');
  assert.equal(request.role, 'long_horizon_implementation');
});

test('coding worker gives website work to frontend routing and app work to long-horizon routing', async () => {
  const calls = [];
  const gateway = {
    async edit(request) {
      calls.push(request);
      return {
        result: { stdout: 'ok' },
        modelRouting: {
          mode: 'free-multimodel',
          candidate: request.role === 'frontend_implementation' ? 'ag-sonnet-4.6' : 'ag-gemini-3.8-flash',
          family: request.role === 'frontend_implementation' ? 'anthropic' : 'google',
          provider: 'antigravity',
          model: 'fixture'
        }
      };
    }
  };
  let fingerprint = 0;
  const worker = new MultiModelCodingWorker({
    gateway,
    allowSessionFallback: false,
    controlSurface: async () => {},
    workspaceFingerprint: async () => String(fingerprint++)
  });

  const website = await worker.execute({
    objective: 'Improve the page.',
    projectId: 'website-pilot',
    workflow: { profile: 'autonomous-maintenance' },
    scope: {}
  }, { workspace: '/tmp/site', timeoutMs: 120_000 });
  const callflow = await worker.execute({
    objective: 'Improve the CRM.',
    projectId: 'callflow',
    workflow: { profile: 'autonomous-maintenance' },
    scope: {}
  }, { workspace: '/tmp/callflow', timeoutMs: 120_000 });

  assert.equal(calls[0].role, 'frontend_implementation');
  assert.equal(calls[1].role, 'long_horizon_implementation');
  assert.equal(website.modelRouting.candidate, 'ag-sonnet-4.6');
  assert.equal(callflow.modelRouting.candidate, 'ag-gemini-3.8-flash');
  assert.equal(website.paidApiUsed, false);
  assert.equal(callflow.paidApiUsed, false);
});

test('independent review excludes the implementation family from multimodel routing', async () => {
  let observed = null;
  const gateway = {
    async structured(request) {
      observed = request;
      return {
        value: {
          reviewEvidence: {
            verdict: 'PASS',
            summary: 'No material issue found.',
            findings: []
          }
        },
        modelRouting: {
          mode: 'free-multimodel',
          candidate: 'ag-opus-4.6',
          family: 'anthropic',
          provider: 'antigravity',
          model: 'claude-opus-4-6-thinking'
        }
      };
    }
  };
  const executor = new MultiModelReadOnlySkillExecutor({
    gateway,
    allowSessionFallback: false,
    controlSurface: async () => {}
  });

  const result = await executor.execute({
    skill: 'code.review',
    goal: 'Review the bounded implementation.',
    contract: {
      version: 2,
      inputs: ['project'],
      outputs: ['reviewEvidence']
    },
    context: {
      modelRouting: {
        excludedFamilies: ['google']
      }
    }
  }, {
    workspace: '/tmp/review',
    timeoutMs: 120_000
  });

  assert.equal(observed.role, 'independent_review');
  assert.deepEqual(observed.excludedFamilies, ['google']);
  assert.deepEqual(observed.schema.required, ['reviewEvidence']);
  assert.equal(result.modelRouting.family, 'anthropic');
  assert.equal(result.paidApiUsed, false);
});

test('website planning uses the creative lead rather than the generic research route', async () => {
  let observed = null;
  const gateway = {
    async structured(request) {
      observed = request;
      return {
        value: {
          websitePlan: {
            summary: 'A',
            pages: [{ slug: '/', title: 'Home', purpose: 'Convert', sections: ['Hero'] }],
            design: { direction: 'Editorial', tone: 'Confident', colors: ['#111111'], typography: 'Display plus sans' },
            conversion: { primaryCta: 'Reserva', secondaryCta: null },
            seo: { primaryLocation: null, keywords: [] },
            implementation: { priorities: ['Hero'], constraints: [] },
            missingInputs: []
          }
        },
        modelRouting: {
          mode: 'free-multimodel',
          candidate: 'ag-sonnet-4.6',
          family: 'anthropic',
          provider: 'antigravity',
          model: 'claude-sonnet-4-6'
        }
      };
    }
  };
  const executor = new MultiModelReadOnlySkillExecutor({
    gateway,
    allowSessionFallback: false,
    controlSurface: async () => {}
  });

  const result = await executor.execute({
    skill: 'website.plan',
    goal: 'Plan the website.',
    contract: { version: 1, inputs: ['project'], outputs: ['websitePlan'] },
    context: {}
  }, { workspace: '/tmp/site', timeoutMs: 120_000 });

  assert.equal(observed.role, 'creative_direction');
  assert.equal(result.modelRouting.candidate, 'ag-sonnet-4.6');
});

test('CLI wires the free multimodel executors into local and durable workflow engines', () => {
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /new MultiModelReadOnlySkillExecutor\(\{ allowSessionFallback: false \}\)/);
  assert.match(cli, /new MultiModelCodingWorker\(\{ allowSessionFallback: false \}\)/);
  assert.match(cli, /new WorkflowEngine\(\{ store, projects, \.\.\.workflowModelExecutors \}\)/);
  assert.match(cli, /new DurableCloudWorkflowEngine\(\{ store: activeStore, projects, \.\.\.workflowModelExecutors \}\)/);
});

test('python workflow gateway is a hard free-only boundary', () => {
  const gateway = readFileSync(new URL('../scripts/model-gateway.py', import.meta.url), 'utf8');
  assert.match(gateway, /MODEL_COST_POLICY.*free_only/);
  assert.match(gateway, /PAID_MODELS_EXPLICITLY_ENABLED.*0/);
  assert.match(gateway, /CODEX_API_KEY.*""/);
  assert.match(gateway, /OPENAI_API_KEY.*""/);
  assert.match(gateway, /MAX_STDIN_BYTES = 1536 \* 1024/);
  assert.match(gateway, /gateway_prompt", 1_200_000/);
  assert.match(gateway, /use_role_agent=False/);
});

test('coding worker falls back to a bounded local patch when direct free editing makes no changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-patch-worker-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'feature.ts'), 'export const value = 1;\n');
    const fingerprints = ['clean', 'clean', 'patched'];
    let structuredRequest = null;
    const gateway = {
      async edit() {
        return {
          result: { stdout: 'done without edits' },
          modelRouting: { mode: 'free-multimodel', candidate: 'ag-gemini-3.8-flash', family: 'google', provider: 'antigravity', model: 'fixture' }
        };
      },
      async structured(request) {
        structuredRequest = request;
        return {
          value: {
            summary: 'Raise the fixture value.',
            edits: [{ path: 'src/feature.ts', search: 'export const value = 1;', replace: 'export const value = 2;' }]
          },
          modelRouting: { mode: 'free-multimodel', candidate: 'ollama-qwen-7b', family: 'qwen-local', provider: 'ollama', model: 'qwen2.5-coder:7b' }
        };
      }
    };
    const worker = new MultiModelCodingWorker({
      gateway,
      allowSessionFallback: false,
      controlSurface: async () => {},
      workspaceFingerprint: async () => fingerprints.shift()
    });
    const result = await worker.execute({
      objective: 'Raise the fixture value.',
      projectId: 'leadfinder',
      workflow: { profile: 'autonomous-maintenance' },
      scope: { allowedPaths: ['src'], forbiddenPaths: [] },
      diagnosis: { diagnosis: { relevantPaths: ['src/feature.ts'] } }
    }, { workspace: root, timeoutMs: 120_000 });

    assert.equal(result.status, 'completed');
    assert.equal(result.modelRouting.mode, 'free-multimodel-local-patch');
    assert.equal(result.modelRouting.candidate, 'ollama-qwen-7b');
    assert.equal(structuredRequest.role, 'local_patch');
    assert.deepEqual(structuredRequest.schema.required, ['summary', 'edits']);
    assert.match(await readFile(join(root, 'src', 'feature.ts'), 'utf8'), /value = 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coding worker never routes to another model after a direct provider fails with workspace changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'partial-edit-worker-'));
  try {
    let structuredCalls = 0;
    const fingerprints = ['clean', 'dirty'];
    const worker = new MultiModelCodingWorker({
      gateway: {
        async edit() { throw new Error('provider failed after editing'); },
        async structured() { structuredCalls += 1; throw new Error('must not run'); }
      },
      allowSessionFallback: false,
      controlSurface: async () => {},
      workspaceFingerprint: async () => fingerprints.shift()
    });
    const result = await worker.execute({
      objective: 'Change one file.',
      projectId: 'callflow',
      workflow: { profile: 'autonomous-maintenance' },
      scope: { allowedPaths: ['src'], forbiddenPaths: [] },
      diagnosis: { diagnosis: { relevantPaths: ['src/a.ts'] } }
    }, { workspace: root, timeoutMs: 120_000 });

    assert.equal(result.status, 'failed');
    assert.equal(structuredCalls, 0);
    assert.match(result.output, /direct_model_failed_after_workspace_change/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local patch fallback rejects edits outside the diagnosis-bound authorized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unauthorized-patch-worker-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'feature.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'README.md'), 'safe\n');
    const fingerprints = ['clean', 'clean'];
    const worker = new MultiModelCodingWorker({
      gateway: {
        async edit() { throw new Error('quota exhausted'); },
        async structured() {
          return {
            value: {
              summary: 'Bad route.',
              edits: [{ path: 'README.md', search: 'safe', replace: 'unsafe' }]
            },
            modelRouting: { mode: 'free-multimodel', candidate: 'ollama-qwen-7b', family: 'qwen-local', provider: 'ollama', model: 'qwen2.5-coder:7b' }
          };
        }
      },
      allowSessionFallback: false,
      controlSurface: async () => {},
      workspaceFingerprint: async () => fingerprints.shift()
    });
    const result = await worker.execute({
      objective: 'Change the feature.',
      projectId: 'leadfinder',
      workflow: { profile: 'autonomous-maintenance' },
      scope: { allowedPaths: ['src'], forbiddenPaths: [] },
      diagnosis: { diagnosis: { relevantPaths: ['src/feature.ts'] } }
    }, { workspace: root, timeoutMs: 120_000 });

    assert.equal(result.status, 'failed');
    assert.match(result.output, /local_patch_path_not_authorized:README\.md/);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'safe\n');
    assert.equal(await readFile(join(root, 'src', 'feature.ts'), 'utf8'), 'export const value = 1;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
