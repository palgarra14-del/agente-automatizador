# Cloud State v2 protocol — r6 lane-isolated epoch anchors

## Purpose

Cloud State v2 provides durable, monotonic, per-lane cloud state without trusting process-local memory or mutable Git refs as durable state authority.

The protocol is fail-closed. It rejects rollback, forks, malformed lineage, unproven publication, cross-lane substitution, secret-bearing state, and ambiguous crash recovery.

The current r6 design uses:

- immutable Git state commits;
- deterministic create-only generation claims as the single-writer election primitive;
- append-only GitHub commit statuses as durable canonical authority;
- **one lane-specific immutable status anchor per epoch**;
- a create-only lane epoch-root ref for discovery of the first anchor;
- immutable status links between later epoch anchors;
- state/checkpoint/witness refs only as repairable operational pointers.

This removes both shared-status failure modes found in the earlier r6 draft: first-epoch authorities no longer share a base commit across lanes, and epoch metadata no longer shares one repository-global status root.

## Why previous designs were rejected

Earlier candidates exposed several invalid assumptions:

1. mutable checkpoint/witness/state refs could be rolled back together;
2. a global append-only status ledger required scanning lifetime history;
3. a pre-state-ref intent did not prove election;
4. GitHub `force:false` is only a fast-forward constraint, not an expected-old-SHA compare-and-swap;
5. attaching first-epoch authorities to shared base commits allowed other lanes or ordinary statuses to exhaust that commit's pagination;
6. attaching all registrations and seals to one fixed root commit created a repository-wide lifetime page cap.

r6 removes those shared anchors entirely.

## Immutable template commit

The known parentless repository commit

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

is still verified as parentless and used only as an immutable tree/template when creating the first lane epoch anchor.

**No Cloud State metadata is read from its status list.**

Unrelated statuses on that commit therefore do not participate in lane authority.

## Lane identity

Each store derives a 128-bit digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- checkpoint tag;
- witness tag.

All discovery refs and status contexts are bound to this digest.

Evidence from another digest cannot satisfy this lane.

## Mutable operational refs

Each lane owns:

- state ref: the configured lane tag;
- checkpoint ref: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- witness ref: `agent-cloud-state-v2-witnesses/<stateTag>`.

These are operational pointers only. They do not create authority.

Supported repair can move missing/behind refs only forward, non-force, to already-proven canonical authority.

A ref ahead of canonical authority never causes status synthesis.

## Generation claims

Reserved namespace:

`agent-cloud-state-v2-claims`

For generation `G`:

`agent-cloud-state-v2-claims/<laneDigest>/<epoch>/<G>`

A candidate state commit is created first.

The writer then performs `POST /git/refs` for that deterministic generation claim.

Election rules:

- only an unambiguous successful create response counts as election victory;
- a pre-existing claim is a loss even if it points to the exact same candidate SHA;
- an ambiguous/lost create response is a loss for automatic publication;
- rereading the claim never upgrades an ambiguous request to success;
- claim refs are never mutated or deleted by the implementation.

A claim alone is not durable Cloud State authority. It only permits the current governed process to append canonical authority.

## Epochs

Epoch size is exactly 256 generations.

`epoch = floor((generation - 1) / 256)`

Legacy migration may begin partway through a numerical epoch.

Each epoch has its **own immutable status-anchor commit**. Natural status traffic from another lane cannot accumulate on that commit because another lane creates a different anchor commit.

An epoch anchor contains at most:

- one registration status;
- up to 256 canonical generation statuses;
- zero or one seal;
- zero or one immutable next-anchor link;
- unrelated/malicious statuses, which are still bounded by an explicit local page cap.

The protocol allows eight pages of 100 statuses per epoch anchor. The normal protocol itself uses fewer than 260.

## First epoch anchor discovery

The first anchor is discovered through the create-only ref:

`agent-cloud-state-v2-epoch-roots/<laneDigest>`

The ref itself is not authority.

The target commit must additionally satisfy all of these:

- its Git commit is parentless;
- it has the exact lane-bound registration status;
- the registration declares no previous epoch anchor;
- the state anchor/base generation/start generation are valid;
- all lane statuses on the commit are internally consistent.

A contents-writer that retargets the discovery ref to an arbitrary commit cannot forge the required append-only lane registration status.

If initial anchor creation is ambiguous and no valid registration exists, the lane fails closed.

## Later epoch anchors

Later anchors have deterministic discovery refs:

`agent-cloud-state-v2-epoch-anchors/<laneDigest>/<epoch>`

