# RFC: Relay Markdown body updates

Status: **draft** (relay v2 spike, branch `relay-v2-spike`, base `5dd32f3`). Sections 1, 2, 8, 9 and 14 still
contain `<<MEASURED: …>>` placeholders. The full-n runs fill them. All other sections are complete.

What this RFC describes:
- The server implementation in the working tree on 2026-09-30: committed `20e0e34`/`e1abb36`, plus the uncommitted
  server-core round-2 work. The round-2 items are marked **(WIP)**.
- Cited line numbers refer to that working tree and will drift. Function names are the stable reference.
- The contract document is [`relay2-protocol.md`](relay2-protocol.md). Where the two differ, the code wins, and the
  difference is called out.

Evidence labels:
- **measured**: taken on a deployed Worker or in a local run, with n and the scenario ID.
- **inferred**: derived from measurements through a stated model.
- **code**: read from `server/src`.

## 1. Summary and recommendation

<<MEASURED: final recommendation after L1–L7, C1–C6, B1–B8, X1–X4, K1–K3 at full n>>

Draft position, based on small-n and component evidence: **go with conditions**.

1. On the propagation path the relay is at or near the network floor. The measured small-n L2 p50 is 90 ms for the
   relay against 412 ms for base. The relay path also survives hibernation and scales past the base 32-socket cap.
2. Conditions:
   - write amplification fits the Workers Free rows-written budget (section 9)
   - the feed-floor and journal-retention gap (G1) is fixed
   - the unenveloped-client lazy-hash path (G4) has its bounds proven
   - socket-ack receipts are integrated into `VaultSync` (section 11, phase 2)
3. Semantic reset moves to clients under a lease. That is a prerequisite for large notes, because only clients can
   compact past the 96 MiB Wasm cap.
4. ywasm stays on the server, for the root document, Canvas semantic documents and the base fallback. It leaves the
   Markdown body hot path.
5. Reversal conditions are listed in section 13.

## 2. Problem

Today the authoritative body path puts the following on every body frame:
- a resident ywasm document, plus a validation mirror document
- a debounced flush
- a second write path: the HTTP candidate, which carries the same bytes

The costs below were measured before this spike.

| Cost | Evidence | Label |
|---|---|---|
| Keystroke propagation p50 ≈ 300 ms, set by the 250 ms `PERSIST_DEBOUNCE_MS` flush plus commit and broadcast | A3: 306 ms propagation, 301 ms body sync. v1 relay L2: 300 → 52 ms (A5) | measured |
| Idle storm before phase 0: ≈160k billed DO requests/day for 3 idle devices, 1.6× the DO free tier | A1: 1,430 reconnects per socket per day; `1008 socket authority mismatch` on every ping after a wake | measured + inferred |
| Body sockets capped at 32 per vault (`MAX_BODY_SOCKETS`, the 48 MiB / 96 MiB Wasm envelope) | A3: the 33rd socket gets 429. Harness X1 (base): 429 `body_socket_limit` at #33 | measured |
| Resident memory grows with open bodies: 32 × 512 KiB adds 36 MB of Wasm on base; flat on relay | A5 C3 | measured |
| CPU per keystroke on a heavy note: 19 ms base against < 1 ms v1 relay | A5 C1 | measured |
| Hibernation: base closes body sockets with 1008 on the first edit after DO eviction. Reconnect ≈ 1.33 s against 351 ms warm | A5; harness B1 (base, scratch-2) | measured |
| Time from edit to cleared settled receipt p50 is 531 ms. The debounce accounts for 250 ms of it and the candidate POST for ≈ 280 ms | L5 baseline, D8, n = 14, scratch-2 | measured (small n) |
| Every Worker → DO hop costs ≈ 44–47 ms; a HEAD is 4 hops at ≈ 215 ms | A2/A4 | measured |

Baseline tables for this spike, flag off, same code and harness:

| ID | Metric | Base p50 / p90 / p99 | n | Date | Worker |
|---|---|---|---|---|---|
| L1 | ping RTT | <<MEASURED: L1 base>> | 100 | | |
| L2 | propagation A→B, 4 KiB | <<MEASURED: L2 base>> (small n: 412 ms p50, n = 30) | 300 | | |
| L3 | propagation, 64k chars, after the quick trace | <<MEASURED: L3 base>> | 50 + 50 | | |
| L4 | per-frame at 25 edits/s | <<MEASURED: L4 base>> (small n: 293 / 458 ms, n = 300) | 5,000 | | |
| L5 | edit → cleared receipt | <<MEASURED: L5 base>> (small n: 531 ms, n = 14) | 100 | | |
| C1 | CPU per keystroke, small / heavy | <<MEASURED: C1 base>> | ≥ 40 each | | |

## 3. Product constraints and how they shaped the design

| Constraint (brief §1.2) | Consequence in this design |
|---|---|
| **Local-first; disk is the user-visible truth; the server is not the only copy.** | The server can be a durable ordered mailbox, not a judge. It stores and orders bytes, fences on authority and epoch, and relays. Validation of body content moves to the receiving client before its disk write (section 5), because that client owns the disk. Losing the server's semantic view is acceptable only because every device holds the full text. |
| **Few clients × many documents** (1–5 devices; hundreds to tens of thousands of notes). | Per-note server state must be cheap and bounded by bytes, not documents. Relay sockets carry no resident document. The only cache is a byte LRU (`YAOS_RELAY_MERGED_CACHE_BYTES`, 16 MiB) keyed by head sequence. The socket cap is a config value (default 5,000), not a memory envelope. Bootstrap and catch-up read stored bytes and never build a document. |
| **Idle most of the day, Obsidian left open.** | Hibernation must be invisible. Relay sockets are exempt from the `runtimeEpoch` fence (the attachment records the admission epoch), so a woken DO keeps serving the socket (B1). No debounce timers are needed. An alarm is armed only when a tail crosses the checkpoint threshold. A fully idle vault does no SQL writes. |
| **Self-hosted on the user's Cloudflare account, aiming for $0.** | The free tier is a hard constraint on request counts and rows written (section 9). This drove several choices: one transaction per append with no extra rows (`vault_operation_outcomes` is not written); the growth cap (resends become no-ops, not rows); optional micro-batching; checkpoints bounded to 200 rows per pass. It also exposed the main risk: relay writes one append per frame where base writes one per 250 ms window (section 12, R5). |
| **Devices may all be phones; nothing may require a desktop.** | Server-side semantic compaction is replaced by a client lease, so the work must be feasible on a phone. K2 measured desktop reset build times of 12–98 ms p50; mobile-class ×4–6 is inferred at 48–586 ms, with a duty-cycle pessimistic bound of 1.7 s p50 for 5 MB. The routine checkpoint stays on the server as a byte merge that needs no client. Any device may take the lease; none is privileged. |
| **Devices are usually close to the DO; mobile networks and travel exist.** | Receipts ride the socket ack (no second HTTP round trip). Catch-up and bootstrap stay HTTP-batched. Retries are idempotent through `candidateId` receipts. The lease TTL (120 s, up to 600 s) and the reset upload limits reflect slow mobile uploads: B5 measured 115.7 s for a 5 MB upload. |

## 4. Design

### 4.1 Scope and flag

- The flag is `YAOS_RELAY_BODIES === "true"` (`relayFlag.ts` `relayBodiesEnabled`). With it on, Markdown body sockets
  use the relay path. A body is a relay body when it is not `root` and has a catalog head (`server.ts` `isRelayBody`).
- Out of scope:
  - root sockets (download-only)
  - Canvas semantic sockets (`/ws/semantic`)
  - lifecycle HTTP routes, i.e. create, rename and delete, including the creation-candidate fence
- The Node host reads the same flag (`packages/server-node/src/index.ts`).
- The capability `relayBodies: 2` is advertised in `VAULT_READY.capabilities` and in `/api/capabilities`.
- The socket URL does not change: `/ws/body/:bodyId`, with a ticket bound to the body epoch.

### 4.2 Data model

The relay reuses the storage-4 tables. It adds exactly one table, created lazily.

| Table | Relay use |
|---|---|
| `vault_clock` (single row) | One `sequence + 1` per append. This is the vault-wide total order. |
| `vault_journal` (`sequence`, `document_id`, `generation`, `semantic_epoch`, `kind`, `update_byte_length`, `data`, `created_at`; index `(document_id, sequence)`) | One row per append, kind `'body'`, raw Yjs v1 update bytes of at most 1,750,000 B (`MAX_DURABLE_UPDATE_BYTES`). A reset writes kind `'semantic-reset'` with zero bytes. |
| `vault_mutation_attribution` | One row per frame in the append: principal, membership revision, device, credential revision, `request_digest` = sha256 of the frame. `operation_id` is NULL. |
| `vault_document_heads` | `generation + 1` and `latest_sequence` per append. Epoch changes happen only through reset. |
| `vault_catalog_events` | One row per append: path, lifecycle `active`, generation, epoch, and `content_hash`/`size`, or NULL when no claim was accepted. |
| `vault_candidate_receipts` | One row per enveloped frame that carries a `candidateId`: `(body_id, client_id, candidate_id)` → digest, epoch, generation, sequence, runtime epoch. Pruned by the alarm (`pruneCandidateReceipts`). |
| `vault_checkpoints` + `vault_checkpoint_manifests` | Byte-merged snapshot, chunked. Written by the checkpoint and by reset. The 3 newest checkpoints of the current epoch are kept, and pins are respected (`pruneUnpinnedDocumentHistory`). |
| `vault_semantic_compaction_state` | Reset cooldown source (`last_compacted_at`) **(WIP)**. |
| **`relay_compaction_leases`** (new) | `body_id` PK, `lease_id`, `device_id`, `principal_id`, `body_epoch`, `expires_at`, `created_at`. Created lazily by `RelayBodyStore.ensureLeaseTable`. |

