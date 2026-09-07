# Currentness plane and editor admission investigation

**Date:** 2026-09-07
**Status:** implemented; see the
[implementation and deployed validation report](currentness-plane-implementation-report.md).
**Decision:** retain independent live body sockets and use the additive
protocol-2 currentness plane plus conditional batched reconciliation.

## Executive conclusion

The multiplexing benchmark exposed a larger opportunity than multiplexing.
YAOS does not primarily need fewer physical body sockets. It needs a cheap,
truthful way to answer three different questions without repeatedly using
single-body HTTP requests:

1. Is this existing body session still the session the editor may join?
2. Through which durable body generation has this exact Y.Doc observed state?
3. Which bodies need disk materialization after a period of live or offline
   activity?

Today those questions collapse into `currentHead`, full body reads, and a full
Bootstrap feed pass. This is safe in intent but expensive and occasionally
over-broad. The same remote body commit can already be present in an open
Y.Doc, then cause a head read, a complete body read, a changes read, and a root
read. Editor reacquisition of an already-synced body still waits for a separate
head read before a second view may bind.

The right Relay lesson is its compact subdocument-index query, not a shared
live Yjs transport. YAOS should build a small **currentness plane** over the
existing root and body control channels, make body commit watermarks exact,
and batch cold reconciliation through the route it already has. The body data
plane should remain independently socketed.

This work is worth doing. It has a smaller protocol and failure surface than
multiplexing, attacks the measured delay directly, reduces redundant reads and
reconstruction, and strengthens rather than weakens the meaning of durable
generation evidence.

## Measured opportunity

The deployed Cloudflare runs in
`qa-runs/multiplexing/deployed-run-{1,2,3}.json` provide the current bounds:

| Operation | Deployed evidence |
| --- | ---: |
| authenticated current-head read, p50 | 194.38 ms |
| 4 KiB current-body read, p50 | 193.14 ms |
| body WebSocket open, p50 | 217–223 ms |
| body provider sync, p50 | 269–277 ms |
| READY-to-PONG on the same socket, inferred p50 | 51–56 ms |
| seven parallel body syncs, wall p50 | 306–316 ms |

The READY-to-PONG value is a conservative proxy for a new control-channel
round trip. The benchmark sent PING when READY arrived. PONG arrived roughly
51–56 ms after READY across the three runs, while provider sync completed part
way through that interval. A probe sent after sync should be measured directly
before a product SLO is assigned; the existing result is enough to establish
that reusing an admitted socket can be materially cheaper than authenticated
HTTP at the measured edge.

### Present admission paths

`acquireEditorBody()` calls `loadCurrentBodyUnadmitted()` before it decides
whether an existing body session can be reused. That function always loads the
body and calls `catchUpBody()`, whose first operation is `currentHead()`.
Consequently:

| Editor acquisition | Present network gate | Approximate p50 floor |
| --- | --- | ---: |
| same consumer already admitted | none | immediate |
| second consumer, active synced session | one HEAD | 194 ms |
| released editor, warm synced open session | one HEAD | 194 ms |
| current local body, no body socket | HEAD + provider sync | 469 ms |
| stale local body, no body socket | HEAD + body GET + provider sync | 662 ms |

These are stage sums, not measured end-to-end editor latency. They exclude
residency queueing, IndexedDB load, local hashing, CM6 binding, event-loop
contention, and cancellation. That missing distribution is why instrumentation
is Phase 0 rather than a post-optimization task.

Hashing is not the expensive part on the measured desktop runtime: SHA-256 was
about 0.01 ms for 4 KiB, 0.4 ms for 1 MiB, and 4.11 ms for 10 MiB. Network
round trips dominate clean-body validation at this edge.

### Present commit amplification

The body provider receives and applies remote Yjs updates before durable
settlement notifications. The server sends `BODY_COMMITTED` to the root socket
and the exact body socket, but the client only consumes it on the root socket.
The root handler queues `runBodyWakeWork()`, waits for the work scheduler to
become idle, then invokes `onDurableBodyCommitted`; `main.ts` responds by
scheduling a full Bootstrap run.

