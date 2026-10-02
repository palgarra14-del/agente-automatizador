import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const offline = resolve('scripts/design-lab/offline-learning.py');

test('offline learning cools down provider failure, prefers Ollama, and clears failure state after success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-learning-'));
  try {
    const source = `
import contextlib, importlib.util, io, json, os, sys, time
from pathlib import Path
root=Path(sys.argv[1])
os.environ["DESIGN_LAB_STATE_DIR"]=str(root)
os.environ["OFFLINE_LEARNING_FAILURE_RETRY_SECONDS"]="3600"
os.environ["OFFLINE_LEARNING_PROVIDER_TIMEOUT_SECONDS"]="90"
base=str(Path(${JSON.stringify(offline)}).parent)
sys.path.insert(0,base)
spec=importlib.util.spec_from_file_location("offline_learning",${JSON.stringify(offline)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root.mkdir(parents=True,exist_ok=True)
m.HISTORY.write_text("\\n".join([
 json.dumps({"runId":"r1","briefSlug":"a","finalScore":8.5,"minCategory":8.0,"categoryScores":{"polish":8.0},"deliveryWithin10Min":True}),
 json.dumps({"runId":"r2","briefSlug":"b","finalScore":8.7,"minCategory":8.2,"categoryScores":{"polish":8.1},"deliveryWithin10Min":True})
]),encoding="utf-8")
m.SUMMARY.write_text(json.dumps({"completedRuns":2,"weakestDimension":"polish"}),encoding="utf-8")
m.PLAYBOOK.write_text("playbook",encoding="utf-8")
calls=[]
def fail(*args,**kwargs):
 calls.append({"phase":"fail","providers":kwargs.get("providers"),"timeout":kwargs.get("timeout")})
 raise m.ProviderUnavailable("none")
m.generate_structured=fail
buf=io.StringIO()
with contextlib.redirect_stdout(buf): m.main()
first=buf.getvalue()
failure_stamp=m.FAILURE_STAMP.exists()
def should_not_run(*args,**kwargs):
 calls.append({"phase":"unexpected"})
 raise RuntimeError("should not run during cooldown")
m.generate_structured=should_not_run
buf=io.StringIO()
with contextlib.redirect_stdout(buf): m.main()
second=buf.getvalue()
m.FAILURE_STAMP.write_text(str(time.time()-3601),encoding="utf-8")
def succeed(*args,**kwargs):
 calls.append({"phase":"success","providers":kwargs.get("providers"),"timeout":kwargs.get("timeout")})
 return {
  "provider":"ollama",
  "elapsedSeconds":1.2,
  "value":{
   "weakestDimension":"polish",
   "recurringPatterns":["x"],
   "rootCauseHypotheses":["y"],
   "nextExperiment":{"target":"polish","hypothesis":"h","constraints":[],"successSignals":["s"]},
   "playbookCandidate":"p",
   "confidence":0.7,
   "risks":[]
  }
 }
m.generate_structured=succeed
buf=io.StringIO()
with contextlib.redirect_stdout(buf): m.main()
third=buf.getvalue()
print(json.dumps({
 "first":first,
 "second":second,
 "third":third,
 "failureStampInitially":failure_stamp,
 "failureStampAfterSuccess":m.FAILURE_STAMP.exists(),
 "successStamp":m.STAMP.exists(),
 "calls":calls
}))
`;
    const run = spawnSync('python3', ['-c', source, dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.match(result.first, /offline_learning_status=no_provider/);
    assert.match(result.second, /offline_learning_status=failure_cooldown/);
    assert.match(result.third, /offline_learning_status=completed/);
    assert.equal(result.failureStampInitially, true);
    assert.equal(result.failureStampAfterSuccess, false);
    assert.equal(result.successStamp, true);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.calls[0].providers, ['ollama','antigravity']);
    assert.equal(result.calls[0].timeout, 90);
    assert.deepEqual(result.calls[1].providers, ['ollama','antigravity']);
    assert.equal(result.calls[1].timeout, 90);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
