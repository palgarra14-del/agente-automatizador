import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { boundedWorkflowDeadlineAt } from '../src/core.js';

test('workflow deadline cap bounds refreshed execution without changing uncapped behavior', () => {
  const now = 1_000_000;
  const timeout = 25 * 60 * 1000;
  assert.equal(boundedWorkflowDeadlineAt(now, timeout), now + timeout);
  assert.equal(
    boundedWorkflowDeadlineAt(now, timeout, now + 10 * 60 * 1000),
    now + 10 * 60 * 1000
  );
  assert.equal(
    boundedWorkflowDeadlineAt(now, timeout, now + 30 * 60 * 1000),
    now + timeout
  );
});

test('workflow deadline cap fails closed on invalid deadline inputs', () => {
  assert.throws(() => boundedWorkflowDeadlineAt(0, 1_000, 0), /workflow_deadline_cap_invalid/);
  assert.throws(() => boundedWorkflowDeadlineAt(0, 1_000, Number.NaN), /workflow_deadline_cap_invalid/);
  assert.throws(() => boundedWorkflowDeadlineAt(Number.NaN, 1_000), /workflow_deadline_inputs_invalid/);
});

test('WorkflowEngine refresh applies the bounded deadline inside runUnlocked', () => {
  const core = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  assert.match(core, /runUnlocked\(id, \{ dryRun = false, refreshPristineDeadline = false, deadlineCapAt = null \} = \{\}\)/);
  assert.match(
    core,
    /saved\.deadlineAt = boundedWorkflowDeadlineAt\(this\.now\(\), saved\.budgets\.timeoutMs, deadlineCapAt\)/
  );
});
