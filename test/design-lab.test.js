import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/design-lab/website-design-training-lab.py');

function python(body, args = []) {
  const source = `
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location("design_lab", ${JSON.stringify(script)})
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${body}
`;
  const run = spawnSync('python3', ['-c', source, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

function strongEntry(index, patch = {}) {
  const scores = {
    identity: 9.3, hierarchy: 9.3, typography: 9.3, composition: 9.3,
    authenticity: 9.3, conversion: 9.3, mobile: 9.3, polish: 9.3
  };
  return {
    phase: 'training',
    briefSlug: ['a','b','c','d','e','f'][index % 6],
    completedAt: `2026-09-${String(10 + index).padStart(2,'0')}T10:00:00+00:00`,
    finalScore: 9.3,
    minCategory: 9.3,
    buildSeconds: 480,
    deterministicQaPass: true,
    verdict: 'PASS',
    conceptIdentity: `signature ${['alba','bruma','cobre','duna','esfera','fuego'][index % 6]}`,
    categoryScores: scores,
    ...patch
  };
}

test('design lab requires unseen holdouts after a qualifying training streak', () => {
  const training = Array.from({ length: 6 }, (_, i) => strongEntry(i));
  const result = python(`
entries=json.loads(sys.argv[1])
candidate,recent,qualified=m.training_mastery_candidate(entries)
before,_=m.mastery_status(entries)
h1={"phase":"holdout","briefSlug":"holdout-fisioterapia","completedAt":"2026-09-20T10:00:00+00:00","finalScore":9.4,"minCategory":9.1,"buildSeconds":420,"deterministicQaPass":True,"verdict":"PASS","categoryScores":{k:9.3 for k in m.SCORE_WEIGHTS}}
h2={**h1,"briefSlug":"holdout-carpinteria","completedAt":"2026-09-21T10:00:00+00:00"}
after_one,_=m.mastery_status(entries+[h1])
after_two,evidence=m.mastery_status(entries+[h1,h2])
print(json.dumps({"candidate":candidate,"before":before,"afterOne":after_one,"afterTwo":after_two,"evidence":len(evidence),"qualified":qualified}))
`, [JSON.stringify(training)]);
  assert.equal(result.candidate, true);
  assert.equal(result.before, false);
  assert.equal(result.afterOne, false);
  assert.equal(result.afterTwo, true);
  assert.equal(result.evidence, 8);
});

test('failed holdout invalidates qualification until a fresh training streak exists', () => {
  const training = Array.from({ length: 6 }, (_, i) => strongEntry(i));
  const failed = {
    phase: 'holdout',
    briefSlug: 'holdout-fisioterapia',
    completedAt: '2026-09-20T10:00:00+00:00',
    finalScore: 8.7,
    minCategory: 8.1,
    buildSeconds: 430,
    deterministicQaPass: true,
    verdict: 'IMPROVE',
    categoryScores: Object.fromEntries(Object.keys(strongEntry(0).categoryScores).map(k => [k, 8.7]))
  };
  const result = python(`
entries=json.loads(sys.argv[1])
candidate,recent,qualified=m.training_mastery_candidate(entries)
mastered,_=m.mastery_status(entries)
print(json.dumps({"candidate":candidate,"mastered":mastered,"recent":len(recent),"qualified":qualified}))
`, [JSON.stringify([...training, failed])]);
  assert.equal(result.candidate, false);
  assert.equal(result.mastered, false);
  assert.equal(result.recent, 0);
  assert.equal(result.qualified, null);
});

test('static design audit rejects template-breaking technical defects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-lab-audit-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<html><head><title>X</title></head><body><h1>X</h1><button aria-label=""></button></body></html>');
    writeFileSync(join(dir, 'design-intent.json'), '{}');
    const result = python(`
from pathlib import Path
r=m.static_quality_audit(Path(sys.argv[1]))
print(json.dumps(r))
`, [dir]);
    assert.equal(result.pass, false);
    assert.ok(result.defects.includes('missing_or_invalid_design_intent'));
    assert.ok(result.defects.includes('missing_document_language'));
    assert.ok(result.defects.includes('missing_main_landmark'));
    assert.ok(result.defects.includes('missing_viewport_meta'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('static design audit requires a real synthetic conversion path and accepts exact tel CTA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-lab-conversion-'));
  try {
    writeFileSync(join(dir, 'brief.txt'), JSON.stringify({
      syntheticContact: { phone: '+34000000000', email: 'demo@example.invalid' }
    }));
    writeFileSync(join(dir, 'design-intent.json'), JSON.stringify({
      concept: 'Taller abierto',
      intendedEmotion: 'confianza',
      primaryMessage: 'servicio claro',
      primaryAction: 'llamar',
      signatureVisualDevice: 'retícula material',
      typographyStrategy: 'jerarquía fuerte',
      compositionStrategy: 'ritmo editorial',
      mobileStrategy: 'cta visible',
      antiTemplateRisks: 'evitar tarjetas genéricas'
    }));
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="es"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Demo local</title><meta name="description" content="Demo de entrenamiento local.">
      </head><body><main><h1>Demo local</h1><p>Una propuesta clara y profesional para un negocio local.</p>
      <a href="tel:+34000000000">Llamar</a></main></body></html>`);
    const result = python(`
from pathlib import Path
r=m.static_quality_audit(Path(sys.argv[1]))
print(json.dumps(r))
`, [dir]);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.metrics.actionablePhoneCta, true);
    assert.equal(result.metrics.actionableEmailCta, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
