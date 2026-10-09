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

test('Antigravity explicit model selection omits incompatible effort flag and sends prompts over stdin', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_authenticated=lambda: True
seen={}
class P:
    returncode=0
    stdout=json.dumps({"event":"result","result":{"status":"SUCCESS","response":"","structured_output":{"ok":True}}})
    stderr=''
def fake_run(args,**kwargs):
    seen["args"]=args
    seen["input"]=kwargs.get("input_text")
    return P()
m._run=fake_run
schema={"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}
value=m.antigravity_structured("x"*300000,schema,cwd="/tmp",model="gemini-3.1-pro-high",effort="medium")
print(json.dumps({"seen":seen,"value":value}))
`);
  assert.ok(result.seen.args.includes('--model'));
  assert.ok(!result.seen.args.includes('--effort'));
  assert.ok(!result.seen.args.includes('-p'));
  assert.ok(result.seen.args.includes('--input-format'));
  assert.ok(result.seen.args.includes('stream-json'));
  assert.ok(result.seen.input.length > 300000);
  assert.equal(JSON.parse(result.seen.input).message.content.length,300000);
  assert.equal(result.value.ok,true);
});

test('Antigravity edit also transports large prompts over stdin', () => {
  const result=python(`
import importlib.util,json,tempfile
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.antigravity_authenticated=lambda: True
seen={}
class P:
    returncode=0
    stdout=json.dumps({"event":"result","result":{"status":"SUCCESS","response":"edited"}})
    stderr=''
def fake_run(args,**kwargs):
    seen["args"]=args
    seen["input"]=kwargs.get("input_text")
    return P()
m._run=fake_run
value=m.antigravity_edit("y"*350000,cwd=tempfile.mkdtemp(),model="gemini-3.8-flash-high")
print(json.dumps({"seen":seen,"value":value}))
`);
  assert.ok(!result.seen.args.includes('-p'));
  assert.ok(result.seen.args.includes('--input-format'));
  assert.equal(JSON.parse(result.seen.input).message.content.length,350000);
  assert.equal(result.value.stdout,'edited');
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

test('Ollama requests unload the local model immediately by default', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ollama_ready=lambda: True
captured={}
class Response:
    status=200
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self,*args): return json.dumps({"response":json.dumps({"ok":True})}).encode("utf-8")
def fake_urlopen(request,timeout=None):
    captured["payload"]=json.loads(request.data.decode("utf-8"))
    return Response()
m.urllib.request.urlopen=fake_urlopen
value=m.ollama_structured(
  "x",{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  num_predict=64
)
print(json.dumps({"value":value,"keepAlive":captured["payload"].get("keep_alive")}))
`);
  assert.equal(result.value.ok,true);
  assert.equal(String(result.keepAlive),'0');
});

test('provider binaries prefer native PATH before legacy WSL fallbacks', () => {
  const result=python(`
import importlib.util,json,os,tempfile
from pathlib import Path
bindir=Path(tempfile.mkdtemp())
for name in ("agy","codex","opencode","copilot"):
    p=bindir/name
    p.write_text("#!/bin/sh\\nexit 0\\n")
    p.chmod(0o755)
os.environ["PATH"]=str(bindir)
for key in ("ANTIGRAVITY_CLI","CODEX_BIN","OPENCODE_BIN","COPILOT_BIN"):
    os.environ.pop(key,None)
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({"agy":m.AGY,"codex":m.CODEX,"opencode":m.OPENCODE,"copilot":m.COPILOT}))
`);
  assert.match(result.agy,/\/agy$/);
  assert.match(result.codex,/\/codex$/);
  assert.match(result.opencode,/\/opencode$/);
  assert.match(result.copilot,/\/copilot$/);
});

test('OpenCode model discovery retries a transient empty service response', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fd,path=tempfile.mkstemp(); os.close(fd)
m.OPENCODE=path
m.OPENCODE_FREE_ENABLED=True
m._OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}
m._opencode_service_connection=lambda: ("http://127.0.0.1:49374","secret-value")
m.time.sleep=lambda *_: None
calls={"count":0}
def fake_run(args,**kwargs):
    calls["count"]+=1
    stdout="" if calls["count"]==1 else "opencode/mimo-v2.6-flash-free\\nopencode/space-bunny-free\\n"
    return subprocess.CompletedProcess(args,0,stdout=stdout,stderr="")
