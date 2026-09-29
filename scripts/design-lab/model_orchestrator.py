#!/usr/bin/env python3
"""Adaptive multi-model routing for the website design lab.

Published model strengths seed the priors. Real lab outcomes progressively
adjust routing without allowing one lucky run to permanently dominate.
"""
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from model_router import (
    ProviderUnavailable,
    antigravity_authenticated,
    antigravity_edit,
    antigravity_structured,
    codex_edit,
    codex_ready,
    codex_structured,
    copilot_ready,
    copilot_structured,
    ollama_ready,
    ollama_structured,
    opencode_ready,
    opencode_structured,
)

HOME = Path.home()
STATE = Path(os.environ.get(
    "DESIGN_LAB_STATE_DIR",
    str(HOME / ".local/state/engineering-orchestrator/design-lab"),
)).resolve()
PERFORMANCE = STATE / "model-performance.jsonl"

COST_POLICY = os.environ.get("MODEL_COST_POLICY", "free_only").strip().lower()
PAID_MODELS_EXPLICITLY_ENABLED = os.environ.get(
    "PAID_MODELS_EXPLICITLY_ENABLED", "0"
).strip().lower() in {"1", "true", "yes", "on"}
FREE_COST_CLASSES = {"free_quota", "free_hosted", "local_zero_external"}

def cost_allowed(spec):
    cost_class = spec.get("costClass")
    if cost_class in FREE_COST_CLASSES:
        return True
    return COST_POLICY == "allow_all" and PAID_MODELS_EXPLICITLY_ENABLED

