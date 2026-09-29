# Multi-model website orchestration

This document is the policy source for the autonomous website design lab. The objective is not to crown one model as "best"; it is to route each phase to the strongest available specialist, verify the result with another family, and learn from our own measured outcomes.

## Quality principle

Published model strengths are initial priors only. The lab records success, QA pass/fail, visual score movement, elapsed time, and role-specific outcomes. As samples accumulate, empirical performance can override the initial ordering.

No local/offline model may award official visual scores or declare design mastery. Mastery remains tied to deterministic QA plus a validated premium visual reviewer. Experimental reviewers may guide fixes but are recorded separately until calibrated.

## Current specialist priors

| Role | Preferred specialist | Why it starts there | Fallbacks |
| --- | --- | --- | --- |
| Creative direction | Antigravity / Claude Sonnet 4.6 | Strong frontend design sensibility, layout, interaction and polish | Gemini 3.1 Pro, Claude Opus 4.6 |
| Concept challenger | Antigravity / Gemini 3.1 Pro | Strong reasoning plus interactive UI / visual systems; useful independent alternative | Sonnet 4.6, GPT-OSS-120B |
| Council synthesis | Antigravity / Claude Opus 4.6 | Deep reasoning, arbitration, code/design review and long-horizon planning | GPT-6 Astra, Gemini 3.1 Pro |
| Production implementation | Codex / GPT-6 Astra | Hard end-to-end software engineering and multi-step execution | GPT-6 Sol, Sonnet 4.6, Gemini 3.1 Pro |
| Fast implementation/refinement | Gemini 3.8 Flash High | Fast agentic coding loop with good reasoning-to-latency ratio | GPT-6 Luna, Gemini 3.7 Flash |
| Visual review | Claude Opus 4.6 | Severe cross-cutting critic and arbitration | Sonnet 4.6, GPT-6 Astra when image review is available, Gemini 3.1 Pro |
| Visual/polish fix | Claude Sonnet 4.6 | Frontend aesthetics and implementation together | GPT-6 Astra, Gemini 3.8 Flash High |
| Structural/code fix | GPT-6 Astra | Complex code, debugging and systemic changes | GPT-6 Sol, Sonnet 4.6 |
| Final cross-family audit | Claude Opus 4.6 + GPT-6 Astra | Independent families reduce self-grading bias | Sonnet 4.6 + Gemini 3.1 Pro |
| Repetitive QA/triage | Gemini 3.8 Flash / GPT-6 Luna | High-volume, bounded tasks | Qwen local for advisory-only work |
| Offline continuity / blocker diagnosis | Qwen2.5-Coder 3B local | Zero external quota/cost, always available on MSI | Antigravity free models when signed in |
| Generated UI/graphic assets | Antigravity generative image tool / Nano Banana 2 | Native UI mockup / image generation path | Keep assets abstract/honest when no real business media exists |

## Website quality pipeline

1. Normalize the brief and factual constraints.
2. Run a design council:
   - Sonnet produces a primary art direction.
   - Gemini Pro independently challenges it with a different composition/system.
   - Opus (or Astra) synthesizes the strongest concept without averaging away originality.
3. Build with the strongest available implementation agent.
4. Run deterministic Chrome QA. This remains authoritative for runtime, accessibility, responsive and conversion defects.
5. Run a visual critic from a different model family than the builder.
6. Route each correction by defect type:
   - typography, rhythm, layout, identity, polish -> visual specialist;
   - JS, runtime, accessibility, architecture -> engineering specialist;
   - bounded mechanical fixes -> fast model.
7. Re-render and re-score.
8. Final cross-family audit before publication/mastery.
9. Record every assignment and outcome. Use the evidence to update future routing.

## Learning signal

For each role/model attempt the router records:

- provider/model/agent;
- task role and website/run id;
- success/failure;
- elapsed seconds;
- deterministic QA pass;
- quality before/after when available;
- score delta;
- whether the result was selected;
- optional defect categories.

A model's empirical routing score uses a conservative blend of the prior plus recent outcome quality. Sparse samples never erase the prior immediately, and failures reduce the score. This avoids both permanent hard-coding and wild switching after one lucky run.

## Cost and quota policy

- Prefer free Antigravity capacity when it meets the quality bar.
- Use subscription-backed Codex for high-value engineering rather than spending API money automatically.
- Qwen local is zero-external-cost continuity, not a premium visual judge.
- An OpenAI API key, if explicitly enabled later, must have a user-defined spend ceiling before the orchestrator may use it.
- Never silently convert a quota outage into unbounded paid API usage.

## Safety and factual honesty

- Do not fabricate reviews, awards, customers, credentials, guarantees, years, project photos or business facts.
- Generated imagery must not be presented as documentary evidence of the real business.
- Do not weaken deterministic QA or approval/security boundaries to increase throughput.
- A model cannot grade its own build as the sole final authority.
