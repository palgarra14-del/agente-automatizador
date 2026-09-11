import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultToolSkillRegistry } from '../src/capabilities.js';
import { SpecialistRegistry, defaultSpecialistRegistry, defaultSpecialists } from '../src/specialists.js';

test('specialist registry fingerprint is deterministic across declaration order', () => {
  const left = new SpecialistRegistry({ specialists: defaultSpecialists, capabilityRegistry: defaultToolSkillRegistry });
  const right = new SpecialistRegistry({ specialists: [...defaultSpecialists].reverse(), capabilityRegistry: defaultToolSkillRegistry });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.deepEqual(left.contractSnapshot(), right.contractSnapshot());
});

test('specialist registry rejects duplicate ids, invalid modes, and unknown skills', () => {
  assert.throws(
    () => new SpecialistRegistry({ specialists: [defaultSpecialists[0], defaultSpecialists[0]], capabilityRegistry: defaultToolSkillRegistry }),
    /Duplicate specialist id/
  );
  assert.throws(
    () => new SpecialistRegistry({ specialists: [{ id: 'bad-mode', mode: 'root', skills: ['code.inspect'], authority: 'workspace-read' }], capabilityRegistry: defaultToolSkillRegistry }),
    /mode is invalid/
  );
  assert.throws(
    () => new SpecialistRegistry({ specialists: [{ id: 'bad-skill', mode: 'read-only', skills: ['missing.skill'], authority: 'workspace-read' }], capabilityRegistry: defaultToolSkillRegistry }),
    /unknown skill/
  );
});

test('specialist assignment is explicit and fail-closed', () => {
  const inspector = defaultSpecialistRegistry.validateAssignment('code-inspector', 'code.inspect');
  assert.equal(inspector.mode, 'read-only');
  assert.equal(inspector.executor, 'CodexReadOnlySkillExecutor');
  assert.throws(() => defaultSpecialistRegistry.validateAssignment('code-inspector', 'code.implement'), /not authorized/);
  assert.throws(() => defaultSpecialistRegistry.validateAssignment('missing-specialist', 'code.inspect'), /Unknown specialist/);
});

test('specialist fingerprint ignores descriptions but changes when authority or skill assignment changes', () => {
  const described = new SpecialistRegistry({
    specialists: defaultSpecialists.map((specialist) => ({ ...specialist, description: `changed: ${specialist.description}` })),
    capabilityRegistry: defaultToolSkillRegistry
  });
  assert.equal(described.fingerprint, defaultSpecialistRegistry.fingerprint);

  const changed = new SpecialistRegistry({
    specialists: defaultSpecialists.map((specialist) => specialist.id === 'code-inspector'
      ? { ...specialist, authority: 'different-authority' }
      : specialist),
    capabilityRegistry: defaultToolSkillRegistry
  });
  assert.notEqual(changed.fingerprint, defaultSpecialistRegistry.fingerprint);
});

test('specialist report preserves capability policy instead of granting permissions', () => {
  const project = {
    id: 'fixture',
    skills: {
      allow: ['code.inspect'],
      deny: ['code.review']
    }
  };
  const report = defaultSpecialistRegistry.report(project);
  const inspector = report.specialists.find((specialist) => specialist.id === 'code-inspector');
  const critic = report.specialists.find((specialist) => specialist.id === 'change-critic');
  assert.equal(inspector.skills[0].capability.available, true);
  assert.equal(critic.skills[0].capability.available, false);
  assert.equal(critic.skills[0].capability.reason, 'skill_not_allowed');
  assert.equal(report.specialistRegistryFingerprint, defaultSpecialistRegistry.fingerprint);
});

test('specialist registry internals are not exposed for mutation', () => {
  const registry = new SpecialistRegistry({ specialists: defaultSpecialists, capabilityRegistry: defaultToolSkillRegistry });
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.hasOwn(registry, 'specialists'), false);
  const original = registry.fingerprint;
  assert.throws(() => { registry.fingerprint = 'tampered'; }, TypeError);
  assert.equal(registry.fingerprint, original);
});
