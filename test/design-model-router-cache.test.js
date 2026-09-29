import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const router = resolve('scripts/design-lab/model_router.py');

function python(source) {
  const run = spawnSync('python3', ['-c', source], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('OpenCode model cache probes on first call even just after boot', () => {
  const result = python(`
import importlib.util,json,subprocess
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.OPENCODE_FREE_ENABLED=True
m.OPENCODE="/bin/true"
m.OPENCODE_MODELS_TTL=60
m.time.monotonic=lambda: 10.0
m._OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}
calls=[]
def fake_run(args,cwd=None,timeout=30,input_text=None,env=None):
    calls.append(args)
    return subprocess.CompletedProcess(args,0,stdout="opencode/space-bunny-free\\n",stderr="")
m._run=fake_run
ready=m.opencode_ready("opencode/space-bunny-free")
print(json.dumps({"ready":ready,"calls":len(calls)}))
`);
  assert.equal(result.ready, true);
  assert.equal(result.calls, 1);
});

test('OpenCode model discovery is cached across candidate checks', () => {
  const result = python(`
import importlib.util,json,subprocess
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.OPENCODE_FREE_ENABLED=True
m.OPENCODE="/bin/true"
m.OPENCODE_MODELS_TTL=60
m._OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}
calls=[]
def fake_run(args,cwd=None,timeout=30,input_text=None,env=None):
    calls.append(args)
    return subprocess.CompletedProcess(
        args,0,
        stdout="opencode/mimo-v2.6-flash-free\\nopencode/space-bunny-free\\n",
        stderr=""
    )
m._run=fake_run
a=m.opencode_ready("opencode/mimo-v2.6-flash-free")
b=m.opencode_ready("opencode/space-bunny-free")
missing=m.opencode_ready("opencode/not-present-free")
print(json.dumps({"a":a,"b":b,"missing":missing,"calls":len(calls)}))
`);
  assert.equal(result.a, true);
  assert.equal(result.b, true);
  assert.equal(result.missing, false);
  assert.equal(result.calls, 1);
});

test('OpenCode model cache refreshes after TTL expiry', () => {
  const result = python(`
import importlib.util,json,subprocess
spec=importlib.util.spec_from_file_location("r",${JSON.stringify(router)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.OPENCODE_FREE_ENABLED=True
m.OPENCODE="/bin/true"
m.OPENCODE_MODELS_TTL=1
clock=[100.0]
m.time.monotonic=lambda: clock[0]
m._OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}
calls=[]
def fake_run(args,cwd=None,timeout=30,input_text=None,env=None):
    calls.append(args)
    return subprocess.CompletedProcess(args,0,stdout="opencode/space-bunny-free\\n",stderr="")
m._run=fake_run
first=m.opencode_ready("opencode/space-bunny-free")
clock[0]=100.5
second=m.opencode_ready("opencode/space-bunny-free")
clock[0]=102.0
third=m.opencode_ready("opencode/space-bunny-free")
print(json.dumps({"first":first,"second":second,"third":third,"calls":len(calls)}))
`);
  assert.equal(result.first, true);
  assert.equal(result.second, true);
  assert.equal(result.third, true);
  assert.equal(result.calls, 2);
});
