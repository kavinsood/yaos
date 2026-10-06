# YAOS relay wire: opaque streams (client remake)

This is the contract between the new client (`src/`) and the relay server (`server/`). The relay is an
authenticated, ordered, durable mailbox. It sequences, stores and forwards **opaque bytes**. It never decodes,
validates, merges, hashes or compacts CRDT content. Merging, checkpoint contents and the meaning of streams all
belong to the client.

- Server code: `server/src/streams/{protocol,store,relay}.ts`, wired in `server/src/server.ts`,
  `server/src/index.ts`, `server/src/routes/{vault,ticket,auth}.ts`. Nothing under `server/src/streams/`
  imports the CRDT engine (no ywasm on this path).
- Feature flag: Worker var `YAOS_STREAMS = "true"`. When it is absent, every route below returns 404 and the
  capability is not advertised.
- Tests: `node tests/run-typescript.mjs --test-aliases tests/server/streams-relay.ts` (15 tests, including a
  Cloudflare row-billing model).
- End-to-end smoke: `node e2e/relay/smoke.ts --host <url>`. See [Running](#running).

All numbers below are the shipped defaults. Constants live in `server/src/streams/protocol.ts`; group-commit and
rate knobs live in `readStreamRelayConfig` (`server/src/streams/relay.ts`).

---

## 1. Model

| Term | Meaning |
|---|---|
| vault | One Durable Object (DO SQLite), addressed by `vaultId`. |
| `vaultEpoch` | The vault generation string (`vaultGeneration`). Seqs are only comparable within one epoch. A new epoch (vault destroyed and re-created) means all client cursors are void. |
| `seq` | Vault-wide, monotonic, **contiguous** integer starting at 1. Every committed row gets the next seq. Rejected, failed and deduplicated appends never consume a seq. |
| stream | An opaque name: any non-empty string of ≤ 256 UTF-8 bytes. Conventions: `ns` (namespace), `b:<docId>` (body), `c:<docId>` (canvas/other CRDT). Only one rule is name-based: `b:*` and `c:*` are broadcast provisionally (§5.2). |
| frame / row | One appended payload: `(stream, deviceId, clientFrameId, payload)`. Once committed it becomes a row `(seq, deviceId, clientFrameId, payload)`. |
| `clientFrameId` | Client-chosen id, 1–128 UTF-8 bytes, **unique per device across the whole vault**. Appends are idempotent by `(deviceId, clientFrameId)`. |
| `head` | The highest committed seq in the vault (0 for an empty vault). |
| checkpoint | Client-produced opaque bytes covering all rows of one stream with `seq ≤ coversSeq`. Written by CAS. It lets the server garbage-collect the covered rows. |

---

## 2. Endpoints, auth and onboarding

All bodies are JSON unless noted. Device routes authenticate with `Authorization: Bearer <deviceToken>`.
Never log tokens, pairing codes or recovery keys.

### 2.1 Discovery

`GET /api/capabilities` → `200`

```json
{ "claimed": true, "streams": 1, "attachments": false, "snapshots": false, "recoveryJobs": false,
  "maxBlobUploadBytes": 10485760, "serverVersion": "1.0.0", "schemaVersion": <n>, "protocolVersion": <n>, ... }
```

The client requires `streams === 1`. `attachments` is `true` only when the R2 bucket is bound (§11.3). Other
fields are legacy (§14).

### 2.2 Claim (fresh server only)

`POST /claim {"operatorRecoveryKey": "<≥32 chars>"}` → `200 {ok, host, vaultId, vaultName, pairingCode, pairingExpiresAt, obsidianUrl, capabilities}`

- This creates the server's first vault and returns a one-time owner pairing code (15 min TTL).
- If `/api/capabilities` says `claimed: true`, the server already has an operator. Use §2.3 instead.
- A just-deployed Worker can answer 503 while the claim is still committing. If so, re-probe capabilities. If
  `claimed` is now `true`, log in with the same key.

### 2.3 Operator console (claimed server: create more vaults)

| Request | Response |
|---|---|
| `POST /operator/login {"operatorRecoveryKey"}` | `200` + `Set-Cookie` (the session cookie; send it back as `Cookie`) |
| `POST /operator/vaults {"name"}` | `200 {vault: {vaultId, state, ...}}` (provisioned synchronously) |
| `POST /operator/vaults/:vaultId/owner-code {"purpose":"owner-bootstrap"}` | `200 {pairingCode, ...}` |
| `POST /operator/vaults/:vaultId/provision {}` | Retries provisioning of a vault left in `provisioning` |

### 2.4 Enroll a device

`POST /enroll {"pairingCode", "enrollmentRequestId", "deviceId", "deviceToken", "deviceName"}`

- **The client generates** every id in the body:
  - `deviceId`: `[A-Za-z0-9_-]{16,128}`;
  - `deviceToken`: `[A-Za-z0-9_-]{32,256}`. Use at least 32 random bytes, base64url-encoded. The server stores only
    a hash of it.
  - `enrollmentRequestId`: `[A-Za-z0-9_-]{16,128}`.
- A body that breaks these rules gets `400 invalid enrollment request`.
- `200 {host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration, originImport, principalId, role, membershipRevision, deviceCredentialRevision, capabilities, principal, actor}`
- `202 {"error":"authorization_fence_pending"}`: the enrollment committed, but the authority fence has not
  settled yet. Retry the identical request after about 1 s.

### 2.5 Pair another device

`POST /vault/:vaultId/auth/pairing-code {"purpose":"device"}` (Bearer, from an enrolled device) → `200 {pairingCode, ...}`.
The new device then calls `/enroll` (§2.4).

### 2.6 Streams ticket

`POST /vault/:vaultId/auth/ticket {"purpose":"streams"}` (Bearer) → `200 {ticket, expiresAt, ttlMs}`

- Body rules: `documentId` may be omitted or `"streams"`. Any other value, or any epoch field, returns
  `400 invalid_ticket_scope`.
- The ticket is an HMAC-signed bearer token: audience `yaos-vault-ws`, purpose `streams`, carrying the actor's
  revisions.
- Lifetime: TTL 5 min (`YAOS_TICKET_TTL_MS`, 1 s – 24 h). It is checked only at socket upgrade and is not
  single-use.
- Fetch a fresh ticket for every connect.

### 2.7 Common HTTP errors (device routes)

| Status | `error` | Client action |
|---|---|---|
| 401 | `unauthorized` | Token unknown or revoked. Stop syncing and re-pair. |
| 403 | capability reason, e.g. `capability_denied` | The role lacks the capability (read-only member). Do not retry. |
| 404 | `unknown_vault`, `not_found` | Wrong vault, or the server runs without `YAOS_STREAMS`. Check capabilities. |
| 409 | `vault_<state>`, `authority_superseded`, `vault_generation_mismatch` | Re-fetch identity. If the epoch changed, reset local cursors. |
| 413 | `body_too_large` | The checkpoint is over 4 MiB. Split or shrink it. |
| 503 | `cf_daily_limit` (+ `resetAt`, `kind`, `Retry-After`) | Free-plan row limit (§11.4). Wait until `resetAt`. |
| 503 | `vault_draining` | Retry with backoff. |

---

## 3. Socket

### 3.1 URL

```
wss://<host>/vault/<vaultId>/ws/streams?ticket=<ticket>&streamsVersion=1
```

`streamsVersion` is the streams wire version, independent of the legacy `schemaVersion` / `protocolVersion`.

**Upgrade rejections in the Worker** (before the DO). Without an `Upgrade: websocket` header these come back as
JSON HTTP errors (401 / 426 / 503). With the header, the server accepts the upgrade, sends one control frame and
closes with **1008**:

```
__YPS:{"type":"error","code":"unauthorized"}                  bad/expired ticket, device revoked, vault not active, epoch changed
__YPS:{"type":"error","code":"unclaimed"}                     server not claimed
__YPS:{"type":"error","code":"update_required","reason":"streams_version_mismatch","clientStreamsVersion":null,"serverStreamsVersion":1}
```

**Upgrade rejections in the DO** come back as plain HTTP. The WebSocket handshake fails, so a browser sees an
error followed by close 1006:

- `409 authority_superseded` (actor revisions are stale);
- `429 stream_socket_limit` + `Retry-After: 1` (more than 1000 streams sockets in the vault);
- `403` when `vault.content.read` is missing.

### 3.2 VAULT_READY (first frame on every accepted socket)

```json
{
  "type": "VAULT_READY",
  "documentId": "streams",
  "socketSessionId": "<uuid>",
  "vaultId": "<vaultId>",
  "vaultGeneration": "<epoch>",
  "vaultEpoch": "<epoch>",
  "runtimeEpoch": "<uuid of this DO runtime>",
  "head": 42,
  "liveness": { "version": 1, "idleMs": 60000, "timeoutMs": 15000 },
  "capabilities": { "streams": 1 },
  "limits": {
    "maxStreamNameBytes": 256, "maxClientFrameIdBytes": 128, "maxPayloadBytes": 1048576,
    "maxBinaryMessageBytes": 1049600, "maxTextMessageBytes": 65536, "maxCheckpointBytes": 4194304,
    "feedDefaultLimit": 1000, "feedMaxLimit": 5000, "readDefaultBytes": 1048576, "readMaxBytes": 4194304,
    "readBatchMaxStreams": 128, "rateBytesPerSec": 262144, "burstBytes": 2097152,
    "groupCommit": { "idleMs": 300, "maxMs": 1500, "maxBytes": 65536, "minIntervalMs": 1000, "leadMs": 20, "quietMs": 1500 }
  },
  "canWrite": true,
  "principalId": "...", "deviceId": "...", "role": "owner",
  "membershipRevision": 1, "deviceCredentialRevision": 1, "policyVersion": 1, "capabilityDigest": "..."
}
```

- `head` is the vault head when the socket was admitted. **Every seq > `head` is delivered live on this
  socket** (§5.3).
- `canWrite` is `false` without `vault.content.write`. Appends are then answered with
  `STREAM_APPEND_REJECTED write_forbidden`.

---

## 4. Messages

Two framings share the socket:

- **Text frames** carry control messages: the literal prefix `__YPS:` followed by one JSON object. The server
  ignores text frames without the prefix, and silently ignores unknown control types.
- **Binary frames** carry data, encoded with the lib0 encoding primitives:
  - `u8`: one byte;
  - `varuint`: unsigned LEB128, 7 bits per byte, low group first, high bit = continuation;
  - `varstring`: varuint UTF-8 byte length, then the bytes;
  - `varbytes`: varuint length, then the bytes.

### 4.1 Binary frames

| Kind (byte 0) | Direction | Layout after the kind byte |
|---|---|---|
| `0x01` APPEND | client → server | `varstring stream`, `varstring clientFrameId`, `varbytes payload` (must consume the whole message) |
| `0x10` PROVISIONAL | server → client | `varstring stream`, `varstring deviceId`, `varstring clientFrameId`, `varbytes payload` |
| `0x11` COMMITTED | server → client | `varuint seq`, `varstring stream`, `varstring deviceId`, `varstring clientFrameId`, `varbytes payload` |
| `0x12` COMMIT_NOTICE | server → client | `varuint seq`, `varstring stream`, `varstring deviceId`, `varstring clientFrameId` (no payload; settles an earlier PROVISIONAL) |

A malformed APPEND closes the socket:

- **1008** for `malformed_frame`, `unknown_frame_kind`, `invalid_stream` or `invalid_client_frame_id`;
- **1009** for `payload_too_large` (over 1 MiB).

A close for a malformed APPEND is a client bug. Do not resend that frame.

### 4.2 Control messages, client → server

| Message | Effect |
|---|---|
| `{"type":"VAULT_PING","probeId":"<1–128 printable chars>"}` | Answered with VAULT_PONG. Send it after `liveness.idleMs` of silence. If no pong arrives within `timeoutMs`, reconnect. |

### 4.3 Control messages, server → client

| Message | When / meaning |
|---|---|
| `VAULT_READY` | §3.2 |
| `STREAM_RECEIPTS {head, receipts:[{stream, clientFrameId, seq, deduped}]}` | Your appends are **durable**. One message per group commit per origin socket. Receipts are in commit (seq) order. `deduped: true` means the row already existed (resend or duplicate) and `seq` is the original seq. |
| `STREAM_APPEND_REJECTED {stream, clientFrameId, code, seq?}` | `code`: `client_frame_id_conflict` (the id was used with different bytes or a different stream; `seq` is the stored row when known) or `write_forbidden`. Final: do not resend. |
| `STREAM_PROVISIONAL_DROPPED {stream, deviceId, clientFrameId, reason}` | A PROVISIONAL you hold will never commit. `reason` is `commit_failed` or `client_frame_id_conflict`. Discard it. The origin resends if it can. |
| `STREAM_RESEND {reason:"runtime_restarted", runtimeEpoch, head}` | The DO runtime restarted under this socket (hibernation wake or eviction). Appends that were buffered but not receipted may be gone. Resend every unacknowledged append. Discard PROVISIONALs older than this message that have no notice yet, and re-read the affected streams if needed. |
| `VAULT_PONG {probeId, documentId:"streams", vaultGeneration, runtimeEpoch, head}` | Liveness reply. `head` doubles as a cheap gap probe. |
| `VAULT_BACKPRESSURE {reason:"relay_rate_limit"}` | Sent just before a **1013** close. |
| `VAULT_ERROR {code:"durability_failed", message, stream, clientFrameIds}` | These appends were not committed (a storage error). Resend later. |
| `VAULT_ERROR {code:"cf_daily_limit", cause:"durability_failed", kind, resetAt, message, stream, clientFrameIds}` | Free-plan daily row limit. Nothing was committed. Hold the queue until `resetAt` (Unix ms, next 00:00 UTC). |
| `error {code:"authority_superseded", reason}` | Sent just before a **4403** close. |

---

## 5. Commit, receipt and broadcast semantics

### 5.1 Group commit

All admitted APPENDs of the vault (from every socket) go into one buffer. The buffer is committed in **one
transaction** at the first of these:

- 300 ms after the last append (idle);
- 1500 ms after the first buffered append (max age);
- 64 KiB of buffered payload;
- **leading edge:** 20 ms after an append that found the buffer empty with no commit in the last 1500 ms
  (`leadMs`, `quietMs`; quietMs 0 = off). Appends inside those 20 ms join it; the idle window does not re-arm it.
  An isolated edit is therefore not held for the idle window. A burst pays at most one extra commit at its start
  (2 rows per stream that commit and the next both touch, §11.5), and there is at most one lead commit per
  quietMs. `minIntervalMs` still holds a lead commit.

It is also committed before authority fences and on graceful drain. The commit assigns contiguous seqs in arrival
order.

Only after the transaction returns does the server send, in this order:

1. COMMITTED and COMMIT_NOTICE frames to the other sockets, in seq order;
2. one `STREAM_RECEIPTS` per origin socket.

The invariant is: **durable before receipt, and no seq is visible before its commit.**

Measured append→receipt latency is about 300 ms plus the round trip inside a burst (§15), and about 20 ms plus
the round trip for an isolated append (leading edge).

### 5.2 Provisional broadcast (`b:*`, `c:*`)

A `b:`/`c:` APPEND is sent at once as PROVISIONAL to every other streams socket that is open at that moment, then
buffered. Every PROVISIONAL is later settled on that socket by exactly one of:

- a `COMMIT_NOTICE` carrying the seq;
- `STREAM_PROVISIONAL_DROPPED`;
- the socket closing;
- a `STREAM_RESEND` (runtime restart; the buffer is gone).

A client may apply provisional bytes optimistically (CRDT updates are commutative and idempotent). It must not
advance any durable cursor until the notice arrives.

`ns` and every other stream are **commit-only**: peers get `COMMITTED` with the seq and the payload. They never
see an uncommitted `ns` frame.

### 5.3 Per-socket delivery guarantees

For a socket admitted with `VAULT_READY.head = H`:

- **Exactly once.** Every seq S > H committed while the socket is open reaches it exactly once. The form depends
  on the socket:
  - `STREAM_RECEIPTS` entry with `deduped:false` if the socket is the origin;
  - `COMMIT_NOTICE` if it holds the PROVISIONAL;
  - `COMMITTED` otherwise.
  Seqs are contiguous, so **any gap means a bug or a lost socket**. Recover with feed + read (§9).
  - `deduped:true` receipts are extra acknowledgements, not deliveries. Example: a second socket of the same device
    re-sends a frame that is still pending. That socket gets the peer delivery and also a deduped receipt.
- **Ordering.**
  - COMMITTED frames arrive in strictly increasing seq order.
  - Notices for new rows are in order. A notice for a frame that was store-deduped (a peer re-sent an old
    `b:` frame) may carry an **older** seq. Treat it as a settle, not as progress.
  - PROVISIONALs follow arrival order at the DO and interleave freely with commits.
- **No echo.** The origin socket never receives its own frames back. Other sockets of the same device do, so
  filter on `deviceId` if needed.
- **No re-delivery.** A deduplicated resend of a commit-only frame is not re-delivered to peers.
- **No filtering.** Every streams socket receives every stream. There is no subscription filter.

### 5.4 Idempotency, resend and conflicts

- **Resend.** Keep every sent APPEND until its receipt or a final rejection arrives. Resend the identical
  `(stream, clientFrameId, payload)`, in original order, when any of these happens:
  - reconnect;
  - `STREAM_RESEND`;
  - `VAULT_ERROR durability_failed`;
  - `cf_daily_limit` after `resetAt`;
  - a 1013 close.
  - Frames buffered before a rate close still commit. Their receipts went to the closed socket, so the resend
    returns `deduped:true` with the original seq.
- **Dedupe scope.** Duplicates are detected:
  - in the pending buffer (vault-wide by `(deviceId, clientFrameId)`, comparing stream and bytes);
  - against the stream's open segment;
  - against the newest sealed segment while the open segment has fewer than 64 rows.
  - Outside that window a resend is appended again with a new seq. Payloads must therefore be idempotent to
    apply, which CRDT updates are. In practice the window covers minutes of activity per stream.
- **Conflicts.** The same `(deviceId, clientFrameId)` with different bytes, or with a different stream while the
  first is pending, gets `client_frame_id_conflict`. Reusing an id across streams after the first frame committed
  is **not** detected. Never reuse ids.

### 5.5 Durability and restarts

- A receipt means the row is in DO SQLite.
- Buffered appends live only in memory until the commit. An isolate eviction loses them unreceipted, and the
  restarted runtime sends `STREAM_RESEND`.
- A graceful drain commits the buffer first. Sockets then close with 1001.
- A deploy of new Worker code drops all sockets (1001 or 1006). Reconnect.

---

## 6. Feed (what changed since S)

`GET /vault/:vaultId/streams/feed?after=<S>&limit=<N>` (Bearer, `vault.content.read`)

```json
{ "vaultEpoch": "...", "head": 57, "changes": [ { "stream": "ns", "lastSeq": 41 }, { "stream": "b:x", "lastSeq": 57 } ], "nextAfter": null }
```

- **Contents.** Lists streams with `lastSeq > after`, ascending by `lastSeq`, each once at its latest seq. It is
  an index range scan over one row per stream.
- **Limits.** `limit` defaults to 1000; the max is 5000 (larger values are clamped).
- **Paging.** `nextAfter` is non-null when more remain; call again with `after = nextAfter`.
- **Cursor.** When `nextAfter` is null, set the feed cursor to `head`.
- **Snapshot.** The page and `head` come from one synchronous DO turn, so they are a consistent snapshot. A
  stream that changes during paging moves past the cursor and shows up on a later page.
- **Buffered appends.** HTTP reads never flush the buffer. Appends that are buffered but not committed are
  invisible here and are not receipted.
- **Errors.** `400 invalid_cursor` and `400 invalid_limit`.

## 7. Catch-up read (rows of one stream)

`GET /vault/:vaultId/streams/read?stream=<name>&after=<S>&maxBytes=<B>[&checkpoint=1]` (Bearer, `vault.content.read`)

```json
{
  "vaultEpoch": "...", "head": 57, "stream": "b:x",
  "lastSeq": 57, "checkpointSeq": 50, "gcSeq": 44,
  "checkpoint": { "coversSeq": 50, "bytes": "<base64>" },
  "rows": [ { "seq": 53, "deviceId": "...", "clientFrameId": "...", "payload": "<base64>" } ],
  "nextAfter": 53
}
```

- **Rows.** Returned oldest first, exactly as appended: unmerged, with standard base64 payloads.
- **Checkpoint inclusion.** `checkpoint` is included when `checkpointSeq > 0` and either:
  - `after < gcSeq` (the rows were collected, so the checkpoint is mandatory); or
  - `checkpoint=1` and `after < checkpointSeq` (you prefer the checkpoint to replaying rows).
  - When included, rows start after `checkpoint.coversSeq`.
- **Page size.** `maxBytes` bounds payload bytes per page, checkpoint included. The default is 1 MiB and the max
  is 4 MiB. A page always carries at least one row or the checkpoint, so it always progresses.
- **Paging.** `nextAfter` is non-null when more rows remain; continue with `after = nextAfter`.
- **Unknown stream.** Returns `200` with `lastSeq: 0` and no rows.
- **Errors.** `400 invalid_stream`, `invalid_cursor` and `invalid_max_bytes`.

### 7.1 Batched read (first pages of many streams)

`GET /vault/:vaultId/streams/read?maxBytes=<B>&r=<after>.<0|1>.<name>&r=...` (same auth). Each `r` entry is a
stream cursor, the `checkpoint` flag and the stream name (URL-encoded; everything after the second `.` is the
name). At most `readBatchMaxStreams` entries (`VAULT_READY.limits`, 128); a relay without that limit has no batch
form.

```json
{ "vaultEpoch": "...", "head": 57, "pages": [ { "stream": "b:x", "lastSeq": 57, "checkpointSeq": 0, "gcSeq": 0,
  "checkpoint": null, "rows": [ ... ], "nextAfter": null }, ... ] }
```

- **Pages.** One per entry, in request order; each is exactly the single-read body without `vaultEpoch`/`head`.
- **Budget.** `maxBytes` (default 1 MiB, max 4 MiB) is shared by the whole batch. The first entry always gets
  its page, as a single read would. A later page that would overrun what is left ends the batch: `pages` is a
  prefix of the entries, and the client re-requests the rest.
- **Why.** On the deployed relay every HTTP request costs about 9 edge RTTs (≈ 220 ms: Worker auth, two config
  Durable Object calls, then the vault Durable Object). A fresh device reads one stream per note, so one request
  per stream made a 1000-note bootstrap take a minute; batching makes it a handful of requests.
- **Errors.** As above, plus `400 invalid_read_entry` and `400 batch_too_large`.

## 8. Checkpoint (CAS put + GC)

`PUT /vault/:vaultId/streams/checkpoint?stream=<name>&coversSeq=<N>&expectedCoversSeq=<M>` (Bearer,
`vault.content.write`). The body is raw `application/octet-stream`, 0 – 4 MiB.

**The client's promise.** The bytes represent the merge of every row of `stream` with `seq ≤ N`. The server
cannot check this.

**CAS rule.** The put succeeds iff the current `checkpointSeq == M`, `N > M`, and `N ≤ lastSeq`.

| Result | Body |
|---|---|
| `200` | `{stream, coversSeq, gcSeq, deletedSegments}` |
| `409 checkpoint_conflict` | `{current:{coversSeq}}`. Another device won. Re-read and rebuild, or keep theirs. |
| `400 checkpoint_not_advancing` | `N ≤ M` |
| `409 checkpoint_ahead_of_stream` | `{lastSeq}` |
| `404 stream_not_found` | The stream has no rows. |
| `400 invalid_stream` / `invalid_covers_seq` (N < 1) / `invalid_expected_covers_seq` | |
| `413 body_too_large` / `503 cf_daily_limit` | |

**GC on success.**

- **What is deleted.** Every sealed segment of the stream whose last seq is ≤ N.
- **`gcSeq`.** Rises to the highest collected seq. Rows ≤ `gcSeq` are only reachable through the checkpoint.
- **What survives.** The open segment (the newest rows, under 64 KiB) is never collected, so readers just behind
  the checkpoint can still replay rows.
- **Live sockets.** They are unaffected.

---

## 9. Recommended client loop

1. `GET /api/capabilities`, then `streams === 1`.
2. Get a ticket, connect, and wait for `VAULT_READY`. Note `vaultEpoch` and `head = H`. Buffer live frames from
   here on.
3. If `vaultEpoch` differs from the stored one, drop all cursors.
4. Feed from the stored vault cursor `C` up to `nextAfter = null`. For every stream you track whose
   `lastSeq > its cursor`, page `read` from that stream's cursor. Always track `ns`.
5. Apply the buffered live frames, skipping seqs ≤ the stream cursor you already hold. Then set `C = max(H, feed head)`.
6. Live:
   - apply COMMITTED;
   - settle PROVISIONALs on NOTICE or DROPPED;
   - drop your outbox entries on receipts.
   - If you detect a gap (a seq jump), a `STREAM_RESEND`, or a reconnect, return to step 4 from `C`.
7. Periodically checkpoint hot streams with CAS on the last known `checkpointSeq`.

---

## 10. Close codes

| Code | Sent when | Client action |
|---|---|---|
| 1000 | Client closed | none |
| 1001 | Server drain (code update, eviction), vault deleted | Reconnect with backoff and a fresh ticket. Resend unacked appends. An unauthorized upgrade after a delete means the vault is gone. |
| 1006 | Network loss, platform reset, or a DO-level upgrade rejection (409/429/403 HTTP) | Reconnect with backoff. Repeated failures: probe the ticket, then capabilities. |
| 1008 | Malformed APPEND, or a Worker upgrade rejection (`error` frame `unauthorized` / `unclaimed` / `update_required` first) | Malformed: client bug, so drop that frame and log it. `unauthorized`: re-ticket, and if the ticket fails 401, re-pair. `update_required`: client too old or new. |
| 1009 | Message over the cap (binary over 1 MiB + 1 KiB, text over 64 KiB) or payload over 1 MiB | Client bug. Never resend that frame; split the payload. |
| 1013 | Rate gate overdraft (`VAULT_BACKPRESSURE relay_rate_limit` first) | Back off for at least 1 s, reconnect, resend unacked appends (deduped), pace sends at or below `rateBytesPerSec`. |
| 4403 | Authority superseded: device revoked, credential rotated, membership or role changed (`error authority_superseded` first) | Fetch a new ticket. A 401 from that means revoked, so stop and re-pair. Otherwise reconnect (capabilities may have changed). |
| 4409 | Never on streams sockets (legacy semantic epoch reset) | n/a |

---

## 11. Limits, capabilities, blobs, daily limit

### 11.1 Limits

| Limit | Value |
|---|---|
| Stream name | 1–256 UTF-8 bytes |
| clientFrameId | 1–128 UTF-8 bytes |
| APPEND payload | 1 MiB (raw binary message ≤ 1 MiB + 1 KiB). Keep encoded frames ≤ 1 MiB to stay within the platform WebSocket message limit. |
| Text (control) message | 64 KiB |
| Checkpoint | 4 MiB, stored in 1 MB rows |
| Feed page | default 1000, max 5000 streams |
| Read page | default 1 MiB, max 4 MiB payload (JSON base64 adds about 33%) |
| Batched read | 128 streams per request (`readBatchMaxStreams`), one page budget for the batch |
| Streams sockets per vault | 1000 (`YAOS_STREAMS_MAX_SOCKETS`) |
| Rate gate (per socket) | Token bucket of 256 KiB/s with a 2 MiB burst, charged on raw received bytes (text counted in UTF-16 units). Overdraft gives 1013. |
| Group commit | 300 ms idle / 1500 ms max / 64 KiB; 20 ms leading edge after 1500 ms without a commit |
| Ticket TTL | 5 min |
| Pairing code TTL | 15 min |

Env overrides (Worker vars, integer strings):

- `YAOS_STREAMS_GC_IDLE_MS`, `YAOS_STREAMS_GC_MAX_MS`, `YAOS_STREAMS_GC_MAX_BYTES`, `YAOS_STREAMS_GC_MIN_INTERVAL_MS`,
  `YAOS_STREAMS_GC_LEAD_MS`, `YAOS_STREAMS_GC_QUIET_MS`;
- `YAOS_STREAMS_RATE_BYTES_PER_SEC`, `YAOS_STREAMS_BURST_BYTES` (floored at the max binary message size);
- `YAOS_STREAMS_MAX_SOCKETS`.

The effective values are echoed in `VAULT_READY.limits`.

### 11.2 Permissions

| Operation | Capability |
|---|---|
| Socket, feed, read | `vault.content.read` |
| APPEND, checkpoint | `vault.content.write` |

Socket authority is re-validated (cached for 5 s) on every append and ping. A failure closes the socket with 4403.

### 11.3 Blobs (R2, optional)

Binary attachments do not go through streams. The legacy content-addressed blob routes remain, and they work only
when the Worker binds `YAOS_BUCKET` (R2). Then `capabilities.attachments` is `true`.

| Route | Capability | Response |
|---|---|---|
| `PUT /vault/:id/blobs/<sha256 hex>` (body ≤ `maxBlobUploadBytes` = 10 MiB) | `vault.attachments.write` | `204`; `400 hash mismatch` |
| `GET /vault/:id/blobs/<sha256 hex>` | `vault.attachments.read` | |
| `POST /vault/:id/blobs/exists {"hashes":[...]}` | `vault.attachments.read` | `{present:[...]}` |

Without the bucket these return `503 attachments_unavailable`. The client-e2e deployment and local dev run
**without R2**, which matches the Free-plan profile; the client must treat attachments as unavailable. A client can
reference blobs from stream payloads by hash.

### 11.4 Cloudflare Free-plan daily limit

- **The limit.** DO SQLite allows 100k rows written and 5M rows read per day. When a write raises
  Cloudflare's limit error, the vault latches `cf_daily_limit` until the next 00:00 UTC.
- **Appends while latched.** They are refused up front: `VAULT_ERROR cf_daily_limit` with `stream` and
  `clientFrameIds`, and no PROVISIONAL is broadcast.
- **Commit failure on the limit.** The origin gets `VAULT_ERROR cf_daily_limit` (the original
  `durability_failed` fields plus `kind`, `resetAt` and `cause`). Peers holding PROVISIONALs get
  `STREAM_PROVISIONAL_DROPPED commit_failed`.
- **HTTP writes.** A checkpoint put whose write hits the limit, or that fails while the latch is active, gets
  `503 {error:"cf_daily_limit", kind, resetAt, message}` with `Retry-After`.
- **Reads.** Feed and read keep working unless the rows-read limit is the one hit.
- **Recovery.** The first successful row write clears a rows-written latch.

### 11.5 Storage and row cost

There are three `WITHOUT ROWID` tables:

- `stream_head`: one row per stream, holding the open segment inline, with an index on `last_seq`;
- `stream_segment`: sealed segments of about 64 KiB (at most 1.5 MB);
- `stream_checkpoint`: 1 MB chunks.

Billed writes:

- **Commit:** 2 rows per touched stream (the head row and its `last_seq` index entry), plus 1 per sealed segment.
  There are no per-frame rows, receipt rows or clock rows. A commit carrying 100 frames into one stream costs 2–3
  rows.
- **Checkpoint put:** the old chunks deleted, plus the new chunks inserted, plus 1 per collected segment, plus 1
  head update.

---

## 12. Contract bends (vs the end-state relay brief)

- **Seq space.** The stream seq space is new and independent of the legacy vault sequence. `vaultEpoch` is the
  existing `vaultGeneration`.
- **Dedupe window.** Dedupe is exact only within the window in §5.4; beyond it, it is best effort. Payloads must be
  idempotent.
- **clientFrameId scope.** Ids must be unique per device vault-wide. Reuse across streams after commit is not
  detected.
- **No subscription filter.** Every socket receives every stream.
- **Restarts.** A provisional is not settled across a runtime restart; the client gets `STREAM_RESEND` instead.
  Buffered appends are memory-only until commit, so receipts are the only durability signal.
- **HTTP reads.** Feed and read do not flush the group-commit buffer.
- **Backups.** Legacy recovery projections (R2) and snapshots do not cover streams. A vault's stream rows live only
  in its DO.
- **Socket version.** The version param is `streamsVersion=1`, not `schemaVersion` / `protocolVersion`.
- **GC.** A checkpoint never collects the open segment. GC removes whole sealed segments, never single rows.
- **Notices for deduped resends.** These may carry older seqs (§5.3).
- **Deployment name.** The account is at Cloudflare's 500 Durable Object namespace cap (error 10067; each YAOS
  Worker uses 3), so the e2e target is the idle `yaos-relay2-scratch-3` redeployed with this code rather than a new
  `yaos-relay2-client-e2e`.