# cost_class is relative operational cost, not a price quote.
CANDIDATES = {
    "ag-sonnet-4.6": {
        "provider": "antigravity",
        "model": "claude-sonnet-4-6",
        "agent": None,
        "effort": "high",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-opus-4.6": {
        "provider": "antigravity",
        "model": "claude-opus-4-6-thinking",
        "agent": None,
        "effort": "high",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-gemini-3.1-pro": {
        "provider": "antigravity",
        "model": "gemini-3.1-pro-high",
        "agent": None,
        "effort": "high",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-gemini-3.8-flash": {
        "provider": "antigravity",
        "model": "gemini-3.8-flash-high",
        "agent": None,
        "effort": "medium",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-gemini-3.7-flash": {
        "provider": "antigravity",
        "model": "gemini-3.7-flash-high",
        "agent": None,
        "effort": "medium",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-gemini-3.6-flash": {
        "provider": "antigravity",
        "model": "gemini-3.6-flash-high",
        "agent": None,
        "effort": "medium",
        "costClass": "free_quota",
        "visual": True,
        "editing": True,
    },
    "ag-gpt-oss-120b": {
        "provider": "antigravity",
        "model": "gpt-oss-120b-medium",
        "agent": None,
        "effort": "medium",
        "costClass": "free_quota",
        "visual": False,
        "editing": True,
    },
    "oc-longcat-2.5": {
        "provider": "opencode",
        "model": "opencode/longcat-2.5-preview-free",
        "agent": None,
        "effort": "medium",
        "costClass": "free_hosted",
        "visual": False,
        "editing": False,
    },
    "oc-mimo-2.6-flash": {
        "provider": "opencode",
        "model": "opencode/mimo-v2.6-flash-free",
        "agent": None,
        "effort": "medium",
        "costClass": "free_hosted",
        "visual": False,
        "editing": False,
    },
    "oc-space-bunny": {
        "provider": "opencode",
        "model": "opencode/space-bunny-free",
        "agent": None,
        "effort": "low",
        "costClass": "free_hosted",
        "visual": False,
        "editing": False,
    },
    "copilot-free-auto": {
        "provider": "copilot",
        "model": os.environ.get("COPILOT_FREE_MODEL", "auto"),
        "agent": None,
        "effort": "medium",
        "costClass": "free_quota",
        "visual": False,
        "editing": False,
    },
    "codex-astra": {
        "provider": "codex",
        "model": "gpt-6-astra",
        "agent": None,
        "effort": "high",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "codex-sol": {
        "provider": "codex",
        "model": "gpt-6-sol",
        "agent": None,
        "effort": "high",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "codex-luna": {
        "provider": "codex",
        "model": "gpt-6-luna",
        "agent": None,
        "effort": "medium",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "codex-5.6-sol": {
        "provider": "codex",
        "model": "gpt-5.6-sol",
        "agent": None,
        "effort": "high",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "codex-5.6-terra": {
        "provider": "codex",
        "model": "gpt-5.6-terra",
        "agent": None,
        "effort": "medium",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "codex-5.6-luna": {
        "provider": "codex",
        "model": "gpt-5.6-luna",
        "agent": None,
        "effort": "medium",
        "costClass": "subscription_quota",
        "visual": True,
        "editing": True,
    },
    "ollama-qwen-3b": {
        "provider": "ollama",
        "model": os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:3b"),
        "agent": None,
        "effort": "low",
        "costClass": "local_zero_external",
        "visual": False,
        "editing": False,
    },
}

# Initial priors are hypotheses. Outcome evidence is allowed to overturn them.
ROLE_POLICY = {
    "creative_direction": [
        ("ag-sonnet-4.6", 0.96),
        ("ag-gemini-3.1-pro", 0.92),
        ("ag-opus-4.6", 0.89),
        ("codex-astra", 0.85),
    ],
    "concept_challenger": [
        ("ag-gemini-3.1-pro", 0.96),
        ("ag-sonnet-4.6", 0.91),
        ("ag-gpt-oss-120b", 0.78),
        ("oc-longcat-2.5", 0.76),
        ("codex-astra", 0.84),
    ],
    "council_synthesis": [
        ("ag-opus-4.6", 0.98),
        ("codex-astra", 0.95),
        ("ag-gemini-3.1-pro", 0.91),
        ("ag-sonnet-4.6", 0.89),
    ],
    "implementation": [
        ("codex-astra", 0.99),
        ("codex-sol", 0.96),
        ("ag-sonnet-4.6", 0.94),
        ("ag-gemini-3.1-pro", 0.89),
        ("ag-gemini-3.8-flash", 0.82),
        ("codex-5.6-sol", 0.88),
        ("codex-5.6-terra", 0.84),
        ("ag-gemini-3.7-flash", 0.78),
        ("ag-gemini-3.6-flash", 0.74),
    ],
    "visual_review": [
        ("ag-opus-4.6", 0.99),
        ("codex-astra", 0.97),
        ("ag-sonnet-4.6", 0.96),
        ("ag-gemini-3.1-pro", 0.92),
    ],
    "visual_fix": [
        ("ag-sonnet-4.6", 0.98),
        ("codex-astra", 0.95),
        ("ag-gemini-3.1-pro", 0.90),
        ("ag-gemini-3.8-flash", 0.86),
    ],
    "code_fix": [
        ("codex-astra", 0.99),
        ("codex-sol", 0.96),
        ("ag-sonnet-4.6", 0.91),
        ("ag-gemini-3.8-flash", 0.84),
        ("codex-5.6-sol", 0.90),
        ("codex-5.6-terra", 0.87),
    ],
    "quick_qa": [
        ("ag-gemini-3.8-flash", 0.97),
        ("codex-luna", 0.93),
        ("ag-gemini-3.1-pro", 0.83),
        ("oc-space-bunny", 0.82),
        ("copilot-free-auto", 0.81),
        ("oc-mimo-2.6-flash", 0.80),
        ("ollama-qwen-3b", 0.68),
        ("codex-5.6-terra", 0.88),
        ("codex-5.6-luna", 0.86),
        ("ag-gemini-3.7-flash", 0.84),
        ("ag-gemini-3.6-flash", 0.80),
    ],
    "final_audit": [
        ("ag-opus-4.6", 0.99),
        ("codex-astra", 0.98),
        ("ag-sonnet-4.6", 0.91),
        ("ag-gemini-3.1-pro", 0.90),
    ],
    "offline_analysis": [
        ("ollama-qwen-3b", 0.92),
        ("ag-gemini-3.8-flash", 0.90),
        ("oc-mimo-2.6-flash", 0.88),
        ("copilot-free-auto", 0.875),
        ("oc-longcat-2.5", 0.87),
        ("ag-gpt-oss-120b", 0.86),
    ],
    "blocker_diagnosis": [
        ("ag-gemini-3.8-flash", 0.94),
        ("oc-space-bunny", 0.90),
        ("copilot-free-auto", 0.89),
        ("ollama-qwen-3b", 0.88),
        ("oc-longcat-2.5", 0.86),
        ("ag-gemini-3.1-pro", 0.84),
    ],
}

VISUAL_ROLES = {"creative_direction", "concept_challenger", "visual_review", "visual_fix", "final_audit"}
EDIT_ROLES = {"implementation", "visual_fix", "code_fix"}
ROLE_AGENTS = {
    "creative_direction": "web-art-director",
    "concept_challenger": "web-concept-challenger",
    "council_synthesis": "web-final-auditor",
    "implementation": "web-builder",
    "visual_review": "web-visual-critic",
    "visual_fix": "web-builder",
    "code_fix": "web-builder",
    "final_audit": "web-final-auditor",
}


def now():
    return datetime.now(timezone.utc).isoformat()


def _clamp(value, low=-1.0, high=1.0):
    return max(low, min(high, float(value)))


def read_outcomes():
    if not PERFORMANCE.exists():
        return []
    rows = []
    for line in PERFORMANCE.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except Exception:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def record_outcome(
    role,
    candidate,
    *,
    success,
    elapsed_seconds=None,
    qa_pass=None,
    score_before=None,
    score_after=None,
    selected=None,
    run_id=None,
    defect_types=None,
    note=None,
):
    if role not in ROLE_POLICY:
        raise ValueError("unknown_role")
    if candidate not in CANDIDATES:
        raise ValueError("unknown_candidate")
    delta = None
    if isinstance(score_before, (int, float)) and isinstance(score_after, (int, float)):
        delta = round(float(score_after) - float(score_before), 4)
    row = {
        "recordedAt": now(),
        "role": role,
        "candidate": candidate,
        "provider": CANDIDATES[candidate]["provider"],
        "model": CANDIDATES[candidate]["model"],
        "success": bool(success),
        "elapsedSeconds": elapsed_seconds,
        "qaPass": qa_pass,
        "scoreBefore": score_before,
        "scoreAfter": score_after,
        "scoreDelta": delta,
        "selected": selected,
        "runId": run_id,
        "defectTypes": defect_types or [],
        "note": note,
    }
    STATE.mkdir(parents=True, exist_ok=True)
    with PERFORMANCE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def outcome_reward(row):
    reward = 0.45 if row.get("success") is True else -0.75
    if row.get("qaPass") is True:
        reward += 0.15
    elif row.get("qaPass") is False:
        reward -= 0.20
    delta = row.get("scoreDelta")
    if isinstance(delta, (int, float)):
        reward += 0.35 * _clamp(delta / 0.6)
    else:
        absolute=row.get("scoreAfter")
        if isinstance(absolute,(int,float)):
            # Useful for initial builders/council choices where there is no
            # meaningful before-score. 8.6 is neutral; 9.4 is strongly positive.
            reward += 0.22 * _clamp((float(absolute)-8.6)/0.8)
    if row.get("selected") is True:
        reward += 0.10
    elif row.get("selected") is False:
        reward -= 0.03
    elapsed = row.get("elapsedSeconds")
    if isinstance(elapsed, (int, float)) and elapsed > 0:
        # Tiny latency preference; quality remains dominant.
        reward += 0.04 * _clamp((600.0 - elapsed) / 600.0)
    return _clamp(reward)


def empirical_stats(role, candidate):
    rows = [
        row for row in read_outcomes()
        if row.get("role") == role and row.get("candidate") == candidate
    ][-40:]
    if not rows:
        return {"samples": 0, "meanReward": 0.0, "successRate": None}
    rewards = [outcome_reward(row) for row in rows]
    successes = [1.0 if row.get("success") is True else 0.0 for row in rows]
    return {
        "samples": len(rows),
        "meanReward": round(sum(rewards) / len(rewards), 4),
        "successRate": round(sum(successes) / len(successes), 4),
    }


def provider_available(provider, model=None):
    if provider == "antigravity":
        return antigravity_authenticated()
    if provider == "codex":
        return codex_ready()
    if provider == "ollama":
        return ollama_ready()
    if provider == "opencode":
        return opencode_ready(model)
    if provider == "copilot":
        return copilot_ready()
    return False


def candidate_available(candidate, disabled_providers=None):
    spec = CANDIDATES[candidate]
    disabled = set(disabled_providers or ())
    return (
        cost_allowed(spec)
        and spec["provider"] not in disabled
        and provider_available(spec["provider"], spec.get("model"))
    )


def routing_score(role, candidate, prior):
    stats = empirical_stats(role, candidate)
    # Evidence influence rises gradually to 35%; sparse results cannot swing routing.
    evidence_weight = min(0.35, stats["samples"] * 0.05)
    score = float(prior) + evidence_weight * stats["meanReward"]
    # Small exploration bonus for under-tested candidates, capped so quality priors dominate.
    exploration = 0.025 / math.sqrt(stats["samples"] + 1)
    return round(score + exploration, 5), stats


def rank_candidates(role, *, disabled_providers=None, require_visual=False, require_edit=False):
    if role not in ROLE_POLICY:
        raise ValueError("unknown_role")
    ranked = []
    for candidate, prior in ROLE_POLICY[role]:
        spec = CANDIDATES[candidate]
        if require_visual and not spec.get("visual"):
            continue
        if require_edit and not spec.get("editing"):
            continue
        if not candidate_available(candidate, disabled_providers=disabled_providers):
            continue
        score, stats = routing_score(role, candidate, prior)
        ranked.append({
            "candidate": candidate,
            "routingScore": score,
            "prior": prior,
            "stats": stats,
            **spec,
        })
    return sorted(ranked, key=lambda item: (-item["routingScore"], item["candidate"]))


def choose_candidate(role, **kwargs):
    ranked = rank_candidates(role, **kwargs)
    return ranked[0] if ranked else None


def _candidate_by_name(name):
    if name not in CANDIDATES:
        raise ProviderUnavailable("unknown_candidate:" + str(name))
    return CANDIDATES[name]


def _require_cost_allowed(candidate, spec):
    if not cost_allowed(spec):
        raise ProviderUnavailable(
            "candidate_blocked_by_cost_policy:" + str(candidate) + ":" + COST_POLICY
        )


def run_structured_candidate(candidate, prompt, schema, *, cwd=None, timeout=240, images=None, agent_override=None):
    spec = _candidate_by_name(candidate)
    _require_cost_allowed(candidate, spec)
    provider = spec["provider"]
    started = time.monotonic()
    if provider == "antigravity":
        value = antigravity_structured(
            prompt,
            schema,
            cwd=cwd,
            timeout=timeout,
            model=spec["model"],
            agent=agent_override or spec.get("agent"),
            effort=spec.get("effort", "medium"),
            mode="plan",
        )
    elif provider == "codex":
        value = codex_structured(
            prompt,
            schema,
            cwd=cwd,
            timeout=timeout,
            model=spec["model"],
            effort=spec.get("effort"),
            images=images,
        )
    elif provider == "ollama":
        if images:
            raise ProviderUnavailable("ollama_candidate_has_no_visual_input")
        value = ollama_structured(prompt, schema, cwd=cwd, timeout=timeout)
    elif provider == "opencode":
        if images:
            raise ProviderUnavailable("opencode_candidate_has_no_visual_input")
        value = opencode_structured(prompt, schema, cwd=cwd, timeout=timeout, model=spec["model"])
    elif provider == "copilot":
        if images:
            raise ProviderUnavailable("copilot_candidate_has_no_visual_input")
        value = copilot_structured(prompt, schema, cwd=cwd, timeout=timeout, model=spec["model"])
    else:
        raise ProviderUnavailable("unsupported_provider:" + provider)
    return {
        "candidate": candidate,
        "provider": provider,
        "model": spec["model"],
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "value": value,
    }


def run_role_structured(
    role,
    prompt,
    schema,
    *,
    cwd=None,
    timeout=240,
    images=None,
    disabled_providers=None,
    require_premium=False,
):
    require_visual = bool(images) or role in VISUAL_ROLES
    errors = []
    for item in rank_candidates(
        role,
        disabled_providers=disabled_providers,
        require_visual=require_visual,
    ):
        if require_premium and item["provider"] == "ollama":
            continue
        candidate = item["candidate"]
        try:
            result = run_structured_candidate(
                candidate,
                prompt,
                schema,
                cwd=cwd,
                timeout=timeout,
                images=images,
                agent_override=ROLE_AGENTS.get(role),
            )
            result["routingScore"] = item["routingScore"]
            result["fallbackErrors"] = errors
            return result
        except ProviderUnavailable as exc:
            errors.append(candidate + ":" + str(exc))
    raise ProviderUnavailable(";".join(errors) or "no_role_candidate_available")


def run_edit_candidate(candidate, prompt, *, cwd, timeout=600, agent_override=None):
    spec = _candidate_by_name(candidate)
    _require_cost_allowed(candidate, spec)
    started = time.monotonic()
    if spec["provider"] == "antigravity":
        result = antigravity_edit(
            prompt,
            cwd=cwd,
            timeout=timeout,
            model=spec["model"],
            agent=agent_override or spec.get("agent"),
            effort=spec.get("effort", "medium"),
        )
    elif spec["provider"] == "codex":
        result = codex_edit(
            prompt,
            cwd=cwd,
            timeout=timeout,
            model=spec["model"],
            effort=spec.get("effort"),
        )
    else:
        raise ProviderUnavailable("candidate_cannot_edit_workspace")
    return {
        "candidate": candidate,
        "provider": spec["provider"],
        "model": spec["model"],
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "result": result,
    }


def run_edit_role(role, prompt, *, cwd, timeout=600, disabled_providers=None):
    errors = []
    for item in rank_candidates(
        role,
        disabled_providers=disabled_providers,
        require_edit=True,
    ):
        candidate = item["candidate"]
        try:
            result = run_edit_candidate(
                candidate,
                prompt,
                cwd=cwd,
                timeout=timeout,
                agent_override=ROLE_AGENTS.get(role),
            )
            result["routingScore"] = item["routingScore"]
            result["fallbackErrors"] = errors
            return result
        except ProviderUnavailable as exc:
            errors.append(candidate + ":" + str(exc))
    raise ProviderUnavailable(";".join(errors) or "no_edit_candidate_available")


PROPOSAL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "concept", "emotion", "hero", "typography", "composition",
        "signatureDevice", "mobile", "conversion", "antiTemplateRisks",
    ],
    "properties": {
        "concept": {"type": "string", "minLength": 1, "maxLength": 700},
        "emotion": {"type": "string", "minLength": 1, "maxLength": 300},
        "hero": {"type": "string", "minLength": 1, "maxLength": 900},
        "typography": {"type": "string", "minLength": 1, "maxLength": 700},
        "composition": {"type": "string", "minLength": 1, "maxLength": 900},
        "signatureDevice": {"type": "string", "minLength": 1, "maxLength": 700},
        "mobile": {"type": "string", "minLength": 1, "maxLength": 700},
        "conversion": {"type": "string", "minLength": 1, "maxLength": 500},
        "antiTemplateRisks": {"type": "array", "maxItems": 6, "items": {"type": "string", "maxLength": 300}},
    },
}

SYNTHESIS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "chosenDirection", "why", "discardedIdeas", "implementationMandates",
        "reviewRisks", "originalityCheck",
    ],
    "properties": {
        "chosenDirection": {"type": "object"},
        "why": {"type": "string", "minLength": 1, "maxLength": 1000},
        "discardedIdeas": {"type": "array", "maxItems": 6, "items": {"type": "string", "maxLength": 400}},
        "implementationMandates": {"type": "array", "minItems": 3, "maxItems": 10, "items": {"type": "string", "maxLength": 400}},
        "reviewRisks": {"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": 400}},
        "originalityCheck": {"type": "string", "minLength": 1, "maxLength": 700},
    },
}


