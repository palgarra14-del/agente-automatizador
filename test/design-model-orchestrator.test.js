import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');
const router = resolve('scripts/design-lab/model_router.py');
const lab = resolve('scripts/design-lab/website-design-training-lab.py');

function python(source, args = []) {
  const stateDir = mkdtempSync(join(tmpdir(), 'design-model-'));
  const run = spawnSync('python3', ['-c', source, ...args], { encoding: 'utf8', env: { ...process.env, DESIGN_LAB_STATE_DIR: stateDir } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('multi-model router starts from role-specific priors, not one global winner', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
m.COST_POLICY="allow_all"
m.PAID_MODELS_EXPLICITLY_ENABLED=True
print(json.dumps({
  "creative":m.rank_candidates("creative_direction")[0]["candidate"],
  "implementation":m.rank_candidates("implementation")[0]["candidate"],
  "review":m.rank_candidates("visual_review")[0]["candidate"],
  "quick":m.rank_candidates("quick_qa")[0]["candidate"]
}))
`);
  assert.equal(result.creative, 'ag-sonnet-4.6');
  assert.equal(result.implementation, 'codex-astra');
  assert.equal(result.review, 'ag-opus-4.6');
  assert.equal(result.quick, 'ag-gemini-3.8-flash');
});

test('free-only cost policy blocks subscription candidates even when providers are available', () => {
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
print(json.dumps({
  "codex":m.candidate_available("codex-astra"),
  "antigravity":m.candidate_available("ag-sonnet-4.6"),
  "opencode":m.candidate_available("oc-mimo-2.6-flash"),
  "copilot":m.candidate_available("copilot-free-auto"),
  "implementation":m.rank_candidates("implementation")[0]["candidate"],
  "frontend":m.rank_candidates("frontend_implementation")[0]["candidate"],
  "orchestration":m.rank_candidates("autonomous_orchestration")[0]["candidate"],
  "refactor":m.rank_candidates("deep_refactor")[0]["candidate"],
  "bulk":m.rank_candidates("structured_bulk")[0]["candidate"]
}))
`);
  assert.equal(result.codex, false);
  assert.equal(result.antigravity, true);
  assert.equal(result.opencode, true);
  assert.equal(result.copilot, true);
  assert.equal(result.implementation, 'ag-gemini-3.8-flash');
  assert.equal(result.frontend, 'ag-sonnet-4.6');
  assert.equal(result.orchestration, 'ag-gemini-3.8-flash');
  assert.equal(result.refactor, 'ag-opus-4.6');
  assert.equal(result.bulk, 'ollama-qwen-3b');
});

test('allow_all does not unlock paid models without explicit second gate', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
m.COST_POLICY="allow_all"
m.PAID_MODELS_EXPLICITLY_ENABLED=False
locked=m.candidate_available("codex-astra")
m.PAID_MODELS_EXPLICITLY_ENABLED=True
unlocked=m.candidate_available("codex-astra")
print(json.dumps({"locked":locked,"unlocked":unlocked}))
`);
  assert.equal(result.locked, false);
  assert.equal(result.unlocked, true);
});

test('free-only policy also blocks direct paid candidate execution', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.COST_POLICY="free_only"
m.codex_ready=lambda: True
blocked={}
for mode in ("structured","edit"):
    try:
        if mode=="structured":
            m.run_structured_candidate("codex-astra","x",{"type":"object"},cwd=tempfile.mkdtemp())
        else:
            m.run_edit_candidate("codex-astra","x",cwd=tempfile.mkdtemp())
        blocked[mode]=False
    except m.ProviderUnavailable as e:
        blocked[mode]="candidate_blocked_by_cost_policy" in str(e)
print(json.dumps(blocked))
`);
  assert.equal(result.structured, true);
  assert.equal(result.edit, true);
});

