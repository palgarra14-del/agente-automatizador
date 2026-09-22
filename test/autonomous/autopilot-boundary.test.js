import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTONOMOUS_MAINTENANCE_SCOPE } from '../../src/self-improvement.js';

test('autonomous regression directory is discovered and root-of-trust files stay forbidden', () => {
  assert.ok(AUTONOMOUS_MAINTENANCE_SCOPE.allowedPaths.includes('test/autonomous'));
  for (const path of [
    'src/self-improvement.js',
    'src/core.js',
    'src/cloud-state.js',
    'src/cloud-workflow-engine.js',
    'src/cli.js',
    'src/issue-queue.js',
    'src/capabilities.js',
    'src/specialists.js'
  ]) {
    assert.ok(AUTONOMOUS_MAINTENANCE_SCOPE.forbiddenPaths.includes(path), path);
  }
});
