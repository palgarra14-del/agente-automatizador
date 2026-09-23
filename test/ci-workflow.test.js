import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const deepIf = "if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false";

test('CI runs fast verification on draft updates and re-triggers when a PR becomes ready', () => {
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(workflow, /- run: npm ci\n\s+- run: npm test\n\s+- run: npm run typecheck\n\s+- run: npm run lint\n\s+- run: npm run build/);
});

test('expensive browser and Docker gates run only for final review or explicit dispatch', () => {
  for (const name of [
    'Smoke real Chrome/CDP Browser QA runtime',
    'Adversarial Browser QA Chrome smoke',
    'Build prepared Node 22 / pnpm 11.19.0 image',
    'Verify real Docker execution boundary'
  ]) {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start >= 0, `missing deep check: ${name}`);
    const next = workflow.indexOf('\n      - ', start + 1);
    const block = workflow.slice(start, next >= 0 ? next : workflow.length);
    assert.ok(block.includes(deepIf), `deep check is not review-gated: ${name}`);
  }
  assert.equal(workflow.split(deepIf).length - 1, 4);
});

test('draft-aware CI does not grant write or secret authority', () => {
  assert.doesNotMatch(workflow, /permissions:[\s\S]*write|secrets\.|GITHUB_TOKEN|AGENT_GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY/);
});