A later anchor commit must have exactly one Git parent: the previous epoch's status-anchor commit.

Its registration must name that same previous status anchor and must begin exactly one generation after the previous epoch seal.

The previous epoch may also contain an immutable next-link status:

`agent-cloud-state-v2/<laneDigest>/next`

with:

`e=<nextEpoch>;a=<nextStatusAnchorSha>`

Fresh readers normally follow the immutable next link.

If a previous epoch is sealed and its next link was not written because publication crashed after creating/authenticating the next anchor, the deterministic next-epoch discovery ref may be probed. The discovered target is accepted only if its own lane registration status and Git parent chain validate exactly.

## Registration

Each status anchor contains exactly one lane registration context:

`agent-cloud-state-v2/<laneDigest>/epoch`

Description:

`e=<epoch>;a=<stateAnchorSha>;b=<baseGeneration>;s=<startGeneration>;p=<previousStatusAnchorSha-or-zero>`

Invariants:

- `startGeneration = baseGeneration + 1`;
- start generation belongs to the declared epoch;
- first anchor has no previous status anchor;
- later anchor commit parent and registration previous anchor match exactly;
- later state anchor equals previous epoch sealed state;
- later base generation equals previous epoch sealed generation;
- epochs are consecutive.

Registration is structural metadata only and does not authorize a state candidate.

## Canonical authority

Canonical authority statuses live on that lane's epoch anchor.

Context:

`agent-cloud-state-v2/<laneDigest>/g/<epoch>/<generation>`

Description:

`s=<stateSha>;p=<parentStateSha>`

A canonical sequence must be consecutive.

For the first canonical state in an epoch, parent state SHA equals the registration's state anchor.

Later records parent the preceding canonical state.

Conflicting duplicates, gaps, malformed contexts, wrong epochs, or parent mismatches fail closed.

Only a process that won the deterministic generation claim may append the next canonical status.

Immediately before appending, it rereads the epoch authority sequence and requires it to be identical to the pre-claim sequence. This prevents a stale writer from publishing over a winner that advanced authority between election and append.

## Seal

Context:

`agent-cloud-state-v2/<laneDigest>/seal`

Description:

`s=<stateSha>;g=<generation>`

An epoch may be sealed only at its numerical end generation: 256, 512, 768, and so on.

The complete active epoch lineage is validated before seal publication.

The seal is the historical checkpoint used to anchor the next epoch.

## Publication order

### Same epoch

1. Read and validate refs plus the complete epoch-anchor chain.
2. Validate current canonical authority and active-epoch lineage.
3. Create the exact one-parent state candidate.
4. Create the deterministic generation claim.
5. Reread active canonical authority and prove no change since pre-claim.
6. Append canonical status on the active lane epoch anchor.
7. Validate the active epoch lineage.
8. Move state/checkpoint/witness refs forward, non-force.
9. Verify final canonical authority and operational pointers.

### Epoch rollover

Before the first generation of the next epoch:

1. require current canonical authority at the exact numerical end of the current epoch;
2. validate the full current epoch;
3. append/verify the current epoch seal;
4. create a new lane-specific status-anchor commit whose Git parent is the previous epoch anchor;
5. claim its deterministic epoch-anchor discovery ref;
6. append the new anchor registration;
7. append the immutable next-anchor link to the previous anchor;
8. continue with normal generation claim -> canonical status -> operational refs.

The protocol status traffic for the new epoch is isolated on the new commit.

## Crash boundaries

### Before generation claim

No new state authority exists.

### Ambiguous generation-claim creation

No canonical authority is posted.

Rereading the claim does not recover it.

### Claim succeeds, crash before canonical status

The claim is not state authority.

The previous canonical state remains authoritative.

The blocked generation requires operator reconciliation rather than automatic promotion.

### Canonical status succeeds, state/checkpoint/witness update fails

Durable authority already exists.

Fresh governed repair may move missing/behind operational refs forward to that canonical SHA.

### First epoch anchor ref succeeds, registration fails

The discovery ref alone is not enough.

Fresh reads fail closed because the target has no valid lane registration.

### Later anchor created/registered but next link fails

If the prior epoch is sealed, a fresh process may probe the deterministic next-epoch discovery ref.

It accepts the target only after validating the exact Git parent and append-only registration status.

## Active-epoch lineage validation

Only the active epoch's state chain is replayed in full.

GraphQL history pages are bounded to four pages of 100 commits.

Every state must satisfy:

- exact SHA continuity;
- exactly one Git parent;
- no merge commit;
- exact consecutive generation;
- repository binding;
- lane binding;
- state path binding;
- state/checkpoint/witness tag binding;
- inherited lineage-base consistency;
- state hash integrity;
- project ownership;
- secret-material rejection;
- matching canonical authority status.

The first active state must parent the registration's state anchor exactly.

## Historical epochs

Historical epochs are checked through:

- immutable epoch-anchor Git-parent chain;
- exact registration chain;
- exact seals;
- exact next-anchor links when present.

A seal was created only after that epoch passed full active-lineage validation.

Fresh processes therefore do not replay every historical state commit.

## Bootstrap

For a new lane:

- state lineage base is exact configured base-branch SHA;
- base generation is 0;
- first generation is 1;
- first status-anchor commit is parentless;
- first epoch-root discovery ref is create-only;
- registration state anchor is the exact bootstrap base SHA.

If main advances after a valid orphan registration, the registered bootstrap state anchor remains valid only while it remains an ancestor of current main.

## Legacy v1 migration

v1 has no independent monotonic authority.

The exact legacy state-tag head observed for the first v2 transition is the one-time migration trust boundary.

Registration stores:

- state anchor = exact v1 head;
- base generation = exact v1 envelope generation;
- start generation = legacy generation + 1.

Generation is never inferred from Git distance.

## Rollback and repair

With canonical authority:

- aligned operational refs are accepted;
- missing/behind state ref is rollback/partial publication;
- governed repair may move it forward to canonical authority;
- state ref ahead of canonical authority is unproven and rejected even under repair;
- divergent state ref is a history fork;
- missing/behind checkpoint/witness may be repaired forward;
- checkpoint/witness ahead or divergent fail closed.

Joint rollback of state/checkpoint/witness cannot erase epoch-anchor canonical statuses.

## Cross-lane isolation

Different lanes have different digests and different epoch-anchor commits.

Therefore:

- their authority statuses are physically separated;
- their registrations/seals/next-links are physically separated;
- their natural status pagination cannot consume one another's page budget.

The adversarial suite preloads more than 2,000 unrelated statuses on the old repository root and requires this lane still to bootstrap, read, write, and cross an epoch boundary normally.

Cross-lane contexts on a lane's epoch anchor do not satisfy this lane and malformed same-lane contexts fail closed.

## Request bounds

Per epoch status anchor:

- max 8 pages x 100 statuses.

Active state lineage:

- max 4 GraphQL pages x 100 commits.

There is no repository-global root-status scan.

At 2,050 generations the reader follows roughly nine lane epoch anchors, each bounded independently.

The regression requires bounded fresh read and next write budgets and separately proves >2,000 unrelated repository-root statuses do not affect the lane.

## Exact-SHA reads

State content is always read by exact 40-hex commit SHA, never from a mutable branch/tag ref.

## Security boundaries

r6 preserves:

- explicit project ownership;
- lane isolation;
- exact path/ref binding;
- state-size bounds;
- sensitive-key rejection;
- known secret-material rejection;
- non-force operational ref repair;
- no automatic merge authority;
- no production deployment authority;
- no wider external communication authority.

## Required adversarial regressions

At minimum:

- immutable template root validation;
- first lane epoch-root authentication;
- later epoch-anchor parent chain;
- bootstrap and v1 migration;
- inherited legacy generation offsets;
- generation claim precreation and ambiguous-response cases;
- claim -> canonical crash;
- canonical -> operational-ref crash and repair;
- stateRef-ahead direct child rejection;
- checkpoint/witness partial publication;
- joint rollback;
- same-generation sibling;
- stale concurrent writers;
- conflicting registration/authority/seal/next evidence;
- hidden active-epoch merge;
- malformed/truncated active envelope;
- lineage-base rewrite;
- lane isolation;
- exact-SHA reads;
- local epoch-anchor status pagination bound;
- >2,000 unrelated repository-root statuses;
- 2,050-generation read/write request budgets;
- lease behavior;
- remote envelope integrity.

## Acceptance gate

The candidate is not mergeable until:

1. it is based on current authoritative `main`;
2. changed files are exactly:
   - `src/cloud-state.js`
   - `test/cloud-state.test.js`
   - `docs/CLOUD_STATE_V2_PROTOCOL.md`;
3. the exact candidate SHA passes full CI:
   - unit/adversarial tests;
   - real Chrome/CDP;
   - adversarial Chrome;
   - typecheck;
   - lint;
   - build;
   - prepared runtime image;
   - real Docker execution boundary;
4. a new frozen exact-SHA independent adversarial review returns zero unresolved P1/P2.

Issue #182 grants no automatic merge or production deployment authority.