---

## 13. Running

```sh
# local (wrangler dev, DO SQLite persisted under experiments/logs/client-e2e-local-state, YAOS_STREAMS=true, no R2)
scripts/relay-dev/start-local.sh [--port 8787] [--fresh] [--var K=V]
scripts/relay-dev/stop-local.sh

# deploy (cf CLI credentials fed to wrangler; generated server/wrangler.relay2-<suffix>.toml is git-excluded)
scripts/relay-dev/deploy.sh yaos-relay2-scratch-3 [--var K=V]

# smoke (fresh vault per run; claim on a fresh server, operator login on a claimed one)
node e2e/relay/smoke.ts --host http://127.0.0.1:8787 --label local
node e2e/relay/smoke.ts --host https://yaos-relay2-scratch-3.kavinsood.workers.dev --label deployed \
  --operator-context <json file with operatorRecoveryKey>
```

The smoke stores the operator key in a 0600 file at
`experiments/logs/client-e2e-context-<host>.json`. Results (no secrets) go to
`experiments/logs/client-e2e-smoke-<label>-<ts>.json`.

## 14. Legacy server behaviour still present but unused by the new client

The new client must not call any of the following. It all stays in the Worker for now. Removing it is a separate
change, and some of it is still exercised by `legacy-src/` and the relay2 experiments.

