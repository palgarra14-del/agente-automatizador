import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { createWorkflowPlan, loadProjects } from '../src/core.js';
import { defaultToolSkillRegistry } from '../src/capabilities.js';

test('website pilot is registered for the full governed website-build workflow', async () => {
  const projects = await loadProjects(join(process.cwd(), 'config', 'projects.json'));
  const project = projects.get('website-pilot');

  assert.ok(project);
  assert.deepEqual(project.repository, { owner: 'palgarra14-del', name: 'Zasert' });
  assert.equal(project.workspaceStrategy, 'managed');
  assert.equal(project.execution.provider, 'container-required');
  assert.equal(project.execution.image, 'agent-node22-pnpm11:local');
  assert.deepEqual(
    ['test', 'typecheck', 'lint', 'build'].map((name) => Boolean(project.commands[name])),
    [true, true, true, true]
  );
  assert.deepEqual(project.commands, {
    test: 'node --test test/website.test.js',
    typecheck: 'node --check assets/site.js',
    lint: 'node --check test/website.test.js',
    build: 'node --test test/website.test.js',
    dependencyRefresh: 'npm ci --ignore-scripts'
  });
  for (const command of ['test', 'typecheck', 'lint', 'build']) {
    assert.equal(project.commands[command].includes('scripts/check-static.mjs'), false);
    assert.equal(project.commands[command].includes('generate-services.mjs'), false);
  }
  assert.equal(project.deployment.provider, 'vercel');
  assert.equal(project.deployment.projectId, 'prj_JWGFirkcQg3pmNFOdyoTRAArYCVK');
  assert.equal(project.deployment.requirePreviewReady, true);

  for (const skill of ['website.plan', 'code.implement', 'code.review', 'project.verify', 'release.publish-reviewed-workflow']) {
    assert.equal(defaultToolSkillRegistry.resolve(project, skill, { surface: 'workflow' }).available, true, skill);
  }

  const plan = createWorkflowPlan({
    profile: 'website-build',
    project,
    goal: 'Build a professional local-business pilot',
    input: {
      businessBrief: {
        version: 2,
        commercialPackage: 'essential',
        businessName: 'Negocio Piloto',
        category: 'Servicios',
        locations: ['Madrid'],
        services: [{ name: 'Servicio principal' }]
      }
    },
    scope: { allowedPaths: ['index.html', 'servicios'], forbiddenPaths: ['vercel.json'] }
  });

  assert.equal(plan.profile, 'website-build');
  assert.match(plan.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'requirements', 'design', 'implementation', 'dependency-refresh', 'review',
    'quality', 'release-readiness', 'publication', 'browser-verification', 'visual-verification'
  ]);
});
