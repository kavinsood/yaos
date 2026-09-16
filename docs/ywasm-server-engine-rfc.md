# RFC: ywasm as the YAOS3 server CRDT engine

Status: Implemented and deployed for YAOS3 qualification

Date: 17 September 2026

Target: `yaos3` greenfield server

Decision: Adopt, behind mandatory correctness and resource gates

## Executive decision

YAOS3 should use `ywasm`, built from the active `y-crdt/y-crdt` repository, as
its production server CRDT engine. Durable Object SQLite, alarms, object
storage, authorization, validation, catalog projection, and socket coordination
remain TypeScript. Wasm owns only CRDT document computation.

This is worthwhile because the expensive large-history operations YAOS performs
are materially faster in the real Cloudflare Workers runtime. The improvement
is small for ordinary notes, so this is not a claim that Wasm makes the whole
service several times faster. It removes a costly tail from reconstruction,
catch-up, checkpointing, and update application while leaving SQL and network
time essentially unchanged. Memory remains an admission-envelope result, not a
blanket Wasm win: page growth stabilizes after warmup, but allocator high-water
RSS is workload- and run-sensitive.

This is not a drop-in dependency replacement. YAOS must own a narrow engine
boundary, a reproducible Rust/Wasm artifact, one missing document-census API,
explicit wrapper disposal, sync framing, memory admission, trap recovery, and a
cross-engine conformance suite. Those are release requirements, not follow-up
cleanup.

Before the engine port, YAOS repaired its existing SQL and semantic compaction
scheduling. Faster replay is not a substitute for preventing an unbounded
replay tail or an unnecessarily old CRDT lineage. Step 1 of this RFC records
the implementation and its acceptance criteria.

## Implementation outcome

The RFC is implemented in the YAOS3 worktree. Production server document
computation now uses the pinned ywasm artifact exclusively; Yjs remains a client
dependency and an independent wire/test oracle. Durable Object SQLite, R2,
authorization, alarms, receipts, catalogs, recovery, and socket coordination
remain TypeScript and byte-oriented.

The pinned artifact is built from `y-crdt/y-crdt` commit
`37dfed7eaeeddc70205577c6d92b50c53023b133` with Rust 1.98.1 and wasm-pack
0.15.0. The Wasm is 983,035 bytes with SHA-256
`3d0dc3fceba1de16ae21d7d345999f75a09ea3743339f1911a1e419db8c703c3`;
its configured maximum is 1,536 pages (96 MiB). Two clean builds produced
identical Wasm and JavaScript wrapper hashes. The source pin, build inputs,
license, census/change-detection patches, generated bindings, and checksums are
vendored together.

Qualification completed on 17 September 2026:

- all 169 regression suites passed;
- Worker and production Node capability conformance passed for every declared
  admission, durability, recovery, attachment, collaboration, and semantic
  Canvas capability;
- the local destructive Worker integration suite and a fresh deployed
  destructive integration suite passed through final generation-scoped purge;
- 100,000 current-release Unicode differential operations passed across CJK,
  emoji/ZWJ, combining text, RTL text, and both Yjs/ywasm directions; the
  preceding census artifact also passed a 200,000-operation qualification;
- 10,000 create/apply/encode/free cycles settled at 3,932,160 bytes with zero
  late Wasm-page growth;
- corrupt input, trap recovery, multi-shard residency, exact census, schema
  helpers, sync framing, and memory pre-admission gates passed;
- the current full headless lifecycle run passed 92/92 after closing an
  admitted-creation replay race, and the full regression suite then passed
  169/169;
- the final deployed Worker bundle was 2,518.64 KiB (605.69 KiB gzip), starts in
  8 ms on the retained deployment, and binds all three Durable Object classes
  plus the production R2 bucket. The exact bundle also passed a fresh
  destructive validation deployment, which started in 8 ms and was deleted
  after its generation-scoped purge completed. A preceding clean deployment
  passed every sync/recovery/settings check but its alarm-driven R2 purge did
  not reach terminal state within the suite's bounded 60-second window; the
  fresh rerun completed the same purge normally, so this remains a measured
  platform-scheduling tail rather than a hidden success claim.

The retained qualification deployment is version
`2ec4bef7-ad14-461a-a5a5-ab0e6c10fe82` at
`yaos3-ywasm-final-20260917.kavinsood.workers.dev`. Cloudflare Access is
exact-host and permits only `kavin@cloudflare.com`. The temporary service token
used by automated QA and every disposable profiling deployment were deleted.

The final hot-path hardening preserves the authoritative/validation document
pair while removing avoidable work around it. Frontmatter validation filters
`snapshotRoots()` before materialization, so it never copies the Markdown body.
Canvas validation returns its canonical bytes to every caller instead of
materializing twice. A pinned Rust/Wasm `applyUpdateAndCheckIfChanged` export
uses the exact Yrs update-event predicate, including delete-only transactions,
instead of encoding two state vectors. Socket validation owns its speculative
mirror through a `finally` cleanup, and unrelated notes now use independent
persistence lanes. Durable socket flushes advance only the authoritative mirror
because the validation mirror already contains the staged frames.

