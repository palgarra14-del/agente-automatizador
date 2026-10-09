# Model specialization policy

Research date: 2026-09-29.

This policy exists to prevent one model from becoming the default for every task. Routing stays adaptive: local outcome evidence may overturn these priors, but each model starts from work that matches its published strengths. Cost policy remains authoritative; subscription/paid candidates stay unavailable while `MODEL_COST_POLICY=free_only`.

## Cost and quota governance

Paid API inference is hard-disabled in the multi-model gateway. The gateway strips both `CODEX_API_KEY` and `OPENAI_API_KEY`; Codex candidates use session authentication only. `subscription_quota` is a distinct resource class from generic paid inference and is eligible only under `MODEL_COST_POLICY=subscription_included`.

Codex subscription headroom is currently an environment-fed control because this runtime has no stable machine-readable quota endpoint. Operators or future telemetry may set `CODEX_SUBSCRIPTION_REMAINING_PERCENT` (or the equivalent `CODEX_SUBSCRIPTION_HEADROOM_PERCENT`). The governor reserves 20% by default and blocks subscription candidates when known remaining headroom is at or below that reserve. `CODEX_SUBSCRIPTION_RESERVE_OVERRIDE=1` is an explicit emergency override. Unknown headroom remains usable under `subscription_included`, but routing metadata and policy snapshots report it as `unknown`; no interactive terminal UI is scraped.

## Evidence-backed assignments

| Model / route | Primary jobs | Why |
| --- | --- | --- |
| Antigravity + Claude Sonnet 4.6 | Art direction, frontend implementation, visual correction, focused code fixes | Anthropic describes Sonnet 4.6 as a major upgrade in coding, agent planning, computer use, knowledge work and design; early users reported better context reading, instruction following and less overengineering. |
| Antigravity + Claude Opus 4.6 | Design arbitration, deep refactors, independent review, final audit | Anthropic positions Opus 4.6 for the deepest reasoning, large-codebase refactoring, longer agentic work and coordination of multiple agents. |
| Antigravity + Gemini 3.1 Pro | Independent concept challenger, complex multimodal reasoning and review | Google positions Gemini 3.1 Pro for complex tasks requiring broad world knowledge and advanced reasoning across modalities. |
| Antigravity + Gemini 3.8 Flash | Autonomous orchestration, long-horizon implementation, research/audit, blocker diagnosis and fast QA | Google describes Gemini 3.8 Flash as engineered for long-horizon software engineering, autonomous agents and complex enterprise workflows, and now uses it as Antigravity's default model. |
| Antigravity + GPT-OSS 120B | Text-only structured reasoning, independent logic review and blocker analysis | OpenAI describes gpt-oss-120b as an open-weight reasoning model with tool use, structured outputs and agentic capabilities. Keep it out of visual authority. |
| OpenCode + Muse Spark 1.3 Contributor Free | Structured bulk work, quick QA and first-pass blocker diagnosis | Best measured latency/accuracy balance in the 2026-10-07 local benchmark: 4/4 representative tasks at ~3.5 s mean. |
| OpenCode + MiMo V2.6 Flash Free | Structured work, quick QA, blocker diagnosis and coding-oriented review | 4/4 representative tasks at ~6.7 s mean; reliable general OpenCode workhorse. |
| OpenCode + Nemotron 3 Ultra Free | Research/audit, blocker diagnosis and independent text review | 4/4 representative tasks at ~8.6 s mean; reserve more authority for reasoning than for pure throughput. |
| OpenCode + LongCat 2.5 Preview Free | Structured work, QA and diagnosis fallback | 4/4 representative tasks at ~9.5 s mean; reliable but slower than Muse/MiMo. |
| OpenCode + Nemotron 3.5 Lightning Free | Harder orchestration/review/diagnosis fallback | 4/4 representative tasks but ~24 s mean; accurate enough to keep, too slow for routine bulk work. |
| OpenCode + Ling 3.1 Flash Free | Selective blocker diagnosis and research fallback | Passed QA, diagnosis and commercial-scope reasoning but timed out on structured extraction. |
| OpenCode + Space Bunny Free | Very fast factual extraction and low-stakes QA | Extremely fast, but missed blocker diagnosis and one QA classification; never use as final authority. |
| GitHub Copilot Auto | Reliability fallback for straightforward QA/triage | GitHub Auto selects models using task complexity plus real-time health/availability. The underlying model is opaque, so it is not a final authority. |
| Ollama + Qwen2.5-Coder 3B | Offline/private necessity only | Local model loading consumed ~2.2 GB during the 2026-10-07 benchmark. Normal work must prefer hosted-free routes; local requests set `keep_alive=0` so model memory is released immediately afterward. |
| Codex + GPT-6 Astra | Hardest end-to-end implementation, deep analysis and final audit when explicitly enabled | OpenAI positions Astra as its highest-capability model for complex reasoning, software engineering, browsing and computer use. |
| Codex + GPT-6 Sol | Demanding everyday coding and agentic workflows when explicitly enabled | OpenAI positions Sol as the strong everyday driver for demanding reasoning/coding with a better efficiency balance. |
| Codex + GPT-6 Luna | Focused repeatable/high-volume tasks when explicitly enabled | OpenAI positions Luna for scoped, frequent, efficient automation. |

