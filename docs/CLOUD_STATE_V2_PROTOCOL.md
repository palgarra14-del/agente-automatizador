# Cloud State v2 protocol — r6 isolated epoch metadata + authority anchors

## Purpose

Cloud State v2 provides durable, monotonic, per-lane cloud state without trusting process-local memory or movable Git refs as durable state authority.

The protocol is fail-closed. It rejects rollback, forks, malformed lineage, cross-lane substitution, unproven publication, ambiguous create outcomes, secret-bearing state and incomplete evidence.

The current r6 design uses:

- immutable Git state commits;
- deterministic create-only generation claims for single-writer election;
- append-only GitHub commit statuses for canonical authority;
- one **metadata anchor commit** and one **authority anchor commit** per epoch;
- create-only lane discovery refs;
- immutable status links between epoch metadata anchors;
- state/checkpoint/witness refs only as repairable operational pointers.

The split is deliberate: historical epoch traversal reads only tiny metadata anchors, while the up-to-256 canonical generation statuses live on a separate authority anchor that is scanned only for the active epoch.

## Rejected assumptions from earlier candidates

Earlier designs exposed these invalid assumptions:

1. state/checkpoint/witness refs could be rolled back together;
2. one global status ledger required lifetime-sized scans;
3. a pre-ref intent did not prove election;
4. GitHub `force:false` is a fast-forward rule, not an expected-old-SHA CAS;
5. first-epoch authority statuses on shared base commits let other lanes consume the same page budget;
6. registrations and seals on one repository-global root created a cross-lane 2,000-status terminal cap;
7. placing metadata and all authorities on the same per-epoch commit still caused historical reads to reread 256 statuses per sealed epoch.

r6 removes all seven dependencies.

## Immutable template commit

The known parentless repository commit

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

is verified as parentless and used only as an immutable tree/template when creating the first lane epoch metadata anchor.

Cloud State never reads authority metadata from that commit's status list. Thousands of unrelated statuses on it do not affect a lane.

## Lane identity

Each store derives a digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- checkpoint tag;
- witness tag.

All lane discovery refs and status contexts include this digest.

Evidence from another lane/digest cannot satisfy the current lane.

## Operational refs

Each lane owns:

- state ref: configured lane tag;
- checkpoint ref: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- witness ref: `agent-cloud-state-v2-witnesses/<stateTag>`.

They are operational pointers only.

They never create canonical authority.

Governed repair may move a missing/behind operational ref only forward, non-force, to already-proven canonical authority.

An operational state ref ahead of canonical authority is unproven and is rejected even under repair.

## Generation claims

Reserved namespace:

`agent-cloud-state-v2-claims`

Generation `G` uses:

`agent-cloud-state-v2-claims/<laneDigest>/<epoch>/<G>`

The candidate state commit is created first.

The writer then attempts an atomic create-only `POST /git/refs` for the deterministic claim.

Rules:

- only an unambiguous successful create response is election victory;
- an existing claim is a loss even if it already points to the same candidate;
- a timeout/lost response is not recovered by rereading the ref;
- claim refs are never updated or deleted by the implementation.

A claim is not durable Cloud State authority. It only grants the current governed process permission to append the next canonical authority status.

## Epochs

Epoch size is 256 generations.

`epoch = floor((generation - 1) / 256)`

Legacy migration may begin partway through a numerical epoch.

Each epoch has two exclusive commits:

1. **metadata anchor**
   - registration status;
   - optional seal;
   - optional immutable link to next metadata anchor.

2. **authority anchor**
   - canonical generation authority statuses only;
   - up to 256 normal protocol statuses.

No other lane naturally uses either commit.

## First metadata anchor discovery

The first metadata anchor is discovered by:

`agent-cloud-state-v2-epoch-roots/<laneDigest>`

The ref itself is not authority.

The target must validate as:

- parentless Git commit;
- exact lane-bound registration status;
- no previous metadata anchor;
- valid state anchor/base generation/start generation;
- registration bound to an exact authority-anchor SHA.

If the discovery ref is moved to an arbitrary commit by a contents writer, that commit lacks the required append-only registration evidence and is rejected.

## Later metadata anchors

Later metadata anchors have deterministic discovery refs:

`agent-cloud-state-v2-epoch-anchors/<laneDigest>/<epoch>`

A later metadata anchor must have exactly one Git parent: the preceding metadata anchor.

Its registration must reference that same preceding metadata anchor.

A sealed previous metadata anchor may also contain the immutable next link:

`agent-cloud-state-v2/<laneDigest>/next`

with description:

`e=<nextEpoch>;a=<nextMetadataAnchorSha>`

If a process crashes after creating/registering the next anchor but before writing the next-link status, a fresh process may probe the deterministic next-epoch discovery ref only after the current epoch is sealed. The discovered target must still validate its exact registration and Git parent chain.

## Registration

Metadata context:

`agent-cloud-state-v2/<laneDigest>/epoch`

Description:

`e=<epoch>;a=<stateAnchorSha>;b=<baseGeneration>;s=<startGeneration>;u=<authorityAnchorSha>;p=<previousMetadataAnchor-or-zero>`

Invariants:

- `startGeneration = baseGeneration + 1`;
- start generation belongs to the epoch;
- first metadata anchor has no previous metadata anchor;
- later metadata anchor Git parent equals registration previous anchor;
- later state anchor equals previous sealed state;
- later base generation equals previous seal generation;
- authority anchor SHA is exact and immutable.

The authority-anchor Git commit must have exactly one parent: this epoch's metadata anchor.

That parent check is performed whenever the active authority log is read.

For a historical sealed epoch, a fresh read trusts the seal checkpoint and does not reread the historical authority anchor.

## Canonical authority

Authority statuses live only on the epoch's authority-anchor commit.

Context:

`agent-cloud-state-v2/<laneDigest>/g/<epoch>/<generation>`

Description:

`s=<stateSha>;p=<parentStateSha>`

The active authority log is valid only if:

- the authority-anchor commit parents the metadata anchor exactly;
- every status has state `success`;
- target URL is absent;
- generation belongs to this epoch;
- generations are consecutive from registration start;
- first parent state SHA equals registration state anchor;
- later parent state SHA equals the previous canonical state;
- duplicate records agree exactly;
- conflicting duplicates or gaps fail closed.

Only the writer that won the deterministic generation claim may append the next canonical status.

Immediately before append it rereads the current active authority sequence and requires it to equal the pre-claim sequence.

## Seal

Seal metadata context:

`agent-cloud-state-v2/<laneDigest>/seal`

Description:

`s=<stateSha>;g=<generation>`

Seal is allowed only at the numerical end of the epoch: 256, 512, 768, etc.

Before sealing, the then-active authority anchor and full active state lineage are validated.

The seal becomes the historical checkpoint. Once an epoch is historical, fresh reads no longer scan its 256 authority statuses.

## Publication order

### Same epoch

1. Read operational refs and epoch metadata chain.
2. Read/validate only the active authority anchor.
3. Validate current active state lineage.
4. Create the one-parent state candidate.
5. Create deterministic generation claim.
6. Reread active authority log and prove it did not change.
7. Append canonical authority on the active authority anchor.
8. Validate active state lineage.
9. Move state/checkpoint/witness refs forward, non-force.
10. Verify canonical authority and operational pointers.

### Epoch rollover

1. Require current authority at the exact epoch-end generation.
2. Validate active authority log and state lineage.
3. Append/verify seal on current metadata anchor.
4. Create next metadata anchor as child of current metadata anchor.
5. Create next authority anchor as child of the new metadata anchor.
6. Claim deterministic next metadata-anchor discovery ref.
7. Append registration binding state anchor + new authority anchor + previous metadata anchor.
8. Append immutable next link to previous metadata anchor.
9. Continue with generation claim -> canonical authority -> operational refs.

## Crash boundaries

### Before generation claim

No new state authority exists.

### Ambiguous generation-claim creation

No canonical status is posted.

Rereading the claim never upgrades the ambiguous request.

### Claim succeeds, crash before canonical status

Previous canonical state remains authoritative.

The surviving claim is not automatically promoted.

Operator reconciliation is required for that blocked generation.

### Canonical status succeeds, operational refs fail

Durable authority already exists.

Governed repair may advance missing/behind state/checkpoint/witness refs to that exact canonical state.

### First metadata-anchor ref succeeds, registration fails

The discovery ref alone is not enough.

Fresh read fails closed because no valid lane registration exists.

### Later metadata/authority anchors exist, next link fails

If the previous epoch is sealed, deterministic next-anchor discovery may be used, but only after verifying exact Git parent and append-only registration binding.

## Active state-lineage validation

Only the active epoch state chain is replayed fully.

GraphQL history is bounded to four pages of 100 commits.

Every active state must satisfy:

- exact SHA continuity;
- exactly one Git parent;
- no merge;
- exact generation continuity;
- repository binding;
- lane binding;
- state path;
- state/checkpoint/witness tag binding;
- inherited lineage-base consistency;
- valid state hash;
- project ownership;
- secret rejection;
- matching canonical authority record.