Whole-note hashing now runs at the 250 ms durable flush rather than on every
accepted socket frame. A flush reconstructs each size-bounded partition against
its exact durable prefix, so split queues still produce the correct intermediate
catalog hashes without retaining a whole canonical byte array per frame. One
Markdown materialization remains at admission because canonical-form and exact
size limits are per-frame security invariants; filtering `snapshotRoots()`
removes the accidental second body materialization.

Bootstrap verification uses an engine-independent `canonical-root-v1` digest
rather than comparing Yjs and ywasm checkpoint bytes, because two valid wire
encodings can represent the same root state. The digest sorts roots, CRDT map
entries, and plain-object keys by deterministic UTF-16 code-unit order (never
locale/ICU order). Focused tests cover multiple roots, reversed insertion
orders, Unicode keys, nested maps, and semantic mutation across both engines.

Final headless qualification also found an adjacent lifecycle crash/race: once
the server admitted a creation it owned an exact operation/candidate fence, but
a newer local watcher revision could make the client abandon that operation.
The newer revision then reused the body behind a second operation ID and was
permanently rejected with a fence mismatch. YAOS now treats admission as the
irreversible distributed commitment point, persists the candidate ID and
digest before single or batch admission, and after restart either proves the
exact committed candidate outcome or reconstructs only that same fence. A
deterministic crash/supersession regression and two consecutive 92/92 headless
runs cover this boundary.

The exact pinned artifact's current local lifecycle medians were 75.57 to 27.55
ms for cold reconstruction, 1.45 to 0.52 ms for resident-tail apply, 0.094 to
0.048 ms for catch-up, and 0.623 to 0.182 ms for checkpoint encoding (Yjs to
ywasm). Semantic rebuild was slower, 0.187 to 0.539 ms, but remained
sub-millisecond. In the 10,000-cycle, eight-shard Node soak, ywasm's
post-warmup RSS growth (7.37 MiB) and resident-pair high-water allocation (17.9
MiB) exceeded Yjs in that run (0.84 MiB and effectively zero). That result
reinforces the 96 MiB admission envelope and explicit disposal requirement; it
does not support marketing ywasm as universally lower-memory.
The earlier real-Workers large-history measurements below remain the isolated
deployed CRDT-compute evidence. A public-network 100-shard operational profile
also exposed an intermittent application-level `503 {"error":"unclaimed"}`.
The cause was a real cross-isolate cache race: pre-claim capabilities traffic
cached `claimed:false` for 60 seconds, while `/claim` could invalidate only the
isolate that handled it. ServerConfig SQLite and Durable Object hibernation were
correct. YAOS now never caches the one-way unclaimed state, while retaining the
bounded cache after claim. Regression tests model another isolate completing
claim without local invalidation.

After that fix, a fresh public deployment published all 100 notes, crossed a
20-second idle boundary, completed the full profile, and destroyed its
generation-scoped data without another 503. Public-network medians included
88.81 ms for one 100-body currentness query, 905.95 ms wall time for 100 parallel
head reads, 835.87 ms for stale 100-body catch-up, 562.93 ms for unchanged
100-body catch-up, and 372.32/360.86 ms propagation with one/seven receiving
sockets. Thirty-two body sockets opened in 13.29 seconds and the thirty-third
received the designed 429. The profiler also gained cross-edge claim probes,
exact Access diagnostics, provider-socket Access headers, document-scoped
tickets, current catch-up epochs, and the owner-request/operator-confirmed
destruction flow.

## Scope

This RFC decides:

- whether YAOS3 should adopt `ywasm` on the server;
- the boundary between TypeScript, Durable Object storage, and Wasm;
- how YAOS will own the upstream dependency and missing API;
- the memory, lifetime, failure, and correctness rules for the port;
- the delivery order and release gates;
- the complete implementation plan for Step 1, compaction reliability.

This RFC does not cover migration of an installed YAOS deployment. YAOS3 is a
greenfield implementation, and new vaults may start with this architecture. Yjs
remains useful as a test oracle but is not intended as a production fallback for
the same live document.

## Terminology: two different kinds of compaction

The distinction is important:

| Mechanism | What it changes | What it fixes | What it cannot fix |
| --- | --- | --- | --- |
| SQL/log checkpointing | Writes one complete encoded checkpoint and leaves only a short replay tail logically relevant to reconstruction | SQLite query, row decoding, and per-update replay overhead | CRDT structs and tombstones already encoded in the checkpoint |
| Semantic compaction | Materializes canonical live content into a fresh CRDT identity and atomically advances its semantic epoch | Old CRDT identities, tombstones, deleted structs, and history amplification | Feed retention or SQL rows required by active history pins |

A vault may physically retain journal rows that precede its newest checkpoint
for feed or pin retention. Those rows are not part of cold reconstruction.
Therefore “50,000 rows exist” is not equivalent to “50,000 updates are replayed.”
It can still cause storage and maintenance write amplification, so it is not a
total non-issue; it is a separate issue from CRDT lineage growth.

## Evidence

### Upstream and artifact validation

