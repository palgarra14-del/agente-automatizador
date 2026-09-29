# Free-only AI operating policy

This repository runs in **zero incremental cost mode by default**.

## Invariants

- Do not enable, purchase, upgrade, or consume a paid API/subscription automatically.
- Free/local capacity may be used until its free quota is exhausted.
- On quota exhaustion, policy restriction, authentication failure, or plan-required response, fall back to another free/local provider instead of paying.
- A model labelled `subscription_quota` or any future paid cost class is blocked by default even when its CLI is installed and authenticated.
- Direct candidate execution must obey the same cost policy as ranked routing; paid models may not bypass routing safeguards.
- OpenCode hosted models are eligible only when their model id is explicitly `opencode/*-free`. Ambiguous OpenCode models are blocked.
- Local Ollama models are eligible as `local_zero_external`.
- Copilot Free and OpenCode Free remain opt-in until a real live probe on the MSI succeeds. A provider that times out or returns a policy/plan error stays disabled.
- ChatGPT-side integrations such as Figma, Replit, and Base44 are not assumed to be autonomous MSI providers merely because their ChatGPT plugins are connected.

## Paid-model unlock

Paid/subscription candidates require **both** conditions:

1. `MODEL_COST_POLICY=allow_all`
2. `PAID_MODELS_EXPLICITLY_ENABLED=1`

Setting only one of them must not enable paid models.

The default is:

```text
MODEL_COST_POLICY=free_only
PAID_MODELS_EXPLICITLY_ENABLED=0
```

Only change both after explicit user authorization to spend money.

## Current cost classes

- `free_quota`: provider/account quota that does not create incremental spend under the current configuration.
- `free_hosted`: explicitly free hosted model.
- `local_zero_external`: local inference with no external model charge.
- `subscription_quota`: blocked in free-only mode.

## Operational behavior

When a provider fails:

1. record the failure;
2. avoid repeated blocking retries within the same workflow when practical;
3. continue to the next free/local candidate;
4. never upgrade a plan, buy credits, or add billing information;
5. preserve enough telemetry to compare quality, latency, and reliability later.
6. temporarily suppress a provider after provider-wide quota/auth/billing/service failures, while keeping model-specific failures isolated to that candidate.

Quality routing remains role-specific. Free-only mode is a cost constraint, not a reason to collapse all work onto one model.
