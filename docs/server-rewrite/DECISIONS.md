# YAOS server rewrite: decisions

Status: draft for review. Branch `server-remake`. Wire baseline: `docs/client-remake/relay-wire.md` ("the
contract"). IDs are stable. No decision is silently changed: where the shared spec looks incomplete or wrong,
section 8 flags it with a recommendation.

Budget profile: Cloudflare Workers Free. 100k rows written/day, 5M rows read/day, 100k DO requests/day, 10 ms
CPU, 5 GB DO storage, 2 MB max row. PITR keeps 30 days and does not exist in local dev.

---

## 1. Scope and non-goals (D1)

- **In scope.** One person, many devices: one operator per server, any number of vaults.
- **E2EE.** Single-user E2EE (client-side CryptoPort suite 1) is in scope, so the server stays fully opaque. It
  never interprets payloads, checkpoints, stream names or blob contents.
- **Cloudflare only, fresh deploy.** The core keeps small injected ports (storage, sockets, clock) so tests run it
  on Node. No migration, no dual writes; clients re-seed from disk.
- **Removed (not deferred).** Members, invitations, principals, ownership, governance, device-links, the read-only
  role; shared E2EE vaults; server-side CRDT (semantic sockets, candidates, bootstrap, catch-up, compaction,
  snapshots, recovery jobs); settings sync, relay v2 bodies, bulk create, update-metadata; `packages/server-node`
  and the Docker image.
- **Size.** Keep about 2.2k lines, write about 3k. Delete about 42.8k in `server/src` and 4.1k in
  `packages/server-node`.

---

## 2. Architecture

### 2.1 Responsibilities

| Component | Owns | Never does |
|---|---|---|
| Worker (stateless) | Route table; method/path match; size caps; format checks (vaultId `^[A-Za-z0-9_-]{22}$`, pairing code, blob address, `streamsVersion=1`); body streaming to the DO; unread-body drain in `finally`; R2 I/O for blobs; `claimed=true` cached in isolate memory forever once seen | Crypto; config-DO reads on device routes; storage writes |
| Vault DO (`idFromName(vaultId)`) | `vault_meta` (vaultId, generation = epoch, ticket key); devices; pairing codes; bearer auth; ticket issue and verify; streams store and relay; dedupe index; per-device rate and socket caps; revoke; reset; restore; daily-limit latch | Calls to the config DO |
| Config DO (singleton `idFromName("config")`) | Operator credential hash; operator sessions; vault registry (id, name, createdAt); claim; in-memory login-failure limiter | Being on the hot path. Only `/claim`, `/operator/*` and pre-claim `/api/capabilities` reach it |

Gone: the config→vault authority mirror, the authorization fence, `202 authorization_fence_pending`, the 5 s
actor-authority TTL cache, vault lifecycle states, and the `YAOS_STREAMS` flag (streams are always on).

### 2.2 Route table

Auth: `-` none, `C` operator session cookie, `B` device bearer, `T` streams ticket. Everything not listed → `404
{"error":"not_found"}` with zero DO calls.

| Route | Auth | Worker work | DO(s) |
|---|---|---|---|
| `GET /api/capabilities` | - | answers from the isolate cache once `claimed` | config, only until `claimed` is seen |
| `POST /claim` | - | key ≥ 32 chars; JSON ≤ 64 KiB; mints vaultId | vault (init, owner code), config (claim) |
| `POST /operator/login`, `/operator/logout` | -, C | | config |
| `GET /operator/state` | C | | config |
| `POST /operator/vaults` | C | mints vaultId | vault (init), then config (register) |
| `POST /operator/vaults/:id/owner-code` | C | | config (session, registry), vault |
| `DELETE /operator/vaults/:id` | C | R2 prefix purge | config, vault |
| `GET /operator/vaults/:id/devices` | C | | config, vault |
| `DELETE /operator/vaults/:id/devices/:deviceId` | C | | config, vault |
| `POST /operator/vaults/:id/reset-streams` | C | | config, vault |
| `POST /operator/vaults/:id/restore` | C | | config, vault |
| `POST /enroll` | code | code regex; vaultId taken from the code | vault |
| `POST /vault/:id/auth/pairing-code` | B | | vault |
| `POST /vault/:id/auth/ticket` | B | | vault |
| `GET /vault/:id/ws/streams` | T | `streamsVersion` check (1008 `update_required`) | vault |
| `GET /vault/:id/streams/feed`, `/streams/read` | B | | vault |
| `PUT /vault/:id/streams/checkpoint` | B | Content-Length ≤ 4 MiB else 413; streams body | vault |
| `PUT`/`GET /vault/:id/blobs/:addr`, `POST /vault/:id/blobs/exists` | B | address regex; ≤ 10 MiB; R2 I/O | vault (bearer check only) |
| `POST /vault/:id/debug/simulate-daily-limit` | B | only when `YAOS_DEBUG_ROUTES=1`, else 404 | vault |

The console page (`GET /`), `GET /mobile-setup` and CORS preflight are not in the D5 list. See F5.

### 2.3 Deleted (by subsystem, `wc -l` today)

| Subsystem | Files | Lines |
|---|---|---|
| Semantic document plane | vaultDocumentStore, vaultDocumentCache, vaultSocketService, vaultSemanticService, vaultCandidateService, semanticCompaction*, vaultBootstrapStore, vaultBulkCreateService, vaultLifecycleService, vaultCatalogStore, vaultStore, vaultObjectStore, bootstrap, contracts | 12,415 |
| Recovery | recovery*.ts, vaultRecoveryService | 9,955 |
| Relay v2 spike | relayBodies, relayBodyStore, relayRoutes, relayTail, relayFlag | 3,316 |
| Collaboration/governance | collaboration*, controlPlaneSql, vaultAuthority | 2,744 |
| Legacy config + identity | config, identity (rewritten as the config DO) | 2,449 |
| DO host | server.ts (rewritten as the vault DO) | 2,241 |
| Worker + routes | index.ts, routes/* (rewritten) | 2,636 |
| Shared CRDT/canvas codecs | shared/* except socketLiveness, socketCloseCodes | 2,086 |
| CRDT glue | crdt/* | 1,512 |
| Setup page | setupPage.ts (replaced by the console) | 1,445 |
| Settings sync | settingsSyncStore | 880 |
| Bench/debug | storageBenchmarkWorker, sqlRowCounter, testOnlyTimers | 697 |
| Node host | packages/server-node; Dockerfile, compose.yaml, Docker release job | 4,088 |

Kept (about 2.2k): streams/{protocol,relay,store} 1,387; dailyLimit 263; socketLiveness 260; readBoundedBytes
138; base64url 76; setupQr 29; hex 24; version 14; socketCloseCodes 2. `vaultId.ts` is rewritten to the strict
22-char check.

New code (about 3k): Worker router 350, vault DO host 700, config DO 300, strict codec 100, relay deltas
(H2/H3/H5/H6/H7/H8) 400, blobs 120, console 450, WB tests 600. The BB conformance suite is extra.

---

## 3. Decisions D2–D9

**D2 Topology.** As in §2.1. `/api/capabilities` needs only `claimed`, and the Worker caches `true` forever.
*Why:* the config DO was a serial hop on every device request (§15: ticket 107 ms p50 deployed) and the source of
the fence. *Tests:* T-ENROLL-200 (BB), T-HOTPATH (WB: feed, read, checkpoint, ticket, socket, enroll and
pairing-code make zero config-DO calls, checked with a counting stub).

**D3 Pairing codes.**
- Format `<vaultId>.<secret>`: base64url(16 B) = 22 chars, `.`, base64url(24 B) = 32 chars; 55 in total.
- The Worker trims and checks `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$`. Malformed → `400 invalid_code`, no DO call.
- The vault DO looks up SHA-256(secret) by PK. An unknown vault → `invalid_code` with zero writes and no DDL.
  Expired → `410 expired_code`; used → `409 used_code` (today's statuses).
- TTL 15 min. Purposes: `owner-bootstrap`, `owner-recovery`, `device`. Limiter: in memory, 20 failures/min per
  vault DO → `429 too_many_attempts`.
- The server never sees key material. A future client-only key part must be stripped before `/enroll`.
- *Why:* routing by code removes the config lookup, and 192 bits make brute force moot. *Tests:* T-PAIR-FORMAT,
  T-PAIR-MALFORMED, T-PAIR-UNKNOWN-VAULT, T-PAIR-USED (BB), T-PAIR-NOWRITE (WB). Gaps: F1, F2.

**D4 Tickets.**
- Key: 32 random bytes per vault in `vault_meta`, made at init, never exported or rotated. The vault DO issues
  tickets and verifies them at upgrade, with the key and device map in memory.
- Payload as today (vaultId, deviceId, D6 constants, aud, purpose, documentId, iat, exp, nonce), signed with the
  vault key. Wire unchanged: aud `yaos-vault-ws`, purpose `streams`, TTL 5 min (`YAOS_TICKET_TTL_MS`).
- Issuing costs 0 rows (the lastSeen "touch device" write is dropped). Upgrade rejections keep the §3.1 shape
  (accept, `error` frame, close 1008); the DO now produces them.
- *Why:* a key per vault makes cross-vault replay impossible by construction. *Tests:* T-TICKET-CROSS-VAULT,
  T-TICKET-BAD (BB).

**D5 Surviving routes.** Exactly the §2.2 table plus the console (F5); everything else → 404.
- The console is one server-rendered page with inline JS and no external assets. It covers claim, login, the
  vault list, create vault, owner code + QR (`setupQr.ts`), devices + revoke, and reset streams behind a typed
  vaultId confirmation.
- Operator JSON routes require `Content-Type: application/json` and a same-origin `Origin`. The cookie is
  HttpOnly, Secure, SameSite=Strict, 7 days.
- *Why:* the rest serves only cut subsystems. *Tests:* T-LEGACY-404 (BB: members, invitations, governance,
  device-links, settings-sync, catch-up, bootstrap/start, legacy `DELETE /operator/devices/:id`), T-DEVICES-LIST (BB:
  deviceId, deviceName, no token material).

**D6 VAULT_READY constants.**
- `role:"owner"`, `canWrite:true`, `membershipRevision:1`, `deviceCredentialRevision:1`, `policyVersion:1`.
- `principalId` = `owner:<vaultId>`, the same in the enroll response.
- `capabilityDigest` = today's `capabilityDigestForRole("owner")` value, frozen as a literal.
- Every §3.2 field stays; the `write_forbidden` path is removed. *Why:* the shape stays for the shipped client;
  the authority model is gone. *Test:* T-READY-SHAPE.

**D7 Device revoke.** `DELETE /operator/vaults/:id/devices/:deviceId`: operator-only, idempotent, `200 {ok,
deviceId, revoked}`.
- It deletes the device row and its in-memory entry. In the same turn, each live socket of the device gets
  `__YPS:{"type":"error","code":"authority_superseded"}` and close 4403.
- The bearer then gets 401 on every device route, ticket included. The DO also checks the device at upgrade, so
  an unexpired ticket stops working. Frames already in the buffer still commit (F17).
- *Why:* one DO, so no TTL cache and no fence. *Tests:* T-REVOKE-4403, T-REVOKE-401.

**D8 Epoch.** vaultEpoch == vaultGeneration: random base64url(16), minted at vault init. Device credentials are
bound to the vaultId only. *Why:* an epoch means only "the stream space was replaced"; credentials survive it.

**D8a reset-streams.** Request `{"confirmVaultId"}` (mismatch → `400 confirmation_mismatch`) → `200
{vaultEpoch}`.
- One `transactionSync` deletes every row of the 3 stream tables and writes a new generation. Then the pending
  buffer, head cache and dedupe index are discarded and streams sockets close 1001. Devices stay enrolled.
- *Test:* T-RESET. Cost: F16.

**D8b restore.** Request `{"at": ISO8601}`.
- Step 1: `getBookmarkForTime(at)`, `onNextSessionRestoreBookmark(bookmark)`, `ctx.abort()`.
- Step 2, on the new runtime: rotate the epoch and set `last_restore_at`. A repeat whose `at` equals
  `last_restore_at` returns the current epoch and does nothing, so the route is idempotent.
- *Test:* T-RESTORE-MANUAL. Gaps: F9.

**D8c epoch param.** Feed, read and checkpoint take an optional `epoch=`.
- The check runs right after bearer auth, before any other validation or effect. Absent → no check.
- Mismatch (empty included) → `409 {"error":"vault_generation_mismatch","vaultEpoch":"<current>"}`.
- *Tests:* T-EPOCH-MISMATCH, T-EPOCH-MATCH, T-EPOCH-ABSENT.

**D9 Blobs (R2 only).**
- Address `^[0-9a-f]{64}$`: format check only, no SHA-256 check. PUT overwrites. Body ≤ 10 MiB
  (`maxBlobUploadBytes`), else 413. `exists` takes ≤ 50 addresses.
- No `YAOS_BUCKET` → `503 attachments_unavailable` and `capabilities.attachments=false`.
- The R2 key drops the generation (F3).
- *Why:* E2EE addresses are HMAC(vaultKey, hash), which the server cannot check; the client verifies on download.
  *Tests:* T-BLOB-OPAQUE (SKIP when `attachments=false`), T-BLOB-UNAVAILABLE.

---

## 4. Hardening H1–H8

**H1 Strict codec.** It replaces lib0 `readVarString`/`readVarUint` on the APPEND path. lib0 turns invalid UTF-8
into U+FFFD and accepts non-minimal varuints.
- Strings: `TextDecoder("utf-8", {fatal: true, ignoreBOM: true})` (`ignoreBOM` keeps a leading U+FEFF). Varuints:
  minimal (no trailing `0x00` group) and ≤ 2^53.
- Every length must fit the remaining bytes, and the message must be fully consumed.
- Any violation → close 1008 `malformed_frame`.
- *Why:* two byte strings must never alias one stream name or frame id. *Tests:* T-CODEC-UTF8, T-CODEC-SURROGATE
  (`ED A0 80`), T-CODEC-OVERLONG (`C0 AF`), T-CODEC-NONMINIMAL (`0x82 0x00`), T-CODEC-TRAILING, T-CODEC-VALID
  (`"b:é✓😀"`).

**H2 Dedupe window.** A resend is deduped exactly when its original is among the newest W stored-row bytes of its
stream.
- W ≥ burst + maxPayload + gcMaxBytes = 2 MiB + 1 MiB + 64 KiB ≈ 3.06 MiB. **W = 4 MiB.**
- The pending buffer stays exact and vault-wide.
- *Why:* today's window collapses to the last sealed segment, so after 3×600 KiB every frame but the last is
  re-appended on resend.

Index:
- **Shape.** One lazy index per stream: `Map<hash53(deviceId 0x00 clientFrameId) → seq>`, plus a ring of
  (hash, rowBytes) to trim entries older than W.
- **Build.** On the first append to a stream in a runtime, one bounded scan: the head (usually cached), then
  `SELECT bytes FROM stream_segment WHERE stream=? ORDER BY first_seq DESC LIMIT 64`, stopping at ≥ W. It parses
  only key bytes and skips payloads by length.
- **Maintenance.** Each commit adds its rows. **Hit.** Load the row (open: 0 rows; sealed: 1) and compare bytes.
  Equal → `deduped:true` with the original seq; different → `client_frame_id_conflict` with seq. A collision on
  another key is not a hit.
- **Rows read, worst case.** Every sealed segment is ≥ 64 KiB (an end-of-commit seal needs ≥ 64 KiB, a mid-commit
  seal > 1.5 MB − 1 MiB). So one scan reads ≤ 64 segments + 1 head = **65 rows** (≤ W + 1.5 MB), once per stream
  per runtime.
  The 5M budget allows ≈ 76.9k cold scans/day; a realistic load (200 wakes × 10 hot streams) is ≈ 130k rows/day (2.6%).
- **Memory bound.** The minimum row is 21 B (seq 1, deviceId 1+16, cfid 1+1, len 1), so one stream holds
  ≤ 199,728 entries, about 12 MB at about 60 B/entry (typical 250 B rows: ≤ 17k entries, about 1 MB). DO-wide cap:
  262,144 entries (about 16 MB), by LRU eviction of whole streams; an evicted stream rescans (≤ 65 rows).
- Update §5.4 (section 5). *Tests:* T-DEDUPE-LARGE (3×600 KiB), T-DEDUPE-SMALL (400×4 KiB), T-DEDUPE-CONFLICT.
  Issues: F12, F18.

**H3 Commit-failure typing.** The relay classifies its own commit errors; the `decorateControl` rewrite goes.
- Daily limit → `VAULT_ERROR cf_daily_limit {cause:"durability_failed", kind, resetAt, message, stream,
  clientFrameIds}`.
- Anything else → `durability_failed` plus an additive `retryAfterMs = round(min(30000, 1000·2^(n−1)) ·
  (0.5 + 0.5·rand))`, where n counts consecutive failed commits in the runtime and resets on success.
- The checkpoint, feed and read handlers map daily-limit errors to `503 cf_daily_limit` themselves.
- *Why:* errors are typed at the source, so there is no latch race. *Tests:* T-COMMIT-DAILY-WB, T-COMMIT-RETRY-WB (WB,
  new IDs), T-DAILY (BB, via `POST /vault/:id/debug/simulate-daily-limit`, only with `YAOS_DEBUG_ROUTES=1`).

**H4 Authority before write_forbidden.** Resolved by design: no roles, `canWrite` always true, and revoke closes
synchronously. *Tests:* covered by T-REVOKE-4403 and T-READY-SHAPE.

**H5 Socket cache.** A `Map<WebSocket, Attachment>` with per-device lists, each attachment parsed once per socket
per runtime; maintained on accept, close and error, rebuilt from `ctx.getWebSockets()` after a wake. *Why:* today
`streamSockets()` walks every socket on every call. *Test:* T-SOCKET-CACHE-WB (WB, new ID).

**H6 Per-device limits.**
- One in-memory token bucket per deviceId (256 KiB/s, 2 MiB burst, full after a wake), shared by its sockets. An
  overdraft closes the overdrawing socket (BACKPRESSURE, 1013).
- Cap of 4 sockets per device: a 5th connect closes that device's oldest socket with 1001, then accepts. This
  runs before the vault-wide check, so a device at its cap can always reconnect.
- The vault-wide cap of 1000 (`429 stream_socket_limit`, `Retry-After: 1`) stays.
- *Why:* the limit must bind the writer, not the socket. Ghost sockets after a network switch are the usual 5th.
  *Tests:* T-RATE-DEVICE, T-RATE-SOCKET, T-SOCKET-CAP-DEVICE. Issue: F13.

**H7 Retired-stream GC.**
- When `coversSeq == lastSeq`, the head UPDATE also sets `open=NULL, open_rows=0, tail_first=NULL, gc_seq=lastSeq`.
  Sealed segments are all ≤ N and deleted as today; the head row stays. Cost: still 1 row (no indexed column in SET).
- Client note: sealed segments of a retired stream are only collected if the client writes a final checkpoint.
- Update §8. *Tests:* T-RETIRED-GC, T-PARTIAL-GC.

**H8 minIntervalMs.**
- Default 1000 (`YAOS_STREAMS_GC_MIN_INTERVAL_MS` still overrides), echoed in `VAULT_READY.limits.groupCommit`.
- The idle flush waits `max(idleMs, lastCommitAt + 1000 − now)`; the max (1500 ms) and bytes (64 KiB) triggers stay.
- Small writes: ≤ 1 commit/s/vault, about 2–4 rows/s while typing, so 100k rows ≈ 7–14 h of continuous editing.
- *Tests:* T-MININTERVAL-READY, T-MININTERVAL-TIMING (≥ ~900 ms between back-to-back commits). Issue: F14.

**BASELINE** (unchanged behaviour, must stay green): T-OVERSIZE-1009, T-CKPT-MULTICHUNK (2.5 MB), T-TWO-SOCKETS,
T-HAPPY.

---

## 5. Contract delta against relay-wire.md

Classes: **additive** (new; old clients unaffected), **relaxation** (the server accepts or promises more),
**tightening** (it accepts or promises less), **removal** (gone).

| § | Old → new | Class | Client action |
|---|---|---|---|
| 2.1 | Capabilities: keep `claimed`, `streams:1`, `attachments`, `maxBlobUploadBytes`, `serverVersion`. Drop `schemaVersion`, `protocolVersion`, `snapshots`, `recoveryJobs`, `settingsSync`, `semanticCanvas`, `bulkCreate`, `relayBodies`, `storageFormatVersion`, `snapshotFormatVersion`, `settingsFormatVersion`, `update*` | removal | none (pairing.ts reads only the kept five) |
| 2.2 | Claim body/response unchanged; already claimed → `409 already_claimed` | none | none |
| 2.3 | + `GET …/devices`, `DELETE …/devices/:deviceId`, `POST …/reset-streams`, `POST …/restore`; `/provision` → 404 (F7); `DELETE /operator/vaults/:id` takes `{"confirmVaultId"}` (F6) | additive / removal | none |
| 2.4 | Pairing code: "8–512 printable" → `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$` after trim; malformed → `400 invalid_code`; unknown → `404 invalid_code` (was `unknown_code`, F2) | tightening | none: `enrollHttpError` maps both codes; strip any client-only key part |
| 2.4 | `202 authorization_fence_pending` → never sent | removal | none (the retry loop becomes dead code) |
| 2.4 | 200 body: keep `host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration` + D6 constants; drop `originImport, capabilities, principal, actor` (F10) | removal | none |
| 2.5 | Pairing-code response `{pairingCode, expiresAt, purpose, obsidianUrl, mobileSetupUrl?}`; purpose `device` only (absent = device; else `400 invalid_purpose`) | tightening | none |
| 2.6 | Ticket wire unchanged; issued by the vault DO | none | none |
| 2.7 | Removed: `403 capability_denied`, `409 vault_<state>`, `503 vault_draining`. `409 vault_generation_mismatch` gains `vaultEpoch` | removal / additive | none |
| 3.1 | `unclaimed` frame never sent (F4); DO-level `409 authority_superseded` and `403` at upgrade removed; `unauthorized` and `update_required` frames unchanged; 429 stays | removal | treat as `unauthorized` (already mapped) |
| 3.2 | `canWrite` always true; D6 constants; the `write_forbidden` note is removed; `groupCommit.minIntervalMs` 0 → 1000 | removal / tightening | read `limits`; set receipt timeouts ≥ maxMs + RTT |
| 4.3 | `STREAM_APPEND_REJECTED write_forbidden` removed. `VAULT_ERROR durability_failed` + `retryAfterMs` (ms, number) | removal / additive | when present, wait `retryAfterMs` before resending |
| 5.1 | Idle flush deferred to `lastCommitAt + minIntervalMs` | tightening | none |
| 5.4 | Dedupe scope (text below) | relaxation | none |
| 6, 7, 8 | Optional `epoch=<vaultEpoch>`; mismatch or empty → `409 {"error":"vault_generation_mismatch","vaultEpoch"}` before any effect | additive | send it; on 409 switch to the returned epoch (new local DB) |
| 8 | GC text (below) | tightening | write a final checkpoint at `lastSeq` to retire a stream |
| 10 | 1001 also means "replaced by a newer socket of the same device"; 4403 only on revoke | additive | none |
| 11.1 | Rate gate per socket → per device; + "Streams sockets per device: 4, a 5th evicts the oldest (1001)"; group commit row gains "1000 ms min interval" | tightening | one socket per vault per device |
| 11.2 | Permissions table and the 5 s authority cache removed; revoke closes at once | removal | none |
| 11.3 | `<sha256 hex>` → `<64 lowercase hex address>`; no hash check; `400 hash mismatch` removed; PUT overwrites; capability names gone | relaxation / removal | verify downloads client-side |
| 11.4 | Unchanged; the simulate route exists only with `YAOS_DEBUG_ROUTES=1` | none | none |
| 11.5 | + three identity tables; enroll 2 rows, revoke 1, ticket 0 | additive | none |
| 13 | `YAOS_STREAMS` flag gone; the Node/Docker host gone | removal | none |
| 14 | Everything listed → 404, including "Still used": `me`, `members`, `devices` (vault-level), `invitations`, `device-links`, `principals/*`, `ownership/*`, `governance` | removal | none (`src/` calls none of them) |
| 15 | HTTP routes no longer pay a config-DO hop; receipt p50 rises toward 1 s for back-to-back commits | informational | none |
| 16 | `role` type stays `"owner" \| "member"`; only `"owner"` is sent | none | none |

New §5.4 "Dedupe scope":

> Duplicates are detected in the pending buffer (vault-wide by `(deviceId, clientFrameId)`, comparing stream and
> bytes) and against every committed row among the newest 4 MiB (stored row bytes) of the stream. Outside that
> window a resend is appended again with a new seq. The window covers more than one burst plus one max payload
> plus one commit batch, so every resend this section requires is deduped.

New §8 "What survives":

> When `N < lastSeq`, the open segment (the newest rows, under 64 KiB) survives, so readers just behind the
> checkpoint can still replay rows. When `N == lastSeq`, the open segment is dropped too and `gcSeq = lastSeq`.
> The stream keeps only its head and the checkpoint, and every read below `gcSeq` returns the checkpoint. Sealed
> segments are only collected by a checkpoint, so a retired stream needs a final checkpoint at `lastSeq`.

---

## 6. Storage

### 6.1 Vault DO schema

The DDL runs once, at vault init, and never on a request path (T-PAIR-NOWRITE). The three stream tables are
unchanged from `streams/store.ts`:

- `stream_head(stream PK, last_seq, ckpt_seq, gc_seq, tail_first, open_rows, open BLOB) WITHOUT ROWID` + index
  `stream_head_last_seq(last_seq)`;
- `stream_segment(stream, first_seq, last_seq, rows, bytes, PK(stream, first_seq)) WITHOUT ROWID`;
- `stream_checkpoint(stream, chunk, covers_seq, bytes, PK(stream, chunk)) WITHOUT ROWID`.

New:

```sql
CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vault_id TEXT NOT NULL, vault_generation TEXT NOT NULL,
  ticket_key BLOB NOT NULL,            -- 32 random bytes, never leaves the DO
  created_at INTEGER NOT NULL,
  last_restore_at INTEGER              -- D8b idempotency
) WITHOUT ROWID;
CREATE TABLE device (
  token_hash BLOB PRIMARY KEY,         -- SHA-256(deviceToken)
  device_id TEXT NOT NULL, device_name TEXT NOT NULL,
  enrollment_request_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL
) WITHOUT ROWID;                       -- no secondary index: revoke scans (a few rows)
CREATE TABLE pairing_code (
  code_hash BLOB PRIMARY KEY,          -- SHA-256(secret)
  purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
  used_request_id TEXT, used_device_id TEXT   -- F1 replay key
) WITHOUT ROWID;
```

Probing an unknown vault reads `vault_meta`; "no such table" means unknown, cached in memory (init runs in the same
object, so the cache stays coherent). Rows read per runtime: meta 1 + devices N, then 0 per bearer auth. deviceId
uniqueness is checked in code in the same synchronous turn. Minting a code prunes rows expired over 24 h.

### 6.2 Rows written per operation (cfRowModel rules)

| Operation | Statements | CF rows |
|---|---|---|
| Vault init | INSERT meta (DDL not billed by the model; one-time) | 1 |
| Enroll | UPDATE pairing_code (used_*) + INSERT device | 2 |
| Enroll replay (F1) | none | 0 |
| Pairing / owner code | INSERT pairing_code (+1 per pruned row) | 1 |
| Ticket | none (key and devices in memory) | 0 |
| Revoke | DELETE device | 1 |
| Reset | DELETE H heads + S segments + C chunks; UPDATE meta | H+S+C+1 |
| Restore step 2 | UPDATE meta | 1 |
| Commit | per touched stream: head UPDATE/INSERT (last_seq indexed) = 2; +1 per sealed segment | 2/stream + 1/seal |
| Checkpoint | DELETE old chunks (k₀) + INSERT new chunks (k₁) + DELETE collected segments (g) + UPDATE head (SET has no `last_seq`) | k₀+k₁+g+1 |
| Retired GC (H7) | same head UPDATE | +0 |
| Dedupe index (H2) | memory only | 0 |

### 6.3 Config DO schema

```sql
CREATE TABLE operator (id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash BLOB NOT NULL, claimed_at INTEGER NOT NULL) WITHOUT ROWID;   -- SHA-256(recovery key ≥ 32 chars)
CREATE TABLE session (token_hash BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE vault (vault_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
```

`claimed` = the operator row exists. Rows written: claim 3 here (operator, vault, session) + 2 in the vault DO
(meta, code); login 1 (+1 per pruned session); logout 1; create vault 1 + 1 in the vault DO; delete vault 1 + the
vault DO's `deleteAll()` (not measured).

---

## 7. Acceptance matrix

"scratch-3" is a guess for today's `yaos-relay2-scratch-3` (legacy server, `YAOS_STREAMS=true`, no R2). `*` marks a
WB test: it never runs against scratch-3, so the guess is what today's code would do. BB files live in
`e2e/conformance/` (the file names are suggestions for the suite owner). WB files live in `tests/server/`.

| ID | What | Kind | scratch-3 | Where |
|---|---|---|---|---|
| T-HAPPY | enroll 2 devices, append b:/ns, receipts, provisional/committed, feed, read, checkpoint | BB | PASS | baseline.ts |
| T-TWO-SOCKETS | two devices see each other's frames live | BB | PASS | baseline.ts |
| T-OVERSIZE-1009 | binary > 1 MiB + 1 KiB closes 1009 | BB | PASS | baseline.ts |
| T-CKPT-MULTICHUNK | 2.5 MB checkpoint round-trips (3 chunks) | BB | PASS | baseline.ts |
| T-ENROLL-200 | first enroll is 200 with the §2.4 fields, never 202 | BB | PASS (202 possible) | identity.ts |
| T-HOTPATH | zero config-DO calls on the 7 device paths | WB | FAIL* | hotpath.ts |
| T-PAIR-FORMAT | minted codes match the D3 regex, prefix = vaultId | BB | FAIL | identity.ts |
| T-PAIR-MALFORMED | malformed code → 400 invalid_code | BB | FAIL | identity.ts |
| T-PAIR-UNKNOWN-VAULT | well-formed code, unknown vault → invalid_code | BB | FAIL (unknown_code) | identity.ts |
| T-PAIR-USED | second use → 409 used_code | BB | PASS | identity.ts |
| T-PAIR-NOWRITE | unknown vault: 0 rows written, no DDL | WB | FAIL* | pairing.ts |
| T-ENROLL-REPLAY | identical retry → 200, same device (proposed, F1) | BB | PASS | identity.ts |
| T-TICKET-CROSS-VAULT | vault A ticket on vault B → 1008 unauthorized | BB | PASS | identity.ts |
| T-TICKET-BAD | tampered, expired or garbage ticket → 1008 unauthorized | BB | PASS | identity.ts |
| T-LEGACY-404 | the D5 legacy list → 404 | BB | FAIL | identity.ts |
| T-DEVICES-LIST | deviceId and deviceName, no token material | BB | FAIL (404) | identity.ts |
| T-READY-SHAPE | D6 constants, every §3.2 field | BB | PASS | streams.ts |
| T-REVOKE-4403 | revoke → error frame + 4403 at once | BB | FAIL (route) | identity.ts |
| T-REVOKE-401 | revoked bearer → 401 on ticket, feed, read, checkpoint, pairing-code | BB | FAIL (route) | identity.ts |
| T-RESET | new epoch, empty streams, 1001 closes, devices kept | BB | FAIL | epoch.ts |
| T-RESTORE-MANUAL | restore to T, epoch rotates, repeat is a no-op (deployed only) | manual | n/a | manual-restore.ts |
| T-EPOCH-MISMATCH | wrong or empty epoch → 409 + vaultEpoch, no effect | BB | FAIL | epoch.ts |
| T-EPOCH-MATCH | matching epoch → normal | BB | PASS | epoch.ts |
| T-EPOCH-ABSENT | no param → normal | BB | PASS | epoch.ts |
| T-BLOB-OPAQUE | non-SHA 64-hex address PUT/GET/exists, overwrite | BB | SKIP (no R2) | blobs.ts |
| T-BLOB-UNAVAILABLE | 503 attachments_unavailable, attachments=false | BB | PASS | blobs.ts |
| T-CODEC-UTF8 | invalid UTF-8 → 1008 | BB | FAIL | codec.ts |
| T-CODEC-SURROGATE | `ED A0 80` → 1008 | BB | FAIL | codec.ts |
| T-CODEC-OVERLONG | `C0 AF` → 1008 | BB | FAIL | codec.ts |
| T-CODEC-NONMINIMAL | `0x82 0x00` → 1008 | BB | FAIL | codec.ts |
| T-CODEC-TRAILING | trailing byte → 1008 | BB | PASS | codec.ts |
| T-CODEC-VALID | `"b:é✓😀"` accepted | BB | PASS | codec.ts |
| T-DEDUPE-LARGE | 3×600 KiB, reconnect, resend → deduped, original seqs | BB | FAIL | streams.ts |
| T-DEDUPE-SMALL | 400×4 KiB resend → deduped | BB | FAIL | streams.ts |
| T-DEDUPE-CONFLICT | same id, other bytes → client_frame_id_conflict + seq | BB | PASS | streams.ts |
| T-DEDUPE-COLD-WB | the same after a runtime restart; ≤ 65 rows read | WB | FAIL* | dedupe.ts |
| T-DAILY | simulated limit → VAULT_ERROR cf_daily_limit; checkpoint 503 | BB | SKIP (no `YAOS_DEBUG_ROUTES`) | daily.ts |
| T-COMMIT-DAILY-WB | the relay types the daily limit itself | WB | PASS* (same wire) | relay-commit.ts |
| T-COMMIT-RETRY-WB | durability_failed + retryAfterMs, backoff, reset | WB | FAIL* | relay-commit.ts |
| T-SOCKET-CACHE-WB | attachment parsed once per socket per runtime | WB | FAIL* | socket-cache.ts |
| T-RATE-DEVICE | two sockets of one device share one bucket → 1013 | BB | FAIL | streams.ts |
| T-RATE-SOCKET | one socket overdraft → BACKPRESSURE + 1013 | BB | PASS | streams.ts |
| T-SOCKET-CAP-DEVICE | 5th socket evicts the oldest with 1001 | BB | FAIL | streams.ts |
| T-RETIRED-GC | ckpt at lastSeq → gcSeq=lastSeq, read = checkpoint only | BB | FAIL | streams.ts |
| T-PARTIAL-GC | ckpt below lastSeq → open survives | BB | PASS | streams.ts |
| T-MININTERVAL-READY | VAULT_READY minIntervalMs 1000 | BB | FAIL | streams.ts |
| T-MININTERVAL-TIMING | back-to-back commits ≥ ~900 ms apart | BB | FAIL | streams.ts |
| T-ROWS-WB | every §6.2 row count under cfRowModel | WB | n/a | rows.ts |

---

## 8. Open questions and flags

Each item keeps the spec as written and gives a recommendation.

- **F1 Enrollment idempotency is missing (D3).** `pairing.ts` re-sends the identical `/enroll` body after a network
  failure, relying on `enrollmentRequestId`; under D3 the retry gets `used_code`. *Rec:* store `used_request_id`
  and `used_device_id`. Same id + deviceId + token hash → replay 200 (0 rows). Same id with another body → `409
  enrollment_request_conflict`. Add T-ENROLL-REPLAY.
- **F2 No status for a well-formed unknown code.** Today it is `404 unknown_code`. *Rec:* `404 invalid_code` for
  an unknown vault and an unknown secret alike; the client maps both codes.
- **F3 Blob keys include `vaultGeneration` today**, so D8a and D8b would orphan every blob. *Rec:* key
  `v/<vaultId>/<address>`; vault delete purges the prefix.
- **F4 The §3.1 `unclaimed` frame needs a config read at upgrade**, which T-HOTPATH forbids. *Rec:* drop it. An
  unclaimed server has no vaults, so the DO answers `unauthorized`.
- **F5 D5's "everything else → 404" also catches the console** (`GET /`), `GET /mobile-setup` (the target of
  `mobileSetupUrl` and the claim QR) and CORS preflight. *Rec:* allow all three as static Worker responses.
- **F6 The body of `DELETE /operator/vaults/:id` is unspecified** (today: `governanceRequestId`). *Rec:*
  `{"confirmVaultId"}`. Order: sockets 1001 + `deleteAll()`, then the R2 prefix purge (1000 per batch), then the
  registry row. An incomplete purge → `503 purge_incomplete`, retryable.
- **F7 `/provision` (§2.3): drop it.** The Worker mints the vaultId, runs the idempotent vault init first and
  writes the registry row last. A listed vault is therefore always initialized, there is no `provisioning` state
  to retry, and the client never calls the route. A failed registration leaves an unreachable 1-row orphan DO;
  that is accepted.
- **F8 Claim spans two DOs.** Order: vault init → config claim (operator, vault and session in one write) →
  owner code. A failure after the claim → 503; per §2.2 the user re-probes, logs in and uses owner-code.
- **F9 D8b rolls back devices and pairing codes.** Devices revoked after T return (this breaks D7), devices
  enrolled after T vanish, and writes can land between the steps. *Rec:* the Worker snapshots the device table
  (hashes only) before step 1; step 2 restores that snapshot, clears codes and rotates the epoch. Document the
  window.
- **F10 The enroll 200 body is unspecified.** *Rec:* the six fields the client reads plus the D6 constants. Drop
  `originImport`, `capabilities`, `principal` and `actor`.
- **F11 Device routes on an unknown vault.** §2.7 says `404 unknown_vault`. *Rec:* `401 unauthorized`: there is no
  existence oracle, and it matches revoke and §10's "unauthorized after a delete".
- **F12 H2 cold-scan CPU.** 200k tiny rows can exceed 10 ms CPU. With the memory cap, "one scan per runtime"
  becomes "one per eviction". *Rec:* key-only parsing; measure in P3; if still over, chunk the scan and gate that
  stream's commit on it.
- **F13 H6 eviction ping-pong.** Five live clients on one device evict each other forever. *Rec:* close reason
  `device_socket_limit`; the client backs off at least 30 s on it.
- **F14 H8 bounds only small writes.** The 64 KiB trigger still commits back to back (≤ 4/s/device at the rate
  gate). Accept, and state it in §11.5.
- **F15 Dropping `packages/server-node` breaks the WB harness.** `streams-relay.ts` and `cfRowModel.ts` import its
  `storage.ts` (678 lines). `packages/cli` (5.5k lines, the legacy schema-6 daemon) also stops working. *Rec:*
  move a trimmed adapter into `tests/server/helpers/` first; delete or freeze `packages/cli` explicitly.
- **F16 D8a cost.** Reset bills one row per stream row. A daily-limit hit rolls the transaction back → `503
  cf_daily_limit`. *Rec:* measure DROP+CREATE billing on workerd; use it if it is cheaper.
- **F17 Buffered frames of a revoked device.** The spec is silent. *Rec:* commit them, as today (they were accepted
  while authorized). No receipt is sent.
- **F18 Dedupe against rows that GC has already collected.** Entries with `seq ≤ gcSeq` cannot be byte-compared.
  *Rec:* answer `deduped:true` with the original seq; the checkpoint covers it.

---

## 9. Work plan

| Phase | Work | Exit criterion |
|---|---|---|
| P0 Conformance baseline | BB suite in `e2e/conformance/` for every BB row of section 7; run against scratch-3 and local `wrangler dev` | The suite runs end to end; scratch-3 results recorded, with every difference from the section 7 guesses explained |
| P1 Host skeleton | New Worker router, vault DO and config DO classes; streams core behind ports; legacy and server-node deleted (harness moved first, F15); README "Cloudflare only" | Ported streams WB tests green; T-LEGACY-404 and T-HOTPATH harness in place; `tsc`/lint clean |
| P2 Identity | Claim, login and sessions, vaults, owner code, D3 codes, enroll (+F1), D4 tickets, devices list and revoke | D2–D7 BB + BASELINE green on local dev; T-PAIR-NOWRITE, T-HOTPATH, T-ROWS-WB (identity rows) green |
| P3 Hardening | H1–H8, D8a/D8c, D9 (F3 keys) | Every BB row except T-RESTORE-MANUAL green locally (T-BLOB-OPAQUE with local R2); all WB green; F12 CPU measured |
| P4 Console | `GET /` page and `GET /mobile-setup` (F5) | Manual run on local dev: claim → vault → QR → enroll → revoke → reset; no external assets |
| P5 Deploy over scratch-3 | The coordinator deploys: one migration that deletes the old DO classes and adds the two new ones (the account is at the namespace cap) | The full suite is green on scratch-3 except the documented SKIPs; T-RESTORE-MANUAL done once by hand; §15 latencies re-measured |