- The obsolete `yjs/Ywasm` repository is not the source to evaluate.
- The active implementation is in `y-crdt/y-crdt`.
- npm `ywasm@0.27.4` was released on 22 August 2026.
- The active repository HEAD examined for this work was dated 9 September 2026.
- The release workflow exists, but its Rust `stable` input is not hermetically
  pinned. A source checkout alone therefore does not reproduce the published
  binary strongly enough for YAOS's storage core.
- The npm artifact and active HEAD passed the same compatibility and Unicode
  probes. The published npm Wasm was the better immediate Worker artifact during
  the experiment; production adoption still requires YAOS's pinned build rather
  than trusting an opaque npm binary indefinitely.

This corrects the initial concern that the Rust implementation was merely an
old port. The important gap is not wire-format age. The Rust library implements
the Yjs update protocol, but its Wasm surface does not expose every JavaScript
Yjs internal that YAOS currently reads.

### Real Cloudflare Workers deployment

The probe was bundled and deployed to a real Worker backed by Durable Object
SQLite, rather than inferred from Node benchmarks.

- Worker version: `66ccbe1f-ab8f-44dc-89c7-8407b44d5b61`
- Wasm asset: approximately 960 KiB
- JavaScript wrapper: approximately 156 KiB
- Worker deployment, Wasm instantiation, binary update storage, Durable Object
  reconstruction, and HTTP execution all succeeded.

Large-shard median timings were:

| Lifecycle operation | Yjs | ywasm | Speedup |
| --- | ---: | ---: | ---: |
| Cold reconstruction | 496 ms | 89 ms | 5.6x |
| Dual-document load | 602 ms | 133 ms | 4.5x |
| Apply 50 updates to resident state | 118 ms | 28 ms | 4.2x |
| Catch-up | 350 ms | 92 ms | 3.8x |
| Checkpoint encode | 101 ms | 10 ms | 10.1x |
| Semantic rebuild | 21 ms | 16 ms | 1.3x |

For ordinary notes around 68 KiB, the difference was only about 1–5 ms. SQL
latency did not become algorithmically faster: Workers executed a faster CRDT
implementation around the same SQLite calls. The large gains arise in decoding,
applying, diffing, and encoding CRDT state, not in Durable Object storage.

### Unicode correctness

The offset contract was tested explicitly rather than inferred from ASCII:

- npm `ywasm@0.27.4` and the active source HEAD were both tested;
- 100 seeds × 500 operations × two cross-engine directions per artifact;
- 200,000 combined operations;
- CJK, emoji, emoji ZWJ sequences, combining marks, Zalgo text, and RTL scripts;
- every final document matched.

The implementation accepts JavaScript-native UTF-16 code-unit offsets. Generated
documentation claiming UTF-8 offsets was wrong. YAOS must encode the UTF-16
contract in its own API and retain this fuzz test as a release gate.

### Memory behavior

Wasm linear memory grows in pages and does not shrink after documents are freed.
Local retained-RSS observations after processing one state were:

| Encoded state | Retained RSS increase |
| ---: | ---: |
| 1.5 MB | 8.8 MiB |
| 3 MB | 11.3 MiB |
| 10 MB | 25 MiB |
| 25 MB | 53.5 MiB |
| 50 MB | 100.7 MiB |

An eight-large-shard, dual-document soak retained approximately 186 MiB with
Yjs and 111 MiB with ywasm, a roughly 40% reduction in that local process. Both
V8 and Wasm retain allocator high-water memory; only the Wasm linear heap is
directly observable through `memory.buffer.byteLength`.

Per-note sharding is valuable: the largest live CRDT state is bounded by an
individual note rather than the whole vault. It is not a complete memory proof.
The Wasm linear heap is shared by documents in one isolate, transient operations
overlap old state, fresh state, encoded buffers, and JS copies, and one unusually
large note can permanently raise the isolate's Wasm high-water mark. Worker code
cannot reliably terminate its own isolate to reclaim that memory. Admission must
prevent unsafe growth before it happens.

### Regression boundary

The current TypeScript implementation passed 164 suites with zero failures at
the end of the experiment. This proves the baseline used for comparison, not
that a future engine port automatically preserves those semantics.

## Why adopt now

YAOS3 is the least expensive point at which to establish the engine boundary.
Adding it after users have installed YAOS3 would require operating a live
storage-engine transition and a larger compatibility matrix. The wire format is
compatible, but runtime object identity, sync integration, memory behavior, and
failure handling are not.

The decision is based on four facts:

1. the large-history Worker gains are real and occur on YAOS lifecycle work;
2. ordinary traffic does not regress enough to erase those gains;
3. the missing surface is narrow enough to maintain as an auditable patch;
4. greenfield delivery lets YAOS make resource and lifetime invariants native
   rather than layering them onto an installed system.

This decision would be reversed before release if the pinned build cannot match
the measured artifact, the memory ceiling cannot be enforced before growth, or
the cross-engine conformance suite finds a wire/semantic incompatibility.

## Target architecture

The storage boundary remains byte-oriented:

```text
client wire update
    -> TypeScript size/auth/epoch admission
    -> ywasm CRDT operation
    -> TypeScript canonical Markdown/Canvas/root validation
    -> Uint8Array update/checkpoint
    -> Durable Object SQLite transaction
    -> receipt, feed, catalog, alarm, and socket coordination
```

Wasm never calls Durable Object storage. TypeScript passes bounded
`Uint8Array`s across the Wasm boundary and writes returned bytes using the same
SQLite schema and transactional rules. This preserves the current durable model
and avoids importing coordination policy into Rust.

### Server-only `CrdtEngine`

All server CRDT use must pass through a narrow interface. Application code must
not import Yjs or ywasm directly. The exact TypeScript spelling may evolve, but
the boundary must cover these capabilities:

```ts
interface CrdtEngine<Doc, Vector, Update> {
	createDocument(guid: string): Doc;
	openDocument(guid: string, encodedState: Uint8Array): Doc;
	applyUpdate(doc: Doc, update: Uint8Array, origin?: string): boolean;
	encodeStateVector(doc: Doc): Uint8Array;
	encodeStateAsUpdate(doc: Doc, vector?: Uint8Array): Uint8Array;
	mergeUpdates(updates: readonly Uint8Array[]): Uint8Array;
	documentStats(doc: Doc): {
		encodedStateBytes: number;
		totalStructs: number;
		deletedStructs: number;
	};
	withReadTransaction<T>(doc: Doc, body: (tx: unknown) => T): T;
	withWriteTransaction<T>(doc: Doc, origin: string, body: (tx: unknown) => T): T;
	destroyDocument(doc: Doc): void;
}
```

Text, map, array, and XML access should be exposed through schema-aware YAOS
helpers, not raw engine wrappers escaping into services. `roots()` can replace
the present `doc.share` inspection. No transaction or wrapper may survive an
`await`.

Production supplies a ywasm adapter. Tests supply both ywasm and Yjs adapters so
the existing engine remains an independent oracle. YAOS will not keep two
mutable production representations of one document.

### Missing document census

YAOS currently uses `doc.store.clients` to count structs and deleted structs for
semantic compaction. That Yjs internal is neither a stable public abstraction
nor exposed by ywasm.

Add one narrow Rust/Wasm method, `documentStats()`, that returns only the stable
numbers the policy requires. Submit it upstream and carry the patch against an
exact source commit until accepted. Do not recreate a shadow Yjs document to
obtain the census; that would double representation and erase much of the memory
benefit.

The patch must have a Rust unit test, a Wasm binding test, cross-engine fixtures,
and a source-level review showing that it walks existing store metadata without
mutating the document.

### Sync protocol

`y-protocols/sync` accepts Yjs document objects, so it cannot be passed a ywasm
document. YAOS should retain the existing outer message framing and implement
the three small sync operations directly:

- sync step 1: decode the peer state vector and encode the missing update;
- sync step 2: validate and apply the returned update through normal admission;
- update: validate and apply through the same durable candidate path.

Framing tests must compare byte-level behavior and final state with the Yjs
oracle. Root sockets remain download-only and must retain the current structural
empty-update rule.

### Lifetime rules

Every Wasm-backed document, shared type, transaction, observer, and temporary
wrapper is an owned resource unless the binding proves otherwise.

- Use `try/finally` or a scoped helper at every allocation site.
- Free child wrappers before their document.
- Never retain a transaction across `await`.
- Copy bytes deliberately when storage or asynchronous work outlives a Wasm
  view.
- Make double-free and use-after-free impossible at the adapter boundary.
- Run a 10,000-cycle allocation/disposal soak and assert that linear-memory
  growth settles within a calibrated page allowance.

JavaScript garbage collection is not the ownership mechanism for Wasm
resources.

### Memory envelope

The ywasm build must export its `WebAssembly.Memory`, and diagnostics must report
`memory.buffer.byteLength`. The build must also set a tested maximum linear-memory
limit so uncontrolled `memory.grow` fails closed.

Admission uses a conservative pre-operation estimate that includes:

- resident authoritative and validation documents;
- the current linear-memory high-water mark;
- incoming JS bytes and required copies;
- old document, fresh semantic-reset document, state vector, encoded checkpoint,
  and hashing/storage buffers that can overlap;
- a fixed allocator/fragmentation safety margin.

Updates and journal rows remain bounded before entering Wasm. Reconstruction
applies a checkpoint and a bounded tail incrementally rather than first merging
the entire journal in JavaScript. If the reservation cannot fit, YAOS returns
explicit resource backpressure before invoking Wasm. Throwing an exception is
not treated as an isolate reset.

Budgets must be recalibrated from deployed Worker telemetry. The current 48 MiB
server encoded-state cache ceiling cannot simply be copied to a different
allocator model.

### Traps and corrupt input

All untrusted byte lengths are checked in TypeScript before Wasm. An apply or
decode trap marks the operation failed, frees or discards all wrappers that can
still be freed, discards the affected resident document, and reconstructs from
the durable checkpoint and tail on the next access. A trap must never publish a
catalog mutation, receipt, or socket broadcast.

