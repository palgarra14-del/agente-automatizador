import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('draft pull requests allocate no hosted CI runner', () => {
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(workflow, /verify:\n\s+if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.draft == false/);
});

test('superseded CI runs are cancelled and final candidates keep the full deep gate', () => {
  assert.match(workflow, /concurrency:\n\s+group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n\s+cancel-in-progress: true/);
  for (const item of [
    'npm ci',
    'npm test',
    'npm run typecheck',
    'npm run lint',
    'npm run build',
    'Smoke real Chrome/CDP Browser QA runtime',
    'Adversarial Browser QA Chrome smoke',
    'Build prepared Node 22 / pnpm 11.19.0 image',
    'Verify real Docker execution boundary'
  ]) assert.ok(workflow.includes(item), item);
});

test('budget guard adds no write or secret authority', () => {
  assert.doesNotMatch(workflow, /permissions:[\s\S]*write|secrets\.|GITHUB_TOKEN|AGENT_GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY/);
});
