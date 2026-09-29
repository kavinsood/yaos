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
  `{epoch, latestSequence, mergedBytes, stateVector}`.
- **Byte ops.** State vector and diff are computed from those bytes with the patch-0003 ywasm
  byte ops (`server/src/crdt/ywasmByteOps.ts`). No Y.Doc and no `yjs` import on the server.
- **Checkpoint.** An alarm-driven checkpoint merges the tail at the byte level at 50 entries or
  1 MiB. It is written into the existing checkpoint tables in one transaction.
- **History GC.** A client performs history GC, holding a lease: `compaction-lease` then
  `semantic-reset` (§5).

Root sockets and root documents are unchanged in relay mode. Only `kind === "body"` sockets and
body documents use the relay path.

## 2. Socket: accept

`GET /vault/:id/ws?kind=body&documentId=…&documentEpoch=…`, unchanged URL and auth.

Relay-mode differences:

- **Skipped:** `MAX_BODY_SOCKETS` (32), `cache.admitBody`, `cache.load` and the
  semantic-compaction admission pause.
- **Sanity cap:** at most `YAOS_RELAY_MAX_BODY_SOCKETS` (default 5000) body sockets per vault
  DO. Over the cap, the socket closes with 1013.
- **Epoch:** the body epoch is checked against the durable head (`vault_document_heads`). On a
  mismatch the server returns the same `SemanticEpochMismatchError` payload as base.
- **Body state:** the body must be active (`activeBodyHead`), as in base.
- **Handshake:** the server sends step1 = the state vector of the stored merged bytes.
  `VAULT_READY` is the same frame as base; `durableGeneration` is the head generation.
  `capabilities` gains `"relay-bodies-v2"`.
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

The path is synchronous in the DO; nothing awaits between the merge and the commit.

1. **Empty skip.** An inner update equal to `[0,0]` is not appended (`emptySkips++`).
2. **Candidate dedupe.** This step applies only if the envelope carries `candidateId`. The server
   looks up `vault_candidate_receipts(bodyId, deviceId, candidateId)`:
   - Same digest (`candidateDigest ?? payloadDigest`): the original receipt is re-sent as
     `BODY_COMMITTED` with `deduped: true`. Nothing is appended.
   - Different digest: the frame is rejected with
     `{type:"BODY_UPDATE_REJECTED", clientFrameId, candidateId, reason:"candidate_id_reused"}`.
     Nothing is appended.
3. **No-op skip (growth cap).** If `mergeUpdates([merged, u])` is byte-identical to `merged`, the
   update adds nothing (for example, a reconnect step2 re-sending a covered delete set). It is not
   appended (`noopSkips++`). The origin still gets `BODY_COMMITTED` with `noop: true` and the
   current head sequence.
4. **Authority re-check.** `validateActor` runs against the DO's own authority tables, with a
   per-runtime cache keyed by an in-memory authority version. The version is bumped by device
   revocation, authority fences, membership and provisioning writes, and there is a 5 s TTL safety
   net. A revoked actor gets `{type:"error", code:"authority_superseded"}` and close 4403.
5. **Budgets.** Each socket has a token bucket: `YAOS_RELAY_RATE_BYTES_PER_SEC` (default
   262144) refilling a burst of `YAOS_RELAY_BURST_BYTES` (default 1048576). An empty bucket gets
   `{type:"VAULT_BACKPRESSURE", reason:"relay_rate_limit"}` and close 1013.
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
   - `BODY_COMMITTED` without relay fields goes to root sockets and peer body sockets (the same
     frame base sends).

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
- Root sockets, and body sockets of the same body and epoch, get the base `BODY_COMMITTED`
  (no relay fields).

### 4.3 Close codes

| Code | Meaning |
|---|---|
| 4409 | Semantic epoch fenced. Sent on a frame for a stale epoch and after a `semantic-reset`. Client rebases. |
| 4403 | Authority superseded (revoked device or membership, authority fence). |
| 1013 | Backpressure: token bucket empty, or over the relay socket cap. |
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
clamped to [1000, 600000]. `{"release": "<leaseId>"}` releases a lease the caller holds.

This is a CAS on `relay_compaction_leases(body_id PK)`. The lease is granted if there is no row,
the row has expired, or the row is held by the same device (re-grant, new `leaseId`), **and**
`expectedEpoch` equals the head epoch.

- `200 {"granted": true, "leaseId", "expiresAt", "epoch", "headSequence", "generation", "stateVector"}`
  - `headSequence` is the head `latest_sequence`.
  - `stateVector` is the base64 SV of the merged bytes at `headSequence`.