- **Semantic sockets.** `/vault/:id/ws/root`, `/ws/body/:bodyId` and `/ws/semantic/:docId` carry server-side Yjs
  sync with root/body epochs. They come with tickets of purpose `root`/`body`/`semantic`, close code 4409 (epoch
  reset), `BODY_CURRENTNESS_QUERY`, the legacy `VAULT_READY` with `documentEpoch`, and the `schemaVersion` /
  `protocolVersion` socket params.
- **Server-side CRDT HTTP.** The engine (ywasm) decodes and merges updates for these routes:
  - body/semantic candidates and lifecycle: `body/:id/candidate`, `body/candidates`, `semantic/:id/candidate`,
    `semantic/lifecycle`, `semantic/authority/promote|demote`;
  - reads: `semantic/:id/head|state`, `body/:id`, `head/:id`, `catch-up`;
  - lifecycle: `lifecycle/create-bulk|batch|publish`, `attachments/publish`;
  - bootstrap: `bootstrap/start`, `bootstrap/:id/root|catalog|semantic-catalog|...`;
  - `operations/:id/outcome`.
  The server also keeps semantic compaction, the legacy vault sequence/journal, `bulkCreate` and snapshots
  (`snapshots`).
- **Relay v2 spike** (`YAOS_RELAY_BODIES`): relay body sockets, `body/:id/compaction-lease`,
  `body/:id/semantic-reset`, `HEAD body/:id`, `debug/relay-table-counts`, `debug/relay-crash`.
