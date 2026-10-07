import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');

function python(source, extraEnv = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'provider-broker-'));
  const run = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DESIGN_LAB_STATE_DIR: stateDir,
      MODEL_PROVIDER_SLOT_WAIT_SECONDS: '0.12',
      ...extraEnv
    }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('resource broker classifies local, hosted, workhorse, deep and paid candidates', () => {
  const result = python(`
import importlib.util,json,sys
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "local":m.candidate_resource_class("ollama-qwen-7b"),
  "hosted":m.candidate_resource_class("oc-mimo-2.6-flash"),
  "workhorse":m.candidate_resource_class("ag-gemini-3.8-flash"),
  "deep":m.candidate_resource_class("ag-opus-4.6"),
  "paid":m.candidate_resource_class("codex-astra")
}))
`);
  assert.deepEqual(result, {
    local: 'local',
    hosted: 'hosted_free',
    workhorse: 'workhorse_free',
    deep: 'deep_free',
    paid: 'paid'
  });
});

test('provider broker exposes conservative cross-process concurrency defaults', () => {
  const result = python(`
import importlib.util,json,sys
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.PROVIDER_CONCURRENCY))
`);
  assert.equal(result.antigravity, 2);
  assert.equal(result.ollama, 1);
  assert.equal(result.opencode, 1);
  assert.equal(result.copilot, 1);
  assert.equal(result.codex, 1);
});

test('provider slots cap concurrency and become reusable after release', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE=Path(tempfile.mkdtemp())
m.PROVIDER_SLOT_DIR=m.STATE/"provider-slots"
m.PROVIDER_CONCURRENCY={"antigravity":2}
m.PROVIDER_SLOT_WAIT_SECONDS=0.05
third_blocked=False
slots=[]
with m.provider_slot("antigravity",timeout_seconds=1) as first:
  slots.append(first["slot"])
  with m.provider_slot("antigravity",timeout_seconds=1) as second:
    slots.append(second["slot"])
    try:
      with m.provider_slot("antigravity",timeout_seconds=0.05):
        pass
    except m.ProviderUnavailable as exc:
      third_blocked="provider_capacity_timeout:antigravity" in str(exc)
with m.provider_slot("antigravity",timeout_seconds=1) as recycled:
  recycled_slot=recycled["slot"]
print(json.dumps({"slots":slots,"thirdBlocked":third_blocked,"recycled":recycled_slot}))
`);
  assert.deepEqual([...result.slots].sort(), [0, 1]);
  assert.equal(result.thirdBlocked, true);
  assert.ok([0, 1].includes(result.recycled));
});

test('candidate result reports resource class and acquired provider slot', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE=Path(tempfile.mkdtemp())
m.PROVIDER_SLOT_DIR=m.STATE/"provider-slots"
m.ollama_structured=lambda *args,**kwargs: {"ok":True}
result=m.run_structured_candidate("ollama-qwen-3b","x",{"type":"object"},cwd=tempfile.mkdtemp(),timeout=1)
print(json.dumps({"resourceClass":result["resourceClass"],"slot":result["providerSlot"]}))
`);
  assert.equal(result.resourceClass, 'local');
  assert.equal(result.slot.provider, 'ollama');
  assert.equal(result.slot.limit, 1);
  assert.equal(result.slot.coordinated, true);
});


test('operational roles preserve deep-free models for second-wave escalation', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
m.COST_POLICY="free_only"
def order(role):
  return [{"candidate":x["candidate"],"wave":x["resourceWave"],"resource":x["resourceClass"]} for x in m.rank_candidates(role)]
print(json.dumps({
  "research":order("research_and_audit"),
  "orchestration":order("autonomous_orchestration"),
  "diagnosis":order("blocker_diagnosis")
}))
`);
  for (const role of ['research','orchestration','diagnosis']) {
    const ranked = result[role];
    assert.equal(ranked[0].candidate, 'ag-gemini-3.8-flash');
    const firstDeep = ranked.findIndex((item) => item.resource === 'deep_free');
    const workhorseFallback = ranked.findIndex((item) => item.candidate === 'ag-gpt-oss-120b');
    assert.ok(workhorseFallback > 0);
    assert.ok(firstDeep > workhorseFallback);
    assert.equal(ranked[firstDeep].wave, 1);
  }
});


test('normal high-volume roles keep Ollama in the final heavy-local wave', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
m.COST_POLICY="free_only"
def order(role):
  return [{"candidate":x["candidate"],"wave":x["resourceWave"]} for x in m.rank_candidates(role)]
print(json.dumps({"quick":order("quick_qa"),"bulk":order("structured_bulk")}))
`);
  for (const role of ['quick','bulk']) {
    const ranked = result[role];
    const ollama = ranked.find((item) => item.candidate === 'ollama-qwen-3b');
    assert.ok(ollama);
    assert.equal(ollama.wave, Math.max(...ranked.map((item) => item.wave)));
    assert.notEqual(ranked[0].candidate, 'ollama-qwen-3b');
  }
  assert.equal(result.bulk[0].candidate, 'oc-muse-spark-1.3');
});
