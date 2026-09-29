# Relay v2 body protocol (spike, `relay-v2-spike` branch)

Status: experimental. Everything here is gated by the Worker var
`YAOS_RELAY_BODIES === "true"`. With the flag unset or set to any other value, the server is
byte-for-byte the phase0 server: it adds no routes, frames or tables, and nothing on the socket
path changes.

Owner: server-core agent. The harness agent and reset agent build clients against this document.
Brief: `experiments/PHASE2-RELAY-SPIKE-V2.md`. Binding decisions: `experiments/results/relay2/DECISIONS.md`.

## 1. Model

In relay mode the server never holds a CRDT document for a body in the hot path:

- **Log.** Each accepted update is one row in the existing `vault_journal` (D5 option a). It takes a
  `vault_clock` sequence, advances `vault_document_heads`, and writes one catalog event and one
  attribution row. Feed, catch-up, bootstrap and pins read that table, so they see relay edits with
  no further changes.
- **Merged bytes.** The server keeps the body's merged state as bytes: checkpoint plus journal
  tail, merged with ywasm `mergeUpdatesV1`. There is a bounded per-runtime LRU cache of
  `{epoch, latestSequence, mergedBytes|null, stateVector}`.
  - Bodies whose merged bytes are at most `YAOS_RELAY_EXACT_MERGE_BYTES` (default 256 KiB) are
    merged exactly on every append (exact SV, exact no-op check).
  - Larger bodies (K3: whole-state merge/SV costs 7-14 ms at 5-10 MB) keep the head SV
    **incrementally**: `SV' = pointwise max(SV, SV(update))`. The bytes are marked stale and rebuilt
    lazily on the next step1/HTTP read. See §8 for the risk this carries.
- **Byte ops.** State vector and diff are computed from those bytes with the patch-0003 ywasm
  byte ops (`server/src/crdt/ywasmByteOps.ts`). No Y.Doc and no `yjs` import on the server.
- **Checkpoint.** An alarm-driven checkpoint merges the tail at the byte level at 50 entries or
  1 MiB. It is written into the existing checkpoint tables in one transaction. One pass merges at
  most `YAOS_RELAY_CHECKPOINT_MAX_ROWS` (default 200) tail rows (K3: merge cost is superlinear in
  frame count). A longer tail gets a **partial** checkpoint through the 200th row, and the alarm
  re-arms immediately for the rest.
- **History GC.** A client performs history GC, holding a lease: `compaction-lease` then
  `semantic-reset` (§5).

Root sockets and root documents are unchanged in relay mode. Only `kind === "body"` sockets and
body documents use the relay path.

## 2. Socket: accept

`GET /vault/:id/ws/body/:bodyId?ticket=…&schemaVersion=…&protocolVersion=…`: unchanged URL and
auth. The body epoch comes only from the HMAC socket ticket (`POST …/socket-ticket` with
`bodyEpoch`), as in base.

Relay-mode differences:

- **Skipped:** `MAX_BODY_SOCKETS` (32), `cache.admitBody`, `cache.load` and the
  semantic-compaction admission pause.
- **Sanity cap:** at most `YAOS_RELAY_MAX_BODY_SOCKETS` (default 5000) body sockets per vault
  DO. Over the cap, the upgrade is refused with HTTP 429 `{error:"body_socket_limit"}`. Relay
  sockets do not count toward base `MAX_BODY_SOCKETS`.
- **Epoch:** the body epoch is checked against the durable head (`vault_document_heads`). On a
  mismatch the server returns the same `SemanticEpochMismatchError` payload as base.
- **Body state:** the body must be active (`activeBodyHead`), as in base.
- **Handshake:** the server sends step1 = the state vector of the stored merged bytes.
  `VAULT_READY` is the same frame as base; `durableGeneration` is the head generation.
  `capabilities` is the base object plus `relayBodies: 2`
  (`{"currentnessQuery":2,"committedHead":2,"relayBodies":2}`). `GET /api/capabilities` also
  carries `"relayBodies": 2` when the flag is on, and omits the field when it is off.
- **Runtime identity:** relay body sockets survive a DO wake. The `runtimeEpoch` check in
  `message()` is bypassed for them (§4.4).

## 3. Socket: client → server frames

### 3.1 Sync frames (binary, y-protocols)

| Frame | Server action |
|---|---|
| `MESSAGE_SYNC` step1 (client SV) | Reply step2 = `diffUpdate(merged, clientSV)`. Nothing is written. |
| `MESSAGE_SYNC` step2 | Append path (§3.3). |
| `MESSAGE_SYNC` update | Append path (§3.3). |
| `MESSAGE_AWARENESS` | Phase0 semantics: own awareness only; the server rewrites `state.user`. |