Repeated traps for the same durable bytes are a corruption state, not an
infinite retry. Diagnostics must identify the document and durable sequence
without logging note contents.

### Build ownership

YAOS should vendor build metadata and its tiny patch, not an unexplained binary.
The build must pin:

- the exact `y-crdt/y-crdt` commit;
- Rust toolchain version and target;
- `wasm-bindgen`/`wasm-pack` and optimizer versions;
- Cargo dependency lockfile;
- build flags, memory maximum, and exported-memory behavior.

CI builds twice and compares checksums, records the Wasm and JS sizes, scans the
imports/exports, runs `wasm-opt` only at the pinned version, and rejects material
bundle or benchmark regression. The deployed artifact checksum belongs in build
metadata and operational diagnostics.

## Risks and required mitigations

| Risk | Required mitigation |
| --- | --- |
| Semantic and SQL compaction can stop being scheduled | Complete Step 1 before the engine port |
| Missing `doc.store.clients` census | Narrow upstreamable Rust/Wasm `documentStats()` patch |
| Missing `doc.share` | Engine/schema-aware root access using `roots()` |
| Yjs-specific APIs throughout the server | Server-only `CrdtEngine`; forbid direct imports outside adapters/tests |
| `y-protocols/sync` requires Yjs docs | Implement the small sync state machine over engine byte APIs |
| Wrapper leaks | Scoped disposal, lint/review rule, 10,000-cycle leak soak |
| Linear-memory high-water growth | Export telemetry, maximum pages, conservative pre-admission, per-note limits |
| No reliable Worker self-termination | Never depend on self-termination; fail before memory growth |
| Wasm traps or panics | Bound input, fail closed, discard resident state, durable reconstruction |
| Upstream/build drift | Exact source/toolchain pins, checksums, reproducible CI, tiny reviewed patch |
| Incorrect offset documentation | YAOS-owned UTF-16 contract and Unicode differential fuzzing |
| FFI copy overhead | Keep SQL byte-oriented, measure copies, avoid wrapper churn and whole-tail merges |
| “Wasm fixes everything” expectation | Report end-to-end SQL/network/coordination timings, not CRDT-only speedups |

## Delivery sequence

1. Repair SQL and semantic compaction accounting, durable retry, alarms, and
   restart behavior as specified below.
2. Establish the hermetic Rust/Wasm build, memory export/maximum, artifact
   checksums, and the document-census patch.
3. Introduce `CrdtEngine`, a Yjs oracle adapter, and a ywasm adapter without
   changing production behavior.
4. Move server document operations behind the interface, implement sync framing,
   and enforce scoped disposal and trap recovery.
5. Make ywasm the only production engine and run the complete greenfield YAOS3
   qualification matrix.

Each step lands independently with its own tests. Step 1 is valuable even if a
later ywasm gate fails.

## Step 1: compaction reliability implementation plan

### Current defects

The audit found five concrete defects or coverage gaps.

1. `SemanticCompactionRuntime.measureAndMaybeCompact()` sets
   `admissionPaused` when hard pressure is known. Its transient reservation can
   then throw. `VaultServerRuntime.recordCompactionCommit()` schedules an alarm
   only from the fulfilled promise; rejection is logged. The document can keep
   returning 429 without a guaranteed retry.
2. Runtime activity, latency pressure, and `admissionPaused` are memory-only.
   A Durable Object restart resets all three and an already-pathological
   document is not examined merely because it is loaded.
3. The alarm enumerates only in-memory semantic diagnostics. A persisted alarm
   wakes a fresh object, but the fresh object has no document IDs to process.
   The alarm is a wake-up hint, not durable work identity.
4. `documentJournalStats()` counts every retained row, including rows at or
   before a complete checkpoint. Once 50 retained rows exist, subsequent commits
   can write redundant full checkpoints until the feed floor advances.
5. Some root-only Canvas creation and lifecycle commits do not invoke the common
   semantic compaction accounting callback. The current accounting surface is
   call-site-dependent.

Ordinary Markdown/Canvas paths are otherwise safer than the pathological trace
alone suggests. Socket flush invokes maintenance after success; HTTP candidate
paths flush pending work before their direct commit; reconstruction starts at
the newest complete checkpoint. Semantic reset itself already has the important
correctness properties: canonical validation, a fresh lineage, exact-head CAS,
atomic epoch/checkpoint publication, stale-socket fencing, and transactional
durable policy.

### Invariants

The implementation is complete only if these invariants hold:

1. Every successful durable CRDT journal commit is accounted exactly once by
   one common post-commit path, including Markdown, Canvas, root, socket, HTTP,
   creation, promotion/demotion, and lifecycle mutations.
2. Compaction work identity is durable or reconstructible from durable state.
   Neither a promise continuation, an in-memory map, nor an alarm timestamp is
   the sole record that work exists.
3. Once hard pressure fences admission, that fence survives object restart and
   remains until an exact successful census clears it or an exact semantic reset
   clears it transactionally.
4. An exact receipt replay is checked before compaction backpressure. A client
   may always recover the proof of an already committed operation.
5. SQL checkpoint eligibility counts only journal rows strictly newer than the
   newest complete checkpoint for that document.
