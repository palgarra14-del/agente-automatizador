# Model specialization policy

Research date: 2026-09-29.

This policy exists to prevent one model from becoming the default for every task. Routing stays adaptive: local outcome evidence may overturn these priors, but each model starts from work that matches its published strengths. Cost policy remains authoritative; subscription/paid candidates stay unavailable while `MODEL_COST_POLICY=free_only`.

## Evidence-backed assignments

| Model / route | Primary jobs | Why |
| --- | --- | --- |
| Antigravity + Claude Sonnet 4.6 | Art direction, frontend implementation, visual correction, focused code fixes | Anthropic describes Sonnet 4.6 as a major upgrade in coding, agent planning, computer use, knowledge work and design; early users reported better context reading, instruction following and less overengineering. |
| Antigravity + Claude Opus 4.6 | Design arbitration, deep refactors, independent review, final audit | Anthropic positions Opus 4.6 for the deepest reasoning, large-codebase refactoring, longer agentic work and coordination of multiple agents. |
| Antigravity + Gemini 3.1 Pro | Independent concept challenger, complex multimodal reasoning and review | Google positions Gemini 3.1 Pro for complex tasks requiring broad world knowledge and advanced reasoning across modalities. |
| Antigravity + Gemini 3.8 Flash | Autonomous orchestration, long-horizon implementation, research/audit, blocker diagnosis and fast QA | Google describes Gemini 3.8 Flash as engineered for long-horizon software engineering, autonomous agents and complex enterprise workflows, and now uses it as Antigravity's default model. |
| Antigravity + GPT-OSS 120B | Text-only structured reasoning, independent logic review and blocker analysis | OpenAI describes gpt-oss-120b as an open-weight reasoning model with tool use, structured outputs and agentic capabilities. Keep it out of visual authority. |
| OpenCode + MiMo V2.6 Flash Free | High-frequency structured work, quick QA and large-context text/code analysis | Xiaomi positions MiMo V2.6 Flash as a high-intelligence, low-cost model for high-frequency professional workflows, with 1M context, tool calls and structured output. |
| OpenCode + Space Bunny / LongCat | Low-stakes fallback and empirical exploration | Free hosted options are useful redundancy, but their authority is intentionally limited until our own outcome ledger proves a stronger specialty. |
| GitHub Copilot Auto | Reliability fallback for straightforward QA/triage | GitHub Auto selects models using task complexity plus real-time health/availability. The underlying model is opaque, so it is not a final authority. |
| Ollama + Qwen2.5-Coder 3B | Private/offline triage, classification, normalization and simple code checks | Local execution has zero external inference and is ideal for cheap repetitive pre-processing. Its small size makes it inappropriate for architecture or final review. |
| Codex + GPT-6 Astra | Hardest end-to-end implementation, deep analysis and final audit when explicitly enabled | OpenAI positions Astra as its highest-capability model for complex reasoning, software engineering, browsing and computer use. |
| Codex + GPT-6 Sol | Demanding everyday coding and agentic workflows when explicitly enabled | OpenAI positions Sol as the strong everyday driver for demanding reasoning/coding with a better efficiency balance. |
| Codex + GPT-6 Luna | Focused repeatable/high-volume tasks when explicitly enabled | OpenAI positions Luna for scoped, frequent, efficient automation. |

## Workflow allocation

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

1. Private/local triage: Qwen local.
2. Diagnosis: Gemini 3.8 Flash.
3. UI work: Sonnet 4.6.
4. Core/refactor work: Gemini 3.8 Flash; Opus for deep refactors.
5. Bulk regression classification: Qwen or MiMo.
6. Independent review: Opus / Gemini 3.1 Pro from a different family.
7. Final gate: Opus.

### Lead Finder

1. Research/enrichment reasoning: Gemini 3.8 Flash.
2. Bulk normalization/scoring preparation: Qwen local or MiMo.
3. Ranking/quality diagnosis: Gemini 3.8 Flash.
4. Core implementation: Gemini 3.8 Flash.
5. Independent review: Opus or Gemini 3.1 Pro.
6. Final gate: Opus.

### Autonomous self-improvement

1. Cheap local triage: Qwen local.
2. Blocker diagnosis: Gemini 3.8 Flash.
3. Plan/delegate: Gemini 3.8 Flash; Opus for unusually difficult coordination.
4. Bounded implementation: Gemini 3.8 Flash.
5. Large refactor: Opus.
6. Fast validation: Gemini 3.8 / MiMo / deterministic tests.
7. Independent review: different model family from the implementer.
8. Final audit: Opus.

## Routing rules

- Keep `free_only` as the default hard boundary. No research result may silently unlock subscription or paid inference.
- Use the lightest model that reliably clears the quality bar; empirical outcomes can change priors gradually.
- A builder must not be its only reviewer. High-impact work should have at least one reviewer from a different model family.
- Opaque or stealth models can earn more authority only through repeated successful local outcomes.
- Public/synthetic data can use free hosted fallback models. Personal, confidential or commercially sensitive data should prefer local/private routes unless the provider's handling is explicitly acceptable.
- Deterministic tests, browser QA and repository policy remain authoritative over model confidence.

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
