import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const orchestrator = resolve('scripts/design-lab/model_orchestrator.py');
const router = resolve('scripts/design-lab/model_router.py');
const lab = resolve('scripts/design-lab/website-design-training-lab.py');

function python(source, args = []) {
  const run = spawnSync('python3', ['-c', source, ...args], { encoding: 'utf8' });
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
  "opencode":m.candidate_available("oc-ling-3-flash"),
  "copilot":m.candidate_available("copilot-free-auto"),
  "implementation":m.rank_candidates("implementation")[0]["candidate"]
}))
`);
  assert.equal(result.codex, false);
  assert.equal(result.antigravity, true);
  assert.equal(result.opencode, true);
  assert.equal(result.copilot, true);
  assert.equal(result.implementation, 'ag-sonnet-4.6');
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
m.candidate_available=lambda candidate,disabled_providers=None: True
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
    return subprocess.CompletedProcess(args,0,stdout='{"ok":true}',stderr='')
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
    return subprocess.CompletedProcess(args,0,stdout='{}',stderr='')
m._run=fake_run
m.antigravity_edit("build",tempfile.mkdtemp(),model="claude-sonnet-4-6",agent="web-builder",effort="high")
print(json.dumps({"args":captured["args"]}))
`);
  assert.ok(result.args.includes('accept-edits'));
  assert.ok(result.args.includes('--sandbox'));
  assert.ok(!result.args.includes('--dangerously-skip-permissions'));
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
