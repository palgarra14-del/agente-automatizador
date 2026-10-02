import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeDesignLab } from '../control-center/design-lab-status.mjs';

test('design lab summary exposes emergency QA and honest deferred review state', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const result = summarizeDesignLab({
    serviceState:'inactive',
    timerState:'active',
    quotaNotBeforeEpoch:Math.floor(now / 1000) + 3600,
    summary:{completedRuns:42,weakestDimension:'polish',qaPassRate:0.83},
    latest:{
      name:'run-0594-training-pintura-decoracion',
      brief:{business:'Materia Pintura',category:'Pintura y decoración'},
      route:{provider:'local',model:'deterministic-emergency-v1',emergencyRenderer:true},
      qa:{pass:true,defects:[]},
      deferredReason:'visual_review_unavailable:no_role_candidate_available'
    }
  }, now);
  assert.equal(result.state,'review_deferred');
  assert.equal(result.timerActive,true);
  assert.equal(result.emergencyRenderer,true);
  assert.equal(result.qaPass,true);
  assert.equal(result.business,'Materia Pintura');
  assert.equal(result.weakestDimension,'polish');
  assert.equal(result.quotaActive,true);
  assert.equal(result.quotaRetryInSeconds,3600);
  assert.equal(result.officialTrainingEvidence,false);
});

test('design lab running state outranks deferred artifacts and completed result is recognized later', () => {
  const running = summarizeDesignLab({
    serviceState:'activating',
    latest:{name:'run-1',deferredReason:'old'}
  });
  assert.equal(running.state,'running');

  const completed = summarizeDesignLab({
    serviceState:'inactive',
    latest:{name:'run-2',result:{business:'X',category:'Y',reviewAuthority:'codex_visual',officialTrainingEvidence:true}}
  });
  assert.equal(completed.state,'completed');
  assert.equal(completed.officialTrainingEvidence,true);
  assert.equal(completed.reviewAuthority,'codex_visual');
});

test('design lab failed result is not mislabeled as completed', () => {
  const result = summarizeDesignLab({
    serviceState:'failed',
    latest:{name:'run-3',result:{error:'build_failed:70'}}
  });
  assert.equal(result.state,'failed');
});
