# Cloud State v2 protocol — r6 deterministic lane root + isolated epoch anchors

## Purpose

Cloud State v2 provides durable, monotonic, per-lane cloud state for fresh cloud workers without trusting process-local memory or movable Git refs as durable authority.

The protocol is deliberately fail-closed. It rejects rollback, forks, ambiguous publication, malformed lineage, cross-lane substitution, hidden merges, state-integrity drift, secret-bearing state, and incomplete authority evidence.

The current r6 design uses:

- immutable Git state commits;
- a **deterministically addressable lane-root commit**;
- an exact-context append-only initialization marker on the permanent repository root;
- a lane-root append-only pointer to the first epoch;
- one lane-specific metadata anchor and one lane-specific authority anchor per epoch;
- deterministic create-only generation claims for single-writer election;
- append-only commit statuses for canonical generation authority;
- state/checkpoint/witness refs only as repairable operational pointers.

A fresh process can therefore recover the lane authority path even if all lane refs are deleted.

## Rejected assumptions from earlier candidates

Earlier candidates exposed several invalid assumptions:

1. state/checkpoint/witness refs can all be rolled back together;
2. a global status ledger grows without bound;
3. a pre-ref intent does not prove writer election;
4. GitHub `force:false` is only a fast-forward rule, not an expected-old-SHA compare-and-swap;
5. first-epoch authorities on a shared base commit let unrelated lanes consume the same status pagination;
6. registrations and seals on one repository-global root create a cross-lane lifetime status cap;
7. combining metadata and all authorities on one epoch commit makes historical traversal reread up to 256 authorities per sealed epoch;
8. discovering the first epoch only through a mutable ref lets ref deletion hide old authority from a fresh process.

r6 removes all eight dependencies.

## Permanent repository root

The known repository root commit is:

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

It must exist and have zero parents.

Its tree SHA is used as the immutable template for the deterministic lane-root commit.

Cloud State does **not** scan this commit's complete status list. The only lane-specific information read from it is an exact status context lookup for that lane's initialization marker.

Therefore thousands of unrelated statuses on this commit do not consume this lane's pagination budget.

## Lane identity

A full SHA-256 digest is calculated from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- checkpoint tag;
- witness tag.

The first 128 bits are used in bounded ref/status names. The full 256-bit digest is embedded in the deterministic lane-root commit message.

This binds durable evidence to the repository, lane, state location and all three operational refs.

## Deterministic lane-root commit

Every lane has a Git commit whose SHA can be calculated without reading any movable lane ref.

The commit uses:

- tree: exact tree from the permanent repository root;
- no parents;
- message: `Cloud State v2 lane root <fullLaneDigest>`;
- fixed author and committer:
  - name: `Cloud State v2`;
  - email: `cloud-state-v2@users.noreply.github.com`;
  - date: `2000-01-01T00:00:00Z`.

The implementation serializes the Git commit object deterministically and calculates its SHA-1 locally before any lane initialization.

When the lane-root object is read, all of the following must match the deterministic specification:

- exact SHA;
- exact tree;
- zero parents;
- exact message;
- exact author;
- exact committer;
- exact date.

If an initialization marker says a lane exists but this exact object is missing or mismatched, the store fails closed. It never silently treats that lane as empty.

## Exact lane initialization marker

The permanent root carries one lane initialization status with exact context:

`agent-cloud-state-v2/<laneDigest>/init`

Description:

`r=<deterministicLaneRootSha>`

The marker is read through an exact status-context lookup rather than by paginating every status on the permanent root.

Required properties:

- context is exactly the lane init context;
- status state is success;
- target URL is absent;
- description contains the exact deterministic lane-root SHA;
- conflicting marker evidence fails closed.

### Initialization states

**No init marker**

The lane is not durably initialized. A read may return an empty lane.

A governed first write may create the deterministic lane-root commit and append the init marker.

An orphan deterministic commit without the init marker does not establish lane authority.

**Init marker exists**

The lane has durably existed.

The exact deterministic lane-root commit must also exist and validate. Missing root object is corruption/authority loss and fails closed.

If the lane root exists but the append-only first-epoch pointer is missing, the lane is **initialized but incomplete** and also fails closed. It is never returned as an empty/new lane, including under governed repair.