## OpenCode empirical gate — 2026-10-07

Representative tests covered factual extraction, JavaScript QA, provider-failure diagnosis and commercial scope discipline. They are a routing seed, not a permanent benchmark: production outcomes remain more authoritative and can move priors gradually.

| Free model exposed by OpenCode | Result | Routing decision |
| --- | --- | --- |
| Muse Spark 1.3 Contributor | 4/4; ~3.45 s mean | Preferred high-volume hosted worker. |
| MiMo V2.6 Flash | 4/4; ~6.73 s | General hosted workhorse. |
| Nemotron 3 Ultra | 4/4; ~8.62 s | Research/diagnosis/review. |
| LongCat 2.5 Preview | 4/4; ~9.49 s | Reliable fallback. |
| Nemotron 3.5 Lightning | 4/4; ~24.07 s | Harder reasoning only; avoid bulk latency. |
| Ling 3.1 Flash | 3/4; ~16.37 s | Selective diagnosis/research; avoid bulk extraction. |
| Space Bunny | partial 3/4-equivalent; ~4.13 s | Fast extraction/low-stakes QA only. |
| Ling 3.0 Flash Fin | endpoint unavailable | Do not route until a later probe proves availability. |
| Fledge Alpha | region unavailable in Spain | Do not route. |
| Exo | four 35 s timeouts | Do not route until a later probe proves useful latency. |

The OpenCode catalogue can also expose `ollama/*` models. Those are **not** hosted-free capacity and must never be treated as a substitute for the hosted models above; they still execute locally and inherit the Ollama heavy-local policy.

## Workflow allocation

### Implementation role envelope

Implementation routing is derived from an inspectable structured task envelope: workflow profile, allowed scope paths, validated inspection/diagnosis relevant paths, and an approved plan when present. Website builds remain `frontend_implementation`. A validated one- or two-file bounded evidence set routes to `code_fix`; broader app and self-improvement changes route to `long_horizon_implementation`. `deep_refactor` is reserved for an explicit structured scope/classification signal such as `changeScope=deep_refactor`, `broad`, or `large_refactor`; prose keywords alone never select it.

### Quota-preserving waves

For `quick_qa` and `structured_bulk`, routing waves are: hosted-free OpenCode first, workhorse-free Antigravity/Copilot second, subscription Codex third, deeper free models fourth, and local Ollama last. Implementation roles do not use these throughput waves: subscription Codex is eligible and can rank highly under `subscription_included`, while `free_only` behavior is unchanged.

### Website production

1. Research / factual audit: Gemini 3.8 Flash.
2. Art direction: Sonnet 4.6.
3. Independent concept challenge: Gemini 3.1 Pro; never reuse the primary model family.
4. Arbitration: Opus 4.6.
5. Frontend build: Sonnet 4.6 by default in free-only mode; Gemini 3.8 Flash is the long-horizon fallback.
6. Runtime/code correction: Sonnet 4.6 or Gemini 3.8 Flash.
7. Visual review: reviewer family must differ from the builder family when possible.
8. Final gate: Opus 4.6. Codex Astra can become the premium final authority only after explicit cost-policy enablement.

