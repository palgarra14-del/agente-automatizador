# Cloud State v2 protocol — r6 generation-claim authority

## Purpose

Cloud State v2 provides durable, monotonic, per-lane cloud state without trusting process-local memory or mutable Git refs as durable authority.

The protocol is fail-closed. It rejects rollback, forks, malformed lineage, unproven publication, cross-lane substitution, secret-bearing state, and ambiguous crash recovery.

r6 uses:

- immutable Git state commits;
- append-only GitHub commit statuses as durable authority;
- 256-generation epochs to bound normal verification cost;
- a deterministic create-only Git ref claim as the **single-writer election primitive** for each generation;
- state/checkpoint/witness refs only as repairable operational pointers.

## Why r5 and the first r6 draft were rejected

r5 used a pre-state-ref intent. That intent proved only that a candidate existed; it did not prove that the writer won the ref election.

The first r6 draft then treated a successful `PATCH ref force:false` plus reread as a CAS. GitHub only guarantees that such an update is a fast-forward; the API does not accept an expected-old-SHA precondition. A contents-writer could therefore race the ref to the exact candidate and make a later update/no-op look successful.

The corrected r6 does not use stateRef mutation as the election proof.

## Mutable refs

Each lane owns:

- state ref: the configured lane tag;
- checkpoint ref: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- witness ref: `agent-cloud-state-v2-witnesses/<stateTag>`.

These refs are operational pointers only. They can be missing, stale, or externally moved by `contents: write`, so they never create durable authority.

Supported repair only moves them forward, non-force, to already-proven canonical authority.

## Generation claim namespace

The reserved claim root is:

`agent-cloud-state-v2-claims`

A state tag may not equal that root.

Each lane derives a 128-bit digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- checkpoint tag;
- witness tag.

For generation `G`, the deterministic claim tag is:

`agent-cloud-state-v2-claims/<laneDigest>/<epoch>/<G>`

where:

`epoch = floor((G - 1) / 256)`

### Claim semantics

The candidate commit is created first.

The writer then attempts:

`POST /git/refs`

for the exact deterministic generation claim, pointing to that candidate SHA.

This is the election:

- if creation succeeds, that process has proven it created the previously absent generation claim;
- if the ref already exists, even at the exact same candidate SHA, the writer **does not** treat that as success;
- if the create request times out or otherwise returns an error, a later reread of the claim **does not** convert the ambiguous request into success;
- if the response payload or exact reread does not match the candidate, the election fails.

A claim is not durable state authority. It is only proof available to the process that received an unambiguous successful create response.

The implementation never updates or deletes claim refs.

A malicious or accidental `contents: write` actor may precreate a claim and cause denial of service, but cannot thereby create canonical Cloud State authority because the governed writer will lose the election and will not post a canonical status.

If a process successfully creates a claim and crashes before canonical authority is posted, later automatic recovery does not infer authority from the surviving claim. The generation remains blocked for operator reconciliation.

## Durable status root

Epoch metadata is attached as GitHub commit statuses to the verified parentless repository root:

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

Before any Cloud State status is trusted, that exact commit must exist and have zero parents.

The API surface used by the worker creates and lists commit statuses; it does not mutate or delete existing status records. Conflicting status evidence therefore fails closed.

## Epochs

Epoch size is exactly 256 generations.

An epoch may start in the middle of its numerical range during legacy migration. For example, v1 generation 280 migrates to v2 generation 281, which belongs to epoch 1.

Each epoch has:

- one registration status on the root;
- zero or one seal status on the root;
- canonical generation authority statuses on the immutable epoch anchor commit.

### Registration

Context:

`agent-cloud-state-v2/<laneDigest>/e/<epoch>`

Description:

`a=<anchorSha>;b=<baseGeneration>;s=<startGeneration>`

Invariants:

- `startGeneration = baseGeneration + 1`;
- start generation belongs to the context epoch;
- first registration anchor is bootstrap base SHA or exact v1 migration head;
- each later registration anchors exactly to the previous epoch seal;
- later epochs are consecutive.

Registration is structural metadata only. It never authorizes a candidate.

An orphan registration before generation claim is harmless and may be reused.