Oversized frames close with 1009, as in base: a frame larger than `MAX_CANDIDATE_BYTES + 64`,
or an inner update larger than `MAX_DURABLE_UPDATE_BYTES` (1,750,000 B).

### 3.2 Envelope (D6), `__YPS:` text frame immediately before a binary update

```json
{
  "type": "BODY_UPDATE_ENVELOPE",
  "bodyId": "…",
  "bodyEpoch": 1,
  "clientFrameId": "…",
  "payloadDigest": "<sha256 hex of the INNER Yjs update bytes (the sync message payload, not the whole frame)>",
  "candidateId": "…",
  "candidateDigest": "…",
  "contentHash": "<canonicalMarkdownHash of the client's text after applying the update>",
  "size": 1234,
  "stateVector": "<base64 of Y.encodeStateVector(clientDoc) after applying the update>",
  "frameKind": "update"
}
```

Required fields: `type`, `bodyId`, `bodyEpoch`, `clientFrameId` and `payloadDigest`.
Optional fields: `candidateId`, `candidateDigest`, `contentHash`, `size`, `stateVector` and
`frameKind` (`"update"` or `"step2"`, informational only).

Pairing rules:

- The envelope applies only to the **next binary sync frame** (step2 or update) on the same socket.
  - If that frame's `sha256(innerUpdate) !== payloadDigest`, the frame is treated as having **no
    envelope**. It is still appended, but gets no `clientFrameId` echo and no hash.
  - A second envelope before a binary frame replaces the first.
- An envelope for another `bodyId` or `bodyEpoch` is ignored.
  - A binary frame on a socket whose epoch is stale is fenced with 4409 anyway (§4.3).
- Pending envelopes live in DO memory only. If the DO hibernates between the envelope and the
  binary frame (practically never, since the two are adjacent), the frame counts as envelope-less.
  The client sees no echo and retries.

