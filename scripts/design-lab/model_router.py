#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

AGY=os.environ.get("ANTIGRAVITY_CLI","/home/pablo/.local/bin/agy")
OLLAMA_URL=os.environ.get("OLLAMA_URL","http://127.0.0.1:11434")
OLLAMA_MODEL=os.environ.get("OLLAMA_MODEL","qwen2.5-coder:3b")

class ProviderUnavailable(RuntimeError):
    pass

def _run(args, cwd=None, timeout=30):
    try:
        return subprocess.run(args,cwd=cwd,text=True,capture_output=True,timeout=timeout,check=False)
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

def antigravity_authenticated():
    if not Path(AGY).is_file():
        return False
    proc=_run([AGY,"models"],timeout=20)
    combined=(proc.stdout+"\n"+proc.stderr).lower()
    return proc.returncode==0 and "please sign in" not in combined and "sign in" not in combined

def antigravity_structured(prompt,schema,cwd=None,timeout=180):
    if not antigravity_authenticated():
        raise ProviderUnavailable("antigravity_not_authenticated")
    workdir=Path(cwd or os.getcwd()).resolve()
    workdir.mkdir(parents=True,exist_ok=True)
    schema_file=None
    try:
        with tempfile.NamedTemporaryFile("w",suffix=".json",prefix="agy-schema-",dir=workdir,delete=False,encoding="utf-8") as f:
            json.dump(schema,f,ensure_ascii=False)
            schema_file=f.name
        proc=_run([
          AGY,"-p",prompt,
          "--output-format","json",
          "--json-schema",schema_file,
          "--print-timeout",f"{int(timeout)}s",
          "--sandbox","--mode","plan","--effort","medium"
        ],cwd=workdir,timeout=timeout+15)
        if proc.returncode!=0:
            raise ProviderUnavailable("antigravity_failed:"+((proc.stderr or proc.stdout)[-800:]))
        return extract_structured(proc.stdout,schema)
    finally:
        if schema_file:
            try: Path(schema_file).unlink()
            except OSError: pass

def ollama_ready():
    try:
        with urllib.request.urlopen(OLLAMA_URL+"/api/version",timeout=2) as response:
            return response.status==200
    except Exception:
        return False

def ollama_structured(prompt,schema,cwd=None,timeout=180):
    if not ollama_ready():
        raise ProviderUnavailable("ollama_unavailable")
    payload={
      "model":OLLAMA_MODEL,
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