m._run=fake_run
ready,models=m._opencode_models_snapshot()
print(json.dumps({"ready":ready,"models":sorted(models),"calls":calls["count"]}))
os.unlink(path)
`);
  assert.equal(result.ready,true);
  assert.equal(result.calls,2);
  assert.deepEqual(result.models,['opencode/mimo-v2.6-flash-free','opencode/space-bunny-free']);
});

test('OpenCode service connection self-heals one stopped local service', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
home=Path(tempfile.mkdtemp())
(home/".config/opencode").mkdir(parents=True)
(home/".config/opencode/service.json").write_text(json.dumps({"password":"secret-value"}))
m.Path.home=lambda: home
fd,path=tempfile.mkstemp(); os.close(fd)
m.OPENCODE=path
calls=[]
def fake_run(args,**kwargs):
    calls.append(args[1:])
    if args[1:]==["service","status"] and calls.count(["service","status"])==1:
        return subprocess.CompletedProcess(args,1,stdout="",stderr="stopped")
    if args[1:]==["service","start"]:
        return subprocess.CompletedProcess(args,0,stdout="",stderr="")
    if args[1:]==["service","status"]:
        return subprocess.CompletedProcess(args,0,stdout="http://127.0.0.1:49374\\n",stderr="")
    raise AssertionError(args)
m._run=fake_run
url,password=m._opencode_service_connection()
print(json.dumps({"url":url,"password":password,"calls":calls}))
os.unlink(path)
`);
  assert.equal(result.url,'http://127.0.0.1:49374');
  assert.equal(result.password,'secret-value');
  assert.deepEqual(result.calls,[
    ['service','status'],
    ['service','start'],
    ['service','status']
  ]);
});

