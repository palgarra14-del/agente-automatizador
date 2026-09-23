import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const core = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/agent-cloud.yml', import.meta.url), 'utf8');

test('cloud control can load core without a static Codex SDK dependency', () => {
  assert.doesNotMatch(core, /from ['"]@openai\/codex-sdk['"]/);
  assert.match(core, /import\(['"]@openai\/codex-sdk['"]\)\.then\(\(module\) => module\.Codex\)/);
  assert.equal((core.match(/CodexClient = null/g) ?? []).length, 2);
  assert.equal((core.match(/this\.CodexClient \?\? await loadDefaultCodexClient\(\)/g) ?? []).length, 2);
});

test('cloud workflow installs dependencies only after executable work is proven', () => {
  assert.equal((workflow.match(/npm ci --ignore-scripts/g) ?? []).length, 1);
  const admitStart = workflow.indexOf('  admit:');
  const recoverStart = workflow.indexOf('  recover:');
  const cloudStart = workflow.indexOf('  cloud-once:');
  assert.ok(admitStart >= 0 && recoverStart > admitStart && cloudStart > recoverStart);
  assert.doesNotMatch(workflow.slice(admitStart, recoverStart), /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow.slice(recoverStart, cloudStart), /npm ci --ignore-scripts/);

  const controlStart = workflow.indexOf('- name: Run lightweight cloud control tick', cloudStart);
  const preflightStart = workflow.indexOf('- name: Check lane for executable work', cloudStart);
  const installStart = workflow.indexOf('- name: Install frozen dependencies for executable work', cloudStart);
  const runtimeStart = workflow.indexOf('- name: Prepare exact cloud runtime', cloudStart);
  assert.ok(controlStart > cloudStart && preflightStart > controlStart && installStart > preflightStart && runtimeStart > installStart);
  const preInstall = workflow.slice(cloudStart, installStart);
  assert.doesNotMatch(preInstall, /npm ci --ignore-scripts/);
  const installBlock = workflow.slice(installStart, runtimeStart);
  assert.match(installBlock, /if: steps\.preflight\.outputs\.has_work == 'true'/);
  assert.match(installBlock, /run: npm ci --ignore-scripts/);
});

test('lightweight cloud phases do not receive model or cross-repository secrets', () => {
  const cloudStart = workflow.indexOf('  cloud-once:');
  const installStart = workflow.indexOf('- name: Install frozen dependencies for executable work', cloudStart);
  const light = workflow.slice(0, installStart);
  assert.doesNotMatch(light, /^\s*AGENT_GITHUB_TOKEN:/m);
  assert.doesNotMatch(light, /^\s*CODEX_API_KEY:/m);
});
