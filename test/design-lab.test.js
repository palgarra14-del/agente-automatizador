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

function layoutProfile(index) {
  const variants = [
    { heights: [0.5,1.1,0.8,1.4], aligns: ['left','left','center','left'], displays: ['flex','grid','block','grid'], h1: 3.4, action: 0.45 },
    { heights: [0.8,0.7,1.6,0.6], aligns: ['center','left','left','center'], displays: ['grid','block','flex','block'], h1: 4.2, action: 0.68 },
    { heights: [1.3,0.5,0.9,1.0], aligns: ['left','right','left','left'], displays: ['block','grid','grid','flex'], h1: 2.8, action: 0.35 },
    { heights: [0.6,1.8,0.6,0.9], aligns: ['right','left','center','left'], displays: ['flex','flex','grid','block'], h1: 5.0, action: 0.82 },
    { heights: [1.0,0.9,1.2,0.5], aligns: ['center','center','left','right'], displays: ['grid','grid','block','flex'], h1: 3.0, action: 0.52 },
    { heights: [1.5,0.6,0.7,1.3], aligns: ['left','center','right','center'], displays: ['block','flex','block','grid'], h1: 4.6, action: 0.28 }
  ];
  const v = variants[index % variants.length];
  const view = {
    blockCount: v.heights.length,
    heights: v.heights,
    widths: [1,0.92,1,0.88],
    aligns: v.aligns,
    displays: v.displays,
    pageHeightVh: v.heights.reduce((a,b) => a + b, 0) + 0.5,
    h1BodyRatio: v.h1,
    firstActionYVh: v.action,
    firstActionWidthVw: 0.32
  };
  return { desktop: view, mobile: { ...view, widths: [1,1,1,1], firstActionWidthVw: 0.82 } };
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
    selectedElapsedSeconds: 540,
    deterministicQaPass: true,
    verdict: 'PASS',
    conceptIdentity: `signature ${['alba','bruma','cobre','duna','esfera','fuego'][index % 6]}`,
    layoutProfile: layoutProfile(index),
    categoryScores: scores,
    ...patch
  };
}

test('layout fingerprint distinguishes materially different compositions', () => {
  const a = layoutProfile(0);
  const b = JSON.parse(JSON.stringify(a));
  b.desktop.heights[1] += 0.03;
  b.mobile.firstActionYVh += 0.02;
  const c = layoutProfile(3);
  const result = python(`
a=json.loads(sys.argv[1]); b=json.loads(sys.argv[2]); c=json.loads(sys.argv[3])
print(json.dumps({"near":m.layout_similarity(a,b),"different":m.layout_similarity(a,c)}))
`, [JSON.stringify(a), JSON.stringify(b), JSON.stringify(c)]);
  assert.ok(result.near >= 0.95, JSON.stringify(result));
  assert.ok(result.different < 0.9, JSON.stringify(result));
});

test('training cannot qualify by recycling one layout across distinct concepts', () => {
  const repeated = Array.from({ length: 6 }, (_, i) => strongEntry(i, { layoutProfile: layoutProfile(0) }));
  const result = python(`
entries=json.loads(sys.argv[1])
candidate,recent,qualified=m.training_mastery_candidate(entries)
print(json.dumps({"candidate":candidate,"recent":len(recent),"qualified":qualified}))
`, [JSON.stringify(repeated)]);
  assert.equal(result.candidate, false);
  assert.equal(result.recent, 6);
  assert.equal(result.qualified, null);
});

test('training cannot qualify when the best sale-ready candidate arrives after ten minutes', () => {
  const slow = Array.from({ length: 6 }, (_, i) => strongEntry(i, { selectedElapsedSeconds: 601 }));
  const result = python(`
entries=json.loads(sys.argv[1])
candidate,recent,qualified=m.training_mastery_candidate(entries)
print(json.dumps({"candidate":candidate,"recent":len(recent),"qualified":qualified}))
`, [JSON.stringify(slow)]);
  assert.equal(result.candidate, false);
  assert.equal(result.recent, 6);
  assert.equal(result.qualified, null);
});