6. Compaction remains serialized per document and publishes only through the
   existing exact `(generation, semanticEpoch, latestSequence)` CAS.
7. Active history pins retain their exact reconstruction recipes. Neither SQL
   checkpointing nor semantic reset weakens pin retention.
8. At most one semantic compaction attempt for a document is active in an
   isolate. Duplicate alarms and commit callbacks coalesce on durable identity.
9. Maintenance failure cannot roll back or misreport the user commit that has
   already succeeded.
10. Alarm work is bounded and re-arms itself while any durable retry remains.

### Durable state

Extend `vault_semantic_compaction_state` in the greenfield schema:

```sql
retry_required INTEGER NOT NULL DEFAULT 0
  CHECK(retry_required IN (0, 1)),
admission_paused INTEGER NOT NULL DEFAULT 0
  CHECK(admission_paused IN (0, 1)),
retry_not_before INTEGER
  CHECK(retry_not_before IS NULL OR retry_not_before >= 0),
retry_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK(retry_failure_count >= 0),
last_failure_class TEXT,
last_failure_at INTEGER
  CHECK(last_failure_at IS NULL OR last_failure_at >= 0),
CHECK(retry_required = 1 OR (
  admission_paused = 0 AND retry_not_before IS NULL
))
```

Add an index over `(retry_required, retry_not_before, document_id)`. Failure
class is a bounded enum such as `transient-budget`, `busy`, `not-resident`,
`head-changed`, `trap`, and `internal`; do not persist arbitrary exception text
or note content. Saturate the failure count rather than allowing numeric
overflow.

`retry_required` means the document must receive another exact compaction
attempt. `admission_paused` is separate because a failed soft attempt may need a
retry without rejecting writes. `retry_not_before` is scheduling policy, not
correctness authority.

Add store operations with narrow semantics:

- `markSemanticCompactionRetry(documentId, state)` atomically upserts retry and
  pause state, preserves the earliest outstanding due time, and increments a
  bounded failure count only for an actual failed attempt;
- `listSemanticCompactionRetries(now, limit)` returns deterministic due work;
- `nextSemanticCompactionRetryAt()` returns the earliest future due time;
- `clearSemanticCompactionRetry(documentId, expectedHead)` clears only if the
  durable head still matches the census that justified clearing it;
- `semanticCompactionState(documentId)` returns policy and retry fields;
- `semanticResetFromEncodedState()` clears retry, pause, and failure fields in
  the same transaction that publishes the fresh epoch and checkpoint.

Creating a retry row and arming an alarm happen in that order. If alarm arming
throws, the durable row still causes a later request, load, or alarm to rediscover
the work.

### One post-commit path

Replace the optional, inconsistently invoked service callbacks with one
non-throwing commit observer at the `VaultStore.commitUpdate()` completion
boundary. It invokes a required runtime method:

```ts
afterDurableCommit({
	documentId,
	ingressBytes,
	commitLatencyMs,
	vaultSequence,
}): void
```

The store emits the record exactly once after its SQLite transaction succeeds.
The runtime defers maintenance to the next microtask so the caller can publish
the same update into resident state first. It then performs two independent
actions:

1. evaluate tail-only SQL checkpoint maintenance;
2. enqueue semantic activity measurement in `execution.waitUntil()`.

The method is idempotent by committed vault sequence so a refactor cannot
double-count one commit. The observer knows only the immutable commit record; it
cannot await, throw into an already-completed user commit, or know about alarms
or Wasm. This covers commits made through higher-level `VaultStore` helpers as
well as direct service calls.

Audit every `commitUpdate()` producer and remove the superseded optional
callbacks in:

- socket flush and direct server paths;
- Markdown candidate and lifecycle services;
- Canvas candidate, creation, promotion/demotion, and lifecycle services;
- root catalog and attachment-authority mutation paths.

Add a test-only assertion that every successful journal sequence emitted one
post-commit record. This prevents the coverage gap from reappearing when a new
mutation endpoint or `VaultStore` helper is added.

### Tail-only SQL checkpointing

Replace `documentJournalStats()` for maintenance decisions with
`documentJournalTailStats()`:

```sql
WITH checkpoint AS (
  SELECT COALESCE(MAX(checkpoint_sequence), 0) AS sequence
  FROM vault_checkpoint_manifests
  WHERE document_id = ? AND complete = 1
)
SELECT COUNT(*) AS entries,
       COALESCE(SUM(update_byte_length), 0) AS bytes,
       checkpoint.sequence AS checkpoint_sequence
FROM vault_journal, checkpoint
WHERE document_id = ?
  AND vault_journal.sequence > checkpoint.sequence;
```

Use the existing entry/byte thresholds against this tail. A checkpoint write
must use the head observed for the decision and retain its existing integrity
manifest and exact-head validation. Feed-floor pruning remains a separate pass:
pre-checkpoint rows may stay physically present while reporting a zero tail.

If checkpoint creation fails after the user commit, record a bounded diagnostic
and allow the next post-commit/load/alarm maintenance pass to retry. SQL
checkpoint failure does not set semantic admission pause. Because the tail and
head are durable, the work is reconstructible even without another queue table;
startup/load must call the tail check so a quiet document is not dependent on a
future write.