This distinction prevents deletion of lane refs or a crash between init-marker and first-pointer publication from making an established lane look new.

## First-epoch pointer

The deterministic lane-root commit carries the append-only first-epoch pointer context:

`agent-cloud-state-v2/<laneDigest>/first`

Description:

`e=<firstEpoch>;a=<firstMetadataAnchorSha>`

A fresh process follows:

`permanent root exact init marker -> deterministic lane root -> first pointer -> epoch metadata chain`

No movable state/checkpoint/witness or epoch discovery ref is required to find existing canonical authority.

Conflicting first pointers fail closed.

## Movable operational refs

Each lane owns:

- state ref: configured lane tag;
- checkpoint ref: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- witness ref: `agent-cloud-state-v2-witnesses/<stateTag>`.

They are operational pointers only.

They never create canonical authority.

Governed repair may move a missing or behind ref only forward, non-force, to already-proven canonical authority.

A state ref ahead of canonical authority is unproven and is rejected even under repair.

Deleting all three refs cannot delete the authority path described above.

## Generation claims

Reserved namespace:

`agent-cloud-state-v2-claims`

Generation `G` uses:

`agent-cloud-state-v2-claims/<laneDigest>/<epoch>/<G>`

The candidate state commit is created first.

The writer then attempts an atomic create-only `POST /git/refs` for the deterministic generation claim.

Election rules:

- only an unambiguous successful create response counts as victory;
- an already-existing claim is a loss even when it points to the same candidate SHA;
- a timeout or lost response is not upgraded to success by rereading the ref;
- claim refs are never updated or deleted by the implementation.

A claim is not durable state authority. It only grants that currently executing governed writer permission to append the next canonical authority status.

A malicious ref writer may precreate a claim and cause denial of service, but cannot thereby create canonical state authority.

## Epochs

Epoch size is exactly 256 generations.

`epoch = floor((generation - 1) / 256)`

Legacy v1 migration may begin partway through a numerical epoch.

Each epoch has two exclusive immutable commits:

1. **metadata anchor**
   - registration;
   - optional seal;
   - optional next-epoch link.

2. **authority anchor**
   - canonical generation authority statuses only;
   - normally at most 256 protocol statuses.

The two commits are lane-specific. Their Git commit messages include the full lane digest and epoch number and those identities are validated when read. The metadata message is `Cloud State v2 metadata <fullLaneDigest> epoch <epoch>`; the authority message is `Cloud State v2 authority <fullLaneDigest> epoch <epoch>`.

This prevents two lanes or two epochs created with the same tree/parents/identity/timestamp from collapsing onto the same physical Git object. Normal traffic from another lane therefore cannot share the status budget accidentally.

## Epoch metadata-anchor discovery refs

Metadata anchors also have deterministic convenience refs:

`agent-cloud-state-v2-epoch-anchors/<laneDigest>/<epoch>`

These refs are structural/discovery aids only.

They are not the root of durable authority.

The first epoch is found from the deterministic lane-root status pointer.

Later epochs are normally found through immutable `next` statuses from the previous metadata anchor.

A deterministic epoch ref may only assist recovery after a sealed epoch; its target must still satisfy the exact Git-parent and append-only registration checks.

Deleting these refs does not erase an established authority chain.

## Metadata registration

Metadata context:

`agent-cloud-state-v2/<laneDigest>/epoch`

Description:

`e=<epoch>;a=<stateAnchorSha>;b=<baseGeneration>;s=<startGeneration>;u=<authorityAnchorSha>;p=<previousMetadataAnchor-or-zero>`

Invariants:

- `startGeneration = baseGeneration + 1`;
- start generation belongs to the declared epoch;
- first metadata anchor has no previous metadata anchor;
- later metadata anchor Git parent equals its recorded previous metadata anchor;
- later state anchor equals the previous epoch's sealed state;
- later base generation equals the previous seal generation;
- authority anchor SHA is exact and immutable.

## Authority-anchor binding

The authority-anchor Git commit must have exactly one parent: its epoch metadata anchor, and its Git message must carry the exact full lane digest plus epoch number.

