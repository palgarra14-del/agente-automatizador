import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');

function python(source) {
  const stateDir = mkdtempSync(join(tmpdir(), 'model-circuit-'));
  const run = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, DESIGN_LAB_STATE_DIR: stateDir }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('provider-wide quota failure opens a runtime circuit and skips sibling models', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.COST_POLICY="free_only"
calls=[]
def fake_run(candidate,*args,**kwargs):
    calls.append(candidate)
    if candidate=="ag-gemini-3.8-flash":
        raise m.ProviderUnavailable("antigravity_failed:quota exceeded")
    return {
      "candidate":candidate,"provider":m.CANDIDATES[candidate]["provider"],
      "model":candidate,"elapsedSeconds":0.1,"value":{"ok":True}
    }
m.run_structured_candidate=fake_run
value=m.run_role_structured(
    "blocker_diagnosis","x",
    {"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
    cwd=tempfile.mkdtemp()
)
blocked=m._runtime_cooldown("ag-gemini-3.1-pro")
print(json.dumps({
  "selected":value["candidate"],
  "calls":calls,
  "scope":blocked[0] if blocked else None,
  "fallbackErrors":value["fallbackErrors"]
}))
`);
  assert.equal(result.selected, 'oc-mimo-2.6-flash');
  assert.deepEqual(result.calls, ['ag-gemini-3.8-flash', 'oc-mimo-2.6-flash']);
  assert.equal(result.scope, 'provider');
  assert.match(result.fallbackErrors[0], /quota exceeded/);
});

test('candidate-specific invalid output does not disable sibling models on the same provider', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.COST_POLICY="free_only"
calls=[]
def fake_run(candidate,*args,**kwargs):
    calls.append(candidate)
    if candidate=="ag-sonnet-4.6":
        raise m.ProviderUnavailable("structured_output_invalid:missing")
    return {
      "candidate":candidate,"provider":m.CANDIDATES[candidate]["provider"],
      "model":candidate,"elapsedSeconds":0.1,"value":{"ok":True}
    }
m.run_structured_candidate=fake_run
value=m.run_role_structured(
    "creative_direction","x",
    {"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
    cwd=tempfile.mkdtemp()
)
blocked=m._runtime_cooldown("ag-sonnet-4.6")
sibling=m._runtime_cooldown("ag-gemini-3.1-pro")
print(json.dumps({
  "selected":value["candidate"],
  "calls":calls,
  "scope":blocked[0] if blocked else None,
  "siblingBlocked":bool(sibling)
}))
`);
  assert.equal(result.selected, 'ag-gemini-3.1-pro');
  assert.deepEqual(result.calls, ['ag-sonnet-4.6', 'ag-gemini-3.1-pro']);
  assert.equal(result.scope, 'candidate');
  assert.equal(result.siblingBlocked, false);
});