For a loaded open body whose Y.Doc already contains the remote update:

1. `runBodyWakeWork()` sees an old numeric generation.
2. `catchUpBody()` performs `currentHead()`.
3. Because the head generation is newer, it performs `currentBody()` even if
   the live Y.Doc already has exactly the head content.
4. The Bootstrap callback reads `/changes`.
5. It reads the root through the returned sequence.
6. The direct wake normally advanced the local generation, so the later
   body-feed step then returns without another body read.

That is four HTTP requests after a state update already arrived over the body
socket. The measured direct-wake portion alone has a roughly 387 ms p50 stage
sum. `/changes` and root-through latency were not separately measured, so this
report does not invent an end-to-end number for the complete sequence.

For a body that reaches `materializeEntryFenced()`, request multiplication can
be larger. `settleFeedBody()` reads the head and then
`materializeEntryFenced()` reads it again. A changed body may then use a body
read, a pre-apply head, a post-apply head, and a further head while recording a
common-base settlement. The pre/post effect fences are deliberate. The outer
duplicate is not.

## Correctness findings

### 1. Active-session reuse is the safest and highest-confidence fast path

If a session already has an editor consumer, another editor joining the same
session does not create a new document-currentness boundary. The first editor
is already editing that exact Y.Doc and provider. A split view should acquire
its own projection lease and pin immediately, without HEAD, body fetch, or
provider admission.

This remains fail-closed on identity: the catalog must still map the requested
path to the session body, the session must still point at the loaded Y.Doc, and
projection acquisition must accept that exact path/body pair.

### 2. A warm session needs a barrier, not a time-to-live

An open, synced session with no consumers is a strong reusable resource, but
“recently healthy” is not exact currentness. A timestamp or a quiet interval
cannot prove that a commit was not concurrent with reacquisition.

The correct proof is a request/response barrier on that exact body socket. The
response must name:

- the exact document;
- vault generation;
- runtime epoch;
- current durable body generation;
- active lifecycle;
- ideally the current content hash and canonical size.

All body messages the server sent on that socket before the response are
delivered before the response. A body that passes the barrier can bind without
the independent HTTP head request. An absent capability, authority mismatch,
timeout, disconnect, or changed local body revision falls back to the current
HTTP path.

The barrier does not promise that no future update can race the bind. Neither
does HEAD. It establishes the same point-in-time boundary more cheaply while
retaining the live provider which will deliver subsequent updates.

### 3. New providers must retain currentness validation

Skipping validation for every loaded body would be unsafe. A clean local Y.Doc
may be an old reconstruction from a different server history. Yjs initial sync
is bidirectional; connecting the old document can transmit history that the
current server document does not contain. The existing generation/hash/body
replacement path prevents that before a new provider is admitted.

Therefore:

- reuse an already-consumed exact session immediately;
- barrier-check an already-synced exact session;
- validate a body before creating a new provider;
- never use an age-based cache entry as permission to open a provider.

The existing `catchUpBody()` is already fail-open when a stored body has a
generation or is dirty and the head request fails. The proposed fast path must
not silently broaden that existing availability policy.

### 4. Body sockets already carry the best commit evidence, but it is ignored

The server broadcasts each accepted live update before the later durable
`BODY_COMMITTED` control frame. For the originating socket, the update already
exists locally. For a peer body socket, the update frame precedes the commit
frame on that same ordered transport. Thus a correctly fenced body-socket
notification is evidence that the Y.Doc has observed the update belonging to
that durable commit.

The current body-session custom-message handler only calls
`handleVaultControl()`, which does not parse `BODY_COMMITTED`. The root handler
does parse it, but does not reject a notification whose vault generation or
runtime epoch does not match the socket authority established by READY.

Before consuming watermarks, the client must:

- validate body ID against the body socket attachment;
- validate vault generation;
- validate runtime epoch against that exact socket's READY epoch;
- fence notification handling to the same provider/session instance;
- defer promotion until initial provider sync is complete;
- tolerate a newer Y.Doc revision arriving during persistence.

### 5. Durable generation cannot be assigned blindly to a mutable Y.Doc