Nothing is migrated. With the flag off the lease table is never created. With the flag on, base tables are written
with the same meanings as base, so a vault can move between modes only on a fresh install (section 11).

### 4.3 Wire protocol

**Frames on a relay body socket** (`vaultSocketService.ts` `relayMessage`):

| Direction | Frame | Handling |
|---|---|---|
| C→S text | `BODY_UPDATE_ENVELOPE` JSON: `clientFrameId`, `payloadDigest` (sha256 hex of the next binary update), optional `candidateId`, `candidateDigest`, `contentHash`, `size`, `stateVector` (base64) | Held in `pendingEnvelopes[socketId]` (memory only) and paired with the next binary SYNC_UPDATE on that socket when the digest matches (`relayBodies.ts` `handleControl`, `handleSyncFrame`). A mismatch drops the pairing (`envelopeMismatches`). The frame is still appended, unenveloped. |
| C→S binary | y-protocols `MESSAGE_SYNC` step1 / step2 / update | step1 → step2 served from bytes (4.5). step2/update → append (4.4). |
| C→S binary | awareness | Relayed through `relayAwareness`; not stored. |
| C→S text | `VAULT_PING`, `BODY_CURRENTNESS_QUERY` | Both re-validate the actor. The ping answers with the admission `runtimeEpoch`. Currentness answers from `currentBodyHead` (the hash may be null). |
| S→C text | `VAULT_READY` | Includes `capabilities.relayBodies: 2`. |
| S→C text | `BODY_COMMITTED` (origin) | `relay: true`, `clientFrameId`, `vaultSequence`, `durableGeneration`, `candidateId`/`candidateDigest`, `payloadDigest`, `runtimeEpoch` (admission), `commitRuntimeEpoch`, `contentHashAccepted`, `deduped`, `noop`. |
| S→C binary + text | peer fan-out | Raw SYNC_UPDATE with the same bytes, plus `BODY_COMMITTED` with `relay: true, peer: true`. The origin is excluded. |
| S→C text | `BODY_UPDATE_REJECTED` | Reason `candidate_id_reused`: the same `candidateId` was sent with a different digest. |
| S→C text | `VAULT_BACKPRESSURE` | Reason `relay_rate_limit`, followed by close 1013. |
| S→C text | `VAULT_ERROR` | Code `durability_failed`, followed by close 1011. |

**Close codes:**

| Code | Meaning |
|---|---|
| 4409 | Epoch fence. Carries the current epoch; the client rebases. |
| 4403 | Authority superseded (revocation, membership change). |
| 1013 | Rate limit. |
| 1009 | Frame larger than 1.75 MB. |
| 1008 | Body not active or deleted. |
| 1011 | Commit failed. |
| HTTP 429 | At upgrade, when relay + semantic sockets would exceed `YAOS_RELAY_MAX_BODY_SOCKETS`. |

**HTTP routes added:**
- `POST /vault/:id/body/:bodyId/compaction-lease` and `POST …/semantic-reset`. Both need the
  `vault.content.write` capability. See 4.9.
- `HEAD /body/:id` **(WIP)**.
- Test-only: `/__yaos/test-only/relay-table-counts`.

`GET /body/:id` gains `x-yaos-head-sequence` and `x-yaos-content-hash-state` (`known` | `materialised` | `unknown`)
**(WIP)**.

### 4.4 The append

Order of operations. Code: `relayBodies.ts` `handleSyncFrame` then `commitFrames`, and `relayBodyStore.ts`
`appendRelayBodyUpdate`.

1. **Size.** More than 1,750,000 B closes the socket with 1009.
2. **Envelope pairing.** `sha256HexSync(update) === pending.payloadDigest`.
3. **Empty skip.** `[0,0]` or zero bytes: no append. An enveloped frame gets a `noop` ack.
4. **Candidate dedupe.**
   - Look up `vault_candidate_receipts(body, device, candidateId)`.
   - Same digest: re-ack with the stored receipt (`deduped: true`).
   - Different digest: send `BODY_UPDATE_REJECTED`.
5. **Authority.** `validateActorCached` (`vaultDocumentStore.ts:1047`). The cache is keyed by the full actor tuple and
   invalidated by `authorityVersion`, which every in-process authority writer bumps (revoke, membership, authority
   fence). The TTL is 5 s. Failure closes with 4403.
6. **Budget.** A per-socket token bucket:
   - 256 KiB/s
   - burst `max(1 MiB, 1.75 MB)`, clamped so that any legal frame can pass **(WIP)**
   - empty bucket: `VAULT_BACKPRESSURE`, then 1013
7. **Optional micro-batch** (`YAOS_RELAY_MICROBATCH_MS`, default 0, max 50). Frames are queued per body, and the
   batch is merged with `mergeUpdateBytes` at commit.
8. **Epoch check** against the head (the merged cache revalidates against the head row). A mismatch sends every frame
   in the batch through `fenceRelaySocket` (4409).
9. **Growth cap.**
   - Merged body ≤ 256 KiB (`EXACT_MERGE_BYTES`): exact merge. The append is a no-op if and only if
     `mergeUpdates([merged, update])` is byte-equal to `merged`. The SV is exact.
   - Larger bodies: the append is a no-op only if the update is byte-identical to the last update (≤ 64 KiB kept).
     The next SV is the pointwise max of the head SV and the update's SV.
   - A no-op is acked `noop: true` and writes no rows.