- **Recovery.** The recovery projection and recovery jobs (`RecoveryJob` DO, R2), plus the public recovery routes.
- **Settings sync.** `settings-sync/*` (`settingsSync`).
- **Debug/admin.** `debug/recent`, `debug/compact`, `debug/simulate-restart`, `debug/simulate-daily-limit`,
  `debug/sql-rows`.
- **Still used.** Identity and governance routes are shared, not legacy. The new client uses `auth/*`,
  `/enroll`, `/claim` and the operator console. It may use `me`, `members`, `devices`, `invitations`,
  `device-links`, `principals/*`, `ownership/*` and `governance` unchanged.

## 15. Measured (e2e/relay/smoke.ts, 31/31 checks, 2026-10-05)

| ms (p50) | local wrangler dev | deployed (`yaos-relay2-scratch-3`, Workers Free profile) |
|---|---|---|
| ticket | 4.3 | 107 |
| socket connect (upgrade → VAULT_READY) | 6.2 | 317 |
| append → peer PROVISIONAL | 1.1 | 57 |
| append → own receipt (n=9) | 303 | 370 (p90 393) |
| append → peer COMMIT_NOTICE (n=9) | 303 | 357 |
| append → peer COMMITTED (`ns`) | 304 | 395 |
| ping → pong | 1.0 | 67 |
| 12 × 8 KiB burst → last receipt | 309 | 467 |
| feed | 5.5 | 249 |
| read page | 4.1 | 238 |
| checkpoint put (+GC) | 4.8 | 266 |