### Callflow

1. Private/offline triage: Qwen local only when locality is actually required; unload it immediately afterward.
2. Diagnosis: Gemini 3.8 Flash first; Muse/MiMo/Nemotron hosted-free fallbacks.
3. UI work: Sonnet 4.6.
4. Core/refactor work: Gemini 3.8 Flash; Opus for deep refactors.
5. Bulk regression classification: Muse first, then MiMo/Space Bunny/Nemotron/LongCat; Ollama only as the final heavy-local fallback.
6. Independent review: Opus / Gemini 3.1 Pro; Nemotron/LongCat provide hosted-free text-review redundancy.
7. Final gate: Opus.

### Lead Finder

1. Research/enrichment reasoning: Gemini 3.8 Flash; Nemotron 3 Ultra/LongCat as hosted-free fallbacks.
2. Bulk normalization/scoring preparation: Muse first, then MiMo/Space Bunny/Nemotron/LongCat.
3. Ranking/quality diagnosis: Gemini 3.8 Flash; Muse/MiMo/Nemotron hosted-free fallbacks.
4. Core implementation: Gemini 3.8 Flash.
5. Independent review: Opus or Gemini 3.1 Pro; hosted Nemotron/LongCat when deeper free quota is unavailable.
6. Final gate: Opus.

### Autonomous self-improvement

1. Cheap triage: Muse/MiMo hosted-free; Qwen local only for genuine offline/private necessity.
2. Blocker diagnosis: Gemini 3.8 Flash, then Muse/MiMo/Nemotron/LongCat.
3. Plan/delegate: Gemini 3.8 Flash; Nemotron 3.5 Lightning is the slower hosted-free fallback for harder orchestration; Opus for unusually difficult coordination.
4. Bounded implementation: Gemini 3.8 Flash.
5. Large refactor: Opus.
6. Fast validation: Muse / MiMo / Gemini 3.8 / deterministic tests.
7. Independent review: different model family from the implementer.
8. Final audit: Opus.

## Routing rules

- Keep `free_only` as the default hard boundary. No research result may silently unlock subscription or paid inference.
- Use the lightest model that reliably clears the quality bar; empirical outcomes can change priors gradually.
- A builder must not be its only reviewer. High-impact work should have at least one reviewer from a different model family.
- Opaque or stealth models can earn more authority only through repeated successful local outcomes.
- Public/synthetic data can use free hosted fallback models. Personal, confidential or commercially sensitive data should prefer local/private routes unless the provider's handling is explicitly acceptable.
- Deterministic tests, browser QA and repository policy remain authoritative over model confidence.
- Quality remains dominant, but measured latency has a materially larger objective weight for `quick_qa` and `structured_bulk` than for `research_and_audit`, `final_audit`, or `deep_refactor`. Learning remains conservative: evidence influence is capped and requires repeated samples, so a faster equally-successful bulk worker can eventually beat a slightly higher prior without turning speed into authority for final review.

## Research sources

- OpenAI model selection and GPT-6 guidance: https://developers.openai.com/api/docs/guides/model-selection and https://developers.openai.com/api/docs/guides/latest-model
- OpenAI GPT-6 models: https://developers.openai.com/api/docs/models
- Anthropic Sonnet 4.6: https://www.anthropic.com/news/claude-sonnet-4-6
- Anthropic Opus 4.6: https://www.anthropic.com/news/claude-opus-4-6
- Google Gemini model guide and Gemini 3.8 Flash: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/latest-model
- Google Antigravity agent: https://ai.google.dev/gemini-api/docs/antigravity-agent
- GitHub Copilot Auto: https://docs.github.com/en/copilot/concepts/models/auto-model-selection
- OpenCode model catalogue: https://opencode.ai/v2/docs/console/models/
- Xiaomi MiMo V2.6 Flash: https://mimo.mi.com/models/en-US/mimo-v2.6-flash
- OpenAI gpt-oss-120b: https://developers.openai.com/api/docs/models/gpt-oss-120b