test('design lab requires unseen holdouts after a qualifying training streak', () => {
  const training = Array.from({ length: 6 }, (_, i) => strongEntry(i));
  const result = python(`
entries=json.loads(sys.argv[1])
candidate,recent,qualified=m.training_mastery_candidate(entries)
before,_=m.mastery_status(entries)
h1={"phase":"holdout","briefSlug":"holdout-fisioterapia","completedAt":"2026-09-20T10:00:00+00:00","finalScore":9.4,"minCategory":9.1,"buildSeconds":420,"selectedElapsedSeconds":560,"deterministicQaPass":True,"verdict":"PASS","categoryScores":{k:9.3 for k in m.SCORE_WEIGHTS}}
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

test('conversion ergonomics requires an exact above-fold comfortably tappable contact action', () => {
  const brief = { syntheticContact: { phone: '+34000000000', email: 'demo@example.invalid' } };
  const good = {
    mobile: { designMetrics: { viewport: { width: 390, height: 844 }, actions: [
      { kind: 'phone', recipient: 'tel:+34000000000', yVh: 0.35, widthVw: 0.62, heightVh: 0.06, fontSizePx: 16 }
    ] } },
    desktop: { designMetrics: { viewport: { width: 1440, height: 900 }, actions: [
      { kind: 'phone', recipient: 'tel:+34000000000', yVh: 0.3, widthVw: 0.18, heightVh: 0.05, fontSizePx: 15 }
    ] } }
  };
  const bad = {
    mobile: { designMetrics: { viewport: { width: 390, height: 844 }, actions: [
      { kind: 'phone', recipient: 'tel:+34000000000', yVh: 1.2, widthVw: 0.7, heightVh: 0.07, fontSizePx: 16 }
    ] } },
    desktop: { designMetrics: { viewport: { width: 1440, height: 900 }, actions: [
      { kind: 'phone', recipient: 'tel:+34000000000', yVh: 0.25, widthVw: 0.02, heightVh: 0.02, fontSizePx: 12 }
    ] } }
  };
  const result = python(`
brief=json.loads(sys.argv[1]); good=json.loads(sys.argv[2]); bad=json.loads(sys.argv[3])
print(json.dumps({"good":m.conversion_ergonomics_from_qa(good,brief),"bad":m.conversion_ergonomics_from_qa(bad,brief)}))
`, [JSON.stringify(brief), JSON.stringify(good), JSON.stringify(bad)]);
  assert.equal(result.good.pass, true, JSON.stringify(result.good));
  assert.equal(result.good.viewports.mobile.ergonomicCount, 1);
  assert.equal(result.bad.pass, false);
  assert.ok(result.bad.defects.includes('conversion_action_not_above_fold_mobile'));
  assert.ok(result.bad.defects.includes('conversion_target_too_small_desktop'));
});

test('typography ergonomics rejects unreadable body copy but allows editorial microcopy', () => {
  const good = {
    mobile: { designMetrics: { textSamples: [
      { tag: 'p', textLength: 140, fontSizePx: 16, lineHeightRatio: 1.5, measureEm: 31 },
      { tag: 'figcaption', textLength: 58, fontSizePx: 12, lineHeightRatio: 1.25, measureEm: 24 }
    ] } },
    desktop: { designMetrics: { textSamples: [
      { tag: 'p', textLength: 180, fontSizePx: 16, lineHeightRatio: 1.55, measureEm: 62 }
    ] } }
  };
  const bad = {
    mobile: { designMetrics: { textSamples: [
      { tag: 'p', textLength: 150, fontSizePx: 11.5, lineHeightRatio: 1.08, measureEm: 52 }
    ] } },
    desktop: { designMetrics: { textSamples: [
      { tag: 'p', textLength: 180, fontSizePx: 13, lineHeightRatio: 1.45, measureEm: 92 }
    ] } }
  };
  const result = python(`
good=json.loads(sys.argv[1]); bad=json.loads(sys.argv[2])
print(json.dumps({"good":m.typography_ergonomics_from_qa(good),"bad":m.typography_ergonomics_from_qa(bad)}))
`, [JSON.stringify(good), JSON.stringify(bad)]);
  assert.equal(result.good.pass, true, JSON.stringify(result.good));
  assert.equal(result.good.viewports.mobile.severeSmallCount, 0);
  assert.ok(result.good.observations.some(item => item.startsWith('secondary_copy_small_mobile')));
  assert.equal(result.bad.pass, false);
  assert.ok(result.bad.defects.includes('substantial_copy_too_small_mobile'));
  assert.ok(result.bad.defects.includes('substantial_copy_line_height_too_dense_mobile'));
  assert.ok(result.bad.observations.some(item => item.startsWith('reading_measure_too_wide_')));
});

test('section rhythm flags repeated structure but tolerates deliberate variety', () => {
  const repeatedBlocks = Array.from({ length: 5 }, (_, index) => ({
    tag: 'section', heightVh: 0.8 + index * 0.01, display: 'grid', flexDirection: 'row',
    gridColumnCount: 2, directChildCount: 2, headingXVw: 0.08, textAlign: 'start'
  }));
  const variedBlocks = [
    { tag: 'section', heightVh: 0.55, display: 'block', flexDirection: 'row', gridColumnCount: null, directChildCount: 3, headingXVw: 0.08, textAlign: 'start' },
    { tag: 'section', heightVh: 1.35, display: 'grid', flexDirection: 'row', gridColumnCount: 2, directChildCount: 2, headingXVw: 0.62, textAlign: 'end' },
    { tag: 'section', heightVh: 0.72, display: 'flex', flexDirection: 'column', gridColumnCount: null, directChildCount: 4, headingXVw: 0.35, textAlign: 'center' },
    { tag: 'section', heightVh: 1.05, display: 'grid', flexDirection: 'row', gridColumnCount: 3, directChildCount: 5, headingXVw: 0.12, textAlign: 'start' },
    { tag: 'section', heightVh: 0.45, display: 'block', flexDirection: 'row', gridColumnCount: null, directChildCount: 1, headingXVw: null, textAlign: 'start' }
  ];
  const repeated = { mobile: { designMetrics: { visualBlocks: repeatedBlocks } }, desktop: { designMetrics: { visualBlocks: repeatedBlocks } } };
  const varied = { mobile: { designMetrics: { visualBlocks: variedBlocks } }, desktop: { designMetrics: { visualBlocks: variedBlocks } } };
  const result = python(`
repeated=json.loads(sys.argv[1]); varied=json.loads(sys.argv[2])
print(json.dumps({"repeated":m.section_rhythm_from_qa(repeated),"varied":m.section_rhythm_from_qa(varied)}))
`, [JSON.stringify(repeated), JSON.stringify(varied)]);
  assert.ok(result.repeated.observations.some(item => item.startsWith('repeated_section_structure_')));
  assert.ok(result.repeated.observations.some(item => item.startsWith('flat_section_rhythm_')));
  assert.equal(result.varied.observations.length, 0, JSON.stringify(result.varied));
  assert.ok(result.varied.viewports.desktop.uniqueStructures >= 4);
});

test('identity continuity flags hero-only signature treatment and accepts page-wide art direction', () => {
  const goodMarkers = [
    { label: 'ribbon', yVh: 0.25, widthVw: 0.45, heightVh: 0.25 },
    { label: 'ribbon-detail', yVh: 1.15, widthVw: 0.3, heightVh: 0.18 },
    { label: 'ribbon-transition', yVh: 2.1, widthVw: 0.5, heightVh: 0.12 }
  ];
  const badMarkers = [
    { label: 'ribbon', yVh: 0.25, widthVw: 0.45, heightVh: 0.25 }
  ];
  const good = {
    mobile: { designMetrics: { signatureElements: goodMarkers } },
    desktop: { designMetrics: { signatureElements: goodMarkers } }
  };
  const bad = {
    mobile: { designMetrics: { signatureElements: badMarkers } },
    desktop: { designMetrics: { signatureElements: badMarkers } }
  };
  const result = python(`
good=json.loads(sys.argv[1]); bad=json.loads(sys.argv[2])
print(json.dumps({"good":m.identity_continuity_from_qa(good),"bad":m.identity_continuity_from_qa(bad)}))
`, [JSON.stringify(good), JSON.stringify(bad)]);
  assert.equal(result.good.observations.length, 0, JSON.stringify(result.good));
  assert.equal(result.good.viewports.mobile.nonHeroCount, 2);
  assert.ok(result.bad.observations.some(item => item.startsWith('signature_identity_hero_heavy_mobile')));
  assert.ok(result.bad.observations.some(item => item.startsWith('signature_identity_hero_heavy_desktop')));
});

test('design lab learns Codex quota reset and adds a safety margin', () => {
  const result = python(`
reset=m.parse_usage_reset_epoch("ERROR: You've hit your usage limit. Please try again at Sep 29th, 2026 12:55 AM.")
print(json.dumps({"iso":m.datetime.fromtimestamp(reset,m.LOCAL_TZ).isoformat()}))
`);
  assert.equal(result.iso, '2026-09-29T01:00:00+02:00');
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