The table measures the server before its rewrite. There, receipt latency was dominated by the 300 ms idle
group-commit window, and the rest was the round trip; HTTP routes paid Worker auth (a device check in the config DO)
plus the vault DO hop.

The rewritten server (docs/server-rewrite/DECISIONS.md) authenticates devices in the vault DO: no config DO hop
(D2). A commit also waits at least `minIntervalMs` (1000 ms) after the last one (H8). Deployed on the same Worker
(2026-10-06, p50 median of three 31/31 smoke runs), in ms: ticket 91, socket connect 170, peer PROVISIONAL 61, own
receipt 989, peer COMMIT_NOTICE 994, peer COMMITTED 374, ping 64, burst 1150, feed 97, read page 93, checkpoint put
117. Smoke sends each append right after the last receipt, inside `minIntervalMs`. Its first receipt, from idle, takes
372 ms.

---

## 16. TypeScript types

```ts
// ---- binary (lib0 varuint / varstring / varbytes) ----
export const STREAM_FRAME_APPEND = 0x01;        // client -> server
export const STREAM_FRAME_PROVISIONAL = 0x10;   // server -> client
export const STREAM_FRAME_COMMITTED = 0x11;
export const STREAM_FRAME_COMMIT_NOTICE = 0x12;

export interface AppendFrame { stream: string; clientFrameId: string; payload: Uint8Array }
export type ServerStreamFrame =
  | { kind: "provisional"; stream: string; deviceId: string; clientFrameId: string; payload: Uint8Array }
  | { kind: "committed"; seq: number; stream: string; deviceId: string; clientFrameId: string; payload: Uint8Array }
  | { kind: "notice"; seq: number; stream: string; deviceId: string; clientFrameId: string };

// ---- control (text frames: "__YPS:" + JSON) ----
export interface StreamLimits {
  maxStreamNameBytes: number; maxClientFrameIdBytes: number; maxPayloadBytes: number;
  maxBinaryMessageBytes: number; maxTextMessageBytes: number; maxCheckpointBytes: number;
  feedDefaultLimit: number; feedMaxLimit: number; readDefaultBytes: number; readMaxBytes: number;
  readBatchMaxStreams: number; rateBytesPerSec: number; burstBytes: number;
  groupCommit: { idleMs: number; maxMs: number; maxBytes: number; minIntervalMs: number; leadMs: number; quietMs: number };
}
export interface VaultReady {
  type: "VAULT_READY"; documentId: "streams"; socketSessionId: string;
  vaultId: string; vaultGeneration: string; vaultEpoch: string; runtimeEpoch: string; head: number;
  liveness: { version: 1; idleMs: number; timeoutMs: number };
  capabilities: { streams: 1 }; limits: StreamLimits; canWrite: boolean;
  principalId: string; deviceId: string; role: "owner" | "member";
  membershipRevision: number; deviceCredentialRevision: number; policyVersion: number; capabilityDigest: string;
}
export interface StreamReceipt { stream: string; clientFrameId: string; seq: number; deduped: boolean }
export type ClientControl = { type: "VAULT_PING"; probeId: string };
export type ServerControl =
  | VaultReady
  | { type: "STREAM_RECEIPTS"; head: number; receipts: StreamReceipt[] }
  | { type: "STREAM_APPEND_REJECTED"; stream: string; clientFrameId: string;
      code: "client_frame_id_conflict" | "write_forbidden"; seq?: number }
  | { type: "STREAM_PROVISIONAL_DROPPED"; stream: string; deviceId: string; clientFrameId: string;
      reason: "commit_failed" | "client_frame_id_conflict" }
  | { type: "STREAM_RESEND"; reason: "runtime_restarted"; runtimeEpoch: string; head: number }
  | { type: "VAULT_PONG"; probeId: string; documentId: "streams"; vaultGeneration: string; runtimeEpoch: string; head: number }
  | { type: "VAULT_BACKPRESSURE"; reason: "relay_rate_limit" }
  | { type: "VAULT_ERROR"; code: "durability_failed"; message: string; stream: string; clientFrameIds: string[] }
  | { type: "VAULT_ERROR"; code: "cf_daily_limit"; cause?: string; kind: "rows-written" | "rows-read" | "unknown";
      resetAt: number; message: string; stream?: string; clientFrameIds?: string[] }
  | { type: "error"; code: "authority_superseded" | "unauthorized" | "unclaimed" | "update_required";
      reason?: string; clientStreamsVersion?: number | null; serverStreamsVersion?: number };

// ---- HTTP ----
export interface TicketResponse { ticket: string; expiresAt: number; ttlMs: number }
export interface FeedResponse {
  vaultEpoch: string; head: number;
  changes: Array<{ stream: string; lastSeq: number }>;
  nextAfter: number | null;
}
export interface ReadResponse {
  vaultEpoch: string; head: number; stream: string;
  lastSeq: number; checkpointSeq: number; gcSeq: number;
  checkpoint: { coversSeq: number; bytes: string /* base64 */ } | null;
  rows: Array<{ seq: number; deviceId: string; clientFrameId: string; payload: string /* base64 */ }>;
  nextAfter: number | null;
}
export type CheckpointResponse =
  | { stream: string; coversSeq: number; gcSeq: number; deletedSegments: number }            // 200
  | { error: "checkpoint_conflict"; current: { coversSeq: number } }                          // 409
  | { error: "checkpoint_ahead_of_stream"; lastSeq: number; current: { coversSeq: number } }  // 409
  | { error: "checkpoint_not_advancing"; current: { coversSeq: number } }                     // 400
  | { error: "stream_not_found" }                                                             // 404
  | { error: "invalid_stream" | "invalid_covers_seq" | "invalid_expected_covers_seq" | "body_too_large" }
  | { error: "cf_daily_limit"; kind: string; resetAt: number; message: string };              // 503

export const STREAM_CLOSE = {
  normal: 1000, goingAway: 1001, policy: 1008, tooBig: 1009, tryAgainLater: 1013, authoritySuperseded: 4403,
} as const;
```