def _first_available(preferred, role, disabled_providers=None):
    for candidate in preferred:
        if candidate_available(candidate, disabled_providers=disabled_providers):
            return candidate
    choice = choose_candidate(role, disabled_providers=disabled_providers)
    return choice["candidate"] if choice else None


def _run_preferred_structured(
    preferred, role, prompt, schema, *, cwd, timeout, disabled_providers=None,
    agent_override=None, exclude_candidates=None,
):
    excluded=set(exclude_candidates or ())
    ordered=[]
    for candidate in preferred:
        if candidate in excluded or candidate in ordered:
            continue
        if candidate_available(candidate, disabled_providers=disabled_providers):
            ordered.append(candidate)
    for item in rank_candidates(role, disabled_providers=disabled_providers):
        candidate=item["candidate"]
        if candidate not in excluded and candidate not in ordered:
            ordered.append(candidate)
    errors=[]
    for candidate in ordered:
        try:
            result=run_structured_candidate(
                candidate,prompt,schema,cwd=cwd,timeout=timeout,
                agent_override=agent_override,
            )
            result["fallbackErrors"]=errors
            return result
        except ProviderUnavailable as exc:
            errors.append(candidate+":"+str(exc))
    raise ProviderUnavailable(";".join(errors) or "no_preferred_candidate_available")


