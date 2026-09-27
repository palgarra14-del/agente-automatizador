import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const projects = JSON.parse(readFileSync(new URL('../../config/projects.json', import.meta.url), 'utf8'));
const cli = readFileSync(new URL('../../src/cli.js', import.meta.url), 'utf8');

test('self-maintenance has enough bounded runtime to finish on the local runner', () => {
  const self = projects.projects.find((project) => project.id === 'self');
  assert.ok(self);
  assert.equal(self.budgets.maxRuntimeMinutes, 18);
  assert.ok(self.budgets.maxRuntimeMinutes < 20);
});

test('cloud autonomous improvement selects policy by lane and uses that project runtime budget', () => {
  assert.match(cli, /autonomousPolicyForLane\(cloudLane\.id\)/);
  assert.match(
    cli,
    /workflowTimeoutMs:\s*projects\.get\(autonomousPolicy\.projectId\)\.budgets\.maxRuntimeMinutes \* 60_000/
  );
});
