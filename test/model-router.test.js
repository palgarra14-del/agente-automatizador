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

test('OpenCode persistent runner keeps password in env and connects only to local service', () => {
  const result=python(`
import importlib.util,json,tempfile,subprocess
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.OPENCODE_FREE_ENABLED=True
m.opencode_ready=lambda model=None: True
m._opencode_service_connection=lambda: ("http://127.0.0.1:49374","secret-value")
captured={}
def fake_run(args,**kwargs):
    captured["args"]=args
    captured["password"]=kwargs.get("env",{}).get("OPENCODE_PASSWORD")
    captured["timeout"]=kwargs.get("timeout")
    return subprocess.CompletedProcess(args,0,stdout='{"ok":true}',stderr='')
m._run=fake_run
value=m.opencode_structured(
  "x",{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=tempfile.mkdtemp(),model="opencode/ling-3.0-flash-fin-free"
)
print(json.dumps({"value":value,"args":captured["args"],"password":captured["password"],"timeout":captured["timeout"]}))
`);
  assert.equal(result.value.ok,true);
  assert.equal(result.password,'secret-value');
  assert.ok(result.timeout <= 35);
  assert.ok(result.args.includes('--server'));
  assert.ok(result.args.includes('http://127.0.0.1:49374'));
  assert.ok(!result.args.includes('--standalone'));
  assert.ok(!result.args.includes('secret-value'));
});

test('Copilot Free provider is opt-in and disabled by default', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.COPILOT_FREE_ENABLED=False
print(json.dumps({"ready":m.copilot_ready()}))
`);
  assert.equal(result.ready,false);
});

test('Copilot Free structured calls are bounded and read-only', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fd,path=tempfile.mkstemp(); os.close(fd)
m.COPILOT=path
m.COPILOT_FREE_ENABLED=True
m.COPILOT_MAX_AI_CREDITS=1
captured={}
def fake_run(args,**kwargs):
    captured["args"]=args
    return subprocess.CompletedProcess(args,0,stdout='{"ok":true}',stderr='')
m._run=fake_run
value=m.copilot_structured(
  "x",{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=tempfile.mkdtemp(),model="auto"
)
print(json.dumps({"value":value,"args":captured["args"]}))
os.unlink(path)
`);
  assert.equal(result.value.ok,true);
  assert.ok(result.args.includes('--max-ai-credits'));
  assert.ok(result.args.includes('1'));
  assert.ok(result.args.includes('--mode'));
  assert.ok(result.args.includes('plan'));
  assert.ok(result.args.includes('--disable-builtin-mcps'));
  assert.ok(result.args.includes('--no-ask-user'));
  assert.ok(result.args.includes('--available-tools'));
  assert.ok(result.args.includes('read'));
  assert.ok(result.args.includes('grep'));
  assert.ok(result.args.includes('glob'));
  assert.ok(result.args.includes('ls'));
  assert.ok(!result.args.includes('edit'));
  assert.ok(!result.args.includes('shell'));
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