def run_design_council(brief, context, *, cwd, disabled_providers=None, timeout=240):
    """Generate two deliberately independent concepts and synthesize them.

    Failure is graceful: callers may continue with their existing builder prompt.
    """
    common = {
        "brief": brief,
        "trainingContext": context,
    }

    primary_prompt = """Act as a senior digital art director for a premium SME website.
Create ONE authored, specific art direction from the supplied evidence. Avoid generic component recipes.
Your job is concept, typography, spatial composition, signature visual language, mobile recomposition and conversion hierarchy.
Do not invent business facts, proof, testimonials or documentary imagery.
Return only the required JSON.
EVIDENCE:
""" + json.dumps(common, ensure_ascii=False)
    challenger_prompt = """Act as an independent digital design challenger.
Create a materially DIFFERENT premium direction for the same SME brief. Do not merely recolor or reorder a standard landing page.
Challenge the obvious composition, visual metaphor and typography while preserving factual honesty, accessibility and conversion.
Return only the required JSON.
EVIDENCE:
""" + json.dumps(common, ensure_ascii=False)

    primary = _run_preferred_structured(
        ["ag-sonnet-4.6", "ag-gemini-3.1-pro", "codex-astra"],
        "creative_direction", primary_prompt, PROPOSAL_SCHEMA,
        cwd=cwd, timeout=timeout, disabled_providers=disabled_providers,
        agent_override="web-art-director",
    )
    challenger = _run_preferred_structured(
        ["ag-gemini-3.1-pro", "ag-gpt-oss-120b", "ag-opus-4.6", "codex-astra"],
        "concept_challenger", challenger_prompt, PROPOSAL_SCHEMA,
        cwd=cwd, timeout=timeout, disabled_providers=disabled_providers,
        agent_override="web-concept-challenger",
        exclude_candidates={primary["candidate"]},
    )

    synthesis_prompt = """You are the chief design director arbitrating two independent website directions.
Select or synthesize the strongest direction WITHOUT averaging them into a bland compromise.
Prefer the idea with the clearest brand-specific visual logic, typography, spatial rhythm, mobile translation and conversion path.
Reject template smell and unsupported business facts. The chosenDirection must be implementable with local HTML/CSS/JS.
Return only the required JSON.
INPUT:
""" + json.dumps({
            "brief": brief,
            "primary": primary["value"],
            "challenger": challenger["value"],
            "trainingContext": context,
        }, ensure_ascii=False)
    synthesis = _run_preferred_structured(
        ["ag-opus-4.6", "ag-gemini-3.1-pro", "ag-sonnet-4.6", "codex-astra"],
        "council_synthesis", synthesis_prompt, SYNTHESIS_SCHEMA,
        cwd=cwd, timeout=timeout, disabled_providers=disabled_providers,
        agent_override="web-final-auditor",
    )

    return {
        "createdAt": now(),
        "primary": primary,
        "challenger": challenger,
        "synthesis": synthesis,
        "officialScoreAuthority": False,
    }