Both the parent binding and the lane/epoch object identity are validated when the active authority log is read.

The authority statuses therefore cannot be transplanted onto another epoch or lane without breaking either the lane contexts, registration binding or Git-parent relation.

For an already sealed historical epoch, a fresh process does not reread the historical authority log: the seal is the durable checkpoint created only after the epoch passed active validation.

## Canonical generation authority

Authority statuses live only on the active epoch's authority anchor.

Context:

`agent-cloud-state-v2/<laneDigest>/g/<epoch>/<generation>`

Description:

`s=<stateSha>;p=<parentStateSha>;b=<validatedBaseSha>`

The `b` field is an **immutable base witness**: the exact base-branch commit observed and lineage-validated by the winning writer immediately before authority publication. Canonical authority is validated against that exact commit, not against whatever the mutable branch happens to point to later. This removes the impossible cross-API requirement that a branch ref stay unchanged between a read and a subsequent append-only status POST.

The active authority sequence must satisfy:

- status state is success;
- target URL is absent;
- context belongs to the exact lane and epoch;
- generation lies in the epoch;
- generations are consecutive from the registration start;
- first canonical parent equals the registration state anchor;
- every later parent equals the preceding canonical state;
- duplicate evidence agrees exactly;
- conflicting duplicates, gaps or malformed evidence fail closed.

Immediately before appending the next canonical status, the writer rereads the authority log and requires it to equal the sequence observed before it won the generation claim.

This prevents a stale writer from publishing over authority that advanced during its election window.

## Seal

Metadata context:

`agent-cloud-state-v2/<laneDigest>/seal`

Description:

`s=<stateSha>;g=<generation>;b=<validatedBaseSha>`

The seal carries forward the final generation's immutable base witness. Historical verification and later governed repair therefore do not reacquire authority from the current mutable branch.

A seal is allowed only at the numerical end of the epoch: 256, 512, 768, and so on.

Before sealing, the then-active authority log and full active state lineage must validate.

After seal publication, the seal is the durable checkpoint for that historical epoch.

## Next-epoch link

Metadata context:

`agent-cloud-state-v2/<laneDigest>/next`

Description:

`e=<nextEpoch>;a=<nextMetadataAnchorSha>`

A later metadata anchor must have exactly one Git parent equal to the previous metadata anchor.

Its registration must record the same previous metadata anchor.

A next link without a valid previous seal is rejected.

If the process crashes after creating/registering the next anchor but before writing the next link, a normal read/write **does not follow the mutable discovery ref** and new canonical authority is blocked with `cloud_state_epoch_next_missing`.

Only an explicit governed repair may consult that ref. Repair first validates the discovered metadata anchor, lane/epoch Git identity, exact parent, registration, previous seal and generation continuity. The sealed fallback envelope is then validated against the **base witness already bound into the immutable seal**. The mutable discovery ref contributes no authority and the current branch tip contributes no retroactive authority either. Only then may repair append the missing immutable `next` status to the previous metadata anchor and verify that status before the new epoch becomes traversable. No generation claim or authority append is allowed before that repair succeeds.

## State publication — same epoch

1. Read the exact init marker and deterministic lane root.
2. Follow first pointer and metadata chain.
3. Read and validate only the active authority anchor.
4. Validate the complete active state lineage.
5. Create the exact one-parent candidate state commit.
6. Revalidate the lineage anchor against the current base before election.
7. Create the deterministic generation claim.
8. Reread active authority and prove it has not changed.
9. Read the exact current base SHA once, validate the lineage against that SHA, and bind that SHA into the canonical authority status as `b=<validatedBaseSha>`.
10. Append canonical generation status.
11. Validate the new active lineage against the authority's immutable base witness.
12. Move state/checkpoint/witness refs forward, non-force.
13. Verify canonical authority plus operational refs.

Canonical authority exists before operational refs move.

The publication boundary deliberately does **not** claim an impossible atomic transaction with the mutable base ref. Instead, the durable authority records the exact base observation it validated. A later branch movement cannot retroactively poison or bless that authority; fresh readers verify the immutable witness itself.

