#!/usr/bin/env python3
import fcntl, json, os, time
from datetime import datetime, timezone
from pathlib import Path

from model_router import ProviderUnavailable, generate_structured

HOME=Path.home()
REPO=Path(os.environ.get("AGENT_REPO","/home/pablo/projects/agente-automatizador")).resolve()
STATE=Path(os.environ.get("DESIGN_LAB_STATE_DIR",str(HOME/".local/state/engineering-orchestrator/design-lab"))).resolve()
HISTORY=STATE/"history.jsonl"
SUMMARY=STATE/"training-summary.json"
PLAYBOOK=STATE/"playbook.md"
LATEST=STATE/"offline-learning-latest.json"
JOURNAL=STATE/"offline-learning.jsonl"
STAMP=STATE/"offline-learning-last-run.txt"
FAILURE_STAMP=STATE/"offline-learning-last-failure.txt"
LOCK=STATE/"offline-learning.lock"
MIN_INTERVAL=max(60,int(os.environ.get("OFFLINE_LEARNING_INTERVAL_SECONDS","3600")))
FAILURE_RETRY_SECONDS=max(60,int(os.environ.get("OFFLINE_LEARNING_FAILURE_RETRY_SECONDS","3600")))
PROVIDER_TIMEOUT_SECONDS=min(180,max(20,int(os.environ.get("OFFLINE_LEARNING_PROVIDER_TIMEOUT_SECONDS","90"))))

SCHEMA={
  "type":"object",
  "additionalProperties":False,
  "required":["weakestDimension","recurringPatterns","rootCauseHypotheses","nextExperiment","playbookCandidate","confidence","risks"],
  "properties":{
    "weakestDimension":{"type":"string","minLength":1,"maxLength":80},
    "recurringPatterns":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"string","maxLength":500}},
    "rootCauseHypotheses":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"string","maxLength":600}},
    "nextExperiment":{
      "type":"object",
      "additionalProperties":False,
      "required":["target","hypothesis","constraints","successSignals"],
      "properties":{
        "target":{"type":"string","minLength":1,"maxLength":120},
        "hypothesis":{"type":"string","minLength":1,"maxLength":800},
        "constraints":{"type":"array","maxItems":8,"items":{"type":"string","maxLength":300}},
        "successSignals":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","maxLength":300}}
      }
    },
    "playbookCandidate":{"type":"string","minLength":1,"maxLength":1000},
    "confidence":{"type":"number","minimum":0,"maximum":1},
    "risks":{"type":"array","maxItems":6,"items":{"type":"string","maxLength":400}}
  }
}

def now():
    return datetime.now(timezone.utc).isoformat()

def load_json(path,default):
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception: return default

def completed_runs():
    if not HISTORY.exists(): return []
    rows=[]
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        try:
            value=json.loads(line)
            if value.get("finalScore") is not None: rows.append(value)
        except Exception:
            pass
    return rows

def failure_cooldown_active():
    if not FAILURE_STAMP.exists(): return False
    try: last=float(FAILURE_STAMP.read_text().strip())
    except Exception: return False
    return time.time()-last < FAILURE_RETRY_SECONDS

def due():
    if not STAMP.exists(): return True
    try: last=float(STAMP.read_text().strip())
    except Exception: return True
    return time.time()-last >= MIN_INTERVAL

def compact_evidence():
    rows=completed_runs()[-10:]
    detailed_start=max(0,len(rows)-4)
    out=[]
    for index,r in enumerate(rows):
        item={
          "runId":r.get("runId"),
          "briefSlug":r.get("briefSlug"),
          "finalScore":r.get("finalScore"),
          "minCategory":r.get("minCategory"),
          "categoryScores":r.get("categoryScores",{}),
          "deliveryWithin10Min":r.get("deliveryWithin10Min")
        }
        if index >= detailed_start:
            item["topIssue"]=[str(value)[:200] for value in r.get("topIssues",[])[:1]]
            item["templateSignals"]=[str(value)[:120] for value in r.get("templateSignals",[])[:2]]
            item["transferableLesson"]=[str(value)[:180] for value in r.get("transferableLessons",[])[:1]]
        out.append(item)
    return out

def prompt_for(summary,evidence,playbook):
    summary_view={key:summary.get(key) for key in (
      "completedRuns","averageInitialScore","averageFinalScore","averageBuildSeconds",
      "dimensionAverages","trainingFocusDimensionAverages","weakestDimension",
      "averageScoreGain","averageCycleSeconds","averageSelectedElapsedSeconds",
      "deliveryWithin10MinRate","holdoutAttempts","holdoutPasses"
    )}
    bundle={
      "trainingSummary":summary_view,
      "completedRuns":evidence,
      "currentPlaybook":playbook[-800:]
    }
    return """You are an offline research analyst for a strict autonomous website-design training lab.
You do NOT see the screenshots in this task. Use only the supplied reviewer scores, QA signals, issues, concepts and playbook evidence.
Your job is to find cross-run patterns and propose ONE high-value experiment for the next premium visual training cycle.
Do not rescore websites, do not claim mastery, and do not invent visual evidence.
Prioritize recurring weaknesses that plausibly explain the gap from consistent 9.2+ work. Distinguish symptoms from likely root causes.
The playbookCandidate is advisory only: write one concise general principle that should be tested before being promoted into the real playbook.
successSignals must be observable later through existing reviewer/QA evidence, not vague taste claims.
confidence MUST be a decimal from 0.0 to 1.0 (for example 0.85, never 85).
Return only the required JSON schema.

EVIDENCE:
"""+json.dumps(bundle,ensure_ascii=False)

def main():
    STATE.mkdir(parents=True,exist_ok=True)
    with LOCK.open("w") as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print("offline_learning_status=already_running")
            return
        if failure_cooldown_active():
            print("offline_learning_status=failure_cooldown")
            return
        if not due():
            print("offline_learning_status=not_due")
            return
        summary=load_json(SUMMARY,{})
        evidence=compact_evidence()
        if len(evidence)<2:
            print("offline_learning_status=insufficient_evidence")
            return
        playbook=PLAYBOOK.read_text(encoding="utf-8",errors="ignore") if PLAYBOOK.exists() else ""
        try:
            result=generate_structured(
              prompt_for(summary,evidence,playbook),
              SCHEMA,
              cwd=STATE,
              providers=("ollama","antigravity"),
              timeout=PROVIDER_TIMEOUT_SECONDS
            )
        except ProviderUnavailable as exc:
            FAILURE_STAMP.write_text(str(time.time()),encoding="utf-8")
            print("offline_learning_status=no_provider")
            print("offline_learning_error="+str(exc)[:1000])
            return
        record={
          "createdAt":now(),
          "advisoryOnly":True,
          "provider":result["provider"],
          "providerElapsedSeconds":result["elapsedSeconds"],
          "analysis":result["value"],
          "sourceRunIds":[item["runId"] for item in evidence]
        }
        LATEST.write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding="utf-8")
        with JOURNAL.open("a",encoding="utf-8") as f:
            f.write(json.dumps(record,ensure_ascii=False)+"\n")
        STAMP.write_text(str(time.time()),encoding="utf-8")
        try: FAILURE_STAMP.unlink()
        except FileNotFoundError: pass
        print("offline_learning_status=completed")
        print("offline_learning_provider="+result["provider"])
        print("offline_learning_result="+json.dumps(result["value"],ensure_ascii=False))

if __name__=="__main__":
    main()