### Canonical authority

Canonical statuses are attached to the epoch anchor.

Context:

`agent-cloud-state-v2/<laneDigest>/a/<epoch>/g/<generation>`

Description:

`s=<stateSha>;p=<parentSha>`

A canonical record is accepted only when:

- status state is `success`;
- target URL is absent;
- generation belongs to the registered epoch;
- first generation parents the exact epoch anchor;
- later generations parent the previous canonical state;
- duplicate records agree exactly;
- no generation gap exists.

The governed writer posts a new canonical authority only after winning the deterministic generation-claim creation.

Before posting, it rereads the epoch authorities and requires that they are exactly the same authority sequence observed before the claim. This closes stale-writer races between election and canonical append.

### Seal

When an epoch reaches its numerical end generation, it is fully validated and then sealed before the next epoch registration is created.

Context:

`agent-cloud-state-v2/<laneDigest>/s/<epoch>`

Description:

`s=<stateSha>;g=<generation>`

The seal generation must equal the epoch end: 256, 512, 768, and so on.

A seal is a durable checkpoint for a previously fully validated epoch.

## Publication order

### Bootstrap / migration / normal generation

1. Read refs and complete current epoch evidence.
2. Validate the current authoritative state or exact bootstrap/migration boundary.
3. Create/reuse required epoch registration.
4. Create the candidate Git state commit as the exact one-parent child.
5. Atomically create the deterministic generation claim.
6. Reread epoch authority and prove it has not changed since before the claim.
7. Append canonical authority for the claimed candidate.
8. Validate the complete active epoch lineage.
9. Advance state, checkpoint, and witness refs independently, non-force.
10. Verify final refs and canonical authority.

The authority-bearing transition is therefore:

`create-only generation claim -> append-only canonical status`

Mutable stateRef movement happens only **after** durable authority exists.

## Crash matrix

### Before claim

No new authority exists. Retry may create a new candidate and attempt the same claim.

### Claim create request is ambiguous

Even if a later GET sees the desired claim ref, the operation is not accepted as won.

No authority is posted.

The claim may remain and block automatic retry; operator reconciliation is required.

### Claim created, crash before canonical status

The claim alone is never trusted by another process.

No authority is synthesized.

The prior canonical state remains readable. A later write for the blocked generation cannot silently replace the claim.

### Canonical status created, crash before stateRef

Durable authority already exists.

A fresh process detects mutable refs behind canonical authority.

Ordinary read reports rollback/partial publication; governed `repair:true` may move state/checkpoint/witness forward, non-force, to the already-proven canonical SHA.

### Checkpoint or witness update fails

Authority and state remain canonical. Missing/behind operational refs may be repaired forward.

## Why stateRef-ahead never creates authority

If an external contents-writer puts stateRef on a descendant that has no canonical status:

- ordinary read fails with unproven state advance;
- `repair:true` also fails;
- no status is synthesized from the mutable ref.

This remains true even when the descendant is otherwise a perfectly valid envelope.

## Bootstrap

For a brand-new lane:

- lineage base is the exact configured base-branch SHA;
- lineage base generation is 0;
- first v2 generation is 1.

Registration may be created before the generation claim.

If main advances after an orphan bootstrap registration, the registered anchor remains usable only if it is still an ancestor of current main.

## Legacy v1 migration

v1 had no independent monotonic authority.

Migration therefore has one unavoidable trust boundary: the exact v1 state-tag head used to construct the first v2 candidate.

The first v2 registration records:

- anchor SHA = exact v1 migration head;
- base generation = exact v1 envelope generation;
- start generation = legacy generation + 1.

Legacy generation is never inferred from Git distance.

## Epoch rollover

Before publishing the first generation in the next epoch:

1. require current authority at the exact end of the old epoch;
2. validate the complete old active epoch;
3. append/verify the old epoch seal;
4. append/verify the next epoch registration anchored to that sealed state;
5. create the new candidate;
6. claim its generation atomically;
7. append canonical authority;
8. advance operational refs.

A crash after seal/registration but before generation claim is harmless structural progress.

## Active-epoch lineage validation

Only the active epoch requires full per-generation replay.