def route_fix_role(review, qa=None):
    """Choose visual vs structural correction from actual defects."""
    text = json.dumps({"review": review, "qa": qa or {}}, ensure_ascii=False).lower()
    code_markers = (
        "runtime", "javascript", "console", "accessibility", "aria", "overflow",
        "missing_", "http", "error", "link", "target", "semantic",
    )
    visual_markers = (
        "polish", "typography", "composition", "identity", "rhythm", "spacing",
        "layout", "hero", "visual", "mobile", "tablet", "hierarchy",
    )
    code_hits = sum(text.count(marker) for marker in code_markers)
    visual_hits = sum(text.count(marker) for marker in visual_markers)
    return "code_fix" if code_hits > visual_hits else "visual_fix"


def policy_snapshot():
    return {
        "generatedAt": now(),
        "costPolicy": COST_POLICY,
        "paidModelsExplicitlyEnabled": PAID_MODELS_EXPLICITLY_ENABLED,
        "freeCostClasses": sorted(FREE_COST_CLASSES),
        "candidates": CANDIDATES,
        "roles": {
            role: [
                {
                    "candidate": candidate,
                    "prior": prior,
                    "empirical": empirical_stats(role, candidate),
                }
                for candidate, prior in candidates
            ]
            for role, candidates in ROLE_POLICY.items()
        },
    }


if __name__ == "__main__":
    print(json.dumps(policy_snapshot(), ensure_ascii=False, indent=2))