A Y.Doc can already contain a later, not-yet-durable remote update when the
notification for an earlier durable update arrives. Persisting the whole doc
and labelling it as an exact image of the earlier generation would overstate
the evidence.

YAOS should distinguish:

- **observed durable floor:** this Y.Doc has incorporated at least the update
  committed through generation N;
- **exact durable image:** this captured Y.Doc revision has the content hash
  and size of durable generation N.

Only the second may replace today's exact `generation + contentHash` body
proof. Promotion to an exact durable image requires a notification carrying
the committed hash/size, a captured `BodyRevisionToken`, hash computation, and
a revision recheck. If the document changes during hashing, retain the
watermark as a target and wait for the next proof or use normal catch-up.

### 6. Server flush semantics must become watermark-safe first

`flushDocument()` currently removes all queued live updates, then commits each
entry as a separate generation. Before each commit it calls
`catalogForLoadedBody()`, which hashes the current loaded document. That loaded
document already contains all queued updates, not just the entry being
committed.

With queued updates A and B, the first durable generation may therefore contain
only A while its catalog hash describes A+B. The final generation is coherent,
but an intermediate notification or concurrent head/body read can observe a
generation/hash pair that is not an exact reconstruction of that generation.
The current client integrity check will reject such a head/body pair rather
than silently accept it, but a new watermark fast path must not depend on an
intermediate pair being exact.

The clean fix is to merge the updates captured by one flush with
`Y.mergeUpdates()` and make one durable commit, one exact catalog mutation, and
one notification. Metadata must be derived from durable baseline plus the
merged update, not from a live cache that may receive another update while a
hash await is in progress. Original queue entries remain available for exact
budget restoration if the commit fails.

This is also a direct Relay learning: compact buffered updates before durable
checkpointing. It reduces journal rows, feed entries, generations,
notifications, and downstream reconciliation work without multiplexing live
documents.

### 7. An open provider must own a body lifetime lease

`replaceFromServer()` checks dirty, unsettled, pending, and pin state before
asynchronous capacity and database work, then later swaps and destroys the
prior Y.Doc without rechecking. `pin()` and projection lease acquisition do not
run through the BodyManager admission chain, so an editor can begin using the
prior body after the first check.

There is a second manifestation: an idle body session may keep a provider
attached to a Y.Doc while root-driven catch-up considers the body unpinned and
eligible for replacement. The session then points at the destroyed prior doc
until later admission notices the identity mismatch.

Required hardening:

- a body session holds a coordinator lease for its provider lifetime;
- replacement captures the prior body and coordinator revision;
- immediately before swap, replacement rechecks loaded identity, revision,
  pins, local work, and leases;
- a failed recheck merges into the current document or returns superseded;
- session teardown releases the lifetime lease exactly once.

This is Phase 0 because a faster admission path increases the probability of
colliding with replacement; it is not unrelated cleanup.

## Target architecture

The proposed design has three channels but only two data transports.

### Live data plane

- Root Yjs socket: structural authority and root awareness.
- Independent body Yjs sockets: active editor synchronization and isolated
  failure domains.
- HTTP candidate publication: durable identity, digest, and receipt proof.

This remains the current transport design. No body mux is introduced.

### Currentness control plane

- Exact body-socket currentness barrier for a warm live body.
- Bounded root-socket query for current heads of up to 100 body IDs.
- Exact `BODY_COMMITTED` envelopes carrying durable generation, vault
  sequence, content hash, size, vault generation, and runtime epoch.
- A client invalidation ledger coalescing the maximum required generation per
  body.
- Capability advertisement in `VAULT_READY`; old or incapable servers cause
  immediate HTTP fallback rather than a long query timeout.

The root query is the closest YAOS analogue to Relay's `MSG_QUERY_SUBDOCS`. It
is a compact snapshot-index query over the existing parent connection, not a
live child-document transport.

Suggested protocol shapes, subject to an RFC-level exact-key review:

```text
VAULT_READY {
  ...,
  socketSessionId,
  capabilities: {
    currentnessQuery: 2,
    committedHead: 2
  }
}

BODY_CURRENTNESS_QUERY {
  queryId,
  bodyIds[]                 // exact body socket: self only; root: <= 100
}

BODY_CURRENTNESS_RESULT {
  queryId,
  socketSessionId,
  vaultSequence,
  heads: [{ bodyId, lifecycle, generation, contentHash, size }]
}

BODY_COMMITTED {
  bodyId,
  vaultGeneration,
  runtimeEpoch,
  vaultSequence,
  durableGeneration,
  contentHash,
  size
}
```

This should be an additive, capability-gated protocol-2 extension rather than
a protocol-3 transport cutover. Existing clients already ignore unknown
control-frame fields, and existing servers can omit the capability so new
clients take the present HTTP path. The rollout does not change Yjs framing,
candidate receipts, socket URLs, or the root/body topology.

Do not overload periodic `VAULT_PING/PONG` with the complete query protocol.
Adding an optional durable generation to PONG is compatible and useful for
diagnostics, but currentness has different cancellation, batching, timeout,
and result-shape semantics from liveness. A dedicated query keeps a failed
head lookup from being misreported as a dead transport and lets the root ask
for many bodies in one bounded frame.

The query result is point-in-time durable evidence, like HEAD. It does not need
to flush undurable live updates. A newly opened body provider obtains those
updates through normal Yjs sync. Missing or non-active bodies are represented
explicitly and cannot be collapsed into an empty head.

### Batched reconciliation plane

The server already exposes `/catch-up` for up to 100 bodies, but the product
clients do not use it. The endpoint currently returns complete state for every
requested active body. The client should use it for coalesced invalidations,
then evolve it to accept each local durable generation/hash and omit unchanged
bodies.

The reconciliation pipeline becomes:

1. Root notifications and the ordered feed update `requiredGeneration[body]`
   using max semantics.
2. Exact body-socket watermarks settle already-open bodies without a body GET.
3. Remaining loaded or disk-relevant bodies are grouped into one bounded
   conditional `/catch-up` request.
4. Returned states are verified and applied with body revision and projection
   fences.
5. Structural feed entries still settle root and catalog changes through the
   stronger root path.
6. Body-only feed entries do not force a root-state download.
7. Editor demand may promote one body ahead of the batch without creating a
   second retry owner.

The feed remains the replay authority after disconnect and restart. Socket
notifications are low-latency invalidations and watermarks, not a replacement
for durable replay.

## Admission tiers after implementation

| Tier | Proof | Network behavior | Expected effect |
| --- | --- | --- | --- |
| same consumer | existing projection lease | none | unchanged immediate return |
| shared active session | exact session/doc plus existing active consumer | none | remove ~194 ms HEAD gate |
| warm synced body session | exact body-socket barrier | one control RTT | replace ~194 ms HEAD with ~51–56 ms measured proxy |
| loaded body, no body session | root batched head query, then body socket | one control RTT + provider sync | reduce current ~469 ms stage floor to roughly 320–335 ms |
| stale/cold body | root head query + conditional batch/body fetch + provider sync | bounded control and state reads | save per-body HEAD and amortize state requests |
| no control capability | existing HTTP head/body path | unchanged | safe compatibility fallback |

The 320–335 ms figure is a projection from deployed component measurements,
not an achieved editor latency claim. Phase 5 must measure the shipped result
in real Obsidian.

## Work plan

### Phase 0 — evidence and lifetime hardening

1. Add a redacted editor-admission span with monotonic timestamps for request,
   local load, currentness proof, state fetch, provider admission, provider
   sync, projection acquisition, and CM6 bind.
2. Record only acquisition tier, durations, socket count, queue delay,
   cancellation/failure class, and body size bucket. Do not export paths, body
   IDs, content, provider URLs, tickets, or request identifiers.
3. Give every body session a provider-lifetime coordinator lease.
4. Add final replacement identity/revision/blocker checks after all awaits.
5. Add deterministic collision tests for editor acquisition during
   replacement and root wake against an idle open session.

**Exit:** replacement cannot destroy a newly leased or session-owned doc, and
the baseline note-visible-to-CRDT-bound distribution is measurable.

### Phase 1 — immediate shared-session admission

