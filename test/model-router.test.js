import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const router = resolve('scripts/design-lab/model_router.py');
const doctor = resolve('scripts/design-lab/blocker-doctor.py');

function python(source,args=[]) {
  const run=spawnSync('python3',['-c',source,...args],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('model router extracts schema-shaped JSON from wrapped provider output', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
schema={"required":["cause","safeAction"]}
print(json.dumps(m.extract_structured('{"wrapper":{"cause":"x","safeAction":"none"}}',schema)))
`);
  assert.deepEqual(result,{cause:'x',safeAction:'none'});
});

test('model router rejects provider JSON that violates numeric schema bounds', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
schema={"type":"object","required":["confidence"],"properties":{"confidence":{"type":"number","minimum":0,"maximum":1}}}
try:
    m.extract_structured('{"confidence":85}',schema)
    print(json.dumps({"accepted":True}))
except m.ProviderUnavailable as e:
    print(json.dumps({"accepted":False,"error":str(e)}))
`);
  assert.equal(result.accepted,false);
  assert.match(result.error,/above_maximum/);
});

test('Antigravity explicit model selection omits incompatible effort flag', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_authenticated=lambda: True
seen={}
class P:
    returncode=0
    stdout='{"ok":true}'
    stderr=''
def fake_run(args,**kwargs):
    seen["args"]=args
    return P()
m._run=fake_run
schema={"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}
m.antigravity_structured("x",schema,cwd="/tmp",model="gemini-3.1-pro-high",effort="medium")
print(json.dumps(seen))
`);
  assert.ok(result.args.includes('--model'));
  assert.ok(!result.args.includes('--effort'));
});

test('Antigravity authentication caches a recent positive readiness check', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fd,path=tempfile.mkstemp(); os.close(fd); m.AGY=path
calls={"count":0}
def fake_run(args,**kwargs):
    calls["count"]+=1
    return subprocess.CompletedProcess(args,0,stdout="claude-sonnet-4-6",stderr="")
m._run=fake_run
print(json.dumps({"first":m.antigravity_authenticated(),"second":m.antigravity_authenticated(),"calls":calls["count"]}))
os.unlink(path)
`);
  assert.equal(result.first,true);
  assert.equal(result.second,true);
  assert.equal(result.calls,1);
});

test('model router falls back from unavailable Antigravity to local Ollama', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_structured=lambda *a,**k: (_ for _ in ()).throw(m.ProviderUnavailable("not signed in"))
m.ollama_structured=lambda *a,**k: {"ok":True}
print(json.dumps(m.generate_structured("x",{"required":["ok"]},providers=("antigravity","ollama"))))
`);
  assert.equal(result.provider,'ollama');
  assert.equal(result.value.ok,true);
  assert.match(result.errors[0],/antigravity/);
});

test('OpenCode free-only guard accepts only local or explicitly free hosted models', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "hostedFree":m.opencode_model_is_free("opencode/ling-3.0-flash-fin-free"),
  "local":m.opencode_model_is_free("ollama/qwen2.5-coder:3b"),
  "ambiguous":m.opencode_model_is_free("opencode/big-pickle"),
  "paidLike":m.opencode_model_is_free("openai/gpt-5")
}))
`);
  assert.equal(result.hostedFree,true);
  assert.equal(result.local,true);
  assert.equal(result.ambiguous,false);
  assert.equal(result.paidLike,false);
});

test('OpenCode refuses a non-free model before any provider call', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.opencode_ready=lambda *a,**k: True
try:
    m.opencode_structured("x",{"type":"object"},model="opencode/big-pickle")
    print(json.dumps({"blocked":False}))
except m.ProviderUnavailable as e:
    print(json.dumps({"blocked":True,"error":str(e)}))
`);
  assert.equal(result.blocked,true);
  assert.match(result.error,/not_free/);
});

test('doctor can use free/local semantic diagnosis for an unknown failure', () => {
  const result=python(`
import importlib.util,json,sys,os
sys.path.insert(0,${JSON.stringify(dirname(doctor))})
spec=importlib.util.spec_from_file_location("doctor",${JSON.stringify(doctor)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.generate_structured=lambda *a,**k: {"provider":"ollama","value":{
  "cause":"browser runtime transient","category":"transient_runtime","confidence":0.91,
  "explanation":"bounded browser failure","recommendedAction":"retry","safeAction":"restart_service"
}}
bundle={"service":{"activeState":"failed","result":"exit-code"},"timers":{"lab":True,"guardian":True}}
det={"category":"unknown_failure","confidence":0.45}
print(json.dumps(m.model_diagnosis(bundle,det)))
`);
  assert.equal(result.source,'model:ollama');
  assert.equal(result.safeAction,'restart_service');
});

test('doctor suppresses mutations from a low-confidence local diagnosis', () => {
  const result=python(`
import importlib.util,json,sys,os
sys.path.insert(0,${JSON.stringify(dirname(doctor))})
spec=importlib.util.spec_from_file_location("doctor",${JSON.stringify(doctor)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.generate_structured=lambda *a,**k: {"provider":"ollama","value":{
  "cause":"unclear","category":"unknown","confidence":0.52,
  "explanation":"insufficient evidence","recommendedAction":"restart maybe","safeAction":"restart_service"
}}
print(json.dumps(m.model_diagnosis({},{"category":"unknown_failure","confidence":0.45})))
`);
  assert.equal(result.source,'model:ollama');
  assert.equal(result.safeAction,'none');
});
