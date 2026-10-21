# YAOS relay wire: opaque streams (client remake)

This is the contract between the new client (`src/`) and the relay server (`server/`). The relay is an
authenticated, ordered, durable mailbox. It sequences, stores and forwards **opaque bytes**. It never decodes,
validates, merges, hashes or compacts CRDT content. Merging, checkpoint contents and the meaning of streams all
belong to the client.

- Server code: `server/src/streams/{protocol,store,relay,dedupe}.ts`, wired in `server/src/router.ts` (HTTP routes,
  capabilities) and the vault Durable Object, `server/src/vault/{host,vault,ticket,schema}.ts`. Nothing under
  `server/src/streams/` imports a CRDT engine.
- No feature flag: the rewritten server always serves streams (DECISIONS; `server/src/router.ts` advertises
  `STREAMS_CAPABILITY_VERSION`).
- Tests: `node tests/run-typescript.mjs --test-aliases tests/server/streams-relay.ts` (17 tests, including a
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
| stream | An opaque name: any non-empty string of ≤ 256 UTF-8 bytes. The client's names (`src/core/types.ts:56-84`): `ns` (namespace), `cfg` (settings), `snap` (snapshot index), `k` (keyring, e2ee-design §11), `b:<docId>` (body), `c:<docId>` (canvas/other CRDT). All are client-defined and opaque to the relay. Only one rule is name-based: `b:*` and `c:*` are broadcast provisionally (§5.2). |
| frame / row | One appended payload: `(stream, deviceId, clientFrameId, payload)`. Once committed it becomes a row `(seq, deviceId, clientFrameId, payload)`. |
| `clientFrameId` | Client-chosen id, 1–128 UTF-8 bytes, **unique per device across the whole vault**. Appends are idempotent by `(deviceId, clientFrameId)`. |
| `head` | The highest committed seq in the vault (0 for an empty vault). |
| checkpoint | Client-produced opaque bytes covering all rows of one stream with `seq ≤ coversSeq`. Written by CAS. It lets the server garbage-collect the covered rows. |

---

## 2. Endpoints, auth and onboarding

All bodies are JSON unless noted. Device routes authenticate with `Authorization: Bearer <deviceToken>`; the
pairing-grant routes of §2.4.1 with `Authorization: Grant <grantSecret>`. The two schemes never mix. Never log
tokens, grant secrets, retire keys, pairing codes or recovery keys.

### 2.1 Discovery

`GET /api/capabilities` → `200`

```json
{ "claimed": true, "streams": 1, "attachments": false, "snapshots": false, "recoveryJobs": false,
  "maxBlobUploadBytes": 100000000, "serverVersion": "1.0.0", "schemaVersion": <n>, "protocolVersion": <n>, ... }
```

The client requires `streams === 1`. `attachments` is `true` only when the R2 bucket is bound (§11.3). Other
fields are not read by the client.

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
- The body is exactly these fields. A setup link's client-only part (`key`, or `suite=0`, e2ee-design §12.1) never
  reaches `/enroll` (`src/host/ui/pairing.ts:346-352`; DECISIONS D3).
- `200 {host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration}`: exactly these six fields
  (`server/src/vault/host.ts:599-602`, DECISIONS D3).
- The rewritten server never answers `202 authorization_fence_pending`; the client still retries one with the
  identical body (`src/host/ui/pairing.ts:340-343`).
- A `deviceId` that was ever retired (§2.4.1) answers `409 device_retired`, under any code.

**Grant enroll** ([identity-per-store](identity-per-store.md) §3.2; server phase 1, the client switches in phase 2):
`POST /enroll {"pairingCode", "enrollmentRequestId", "grantSecret", "grantName"}`.

- The client mints `grantSecret` (`[A-Za-z0-9_-]{43,256}`: at least 32 random bytes, base64url); the server stores
  only its SHA-256. A body with both a `grantSecret` and a `deviceId`/`deviceToken` is `400 invalid enrollment
  request`.
- `200 {host, vaultId, grantId, grantSecret, grantName, vaultGeneration}`. `grantId` is minted by the server
  (base64url of 16 bytes); `grantName` is `grantName` trimmed (50 chars, default `unnamed-device`), made unique
  among the live grants and the devices without a grant ("Mac 2"). No device is registered: the client registers
  its first store next (§2.4.1).
- The D3 replay holds with the grant in the device's place: the same code, `enrollmentRequestId` and secret while
  the grant is live → the same 200; another secret, or the old body, under that id → `409
  enrollment_request_conflict`; the grant revoked → `409 used_code`. A secret already used by any grant → `409
  grant_exists`.

#### 2.4.1 Pairing grants and store identities (server phase 1)

A grant is one paired install. Each local store (one IndexedDB) registers its own device under it; a deviceId is
used by one store, ever ([identity-per-store](identity-per-store.md) §1.3). The device token stays the credential of
§2.5–§8: tickets, sockets and every streams route are unchanged.

| Request | Auth | Response |
|---|---|---|
| `POST /vault/:id/auth/device {"deviceId", "deviceToken", "retireKeyHash"}` | `Grant <secret>`, or the `Bearer` of a live device of the same grant | `200 {vaultId, deviceId, deviceName, grantId, vaultGeneration}` |
| `POST /vault/:id/auth/device/retire {"deviceId", "retireKey"}` | the retire key | `200 {ok, deviceId, retired}` |
| `POST /vault/:id/auth/device/status {"deviceIds"}` | `Bearer` | `200 {ok, devices: [{deviceId, state}]}` |
| `DELETE /vault/:id/auth/device` | `Bearer` (any device, a grant's or not) | `200 {ok, deviceId, retired: true}` |
| `DELETE /vault/:id/auth/grant` | `Grant <secret>` | `200 {ok, grantId, revoked, retiredDevices}` |
| `GET /vault/:id/auth/grant` | `Bearer` | `200 {grantId, grantName, grantSecret}` |

- **Register.** `deviceId` and `deviceToken` follow §2.4's formats; `retireKeyHash` is the lowercase hex SHA-256 of a
  client-minted retire key (32+ random bytes, base64url). The device takes the grant's name. The same deviceId,
  token and retire key again → the same 200 (idempotent). Errors: `401 unauthorized` (unknown secret or bearer),
  `401 grant_revoked`, `403 grant_required` (a bearer of a device enrolled without a grant), `400 invalid_request`,
  `409 device_exists` (the id or the token is taken), `409 device_retired`, `429 registration_limit` (+
  `Retry-After` to 00:00 UTC; 20 registrations a UTC day per grant), `409 device_limit` (50 live devices per grant),
  `429 too_many_attempts` (wrong grant secrets and retire keys count against §11.1's 20 failed enrolls a minute).
- **Retire** (the successor's fence, a self-retire or an operator "Remove device") is a D7 revoke plus a tombstone in
  one server turn: the device row is deleted, its buffered frames are dropped, its sockets get
  `authority_superseded` and close 4403, its bearer and tickets get `401`, and the deviceId can never register or
  enroll again. Retire by key: a device that is already gone (or never existed) is `200 {retired: false}`; a wrong
  key, or a device without one, is `401 unauthorized`. Self-retire twice: the second call is `401` (the token is
  dead), which counts as done.
- **Status** (identity-per-store phase 3; DESIGN §i.5 "Abandoned creates"): 1..32 well-formed deviceIds (duplicates
  answered once, in request order); `state` is `live` (registered), `retired` (tombstoned) or `unknown`. It reads
  the registry only, but like registration it first runs the server's lazy inactivity retirement (phase 5: devices
  without a ticket for more than 90 UTC days are retired as by "Remove device", at most one full scan a UTC day), so
  an answer may already reflect it. `400 invalid_request` for an empty, oversized or malformed list.
- **Grant fetch** (phase 5, identity-per-store §3.4): after the operator rotated the grant's secret (`POST
  /operator/vaults/:id/grants/:grantId/rotate`; the old secret is `401 unauthorized` from then on), a live device of
  the grant reads the new one here and its install rewrites data.json. `404 grant_secret_unavailable` (never
  rotated: keep the secret you have), `401 grant_revoked`, `401 unauthorized` (bad bearer), `403 grant_required` (a
  device enrolled without a grant), `409 grant_rotating` (a rotation landed meanwhile: ask again).
- **Leave** revokes the grant and retires all its devices; a revoked grant answers `revoked: false`. The operator's
  `DELETE /operator/vaults/:id/grants/:grantId` ("Revoke pairing") does the same.
- `POST /enroll`'s old device body (§2.4) still enrolls a device without a grant until the client switches.

### 2.5 Pair another device

`POST /vault/:vaultId/auth/pairing-code {"purpose":"device"}` (Bearer, from an enrolled device, or `Grant <secret>`
from a live grant) → `200 {pairingCode, ...}`. A revoked grant gets `401 grant_revoked`. The new device then calls
`/enroll` (§2.4).

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
| 401 | `grant_revoked` | The pairing is revoked (§2.4.1): the install is unpaired. Re-pair. |
| 409 | `device_retired`, `device_exists`, `device_limit` | §2.4.1: mint another identity; at the device limit, retire old stores. |
| 429 | `registration_limit` (+ `Retry-After`) | §2.4.1: 20 registrations a UTC day per grant. Wait. |
| 404 | `unknown_vault`, `not_found` | Wrong vault. |
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

- `409 authority_superseded` (the device is no longer enrolled, `server/src/streams/relay.ts:434`);
- `429 stream_socket_limit` + `Retry-After: 1` (more than 1000 streams sockets in the vault).

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
  "liveness": { "version": 1, "idleMs": 60000, "timeoutMs": 15000, "keepalive": true },
  "capabilities": { "streams": 1 },
  "limits": {
    "maxStreamNameBytes": 256, "maxClientFrameIdBytes": 128, "maxPayloadBytes": 1048576,
    "maxBinaryMessageBytes": 1049600, "maxTextMessageBytes": 65536, "maxCheckpointBytes": 4194304,
    "feedDefaultLimit": 1000, "feedMaxLimit": 5000, "readDefaultBytes": 1048576, "readMaxBytes": 4194304,
    "readBatchMaxStreams": 128, "maxSubscriptions": 128, "rateBytesPerSec": 262144, "burstBytes": 2097152,
    "groupCommit": { "idleMs": 300, "maxMs": 1500, "maxBytes": 65536, "minIntervalMs": 1000, "leadMs": 20, "quietMs": 1500 }
  },
  "rekey": { "removals": 1, "rekeyed": 0 },
  "canWrite": true,
  "principalId": "...", "deviceId": "...", "role": "owner",
  "membershipRevision": 1, "deviceCredentialRevision": 1, "policyVersion": 1, "capabilityDigest": "..."
}
```

- `head` is the vault head when the socket was admitted. **Every seq > `head` is delivered live on this
  socket** (§5.3).
- `canWrite` is always `true`: there are no roles (DECISIONS H4; `server/src/vault/host.ts:667`). On a socket
  with `canWrite: false` the relay would answer appends with `STREAM_APPEND_REJECTED write_forbidden`
  (`server/src/streams/relay.ts:632`).
- `limits.maxSubscriptions` bounds the socket's subscription set (§5.6).
- The client requires `maxPayloadBytes`, `maxCheckpointBytes`, `rateBytesPerSec`, `burstBytes`,
  `feedDefaultLimit`, `readDefaultBytes`, `readBatchMaxStreams` and `maxSubscriptions`, each positive. A
  `VAULT_READY` missing one fails the connect as `update-required` (no client-side defaults).
- `rekey` is the vault's **key-roll signal** (e2ee-design §14.5): `removals` counts the operator's blocking device
  removals ("Revoke pairing", and "Revoke" of a device enrolled without a grant; "Remove device" of a store under a
  live grant, a leave and a self-retire do not count), `rekeyed` is the highest such count a device has covered with
  a new vault key (`VAULT_REKEYED`, §4.2). A roll is due while `removals > rekeyed`. Both are integers ≥ 0 with
  `rekeyed ≤ removals`; they never go back, and a reset or restore keeps them (authority, not content). A device that
  was offline at a removal learns it here, at its next connect. The client requires the field: without it, or
  malformed, the connect fails as `update-required`.

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
| `0x13` STREAM_SKIPPED | server → client | `varuint streamCount`, then per stream: `varstring stream`, `varuint n` (≥ 1), `varuint firstSeq`, `varuint delta` × (n−1) (seq[i] − seq[i−1], each > 0). Committed seqs this socket is not sent (§5.6) |

A malformed APPEND closes the socket:

- **1008** for `malformed_frame`, `unknown_frame_kind`, `invalid_stream` or `invalid_client_frame_id`;
- **1009** for `payload_too_large` (over 1 MiB).

A close for a malformed APPEND is a client bug. Do not resend that frame.

### 4.2 Control messages, client → server

| Message | Effect |
|---|---|
| `{"type":"VAULT_PING","probeId":"<1–128 printable chars>"}` | Answered with VAULT_PONG. Send it after `liveness.idleMs` of silence. If no pong arrives within `timeoutMs`, reconnect. |
| `__YPS:{"type":"VAULT_KEEPALIVE"}` (exactly this text) | Answered with exactly `__YPS:{"type":"VAULT_ALIVE"}`. Only when VAULT_READY has `liveness.keepalive: true`. The runtime answers it itself (`setWebSocketAutoResponse`, server/src/vault/vault.ts), so it does not wake a hibernated vault DO; the relay answers it in code too. The idle probe of choice: the client sends it after `liveness.idleMs` of silence instead of VAULT_PING, except every 10th idle probe, a VAULT_PING (its pong carries `head`, the idle gap check; src/engine/adapters/wsRelay.ts `KEEPALIVE_PING_EVERY`). An older relay never advertises it and gets VAULT_PING. |
| `{"type":"STREAM_SUBSCRIBE","streams":["b:…","c:…",…]}` | Replaces this socket's subscription set (§5.6). No ack; `STREAM_SUBSCRIBE_REJECTED` on invalid input. |
| `{"type":"VAULT_REKEYED","removals":<n>}` | This device's revoke record won (e2ee-design §14.2) after it had seen `n` blocking removals (§3.2 `rekey`). The relay takes `n` only when `rekeyed < n ≤ removals` (1 row, `vault_meta.rekeyed`) and then sends every socket `VAULT_REKEY`; anything else is ignored silently (a late or repeated ack, a count the vault never had, not a positive integer). The socket's device is checked first (D7), so a removed device cannot ack. The client resends it on each new session until a `rekey` shows it taken. |

### 4.3 Control messages, server → client

| Message | When / meaning |
|---|---|
| `VAULT_READY` | §3.2 |
| `STREAM_RECEIPTS {head, receipts:[{stream, clientFrameId, seq, deduped}]}` | Your appends are **durable**. One message per group commit per origin socket. Receipts are in commit (seq) order. `deduped: true` means the row already existed (resend or duplicate) and `seq` is the original seq. |
| `STREAM_APPEND_REJECTED {stream, clientFrameId, code, seq?}` | `code`: `client_frame_id_conflict` (the id was used with different bytes or a different stream; `seq` is the stored row when known) or `write_forbidden`. Final: do not resend. |
| `STREAM_PROVISIONAL_DROPPED {stream, deviceId, clientFrameId, reason}` | A PROVISIONAL you hold will never commit. `reason` is `commit_failed` or `client_frame_id_conflict`. Discard it. The origin resends if it can. |
| `STREAM_RESEND {reason:"runtime_restarted", runtimeEpoch, head}` | The DO runtime restarted under this socket (hibernation wake or eviction). Appends that were buffered but not receipted may be gone. Resend every unacknowledged append. Discard PROVISIONALs older than this message that have no notice yet, and re-read the affected streams if needed. |
| `STREAM_SUBSCRIBE_REJECTED {code, max}` | The last `STREAM_SUBSCRIBE` was refused and the previous set still applies. `code`: `invalid` (not an array, or a name that is not a valid stream name) or `too_many` (more than `max` = `maxSubscriptions` distinct names). |
| `VAULT_PONG {probeId, documentId:"streams", vaultGeneration, runtimeEpoch, head}` | Liveness reply. `head` doubles as a cheap gap probe. |
| `VAULT_BACKPRESSURE {reason:"relay_rate_limit"}` | Sent just before a **1013** close. |
| `VAULT_REKEY {removals, rekeyed}` | The key-roll signal changed (§3.2 `rekey`): to every streams socket of the vault, at a blocking removal (after the removed device's sockets closed 4403) and when a `VAULT_REKEYED` was taken. Event-driven: never sent while the pair stays the same. The client puts it in its status; main prompts for a new vault key while `removals > rekeyed` (e2ee-design §14.5). |
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

A frame whose stream's dedupe index is still building (after a wake) waits for the build, but never longer than
**5 s** after it was admitted (`STREAM_HOLD_MAX_MS`): then it commits with the index built inline, so dedupe still
holds. The env overrides of idle, max, lead and min interval are clamped to the same 5 s.

It is also committed before authority fences and on graceful drain. The commit assigns contiguous seqs in arrival
order.

Only after the transaction returns does the server send, in this order:

1. COMMITTED, COMMIT_NOTICE and STREAM_SKIPPED frames to the other sockets, in seq order (§5.6);
2. one `STREAM_RECEIPTS` per origin socket.

The invariant is: **durable before receipt, and no seq is visible before its commit.**

Measured append→receipt latency is about 300 ms plus the round trip inside a burst (§14), and about 20 ms plus
the round trip for an isolated append (leading edge).

### 5.2 Provisional broadcast (`b:*`, `c:*`)

A `b:`/`c:` APPEND is sent at once as PROVISIONAL to every other streams socket that is open at that moment and
wants the stream (§5.6: every socket that has not subscribed), then buffered. Every PROVISIONAL is later settled on that socket by exactly one of:

- a `COMMIT_NOTICE` carrying the seq;
- `STREAM_PROVISIONAL_DROPPED` (sent only to the sockets that were sent the PROVISIONAL);
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
  - a seq in a `STREAM_SKIPPED` run if it does not want the stream (§5.6; until it subscribes it wants no other
    device's `b:`/`c:` rows);
  - `COMMITTED` otherwise.
  Seqs are contiguous, so **any gap means a bug or a lost socket**. Recover with feed + read (§9).
  - `deduped:true` receipts are extra acknowledgements. Example: a second socket of the same device re-sends a
    frame that is still pending. That socket is a duplicate waiter: like the origin, it gets only the (deduped)
    receipt, no COMMITTED, notice or skip for that frame. A PROVISIONAL it got for the frame before its resend is
    settled by that receipt.
- **Ordering.**
  - COMMITTED frames, new-row notices and skipped seqs arrive in strictly increasing seq order, and every one of
    them for a commit arrives before that commit's `STREAM_RECEIPTS` on the same socket.
  - Notices for new rows are in order. A notice for a frame that was store-deduped (a peer re-sent an old
    `b:` frame) may carry an **older** seq. Treat it as a settle, not as progress.
  - PROVISIONALs follow arrival order at the DO and interleave freely with commits.
- **No echo.** The origin socket never receives its own frames back. Other sockets of the same device do, so
  filter on `deviceId` if needed.
- **No re-delivery.** A deduplicated resend of a commit-only frame is not re-delivered to peers.
- **Filtering only by subscription.** A socket receives payloads as §5.6 says (one that never sent
  `STREAM_SUBSCRIBE` has the empty set), and every other seq as skipped.

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
  - against the rows a retiring checkpoint dropped from the open segment (§8), in its place: deduped, uncompared.
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

### 5.6 Subscriptions (per-stream live push)

Normative. Code: `server/src/streams/relay.ts` (`subscribe`, `wants`, `flush`), `protocol.ts` (`encodeSkipped`).

- **Limit.** `VAULT_READY.limits.maxSubscriptions: 128`.
- **Default.** Every socket starts with the empty set: until it subscribes it is pushed only vault-global streams
  and its own device's rows; every other `b:`/`c:` row reaches it as a skipped seq.
- **Set.** `STREAM_SUBSCRIBE {streams}` replaces the socket's whole set (idempotent, safe to resend). It is
  allowed on read-only sockets and charged to the device's rate bucket like any message.
  - `streams` must be an array of valid stream names (§11.1) with at most `maxSubscriptions` distinct entries;
    repeats count once. Otherwise `STREAM_SUBSCRIBE_REJECTED {code: "invalid" | "too_many", max}`, and the
    previous set stays.
  - Names without a `b:`/`c:` prefix are stored and have no effect: those streams are always pushed.
  - It takes effect for frames admitted and commits flushed after the relay handles the message. There is no ack;
    a later `VAULT_PING` answered by `VAULT_PONG` proves it was handled.
- **wants(socket, row)** is true when any of these holds:
  - the stream is not `b:`/`c:`;
  - the set contains the stream;
  - the row's `deviceId` is the socket's own device (the device's other sockets get its rows, so receipts lost
    with an earlier socket are never deferred).
- **PROVISIONAL** goes only where wants holds. The relay records each frame's recipients; COMMIT_NOTICE and
  `STREAM_PROVISIONAL_DROPPED` go to those recipients only.
- **Per commit, per socket, in frame (seq) order.** The origin and every duplicate waiter of a frame get only
  receipts. Every other socket gets:
  1. `COMMIT_NOTICE` if it was sent the PROVISIONAL (even if it has since unsubscribed);
  2. else, for a newly appended row it wants, `COMMITTED` (also when it subscribed after the PROVISIONAL went out);
  3. else, for a newly appended row it does not want, the seq is added to its pending skip run;
  4. a store-deduped row (§5.3) is neither COMMITTED nor skipped, as before.

  The pending run is sent as one `STREAM_SKIPPED` before the socket's next COMMITTED or COMMIT_NOTICE, and once
  after the commit's last frame, before any `STREAM_RECEIPTS`. So each socket sees every seq once, ascending.
  Within one frame, streams appear in order of their first seq and seqs ascend. A commit may produce several
  STREAM_SKIPPED frames for one socket, interleaved with its live frames.
- **Client handling.** A skipped `(stream, seq)` accounts that seq for the cursor exactly like a delivery, and
  marks the stream stale: read it (§7) when it needs to be current. Subscribing does not make a stream current:
  rows committed before the relay handled the subscribe were skipped.
- **Persistence.** The set lives in relay memory and, when the JSON encoding of its names is at most 1024 UTF-8
  bytes (`SUBSCRIPTION_ATTACHMENT_BYTES`), in the socket attachment as `subs`. A larger set is not persisted. A
  new runtime that adopts the socket (hibernation wake, eviction) restores the persisted set; a socket without one
  (never subscribed, or overflowed) restores as the empty set. A runtime restart always comes with
  `STREAM_RESEND {runtime_restarted}`, and the client resends its set on every `STREAM_RESEND` (cheap, and it
  covers overflow). Until then the rows it would have been pushed arrive as skips, which the client reads (§7)
  like any stale stream. There is no `STREAM_SUBSCRIPTION_RESET`.
- **Counters** (`diagnostics().counters`): `skippedRows`, `skipFrames`, `subscribes`, `subscribeRejects`.

---

## 6. Feed (what changed since S)

`GET /vault/:vaultId/streams/feed?after=<S>&limit=<N>` (Bearer)

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

`GET /vault/:vaultId/streams/read?stream=<name>&after=<S>&maxBytes=<B>[&checkpoint=1]` (Bearer)

`200` with the binary read reply (§7.2) holding one page: `vaultEpoch`, `head`, and for the stream `lastSeq`,
`checkpointSeq`, `gcSeq`, `checkpoint` (`coversSeq` + raw bytes, or none), `rows` and `nextAfter`.

- **Rows.** Returned oldest first, exactly as appended: unmerged, with raw payload bytes.
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
name). At most `readBatchMaxStreams` entries (`VAULT_READY.limits`, 128); the limit is required, and a
request with one entry may use the single-stream read (§7) instead.

`200` with the binary read reply (§7.2): `vaultEpoch`, `head` and one page per served entry.

- **Pages.** One per entry, in request order; each is exactly the page a single read of that entry returns.
- **Budget.** `maxBytes` (default 1 MiB, max 4 MiB) is shared by the whole batch. The first entry always gets
  its page, as a single read would. A later page that would overrun what is left ends the batch: `pages` is a
  prefix of the entries, and the client re-requests the rest.
- **Why.** On the deployed relay every HTTP request costs about 9 edge RTTs (≈ 220 ms: Worker auth, two config
  Durable Object calls, then the vault Durable Object). A fresh device reads one stream per note, so one request
  per stream made a 1000-note bootstrap take a minute; batching makes it a handful of requests.
- **Errors.** As above, plus `400 invalid_read_entry` and `400 batch_too_large`.

### 7.2 Binary read reply

Every successful single or batched read is answered `200` with `Content-Type:
application/vnd.yaos.streams-read.v1+binary` and this lib0 binary body; no `Accept` header is needed:

```
u8        1                               format version
varstring vaultEpoch
varuint   head
varuint   pageCount                       1 for a single read; the served prefix for a batch
page × pageCount:
  varstring stream
  varuint   lastSeq | checkpointSeq | gcSeq
  varuint   nextAfter + 1                 0 = null
  u8        hasCheckpoint                 1: varuint coversSeq | varbytes checkpoint
  varuint   rowCount
  row × rowCount: varuint seq | varstring deviceId | varstring clientFrameId | varbytes payload
```

- **Fields.** The checkpoint rule, paging and the batch budget are those of §7 and §7.1. Payloads and checkpoints
  are raw bytes.
- **Errors are JSON.** Any non-`200` reply has a JSON error body and Content-Type.
- **CORS.** Content-Type is a safelisted response header, so the browser preflight is unchanged.

## 8. Checkpoint (CAS put + GC)

`PUT /vault/:vaultId/streams/checkpoint?stream=<name>&coversSeq=<N>&expectedCoversSeq=<M>` (Bearer). The body is raw `application/octet-stream`, 0 – 4 MiB.

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
- **What survives.** The open segment (the newest rows, under 64 KiB) is kept, so readers just behind the
  checkpoint can still replay rows. Exception: a checkpoint at the stream's `lastSeq` retires the stream (server
  H7, `server/src/streams/store.ts` `putCheckpoint`): the open segment is dropped too and `gcSeq = lastSeq`, so
  every row of the stream is then reachable only through the checkpoint. Those rows stay in the dedupe scope the
  open segment was (§5.4; the server's H2 index keeps their keys): a resend of one is deduped with its original
  seq, without a bytes comparison.
- **Live sockets.** They are unaffected.

---

## 9. Recommended client loop

1. `GET /api/capabilities`, then `streams === 1`.
2. Get a ticket, connect, and wait for `VAULT_READY`. Note `vaultEpoch` and `head = H`. Buffer live frames from
   here on. Send `STREAM_SUBSCRIBE` with the streams you need live (§5.6), and resend it after every
   `STREAM_RESEND`.
3. If `vaultEpoch` differs from the stored one, drop all cursors.
4. Feed from the stored vault cursor `C` up to `nextAfter = null`. For every stream you track whose
   `lastSeq > its cursor`, page `read` from that stream's cursor. Always track `ns`.
5. Apply the buffered live frames, skipping seqs ≤ the stream cursor you already hold. Then set `C = max(H, feed head)`.
6. Live:
   - apply COMMITTED;
   - account STREAM_SKIPPED seqs and mark their streams stale (§5.6);
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
| 1006 | Network loss, platform reset, or a DO-level upgrade rejection (409/429 HTTP) | Reconnect with backoff. Repeated failures: probe the ticket, then capabilities. |
| 1008 | Malformed APPEND, or a Worker upgrade rejection (`error` frame `unauthorized` / `unclaimed` / `update_required` first) | Malformed: client bug, so drop that frame and log it. `unauthorized`: re-ticket, and if the ticket fails 401, re-pair. `update_required`: client too old or new. |
| 1009 | Message over the cap (binary over 1 MiB + 1 KiB, text over 64 KiB) or payload over 1 MiB | Client bug. Never resend that frame; split the payload. |
| 1013 | Rate gate overdraft (`VAULT_BACKPRESSURE relay_rate_limit` first) | Back off for at least 1 s, reconnect, resend unacked appends (deduped), pace sends at or below `rateBytesPerSec`. |
| 4403 | Authority superseded: the device was revoked (`server/src/vault/host.ts:680-700`), or is no longer enrolled when the vault wakes (`server/src/streams/relay.ts:497`) (`error authority_superseded` first) | Fetch a new ticket. A 401 from that means revoked, so stop and re-pair. Otherwise reconnect (capabilities may have changed). |
| 4409 | Never on streams sockets (legacy semantic epoch reset) | n/a |

---

## 11. Limits, capabilities, blobs, daily limit

### 11.1 Limits

| Limit | Value |
|---|---|
| Stream name | 1–256 UTF-8 bytes |
| clientFrameId | 1–128 UTF-8 bytes |
| APPEND payload | 1 MiB (raw binary message ≤ 1 MiB + 1 KiB). Keep encoded frames ≤ 1 MiB to stay within the platform WebSocket message limit. The client caps frame content at `MAX_FRAME_CONTENT_BYTES` = 1015808 (1 MiB − 32 KiB, `src/core/limits.ts:60`), so a padded suite-1 payload still fits (e2ee-design §7.3). |
| Text (control) message | 64 KiB |
| Checkpoint | 4 MiB, stored in 1 MB rows |
| Feed page | default 1000, max 5000 streams |
| Read page | default 1 MiB, max 4 MiB payload (raw bytes in the binary reply) |
| Batched read | 128 streams per request (`readBatchMaxStreams`), one page budget for the batch |
| Subscription set | 128 distinct streams per socket (`maxSubscriptions`); persisted across a wake up to 1024 bytes of names (§5.6) |
| Streams sockets per vault | 1000 (`YAOS_STREAMS_MAX_SOCKETS`) |
| Rate gate (per device, shared by its sockets) | Token bucket of 256 KiB/s with a 2 MiB burst, charged on raw received bytes (text counted in UTF-16 units). Overdraft gives 1013. |
| Group commit | 300 ms idle / 1500 ms max / 64 KiB; 20 ms leading edge after 1500 ms without a commit |
| Ticket TTL | 5 min |
| Pairing code TTL | 15 min |
| Blob body | 100 MB (`maxBlobUploadBytes` = 100000000): Cloudflare's Free/Pro request body limit, not a YAOS policy; `exists` takes at most 50 addresses (§11.3) |
| Blob GC | list page 1000 items; batch delete 1–100 addresses; list and delete together 60 requests/min per vault (§11.3.1) |

Env overrides (Worker vars, integer strings):

- `YAOS_STREAMS_GC_IDLE_MS`, `YAOS_STREAMS_GC_MAX_MS`, `YAOS_STREAMS_GC_MAX_BYTES`, `YAOS_STREAMS_GC_MIN_INTERVAL_MS`,
  `YAOS_STREAMS_GC_LEAD_MS`, `YAOS_STREAMS_GC_QUIET_MS` (the four time knobs except quiet are clamped to 5 s, §5.1);
- `YAOS_STREAMS_RATE_BYTES_PER_SEC`, `YAOS_STREAMS_BURST_BYTES` (floored at the max binary message size);
- `YAOS_STREAMS_MAX_SOCKETS`.

The effective values are echoed in `VAULT_READY.limits`.

### 11.2 Permissions

No roles: every enrolled device may read and write (DECISIONS H4; the vault accepts each socket with `canWrite`
true, `server/src/vault/host.ts:667`). A revoke shuts the device's gate in one synchronous turn and sends each of
its sockets `authority_superseded` + close 4403 (`server/src/vault/host.ts:680-700`).

### 11.3 Blobs (R2, optional)

Binary attachments do not go through streams. The blob routes work only when the Worker binds `YAOS_BUCKET` (R2);
then `capabilities.attachments` is `true`. Every blob route takes the device bearer (`Authorization: Bearer
<deviceToken>`), checked by the vault DO with no config-DO call.

- **Address.** `<address>` is 64 lowercase hex characters, `^[0-9a-f]{64}$`. The server checks the format only and
  never hashes the body, so the address is opaque to it: a plaintext SHA-256 and an E2EE keyed address look alike.
  A client names a blob by `CryptoPort.blobAddress(sha256)`: the sha256 under suite 0, `HMAC(kAddr, sha256)` under
  suite 1 (e2ee-design §10.1), so no plaintext hash reaches the relay in a route or an `exists` body under suite 1.
  The client verifies every blob it downloads (DESIGN §j.1, §j.4).
- **Storage.** The R2 key is `v/<vaultId>/<address>`, with no epoch: a blob survives reset-streams and restore, and
  vault delete purges the prefix.
- **PUT overwrites.** A PUT to an address that exists replaces the bytes and refreshes the object's upload time.

| Route | Request | Response |
|---|---|---|
| `PUT /vault/:id/blobs/<address>` | body 1 B to `maxBlobUploadBytes` (100 MB), with a `Content-Length` | `204`; `413 body_too_large`; `411 length_required`; `400 missing_body`; `400 invalid_content_length` |
| `GET /vault/:id/blobs/<address>` | | `200` the bytes as `application/octet-stream` with `X-Content-Type-Options: nosniff`; `404 {"error":"not found"}` |
| `POST /vault/:id/blobs/exists` | `{"hashes":[<address>, ...]}`, at most 50, body ≤ 64 KiB | `200 {"present":[...]}`: the stored addresses, in request order |
| `GET /vault/:id/blobs?cursor=<next>` | blob GC, §11.3.1 | `200 {"items":[{"address","uploadedAt"}],"next"}`; `503 list_incomplete` |
| `POST /vault/:id/blobs/delete` | blob GC, §11.3.1: `{"ifUploadedBefore":<ms>,"addresses":[<address>, ...]}`, 1 to 100, body ≤ 16 KiB | `200 {"results":[{"address","result":"deleted"\|"newer"\|"absent","uploadedAt"?}]}` |

Checks, in order, on every blob route:

1. No bucket: `503 attachments_unavailable`. The client then fails closed: attachments are not synced, with no
   notice (DESIGN §j.1). `start-local.sh` keeps the bucket (miniflare R2) by default; `--no-r2` drops it, only for
   the store-less test (conformance T-BLOB-UNAVAILABLE).
2. Format: `400 invalid_address` for a malformed `<address>`, the PUT size checks, and the GC cursor and delete-body
   checks below. (The `exists` body is read after the bearer check.)
3. Bearer: `401 unauthorized` (an unknown vault too, §2.7); `503 restore_in_progress` with `Retry-After` during a
   restore.
4. GC routes only: the request limit, `429 too_many_attempts` (§11.3.1).

`exists`:

- Every entry of `hashes` must be an address. One that is not (a non-string, upper case, the wrong length) makes the
  whole request `400 invalid_address`. It is never reported as absent, so a client addressing bug fails loudly
  instead of re-uploading forever.
- At most 50 entries. More is `400 too_many_addresses`, with no R2 call, never an answer for the first 50; send
  batches of at most 50.
- Other errors: `400 "invalid json"`, `400 "missing hashes array"`, `413 body_too_large`.

#### 11.3.1 Blob garbage collection

The server cannot tell which blobs a vault still references (under E2EE it sees only opaque addresses), so blob GC
is the client's mark-and-sweep. The list and the batch delete are the server's part. They are a cold path: a sweep
runs on one device, on a user command or at most monthly.

- **List.** `GET /vault/:id/blobs` lists the vault's blobs in address order (lexicographic), at most **1000** items
  a page (R2's `list` maximum, usually one R2 list call a page, about 90 KiB of JSON).
  - `uploadedAt` is R2's upload time of the object, in ms since the Unix epoch. A PUT overwrite refreshes it.
  - `next` is the cursor of the following page, or `null` after the last page. Treat it as opaque and send it back
    unchanged as `?cursor=`. An absent or empty `cursor` asks for the first page; a malformed one is
    `400 invalid_cursor`.
  - Only `next: null` ends the walk; do not infer the end from a short page.
  - R2 may answer a list call truncated with fewer objects than asked, even none. On an empty truncated answer the
    server keeps listing in the same request with R2's own cursor, up to **10** R2 list calls, until it has items
    or the listing ends. So a page may be short, or empty with `next: null` at the end. If 10 calls bring nothing
    while R2 still says truncated, the answer is `503 {"error":"list_incomplete"}` with `Retry-After: 5`: send the
    same cursor again after that long. `next` is never `null` while R2 says the listing is truncated.
  - Deleting listed blobs between pages (the sweep does) skips nothing. A blob PUT during the walk may or may not
    be listed.
- **Batch conditional delete.** `POST /vault/:id/blobs/delete` with
  `{"ifUploadedBefore": <ms>, "addresses": [<address>, ...]}`. The server reads each object's upload time (R2 `head`,
  at most 6 in flight, the Workers limit on simultaneous open connections), then deletes the objects uploaded strictly
  before `ifUploadedBefore` in one R2 `delete` call.
  - The answer is `200 {"results":[...]}`, one entry per address, in request order:
    - `{"address":…,"result":"deleted","uploadedAt":<ms>}`: it was older; it is gone.
    - `{"address":…,"result":"newer","uploadedAt":<ms>}`: uploaded at or after the cutoff, for example re-uploaded
      during the sweep; it is kept.
    - `{"address":…,"result":"absent"}`: there is no such blob.
  - The body is checked before the bearer and before any R2 call. One bad field refuses the whole call and nothing is
    deleted:
    - a body over 16 KiB: `413 body_too_large`; not a JSON object: `400 invalid_json`;
    - `addresses` missing, not an array or empty: `400 invalid_addresses`; more than 100: `400 too_many_addresses`;
    - an entry that is not an address: `400 invalid_address`; the same address twice: `400 duplicate_address`;
    - `ifUploadedBefore` missing or not a JSON integer from 0 to 2^53 − 1: `400 invalid_if_uploaded_before`.
    - Unknown fields are ignored.
  - A call is one request against the limit below, whatever its size. It is at most 100 heads, 1 delete and 1
    vault-DO call: 102 subrequests to Cloudflare services, within the Workers Free budget of 1000 per invocation
    (https://developers.cloudflare.com/workers/platform/limits/#subrequests), and none external.
  - R2 has no conditional delete. All heads run before the one delete, so a PUT that lands after an address's head
    and before the delete (at most 17 rounds of 6 heads, then the delete) is deleted, and its result still says
    `deleted`. The sweep's grace period (E2EE design §10.4: only blobs listed as uploaded more than 7 days ago) keeps
    the window to re-uploads of long-orphaned bytes. The client narrows it further (E2EE design §10.4: the sweeping
    device re-reads the name table after its deletes and re-uploads any deleted blob that became live, when it has
    the bytes); a blob it has no bytes for is reported lost, not repaired.
- **Limit.** List and batch delete share **60 requests a minute per vault**, counted in the vault DO in memory (a
  restarted vault DO starts a fresh window). A batch delete of up to 100 addresses is one request. Only requests
  with a valid bearer count, and a refused one does not. Over the limit: `429 {"error":"too_many_attempts"}` with
  `Retry-After` in seconds; wait that long. PUT, GET and `exists` are not limited.
- **Cost.** A list request is one vault-DO request plus usually one R2 list (Class A). A batch delete is one
  vault-DO request plus one R2 head (Class B) per address and one R2 delete (free). A sweep of a vault with N blobs
  and D orphans costs about N/1000 + D/100 requests and takes at least that many seconds at the limit.

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
- **Identity** (DECISIONS §6.2): enroll and grant enroll 2 rows; register 2; any retire 2 (the device row and its
  tombstone); revoking a pairing 1 + 2 per live device; a ticket 0, except the first of a UTC day per device, which
  writes its `last_seen_day` (1 row).

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
- **GC.** A checkpoint below `lastSeq` never collects the open segment; one at `lastSeq` drops it (H7, §8). GC
  removes whole segments, never single rows.
- **Notices for deduped resends.** These may carry older seqs (§5.3).
- **Deployment name.** The account is at Cloudflare's 500 Durable Object namespace cap (error 10067; each YAOS
  Worker uses 3), so the e2e target is the idle `yaos-relay2-scratch-3` redeployed with this code rather than a new
  `yaos-relay2-client-e2e`.

---

## 13. Running

```sh
# local (wrangler dev, DO SQLite persisted under experiments/logs/client-e2e-local-<port>-state, R2 by default;
# --no-r2 drops the bucket, --r2 is a no-op)
scripts/relay-dev/start-local.sh [--port 8787] [--fresh] [--r2 | --no-r2] [--var K=V]
scripts/relay-dev/stop-local.sh

# deploy (`cf deploy` as the cf CLI OAuth session; generated server/wrangler.relay2-<suffix>.toml is git-excluded).
# YAOS_BUCKET is bound to the test bucket yaos-relay2-e2e (config.sh rewrites server/wrangler.toml's "yaos", the
# legacy production bucket; the test bucket must exist); RELAY_DEV_R2=0 deploys without it.
scripts/relay-dev/deploy.sh [<yaos-relay2-name>] [--var K=V]

# smoke (fresh vault per run; claim on a fresh server, operator login on a claimed one)
node e2e/relay/smoke.ts --host http://127.0.0.1:8787 --label local
node e2e/relay/smoke.ts --host https://yaos-relay2-scratch-3.kavinsood.workers.dev --label deployed \
  --operator-context <json file with operatorRecoveryKey>
```

The smoke stores the operator key in a 0600 file at
`experiments/logs/client-e2e-context-<host>.json`. Results (no secrets) go to
`experiments/logs/client-e2e-smoke-<label>-<ts>.json`.

## 14. Measured (e2e/relay/smoke.ts, 31/31 checks, 2026-10-05)

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

## 15. TypeScript types

```ts
// ---- binary (lib0 varuint / varstring / varbytes) ----
export const STREAM_FRAME_APPEND = 0x01;        // client -> server
export const STREAM_FRAME_PROVISIONAL = 0x10;   // server -> client
export const STREAM_FRAME_COMMITTED = 0x11;
export const STREAM_FRAME_COMMIT_NOTICE = 0x12;
export const STREAM_FRAME_SKIPPED = 0x13;

export interface AppendFrame { stream: string; clientFrameId: string; payload: Uint8Array }
export type ServerStreamFrame =
  | { kind: "provisional"; stream: string; deviceId: string; clientFrameId: string; payload: Uint8Array }
  | { kind: "committed"; seq: number; stream: string; deviceId: string; clientFrameId: string; payload: Uint8Array }
  | { kind: "notice"; seq: number; stream: string; deviceId: string; clientFrameId: string }
  | { kind: "skipped"; runs: Array<{ stream: string; seqs: number[] }> };  // seqs ascending, ≥ 1 per run

// ---- control (text frames: "__YPS:" + JSON) ----
export interface StreamLimits {
  maxStreamNameBytes: number; maxClientFrameIdBytes: number; maxPayloadBytes: number;
  maxBinaryMessageBytes: number; maxTextMessageBytes: number; maxCheckpointBytes: number;
  feedDefaultLimit: number; feedMaxLimit: number; readDefaultBytes: number; readMaxBytes: number;
  readBatchMaxStreams: number; maxSubscriptions: number; rateBytesPerSec: number; burstBytes: number;
  groupCommit: { idleMs: number; maxMs: number; maxBytes: number; minIntervalMs: number; leadMs: number; quietMs: number };
}
export interface VaultReady {
  type: "VAULT_READY"; documentId: "streams"; socketSessionId: string;
  vaultId: string; vaultGeneration: string; vaultEpoch: string; runtimeEpoch: string; head: number;
  liveness: { version: 1; idleMs: number; timeoutMs: number; keepalive?: true };
  capabilities: { streams: 1 }; limits: StreamLimits; rekey: RekeySignal; canWrite: boolean;
  principalId: string; deviceId: string; role: "owner" | "member";
  membershipRevision: number; deviceCredentialRevision: number; policyVersion: number; capabilityDigest: string;
}
/** e2ee-design §14.5: blocking removals, and the highest count a new vault key covers. Due while removals > rekeyed. */
export interface RekeySignal { removals: number; rekeyed: number }
export interface StreamReceipt { stream: string; clientFrameId: string; seq: number; deduped: boolean }
export type ClientControl =
  | { type: "VAULT_PING"; probeId: string }
  | { type: "STREAM_SUBSCRIBE"; streams: string[] }
  | { type: "VAULT_REKEYED"; removals: number };
export type ServerControl =
  | VaultReady
  | { type: "STREAM_RECEIPTS"; head: number; receipts: StreamReceipt[] }
  | { type: "STREAM_APPEND_REJECTED"; stream: string; clientFrameId: string;
      code: "client_frame_id_conflict" | "write_forbidden"; seq?: number }
  | { type: "STREAM_PROVISIONAL_DROPPED"; stream: string; deviceId: string; clientFrameId: string;
      reason: "commit_failed" | "client_frame_id_conflict" }
  | { type: "STREAM_SUBSCRIBE_REJECTED"; code: "invalid" | "too_many"; max: number }
  | { type: "STREAM_RESEND"; reason: "runtime_restarted"; runtimeEpoch: string; head: number }
  | { type: "VAULT_PONG"; probeId: string; documentId: "streams"; vaultGeneration: string; runtimeEpoch: string; head: number }
  | { type: "VAULT_BACKPRESSURE"; reason: "relay_rate_limit" }
  | ({ type: "VAULT_REKEY" } & RekeySignal)
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
/** A decoded binary read reply (§7.2); a single read has exactly one page. */
export interface ReadPage {
  stream: string; lastSeq: number; checkpointSeq: number; gcSeq: number;
  checkpoint: { coversSeq: number; bytes: Uint8Array } | null;
  rows: Array<{ seq: number; deviceId: string; clientFrameId: string; payload: Uint8Array }>;
  nextAfter: number | null;
}
export interface ReadReply { vaultEpoch: string; head: number; pages: ReadPage[] }
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