test('empirical outcomes can overturn initial model priors', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.provider_available=lambda provider,model=None: True
m.STATE=Path(tempfile.mkdtemp())
m.PERFORMANCE=m.STATE/"perf.jsonl"
before=m.rank_candidates("creative_direction")[0]["candidate"]
for i in range(8):
    m.record_outcome("creative_direction","ag-sonnet-4.6",success=False,elapsed_seconds=500)
    m.record_outcome("creative_direction","ag-gemini-3.1-pro",success=True,elapsed_seconds=240,qa_pass=True,selected=True)
after=m.rank_candidates("creative_direction")[0]["candidate"]
print(json.dumps({"before":before,"after":after,"gemini":m.empirical_stats("creative_direction","ag-gemini-3.1-pro")}))
`);
  assert.equal(result.before, 'ag-sonnet-4.6');
  assert.equal(result.after, 'ag-gemini-3.1-pro');
  assert.equal(result.gemini.samples, 8);
  assert.equal(result.gemini.successRate, 1);
});

test('fix routing separates visual polish from structural runtime defects', () => {
  const result = python(`
import importlib.util,json,sys
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
 "visual":m.route_fix_role({"issues":["typography rhythm and visual polish are weak"]},{}),
 "code":m.route_fix_role({"issues":[]},{"defects":["javascript runtime error","missing_aria_label","console error"]})
}))
`);
  assert.equal(result.visual, 'visual_fix');
  assert.equal(result.code, 'code_fix');
});

test('design council falls back to another specialist when a preferred model returns invalid output', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.candidate_available=lambda candidate,disabled_providers=None,excluded_families=None,excluded_candidates=None: True
calls=[]
def fake_run(candidate,*args,**kwargs):
    calls.append(candidate)
    if candidate=="ag-sonnet-4.6":
        raise m.ProviderUnavailable("structured_output_invalid")
    return {"candidate":candidate,"provider":"antigravity","model":candidate,"elapsedSeconds":0.1,"value":{"concept":"ok"}}
m.run_structured_candidate=fake_run
value=m.run_design_council({"business":"x"},{"summary":"y"},cwd=tempfile.mkdtemp())
print(json.dumps({"primary":value["primary"]["candidate"],"challenger":value["challenger"]["candidate"],"synthesis":value["synthesis"]["candidate"],"errors":value["primary"]["fallbackErrors"],"calls":calls}))
`);
  assert.equal(result.primary,'ag-gemini-3.1-pro');
  assert.equal(result.challenger,'ag-gpt-oss-120b');
  assert.equal(result.synthesis,'ag-opus-4.6');
  assert.match(result.errors[0],/ag-sonnet-4.6/);
});

test('Antigravity structured calls pin model and agent while omitting incompatible effort', () => {
  const result = python(`
import importlib.util,json,sys,tempfile,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_authenticated=lambda: True
captured={}
def fake_run(args,cwd=None,timeout=30,check=False,input_text=None):
    captured["args"]=args
    return subprocess.CompletedProcess(args,0,stdout=json.dumps({"event":"result","result":{"status":"SUCCESS","response":"","structured_output":{"ok":True}}}),stderr='')
m._run=fake_run
value=m.antigravity_structured(
  "x",{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=tempfile.mkdtemp(),model="claude-sonnet-4-6",agent="web-art-director",
  effort="high",mode="plan"
)
print(json.dumps({"value":value,"args":captured["args"]}))
`);
  assert.equal(result.value.ok, true);
  assert.ok(result.args.includes('claude-sonnet-4-6'));
  assert.ok(result.args.includes('web-art-director'));
  assert.ok(!result.args.includes('--effort'));
  assert.ok(result.args.includes('plan'));
});

test('Antigravity editor uses accept-edits but keeps sandbox enabled', () => {
  const result = python(`
import importlib.util,json,tempfile,subprocess
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_authenticated=lambda: True
captured={}
def fake_run(args,cwd=None,timeout=30,check=False,input_text=None):
    captured["args"]=args
    return subprocess.CompletedProcess(args,0,stdout=json.dumps({"event":"result","result":{"status":"SUCCESS","response":"edited"}}),stderr='')
m._run=fake_run
m.antigravity_edit("build",tempfile.mkdtemp(),model="claude-sonnet-4-6",agent="web-builder",effort="high")
print(json.dumps({"args":captured["args"]}))
`);
  assert.ok(result.args.includes('accept-edits'));
  assert.ok(result.args.includes('--sandbox'));
  assert.ok(!result.args.includes('--dangerously-skip-permissions'));
});