### Semantic attempt state machine

Refactor semantic measurement around explicit outcomes:

```text
commit/load/alarm observes due work
    -> serialize document
    -> persist hard pause before any fallible full-state operation
    -> ensure clean, current resident head
    -> reserve transient budget
    -> exact census and policy decision
       -> no reset needed: conditional clear retry/pause
       -> reset needed: exact-head CAS reset; clear in same transaction
       -> busy/head changed/no resident/error: persist retry and due time
    -> arm earliest alarm
```

Important ordering rules:

- Persist a newly established hard pause before checking dirty state, resident
  availability, or transient budget.
- Put transient reservation inside the classified `try/catch`; the current
  reservation throw occurs before the cleanup block.
- Treat `busy`, `not-resident`, and `head-changed` as retry outcomes when durable
  retry is set, not terminal successes.
- If a successful census says no semantic reset is useful, clear the retry only
  with the exact head used for that census. A changed head leaves it pending.
- If hard pressure describes irreducible live content rather than removable
  history, surface a distinct durable resource-limit diagnostic. Do not spin an
  alarm forever or imply that another semantic reset can shrink it. The later
  Wasm memory-envelope work must define the admission/recovery policy for that
  terminal condition.
- A semantic reset keeps the existing transaction that advances the epoch,
  writes the checkpoint and policy low-water mark, migrates root proofs where
  applicable, and prunes only unpinned history.

Backoff starts at the existing persistence retry interval, is bounded, and has
deterministic jitter per document to avoid a vault-wide retry burst. Fresh input
may move a retry earlier but never deletes it.

### Load and restart behavior

After `VaultDocumentCache.load()` has installed and sized a document, notify the
runtime with `(documentId, kind, encodedStateBytes, durableHead)`. Do not run an
exact census while the cache's reconstruction reservation is still held.

The load hook must:

- restore durable `admissionPaused` immediately;
- schedule due durable retry intent;
- schedule an exact census when encoded bytes already cross a soft/hard threshold;
- check the SQL journal tail and retry a missing checkpoint;
- avoid counting a load as a new edit.

On object construction there is no need to scan every document in a vault.
Alarms enumerate durable retry rows; ordinary document loads inspect their own
durable state. This preserves vault sharding and bounds startup work.

### Alarm drain

The alarm handler must query `listSemanticCompactionRetries()` rather than the
in-memory diagnostics map. Process a bounded number of due documents and at
most one expensive reset concurrently. Each document still enters the cache's
serialization lane.

At the end of every drain, compute the earliest outstanding due time and combine
it with pending socket persistence, recovery capture/restore, and GC deadlines.
Arm the single Durable Object alarm for the earliest deadline. Never move an
already-needed alarm later and never delete it while another subsystem has
durable work.

An alarm attempt that cannot load a document under the transient budget leaves
its durable retry row, advances its backoff, and re-arms. A runtime restart
between any two of these operations cannot erase the intent.

### Admission and receipt ordering

Candidate endpoints already generally check durable receipts before the pause
guard. Preserve and test this ordering in both the outer request path and the
per-document serialized recheck:

1. validate identity/epoch enough to locate a receipt;
2. return an exact matching durable receipt;
3. reject operation-ID/digest reuse;
4. only then return semantic-compaction 429 for new work.

Socket admission and new socket updates may be fenced under a hard pause. Root
mutations are internal, exact-CAS operations; they must be accounted and retried
without turning one root maintenance event into an unexplained vault-wide 429.

### Diagnostics

Expose per-document fields without note content:

- total retained journal rows/bytes;
- post-checkpoint tail rows/bytes and checkpoint sequence;
- encoded resident bytes and last exact census values;
- retry required, admission paused, failure count/class/time, and next attempt;
- last successful measurement/reset/checkpoint time;
- current generation, semantic epoch, and observed head sequence;
- compaction attempt/result counters and duration;
- active history-pin count and oldest protected boundary.

Aggregate alarms should report due semantic retries, future semantic retries,
pending persistence, and which deadline won alarm scheduling. Logs must
distinguish SQL checkpoint maintenance from semantic reset.

### Test plan

Add focused deterministic tests before changing the engine:

| Scenario | Required assertion |
| --- | --- |
| Transient reservation fails after hard pressure | Pause and retry are durable; an alarm is requested; no update is lost |
| Object restarts before alarm | Fresh runtime enumerates the durable document and retries successfully |
| Alarm scheduling itself fails | Durable intent remains and the next request/load rediscovers it |
| Candidate arrives while paused | New candidate receives 429 with retry guidance |
| Exact candidate replay while paused | Matching durable receipt still returns success; mismatched digest returns conflict |
| Candidate-only commit stream reaches SQL threshold | A complete checkpoint is written without requiring socket traffic |
| Checkpointed rows remain for feed retention | Tail becomes zero and later sub-threshold commits do not create redundant checkpoints |
| Canvas root-only create/lifecycle churn | Root activity is counted and a due census/reset is scheduled |
| Over-threshold document is loaded after restart | Load schedules exact measurement without counting a commit |
| Successful no-op census | Durable retry/pause clears only if the exact head still matches |
| Successful semantic reset | Retry fields clear in the same transaction as epoch/checkpoint publication |
| Head changes during preparation | CAS publishes nothing; durable retry remains and later succeeds |
| Dirty or validation-pending resident | Attempt is classified busy and re-armed |
| Active history pin spans reset/checkpoint | Exact protected recipe reconstructs the pinned boundary |
| Duplicate commit callback/alarm | One sequence is counted once and no concurrent document compactions occur |
| Irreducible hard live state | Classified resource-limit state does not spin alarms indefinitely |
| Checkpoint write fault | User commit remains successful; tail remains reconstructible; later maintenance retries |

Retain the existing semantic reset, epoch fencing, checkpoint corruption,
history pin, candidate race, socket race, and full server regression suites. Add
a frozen high-churn trace in which the SQL tail stays bounded and semantic
history is reset before the old pathological state can recur.

### Implementation slices

Land Step 1 in reviewable slices:

1. Add tail-only store queries and regression tests for retained pre-checkpoint
   rows.
2. Add durable semantic retry/pause schema, store operations, and transaction
   tests.
3. Refactor the semantic runtime into classified outcomes with correct
   persist-before-fallible ordering.
4. Introduce `afterDurableCommit()` and convert every mutation producer, with
   coverage assertions.
5. Add load/restart discovery and the durable alarm drain.
6. Add diagnostics, fault injection, frozen-trace coverage, and run the complete
   server suite.

### File-level work map

| Area | Planned change |
| --- | --- |
| `server/src/vaultDocumentStore.ts` | Extend durable compaction state, add retry enumeration/transitions, add tail-only journal statistics, and clear retry state in the semantic-reset transaction |
| `server/src/vaultStore.ts` | Emit the immutable non-throwing post-commit record from the one successful `commitUpdate()` boundary, including commits reached through store helpers |
| `server/src/semanticCompactionRuntime.ts` | Restore durable pause/retry state, classify all attempt outcomes, persist before fallible work, conditionally clear against the exact head, and expose diagnostics |
| `server/src/server.ts` | Own `afterDurableCommit()`, tail maintenance, bounded durable alarm draining, earliest-deadline alarm coordination, and load discovery |
| `server/src/vaultDocumentCache.ts` | Report completed loads after reconstruction reservations are released; do not start compaction inside cache installation |
| candidate/lifecycle/semantic/socket services | Remove optional accounting callbacks, preserve receipt-before-backpressure ordering, and rely on the store completion boundary |
| `tests/server/semantic-compaction-runtime.ts` | Add durable failure/restart, classified outcome, exact-head clearing, and no-concurrency tests |
| store/runtime/race suites | Add tail-only checkpoint, all-producer coverage, receipt replay, alarm failure, pin retention, and Canvas/root churn cases |

### Step 1 acceptance criteria

Step 1 is done when all of the following are evidenced:

- no successful CRDT journal commit bypasses post-commit accounting;
- a hard-pressure retry survives object restart and failed alarm arming;
- a paused document cannot become permanently stranded behind a memory-only
  flag;
- exact receipt replay works during the pause;
- SQL checkpoint thresholds use only the post-checkpoint tail;
- retained feed/pin rows do not cause checkpoint-per-commit behavior;
- load, candidate-only, socket, Canvas, and root-only paths all schedule work;
- semantic reset still has exact-head atomicity and pin-safe retention;
- alarms are bounded and remain armed while durable retry exists;
- current regression suites and the new fault matrix pass.

## YAOS3 release gates for the complete RFC

The ywasm production switch may ship only after:

- Step 1 acceptance is complete;
- pinned builds are reproducible and artifact sizes fit Worker limits;
- the census patch is covered and either upstreamed or documented as a tiny
  maintained patch;
- differential wire/state/canonical-content suites pass for Markdown, Canvas,
  root, sync, checkpoints, catch-up, and semantic resets;
- the 200,000-operation Unicode fuzz suite passes unchanged;
- 10,000 create/apply/encode/free cycles settle within the memory allowance;
- multi-shard and one-pathological-note tests stay within the calibrated Worker
  admission envelope;
- traps, corrupt updates, allocation failure, and restart recover from SQLite
  without partial publication;
- deployed Worker lifecycle medians do not materially regress from the measured
  ywasm artifact;
- the entire YAOS regression, Worker conformance, and destructive greenfield
  deployment suites pass.

## Final recommendation

Proceed with the implemented design. The measured benefit is large on the exact pathological and lifecycle
operations that threaten a constrained Durable Object, while the greenfield
window makes the architectural cost lower now than later. But treat ywasm as a
storage-engine component YAOS owns operationally, not as an npm optimization.

Step 1, the Rust/Wasm build, the engine boundary, the production port, the
cross-isolate claim fix, and the qualification matrix are complete in this
worktree. Continue recalibrating memory admission from production telemetry;
that operational tuning does not change the adopted engine boundary.
