import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('CI skips draft synchronize churn and cancels superseded runs', () => {
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(workflow, /concurrency:\n\s+group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n\s+cancel-in-progress: true/);
  const draftStart = workflow.indexOf('  draft-smoke:');
  const verifyStart = workflow.indexOf('  verify:');
  assert.ok(draftStart >= 0 && verifyStart > draftStart);
  const draft = workflow.slice(draftStart, verifyStart);
  assert.match(draft, /github\.event\.pull_request\.draft == true/);
  assert.match(draft, /github\.event\.action == 'opened' \|\| github\.event\.action == 'reopened'/);
  assert.doesNotMatch(draft, /github\.event\.action == 'synchronize'/);
  assert.match(draft, /runs-on: ubuntu-slim/);
  assert.match(draft, /timeout-minutes: 15/);
});

test('ready and manually dispatched candidates receive the complete deep gate', () => {
  const verifyStart = workflow.indexOf('  verify:');
  assert.ok(verifyStart >= 0);
  const verify = workflow.slice(verifyStart);
  assert.match(verify, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.draft == false/);
  assert.match(verify, /runs-on: ubuntu-latest/);
  for (const command of ['npm ci', 'npm test', 'npm run typecheck', 'npm run lint', 'npm run build']) {
    assert.ok(verify.includes(`- run: ${command}`), `missing deep command: ${command}`);
  }
  for (const name of [
    'Smoke real Chrome/CDP Browser QA runtime',
    'Adversarial Browser QA Chrome smoke',
    'Build prepared Node 22 / pnpm 11.19.0 image',
    'Verify real Docker execution boundary'
  ]) {
    assert.ok(verify.includes(`- name: ${name}`), `missing deep check: ${name}`);
  }
});

test('draft-aware CI does not grant write or secret authority', () => {
  assert.doesNotMatch(workflow, /permissions:[\s\S]*write|secrets\.|GITHUB_TOKEN|AGENT_GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY/);
});
