# Security

The policy engine is deterministic. Merge, production deployment, destructive data changes, secrets and communications require approval. Force-push to main, deletion of repositories, printing secrets, disabling security, production testing and approval bypass are forbidden.

Commands must be configured, are split without a shell, reject metacharacters, time out and have output capped/masked. LLM/planner output cannot execute commands or override policy. Tokens only reside in environment variables. Recognised GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), OpenAI (`sk-`) and Bearer tokens are replaced in full with `[REDACTED]` before persistence.

Project configuration can add approval or forbidden actions; global forbidden actions can never be downgraded.
