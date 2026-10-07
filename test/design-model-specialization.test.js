import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');

function python(source) {
  const run = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, ORCHESTRATOR_PATH: orchestrator, DESIGN_LAB_STATE_DIR: mkdtempSync(join(tmpdir(), 'design-specialization-')) }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('cross-family exclusions keep independent reviewers out of the builder family', () => {
  const result = python(`
import importlib.util,json,os,sys,tempfile
from pathlib import Path
orchestrator=Path(os.environ["ORCHESTRATOR_PATH"])
base=str(orchestrator.parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",str(orchestrator))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
m.COST_POLICY="free_only"
ranked=m.rank_candidates("visual_review",excluded_families={"anthropic"})
print(json.dumps({
  "candidate":ranked[0]["candidate"],
  "family":ranked[0]["family"],
  "sonnetFamily":m.candidate_family("ag-sonnet-4.6"),
  "geminiFamily":m.candidate_family("ag-gemini-3.1-pro")
}))
`);
  assert.equal(result.sonnetFamily, 'anthropic');
  assert.equal(result.geminiFamily, 'google');
  assert.equal(result.family, 'google');
  assert.equal(result.candidate, 'ag-gemini-3.1-pro');
});

test('specialization snapshot exposes duties for the key model families', () => {
  const result = python(`
import importlib.util,json,os,sys,tempfile
from pathlib import Path
orchestrator=Path(os.environ["ORCHESTRATOR_PATH"])
base=str(orchestrator.parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",str(orchestrator))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
snapshot=m.policy_snapshot()
print(json.dumps({
  "sonnet":snapshot["candidates"]["ag-sonnet-4.6"]["specialization"]["primary"],
  "gemini38":snapshot["candidates"]["ag-gemini-3.8-flash"]["specialization"]["primary"],
  "opus":snapshot["candidates"]["ag-opus-4.6"]["specialization"]["primary"],
  "muse":snapshot["candidates"]["oc-muse-spark-1.3"]["specialization"]["primary"],
  "nemotron":snapshot["candidates"]["oc-nemotron-3.5-lightning"]["specialization"]["primary"],
  "spaceAvoid":snapshot["candidates"]["oc-space-bunny"]["specialization"]["avoid"],
  "qwen":snapshot["candidates"]["ollama-qwen-3b"]["specialization"]
}))
`);
  assert.ok(result.sonnet.includes('frontend_implementation'));
  assert.ok(result.gemini38.includes('autonomous_orchestration'));
  assert.ok(result.opus.includes('final_audit'));
  assert.ok(result.muse.includes('structured_bulk'));
  assert.ok(result.muse.includes('blocker_diagnosis'));
  assert.ok(result.nemotron.includes('autonomous_orchestration'));
  assert.ok(result.spaceAvoid.includes('blocker_diagnosis'));
  assert.deepEqual(result.qwen.primary, ['offline_analysis']);
  assert.ok(result.qwen.avoid.includes('structured_bulk'));
});
