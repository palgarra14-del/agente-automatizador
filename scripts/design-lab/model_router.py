#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

AGY=os.environ.get("ANTIGRAVITY_CLI","/home/pablo/.local/bin/agy")
OLLAMA_URL=os.environ.get("OLLAMA_URL","http://127.0.0.1:11434")
OLLAMA_MODEL=os.environ.get("OLLAMA_MODEL","qwen2.5-coder:3b")
CODEX=os.environ.get("CODEX_BIN","/home/pablo/projects/agente-automatizador/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
OPENCODE=os.environ.get("OPENCODE_BIN","/home/pablo/.nvm/versions/node/v22.23.2/lib/node_modules/@opencode/cli/bin/opencode.exe")
OPENCODE_FREE_ENABLED=os.environ.get("OPENCODE_FREE_ENABLED","0").strip().lower() in {"1","true","yes","on"}
COPILOT=os.environ.get("COPILOT_BIN","/home/pablo/.nvm/versions/node/v22.23.2/bin/copilot")
COPILOT_FREE_ENABLED=os.environ.get("COPILOT_FREE_ENABLED","0").strip().lower() in {"1","true","yes","on"}
COPILOT_FREE_MODEL=os.environ.get("COPILOT_FREE_MODEL","auto")
COPILOT_MAX_AI_CREDITS=max(1,int(os.environ.get("COPILOT_MAX_AI_CREDITS","1")))
OPENCODE_FREE_TIMEOUT=min(60,max(10,int(os.environ.get("OPENCODE_FREE_TIMEOUT","35"))))
OPENCODE_MODELS_TTL=float(os.environ.get("OPENCODE_MODELS_TTL","60"))
ANTIGRAVITY_AUTH_TTL=float(os.environ.get("ANTIGRAVITY_AUTH_TTL","300"))
_ANTIGRAVITY_AUTH_CACHE={"checkedAt":0.0,"authenticated":False}
_OPENCODE_MODELS_CACHE={"checkedAt":0.0,"ready":False,"models":set()}

class ProviderUnavailable(RuntimeError):
    pass

def _run(args, cwd=None, timeout=30, input_text=None, env=None):
    try:
        return subprocess.run(
            args,cwd=cwd,text=True,input=input_text,capture_output=True,
            timeout=timeout,check=False,env=env,
        )
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise ProviderUnavailable(str(exc)) from exc

def _walk_dicts(value):
    if isinstance(value,dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value,list):
        for child in value:
            yield from _walk_dicts(child)

def _required_keys(schema):
    required=schema.get("required",[]) if isinstance(schema,dict) else []
    return {str(key) for key in required}

def validate_schema(value,schema,path="$"):
    if not isinstance(schema,dict):
        return
    expected=schema.get("type")
    if expected=="object":
        if not isinstance(value,dict):
            raise ProviderUnavailable(f"{path}:expected_object")
        required=_required_keys(schema)
        missing=required-set(value)
        if missing:
            raise ProviderUnavailable(f"{path}:missing_required")
        properties=schema.get("properties",{})
        if schema.get("additionalProperties") is False:
            extra=set(value)-set(properties)
            if extra:
                raise ProviderUnavailable(f"{path}:unexpected_properties")
        for key,child in properties.items():
            if key in value:
                validate_schema(value[key],child,f"{path}.{key}")
    elif expected=="array":
        if not isinstance(value,list):
            raise ProviderUnavailable(f"{path}:expected_array")
        if len(value)<int(schema.get("minItems",0)):
            raise ProviderUnavailable(f"{path}:too_few_items")
        if "maxItems" in schema and len(value)>int(schema["maxItems"]):
            raise ProviderUnavailable(f"{path}:too_many_items")
        child=schema.get("items")
        if child:
            for index,item in enumerate(value):
                validate_schema(item,child,f"{path}[{index}]")
    elif expected=="string":
        if not isinstance(value,str):
            raise ProviderUnavailable(f"{path}:expected_string")
        if len(value)<int(schema.get("minLength",0)):
            raise ProviderUnavailable(f"{path}:too_short")
        if "maxLength" in schema and len(value)>int(schema["maxLength"]):
            raise ProviderUnavailable(f"{path}:too_long")
    elif expected=="number":
        if isinstance(value,bool) or not isinstance(value,(int,float)):
            raise ProviderUnavailable(f"{path}:expected_number")
        if "minimum" in schema and value<schema["minimum"]:
            raise ProviderUnavailable(f"{path}:below_minimum")
        if "maximum" in schema and value>schema["maximum"]:
            raise ProviderUnavailable(f"{path}:above_maximum")
    elif expected=="boolean":
        if not isinstance(value,bool):
            raise ProviderUnavailable(f"{path}:expected_boolean")
    if "enum" in schema and value not in schema["enum"]:
        raise ProviderUnavailable(f"{path}:not_in_enum")

def extract_structured(text,schema):
    raw=str(text or "").strip()
    candidates=[]
    try:
        candidates.append(json.loads(raw))
    except Exception:
        start=raw.find("{")
        end=raw.rfind("}")
        if start>=0 and end>start:
            try: candidates.append(json.loads(raw[start:end+1]))
            except Exception: pass
    required=_required_keys(schema)
    errors=[]
    for candidate in candidates:
        for value in _walk_dicts(candidate):
            if required.issubset(value.keys()):
                try:
                    validate_schema(value,schema)
                    return value
                except ProviderUnavailable as exc:
                    errors.append(str(exc))
    raise ProviderUnavailable("structured_output_invalid:"+(";".join(errors[-3:]) if errors else "missing"))

def _antigravity_stream_input(prompt):
    return json.dumps({
        "event":"user",
        "message":{"content":str(prompt)}
    },ensure_ascii=False)+"\n"

def _antigravity_stream_result(stdout):
    terminal=None
    for line in str(stdout or "").splitlines():
        try:
            event=json.loads(line)
        except Exception:
            continue
        if event.get("event")=="result" and isinstance(event.get("result"),dict):
            terminal=event["result"]
    if terminal is None:
        raise ProviderUnavailable("antigravity_stream_result_missing")
    status=str(terminal.get("status") or "").upper()
    if status!="SUCCESS":
        detail=terminal.get("error") or terminal.get("response") or status or "unknown"
        raise ProviderUnavailable("antigravity_failed:"+str(detail)[-800:])
    return terminal

def antigravity_authenticated():
    now=time.monotonic()
    if (
        _ANTIGRAVITY_AUTH_CACHE["authenticated"]
        and now-_ANTIGRAVITY_AUTH_CACHE["checkedAt"] < ANTIGRAVITY_AUTH_TTL
    ):
        return True
    if not Path(AGY).is_file():
        _ANTIGRAVITY_AUTH_CACHE.update(checkedAt=now,authenticated=False)
        return False
    try:
        proc=_run([AGY,"models"],timeout=60)
    except ProviderUnavailable:
        return False
    combined=(proc.stdout+"\n"+proc.stderr).lower()
    authenticated=proc.returncode==0 and "please sign in" not in combined and "sign in" not in combined
    _ANTIGRAVITY_AUTH_CACHE.update(checkedAt=now,authenticated=authenticated)
    return authenticated

def antigravity_structured(prompt,schema,cwd=None,timeout=180,model=None,agent=None,effort="medium",mode="plan"):
    if not antigravity_authenticated():
        raise ProviderUnavailable("antigravity_not_authenticated")
    workdir=Path(cwd or os.getcwd()).resolve()
    workdir.mkdir(parents=True,exist_ok=True)
    schema_file=None
    try:
        with tempfile.NamedTemporaryFile("w",suffix=".json",prefix="agy-schema-",dir=workdir,delete=False,encoding="utf-8") as f:
            json.dump(schema,f,ensure_ascii=False)
            schema_file=f.name
        cmd=[
          AGY,
          "--input-format","stream-json",
          "--output-format","stream-json",
          "--json-schema",schema_file,
          "--print-timeout",f"{int(timeout)}s",
          "--sandbox"
        ]
        if mode: cmd += ["--mode",str(mode)]
        # Explicit Antigravity model ids already encode their reasoning tier
        # (for example Gemini "...-high") or reject --effort entirely (Claude).
        if effort and not model: cmd += ["--effort",str(effort)]
        if model: cmd += ["--model",str(model)]
        if agent: cmd += ["--agent",str(agent)]
        proc=_run(
            cmd,cwd=workdir,timeout=timeout+15,
            input_text=_antigravity_stream_input(prompt)
        )
        if proc.returncode!=0:
            raise ProviderUnavailable("antigravity_failed:"+((proc.stderr or proc.stdout)[-800:]))
        terminal=_antigravity_stream_result(proc.stdout)
        structured=terminal.get("structured_output")
        if isinstance(structured,dict):
            validate_schema(structured,schema)
            return structured
        return extract_structured(terminal.get("response",""),schema)
    finally:
        if schema_file:
            try: Path(schema_file).unlink()
            except OSError: pass

def opencode_model_is_free(model):
    value=str(model or "")
    return value.startswith("ollama/") or (
        value.startswith("opencode/") and value.endswith("-free")
    )

def _opencode_models_snapshot():
    now=time.monotonic()
    checked_at=float(_OPENCODE_MODELS_CACHE["checkedAt"])
    age=now-checked_at
    if checked_at > 0.0 and age < OPENCODE_MODELS_TTL:
        return _OPENCODE_MODELS_CACHE["ready"], set(_OPENCODE_MODELS_CACHE["models"])
    if not Path(OPENCODE).is_file():
        _OPENCODE_MODELS_CACHE.update(checkedAt=now,ready=False,models=set())
        return False,set()
    try:
        server,password=_opencode_service_connection()
        env=os.environ.copy()
        env["OPENCODE_PASSWORD"]=password
        proc=_run([OPENCODE,"models","--server",server],timeout=20,env=env)
    except ProviderUnavailable:
        _OPENCODE_MODELS_CACHE.update(checkedAt=now,ready=False,models=set())
        return False,set()
    ready=proc.returncode==0
    models={
        line.strip() for line in proc.stdout.splitlines() if line.strip()
    } if ready else set()
    _OPENCODE_MODELS_CACHE.update(checkedAt=now,ready=ready,models=models)
    return ready,set(models)

def opencode_ready(model=None):
    if not OPENCODE_FREE_ENABLED:
        return False
    ready,models=_opencode_models_snapshot()
    if not ready:
        return False
    if model is None:
        return True
    return opencode_model_is_free(model) and str(model) in models

def _opencode_service_connection():
    service_file=Path.home()/".config/opencode/service.json"
    if not service_file.is_file():
        raise ProviderUnavailable("opencode_service_config_missing")
    try:
        config=json.loads(service_file.read_text(encoding="utf-8"))
    except (OSError,json.JSONDecodeError) as exc:
        raise ProviderUnavailable("opencode_service_config_invalid") from exc
    password=str(config.get("password") or "").strip()
    if not password:
        raise ProviderUnavailable("opencode_service_password_missing")
    proc=_run([OPENCODE,"service","status"],timeout=10)
    if proc.returncode!=0:
        raise ProviderUnavailable("opencode_service_unavailable")
    server=(proc.stdout or "").strip().splitlines()
    if not server:
        raise ProviderUnavailable("opencode_service_url_missing")
    url=server[-1].strip()
    if not url.startswith("http://127.0.0.1:"):
        raise ProviderUnavailable("opencode_service_not_localhost")
    return url,password

def _opencode_text(stdout):
    texts=[]
    for line in str(stdout or "").splitlines():
        try:
            event=json.loads(line)
        except Exception:
            continue
        for value in _walk_dicts(event):
            for key in ("text","content","output","response"):
                item=value.get(key)
                if isinstance(item,str) and item.strip():
                    texts.append(item)
    return "\n".join(texts) or str(stdout or "")

def opencode_structured(prompt,schema,cwd=None,timeout=180,model=None):
    if not model or not opencode_model_is_free(model):
        raise ProviderUnavailable("opencode_model_not_free")
    if not opencode_ready(model):
        raise ProviderUnavailable("opencode_model_unavailable")
    workdir=Path(cwd or os.getcwd()).resolve()
    workdir.mkdir(parents=True,exist_ok=True)
    schema_hint=json.dumps(schema,ensure_ascii=False,separators=(",",":"))
    task=(
        "Return ONLY valid JSON matching this JSON schema. "
        "Do not use markdown fences. SCHEMA="+schema_hint+"\nTASK:\n"+str(prompt)
    )
    server,password=_opencode_service_connection()
    env=os.environ.copy()
    env["OPENCODE_PASSWORD"]=password
    proc=_run([
        OPENCODE,"run","--server",server,"--auto",
        "--model",str(model),"--format","json",task
    ],cwd=workdir,timeout=min(timeout,OPENCODE_FREE_TIMEOUT),env=env)
    if proc.returncode!=0:
        raise ProviderUnavailable("opencode_failed:"+((proc.stderr or proc.stdout)[-1200:]))
    return extract_structured(_opencode_text(proc.stdout),schema)

def copilot_ready():
    return COPILOT_FREE_ENABLED and Path(COPILOT).is_file()

def copilot_structured(prompt,schema,cwd=None,timeout=180,model=None):
    if not copilot_ready():
        raise ProviderUnavailable("copilot_free_unavailable")
    workdir=Path(cwd or os.getcwd()).resolve()
    workdir.mkdir(parents=True,exist_ok=True)
    schema_hint=json.dumps(schema,ensure_ascii=False,separators=(",",":"))
    task=(
        "Return ONLY valid JSON matching this JSON schema. "
        "Do not use markdown fences. SCHEMA="+schema_hint+"\nTASK:\n"+str(prompt)
    )
    selected=str(model or COPILOT_FREE_MODEL)
    cmd=[
        COPILOT,
        "-p",task,
        "-s",
        "--output-format","text",
        "--model",selected,
        "--mode","plan",
        "--max-ai-credits",str(COPILOT_MAX_AI_CREDITS),
        "--allow-all-tools",
        "--available-tools","read","grep","glob","ls",
        "--disable-builtin-mcps",
        "--no-ask-user",
        "-C",str(workdir),
    ]
    proc=_run(cmd,cwd=workdir,timeout=timeout)
    if proc.returncode!=0:
        raise ProviderUnavailable("copilot_free_failed:"+((proc.stderr or proc.stdout)[-1200:]))
    return extract_structured(proc.stdout,schema)

def codex_ready():
    return Path(CODEX).is_file()

def _codex_base(workdir, model=None):
    cmd=[
      CODEX,"exec","--sandbox","read-only","--config",'approval_policy="never"',
      "--cd",str(workdir),"--skip-git-repo-check","--ephemeral","--color","never"
    ]
    if model: cmd += ["--model",str(model)]
    return cmd

def codex_structured(prompt,schema,cwd=None,timeout=180,model=None,effort=None,images=None):
    if not codex_ready():
        raise ProviderUnavailable("codex_unavailable")
    workdir=Path(cwd or os.getcwd()).resolve()
    workdir.mkdir(parents=True,exist_ok=True)
    schema_file=None
    output_file=None
    try:
        with tempfile.NamedTemporaryFile("w",suffix=".json",prefix="codex-schema-",dir=workdir,delete=False,encoding="utf-8") as f:
            json.dump(schema,f,ensure_ascii=False)
            schema_file=f.name
        fd,output_file=tempfile.mkstemp(suffix=".json",prefix="codex-output-",dir=workdir)
        os.close(fd)
        cmd=_codex_base(workdir,model=model)
        if effort:
            cmd += ["--config",f'model_reasoning_effort="{effort}"']
        cmd += ["--output-schema",schema_file,"-o",output_file]
        if images:
            cmd += ["--image",*[str(Path(path).resolve()) for path in images]]
        cmd += ["-"]
        proc=_run(cmd,cwd=workdir,timeout=timeout,input_text=prompt)
        if proc.returncode!=0:
            raise ProviderUnavailable("codex_failed:"+((proc.stderr or proc.stdout)[-800:]))
        return extract_structured(Path(output_file).read_text(encoding="utf-8",errors="ignore"),schema)
    finally:
        for filename in (schema_file,output_file):
            if filename:
                try: Path(filename).unlink()
                except OSError: pass

def antigravity_edit(prompt,cwd,timeout=600,model=None,agent=None,effort="medium"):
    if not antigravity_authenticated():
        raise ProviderUnavailable("antigravity_not_authenticated")
    workdir=Path(cwd).resolve()
    cmd=[
      AGY,
      "--input-format","stream-json",
      "--output-format","stream-json",
      "--print-timeout",f"{int(timeout)}s",
      "--sandbox","--mode","accept-edits"
    ]
    if effort and not model: cmd += ["--effort",str(effort)]
    if model: cmd += ["--model",str(model)]
    if agent: cmd += ["--agent",str(agent)]
    proc=_run(
        cmd,cwd=workdir,timeout=timeout+15,
        input_text=_antigravity_stream_input(prompt)
    )
    if proc.returncode!=0:
        raise ProviderUnavailable("antigravity_edit_failed:"+((proc.stderr or proc.stdout)[-1200:]))
    terminal=_antigravity_stream_result(proc.stdout)
    response=str(terminal.get("response") or "")
    return {"stdout":response[-6000:],"stderr":proc.stderr[-2000:],"returncode":proc.returncode}

def codex_edit(prompt,cwd,timeout=600,model=None,effort=None):
    if not codex_ready():
        raise ProviderUnavailable("codex_unavailable")
    workdir=Path(cwd).resolve()
    cmd=[
      CODEX,"exec","--sandbox","workspace-write","--config",'approval_policy="never"',
      "--cd",str(workdir),"--skip-git-repo-check","--ephemeral","--color","never"
    ]
    if model: cmd += ["--model",str(model)]
    if effort: cmd += ["--config",f'model_reasoning_effort="{effort}"']
    cmd += ["-"]
    proc=_run(cmd,cwd=workdir,timeout=timeout,input_text=prompt)
    if proc.returncode!=0:
        raise ProviderUnavailable("codex_edit_failed:"+((proc.stderr or proc.stdout)[-1200:]))
    return {"stdout":proc.stdout[-6000:],"stderr":proc.stderr[-2000:],"returncode":proc.returncode}

def ollama_ready():
    try:
        with urllib.request.urlopen(OLLAMA_URL+"/api/version",timeout=2) as response:
            return response.status==200
    except Exception:
        return False

def ollama_structured(prompt,schema,cwd=None,timeout=180,model=None):
    if not ollama_ready():
        raise ProviderUnavailable("ollama_unavailable")
    payload={
      "model":str(model or OLLAMA_MODEL),
      "prompt":prompt,
      "stream":False,
      "format":schema,
      "options":{"temperature":0.1,"num_predict":700}
    }
    request=urllib.request.Request(
      OLLAMA_URL+"/api/generate",
      data=json.dumps(payload,ensure_ascii=False).encode("utf-8"),
      headers={"Content-Type":"application/json"}
    )
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response:
            envelope=json.load(response)
    except (urllib.error.URLError,TimeoutError,json.JSONDecodeError) as exc:
        raise ProviderUnavailable("ollama_failed:"+str(exc)) from exc
    return extract_structured(envelope.get("response",""),schema)

def generate_structured(prompt,schema,cwd=None,providers=None,timeout=180):
    providers=providers or ("antigravity","ollama")
    errors=[]
    for provider in providers:
        started=time.monotonic()
        try:
            if provider=="antigravity":
                value=antigravity_structured(prompt,schema,cwd=cwd,timeout=timeout)
            elif provider=="ollama":
                value=ollama_structured(prompt,schema,cwd=cwd,timeout=timeout)
            elif provider=="opencode":
                value=opencode_structured(prompt,schema,cwd=cwd,timeout=timeout,model=os.environ.get("OPENCODE_FREE_MODEL","opencode/mimo-v2.6-flash-free"))
            elif provider=="copilot":
                value=copilot_structured(prompt,schema,cwd=cwd,timeout=timeout,model=COPILOT_FREE_MODEL)
            else:
                errors.append(f"{provider}:unknown_provider")
                continue
            return {
              "provider":provider,
              "value":value,
              "elapsedSeconds":round(time.monotonic()-started,2),
              "errors":errors
            }
        except ProviderUnavailable as exc:
            errors.append(f"{provider}:{exc}")
    raise ProviderUnavailable(";".join(errors) or "no_provider_available")

if __name__=="__main__":
    schema={"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}
    print(json.dumps(generate_structured('Return {"ok":true}.',schema),ensure_ascii=False))
