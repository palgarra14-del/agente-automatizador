# Reliability gates for autonomous commercial work

Status: implementation and validation checklist. **A green CI on an open PR is not a deployed fix.** Do not merge, deploy, change tokens, spend money, or send communications outside governed approval.

## Historical evidence baseline (Arch 2026-10-06 to 2026-10-09)

The anonymized operator journal audit covered 114,152 log entries and found 951 **signature matches**, not distinct incidents. Largest groups: 531 generic GitHub/API matches (480 from inbox), 162 GitHub rate-limit matches, 148 workspace-integrity matches (147 Website Pilot), 50 auth matches, and 26 lease matches. The inbox detail identified 17 `github_issue_queue_request_timeout` lines, including a long cluster on Oct 7; `github_cli_auth_required` appeared in repeated startup tracebacks. Older WSL, Actions and ASUS journals are not exhausted by that sample.

## Contracts that all lanes must satisfy

1. **One source of authority per state**: GitHub state ref/ledger and leases are not replaced by process memory or a UI signal. Ref/history mismatch fails closed, without destructive auto-repair.
2. **One durable rate-limit signal per host**: all local GitHub consumers must respect GitHub 403/429 cool-down, with response reset/retry headers or bounded secondary-limit fallback. A permissions 403 must not be treated as an authentication retry.
3. **Real progress, not activity**: a timer, running systemd unit or successful wrapper is liveness only. Count verified useful workflow completion, reviewed commit, CI-bound PR, or successful internal website artifact separately.
4. **Failover without duplication**: release/claim transitions are idempotent, bounded and lease-checked. Never restart healthy busy workers to rebalance or reuse unverified workflow history.
5. **Model capacity before attempts**: model CLIs work from noninteractive systemd paths. Unavailable providers must not be probed repeatedly per candidate; unavailable roles log bounded exclusion reasons without leaking credentials. No extra paid API; Codex subscription reserve cannot be claimed proven when remaining headroom is unknown.
6. **Commercial gates**: prioritize Website Pilot saleable Essential demos, Callflow next-best-action and LeadFinder contactable qualified leads. An automated cycle without deliverable is not a sale.

## Regression gates before integrating PR #473 or successors

- Simulate 403/429 with Retry-After and secondary-limit body, and a distinct unauthorized 401 and forbidden 403. Verify shared host cooldown prevents both heartbeat dispatch and inbox polls, including after a process restart.
- Simulate 10+ successive GitHub timeouts: no busy-loop, bounded exponential pause, no loss of queue records or idempotent notification IDs; success restores normal cadence.
- Cold-start user systemd with temporary GitHub CLI unavailability: bounded restart interval; eventual authentication without token persistence or secret logging. Verify after actual reboot.
- On current Arch, verify `agy`, `opencode`, `codex` **from transient systemd context**, and inspect per-role candidate counts. A shell-only PATH check is insufficient.
- Inject crashed/contended lease and changed managed workspace path: no work duplicate, no silent rollback repair, complete resume only after verifying trusted state.
- Complete 2–3 fact-based Pack Esencial briefs end-to-end: QA/preview, factuality, mobile/contact/booking, time human spent, no invented claims or unauthorized publication.

## Release protocol

Keep the exact CI SHA, human-reviewed diff, installed runtime SHA and post-rollout sample in the incident record. States: `identified` -> `fixed_in_pr` -> `ci_verified` -> `runtime_verified` -> `regression_guarded`. Only a real post-rollout test can establish `runtime_verified`.

Outstanding architecture work must reuse #204/#359 for Cloud State, #433/#452 for runners/failover, #439 for quota metering, and #468 for Website Pilot verification. Do not create overlapping ownerless watchdogs or silently revive superseded designs.