1. Split `acquireEditorBody()` into existing-session and new-session paths.
2. If another consumer holds the exact current session/doc, acquire the new
   projection lease and pin without a currentness read.
3. Preserve consumer-generation cancellation checks before publication.
4. Do not create, reconnect, or validate a new provider in this slice.

**Exit:** split view and duplicate-leaf opening issue zero network requests,
share one provider, retain independent leases, and cannot resurrect a replaced
path/body mapping.

### Phase 2 — truthful server commit envelopes

1. Merge the live updates captured by one flush into one durable update.
2. Compute the exact resulting metadata from the durable baseline plus that
   merged update.
3. Commit journal update, document head, catalog head, and sequence atomically.
4. Send one exact commit envelope to root and matching body sockets.
5. Include the committed vault sequence and content metadata.
6. Preserve candidate receipt behavior; candidate commits remain independently
   identified and may emit the same exact envelope after their atomic commit.

**Exit:** every emitted generation/hash/size tuple reconstructs exactly, even
under multiple queued updates and a new update arriving during metadata
calculation.

### Phase 3 — consume body-socket watermarks

1. Establish one immutable socket session from READY per provider instance.
2. Parse and validate exact body-socket commit envelopes.
3. Hold notifications received before initial sync as targets.
4. Capture the body revision, hash current canonical content, and promote the
   exact generation only if content metadata and revision still agree.
5. Serialize watermark persistence after the provider update persistence work.
6. Suppress root-driven body fetch when the exact body session has already
   proven the requested generation.

**Exit:** a remote commit to an open body reaches the Y.Doc and persists its
exact generation without HEAD or body GET; disconnect/reorder cases fall back
to replay.

### Phase 4 — socket currentness queries

1. Advertise the capability from READY.
2. Add an exact self query on body sockets and a bounded multi-body query on
   the root socket.
3. Bind each query waiter to one immutable socket-session identity established
   by READY, plus its query ID and exact requested identity set.
4. Use the self query for warm-session reuse.
5. Use the root query to replace per-body HEADs for simultaneous admissions.
6. Fall back immediately when capability is absent and normally on timeout or
   mismatch.

**Exit:** warm live reacquisition uses one control round trip; concurrent cold
admissions coalesce their head reads without sharing body data transports.

### Phase 5 — conditional batched catch-up and settlement

1. Wire `/catch-up` into the Obsidian and CLI product clients.
2. Make requests conditional on local generation and content hash so unchanged
   bodies return metadata without full Yjs state.
3. Coalesce invalidations by body and maximum generation in the overdue-work
   kernel.
4. Separate body-only feed settlement from structural root settlement.
5. Remove the outer `currentHead()` duplication around
   `materializeEntryFenced()` while retaining effect-specific pre/post fences.
6. Pass already-proven heads down the settlement stack instead of discarding
   them and fetching them again.
7. Keep editor-demand promotion, bounded concurrency, response-size limits,
   and one retry owner.

**Exit:** N sleeping-body commits use one bounded state request per batch, open
bodies use no redundant state request, and feed replay still reconstructs all
missed work after restart.

### Phase 6 — deployed and product validation

Run deterministic tests first, then the same disposable deployed Cloudflare
method used by the multiplexing evaluation, and finally real desktop/mobile
Obsidian traces. Local Wrangler is not production latency evidence.

Required deployed comparisons:

- HEAD versus body-socket self query RTT;
- HEAD-per-body versus root query at widths 1, 2, 4, 7, 24, and 100;
- present versus conditional `/catch-up` for 1, 7, 24, and 100 bodies;
- one and seven active bodies while a 100-body reconciliation batch runs;
- Worker request/subrequest counts and Durable Object CPU per commit burst;
- journal rows and notification count for 1, 10, and 100 rapid live updates;
- foreground/background resume and runtime-epoch replacement.

Required real-client distributions:

- visible-note to CRDT-bound latency;
- acquisition tier hit rate;
- control-query and HTTP-fallback rate;
- state bytes per settled body;
- cancellation and late-result rate;
- ordinary root/body socket 429s;
- active body propagation while catch-up is busy;
- desktop and mobile foreground/background network wake behavior.

