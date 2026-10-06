import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowPlan } from '../src/core.js';
import { defaultToolSkillRegistry } from '../src/capabilities.js';
import { defaultSpecialistRegistry } from '../src/specialists.js';

function websiteProject() {
  return {
    id: 'browser-qa-site',
    workspaceStrategy: 'managed',
    commands: {
      test: 'node --test',
      typecheck: 'node --check app.js',
      lint: 'node --check app.js',
      build: 'node --check app.js'
    },
    budgets: { maxModelCalls: 6 },
    skills: {
      allow: ['visual.review'],
      deny: []
    }
  };
}

test('visual.review is an active workflow capability backed by Browser QA', () => {
  const project = websiteProject();
  const resolution = defaultToolSkillRegistry.resolve(project, 'visual.review', { surface: 'workflow' });
  assert.equal(resolution.available, true);
  assert.equal(resolution.risk, 'network-read');
  assert.deepEqual(resolution.tools.map((tool) => ({
    id: tool.id,
    binding: tool.binding,
    surfaceBound: tool.surfaceBound
  })), [{
    id: 'browser-visual',
    binding: 'BrowserQaCoordinator',
    surfaceBound: true
  }]);

  const specialist = defaultSpecialistRegistry.get('visual-reviewer');
  assert.equal(specialist.mode, 'read-only');
  assert.equal(specialist.authority, 'network-read');
  assert.equal(specialist.executor, 'BrowserQaCoordinator');
  assert.deepEqual(specialist.skills, ['visual.review']);
});

test('website-build inserts Browser QA between publication and human visual approval', () => {
  const project = websiteProject();
  const plan = createWorkflowPlan({
    profile: 'website-build',
    project,
    goal: 'Build and verify a local business website',
    input: {
      businessBrief: {
        version: 1,
        businessName: 'Peluquería QA',
        category: 'peluquería',
        locations: ['Cuenca'],
        services: ['Corte']
      }
    }
  });

  const browser = plan.steps.find((step) => step.id === 'browser-verification');
  const visual = plan.steps.find((step) => step.id === 'visual-verification');
  assert.ok(browser);
  assert.equal(browser.type, 'placeholder');
  assert.equal(browser.skill, 'visual.review');
  assert.equal(browser.specialist, 'visual-reviewer');
  assert.deepEqual(browser.dependsOn, ['publication']);
  assert.deepEqual(visual.dependsOn, ['browser-verification']);
  assert.ok(plan.definitionOfDone.some((requirement) =>
    requirement.id === 'browserQaPassed' &&
    requirement.steps.length === 1 &&
    requirement.steps[0] === 'browser-verification'
  ));
});