The first active state must parent the registration state anchor.

## Historical verification

For sealed epochs, fresh processes verify only the metadata-anchor chain and seal chain.

Metadata anchors contain only a few protocol statuses, so each historical epoch normally costs one bounded status request instead of three pages of generation authorities.

The old authority anchor is not reread after seal because seal publication was permitted only after that epoch passed full authority + state-lineage validation.

## Bootstrap

New lane:

- state lineage base = exact configured base-branch SHA;
- base generation = 0;
- first generation = 1;
- first metadata anchor is parentless;
- first authority anchor parents first metadata anchor;
- first epoch-root discovery ref is create-only;
- registration binds both anchors and the exact bootstrap state anchor.

If main advances after a valid orphan registration, the registered bootstrap state anchor remains valid only while it remains in current main ancestry.

## Legacy v1 migration

v1 has no independent monotonic authority.

The exact legacy state-tag head observed for migration is the one-time trust boundary.

First v2 registration binds:

- state anchor = exact v1 head;
- base generation = exact v1 generation;
- start generation = legacy generation + 1;
- lane-specific metadata/authority anchors.

Legacy generation is never inferred from Git distance.

## Rollback and repair

With canonical authority:

- aligned refs accepted;
- missing/behind state ref = rollback/partial publication;
- repair may move it forward only to canonical authority;
- state ref ahead = unproven, always reject;
- divergent state ref = fork;
- missing/behind checkpoint/witness may repair forward;
- ahead/divergent checkpoint/witness fail closed.

Joint rollback of all movable refs cannot erase append-only canonical statuses on authority anchors.

## Cross-lane isolation

Different lanes have different digests and physically distinct metadata and authority anchor commits.

Natural traffic from another lane cannot consume this lane's pagination.

The adversarial suite injects more than 2,000 unrelated statuses on the old repository root and requires the target lane still to:

- bootstrap;
- read;
- write;
- seal an epoch;
- cross into the next epoch.

Malformed same-lane evidence on a lane anchor still fails closed.

## Request bounds

Metadata anchor:

- max 2 status pages; normal protocol uses at most registration + seal + next.

Active authority anchor:

- max 8 status pages; normal protocol uses at most 256 authority records.

Active state lineage:

- max 4 GraphQL pages.

There is no repository-global status-ledger scan.

At 2,050 generations, historical traversal reads small metadata anchors while only the latest authority anchor is scanned.

The regression enforces bounded fresh-read and next-write request budgets.

## Exact-SHA reads

State content is always read by exact 40-hex commit SHA, never by mutable branch/tag name.

## Security boundaries

r6 preserves:

- explicit project ownership;
- lane isolation;
- state/path/ref binding;
- state-size bounds;
- sensitive-key rejection;
- known secret-material rejection;
- non-force operational ref repair;
- no automatic merge authority;
- no production deployment authority;
- no wider external communication authority.

## Required adversarial regressions

At minimum:

- immutable template-root validation;
- first metadata-anchor authentication;
- separate authority-anchor parent binding;
- later metadata-anchor Git-parent chain;
- bootstrap and v1 migration;
- inherited generation offsets;
- precreated/ambiguous generation claims;
- claim -> canonical crash;
- canonical -> operational-ref crash and repair;
- stateRef-ahead rejection;
- joint rollback;
- sibling/fork;
- stale concurrent writers;
- conflicting registration/authority/seal/next records;
- epoch rollover;
- orphan next-anchor structural progress;
- hidden active-state merge;
- malformed/truncated state envelope;
- lineage-base rewrite;
- exact-SHA reads;
- cross-lane isolation;
- local authority-anchor page bound;
- historical metadata does not rescan sealed authorities;
- >2,000 unrelated repository-root statuses;
- 2,050-generation read/write budgets;
- lease behavior;
- remote envelope integrity.

## Acceptance gate

Not mergeable until:

1. based on current authoritative `main`;
2. changed files remain exactly:
   - `src/cloud-state.js`
   - `test/cloud-state.test.js`
   - `docs/CLOUD_STATE_V2_PROTOCOL.md`;
3. exact candidate SHA passes full CI:
   - unit/adversarial tests;
   - real Chrome/CDP;
   - adversarial Chrome;
   - typecheck;
   - lint;
   - build;
   - prepared runtime image;
   - real Docker boundary;
4. a new frozen exact-SHA independent adversarial review returns zero unresolved P1/P2.

Issue #182 grants no automatic merge or production deployment authority.
