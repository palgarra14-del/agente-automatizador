import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');

function python(source) {
  const stateDir = mkdtempSync(join(tmpdir(), 'production-learning-'));
  const run = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, DESIGN_LAB_STATE_DIR: stateDir }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('availability outcomes are observable but never penalize empirical model quality', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp())
m.PERFORMANCE=root/"performance.jsonl"
m.record_outcome("research_and_audit","ag-gemini-3.8-flash",success=False,outcome_class="availability",note="quota")
m.record_outcome("research_and_audit","ag-gemini-3.8-flash",success=True,outcome_class="execution",elapsed_seconds=12)
print(json.dumps({"stats":m.empirical_stats("research_and_audit","ag-gemini-3.8-flash"),"rows":m.read_outcomes()}))
`);
  assert.equal(result.stats.samples, 1);
  assert.equal(result.stats.availabilitySamples, 1);
  assert.equal(result.stats.successRate, 1);
  assert.deepEqual(result.rows.map((row) => row.outcomeClass), ['availability','execution']);
});

test('structured production routing records successful candidate automatically', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp())
m.PERFORMANCE=root/"performance.jsonl"
m.rank_candidates=lambda role,**kwargs:[{"candidate":"ag-gemini-3.8-flash","routingScore":1.0}]
m.run_structured_candidate=lambda candidate,prompt,schema,**kwargs:{
  "candidate":candidate,"provider":"antigravity","model":"gemini-3.8-flash-high",
  "elapsedSeconds":4.5,"value":{"ok":True}
}
value=m.run_role_structured("research_and_audit","x",{"type":"object"})
print(json.dumps({"candidate":value["candidate"],"rows":m.read_outcomes(),"stats":m.empirical_stats("research_and_audit","ag-gemini-3.8-flash")}))
`);
  assert.equal(result.candidate, 'ag-gemini-3.8-flash');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].success, true);
  assert.equal(result.rows[0].outcomeClass, 'execution');
  assert.equal(result.rows[0].note, 'production_structured_success');
  assert.equal(result.stats.successRate, 1);
});

test('availability failure falls through without degrading quality score and successful fallback learns', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp())
m.PERFORMANCE=root/"performance.jsonl"
m.RUNTIME_HEALTH=root/"runtime.json"
m._RUNTIME_FAILURES={"providers":{},"candidates":{}}
m.rank_candidates=lambda role,**kwargs:[
  {"candidate":"ag-gemini-3.8-flash","routingScore":1.0},
  {"candidate":"ag-gpt-oss-120b","routingScore":0.9}
]
def execute(candidate,prompt,schema,**kwargs):
  if candidate=="ag-gemini-3.8-flash":
    raise m.ProviderUnavailable("provider_capacity_timeout:antigravity")
  return {"candidate":candidate,"provider":"antigravity","model":"gpt-oss-120b-medium","elapsedSeconds":3.0,"value":{"ok":True}}
m.run_structured_candidate=execute
value=m.run_role_structured("research_and_audit","x",{"type":"object"})
print(json.dumps({
  "candidate":value["candidate"],
  "rows":m.read_outcomes(),
  "first":m.empirical_stats("research_and_audit","ag-gemini-3.8-flash"),
  "second":m.empirical_stats("research_and_audit","ag-gpt-oss-120b")
}))
`);
  assert.equal(result.candidate, 'ag-gpt-oss-120b');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].outcomeClass, 'availability');
  assert.equal(result.first.samples, 0);
  assert.equal(result.first.availabilitySamples, 1);
  assert.equal(result.second.samples, 1);
  assert.equal(result.second.successRate, 1);
});