10. **Currentness (D6 #7).** The newest paired envelope whose `stateVector` equals the next merged SV contributes
    `contentHash`/`size`. Otherwise the catalog hash is NULL.
11. **One `transactionSync`**, `appendRelayBodyUpdate`:
    - read `vault_document_heads`: exists, epoch == expected
    - read the latest `vault_catalog_events`: `active`, `file_id` matches, no `vault_creation_candidates` row
    - `UPDATE vault_clock SET sequence = sequence + 1 RETURNING sequence`
    - `INSERT vault_journal (…, 'body', bytes)`
    - N × `INSERT vault_mutation_attribution` (one per frame)
    - `UPDATE vault_document_heads SET generation = generation + 1, latest_sequence = seq`
    - `INSERT vault_catalog_events (…, content_hash|NULL, size|NULL)`
    - 0–N × `INSERT vault_candidate_receipts … ON CONFLICT DO NOTHING`

    Measured on coresmoke with a candidate receipt: **11 CF rowsWritten per append**, index writes included.
12. **After commit only**, in this order:
    1. update the merged cache entry
    2. `syncDocumentCache`, which applies the update through ywasm to a resident base-path doc if one is loaded (G5)
    3. origin `BODY_COMMITTED`
    4. peer fan-out of the same bytes, at the same epoch, excluding the origin
    5. `notifyBodyCommitted`
    6. arm the checkpoint alarm if the tail is ≥ 50 rows or ≥ 1 MiB
13. **On a commit exception:** `VAULT_ERROR durability_failed`, close 1011, invalidate the cache. The client resends
    on reconnect, and the growth cap or the receipt deduplicates the resend.

The relay writes the same row set that base writes per debounced flush (flag-tests.md). What changes is how often:
once per frame instead of once per 250 ms window per body.

### 4.5 Step1/step2, catch-up, bootstrap, currentness

- **Step1.** The server sends step1 with the head SV at accept. A client step1 gets
  `step2 = diffUpdateV1(merged, clientSV)` from stored bytes (ywasm stateless op, patch 0003,
  `crdt/ywasmByteOps.ts`). No document is created.
  - Merged bytes are cached. They are rebuilt with `durableMergedBytes` (latest checkpoint plus journal rows after the
    checkpoint, up to the head, merged). The rebuild throws if the journal crosses an epoch without a checkpoint.
  - **(WIP)** Above `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` (9 MiB) the server does not merge. It sends the stored parts
    as one step2 per part (`replyStep2Unmerged`), and clients merge idempotently.
- **Catch-up** (`POST /catch-up`) and **GET body** use `relay.bodyHttpState`: merged bytes plus the catalog hash.
  - If the catalog hash is NULL and the body is ≤ `lazyHashMaxBytes` (3 MiB, **WIP**), the server materialises it
    once: `reconstructDocument` (a ywasm Doc) → `readText("body")` → canonical Markdown → sha256 →
    `backfillCatalogHash` (UPDATE only while the hash is still NULL).
  - Above that size the hash state is `unknown`.
  - An over-budget body returns 413 `relay_merge_budget_exceeded` **(WIP)**.
- **Bootstrap.** With the flag on, the WIP `bootstrap.ts` serves `durableMergedBytes(bodyId, boundarySequence)` as a
  byte merge, and returns 413 over budget. The committed protocol doc (e1abb36) still says bootstrap is unchanged
  (`reconstructDocument`). **This RFC describes the WIP byte-merge behaviour.**
- **Currentness.** `BODY_CURRENTNESS_QUERY` and `HEAD /body/:id` read the head row and the catalog, with no merge and
  no document. The hash may be `unknown`.

### 4.6 Checkpoints

- Trigger: an append pushes the tail to ≥ 50 rows or ≥ 1 MiB, which arms the alarm.
- `alarm()` → `listJournalCheckpointCandidates(50, 1 MiB, 25)`. For each relay body that is not dirty in the base
  cache, it calls `relay.checkpointBody`.
- `checkpointBody`:
  - If the tail is more than 200 rows, it merges only the first 200 (`tailPrefixSequence`) and writes a **partial**
    checkpoint (`writeRelayCheckpointThrough`, `requireExactHead = false`). Otherwise it writes an exact-head
    checkpoint (`writeCheckpointFromEncodedState`).
  - Merges happen only through the stateless byte ops. **(WIP)** Past the 9 MiB merge budget the body is skipped and
    marked `overBudget` (in memory) until a client reset.
- `persistCheckpoint` runs as one transaction:
  1. write the chunks and the manifest
  2. `assertActivePinRetainedCheckpointCapacity`
  3. delete journal rows ≤ `min(through, journalFloor())`
  4. `pruneUnpinnedDocumentHistory`
- The alarm re-arms immediately while a checkpoint is partial or still needed. It also prunes candidate receipts.
- The base `maintain()` / `writeLiveCheckpoint` path routes relay bodies to the same function.

### 4.7 Receipts

- A receipt is the origin `BODY_COMMITTED` for an enveloped frame. It is sent only after the transaction commits.
- It carries `vaultSequence` and `durableGeneration`, plus `candidateId`/`candidateDigest` when the frame had them.
  The same row lands in `vault_candidate_receipts`, so an HTTP candidate replay or a socket resend of that candidate
  resolves to the same receipt.
- D7: `src/sync/vaultSync.ts` is not modified in this spike. The harness implements socket-ack receipts
  (`scripts/relay2/lib/socketReceipts.ts`).
- Integration sketch:
  - `VaultSync.create({ webSocket })` receives a WebSocket factory, and the relay wrapper's `send()` injects the
    envelope before each binary update. `sync/fencedWebSocket.ts` is the natural home.
  - The candidate observer maps each IDB candidate to `candidateId = candidate id`, `candidateDigest = candidate
    digest` and `clientFrameId`.
  - The candidate is cleared on the relay `BODY_COMMITTED` whose `candidateId` and `candidateDigest` match. The HTTP
    POST remains the fallback after a socket loss.

### 4.8 Budgets

| Budget | Default | Enforced at |
|---|---|---|
| Frame size | 1,750,000 B | `handleSyncFrame` (close 1009) |
| Per-socket rate / burst | 256 KiB/s; burst `max(1 MiB, 1.75 MB)` (WIP clamp) | `consumeTokens` (close 1013) |
| Relay + semantic sockets per vault | 5,000 | `acceptRelayBody` (429) |
| Merged-bytes cache | 16 MiB LRU | `remember` |
| Exact-merge threshold | 256 KiB | `commitFrames` |
| Checkpoint trigger / rows per pass | 50 rows or 1 MiB / 200 | alarm, `checkpointBody` |
| Merge input budget | 9 MiB (WIP) | `durableMergedBytes(…, maxMergeInputBytes)` |
| Lazy-hash materialisation | ≤ 3 MiB (WIP) | `bodyHttpState` |
| Lease TTL | 120 s default, 1–600 s | `acquireLease` |
| Reset cooldown | 24 h (WIP) | `acquireLease`, `semanticReset` |
| Reset snapshot | JSON ≤ 8 MiB (`MAX_CATCH_UP_BYTES`); octet-stream ≤ `RELAY_MAX_RESET_SNAPSHOT_BYTES` (WIP) | `readResetInput` |

### 4.9 Semantic reset lease

Only clients can do history GC, because it needs a fresh `Y.Doc` built from the text.

**Acquire.** `POST …/compaction-lease` with `{expectedEpoch, ttlMs}`. `RelayBodyStore.acquireLease` runs one
transaction:
1. the head exists
2. its epoch equals `expectedEpoch`
3. the cooldown has elapsed since `last_compacted_at` **(WIP)**
4. no other device holds an unexpired lease
5. upsert the lease

Responses:
- 200: `leaseId`, `expiresAt`, `epoch`, `headSequence`, `generation`, `stateVector`, `policy` **(WIP)**
- 409: `held` or `epoch_mismatch`
- 404: `not_found`
- 429: cooldown, with retry-after **(WIP)**

`{release: leaseId}` deletes the lease row for the same device.

**Build (client).** The client builds a lineage-fresh doc from the current text (K2). It optionally pulls
server-sourced state after taking the lease.

**Install.** `POST …/semantic-reset`, as JSON with a base64 snapshot or, **(WIP)**, as octet-stream with the
`x-yaos-lease-id`, `-expected-epoch`, `-covered-sequence`, `-content-hash` and `-content-bytes` headers. Checks:
1. `snapshotStructurallyValid`: 2 B ≤ size ≤ limit, the SV parses, and the SV is non-empty unless `contentBytes = 0`
   **(WIP)**. This replaced the committed `snapshotCoversHead`, which rejected every lineage-fresh reset.
2. The lease `lease_id` and `device_id` match; it is unexpired; its epoch equals the head epoch, which equals
   `expectedEpoch`.
3. `coveredSequence === head.latest_sequence` exactly.
4. Cooldown **(WIP)**.
5. `semanticResetFromEncodedState` runs as one transaction:
   - exact-head assert
   - refuses while a creation is pending or the lifecycle is unpublished
   - `vault_clock + 1`
   - journal row `'semantic-reset'` (0 B)
   - checkpoint chunks and manifest at the new sequence and the new epoch
   - pin capacity check
   - head CAS on (generation, epoch, sequence) → epoch + 1
   - catalog event with `COALESCE(client hash, previous)`
6. Delete the lease.
7. `discardResident`, then `fenceSemanticEpoch`: every old-epoch socket, relay included, is closed with 4409.
8. Invalidate the merged cache.

Errors: 409 for `lease_invalid`, `lease_expired`, `epoch_mismatch`, `head_advanced` and `cooldown`; 400 for
`invalid_snapshot`.

**Losers.**
- A client holding old-epoch edits gets 4409, fetches the new epoch and rebases its text intent. The spike rebase uses
  `mergeThreeWayText`, with a no-intent fast path.
- Server-side semantic compaction (`semanticCompactionRuntime.recordCommit` / `documentLoaded`) is skipped for relay
  bodies (`server.ts` `afterDurableCommit`, `afterDocumentLoaded`).

### 4.10 Revocation, epochs, runtime identity

- **Revocation.** `closeDevice` / `closePrincipal` close every socket of the device or principal with 4403, relay
  sockets included. Authority writers bump `authorityVersion`, so the next frame on any surviving socket fails
  `validateActorCached`. Pings and currentness queries re-validate too.
- **Delete.** `closeBody` closes relay sockets with 1008. The append transaction also refuses non-`active` catalog
  heads.
- **Epochs.** The ticket epoch is checked at accept (`SemanticEpochMismatchError`). The head epoch is checked on step1,
  at commit, and inside the transaction. A reset fences every old-epoch socket.
- **Runtime identity.**
  - `runtimeEpoch` is random per `VaultRuntime` construction.
  - Relay attachments keep their admission epoch. `message()` does not apply the runtime-epoch mismatch close to
    relay attachments with the same vault ID and generation (`vaultSocketService.ts` ~L749).
  - Receipts carry both the admission `runtimeEpoch` and `commitRuntimeEpoch`.
  - Durability does not depend on the runtime. The receipt is issued after `transactionSync`, and a runtime restart
    only loses in-memory state: pending envelopes, the rate buckets, micro-batch queues, and the cache.

## 5. What moves where

| Responsibility | Today (base) | Relay | Rationale |
|---|---|---|---|
| Body frame admission | Resident ywasm doc plus validation mirror doc per body (`vaultDocumentCache.ts`); `bodyUpdateAdmissionError` (frontmatter root shape, 5 MB Markdown cap) | Byte cap, epoch, authority, rate. No document. | The Wasm envelope was what capped sockets at 32 and cost 19 ms on heavy notes. |
| **Body content validation** | Server, before persistence | **Receiving clients, before their disk write. Owned elsewhere; out of scope for this spike.** | Disk is the truth and the client owns it. The server cannot validate once E2EE exists. |
| Persistence timing | 250 ms throttled flush (`scheduleFlush` → `flushDocument` → `commitUpdate`) | Synchronous append per frame (optional ≤ 50 ms micro-batch) | Removes ≈ 250 ms of latency. Costs more appends per keystroke (section 9). |
| Ordering | `vault_clock` per flush | `vault_clock` per append | Unchanged meaning. |
| Attribution | Per flush | Per frame (N rows per append) | More precise. |
| Broadcast | After flush commit, from the resident doc | After append commit, same bytes | Invariant 1 is preserved. No re-encoding. |
| **Candidates (second write path)** | Every edit is also an IDB candidate POSTed over HTTP, cleared by `DurableReceipt` | The socket ack is the receipt (same row in `vault_candidate_receipts`). The HTTP POST becomes a fallback only after socket loss. The creation-candidate fence stays on HTTP. | Removes one Worker request plus a DO hop per burst, and a second journal write of the same bytes. |
| Step1/step2 | ywasm doc `encodeStateAsUpdate(sv)` | `diffUpdateV1` on stored bytes | No document. K3: 0.26–14 ms for 1–10 MB. |
| Catalog hash / size | Computed by the server from the doc on every flush | Client-claimed in the envelope and accepted only when the claim SV equals the merged SV. Otherwise NULL, then lazily materialised on read (≤ 3 MiB). | The server does not read plaintext on the hot path. |
| Routine checkpoint | `maintain()` via a ywasm doc | Byte merge through the stateless op (alarm, ≤ 200 rows per pass) | Plaintext structure is not interpreted. Bounded CPU. |
| **Semantic compaction (history GC)** | Server (`semanticCompaction*.ts`, fresh doc + epoch bump) | **A client under a lease** builds and uploads; the server CASes the epoch | Only clients can compact past the 96 MiB Wasm cap (the 5m fixture traps on the server). Required for E2EE. |
| Catch-up / GET body | Reconstruct doc or resident doc | Merged stored bytes (+ lazy hash) | No document except the lazy-hash fallback. |
| Bootstrap | `reconstructDocument` | Byte merge through the boundary sequence (WIP) | Same. |
| Currentness / HEAD | Head + catalog | Head + catalog; the hash may be `unknown` | Unchanged, plus an explicit hash state. |
| Hibernation survival | Base closes with 1008 after eviction (runtime-epoch fence) | Relay socket survives | Idle product shape. |
| Revocation, membership, namespace, lifecycle, root doc | Authoritative server | **Unchanged**, authoritative server | Authority lives in the namespace. |
| Canvas semantic documents | Server-validated semantic docs | **Unchanged** | Out of scope. |
| Rate limiting | Cache pressure and backpressure | Per-socket token bucket, then 1013 | Explicit budget. |
| Socket cap | 32 (memory envelope) | 5,000 (config) | Bytes, not docs. |

## 6. Invariants

| # | Invariant | How it is enforced | Code | Gaps |
|---|---|---|---|---|
| 1 | No edit is broadcast to peers before its append transaction commits. | Fan-out (`broadcastRelayUpdate`) and `BODY_COMMITTED` are called only after `appendRelayBodyUpdate` returns. The commit path is synchronous, so no interleaving is possible. | `relayBodies.ts` `commitFrames` (step 7) | none found |
| 2 | Every append has exactly one vault sequence, and the feed returns it after the cursor. | `vault_clock` is bumped inside the same transaction as the journal insert; the sequence is the journal PK. | `relayBodyStore.ts` `appendRelayBodyUpdate` | A reset uses one sequence as well. Feed retention: G1. |
| 3 | A returned receipt means the bytes are durable. | The origin ack is sent after `transactionSync`. A dedupe re-ack reads a committed receipt row. A no-op ack means the bytes are already contained in durable state. | `commitFrames`, `ackOrigin`, `ackNoop` | Incremental-SV no-op for large bodies only matches identical bytes, which is safe. |
| 4 | A revoked device's frames after the fence sequence are never appended. | Sockets are closed with 4403 on revoke. `validateActorCached` runs on every frame: `authorityVersion` is bumped synchronously by the writer, and the 5 s TTL applies only to cross-isolate changes. | `vaultSocketService.ts` `closeDevice`; `vaultDocumentStore.ts` `validateActorCached` | **G2:** with micro-batching > 0, authority is checked at enqueue, not at commit. **G6:** step1 replies are not re-checked. **G19:** reset uploads authorize once, before a body read that may take minutes. |
| 5 | Old-epoch frames are never appended after an epoch bump. | Ticket epoch at accept. Head epoch before commit. `expectedEpoch` inside the transaction. `fenceSemanticEpoch` closes old sockets on reset. | `commitFrames`; `appendRelayBodyUpdate`; `relayRoutes.ts` `handleSemanticReset` | **G3:** a micro-batch fences on the first frame's epoch. Pending batches are not dropped on reset. The transaction check still prevents an old-epoch append. |
| 6 | Flag off means baseline behaviour. | Every relay branch is gated on `this.relay !== null` / `relayBodiesEnabled`. | `server.ts`, `vaultSocketService.ts`, `bootstrap.ts` | Measured: 199/199 flag-off steps, 0 new failures (`flag-tests.md`). |
| 7 (D6) | A catalog content hash is recorded only if the claimant's SV equals the merged SV after the append. | `stateVectorsEqual(envelope.stateVector, nextStateVector)`. Otherwise NULL. | `commitFrames` step 6 | **G8:** above 256 KiB, `nextStateVector` is a pointwise max, which can overstate state for updates with causal gaps. The hash is also unverified client data (G10). |
| 8 (added) | Idempotent retries: one append per (device, candidateId); the same receipt is returned. | Receipt lookup before append; `ON CONFLICT DO NOTHING` inside the transaction. | `handleSyncFrame` step 2; `appendRelayBodyUpdate` | **G7:** the dedupe runs before the authority check. **G11:** within one micro-batch, duplicate candidate IDs are not detected. |
| 9 (added) | The server never calls into Wasm with more than the merge budget of input. | `durableMergedBytes(…, maxMergeInputBytes)` throws `RelayMergeBudgetError` before merging. The lazy hash is capped at 3 MiB. | `vaultDocumentStore.ts` `durableMergedBytes`; `relayBodies.ts` `bodyHttpState` (WIP) | **G5:** `syncDocumentCache` applies to a resident doc with no budget check. That doc already fits the base envelope. |
| 10 (added) | A checkpoint never loses a journal row: journal rows are deleted only in the same transaction that writes a checkpoint covering them, and never above the feed floor. | `persistCheckpoint` deletes `≤ min(through, journalFloor())` inside the checkpoint transaction. | `vaultDocumentStore.ts` `persistCheckpoint` | Safe, but G1: the floor may never advance in relay-only workloads. |
| 11 (added) | At most one semantic reset per epoch. | Lease upsert is one transaction. Reset requires the lease, an epoch CAS, the exact head sequence, and a head CAS inside `semanticResetFromEncodedState`. | `relayBodyStore.ts` `acquireLease`, `semanticReset` | Measured: B5 6/6, exactly one install per race. |

## 7. Failure modes

| Case | What happens | Residual risk |
|---|---|---|
| **A client bug writes bad bytes** (malformed or structurally wrong Yjs, bad frontmatter root) | The server does not parse structure on the hot path, so it appends any update of 1.75 MB or less. Malformed bytes can make the next `mergeUpdates` or `diffUpdate` throw. That means step1, checkpoint or HTTP read failures for that body only. The error is caught per body, the alarm re-arms, and the body stays checkpoint plus tail. Semantically wrong but valid updates, such as a bad frontmatter shape, propagate to peers. Receiving-client validation (owned elsewhere) must refuse to write them to disk and surface a conflict. Recovery: a client semantic reset from good text (lease) replaces the lineage, and the history is kept per retention and pins. | Until receiving-side validation ships, relay mode loses today's server-side frontmatter/root-shape gate. The failure is per body and does not spread to the vault. There is no poison-pill quarantine yet (open question Q3). |
| **The lease holder dies** | The lease expires after its TTL (120 s default). No state changed, because reset is a single transaction at install. Another device can acquire the lease after expiry. The holder can release early. | A lease held by a revoked device blocks others until the TTL (G19). |
| **Two resets race** | The lease upsert serialises them: the second device gets 409 `held`. If a lease expires mid-upload (B5: 5 MB upload at 115.7 s), `lease_expired` rejects the install. At install, the epoch CAS plus `coveredSequence == latest_sequence` plus the head CAS let exactly one win. The losers' sockets get 4409 and they rebase. | Measured B5: 6/6, alternating winners. Starvation risk: R2. |
| **DO crash mid-append** | `transactionSync` is atomic: either all rows (clock, journal, attribution, head, catalog, receipt) or none. No ack or broadcast happens before commit. On crash the socket drops, the client reconnects and resends (step2), and the growth cap or receipt deduplicates. | An in-memory micro-batch is lost, but it was never acked (G2/G3 aside). |
| **DO crash mid-checkpoint** | `persistCheckpoint` is one transaction: chunks, manifest, journal deletes and prune together. After a crash either the old checkpoint plus the full tail remains, or the new checkpoint with the tail pruned. The alarm re-runs. A partial checkpoint (≤ 200 rows) is itself a complete, consistent checkpoint through its sequence. | none found |
| **Log growth while all devices are offline** | Without appends no alarm is armed, so nothing grows. With one writer and no readers, each append arms the checkpoint at 50 rows or 1 MiB, so the merged snapshot stays bounded by live size plus tombstones. Journal rows below the checkpoint are deleted only up to the feed floor. | **G1**: relay appends do not trigger `maintain()`, so the feed floor may never advance and journal rows are never deleted. Over-budget bodies (> 9 MiB merged input) are never checkpointed until a client reset (WIP). |
| **Mobile-only vault** | The routine checkpoint is server-side, so no client is needed. Reset is feasible on phones: K2 inferred 48–586 ms build, duty-cycle bound 1.7 s p50 for 5 MB. Upload speed is the constraint: B5's 5 MB upload took 5–116 s. The lease TTL (≤ 600 s) and the octet-stream upload (WIP, avoids the 33% base64 overhead) matter here. | The exact-head CAS combined with a slow mobile upload on a hot note is R2. |
| **Hibernation** | Relay attachments keep the admission `runtimeEpoch` and are exempt from the mismatch close. The merged cache rebuilds from SQL on the first frame. Measured small-n B1: the socket survives idle plus simulate-restart, with the edit propagated at 309 ms; base gets 1008 plus a ≈ 1.33 s reconnect. | Lost on wake: pending envelopes (G13, the next echo is unenveloped), rate buckets (they refill), micro-batch queue (unacked). |
| **Revoked device with an offline queue** | On reconnect the ticket issue fails, because the control plane rejects the revoked credential. If a socket survived, the first frame fails `validateActorCached` with 4403. Queued edits never append. Attribution rows record device and credential revision for anything appended before the revocation. | The revoked user's local edits stay local by design. Candidate dedupe re-acks old receipts before the authority check (G7): no append, just a small information leak of receipt fields. |
| **Malicious member** (valid credential, hostile client) | Rate limit (1013) and frame cap bound flooding. A malicious member can: append arbitrary valid Yjs, which propagates, just as with base once server validation is gone; claim false content hashes that equal the merged SV (the server cannot verify, G10), poisoning catalog hashes and currentness until the next honest claim; take the lease and install a reset with arbitrary text (the history is kept per retention; the reset is attributable); and hold leases to block resets. | Same trust model as today for members: members can write content. Hash poisoning (G10) is new: today the server computes hashes. Mitigation options: receiving clients verify hashes and report mismatches; the server re-hashes on the lazy path whenever a hash is disputed. |

## 8. Measurements

Dates, Workers, deploy version IDs and spike SHAs come from each run's JSON metadata (see the index in section 14).
Base means the same branch with the flag off. All runs use the same knobs, and the only difference is
`YAOS_RELAY_BODIES`.

### 8.1 Latency

| ID | Metric | Base p50 / p90 / p99 | Relay p50 / p90 / p99 | n | Notes |
|---|---|---|---|---|---|
| L1 | ping RTT | <<MEASURED: L1 base>> | <<MEASURED: L1 relay>> | 100 | floor |
| L2 | propagation (+ origin ack) | <<MEASURED: L2 base>> | <<MEASURED: L2 relay>> | 300 | small n: 412 vs 90 ms p50 (scratch / scratch-3) |
| L3 | propagation on 64k chars, before / after the quick trace | <<MEASURED: L3 base>> | <<MEASURED: L3 relay>> | 50 + 50 | |
| L4 | per-frame at 25 edits/s | <<MEASURED: L4 base>> | <<MEASURED: L4 relay>> | 5,000 | small n: 293 vs 116 ms p50 |
| L5 | edit → cleared receipt (HTTP candidate vs socket ack) | <<MEASURED: L5 base>> | <<MEASURED: L5 relay>> | 100 | small n base 531 ms (D8) |
| L6 | open → synced, cold / warm | <<MEASURED: L6 base>> | <<MEASURED: L6 relay>> | 100 each | |
| L7 | HEAD/GET visible + hash matches client | <<MEASURED: L7 base>> | <<MEASURED: L7 relay>> | 100 | |

### 8.2 Server cost

| ID | Metric | Base | Relay | n / source |
|---|---|---|---|---|
| C1 | CPU per keystroke, small / heavy (tail cpuTime p50/mean) | <<MEASURED: C1 base>> | <<MEASURED: C1 relay>> | ≥ 40 each; the tail is lossy (R6) |
| C2 | CPU per update, quick trace; stress trace (50k edits, 5 clients) | <<MEASURED: C2 base>> | <<MEASURED: C2 relay>> | gql aggregate |
| C3 | Wasm linear memory / resident docs at 1, 8, 32, 100 bodies; 32 × 512 KiB | <<MEASURED: C3 base>> | <<MEASURED: C3 relay>> | v1: base +36 MB, relay flat (A5) |
| C4 | rows written per edit / per reconnect | <<MEASURED: C4 base>> | <<MEASURED: C4 relay>> (coresmoke: 11 per append incl. receipt) | debug table counts |
| C5 | DO requests per edit burst / per catch-up (20:1) | <<MEASURED: C5 base>> | <<MEASURED: C5 relay>> | derived |
| C6 | bundle raw / gzip KiB; startup ms | <<MEASURED: C6 base>> | <<MEASURED: C6 relay>> | measured K3: 2,541.45 / 611.11 KiB with patch 0003 (+3,358 B raw / +379 B gzip) |

### 8.3 Behaviour

| ID | Pass criteria | Base | Relay |
|---|---|---|---|
| B1 | socket survives hibernation and restart | <<MEASURED: B1 base>> (small n: 1008 + ≈ 1.33 s reconnect) | <<MEASURED: B1 relay>> (small n: survives, 309 ms) |
| B2 | catch-up after 50 / 5,000 edits: time, bytes, rows scanned, text equal | <<MEASURED: B2 base>> | <<MEASURED: B2 relay>> |
| B3 | bootstrap of 100 notes (20 relay-edited) | <<MEASURED: B3 base>> | <<MEASURED: B3 relay>> |
| B4 | revocation mid-stream: 4403 ≤ 1 s, no append after the fence | <<MEASURED: B4 base>> | <<MEASURED: B4 relay>> |
| B5 | reset race: one install, zero lost edits | n/a | measured: 6/6 pass (`B5-2026-09-29T20-16-32-720Z.json`) |
| B6 | 3× resend → one append, same receipt | <<MEASURED: B6 base>> | <<MEASURED: B6 relay>> |
| B7 | 5 MiB/s flooder → 1013; victim L2 within 20% | <<MEASURED: B7 base>> | <<MEASURED: B7 relay>> (small n: 1013, victim flat) |
| B8 | delete with sockets open | <<MEASURED: B8 base>> | <<MEASURED: B8 relay>> |

### 8.4 Limits

| ID | Metric | Base | Relay |
|---|---|---|---|
| X1 | max concurrent body sockets (100 → 2,000) | <<MEASURED: X1 base>> (small n: 429 at #33) | <<MEASURED: X1 relay>> (small n: 100 OK) |
| X2 | max sustained append rate, 1 body / 10 bodies | <<MEASURED: X2 base>> | <<MEASURED: X2 relay>> |
| X3 | largest note for step2 and checkpoint (1 / 5 / 10 MB) | <<MEASURED: X3 base>> | <<MEASURED: X3 relay>> |
| X4 | catch-up of 100 bodies × 50 edits stale | <<MEASURED: X4 base>> (A3: 676 ms) | <<MEASURED: X4 relay>> |

### 8.5 Compaction

| ID | Metric | Value |
|---|---|---|
| K1 | alarm merge at tails of 50 / 500 / 5,000: ms, memory, rows before and after | <<MEASURED: K1>> |
| K2 | reset build (desktop, measured, n = 10): 100k 12 ms, 1m 26 ms, 5m 98 ms, stress 14 ms p50; mobile-class inferred ×4–6: 48–586 ms (duty-cycle bound 1.7 s / 2.7 s p50/p90 for 5m); upload ≈ live size + 120 B; 5m peak heap 176 MiB | measured / inferred (K2.md) |
| K2-upload | deployed upload p50: 100k 395 ms, 1m 1.08 s, 5m 5.0 → 20.9 s, then `lease_expired` at 115.7 s | measured (B5) |
| K3 | stateless byte ops (c) vs transient doc (a) vs JS yjs (b): merge (c) ≈ 2.5× faster than yjs and super-linear (50k frames: 4.4 s vs 12.8 s); SV/diff 0.26 ms quick, 1.2 ms 1 MB, 6.7 ms 5 MB, 14 ms 10 MB; Wasm high-water ≈ 4–5× merged size for merge | measured (K3.md, Node, not workerd) |

### 8.6 v1 projections: did they hold?

| Projection (v1, A5) | v1 evidence | v2 measured | Held? |
|---|---|---|---|
| 10–50× less memory | 32 × 512 KiB: +36 MB base vs flat relay | <<MEASURED: C3 ratio>> | <<MEASURED>> |
| 30–100× more concurrent notes | 100/100 vs 429 at #33 | <<MEASURED: X1 ceiling / 32>> | <<MEASURED>> |
| 3–5× faster propagation | 300 → 52 ms | <<MEASURED: L2 base / relay>> (small n: 412 / 90 ≈ 4.6×) | <<MEASURED>> |
| 30–100× less CPU on heavy notes | 19 ms → < 1 ms | <<MEASURED: C1 heavy ratio>> | <<MEASURED>> |
| Near-zero idle cost | hibernation survives | <<MEASURED: idle DO requests/day, C5 + B1>> | <<MEASURED>> |

### 8.7 Convergence

For each scenario, A, B and a fresh C have identical text and state vectors, the server GET equals the client text,
and the recorded hash equals the client's canonical hash.

| Scenario | Pass/fail |
|---|---|
| L2 | <<MEASURED: conv L2>> |
| quick trace | <<MEASURED: conv quick>> |
| stress trace | <<MEASURED: conv stress>> |
| B2 | <<MEASURED: conv B2>> |
| B3 | <<MEASURED: conv B3>> |
| B5 | pass (6/6) |
| B6 | <<MEASURED: conv B6>> |
| X1 sample | <<MEASURED: conv X1>> |

## 9. Cost model

Workers Free limits were checked on 2026-09-30 in the Cloudflare docs
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).

| Limit (Workers Free) | Value | Note |
|---|---|---|
| DO requests | 100,000 / day | Counts HTTP requests, RPC sessions, WebSocket messages and alarm invocations. Incoming WS messages are billed at **20:1**; outgoing messages and protocol-level pings are free. Exceeding any free limit makes further operations of that type fail until 00:00 UTC. |
| DO duration | 13,000 GB-s / day | Hibernatable idle is not billed. |
| SQLite rows written | 100,000 / day | **Index writes, deletes and `setAlarm()` each count as rows written.** |
| SQLite rows read | 5,000,000 / day | |
| SQLite storage | 5 GB total (1 GB per object on Free, per the FAQ) | |
| DO CPU per request | 30 s default (same table for both plans); resets per incoming request or WS message | The Workers Free Worker limit is 10 ms CPU per request; that applies to the Worker entry, not the DO. The enterprise account differs only in configurable DO `cpu_ms`. |
| Memory | 128 MB per isolate (JS heap + Wasm) | The 96 MiB ywasm cap sits inside this. |
| Worker requests | 100,000 / day | HTTP and WS upgrades; WS messages are not Worker requests. |
| Max SQL row / BLOB | 2 MB | This is why `MAX_DURABLE_UPDATE_BYTES` is 1.75 MB. |

The calculator is `scripts/relay2/costmodel.py`. Every input is a named parameter with a provenance tag, and it
reruns with measured values (`--set name=value` or `--json`). Output with the current defaults (**inferred**, not
measured; to be re-run with C4/C5):

| Day shape | Mode | DO req/day | % free | Worker req/day | % free | Rows written/day | % free | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| idle | base | 1,056 | 1% | 0 | 0% | 0 | 0% | 12 sockets, 21,120 WS msgs |
| idle | relay | 1,056 | 1% | 0 | 0% | 0 | 0% | 12 sockets, 21,120 WS msgs |
| typical | base | 2,300 | 2% | 342 | 0% | 89,676 | 90% | 9,000 frames, 7,200 appends, 180 POSTs, 144 ckpts |
| typical | relay | 2,648 | 3% | 60 | 0% | 118,620 | 119% | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| typical+import | base | 5,000 | 5% | 2,742 | 3% | 159,676 | 160% | +2,000 notes |
| typical+import | relay | 5,648 | 6% | 2,460 | 2% | 190,620 | 191% | +2,000 notes |

| Mode | Rows per typing-second | Typing hours/day to hit 100k rows (excl. idle) |
|---|---:|---:|
| base | 49.8 | 0.56 |
| relay | 65.9 | 0.42 |

Assumptions:
- 3 devices, 4 sockets each.
- 60 s pings and 270 s ticket refreshes (A1).
- A typical day is 2 h of editing summed across devices, at 25% typing duty and 5 frames/s.
- 10 s bursts, one candidate per burst on base.
- 10 rows per base flush, 11 per relay append (coresmoke), 11 per base candidate commit (assumed).
- Checkpoint: 8 fixed rows plus 2 rows (row + index) per pruned journal row.

Reading the model:
- **Idle cost is equal, and small (≈ 1% of DO requests)** once phase 0 made pings survive. Before phase 0 it was
  ≈ 160k/day (A1). The relay's extra benefit is not reconnecting after eviction (B1); in base those reconnects appear
  on the first edit, not while idle.
- **Rows written, not requests, is the binding free-tier limit for both modes.** Under these assumptions:
  - A typical editing day uses 90% (base) and 119% (relay) of 100k rows/day.
  - Base gains from its 250 ms flush window (at most 4 appends/s per body). The relay appends once per frame.
  - At 5 frames/s the relay writes ≈ 1.3× base rows; at 8 frames/s ≈ 2×.
  - Relay micro-batching up to its 50 ms maximum does not help at typing cadence (frames ≈ 200 ms apart).
- **What moves the relay under the limit** (each can be checked with the calculator):
  1. Drop the per-append catalog event when the hash is unknown, and the attribution row for single-frame appends
     (≈ −3–4 rows).
  2. Client-side coalescing of frames into ≤ 4/s during continuous typing.
  3. Micro-batch windows of 200–250 ms, which trade back part of the latency win.
  4. Relay mode eliminates the base candidate commit (180 POSTs × 11 rows ≈ 2k rows/day in this model; larger if
     candidates are per edit rather than per burst).
- **The heavy import** is dominated by lifecycle rows (`import_rows_per_note`, assumed 25). Both modes exceed the free
  budget on an import day. An import of about 3,000 notes or more is a two-day operation on Free in either mode.
- G1 changes this: the model charges 2 rows per pruned journal row, but if the floor never advances nothing is pruned
  (fewer rows written, unbounded storage).

To fill:

| Input | Placeholder |
|---|---|
| `relay_rows_per_append`, `base_rows_per_flush`, rows per reconnect | <<MEASURED: C4>> |
| DO requests per burst and per catch-up | <<MEASURED: C5>> |
| `checkpoint_fixed_rows`, rows per checkpoint | <<MEASURED: K1 rows before/after>> |
| `base_candidate_rows` | <<MEASURED: C4 base with the real VaultSync candidate path (L5 script)>> |
| `frames_per_typing_s` | <<MEASURED: L4 trace frame rate / real editor capture>> |

## 10. E2EE compatibility

Goal: relay mode should need plaintext CRDT structure only in removable, optional server paths. The table lists every
relay-mode server operation that reads update bytes as more than opaque blobs.

| Operation | Where | Needs | Moves to clients how |
|---|---|---|---|
| **Checkpoint byte merge** (`mergeUpdatesV1`) | alarm → `checkpointBody` → `durableMergedBytes` | Plaintext CRDT structure (it parses structs and IDs) | A client under a lease uploads an encrypted snapshot covering sequence S. The server stores it as an opaque checkpoint and prunes the journal ≤ S (the same row shape as reset without the epoch bump). Mobile-only is fine because the lease is available to any device. |
| **Lazy hash materialisation** (`reconstructDocument` → `readText` → sha256) | `bodyHttpState` (GET, catch-up) when the catalog hash is NULL | Plaintext **text** (a full ywasm Doc) | Delete it. The hash comes only from client claims (the envelope). Unknown stays unknown, and HEAD already exposes `hashState`. Under E2EE the hash itself must be a keyed hash (HMAC with a vault key) so it leaks nothing. |
| **Head SV tracking** (`stateVectorFromUpdate`, `maxStateVector`) | every append (`commitFrames`), rebuild | Plaintext structure (IDs and clocks) | The client sends its post-update SV in the envelope (it already does for D6). Under E2EE the SV is metadata the client chooses to reveal. Either accept the SV leak (client IDs and clock counts, no content) or have the server track only sequences, with step1 answered by "all rows after the client's last seen sequence". |
| **Step2 diff** (`diffUpdateV1(merged, clientSV)`) | step1 reply | Plaintext structure | Replace SV-based diff with sequence-based catch-up: the client sends its last durable sequence and the server returns checkpoint + rows > seq as opaque blobs, which is already how `replyStep2Unmerged` works (WIP). Costs more bytes; no crypto change. |
| **Growth-cap no-op test** (exact merge equality) | `commitFrames` ≤ 256 KiB | Plaintext structure | Drop it and rely on client idempotence: receipts via candidateId, and clients skip resends whose SV is already covered by the last acked SV. The large-body identical-bytes test works on ciphertext only if encryption is deterministic, which it should not be. |
| **Micro-batch merge** (`mergeUpdates(live…)`) | `commitFrames` when batch > 1 | Plaintext structure | Store the frames as separate journal rows in one transaction (N journal rows, one sequence each) or disable micro-batching. |
| **Bootstrap / catch-up / GET byte merge** | `durableMergedBytes` | Plaintext structure | Serve checkpoint + tail parts unmerged (opaque); the client merges. |
| **Merged-bytes cache** | `MergedEntry` | Opaque storage of plaintext merged state | Disappears with the merges. |
| **`syncDocumentCache`** (applies to a resident base doc) | after append | Plaintext structure (ywasm) | Delete it together with the base body path (section 11). |
| **Reset structural check** (`snapshotStructurallyValid`: SV parse) | reset route | Plaintext structure (SV parse only) | Replace with a size check plus a client-signed header. |
| **Semantic reset** | client builds | None on the server (opaque install); the server trusts `coveredSequence` | Already on the client. |
| Frame size, rate, epochs, authority, receipts, sequence, attribution digests | throughout | **Opaque bytes** (length and sha256 of ciphertext) | No change. |

Classification summary:
- Opaque today: size, rate, digest, receipts, epochs, sequence, lease/reset CAS.
- Needs structure: merge, SV, diff, growth cap, micro-batch merge, reset SV parse, `syncDocumentCache`.
- Needs text: the lazy hash only.

The brief's expectation was that only the optional checkpoint and the lazy hash need plaintext. That understates it:
SV tracking and step2 diff also need structure. Each has a removal path (the envelope SV and sequence-based catch-up)
that works today with `replyStep2Unmerged`.

## 11. Migration plan

**Cutover policy (confirmed).** `docs/operations.md` says: "There is no in-place migration from any earlier schema or
storage format … A release changing any pin or required class must declare another fresh or guided cutover."

The relay keeps storage format 4, schema 8 and protocol 5. It adds one lazily created table and one capability key.
- A flag flip on an existing deployment is technically possible, because the tables mean the same thing.
- Receipts and sockets differ by mode, so the recommendation is: **flag changes only on a fresh deployment**, paired
  with a protocol-capability check in the client (`relayBodies: 2`).
- Rollback (relay → base) on the same storage is possible, because base can read relay-written journal, checkpoint
  and catalog rows, which have the same shape. It is untested and is open question Q6.

**Phases:**

| Phase | Flag / gate | Contents | Exit criteria |
|---|---|---|---|
| 0 | none | Fix G1–G3, G5, G8, G10 mitigations, G19; land WIP round 2; write-amplification reductions (section 9) | unit tests + flag-off 0 new failures |
| 1 | `YAOS_RELAY_BODIES=true`, opt-in deploy var | Server relay plus the unmodified client (unenveloped; hash via lazy path ≤ 3 MiB; HTTP candidates still clear receipts) | full-n section 8 tables; section 13 not triggered |
| 2 | client capability `relayBodies ≥ 2` | Envelope + socket-ack receipts in `VaultSync` (fencedWebSocket `send()` wrapper; candidate observer → clientFrameId/candidateId); HTTP candidate POST becomes fallback | L5 relay ≤ base; candidate clears via socket in ≥ 99% |
| 3 | client | Lease-based semantic reset in the plugin (policy + builder from `scripts/relay2/reset`), receiving-side validation (owned elsewhere) | B5 at full n; mobile-class reset in budget |
| 4 | default on, fresh-install release | Delete the base body path (below) | one release of relay-default without reversal |
| 5 (E2EE prep) | separate | Client checkpoints, sequence-based catch-up, remove the lazy hash (section 10) | |

**Code that becomes dead in phase 4** (`wc -l` on the working tree, 2026-09-30).

The root document, Canvas semantic documents and the creation-candidate fence stay on the base path, so most files
are only partly deletable.

| File | Lines | Deletable part | Estimate |
|---|---:|---|---:|
| `server/src/semanticCompaction.ts` + `…Policy.ts` + `…Runtime.ts` | 289 + 244 + 432 = 965 | Body share (Canvas keeps server compaction unless it also moves) | 350–600 |
| `server/src/vaultDocumentCache.ts` | 1,178 | Body validation mirror (`validateBodyUpdate`, `stage/discardValidatedBodyUpdate`, `rebuildValidation`), body admission and capacity (`admitBody`, `ensureBodyCapacity`, `cleanBodyCandidates`, `loadedBody*`) | ≈ 250–300 |
| `server/src/vaultSocketService.ts` | 1,372 | `bodyUpdateAdmissionError` (23) + body branch of `handleSyncFrame` validation and staging + base body step1 load | ≈ 120–180 |
| `server/src/server.ts` | 1,573 | Body share of `scheduleFlush`/`flushDocument`/`flushLoadedDocuments` (1196–1312, 1472–1476, ≈ 125); body semantic-compaction wiring; body `writeLiveCheckpoint` doc path | ≈ 100–150 (the flush path stays for Canvas) |
| `server/src/vaultCandidateService.ts` | 379 | Ordinary active-body candidate commit (the creation fence stays) | ≈ 150–200 |
| `server/src/crdt/frontmatterSemanticSnapshots.ts` + `frontmatterSemanticValidation.ts` + `shared/frontmatterSemanticValidation.ts` | 98 + 10 + 207 | Moves to receiving clients (the client already shares `shared/`) | 108 server-only |
| `vaultDocumentStore.ts` `reconstructDocument` body uses / `writeCheckpoint` via doc | (2,412) | Only after phase 5 (lazy hash) | ≈ 50 |
| **Total** | | | **≈ 1,100–1,600 server lines**, against +≈ 1,400 relay lines (`relayBodies.ts` 912, `relayBodyStore.ts` ≈ 330, `relayFlag.ts` ≈ 120, `relayRoutes.ts` ≈ 136, `ywasmByteOps.ts` 180) |

Client side:
- `src/sync/vaultSync.ts` candidate HTTP plumbing stays as the fallback. Net client code grows by the envelope,
  receipt mapping, reset policy/builder and rebase: `scripts/relay2/reset` gives an upper bound.
- The spike diff is 71 files, +9,895 lines, mostly harness and tests.

**`packages/server-node` impact.**
- The Node host runs the same `VaultRuntime` compositions, and it already reads `YAOS_RELAY_BODIES` and
  `readRelayConfig` (`packages/server-node/src/index.ts:112–114`).
- `ywasmNodeCrdtEngine.ts` (30 lines) exposes the pinned bindings, and the byte ops come from the same patched ywasm
  artifact.
- Nothing else changes: storage (`storage.ts`, 678 lines) implements the same SQL port, and `transactionSync` keeps
  the append atomic.
- The Node host has no free-tier quota. The rows-per-keystroke concern is SQLite write amplification (fsync per
  transaction) and does not block it.

**Keep ywasm for stateless byte ops, or drop it?**

| Option | Bundle | Memory | Risk | Verdict |
|---|---|---|---|---|
| Keep ywasm (status quo + patch 0003) | 2,541.45 KiB raw / 611.11 KiB gzip (Wasm ≈ 340 KB of the gzip, ≈ 55%) (K3) | Wasm high-water ≈ 4–5× merged size, per isolate, until eviction; 96 MiB cap ≈ 20 MB merged | Lone-surrogate loss only on the Doc paths (lazy hash, root/Canvas, reset probe), not on stateless ops | **Required anyway**: the root doc (lifecycle writes root operations, `vaultLifecycleService.ts`) and Canvas semantic docs still need a server CRDT. |
| Drop ywasm for bodies only (JS yjs byte ops) | yjs-only byte-ops ≈ 75 KB raw / 22.5 KB gzip, but it is **added** unless ywasm leaves entirely; `scripts/guard-server-crdt-imports.mjs` forbids `yjs` on the server | JS heap instead of Wasm; merge ≈ 2.5× slower (K3) | Two CRDT implementations on the server | Not worth it |
| Drop ywasm entirely | ≈ −585 KiB gzip | no Wasm cap | Requires root and Canvas to move off server-authored CRDT, beyond this RFC | Out of scope; revisit after E2EE phase 5 |

Recommendation: keep ywasm, restrict body use to the three stateless ops, and delete body Doc paths in phase 4 and
the lazy hash in phase 5.

## 12. Open questions and risks

Design gaps found while checking this RFC against the code are labelled **G#**. Risks are labelled **R#**.

**Gaps (verified in code unless marked):**

- **G1 — The feed floor may never advance in relay-only workloads, so the journal is never pruned.**
  - `persistCheckpoint` deletes journal rows ≤ `min(through, journalFloor())`.
  - `advanceFeedFloor` is called only from `maintain()` (after a compaction) and the admin compact route
    (`server.ts:1127`, `:1396`).
  - Relay appends do not call the store's commit observer, so `afterDurableCommit` → `maintain()` never runs for them.
  - The relay alarm loop checkpoints first, so the following `maintain()` loop sees no candidate.
  - Result: in a vault where only relay bodies change, `vault_journal` grows without bound (storage, `diagnostics()`
    `COUNT(*)`). Rebuild cost stays bounded, because rebuild reads only rows after the checkpoint.
  - Fix: advance the floor in the relay alarm path when no pins are active.
  - Verify with `/relay-table-counts` after K1.
- **G2 — Micro-batch revocation window.**
  - With `MICROBATCH_MS > 0`, authority is checked at enqueue (`handleSyncFrame` step 3), not in `commitFrames`.
  - `closeDevice` does not drop queued frames. A revocation inside the ≤ 50 ms window still commits them after the
    revocation, which violates invariant 4.
  - Fix: re-validate in `commitFrames` and drop the batch frames of closed sockets.
- **G3 — Micro-batch epoch handling.**
  - `commitFrames` uses `live[0].attachment.documentEpoch` for the whole batch, and batches are keyed by `bodyId`
    only. Frames from mixed epochs are fenced together.
  - Reset does not flush or drop pending batches. The in-transaction `expectedEpoch` still prevents an old-epoch
    append, so this is a spurious-fence bug, not a correctness hole.
- **G4 — Unenveloped clients make the lazy hash the normal path.**
  - Every frame from today's unmodified `VaultSync` has no envelope, so every catalog event gets a NULL hash.
  - Every GET or catch-up of an edited body then runs `reconstructDocument` (ywasm Doc) → `readText` → sha256, in the
    request.
  - That means plaintext, lone-surrogate exposure (R1) and Wasm memory on the read path until phase 2.
  - Bounded at 3 MiB (WIP). Above that the hash is `unknown`, which currentness and 304 logic must tolerate.
- **G5 — `syncDocumentCache` runs ywasm on the hot path** whenever the HTTP candidate path has loaded the body
  (the same body served both ways). It is outside the merge budget check.
- **G6 — No authority re-check on step1 replies.** Revocation relies on `closeDevice` closing sockets proactively,
  which it does.
- **G7 — Candidate dedupe runs before the authority check.** A revoked device can have an old receipt re-acked.
  Nothing is appended.
- **G8 — Incremental SV (bodies > 256 KiB) can overstate state.**
  - The pointwise max of the head SV and the update SV is not the merged SV when the update has a causal gap
    (pending structs).
  - D6 then accepts a hash claim that equals an overstated SV, a possible false acceptance.
  - `stateVectorDrift` counts it only at rebuild. The WIP rebuild over budget also computes the pointwise max of the
    parts and still marks it `stateVectorExact: true`.
  - For large bodies the growth cap catches only byte-identical resends, so reconnect step2 resends are appended.
- **G9 — Exact-head reset CAS starvation** (R2).
- **G10 — The server does not verify reset `contentHash` or envelope hashes.**
  - A malicious member can poison catalog hashes. The SV equality rule limits this to claims made at the head.
  - The reset hash is recorded as `COALESCE(client, previous)`.
- **G11 — Duplicate `candidateId` within one micro-batch.** The receipt insert is `ON CONFLICT DO NOTHING`, so the
  second frame silently gets the first frame's receipt semantics. Two frames with the same `candidateId` but
  different digests in one batch are not detected.
- **G12 — The committed `snapshotCoversHead` rejected every lineage-fresh reset.** Replaced in WIP by
  `snapshotStructurallyValid`. The committed `e1abb36` protocol doc still documents the old check.
- **G13 — Pending envelopes are memory-only.** Hibernation between an envelope and its frame loses the pairing: the
  frame is appended unenveloped and its hash is not accepted.
- **G14 — `vault_operation_outcomes` is not written**, so relay receipts are not visible via
  `/operations/:id/outcome`.
- **G15 — `diagnostics()` runs `COUNT(*)` over `vault_journal`.** Combined with G1 this is a full scan of an
  unbounded table (rows read count against 5M/day).
- **G16 — Multi-origin batches send `notifyBodyCommitted` to the origins too.** It is sent once with
  `excludeSocketId` only when a batch has one origin. Minor.
- **G17 — Bootstrap: committed vs WIP drift.** The doc says reconstruct; WIP uses the byte merge. This RFC describes
  WIP.
- **G18 — Write amplification.** 11 CF rows per append, index writes included (measured), against 5–6 logical rows.
  One catalog event per keystroke also grows `vault_catalog_events` and the root feed.
- **G19 — Reset and lease routes authorize once, at request start, before an async body read** that may take minutes
  (B5: 115.7 s).
  - A device revoked mid-upload can still install a reset if its lease is valid.
  - Revocation does not delete `relay_compaction_leases` rows, so a revoked holder blocks others until the TTL.
  - Fix: re-run `validateActor` inside `semanticReset`, and delete the leases of revoked devices.
- **G20 — Over-budget bodies (WIP).**
  - Above 9 MiB merged input, GET, catch-up and bootstrap return 413 `relay_merge_budget_exceeded`. A single
    over-budget note makes a batched bootstrap response fail for the whole batch.
  - `overBudgetBodies` is in memory: after eviction the alarm retries the merge, and re-marks the body only after the
    budget check throws.
  - Only a client reset recovers the body.

**Risks:**

- **R1 — Lone-surrogate data loss in ywasm Doc round-trips (K3).**
  - When an update splits a UTF-16 surrogate pair, a round-trip through a ywasm Doc drops the text after the lone
    surrogate (`x�Zy` → `x�Z`). Stateless ops and JS yjs preserve it.
  - This **affects today's authoritative path**, which applies every body update to a ywasm Doc and re-encodes step2
    and checkpoints from it. In relay mode it affects only the lazy hash (G4), root/Canvas docs and
    `syncDocumentCache` (G5).
  - Real editors rarely emit split pairs. An upstream y-crdt issue plus a regression fixture are needed independent
    of this RFC.
- **R2 — Starvation of the exact-head reset CAS.**
  - `coveredSequence === latest_sequence` fails whenever any append lands between the client's build and the install.
  - On a hot note with a slow mobile upload (5 MB: up to 116 s) the reset may never succeed.
  - Options:
    - a short-lived append pause for the body during install: the lease blocks appends for ≤ N s, and the server
      returns backpressure
    - a covered-sequence rebase: the server appends the tail rows > covered onto the new epoch, if they can be
      transcoded, which they cannot across lineages without a client
    - retry with a smaller snapshot
  - Needs a decision.
- **R3 — The 96 MiB Wasm cap means only clients can compact bloated notes.**
  - The 5m fixture (8.7 MB, 246k structs) traps the server (`unreachable`) in a Doc.
  - Stateless merge high-water is ≈ 4–5× merged size, so ≈ 20 MB merged is the cap even without a Doc. The 9 MiB
    merge budget (WIP) keeps the server below it.
  - Past that, a body is served unmerged and never checkpointed until a client resets it. A vault whose devices never
    run the reset policy keeps that body's tail forever.
- **R4 — Estimated SV for bodies > 256 KiB.** G8 is the correctness side. The performance side: exact SVs above
  256 KiB cost 1.2 ms (1 MB) to 14 ms (10 MB) per append (K3), which exceeds a 10 ms Worker-style budget. The
  incremental SV is therefore needed, and its drift must be measured (`stateVectorDrift` in C2/stress).
- **R5 — Write amplification against the free tier (section 9).**
  - One append per frame at 11 rows is ≈ 55 rows per typing-second at 5 frames/s.
  - The model puts a typical 2 h editing day at 119% of the 100k rows/day free limit for the relay, and 90% for base.
  - This is the most likely reason relay mode would be unacceptable on Free. It needs the C4 numbers and the
    reductions listed in section 9.
- **R6 — Tail CPU measurements are lossy.**
  - `wrangler tail` dropped every WS event on a busy Worker (scratch-1 C1: 0 events). It matched 15/15 on a quiet one
    (scratch-2).
  - C1/C2 numbers must come from gql aggregates (`Invocations`, µs) or from matched-sample tails with loss reported.
    Per-event p50 from a lossy tail is biased toward quiet periods.
- **R7 — Receiving-side validation does not exist yet.** Relay mode without it drops today's server-side
  frontmatter/root-shape gate.
- **R8 — Measurements taken in Node** (K3, K2) and on an enterprise account. Workers Free DO limits are the same
  tables, but CPU and memory accounting on the edge may differ.

**Open questions:**

- **Q1** Should relay append catalog events only when the hash or size changes or is claimed, to cut rows (section 9)?
  Currentness then needs `latest_sequence` from the head, which it already has.
- **Q2** Should step1 always answer by sequence (unmerged parts) rather than by SV diff? That trades bytes for E2EE
  readiness and zero merges.
- **Q3** A poison-pill policy for bodies whose bytes make merges throw: quarantine, and surface to clients for a reset?
- **Q4** Lease TTL vs upload size: should the TTL scale with the declared snapshot size, or should an upload in
  progress extend the lease?
- **Q5** Keep attribution per frame or per append? Per frame is N rows per batch.
- **Q6** Rollback relay → base on the same storage: allowed or forbidden?

## 13. Reversal conditions

Abandon the change or roll back to base if **any** of the following holds at full n on the Workers Free-representative
config:

1. **Latency.** Relay L2 p50 is not at least 2× better than base, or relay L2 p99 is worse than base p99.
2. **Rows written.** With measured C4 and after the phase-0 reductions, the costmodel typical day (2 h, 3 devices,
   5 frames/s) is > 100% of 100k rows/day for the relay **and** > 1.25× base.
3. **DO requests.** Idle or typical-day DO requests for the relay are > 1.1× base (C5).
4. **Correctness.** Any convergence failure (section 8.7), or any violation of invariants 1–5, 7, 8 or 11 in tests or
   deployed runs: an append after the revocation fence sequence (B4), an old-epoch append (B5), or more than one
   append per resent candidate (B6).
5. **CPU.** Relay C1 heavy-note CPU per keystroke p50 is not below base's, or relay p99 per append is > 10 ms on a
   ≤ 256 KiB body.
6. **Memory and scale.** Relay X1 is below 250 concurrent body sockets per vault, or relay C3 Wasm high-water at
   32 × 512 KiB exceeds base.
7. **Reset.** Mobile-class inferred reset build p50 for 1 MB is > 2 s, or B5 at full n shows a lost edit, or reset
   starvation (R2) persists: fewer than 90% of reset attempts on a note edited at 1 frame/s succeed within 3 tries.
8. **Stored-state growth.** After the G1 fix, `vault_journal` rows per relay body are not bounded (more than
   checkpoint entries + feed retention) after the stress trace.
9. **Post-launch regression.** A support-visible rise in conflict copies, attributable to rebase, of more than 2× base
   in the first release.

## 14. Appendix

### 14.1 Harness usage

See `scripts/relay2/README.md`. In short:

```
zsh scripts/relay2/deploy.sh yaos-relay2-<name> --relay on|off [--require-clean | --src <tree>]
node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts --host <url>
node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <scenario> --host <url> --out <json> \
     --adapter base|relay|relay-nosv|relay-nocand [--tail]
python3 scripts/relay2/analyze.py <run.json…>          # summaries
node tests/run-typescript.mjs --test-aliases scripts/relay2/gql.ts …   # CPU from analytics (preferred, R6)
python3 scripts/relay2/costmodel.py [--set k=v] [--json measured.json]  # section 9
```

Other entry points:
- Reset and K2: `scripts/relay2/reset/`.
- Byte ops and K3: `scripts/relay2/k3/`.
- Core smoke: `scripts/relay2-core-smoke.ts <host>`.

Local tests:

| Suite | Result |
|---|---|
| `tests/server/relay2-server-core.ts` | 12/12 |
| `tests/server/relay2-byteops.ts` | 9/9 |
| `tests/client/relay2-reset-builder.ts` | 45/45 |
| `tests/client/relay2-reset-policy.ts` | 31/31 |
| `tests/client/relay2-reset-race.ts` | 127/127 |
| flag-off regressions | 199/199 (`results/relay2/flag-tests.md`) |
| base suites | 179/179 (`results/relay2/base-tests.md`) |

### 14.2 Raw data index

| Data | Location |
|---|---|
| Run JSONs (per scenario, per Worker) | `experiments/logs/relay2/runs/` (not in git; contexts hold tokens) |
| Deploy records | `experiments/logs/relay2/deploy-<name>.json` |
| K2 | `experiments/results/relay2/K2.md`, `K2-local-2026-09-29T19-58-32-456Z.json` |
| K3 | `experiments/results/relay2/K3.md`, `K3-byteops-all.json`, `K3-byteops-svdiff-all.json`, `K3-bundle-size.json` |
| B5 | `experiments/results/relay2/B5-2026-09-29T20-13-40-001Z.json`, `B5-2026-09-29T20-16-32-720Z.json` |
| Flag / base tests | `experiments/results/relay2/flag-tests.md`, `base-tests.md`, `base-tests.json` |
| Prior art | `experiments/results/A1.md`, `A2-A4.md`, `A3.md`, `A5.md` |
| Full-n runs | <<MEASURED: list of final run JSON paths per scenario ID>> |
| Final deploy version IDs (base / relay) | <<MEASURED: version ids + spike SHA>> |