## Failure matrix

At minimum, the implementation must cover:

| Sequence | Required outcome |
| --- | --- |
| second split opens during active edit | immediate shared bind, independent lease |
| last consumer releases, then reacquires | barrier proof or HTTP fallback |
| remote commit before query | result names new durable head |
| remote commit during query | either head is valid; later update/notification converges |
| local doc changes during hash | exact promotion rejected, target retained |
| notification before provider sync | target held until sync, never promoted early |
| body update B arrives before commit notification A | no exact-generation overclaim |
| body deleted during query | inactive result or later lifecycle fence blocks bind |
| membership revoked during query | socket closes; waiter fails without publication |
| runtime epoch changes | old result/notification rejected |
| root notification missed during disconnect | feed replay restores invalidation |
| body notification missed, root received | batch/direct catch-up settles body |
| root notification missed, body received | live body watermark settles; feed cursor catches up later |
| replacement already passed its first check | final check blocks destructive swap |
| editor cancellation before result | late result cannot acquire a lease or bind |
| old server lacks capability | immediate existing HTTP path |
| catch-up response exceeds bound | batch splits or reports retryable bounded failure |
| one malformed batch member | identity failure cannot be attributed to another body |
| server flush fails after queue capture | original pending entries and budgets restored |
| update arrives during server metadata hash | committed metadata excludes it exactly |

## Triage

| Priority | Item | Value | Risk |
| --- | --- | --- | --- |
| P0 | provider-lifetime lease and final replacement recheck | correctness prerequisite | low/medium |
| P0 | editor admission instrumentation | establishes actual workload and result | low |
| P1 | shared active-session fast path | removes measured HEAD from split views | low |
| P1 | merge-per-flush and exact commit envelopes | truthful watermarks plus less amplification | medium |
| P1 | body-socket watermark consumption | removes redundant HEAD/body reads for live bodies | medium |
| P2 | capability-gated socket head queries | attacks warm/cold admission HEAD latency | medium |
| P2 | conditional `/catch-up` and invalidation batching | Relay-style large-vault efficiency | medium/high |
| P3 | body-only versus structural feed specialization | removes root work from body-only commits | medium/high |
| Reject now | live multiplexed body transport | does not address currentness and adds failure coupling | high |
| Defer | liveness cadence changes | needs mobile/host field evidence | medium |

## Success criteria

The program is successful when all of the following are true:

1. A second editor on an active body binds without network work.
2. A warm live body normally replaces the 194 ms HEAD with a bounded control
   round trip and safely falls back.
3. An open body receiving a durable remote commit performs no redundant HEAD
   or full-body read for in-memory currentness.
4. A burst of N closed-body commits creates O(1) bounded catch-up requests per
   batch, not O(N) head/body pairs.
5. Every accepted exact-generation promotion has matching content metadata and
   a current local revision proof.
6. Every missed socket notification remains recoverable from the ordered feed.
7. Active-editor propagation remains within 10% of the separate-socket
   baseline while maximum catch-up work runs.
8. Deployed p95 visible-to-bound latency improves by at least 150 ms for the
   affected warm/session tiers, or by at least 25%, without increasing data
   loss, stale apply, or unresolved settlement outcomes.

If real acquisition traces show that the affected tiers are rare, Phase 1 and
the correctness portions of Phases 2–3 still stand on their own. The root query
and conditional batch work can then be stopped before permanent protocol
surface exceeds demonstrated value.

## Relationship to the Relay horizon

Completing this program extracts the remaining useful transport lesson from
Relay:

- compact child-head queries on the parent channel;
- bounded independent live document connections;
- buffered update compaction;
- explicit document lifetime ownership;
- demand-prioritized, batched cold materialization;
- honest separation of liveness, durability, and exact content evidence.

It deliberately does not copy Relay's implementation grain or invent a shared
body WebSocket. After this work, any renewed multiplexing proposal must be
justified by new socket, radio, host-cost, or multi-device evidence rather than
by editor admission latency or catch-up request amplification; those problems
will already have the more direct solution.
