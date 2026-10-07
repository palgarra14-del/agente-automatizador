#!/usr/bin/env python3
"""Fail-closed bridge from the governed Node workflow engine to free multi-model routing.

Input is one bounded JSON request on stdin. The current working directory is the
only workspace the bridge may expose to model CLIs. Paid model/API paths are
hard-disabled here even if the parent process is misconfigured.
"""
import json
import os
import sys
from pathlib import Path

MAX_STDIN_BYTES = 1536 * 1024
ALLOWED_ACTIONS = {"structured", "edit"}

# The bridge defaults to free-only. An explicit subscription_included policy
# may use already-paid subscription quota while API credentials remain stripped.
_requested_cost_policy = os.environ.get("MODEL_COST_POLICY", "free_only").strip().lower()
os.environ["MODEL_COST_POLICY"] = (
    "subscription_included" if _requested_cost_policy == "subscription_included" else "free_only"
)
os.environ["PAID_MODELS_EXPLICITLY_ENABLED"] = "0"
os.environ["CODEX_PAID_API_FALLBACK_ENABLED"] = "0"
os.environ["CODEX_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ.setdefault("OPENCODE_FREE_ENABLED", "1")
os.environ.setdefault("COPILOT_FREE_ENABLED", "1")

HERE = Path(__file__).resolve().parent
DESIGN_LAB = HERE / "design-lab"
sys.path.insert(0, str(DESIGN_LAB))

from model_orchestrator import (  # noqa: E402
    EDIT_ROLES,
    ROLE_POLICY,
    ProviderUnavailable,
    candidate_family,
    run_edit_role,
    run_role_structured,
)


def _read_request():
    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        raise ValueError("gateway_request_too_large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("gateway_request_invalid_json") from exc
    if not isinstance(value, dict):
        raise ValueError("gateway_request_must_be_object")
    return value


def _text(value, label, max_len):
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise ValueError(f"{label}_invalid")
    if "\x00" in value:
        raise ValueError(f"{label}_invalid")
    return value


def _string_list(value, label, max_items=16):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > max_items:
        raise ValueError(f"{label}_invalid")
    result = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 120:
            raise ValueError(f"{label}_invalid")
        result.append(item)
    return result


def _timeout(value):
    if value is None:
        return 240
    if isinstance(value, bool) or not isinstance(value, int) or value < 10 or value > 900:
        raise ValueError("gateway_timeout_invalid")
    return value


def _schema(value):
    if not isinstance(value, dict):
        raise ValueError("gateway_schema_invalid")
    encoded = json.dumps(value, ensure_ascii=False)
    if len(encoded) > 64 * 1024:
        raise ValueError("gateway_schema_too_large")
    return value


def _result_envelope(result):
    candidate = result.get("candidate")
    return {
        "ok": True,
        "candidate": candidate,
        "family": candidate_family(candidate) if candidate else None,
        "provider": result.get("provider"),
        "model": result.get("model"),
        "resourceClass": result.get("resourceClass"),
        "providerSlot": result.get("providerSlot"),
        "routingScore": result.get("routingScore"),
        "subscriptionQuota": result.get("subscriptionQuota"),
        "elapsedSeconds": result.get("elapsedSeconds"),
        "fallbackErrors": result.get("fallbackErrors") or [],
        **({"value": result.get("value")} if "value" in result else {}),
        **({"result": result.get("result")} if "result" in result else {}),
    }


def main():
    request = _read_request()
    action = _text(request.get("action"), "gateway_action", 32)
    if action not in ALLOWED_ACTIONS:
        raise ValueError("gateway_action_unsupported")
    role = _text(request.get("role"), "gateway_role", 80)
    if role not in ROLE_POLICY:
        raise ValueError("gateway_role_unknown")
    prompt = _text(request.get("prompt"), "gateway_prompt", 1_200_000)
    timeout = _timeout(request.get("timeoutSeconds"))
    excluded_families = _string_list(request.get("excludedFamilies"), "gateway_excluded_families")
    excluded_candidates = _string_list(request.get("excludedCandidates"), "gateway_excluded_candidates")
    cwd = str(Path.cwd().resolve())

    if action == "structured":
        result = run_role_structured(
            role,
            prompt,
            _schema(request.get("schema")),
            cwd=cwd,
            timeout=timeout,
            excluded_families=excluded_families,
            excluded_candidates=excluded_candidates,
            use_role_agent=False,
        )
    else:
        if role not in EDIT_ROLES:
            raise ValueError("gateway_role_not_editable")
        result = run_edit_role(
            role,
            prompt,
            cwd=cwd,
            timeout=timeout,
            excluded_families=excluded_families,
            excluded_candidates=excluded_candidates,
            use_role_agent=False,
        )

    sys.stdout.write(json.dumps(_result_envelope(result), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, ProviderUnavailable) as exc:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": str(exc)[-1600:],
        }, ensure_ascii=False))
        raise SystemExit(2)
    except Exception as exc:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": ("gateway_internal_error:" + str(exc))[-1600:],
        }, ensure_ascii=False))
        raise SystemExit(3)
