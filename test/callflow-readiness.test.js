import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { evaluateChangePolicy, loadProjects } from '../src/core.js';

test('Callflow is registered as a governed isolated project', async () => {
  const projects = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  const callflow = projects.get('callflow');

  assert.ok(callflow);
  assert.deepEqual(callflow.repository, { owner: 'palgarra14-del', name: 'App-llamadas' });
  assert.equal(callflow.defaultBranch, 'main');
  assert.equal(callflow.workspaceStrategy, 'managed');
  assert.equal(callflow.execution.provider, 'container-required');
  assert.equal(callflow.execution.image, 'agent-node22-pnpm11:local');
  assert.equal(callflow.commands.test, 'npm test');
  assert.equal(callflow.commands.typecheck, 'node --check prospect-utils.js');
  assert.equal(callflow.commands.lint, 'node --check prospect.js');
  assert.equal(callflow.commands.build, 'node --check app.js');
  assert.deepEqual(callflow.acceptance.require, ['test', 'typecheck', 'lint', 'build', 'ci', 'deployment']);
  assert.equal(callflow.deployment.provider, 'vercel');
  assert.equal(callflow.deployment.requirePreviewReady, true);
  assert.match(callflow.pullRequest.titleTemplate, /^Agent:/);
});

test('Callflow policy blocks production-linked Apps Script paths and gates backend configuration', async () => {
  const projects = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  const callflow = projects.get('callflow');

  for (const path of ['google-apps-script/Code.gs', '.clasp.json']) {
    const decision = evaluateChangePolicy(callflow, { paths: [path], changedFiles: 1, diffLines: 1 });
    assert.equal(decision.ok, false, path);
    assert.match(decision.reason, /^forbidden_path:/);
  }

  for (const path of ['api/leadfinder/search.js', 'config.js', '.claspignore']) {
    const decision = evaluateChangePolicy(callflow, { paths: [path], changedFiles: 1, diffLines: 1 });
    assert.equal(decision.ok, true, path);
    assert.equal(decision.classification, 'sensitive', path);
  }

  const ui = evaluateChangePolicy(callflow, { paths: ['app.js', 'styles.css'], changedFiles: 2, diffLines: 80 });
  assert.equal(ui.ok, true);
  assert.equal(ui.classification, 'normal');

  const tooLarge = evaluateChangePolicy(callflow, { paths: ['app.js'], changedFiles: 1, diffLines: 401 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'change_budget_exceeded');
});