test('OpenCode free-only guard blocks hidden local models unless explicitly enabled', () => {
  const result=python(`
import importlib.util,json
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
local_default=m.opencode_model_is_free("ollama/qwen2.5-coder:3b")
m.OPENCODE_LOCAL_MODELS_ENABLED=True
print(json.dumps({
  "hostedFree":m.opencode_model_is_free("opencode/ling-3.0-flash-fin-free"),
  "localDefault":local_default,
  "localOptIn":m.opencode_model_is_free("ollama/qwen2.5-coder:3b"),
  "ambiguous":m.opencode_model_is_free("opencode/big-pickle"),
  "paidLike":m.opencode_model_is_free("openai/gpt-5")
}))
`);
  assert.equal(result.hostedFree,true);
  assert.equal(result.localDefault,false);
  assert.equal(result.localOptIn,true);
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
    captured["input"]=kwargs.get("input_text")
    return subprocess.CompletedProcess(args,0,stdout='{"ok":true}',stderr='')
m._run=fake_run
large_prompt="x"*300000
value=m.opencode_structured(
  large_prompt,{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=tempfile.mkdtemp(),model="opencode/ling-3.0-flash-fin-free"
)
print(json.dumps({"value":value,"args":captured["args"],"password":captured["password"],"timeout":captured["timeout"],"inputLength":len(captured.get("input") or "")}))
`);
  assert.equal(result.value.ok,true);
  assert.equal(result.password,'secret-value');
  assert.ok(result.timeout <= 90);
  assert.ok(result.args.includes('--server'));
  assert.ok(result.args.includes('http://127.0.0.1:49374'));
  assert.ok(!result.args.includes('--standalone'));
  assert.ok(!result.args.includes('secret-value'));
  assert.ok(result.inputLength > 300000);
  assert.ok(result.args.every(arg => arg.length < 10000));
});

test('provider schema and output temp files never dirty the project workspace', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
workdir=Path(tempfile.mkdtemp()).resolve()
m.antigravity_authenticated=lambda: True
agy_seen={}
class P:
    returncode=0
    stdout=json.dumps({"event":"result","result":{"status":"SUCCESS","structured_output":{"ok":True}}})
    stderr=''
def agy_run(args,**kwargs):
    agy_seen["schema"]=args[args.index("--json-schema")+1]
    return P()
m._run=agy_run
schema={"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}
m.antigravity_structured("x",schema,cwd=str(workdir),model="gemini-3.1-pro-high")

fd,codex_path=tempfile.mkstemp(); os.close(fd)
m.CODEX=codex_path
codex_seen={}
def codex_run(args,**kwargs):
    codex_seen["schema"]=args[args.index("--output-schema")+1]
    codex_seen["output"]=args[args.index("-o")+1]
    Path(codex_seen["output"]).write_text('{"ok":true}',encoding="utf-8")
    return subprocess.CompletedProcess(args,0,stdout="",stderr="")
m._run=codex_run
m.codex_structured("x",schema,cwd=str(workdir))
os.unlink(codex_path)
print(json.dumps({
  "workspaceFiles":sorted(p.name for p in workdir.iterdir()),
  "agySchemaParent":str(Path(agy_seen["schema"]).parent),
  "codexSchemaParent":str(Path(codex_seen["schema"]).parent),
  "codexOutputParent":str(Path(codex_seen["output"]).parent),
  "workdir":str(workdir)
}))
`);
  assert.deepEqual(result.workspaceFiles,[]);
  assert.notEqual(result.agySchemaParent,result.workdir);
  assert.notEqual(result.codexSchemaParent,result.workdir);
  assert.notEqual(result.codexOutputParent,result.workdir);
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
    captured["input"]=kwargs.get("input_text")
    return subprocess.CompletedProcess(args,0,stdout='{"ok":true}',stderr='')
m._run=fake_run
value=m.copilot_structured(
  "x"*200000,{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}},
  cwd=tempfile.mkdtemp(),model="auto"
)
print(json.dumps({"value":value,"args":captured["args"],"inputBytes":len(captured["input"].encode("utf-8"))}))
os.unlink(path)
`);
  assert.equal(result.value.ok,true);
  assert.ok(result.inputBytes > 200000);
  assert.ok(!result.args.includes('-p'));
  assert.ok(!result.args.some((arg) => typeof arg === 'string' && arg.length > 10000));
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

test('OpenCode readiness authenticates model discovery against the local persistent service', () => {
  const result=python(`
import importlib.util,json,tempfile,os,subprocess
spec=importlib.util.spec_from_file_location("router",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fd,path=tempfile.mkstemp(); os.close(fd)
m.OPENCODE=path
m.OPENCODE_FREE_ENABLED=True
m._OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}
m._opencode_service_connection=lambda: ("http://127.0.0.1:49374","secret-value")
captured={}
def fake_run(args,**kwargs):
    captured["args"]=args
    captured["password"]=kwargs.get("env",{}).get("OPENCODE_PASSWORD")
    return subprocess.CompletedProcess(args,0,stdout="opencode/mimo-v2.6-flash-free\\n",stderr="")
m._run=fake_run
ready=m.opencode_ready("opencode/mimo-v2.6-flash-free")
print(json.dumps({"ready":ready,"args":captured["args"],"password":captured["password"]}))
os.unlink(path)
`);
  assert.equal(result.ready,true);
  assert.ok(result.args.includes('--server'));
  assert.ok(result.args.includes('http://127.0.0.1:49374'));
  assert.equal(result.password,'secret-value');
  assert.ok(!result.args.includes('secret-value'));
});

test('edit router skips a successful no-op candidate but fails closed after a partial failed edit', () => {
  const result=python(`
import importlib.util,json,sys
sys.path.insert(0,${JSON.stringify(dirname(router))})
import model_orchestrator as m
ranked=[
  {"candidate":"ag-gemini-3.8-flash","routingScore":1.0},
  {"candidate":"ag-sonnet-4.6","routingScore":0.9},
]
m.rank_candidates=lambda *a,**k: ranked
m._cooldown_error=lambda candidate: None
m._remember_unavailability=lambda *a,**k: "candidate"
calls=[]
marks=iter(["base","base","base","changed"])
m._workspace_edit_fingerprint=lambda cwd: next(marks)
def fake(candidate,*args,**kwargs):
    calls.append(candidate)
    return {"candidate":candidate,"provider":"fixture","model":"fixture","elapsedSeconds":0,"result":{}}
m.run_edit_candidate=fake
first=m.run_edit_role("implementation","x",cwd="/tmp")
partial_calls=[]
marks2=iter(["base","changed"])
m._workspace_edit_fingerprint=lambda cwd: next(marks2)
def partial(candidate,*args,**kwargs):
    partial_calls.append(candidate)
    raise m.ProviderUnavailable("boom")
m.run_edit_candidate=partial
try:
    m.run_edit_role("implementation","x",cwd="/tmp")
    partial_error=None
except m.ProviderUnavailable as e:
    partial_error=str(e)
print(json.dumps({"selected":first["candidate"],"fallbackErrors":first["fallbackErrors"],"calls":calls,"partialCalls":partial_calls,"partialError":partial_error}))
`);
  assert.equal(result.selected,'ag-sonnet-4.6');
  assert.deepEqual(result.calls,['ag-gemini-3.8-flash','ag-sonnet-4.6']);
  assert.match(result.fallbackErrors[0],/completed_without_workspace_changes/);
  assert.deepEqual(result.partialCalls,['ag-gemini-3.8-flash']);
  assert.match(result.partialError,/candidate_failed_after_workspace_change/);
});