Currentness (D6, invariant #7): `contentHash`/`size` are recorded on the new catalog event
**only if** `stateVector` is present **and** it equals (semantic map equality) the state vector
of the body's merged bytes after the append.

- Otherwise the new catalog event has `content_hash = NULL, size = NULL`, meaning "unknown".
- Envelope-less frames (e.g. y-partyserver's internal step2) always give "unknown".
- Therefore a recorded hash always describes exactly the merged state at that catalog event.

Reconciling "unknown":

- A later frame whose envelope matches the merged SV makes the hash known again.
- HTTP body reads with an unknown hash materialise once (lazy, off the hot path, counted in
  diagnostics). They backfill the catalog event in place when it is still the head.
- `BODY_CURRENTNESS_QUERY` answers from the catalog: `contentHash: null` means unknown. The
  client reconciles by fetching the body.

### 3.3 Append path (per binary step2/update frame)

The path is synchronous in the DO; nothing awaits between the merge and the commit. Steps run in
this order (as implemented): size limit (1009), envelope pairing, 1 empty skip, 2 dedupe,
3 authority, 4 budget, then (inside commit) epoch fence, 5 growth cap, D6 check, 6 transaction,
7 fan-out. The growth cap runs after authority and budget because it needs the merged state; a
revoked or rate-limited socket never costs a merge.

1. **Empty skip.** An inner update equal to `[0,0]` is not appended (`emptySkips++`).
2. **Candidate dedupe.** This step applies only if the envelope carries `candidateId`. The server
   looks up `vault_candidate_receipts(bodyId, deviceId, candidateId)`:
   - Same digest (`candidateDigest ?? payloadDigest`): the original receipt is re-sent as
     `BODY_COMMITTED` with `deduped: true`. Nothing is appended.
   - Different digest: the frame is rejected with
     `{type:"BODY_UPDATE_REJECTED", clientFrameId, candidateId, reason:"candidate_id_reused"}`.
     Nothing is appended.
3. **Authority re-check.** `validateActor` runs against the DO's own authority tables, with a
   per-runtime cache keyed by an in-memory authority version. The version is bumped by device
   revocation, authority fences, membership and provisioning writes, and there is a 5 s TTL safety
   net. A revoked actor gets `{type:"error", code:"authority_superseded"}` and close 4403.
4. **Budgets.** Each socket has a token bucket: `YAOS_RELAY_RATE_BYTES_PER_SEC` (default
   262144) refilling a burst of `max(YAOS_RELAY_BURST_BYTES, MAX_DURABLE_UPDATE_BYTES)` (default
   and floor 1,750,000 bytes). The floor guarantees one maximum-size frame always fits; before round 2,
   frames between 1 MiB and 1.75 MB were rejected forever. An empty bucket gets
   `{type:"VAULT_BACKPRESSURE", reason:"relay_rate_limit"}` and close 1013.
5. **No-op skip (growth cap).** Small bodies (exact path): if `mergeUpdates([merged, u])` is
   byte-identical to `merged`, the update adds nothing (for example, a reconnect step2 re-sending
   a covered delete set). Large bodies (incremental path): only an exact resend of the last
   appended update is detected. A skipped update is not appended (`noopSkips++`); the origin still
   gets `BODY_COMMITTED` with `noop: true` and the current head sequence.
6. **Commit**, in one `transactionSync` (per frame, or per micro-batch):
   - epoch fence against the head
   - active-body check against the latest catalog event
   - clock +1
   - journal insert (`kind='body'`)
   - attribution row(s)
   - head update (`generation+1`, `latest_sequence`)
   - catalog event (copies file/path; new generation; hash or NULL)
   - candidate receipt row, only when `candidateId` is present

   There is no head CAS on merged state: appends commute, and only the epoch is compared (D5.1).
7. **After commit:**
   - `BODY_COMMITTED` goes to the origin (§4.1).
   - The raw update frame is broadcast to the other body sockets of that body and epoch.
   - The base `BODY_COMMITTED` goes to root sockets. Peer relay body sockets of the same body and
     epoch get it too, with `relay: true, peer: true` and their own admission `runtimeEpoch`, and
     are never closed by it. The origin socket is excluded.
   - The checkpoint alarm is armed if the tail is over the thresholds.

**Micro-batching:** `YAOS_RELAY_MICROBATCH_MS` (default `0` = off). When it is greater than 0,
frames arriving within the window share one transaction and one clock sequence:

- One journal row holds the merged update.
- There is one attribution row per frame (`mutation_index` = frame index).
- There is one catalog event per batch.
- Every origin gets its own `BODY_COMMITTED`, all with the same `vaultSequence`.

## 4. Socket: server → client frames

### 4.1 `BODY_COMMITTED` (origin, relay mode)

This is the base `BODY_COMMITTED` frame with extra fields:

```json
{
  "type": "BODY_COMMITTED",
  "bodyId": "…", "bodyEpoch": 1, "vaultGeneration": 1,
  "durableGeneration": 17, "vaultSequence": 4242,
  "lifecycle": "active", "contentHash": "…|null", "size": 123,
  "runtimeEpoch": "<runtime epoch that ADMITTED this socket>",
  "relay": true,
  "clientFrameId": "…",
  "candidateId": "…", "candidateDigest": "…", "payloadDigest": "…",
  "commitRuntimeEpoch": "<runtime epoch that committed>",
  "contentHashAccepted": true,
  "deduped": false,
  "noop": false
}
```

- `clientFrameId` is present only when the envelope paired.
- `candidateId` and `candidateDigest` are present only when the envelope carried them.
- `contentHash` and `size` describe the committed head. Clients must compare them with their own
  hash before treating the note as current. `contentHashAccepted` says whether this frame's
  claimed hash was recorded.
- Durability is guaranteed by ordering: the frame is sent only after `transactionSync` returns.

### 4.2 Peers

- Other body sockets of the same body and epoch get the committed update as a normal y-protocols
  update frame, after commit.
- Root sockets get the base `BODY_COMMITTED`. Peer relay body sockets get it with
  `relay: true, peer: true` and no `clientFrameId` (it is a head notice, not a receipt).

### 4.3 Close codes

| Code | Meaning |
|---|---|
| 4409 | Semantic epoch fenced. Sent on a frame for a stale epoch and after a `semantic-reset`. Client rebases. |
| 4403 | Authority superseded (revoked device or membership, authority fence). |
| 1013 | Backpressure: token bucket empty. (The socket cap refuses the upgrade with 429.) |
| 1009 | Frame too large. |
| 1008 | Body deleted or not active (`closeBody`), or socket authority mismatch (root sockets only). |
| 1011 | Durable commit failed. The client reconnects and resends through step2. |

### 4.4 Runtime identity

Base clients accept `BODY_COMMITTED` only when `runtimeEpoch` equals the epoch that admitted
their socket. Relay body sockets survive a DO wake, so relay mode does the following:

- `runtimeEpoch` echoes the socket's **admission** epoch (from its attachment), so existing parsing
  keeps working.
- `commitRuntimeEpoch` names the runtime that actually committed.
- The receipt's evidence is commit-before-send plus `vaultSequence`, not runtime identity.
- Relay body sockets of an older runtime receive `BODY_COMMITTED` normally; they are not closed.
- Root sockets keep base behaviour (hint or close).

## 5. HTTP

All new routes exist only when `YAOS_RELAY_BODIES === "true"` (404 otherwise), and use the
normal vault bearer auth.

### 5.1 `POST /vault/:id/body/:bodyId/compaction-lease`

Requires the `vault.content.write` capability.

Request: `{"expectedEpoch": 1, "ttlMs": 120000}`. `ttlMs` is optional, defaults to 120000 and is
clamped to [1000, 600000]. `{"release": "<leaseId>"}` releases a lease the caller holds
(`200 {"released": true}` or `404 {"released": false}`).

This is a CAS on `relay_compaction_leases(body_id PK)`. The lease is granted if there is no row,
the row has expired, or the row is held by the same device (re-grant, new `leaseId`), **and**
`expectedEpoch` equals the head epoch.

- `200 {"granted": true, "leaseId", "expiresAt", "epoch", "headSequence", "generation", "stateVector", "policy"}`
  - `headSequence` is the head `latest_sequence`.
  - `stateVector` is the base64 SV of the merged bytes at `headSequence`.
  - `policy` (round 2) is `{"lastResetAt": ms|null, "cooldownMs", "cooldownRemainingMs", "nextResetAllowedAt": ms|null}`.
- `429 {"granted": false, "reason": "cooldown", "epoch", "headSequence", "policy"}` with a
  `retry-after` header in seconds. This is the server reset cooldown (round 2): no lease is granted
  until `YAOS_RELAY_RESET_COOLDOWN_MS` (default 24 h, mirroring
  `BODY_COMPACTION_THRESHOLDS.softCooldownMs`) has passed since the body's last semantic reset.
  `lastResetAt` is `vault_semantic_compaction_state.last_compacted_at`, which
  `semanticResetFromEncodedState` already writes, so the cooldown adds no table. `semantic-reset`
  re-checks the cooldown, so a lease granted just before a concurrent reset cannot slip through.
  Test workers set the var small in `[vars]`.
- `409 {"granted": false, "reason": "held"|"epoch_mismatch", "epoch", "headSequence", "holderDeviceId"?, "expiresAt"?}`
- `404 {"granted": false, "reason": "not_found", …}`: the body is unknown or not active.

**Client shape change (round 2, `scripts/relay2/reset/leaseClient.ts` + `httpTransport.ts`).** A
granted result gains `policy`. A denied result gains `reason: "cooldown"` (HTTP 429) and an
optional `policy`; the client should wait `retry-after` or `policy.cooldownRemainingMs` rather than
retry. The SV coverage check is gone (§5.2), so the builder's `coverStateVector` GC-struct prefix is
no longer needed; it is still accepted. Transports should switch to the octet-stream reset body.

### 5.2 `POST /vault/:id/body/:bodyId/semantic-reset`

Requires the `vault.content.write` capability.

Two request shapes are accepted.

**Binary (preferred, round 2).** `Content-Type: application/octet-stream`. The body is the raw
Yjs v1 full-state snapshot, up to `MAX_CATCH_UP_BYTES` (8 MiB). The metadata goes in headers:

| Header | Query fallback | Value |
|---|---|---|
| `x-yaos-lease-id` | `leaseId` | lease id |
| `x-yaos-expected-epoch` | `expectedEpoch` | integer ≥ 1 |
| `x-yaos-covered-sequence` | `coveredSequence` | integer ≥ 0 |
| `x-yaos-content-hash` | `contentHash` | 64 lowercase hex |
| `x-yaos-content-bytes` | `contentBytes` | integer ≥ 0 |

A header wins over the query parameter of the same field. The binary shape skips base64 (4/3
inflation) and JSON parsing, which is about 1.8x the snapshot in transient JS heap, on a 128 MB
isolate.

**JSON (legacy, kept).** The forwarded body limit is 8 MiB, so the snapshot tops out near 6 MB:

```json
{"leaseId": "…", "expectedEpoch": 1, "coveredSequence": 4242,
 "contentHash": "…", "contentBytes": 1234, "snapshot": "<base64 Yjs v1 full-state update>"}
```

The server checks, and then installs, in order:

0. **Structural sanity only:** the snapshot has between 2 bytes and 8 MiB, its state vector
   decodes (`stateVectorFromUpdate`), and the SV is non-empty unless `contentBytes == 0`.
   Otherwise the server returns `400 invalid_snapshot`.
   - **Round 2 removed the SV coverage check** (`SV(snapshot) ⊇ headSV`). A correct client
     snapshot is *lineage-fresh*: a new Y.Doc holding the text, with a new client id. Its SV
     never covers the old head SV, so the check rejected every correct reset unless the client
     prepended GC structs. And it proved nothing about content anyway.
1. The lease is valid (same `leaseId`, same device, not expired).
2. `expectedEpoch` equals the head epoch.
3. `coveredSequence` equals the head `latest_sequence` **exactly**.
4. The reset cooldown has passed (`409 {"reason": "cooldown", "policy"}`; see §5.1).

**Currency proof.** Steps 1–3 together are the proof that the snapshot is current: epoch CAS,
plus a lease, plus `coveredSequence == head` exactly. Appends take a `vault_clock` sequence inside
their commit transaction, and the reset runs in one synchronous transaction that re-reads the head.
So if any edit landed after the head the client built from, the head moved and the reset fails
with `head_advanced`. The server cannot check that the snapshot *text* equals the head text
without a document. That part stays client trust, like the envelope hashes (D6).

**Hot-note CAS starvation.** On a note receiving edits continuously (for example, a live
transcript), the head can move during every build → upload window, so every reset fails
`head_advanced` until the lease expires. Mitigations:

- *Client (recommended):* re-read the head, rebuild from the local
  doc (the rebuild is O(text), about 100 ms at 5 MB), re-POST under the same lease, and add
  jittered backoff between attempts. Only reset when the note has been idle for a moment, since
  the policy thresholds make resets rare anyway.
- *Server (documented, not implemented):* an optional append-pause window. While a lease is held
  with `pauseAppends: true`, relay appends for that body are deferred (queued in memory, bounded
  by the lease TTL and by `YAOS_RELAY_MICROBATCH_MS`-style buffering) or rejected with
  `VAULT_BACKPRESSURE`. That gives the holder a quiet window of at most a few seconds. It trades
  edit latency for guaranteed progress, and the lease TTL bounds the damage if the holder dies.
4. `semanticResetFromEncodedState(bodyId, snapshot, {throughSequence: coveredSequence, generation, semanticEpoch: expectedEpoch})`
   installs the snapshot. In one transaction it writes a checkpoint at a new sequence, bumps the
   epoch, advances the head and copies the catalog event. In relay mode that catalog event
   records the client's `contentHash` and `contentBytes`.
5. The lease row is deleted.
6. `fenceSemanticEpoch` closes old-epoch sockets with 4409.
7. The merged-bytes cache is invalidated.

Responses:

- `200 {"ok": true, "epoch", "previousEpoch", "sequence", "generation", "fencedSockets", "policy"}`
- `409 {"ok": false, "reason": "lease_invalid"|"lease_expired"|"epoch_mismatch"|"head_advanced"|"cooldown", "epoch", "headSequence", "policy"?}`
  - `head_advanced`: rebuild from the current head and retry while the lease is valid.
- `400 {"ok": false, "reason": "invalid_request"|"invalid_snapshot"}`
- `413 {"ok": false, "reason": "too_large"|…}`: the body is over the 8 MiB bound.

A successful reset also drops any resident base-path document (`discardResident`) and prunes the
old epoch's journal rows, checkpoints and manifests (`pruneUnpinnedDocumentHistory`; bootstrap and
restore pins are kept).

The server does **not** verify that `contentHash` matches the snapshot text, because it would need
a doc. Clients are trusted, as with envelope hashes.

### 5.3 Existing reads, relay mode

- **`GET /vault/:id/body/:bodyId`** returns the merged stored bytes (checkpoint + tail, byte
  merge). Headers:
  - `x-yaos-body-epoch`
  - `x-yaos-generation`
  - `x-yaos-head-sequence` (the head `latest_sequence`)
  - `x-yaos-content-hash`, empty when unknown
  - `x-yaos-size`, empty when unknown
  - `x-yaos-content-hash-state`: `known`, `materialised` (computed just now by the lazy hash) or
    `unknown`

  It returns `413 {"error": "relay_merge_budget_exceeded"}` for an over-budget body (§6.2).
- **`HEAD /vault/:id/body/:bodyId`** (relay mode only; base has no HEAD route) returns the same
  headers with no body. It reads only the durable head and the catalog: no byte merge and no
  document. `x-yaos-content-hash-state` is `known` or `unknown`. A client polls it cheaply for
  sequence, generation and epoch.
- **`/catch-up`** returns merged stored bytes. `contentHash`/`size` can be `null` (unknown). An
  over-budget body gets a per-item `{"status": 413, "error": "relay_merge_budget_exceeded"}`.
- **Bootstrap body reads** (`/bootstrap/:id/body/:bodyId` and the batch route) use a byte merge in
  relay mode (round 2). They merge the pinned checkpoint at or before the boundary with the
  journal tail through the boundary (`durableMergedBytes(bodyId, boundarySequence)`), with no
  document. A reset after the boundary still serves the old lineage, because the pin keeps the
  old epoch's rows. Over budget, the batch returns 413.
- **Lazy hash.** If the head catalog event has a NULL hash and the merged bytes are at most
  `YAOS_RELAY_LAZY_HASH_MAX_BYTES` (default 3 MiB), the server materialises the document once,
  computes `canonicalMarkdownHash` and backfills that catalog event in place
  (`materialisations++`). Above that size the hash stays unknown (`lazyHashSkips++`), because a
  document for a large, struct-dense body can exceed the wasm memory budget (§6.2).

### 5.4 Diagnostics

- `GET /vault/:id/diagnostics` (existing, `vault.diagnostics.read`) gains a `relay` object:

  ```json
  { "enabled": true, "config": {…},
    "counters": { "appends", "appendFrames", "emptySkips", "noopSkips", "dedupeHits", "dedupeConflicts",
                  "materialisations", "checkpoints", "lastCheckpointMs", "checkpointRowsWritten",
                  "resets", "leaseGrants", "leaseDenials", "rowsWritten", "rateLimitCloses",
                  "epochFences", "authorityCloses", "commitFailures", "mergedCacheRebuilds",
                  "step2Replies", "envelopeMismatches", "hashAccepted", "hashUnknown",
                  "incrementalAppends", "stateVectorDrift", "partialCheckpoints", "mergeBudgetRejects",
                  "unmergedStep2Replies", "lazyHashSkips", "appendsPerSecond" },
    "documentMaterialisations": { "root", "nonRoot", "recentNonRoot": [ { "documentId", "throughSequence", "at" } ] },
    "byteOps": "<ywasm byte-ops backend name>",
    "bodies": [ { "bodyId", "epoch", "latestSequence", "generation", "logRows", "logBytes",
                  "checkpointSequence", "stateVectorBytes", "mergedBytes|null", "stateVectorExact" } ],
    "mergedCacheBytes": 0, "pendingEnvelopes": 0, "pendingBatches": 0,
    "vaultJournalRows": 123,
    "ywasmLinearMemoryBytes": 0 }
  ```

  Counters are per runtime; they reset when the DO is evicted. `documentMaterialisations` counts
  every `VaultDocumentStore.reconstructDocument` call, relay or base, for any reason. In relay mode
  `nonRoot` should move only for the paths listed in §6.1.

- `GET /vault/:id/debug/relay-table-counts`, gated by `YAOS_TEST_ONLY_DEBUG_ROUTES === "true"` AND
  the relay flag, with the operator session: `{tables: {name: rowCount}}` for every table.

## 6. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `YAOS_RELAY_BODIES` | unset | `"true"` enables everything in this doc. |
| `YAOS_RELAY_MICROBATCH_MS` | `0` | Micro-batch window (ms); 0 means one tx per frame. Capped at 50. |
| `YAOS_RELAY_MAX_BODY_SOCKETS` | `5000` | Sanity cap on body sockets per vault DO. |
| `YAOS_RELAY_RATE_BYTES_PER_SEC` | `262144` | Token-bucket refill per socket. |
| `YAOS_RELAY_BURST_BYTES` | `1048576` | Token-bucket capacity per socket. |
| `YAOS_RELAY_MERGED_CACHE_BYTES` | `16777216` | Per-runtime LRU budget for merged body bytes. |
| `YAOS_RELAY_CHECKPOINT_ENTRIES` | `50` | Tail-entry threshold that arms the checkpoint alarm. |
| `YAOS_RELAY_CHECKPOINT_BYTES` | `1048576` | Tail-byte threshold that arms the checkpoint alarm. |
| `YAOS_RELAY_EXACT_MERGE_BYTES` | `262144` | Bodies up to this merged size use the exact per-append merge; larger ones use the incremental SV. |
| `YAOS_RELAY_CHECKPOINT_MAX_ROWS` | `200` | Max tail rows merged per checkpoint pass (partial checkpoints beyond). |
| `YAOS_RELAY_RESET_COOLDOWN_MS` | `86400000` | Minimum ms between two semantic resets of one body (lease → 429 `cooldown`). `0` disables. |
| `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` | `9437184` | Max summed input of one server byte merge (§6.2). |
| `YAOS_RELAY_LAZY_HASH_MAX_BYTES` | `3145728` | Bodies above this never get the lazy-hash materialisation. |

Local tests: `YAOS_TEST_FORCE_RELAY_BODIES=true` (or `YAOS_TEST_RELAY_BODIES=true`) makes runtimes
built without an env (unit suites) default to relay mode (`relayBodiesTestDefault()` in
`server/src/relayFlag.ts`). An explicit `YAOS_RELAY_BODIES` in the env always wins. The local
wrangler launchers (`tests/conformance/launch/wrangler.ts`, `tests/headless/wrangler.ts`) forward
`YAOS_RELAY_BODIES` from the process env as `--var`, and the Node host reads it from
`process.env`.

### 6.1 Remaining document materialisations in relay mode

These code paths still build a server Y.Doc for a relay body. Each is counted in
`documentMaterialisations`:

| Path | When | Why it stays |
|---|---|---|
| Lazy hash (`bodyHttpState`) | HTTP GET/catch-up of a body whose head catalog hash is NULL, merged bytes ≤ 3 MiB | This is the only way to get text from bytes without a doc. It is at most once per unknown head, then backfilled. Clients avoid it by sending D6 claims. |
| HTTP candidate path / create (`vaultLifecycleService.createDocument`, candidate commit) | Closed-file edits and file creates go through the base HTTP candidate path, which loads the body into the document cache | The markdown → CRDT diff (and validation) needs a document. Relay covers only open-editor socket edits. Moving closed-file edits to "client builds the update, server appends" is a client change. |
| Dirty-doc `writeLiveCheckpoint` | A body resident in the cache (from the candidate path) that is dirty gets a live checkpoint from the doc | This belongs to the base cache lifecycle. `syncDocumentCache` discards a clean resident doc on each relay append, so this happens only while a candidate is in flight. |
| Semantic docs / base compaction | Server semantic compaction | Disabled for relay bodies (§7.9). It can still run for bodies created before the flag. |
| Root | All root reads and writes | Out of scope: the relay covers bodies only. |

Paths that do **not** materialise in relay mode: socket accept (step1 = the SV of merged bytes),
appends, step2 replies, checkpoints, GET with a known hash, HEAD, catch-up with known hashes,
bootstrap body reads (round 2), lease and reset (structural check only). The unit test
`HTTP reads: …` asserts this with the counter.

### 6.2 Memory (ywasm byte ops)

Byte ops are stateless: every op copies its inputs into ywasm linear memory, decodes them, and
encodes the result. The linear memory grows up to a 96 MiB cap (`ywasmByteOps`) and **never
shrinks**, inside a 128 MB isolate.

Measured with `scripts/relay2-core-reset-loop.ts` on Node, the same wasm build:

| Input | Op | ywasm peak |
|---|---|---|
| 10 MB single-lineage text (checkpoint + 211 tail parts) | merge (15 ms) + SV (6 ms) | 39–48 MiB |
| 8.77 MB bloated 5 MB note (`reset-fixtures/sized-5m.update`, 246k structs) | SV only | 54 MiB |
| same | `merge([state, 50 tail edits])` | 85 MiB |
| same | `diff(state, emptySV)` | 88 MiB |
| same | SV + merge + diffs, sequentially | 95.6 MiB |
| same | `merge([state, state])` | **trap (`unreachable`, OOM)** |

The rule of thumb is about 4.5x input bytes for sparse text and up to about 10x for struct-dense
updates.

**Critical: after an OOM trap the ywasm instance is poisoned.** Every later op, even a 100-byte
merge, fails with an allocation error until the isolate restarts. In the DO that would take down
every relay body of the vault until eviction. Re-instantiating the module after a trap is owned by
the ywasm agent. The server side now **refuses before calling into wasm**:

- `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` (default 9 MiB) bounds the summed input of every server
  merge: `durableMergedBytes` throws `RelayMergeBudgetError`. The 9 MiB default sits above the
  8 MiB `MAX_CATCH_UP_BYTES` response cap, so any body a GET could return is still merged. A
  dense 9 MiB input (about 90 MiB) is at the edge; lower the budget if the ywasm agent measures
  denser fixtures.
- An over-budget body keeps `bytes: null` and an exact SV (the pointwise max of the per-part SVs;
  each part is one checkpoint or one ≤1.75 MB frame). Appends keep working.
  - **Step1** is answered with the stored parts, one `SYNC_STEP_2` per part, unmerged and undiffed
    (`unmergedStep2Replies++`). y-protocols clients apply them idempotently.
  - **GET/catch-up/bootstrap** return 413 `relay_merge_budget_exceeded`.
  - **The checkpoint** is skipped (`mergeBudgetRejects++`), and the alarm stops re-arming for that
    body until a semantic reset shrinks it.
- Exact per-append merges only run for bodies ≤ `YAOS_RELAY_EXACT_MERGE_BYTES` (256 KiB), which
  is far below the budget.

**5 MB bloated note: no server doc is needed.** Server compaction is disabled for relay bodies.
The reset takes the client's snapshot and runs only the structural SV parse. GET, step2 and the
checkpoint use byte ops. The lazy hash is skipped above 3 MiB. The bloated fixture's SV-only
parse, 54 MiB, is the largest single op on the reset path.

**Repeated-reset slowdown (live: 5.0 s → 20.9 s → 116 s `lease_expired`).** A local loop with a
5 MB note, 10 iterations, real SQLite and the real route
(`node tests/run-typescript.mjs --test-aliases scripts/relay2-core-reset-loop.ts --mb 5 --n 10`)
showed nothing growing on the server:

- Each reset takes about 140 ms with the binary body and about 155 ms with JSON, flat across
  iterations.
- The post-reset read takes about 132 ms.
- Table counts stay flat (journal 2, checkpoint chunks 3, manifests 1). Old epochs are pruned.
- ywasm stays at 20.2 MiB and the heap at about 45 MiB.

So server storage and CPU do not grow per reset. The likely live cause is isolate memory
pressure: ywasm memory near the cap from the pre-round-2 `snapshotCoversHead` full-state rebuild
and SV, plus the base64 JSON body (about 3x the snapshot in transient heap), plus the 16 MiB
merged LRU, on a 128 MB isolate. That slows GC until the isolate is reset. Client or network time
could also contribute. Round 2 removes the full-state rebuild on reset and adds the binary body.

Live re-measurement after round 2 (`scripts/relay2-core-live-reset.ts --mb 5 --n 6` against
`yaos-relay2-coresmoke-1`; the 5 MB note is grown by 1 MB relay appends; binary 5.24 MB snapshot
each time; results in `results/relay2/core2-live-reset-5mb.json`):

- Six consecutive resets all returned 200: 3.7, 3.3, 3.6, 1.7, 3.1 and 3.1 s. That time is
  dominated by the 5 MB upload from the test machine. There is no growth and no `lease_expired`.
- The GET after each reset took 1.2–1.7 s for 5.24 MB, with `hashState: known`.
- HEAD took 180–260 ms.
- With the 1 s test cooldown, an immediate re-lease got `429 cooldown` (`retry-after: 1`) once. In
  the other five iterations the reset round-trip had already outlasted the cooldown.

## 7. Design decisions

1. **Log storage in `vault_journal`** (D5 a): one source of truth, so feed, catch-up, bootstrap and
   pins keep working unchanged.
2. **No head CAS; epoch fence only** (D5.1). Concurrent appends never fail with
   `document_head_changed`.
3. **Merged bytes, not a Y.Doc.** A per-runtime LRU holds bytes and the SV. It is rebuilt from
   SQL (checkpoint + tail, byte merge) when the head sequence moved. A lazy materialisation
   happens only for an unknown hash on HTTP reads, and is counted.
4. **Growth cap by byte-equality of merge** (small bodies). `mergeUpdates([M,u]) == M` holds exactly
   when `u` adds nothing (verified by probe for covered inserts, full states, delete-only updates
   and `[0,0]`). The cost is one merge, which the exact path already needs. Large bodies only
   catch exact resends (K3 cost).
5. **Currentness requires an SV match** (D6). A hash is recorded only if the client SV equals the
   merged SV after the append (invariant #7).
6. **Synchronous frame handling** (sha256 in JS, no awaits), so envelope pairing and appends never
   interleave across frames.
7. **The receipt is commit-before-send**, not runtime identity (§4.4).
8. **Dedupe uses `vault_candidate_receipts`.** `vault_operation_outcomes` is not written per
   append (write amplification). Receipt pruning runs in the checkpoint alarm, not per append.
9. **Server-side semantic compaction is disabled for relay bodies.** Lease-based client reset
   replaces it; `recordCommit` is skipped for relay appends.

## 8. Deviations (from brief / base behaviour)

- **Validation.** There is no server-side frontmatter or markdown-size validation on relay
  appends, because it would need a doc. The per-frame byte limit still applies.
- **Pending envelopes are memory-only** (§3.2). Hibernation between the envelope and its frame
  means no echo.
- **Checkpoint at `YAOS_RELAY_CHECKPOINT_*`** uses the byte merge. Checkpoints of relay bodies
  never touch the document cache.
- **`vault_operation_outcomes` is not written** for relay appends. Relay receipts are not
  retrievable through `GET /operations/:id/outcome`.
- **The reset lease is at least as strict as needed**: `coveredSequence` must equal the head
  exactly, so a busy note can starve resets. See §5.2 for the hot-note mitigations.
- **Incremental SV on large bodies (K3).** For bodies over `YAOS_RELAY_EXACT_MERGE_BYTES` the head
  SV is the pointwise max of the old SV and the update's SV. If an update arrives with a causal
  gap (its structs cannot integrate yet), that max overstates what the merged state contains,
  so a D6 hash claim can be accepted when it should not be. Well-behaved y-protocols clients send
  causally complete updates, so this should not happen in practice. Every rebuild or checkpoint
  compares the incremental SV with the exact one and counts mismatches in
  `counters.stateVectorDrift`; it was 0 in all tests. The growth cap on large bodies only catches
  exact resends, so a covered-but-different re-send (e.g. a reconnect step2) of a large body is
  appended (it is idempotent, and costs one journal row).
- **Bootstrap body reads use a byte merge** (round 2; §5.3). The bootstrap catalog page can carry
  `contentHash: null` for relay appends whose hash was not accepted; clients must treat that as
  unknown.
- **Over-budget bodies** (§6.2) are not served by GET, catch-up or bootstrap (413) and are not
  checkpointed until a client reset shrinks them.
- **Checkpoints are bounded** to `YAOS_RELAY_CHECKPOINT_MAX_ROWS` rows per pass (partial
  checkpoint + immediate alarm re-arm) instead of one merge of the whole tail.

(Updated as implementation lands; see also `results/relay2/STATUS.md`.)