For sealed-fallback reads and operational-ref repair, mutable-ref classification never substitutes for lineage trust. The sealed lineage is validated against the immutable base witness carried by the seal, so a later change to the branch tip cannot create a TOCTOU repair race.

## Epoch rollover

1. Require current canonical authority at the exact epoch-end generation.
2. Validate the complete active authority log and state lineage.
3. Append or verify the current seal.
4. Create the next metadata anchor as a child of the current metadata anchor.
5. Create the next authority anchor as a child of the new metadata anchor.
6. Create-only claim the next epoch discovery ref.
7. Append the new registration binding state anchor, authority anchor and previous metadata anchor.
8. Append the immutable next link on the previous metadata anchor.
9. Continue with normal generation claim -> canonical authority -> operational refs.

The next epoch gets a fresh, physically isolated status budget.

## Crash boundaries

### Before lane init marker

No durable lane initialization exists.

An orphan deterministic lane-root object alone does not prove prior state.

### Init marker exists, lane-root object unavailable or invalid

Fail closed.

Never rebootstrap as empty.

### Lane root exists, first pointer absent

The lane is initialized but epoch publication is incomplete.

It must not be mistaken for a clean new lane.

### Before generation claim

No new state authority exists.

### Ambiguous generation-claim create

No canonical authority is appended.

Rereading the claim never upgrades the ambiguous request.

### Claim succeeds, crash before canonical status

Previous canonical state remains authoritative.

The surviving claim is not promoted automatically.

Operator reconciliation is required for that blocked generation.

### Canonical status succeeds, operational refs fail

Durable authority already exists.

Governed repair may move missing/behind state/checkpoint/witness refs to that canonical state.

### Epoch-anchor creation/ref/registration/next-link interruption

Structural evidence is accepted only when the deterministic discovery information, exact Git-parent topology and append-only registration/link statuses agree.

Partial structural publication otherwise fails closed.

## Active state-lineage validation

Only the active epoch's state chain is replayed fully.

GraphQL commit history is bounded to four pages of 100 commits.

Every active state must satisfy:

- exact SHA continuity;
- exactly one Git parent;
- no hidden merge;
- exact consecutive generation;
- repository binding;
- lane binding;
- state path binding;
- state/checkpoint/witness tag binding;
- inherited lineage-base consistency;
- state hash integrity;
- project ownership;
- secret-material rejection;
- exact canonical authority match.

The first active state must parent the registration state anchor.

## Historical verification

For sealed historical epochs, fresh workers verify:

- deterministic lane-root initialization;
- first pointer;
- metadata-anchor Git-parent chain;
- registration chain;
- seals;
- next links.

They do not rescan up to 256 historical authority statuses per sealed epoch.

This keeps lifetime verification proportional to epoch count rather than state-generation count.

## Bootstrap

For a brand-new lane:

- lineage base = exact configured base-branch SHA;
- lineage base generation = 0;
- first v2 generation = 1;
- deterministic lane-root commit is created/verified;
- exact init marker permanently records that lane root;
- first metadata anchor is parentless;
- first authority anchor parents the first metadata anchor;
- first pointer on lane root identifies the first metadata anchor;
- registration binds the bootstrap state anchor and authority anchor.

Before the first canonical authority exists, an orphan bootstrap registration is still checked against the current base before it may be extended.

Once canonical authority exists, mutable bootstrap ancestry is no longer reinterpreted from the latest branch tip. Each authority generation records the exact validated base witness that governed its publication, and sealed epochs preserve the final witness. A cached state head may skip replay of immutable historical edges, but authority/base-witness binding is rechecked on every relevant validation and again immediately before both the generation claim and canonical status append. A force-push between load and save therefore cannot leave new durable authority behind.

## Legacy v1 migration

v1 had no independent monotonic authority.

The exact legacy state-tag head observed for first v2 publication is therefore the one-time migration trust boundary.

The first v2 registration binds:

- state anchor = exact v1 head;
- base generation = exact v1 envelope generation;
- start generation = legacy generation + 1;
- lane-specific metadata anchor;
- lane-specific authority anchor.

Legacy generation is never inferred from Git distance.

## Rollback and repair

With canonical authority:

- aligned operational refs are accepted;
- missing/behind state ref is rollback or partial publication;
- governed repair may move it forward only to canonical authority;
- state ref ahead of canonical authority is unproven and always rejected;
- divergent state ref is a history fork;
- missing/behind checkpoint or witness may repair forward;
- ahead/divergent checkpoint or witness fails closed.

Joint deletion or rollback of state/checkpoint/witness, epoch discovery refs and generation claim refs cannot make an initialized lane appear empty because the exact root init marker and deterministic lane-root address survive independently of those refs.

## Cross-lane isolation and saturation

Different lanes derive different digests and therefore different:

- deterministic lane-root objects;
- init contexts;
- first-pointer contexts;
- metadata-anchor commits;
- authority-anchor commits;
- claim namespaces.

The permanent repository root can contain more than 2,000 unrelated statuses without affecting this lane because the init record is fetched by exact context rather than by list pagination.

The adversarial suite explicitly injects more than 2,000 unrelated root statuses and requires bootstrap, read, write and epoch rollover to continue.

## Request bounds

Permanent root:

- exact GraphQL context lookup for lane init;
- no full status pagination.

Lane-root first pointer:

- at most two pages of 100, although normal protocol contains one pointer.

Historical metadata anchor:

- at most two pages of 100;
- normal protocol contains registration, seal and next.

Active authority anchor:

- at most eight pages of 100;
- normal protocol contains at most 256 authority statuses.

Active state lineage:

- at most four GraphQL history pages of 100.

There is no repository-global status-ledger scan.

At 2,050 generations, historical traversal reads small metadata anchors while only the latest authority anchor is scanned.

## Exact-SHA reads

State content is always read using exact 40-hex commit SHAs, never from mutable branch/tag names.

## Security and authority boundaries

r6 preserves:

- explicit project ownership;
- lane isolation;
- exact path/ref binding;
- state-size limits;
- sensitive-key rejection;
- known secret-material rejection;
- non-force operational ref repair;
- no automatic merge authority;
- no production deployment authority;
- no wider external communication authority.

## Required adversarial regressions

At minimum:

- permanent repository-root validation;
- deterministic lane-root SHA/object validation;
- exact lane-init context lookup;
- init marker conflict;
- initialized lane with missing deterministic root fails closed;
- initialized lane with init marker but missing first pointer fails closed instead of looking empty;
- deletion of every movable lane ref cannot erase authority;
- first-pointer conflict;
- metadata/authority anchor parent binding;
- metadata/authority Git object identity binds exact lane digest + epoch and rejects cross-lane transplant;
- bootstrap and legacy migration;
- inherited legacy generation offsets;
- precreated and ambiguous generation claims;
- claim -> canonical crash;
- canonical -> operational-ref crash and repair;
- stateRef-ahead rejection;
- joint rollback and deletion;
- same-generation sibling;
- stale concurrent writers;
- conflicting registration/authority/seal/next evidence;
- epoch rollover;
- crash after next registration but before immutable next link blocks normal publication;
- governed repair validates and restores the missing next link before any new authority;
- partial next-anchor structural publication;
- hidden active-state merge;
- malformed/truncated active state envelope;
- lineage-anchor rewrite;
- base-branch force-push between cached load and save is rejected before generation claim/canonical authority;
- exact-SHA reads;
- cross-lane isolation;
- local pagination fail-closed;
- more than 2,000 unrelated repository-root statuses;
- sealed metadata traversal does not rescan historical authority logs;
- 2,050-generation fresh-read and next-write budgets;
- lease behavior;
- remote envelope integrity.

## Acceptance gate

The candidate is not mergeable until:

1. it is based on current authoritative `main`;
2. changed files remain exactly:
   - `src/cloud-state.js`
   - `test/cloud-state.test.js`
   - `docs/CLOUD_STATE_V2_PROTOCOL.md`;
3. the exact final candidate SHA passes full CI:
   - unit/adversarial tests;
   - real Chrome/CDP;
   - adversarial Chrome;
   - typecheck;
   - lint;
   - build;
   - prepared runtime image;
   - real Docker boundary;
4. a new frozen exact-SHA independent adversarial review returns zero unresolved P1/P2.

Issue #182 grants no automatic merge, deploy or production authority.