test('free-only frontend editing falls back to local Ollama when hosted editors are unavailable', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.COST_POLICY="free_only"
m.provider_available=lambda provider,model=None: provider=="ollama"
m.PERFORMANCE=Path(tempfile.mkdtemp())/"perf.jsonl"
ranked=m.rank_candidates("frontend_implementation",require_edit=True)
print(json.dumps({"candidate":ranked[0]["candidate"],"editing":ranked[0]["editing"],"cost":ranked[0]["costClass"]}))
`);
  assert.equal(result.candidate, 'ollama-qwen-7b');
  assert.equal(result.editing, true);
  assert.equal(result.cost, 'local_zero_external');
});

test('non-git design workspaces use a deterministic tree fingerprint that detects edits', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp())
(root/"brief.txt").write_text("brief",encoding="utf-8")
before=m._workspace_edit_fingerprint(root)
(root/"index.html").write_text("<main>ok</main>",encoding="utf-8")
after=m._workspace_edit_fingerprint(root)
print(json.dumps({"different":before!=after,"stable":after==m._workspace_edit_fingerprint(root)}))
`);
  assert.equal(result.different, true);
  assert.equal(result.stable, true);
});

test('local Ollama editor writes only validated web files and blocks path escape', () => {
  const result = python(`
import importlib.util,json,sys,tempfile
from pathlib import Path
base=str(Path(${JSON.stringify(orchestrator)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("o",${JSON.stringify(orchestrator)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp())
m.STATE=root/"state"; m.PROVIDER_SLOT_DIR=m.STATE/"slots"
m.ollama_structured=lambda *args,**kwargs: {
 "files":[
   {"path":"index.html","content":"<!doctype html><html lang=\\\"es\\\"><main>Local</main></html>"},
   {"path":"design-intent.json","content":"{\\\"concept\\\":\\\"local\\\"}"}
 ],
 "summary":"built locally"
}
result=m.run_edit_candidate("ollama-qwen-7b","build",cwd=root,timeout=30)
blocked=False
try:
 m._apply_ollama_edit_package(root,{"files":[{"path":"../escape.html","content":"x"}],"summary":"x"})
except m.ProviderUnavailable:
 blocked=True
print(json.dumps({
 "provider":result["provider"],
 "exists":(root/"index.html").exists(),
 "summary":result["result"]["stdout"],
 "blocked":blocked,
 "escaped":(root.parent/"escape.html").exists()
}))
`);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.exists, true);
  assert.equal(result.summary, 'built locally');
  assert.equal(result.blocked, true);
  assert.equal(result.escaped, false);
});

test('experimental visual reviews cannot qualify for mastery', () => {
  const result = python(`
import importlib.util,json,sys
from pathlib import Path
base=str(Path(${JSON.stringify(lab)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("lab",${JSON.stringify(lab)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base_entry={
 "finalScore":9.4,"minCategory":9.1,"buildSeconds":300,"selectedElapsedSeconds":580,
 "deterministicQaPass":True,"verdict":"PASS"
}
legacy=dict(base_entry)
experimental={**base_entry,"reviewAuthority":"experimental_antigravity_visual","officialTrainingEvidence":False}
official={**base_entry,"reviewAuthority":"codex_visual","officialTrainingEvidence":True}
print(json.dumps({
 "legacy":m.record_passes(legacy),
 "experimental":m.record_passes(experimental),
 "official":m.record_passes(official)
}))
`);
  assert.equal(result.legacy, true);
  assert.equal(result.experimental, false);
  assert.equal(result.official, true);
});


test('Codex structured routing passes prompt, model, effort and images', () => {
  const result = python(`
import importlib.util,json,tempfile,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.codex_ready=lambda: True
captured={}
def fake_run(args,cwd=None,timeout=30,input_text=None):
    captured["args"]=args
    captured["input"]=input_text
    out=args[args.index("-o")+1]
    Path(out).write_text('{"ok":true}')
    return subprocess.CompletedProcess(args,0,stdout='',stderr='')
m._run=fake_run
root=Path(tempfile.mkdtemp())
image=root/"shot.png"; image.write_bytes(b"x")
value=m.codex_structured(
  "judge",{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=root,model="gpt-6-astra",effort="high",images=[image]
)
print(json.dumps({"value":value,"args":captured["args"],"input":captured["input"]}))
`);
  assert.equal(result.value.ok, true);
  assert.equal(result.input, 'judge');
  assert.ok(result.args.includes('gpt-6-astra'));
  assert.ok(result.args.some(x => String(x).includes('model_reasoning_effort')));
  assert.ok(result.args.includes('--image'));
});