- `409 {"granted": false, "reason": "held"|"epoch_mismatch", "epoch", "headSequence", "holderDeviceId"?, "expiresAt"?}`
- `404 {"granted": false, "reason": "not_found", …}`: the body is unknown or not active.

### 5.2 `POST /vault/:id/body/:bodyId/semantic-reset`

Requires the `vault.content.write` capability.

Request (JSON; the forwarded body limit is 8 MiB):

```json
{"leaseId": "…", "expectedEpoch": 1, "coveredSequence": 4242,
 "contentHash": "…", "contentBytes": 1234, "snapshot": "<base64 Yjs v1 full-state update>"}
```

The server checks, and then installs, in order:

1. The lease is valid (same `leaseId`, same device, not expired).
2. `expectedEpoch` equals the head epoch.
3. `coveredSequence` equals the head `latest_sequence` **exactly**.
4. `semanticResetFromEncodedState(bodyId, snapshot, {throughSequence: coveredSequence, generation, semanticEpoch: expectedEpoch})`
   installs the snapshot. In one transaction it writes a checkpoint at a new sequence, bumps the
   epoch, advances the head and copies the catalog event. In relay mode that catalog event
   records the client's `contentHash` and `contentBytes`.
5. The lease row is deleted.
6. `fenceSemanticEpoch` closes old-epoch sockets with 4409.
7. The merged-bytes cache is invalidated.

Responses:

- `200 {"ok": true, "epoch", "previousEpoch", "sequence", "fencedSockets"}`
- `409 {"ok": false, "reason": "lease_invalid"|"lease_expired"|"epoch_mismatch"|"head_advanced", "epoch", "headSequence"}`
  - `head_advanced`: rebuild from the current head and retry while the lease is valid.
- `400 {"ok": false, "reason": "invalid_request"|"invalid_snapshot"}`

The server does **not** verify that `contentHash` matches the snapshot text, because it would need
a doc. Clients are trusted, as with envelope hashes.

### 5.3 Existing reads, relay mode

`GET/HEAD /vault/:id/body/:bodyId`, `/catch-up` and bootstrap body reads serve merged stored
bytes (checkpoint + tail, byte merge). The hash comes from the catalog. If the head catalog event
has a NULL hash, the server materialises lazily once, computes `canonicalMarkdownHash`, and
backfills that catalog event in place (`materialisations++`).

### 5.4 Diagnostics

- `GET /vault/:id/diagnostics` (existing, `vault.diagnostics.read`) gains a `relay` object:

  ```json
  { "enabled": true, "config": {…},
    "counters": { "appends", "appendFrames", "emptySkips", "noopSkips", "dedupeHits", "dedupeConflicts",
                  "materialisations", "checkpoints", "lastCheckpointMs", "checkpointRowsWritten",
                  "resets", "leaseGrants", "leaseDenials", "rowsWritten", "rateLimitCloses",
                  "epochFences", "authorityCloses", "appendsPerSecond" },
    "bodies": [ { "bodyId", "logRows", "logBytes", "checkpointSequence", "checkpoints",
                  "stateVectorBytes", "mergedBytes" } ],
    "vaultJournalRows": 123,
    "ywasmLinearMemoryBytes": 0 }
  ```

  Counters are per runtime; they reset when the DO is evicted.

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

Local tests: `YAOS_TEST_RELAY_BODIES=true` makes the test Worker env / Node host default
`YAOS_RELAY_BODIES` to `"true"` (see `tests/mocks/workerEnv.ts`).

## 7. Design decisions

1. **Log storage in `vault_journal`** (D5 a): one source of truth, so feed, catch-up, bootstrap and
   pins keep working unchanged.
2. **No head CAS; epoch fence only** (D5.1). Concurrent appends never fail with
   `document_head_changed`.
3. **Merged bytes, not a Y.Doc.** A per-runtime LRU holds bytes and the SV. It is rebuilt from
   SQL (checkpoint + tail, byte merge) when the head sequence moved. A lazy materialisation
   happens only for an unknown hash on HTTP reads, and is counted.
4. **Growth cap by byte-equality of merge.** `mergeUpdates([M,u]) == M` holds exactly when `u`
   adds nothing (verified by probe for covered inserts, full states, delete-only updates and
   `[0,0]`). The cost is one merge, which the append already needs.
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
  exactly, so a busy note can starve resets. The client retries.

(Updated as implementation lands; see also `results/relay2/STATUS.md`.)