GitHub GraphQL `Commit.history` is read in pages of 100, with at most four pages.

Every active state must satisfy:

- exact SHA continuity;
- exactly one parent;
- no merge commit;
- exact consecutive generation;
- repository binding;
- lane binding;
- state-path and ref binding;
- unchanged lineage base;
- valid state hash;
- project ownership;
- secret rejection;
- exact canonical authority record.

The first active state must parent the epoch registration anchor exactly.

Missing nodes, repeated cursors, truncated blobs, malformed envelopes, hidden merges, gaps, or page-limit exhaustion fail closed.

## Historical sealed epochs

A seal is written only after the then-active epoch has passed full lineage validation.

A fresh process therefore uses sealed epochs as immutable historical checkpoints instead of replaying all lifetime state generations.

The root registration/seal chain must remain contiguous and internally consistent.

## Request bounds

- root status evidence: max 20 pages of 100;
- active epoch authority: max 4 pages of 100;
- active GraphQL history: max 4 pages of 100.

The 2,050-generation regression requires:

- fresh aligned read under 30 fake network requests;
- normal next-generation write under 60 fake network requests.

Exceeding a configured pagination bound fails closed; evidence is never silently truncated.

The shared root index is intentionally included in independent adversarial review because it grows with epoch count across lanes. It is not treated as solved merely because the 2,050-generation test passes.

## Concurrency

Two stale writers may build sibling candidate commits.

Both target the same deterministic generation-claim ref.

Only an unambiguously successful create is accepted as election victory.

A pre-existing claim, including one already pointing to that writer's exact candidate, is a loss—not idempotent success.

The loser never posts canonical authority.

If an external actor deletes or rewrites claim refs, durable canonical statuses remain the authority. Claim refs are never used by fresh-process reads to reconstruct authority.

## Read / repair rules

With canonical authority:

- aligned operational refs are accepted;
- missing/behind state ref is rollback/partial publication;
- governed repair may move it only forward to canonical authority;
- state ref ahead of authority is unproven and always rejected;
- divergent state is a fork;
- checkpoint/witness missing or behind may be repaired forward;
- checkpoint/witness ahead or divergent fail closed.

Joint rollback of all three movable refs cannot erase canonical status authority.

## Exact-SHA reads

State content is always read by an exact 40-hex commit SHA, never a mutable ref.

## Security boundaries

r6 preserves:

- explicit project ownership;
- lane isolation;
- exact path/ref binding;
- state-size limits;
- sensitive-key rejection;
- known secret-material rejection;
- non-force operational ref repair;
- no model-authority expansion;
- no automatic merge authority;
- no production-deployment authority;
- no broader external communication authority.

## Required adversarial regressions

At minimum:

- parentless root verification;
- bootstrap and v1 migration;
- inherited legacy generation offsets;
- claim namespace collision rejection;
- same-target claim precreation by contents-writer;
- claim request response lost after server-side create;
- crash claim -> canonical authority;
- canonical authority -> stateRef failure and forward recovery;
- stateRef-ahead direct child never promoted;
- checkpoint/witness partial publication;
- joint rollback of all mutable refs;
- same-generation sibling substitution;
- concurrent stale writers;
- conflicting canonical/root status evidence;
- epoch rollover;
- orphan next-epoch registration;
- hidden active-epoch merge;
- malformed/truncated active envelope;
- lineage-anchor rewrite;
- lane isolation;
- exact-SHA reads;
- pagination fail-closed;
- 2,050-generation read and write request budgets;
- lease semantics;
- remote integrity mismatch.

## Acceptance gate

The candidate is not mergeable until:

1. it is based on current authoritative `main`;
2. changed files are exactly:
   - `src/cloud-state.js`
   - `test/cloud-state.test.js`
   - `docs/CLOUD_STATE_V2_PROTOCOL.md`;
3. the exact candidate SHA passes full CI:
   - tests;
   - real Chrome/CDP;
   - adversarial Chrome;
   - typecheck;
   - lint;
   - build;
   - prepared runtime image;
   - real Docker boundary;
4. a fresh frozen exact-SHA independent adversarial review returns zero unresolved P1/P2.

Issue #182 grants no automatic merge or production deployment authority.
