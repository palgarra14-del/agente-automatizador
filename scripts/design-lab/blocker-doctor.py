#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR=Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0,str(SCRIPT_DIR))
from model_router import ProviderUnavailable, generate_structured

HOME=Path.home()
REPO=Path(os.environ.get("AGENT_REPO","/home/pablo/projects/agente-automatizador")).resolve()
STATE=Path(os.environ.get("DESIGN_LAB_STATE_DIR",str(HOME/".local/state/engineering-orchestrator/design-lab"))).resolve()
HISTORY=STATE/"doctor-history.jsonl"
LATEST=STATE/"doctor-latest.json"
LOCK=STATE/"doctor.lock"
CODEX=str(REPO/"node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
LAB_SERVICE="engineering-orchestrator-design-lab.service"
LAB_TIMER="engineering-orchestrator-design-lab.timer"
GUARDIAN_TIMER="engineering-orchestrator-design-lab-guardian.timer"
PORT=4187

SAFE_ACTIONS={
  "none","wait_quota","restart_timer","restart_service",
  "clear_stale_lock","kill_orphan_http","checkout_main_if_clean"
}

MODEL_SCHEMA={
  "type":"object",
  "additionalProperties":False,
  "required":["cause","category","confidence","explanation","recommendedAction","safeAction"],
  "properties":{
    "cause":{"type":"string","minLength":1,"maxLength":1200},
    "category":{"type":"string","minLength":1,"maxLength":120},
    "confidence":{"type":"number","minimum":0,"maximum":1},
    "explanation":{"type":"string","minLength":1,"maxLength":2000},
    "recommendedAction":{"type":"string","minLength":1,"maxLength":2000},
    "safeAction":{"type":"string","enum":sorted(SAFE_ACTIONS)}
  }
}

def now():
    return datetime.now(timezone.utc).isoformat()

def run(args, timeout=20, check=False, cwd=None, input_text=None):
    try:
        return subprocess.run(args,cwd=cwd,text=True,input=input_text,capture_output=True,timeout=timeout,check=check)
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(args,124,stdout=exc.stdout or "",stderr=(exc.stderr or "")+"\ncommand_timeout")

def tail(path, limit=12000):
    try:
        data=Path(path).read_text(encoding="utf-8",errors="ignore")
    except Exception:
        return ""
    return data[-limit:]

def systemd_prop(unit, prop):
    proc=run(["systemctl","--user","show",unit,f"-p{prop}","--value"],timeout=5)
    return proc.stdout.strip() if proc.returncode==0 else ""

def timer_active(unit):
    return run(["systemctl","--user","is-active","--quiet",unit],timeout=5).returncode==0

def git_context():
    branch=run(["git","-C",str(REPO),"branch","--show-current"],timeout=5).stdout.strip()
    status=run(["git","-C",str(REPO),"status","--porcelain"],timeout=5).stdout
    return {"branch":branch,"dirty":bool(status.strip()),"status":status[-4000:]}

def latest_run_context():
    runs=STATE/"runs"
    if not runs.exists():
        return {"path":None,"files":[],"traces":{}}
    dirs=[p for p in runs.iterdir() if p.is_dir()]
    if not dirs:
        return {"path":None,"files":[],"traces":{}}
    current=max(dirs,key=lambda p:p.stat().st_mtime)
    files=sorted(p.name for p in current.iterdir() if p.is_file())[-80:]
    trace_names=[
      "build-output.txt","review-initial-trace.txt","review-fix1-trace.txt",
      "review-fix2-trace.txt","fix-1-trace.txt","fix-2-trace.txt",
      "server-initial.log","qa-server-initial.log"
    ]
    traces={}
    for name in trace_names:
        value=tail(current/name,5000)
        if value: traces[name]=value
    for p in sorted(current.glob("*trace.txt"))[-8:]:
        traces.setdefault(p.name,tail(p,5000))
    return {"path":str(current),"files":files,"traces":traces}

def lock_context():
    lock=STATE/"active.lock"
    if not lock.exists():
        return {"exists":False,"pid":None,"alive":False}
    raw=tail(lock,128).strip()
    try: pid=int("".join(ch for ch in raw if ch.isdigit()))
    except Exception: pid=None
    alive=False
    if pid:
        try:
            os.kill(pid,0); alive=True
        except OSError:
            alive=False
    return {"exists":True,"pid":pid,"alive":alive}

def port_context():
    proc=run(["bash","-lc",f"ss -ltnp 'sport = :{PORT}' 2>/dev/null || true"],timeout=5)
    return {"port":PORT,"listeners":proc.stdout[-4000:]}

def quota_context():
    path=STATE/"quota-not-before.txt"
    if not path.exists():
        return {"active":False,"epoch":None}
    try: epoch=int(path.read_text().strip())
    except Exception: return {"active":False,"epoch":None,"invalid":True}
    return {"active":time.time()<epoch,"epoch":epoch}

def collect_incident():
    usage=shutil.disk_usage(STATE if STATE.exists() else HOME)
    journal=run(["journalctl","--user-unit",LAB_SERVICE,"-n","120","--no-pager","-o","short-iso"],timeout=10)
    processes=run(["bash","-lc","ps -u $(id -u) -o pid=,etime=,stat=,%cpu=,%mem=,args= | grep -E 'website-design-training-lab|codex exec|http.server 4187|google-chrome' | grep -v grep || true"],timeout=5)
    return {
      "collectedAt":now(),
      "service":{
        "activeState":systemd_prop(LAB_SERVICE,"ActiveState"),
        "subState":systemd_prop(LAB_SERVICE,"SubState"),
        "result":systemd_prop(LAB_SERVICE,"Result"),
        "execMainStatus":systemd_prop(LAB_SERVICE,"ExecMainStatus")
      },
      "timers":{
        "lab":timer_active(LAB_TIMER),
        "guardian":timer_active(GUARDIAN_TIMER)
      },
      "git":git_context(),
      "lock":lock_context(),
      "port":port_context(),
      "quota":quota_context(),
      "disk":{"freeBytes":usage.free,"totalBytes":usage.total},
      "processes":processes.stdout[-8000:],
      "journal":journal.stdout[-12000:],
      "latestRun":latest_run_context()
    }

def incident_text(bundle):
    traces="\n".join(bundle.get("latestRun",{}).get("traces",{}).values())
    return ("\n".join([
      bundle.get("journal",""),
      traces,
      bundle.get("processes",""),
      bundle.get("port",{}).get("listeners","")
    ])).lower()

def deterministic_diagnosis(bundle):
    text=incident_text(bundle)
    service=bundle.get("service",{})
    quota=bundle.get("quota",{})
    lock=bundle.get("lock",{})
    git=bundle.get("git",{})
    disk=bundle.get("disk",{})
    if quota.get("active") or "usage limit" in text or "try again at" in text:
        return {"source":"rules","cause":"Codex usage quota is temporarily unavailable.","category":"quota","confidence":0.99,
                "explanation":"The incident evidence contains an active quota cooldown or an explicit usage-limit response.",
                "recommendedAction":"Wait for the recorded reset time; keep timers alive and retry automatically afterwards.","safeAction":"wait_quota"}
    if not bundle.get("timers",{}).get("lab"):
        return {"source":"rules","cause":"The design-lab timer is not active.","category":"scheduler","confidence":0.99,
                "explanation":"Without the timer, completed or failed cycles will not be scheduled again.",
                "recommendedAction":"Restart the design-lab timer.","safeAction":"restart_timer"}
    if lock.get("exists") and lock.get("pid") and not lock.get("alive") and service.get("activeState") not in {"active","activating"}:
        return {"source":"rules","cause":"The design-lab lock contains a dead process id.","category":"stale_lock","confidence":0.99,
                "explanation":"The previous process died and left stale diagnostic lock content.",
                "recommendedAction":"Clear the stale lock file, then let the timer retry.","safeAction":"clear_stale_lock"}
    if "address already in use" in text or f":{PORT}" in bundle.get("port",{}).get("listeners",""):
        if service.get("activeState") not in {"active","activating"}:
            return {"source":"rules","cause":"The local QA port is occupied while the design-lab service is inactive.","category":"orphan_http","confidence":0.94,
                    "explanation":"A previous local HTTP server likely survived after its parent cycle ended.",
                    "recommendedAction":"Kill only the exact user-owned design-lab http.server process on the QA port.","safeAction":"kill_orphan_http"}
    if disk.get("freeBytes",10**12) < 5*1024**3:
        return {"source":"rules","cause":"Available disk space is below the autonomous repair safety floor.","category":"disk_pressure","confidence":0.98,
                "explanation":"Automatic deletion is intentionally disabled because choosing what to remove requires stronger evidence.",
                "recommendedAction":"Inspect storage usage and choose a safe cleanup target; do not delete user data automatically.","safeAction":"none"}
    if git.get("branch") and git.get("branch")!="main" and not git.get("dirty") and service.get("activeState") not in {"active","activating"}:
        return {"source":"rules","cause":"The runtime repository is clean but not on main.","category":"runtime_branch","confidence":0.98,
                "explanation":"The production design lab should execute the reviewed main branch rather than a feature branch.",
                "recommendedAction":"Checkout main before the next cycle.","safeAction":"checkout_main_if_clean"}
    transient_tokens=["command_timeout","timed out","connection reset","temporary failure","network is unreachable","connection refused","browser_qa","chrome"]
    if service.get("result") not in {"","success"} and any(token in text for token in transient_tokens):
        return {"source":"rules","cause":"The previous cycle failed on a likely transient runtime or browser condition.","category":"transient_runtime","confidence":0.82,
                "explanation":"The logs show a bounded runtime/network/browser failure rather than evidence of corrupted state.",
                "recommendedAction":"Reset the failed unit and retry one clean cycle.","safeAction":"restart_service"}
    if service.get("activeState")=="failed" or service.get("result") not in {"","success"}:
        return {"source":"rules","cause":"The design-lab service ended unsuccessfully and the rule engine cannot prove a more specific root cause.","category":"unknown_failure","confidence":0.45,
                "explanation":"More semantic diagnosis is warranted before choosing anything beyond a bounded retry.",
                "recommendedAction":"Ask the read-only diagnostic model to explain the failure and map it to an allowlisted action.","safeAction":"none"}
    return {"source":"rules","cause":"No active blocker is proven by current evidence.","category":"healthy_or_idle","confidence":0.95,
            "explanation":"Timers and service state do not show a failure requiring repair.","recommendedAction":"No repair is needed.","safeAction":"none"}

def model_diagnosis(bundle, deterministic):
    if deterministic.get("confidence",0)>=0.8 and deterministic.get("category") not in {"unknown_failure"}:
        return None
    STATE.mkdir(parents=True,exist_ok=True)
    prompt="""You are a read-only incident diagnostician for an autonomous website-design training service.
Use ONLY the incident evidence supplied below. Explain the most likely root cause without guessing.
Choose safeAction ONLY from the schema allowlist. A separate repair layer executes it; you cannot run commands or edit files.
Use none when evidence is insufficient. Never recommend deleting user data, resetting a dirty repository, bypassing security checks, disabling tests, changing credentials, or weakening approval gates.
Return only the required JSON.

INCIDENT EVIDENCE:
"""+json.dumps(bundle,ensure_ascii=False)[:48000]
    try:
        routed=generate_structured(prompt,MODEL_SCHEMA,cwd=STATE,providers=("antigravity","ollama"),timeout=180)
        value=routed["value"]
        if value.get("safeAction") not in SAFE_ACTIONS:
            value["safeAction"]="none"
        if float(value.get("confidence",0) or 0) < 0.75:
            value["safeAction"]="none"
        value["source"]="model:"+routed["provider"]
        return value
    except (ProviderUnavailable,ValueError,TypeError):
        pass

    # Premium fallback remains available when its quota is healthy.
    if not Path(CODEX).exists():
        return None
    incident=STATE/"doctor-incident.json"
    schema=STATE/"doctor-schema.json"
    output=STATE/"doctor-model.json"
    incident.write_text(json.dumps(bundle,ensure_ascii=False,indent=2),encoding="utf-8")
    schema.write_text(json.dumps(MODEL_SCHEMA,ensure_ascii=False,indent=2),encoding="utf-8")
    codex_prompt="""You are a read-only incident diagnostician for an autonomous website-design training service.
Read doctor-incident.json. Explain the most likely root cause using only supplied evidence. Do not invent missing facts.
Choose safeAction ONLY from the schema. Use none when the evidence does not justify an allowlisted repair.
Never recommend deleting user data, resetting a dirty repository, bypassing security checks, disabling tests, changing credentials, or weakening approval gates.
Return only the schema JSON."""
    proc=run([
      CODEX,"exec","--sandbox","read-only","--config",'approval_policy="never"',
      "--cd",str(STATE),"--skip-git-repo-check","--ephemeral","--color","never",
      "--output-schema",str(schema),"-o",str(output),"-"
    ],timeout=180,cwd=STATE,input_text=codex_prompt)
    if proc.returncode!=0 or not output.exists():
        return None
    try:
        value=json.loads(output.read_text(encoding="utf-8"))
    except Exception:
        return None
    if value.get("safeAction") not in SAFE_ACTIONS or float(value.get("confidence",0) or 0)<0.75:
        value["safeAction"]="none"
    value["source"]="model:codex"
    return value

def kill_orphan_http():
    if systemd_prop(LAB_SERVICE,"ActiveState") in {"active","activating"}:
        return False,"service_active_no_cleanup"
    proc=run(["bash","-lc",f"ps -u $(id -u) -o pid=,args= | grep 'python3 -m http.server {PORT} --bind 127.0.0.1 --directory {STATE}/runs/' | grep -v grep || true"],timeout=5)
    killed=[]
    for line in proc.stdout.splitlines():
        parts=line.strip().split(None,1)
        if len(parts)!=2: continue
        try: pid=int(parts[0])
        except ValueError: continue
        try:
            os.kill(pid,15); killed.append(pid)
        except OSError: pass
    return True,{"killed":killed}

def execute_safe_action(action):
    if action not in SAFE_ACTIONS:
        return {"ok":False,"detail":"action_not_allowlisted"}
    if action in {"none","wait_quota"}:
        return {"ok":True,"detail":"no_mutation"}
    if action=="restart_timer":
        run(["systemctl","--user","reset-failed",LAB_TIMER],timeout=10)
        proc=run(["systemctl","--user","start",LAB_TIMER],timeout=10)
        return {"ok":proc.returncode==0,"detail":proc.stderr[-1000:]}
    if action=="restart_service":
        run(["systemctl","--user","reset-failed",LAB_SERVICE],timeout=10)
        proc=run(["systemctl","--user","start",LAB_SERVICE],timeout=30)
        return {"ok":proc.returncode==0,"detail":proc.stderr[-1000:]}
    if action=="clear_stale_lock":
        info=lock_context()
        if info.get("alive") or systemd_prop(LAB_SERVICE,"ActiveState") in {"active","activating"}:
            return {"ok":False,"detail":"lock_owner_or_service_active"}
        (STATE/"active.lock").write_text("",encoding="utf-8")
        return {"ok":True,"detail":"stale_lock_cleared"}
    if action=="kill_orphan_http":
        ok,detail=kill_orphan_http()
        return {"ok":ok,"detail":detail}
    if action=="checkout_main_if_clean":
        git=git_context()
        if git.get("dirty"):
            return {"ok":False,"detail":"repo_dirty"}
        proc=run(["git","-C",str(REPO),"checkout","main"],timeout=20)
        return {"ok":proc.returncode==0,"detail":proc.stderr[-1000:]}
    return {"ok":False,"detail":"unhandled_action"}

def append_record(record):
    STATE.mkdir(parents=True,exist_ok=True)
    with HISTORY.open("a",encoding="utf-8") as f:
        f.write(json.dumps(record,ensure_ascii=False)+"\n")
    LATEST.write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding="utf-8")

def main():
    STATE.mkdir(parents=True,exist_ok=True)
    import fcntl
    with LOCK.open("w") as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print("blocker_doctor_skip=already_running")
            return
        bundle=collect_incident()
        deterministic=deterministic_diagnosis(bundle)
        model=model_diagnosis(bundle,deterministic)
        diagnosis=model or deterministic
        action=diagnosis.get("safeAction","none")
        repair=execute_safe_action(action)
        record={
          "diagnosedAt":now(),
          "diagnosis":diagnosis,
          "deterministicDiagnosis":deterministic,
          "modelUsed":bool(model),
          "repair":repair,
          "serviceAfter":{
            "activeState":systemd_prop(LAB_SERVICE,"ActiveState"),
            "result":systemd_prop(LAB_SERVICE,"Result")
          }
        }
        append_record(record)
        print("blocker_doctor_result="+json.dumps(record,ensure_ascii=False))

if __name__=="__main__":
    main()
