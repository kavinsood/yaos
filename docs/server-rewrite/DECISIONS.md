# YAOS server rewrite: decisions

Status: approved 2026-10-06; implementation under way (section 9). Branch `server-remake`. Wire baseline:
`docs/client-remake/relay-wire.md` ("the contract"). IDs are stable. The review flags F1–F18 are folded into the
decisions; section 8 logs where each one landed.

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
  snapshots, recovery jobs); settings sync, relay v2 bodies, bulk create, update-metadata; `packages/server-node`,
  the Docker image and `packages/cli` (already deleted on this branch, §2.3).
- **Size.** Keep about 2.2k lines, write about 3k. Delete about 42.8k in `server/src`, 4.1k in
  `packages/server-node` and 5.3k in `packages/cli`.

---

## 2. Architecture

### 2.1 Responsibilities

| Component | Owns | Never does |
|---|---|---|
| Worker (stateless) | Route table; method/path match; size caps; format checks (vaultId `^[A-Za-z0-9_-]{22}$`, pairing code, blob address, `streamsVersion=1`); body streaming to the DO; unread-body drain in `finally`; R2 I/O for blobs; `claimed=true` cached in isolate memory forever once seen | Crypto; config-DO reads on device routes; storage writes |
| Vault DO (`idFromName(vaultId)`) | `vault_meta` (vaultId, generation = epoch, ticket key); devices; pairing codes; bearer auth; ticket issue and verify; streams store and relay; dedupe index; per-device rate and socket caps; the blob GC request limit (memory); revoke; reset; restore steps; daily-limit latch | Calls to the config DO |
| Config DO (singleton `idFromName("config")`) | Operator credential hash; operator sessions; vault registry (id, name, createdAt); restore journal, steps and alarm (D8b); claim; in-memory login-failure limiter | Being on the hot path. Only `/claim`, `/operator/*` and pre-claim `/api/capabilities` reach it |

Gone: the config→vault authority mirror, the authorization fence, `202 authorization_fence_pending`, the 5 s
actor-authority TTL cache, vault lifecycle states, and the `YAOS_STREAMS` flag (streams are always on).

### 2.2 Route table

Auth: `-` none, `C` operator session cookie, `B` device bearer, `T` streams ticket. Everything not listed → `404
{"error":"not_found"}` with zero DO calls.

| Route | Auth | Worker work | DO(s) |
|---|---|---|---|
| `GET /`, `GET /mobile-setup` | - | static HTML (D5) | none |
| `OPTIONS` on `/api/*`, `/enroll`, `/vault/*` | - | static CORS preflight, 204 | none |
| `GET /api/capabilities` | - | answers from the isolate cache once `claimed` | config, only until `claimed` is seen |
| `POST /claim` | - | key ≥ 32 chars; JSON ≤ 64 KiB; mints vaultId | vault (init), config (claim), vault (owner code); order in D5 |
| `POST /operator/login`, `/operator/logout` | -, C | | config |
| `GET /operator/state` | C | | config (also lists pending restore journal rows) |
| `POST /operator/vaults` | C | mints vaultId; no `/provision` (D5) | vault (init), then config (register) |
| `POST /operator/vaults/:id/owner-code` | C | | config (session, registry), vault |
| `DELETE /operator/vaults/:id` | C | `{"confirmVaultId"}`; R2 prefix purge; order in D5 | config, vault |
| `GET /operator/vaults/:id/devices` | C | | config, vault |
| `DELETE /operator/vaults/:id/devices/:deviceId` | C | | config, vault |
| `POST /operator/vaults/:id/reset-streams` | C | | config, vault |
| `POST /operator/vaults/:id/restore` | C | | config (session, journal, steps), vault |
| `POST /enroll` | code | code regex; vaultId taken from the code | vault |
| `POST /vault/:id/auth/pairing-code` | B | | vault |
| `POST /vault/:id/auth/ticket` | B | | vault |
| `GET /vault/:id/ws/streams` | T | `streamsVersion` check (1008 `update_required`) | vault |
| `GET /vault/:id/streams/feed`, `/streams/read` | B | | vault |
| `PUT /vault/:id/streams/checkpoint` | B | Content-Length ≤ 4 MiB else 413; streams body | vault |
| `PUT`/`GET /vault/:id/blobs/:addr`, `POST /vault/:id/blobs/exists` | B | address regex; ≤ 100 MB with a Content-Length; `exists` ≤ 50 entries; R2 I/O | vault (bearer check only) |
| `GET /vault/:id/blobs?cursor=`, `POST /vault/:id/blobs/delete` | B | cursor format; delete body ≤ 16 KiB with 1–100 distinct addresses and a cutoff; R2 list (≤ 10 calls), or ≤ 100 heads then one delete (D9 GC) | vault (bearer check + GC limit) |
| `POST /vault/:id/debug/simulate-daily-limit` | B | only when `YAOS_DEBUG_ROUTES=1`, else 404 | vault |

Device routes on an unknown vault answer as for a bad credential: `401 unauthorized` (at upgrade: `unauthorized`
frame + 1008). There is no existence oracle, and it matches revoke and §10's "unauthorized after a delete".
*Test:* T-UNKNOWN-VAULT-401.

### 2.3 Deleted (by subsystem, `wc -l` before deletion)

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
| Node host | packages/server-node; Dockerfile, compose.yaml, .dockerignore, tests/docker/smoke.mjs, Docker CI and release jobs | 4,088 |
| Legacy CLI | packages/cli (the schema-6 daemon) | 5,282 |

The Node host and the legacy CLI are already deleted on this branch. The trimmed SQLite adapter that
`streams-relay.ts` and `cfRowModel.ts` need lives in `tests/server/helpers/`. The `server/src` rows go in P1.
*Why:* code excluded from the build rots; git log keeps it if it is ever wanted back.

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

**D3 Pairing codes and enroll.**
- Format `<vaultId>.<secret>`: base64url(16 B) = 22 chars, `.`, base64url(24 B) = 32 chars; 55 in total.
- The Worker trims and checks `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$`. Malformed → `400 invalid_code`, no DO call.
- The vault DO looks up SHA-256(secret) by PK. An unknown vault and an unknown secret both → `404 invalid_code`;
  an unknown vault costs zero writes and no DDL. Expired → `410 expired_code`; used → `409 used_code` (today's
  statuses).
- **Replay (mandatory).** The code row keeps `used_request_id` and `used_device_id`. The same
  `enrollmentRequestId` + deviceId + token hash on the same code, while that device row still exists → the same
  200 body, 0 rows. `deviceName` is not part of the key (a rename-only retry replays the stored name). The same id
  with another deviceId or token → `409 enrollment_request_conflict`. The device row is gone (revoked) → `409
  used_code`: a replay never resurrects a device. *Why:* if the 200 drops on the network, the client retries;
  without replay it gets `used_code` and the pairing is lost.
- **200 body.** Exactly `host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration`: the fields
  `readEnrollment` reads (`src/host/ui/pairing.ts`). The D6 constants belong to VAULT_READY only.
- TTL 15 min. Purposes: `owner-bootstrap`, `owner-recovery`, `device`. Limiter: in memory, 20 failures/min per
  vault DO → `429 too_many_attempts`.
- The server never sees key material. A future client-only key part must be stripped before `/enroll`.
- *Why:* routing by code removes the config lookup, and 192 bits make brute force moot. *Tests:* T-PAIR-FORMAT,
  T-PAIR-MALFORMED, T-PAIR-UNKNOWN-VAULT, T-PAIR-USED, T-ENROLL-REPLAY, T-ENROLL-CONFLICT, T-ENROLL-BODY (BB),
  T-PAIR-NOWRITE (WB).

**D4 Tickets.**
- Ticket key: 32 random bytes per vault in `vault_meta` (`ticket_key`), made at init, never exported or rotated.
  The vault DO issues tickets and verifies them at upgrade, with the key and device map in memory.
- Payload as today (vaultId, deviceId, D6 constants, aud, purpose, documentId, iat, exp, nonce), signed with the
  ticket key. Wire unchanged: aud `yaos-vault-ws`, purpose `streams`, TTL 5 min (`YAOS_TICKET_TTL_MS`).
- Issuing costs 0 rows (the lastSeen "touch device" write is dropped). Upgrade rejections keep the §3.1 shape
  (accept, `error` frame, close 1008); the DO now produces them.
- The §3.1 `unclaimed` frame is never sent: it would need a config read at upgrade. An unclaimed server has no
  vaults, so the DO answers `unauthorized`.
- The ticket key only signs tickets. It is not the E2EE vault key K_e (e2ee-design.md §5.1), which never reaches
  the server.
- *Why:* a ticket key per vault makes cross-vault replay impossible by construction. *Tests:* T-TICKET-CROSS-VAULT,
  T-TICKET-BAD (BB).

**D5 Surviving routes.** Exactly the §2.2 table; everything else → 404.
- Static Worker responses, no DO call: the console (`GET /`), `GET /mobile-setup` (the target of `mobileSetupUrl`
  and the console's setup QR) and CORS preflight.
- The console is one server-rendered page with inline JS and no external assets. It covers login, the
  vault list, owner code + QR (drawn in the page, O12), devices + revoke, reset streams behind a typed vaultId
  confirmation, and the D8b "Restore incomplete" banner.
- Operator JSON routes require `Content-Type: application/json` and a same-origin `Origin`. The cookie is
  HttpOnly, Secure, SameSite=Strict, 7 days.
- **Claim:** vault init → config claim (operator, vault and session in one write) → owner code. A failure after
  the claim → 503; the user re-probes, logs in and uses owner-code.
- **Create vault:** no `/provision` (→ 404). Idempotent vault init first, registry row last, so a listed vault is
  always initialized. A failed registration leaves an unreachable 1-row orphan DO (accepted).
- **Delete vault:** `{"confirmVaultId"}`, missing or mismatched → `400 confirmation_mismatch`. Sockets 1001 +
  `deleteAll()`, then the R2 prefix purge (1000 per batch), then the registry row; an incomplete purge → `503
  purge_incomplete`, retryable. Afterwards every device route → 401.
- *Why:* the rest serves only cut subsystems. *Tests:* T-LEGACY-404 (BB: members, invitations, governance,
  device-links, settings-sync, catch-up, bootstrap/start, legacy `DELETE /operator/devices/:id`), T-DEVICES-LIST (BB:
  deviceId, deviceName, no token material), T-CONSOLE-ROUTES, T-PROVISION-404, T-VAULT-DELETE-CONFIRM (BB).

**D6 VAULT_READY constants.**
- `role:"owner"`, `canWrite:true`, `membershipRevision:1`, `deviceCredentialRevision:1`, `policyVersion:1`.
- `principalId` = `owner:<vaultId>`, in VAULT_READY only: the enroll body is D3's six fields (`readEnrollment`,
  `src/host/ui/pairing.ts:363-388`, never reads it).
- `capabilityDigest` = today's `capabilityDigestForRole("owner")` value, frozen as a literal.
- Every §3.2 field stays; the `write_forbidden` path is removed. *Why:* the shape stays for the shipped client;
  the authority model is gone. *Test:* T-READY-SHAPE.

**D7 Device revoke.** `DELETE /operator/vaults/:id/devices/:deviceId`: operator-only, idempotent, `200 {ok,
deviceId, revoked}`. The gate shuts with the transaction, not with the close handshake.
- **Revoke turn** (one synchronous turn): DELETE the device row and its device-map entry; drop its frames from the
  pending group-commit buffer (they never commit, no receipt); remove its sockets from the fanout set; send each
  `__YPS:{"type":"error","code":"authority_superseded"}` and close 4403.
- **Inbound gate.** The socket attachment carries deviceId. Every `webSocketMessage` first checks the device map
  (rebuilt from SQLite at wake); a miss drops the frame, sends `authority_superseded` and closes 4403.
- **Wake rebuild (added, O3).** H5's rebuild skips, and closes 4403, sockets whose device is not in the map, so a
  revoked socket whose close never completed can't rejoin fanout.
- **Close.** The error and 4403 close frames leave in the revoke turn (legacy: +207 / +211 ms after the request).
  The TCP end follows about 10 s after the DO's last event; that is platform teardown, measured but not judged.
  The new deploy uses a compat date ≥ 2026-04-07 (`web_socket_auto_reply_to_close` on); whether that shortens the
  teardown is unmeasured, and the gate does not depend on it.
- The bearer then gets 401 on every device route, ticket included; the upgrade checks the device map, so an
  unexpired ticket stops working.
- *Why:* one DO, so no TTL cache and no fence. *Tests:* T-REVOKE-GATE, T-REVOKE-SILENCE, T-REVOKE-BUFFER,
  T-REVOKE-4403 (error and close frame each < 1 s; TCP end recorded), T-REVOKE-401.
- *Measured on legacy* (`conformance-scratch3-revoke-20261006T051325Z.json`): 4 cycles, ~5,300 frames sent after
  the revoke response, 0 committed, 0 echoed; the committed frames are always an unbroken prefix of those sent
  before the fence ran. Legacy flushes the 23 buffered frames in the revoke turn (BUFFER fails, as D7 intends to
  change). One cycle showed a 484 ms gap between the cutoff and the error frame, on the safe side (frames in it
  were rejected), cause not found.

**D8 Epoch.** vaultEpoch == vaultGeneration: random base64url(16), minted at vault init. Device credentials are
bound to the vaultId only. *Why:* an epoch means only "the stream space was replaced"; credentials survive it.

**D8a reset-streams.** Request `{"confirmVaultId"}` (missing or mismatched → `400 confirmation_mismatch`) → `200
{vaultEpoch}`.
- One `transactionSync` deletes every row of the 3 stream tables and writes a new generation. Then the pending
  buffer, head cache and dedupe index are discarded and streams sockets close 1001. Devices stay enrolled.
- Cost: one row per stream row (§6.2). A daily-limit hit rolls the transaction back → `503 cf_daily_limit`. P3
  measures DROP+CREATE billing on workerd and uses it if it is cheaper.
  - *Measured (P3a, local workerd, `cursor.rowsWritten`):* DROP+CREATE bills a constant 7 rows (0 per DROP, 2 per
    CREATE TABLE, 1 per CREATE INDEX). Not adopted: DROP fails with SQLITE_LOCKED while any read cursor on the
    table is open, and an early-exited `for…of` keeps one open until GC. Reset stays DELETE at H+S+C+1.
- *Test:* T-RESET.

**D8b restore (approved 2026-10-06; operator-only, cold path).** `POST /operator/vaults/:id/restore {"at": ISO8601}` → `200
{vaultEpoch}`. A restore rewinds content, never authority.
- **Why not a temp table:** PITR "appl[ies] to the entire SQLite database contents, including … key-value data"
  and returns storage "to exactly match what the storage contained at the given bookmark". A backup table written
  before the rewind is erased by it.
- **Why a journal outside the vault:** finish must always run. Until it does, the rewound vault serves the old
  device table and the old epoch, and a client still on that epoch skips the reused seqs (§11 step 5, "skipping
  seqs ≤ the stream cursor"): silent divergence. Only finish's new epoch heals it (§11 step 3 drops all cursors).
  The vault cannot detect its own rewind (the restored state is a genuine past state), so the intent lives in the
  config DO, with a config-DO alarm that resumes it.
- **Crosses the rewind:** the device rows only. Not pairing codes (all deleted), the epoch (finish mints a new
  random one, so no collision with a post-T epoch), the ticket key or the daily latch.

The config DO runs the steps (the Worker forwards the request after the session check):

0. INSERT the journal row (§6.3) and set the alarm to now + 30 s. A PK conflict means a restore is pending:
   resume it, ignore this request's `at`, respond with `resumed:true` and the journaled `at`. An `at` that is
   unparseable, in the future or over 30 days old → `400 invalid_restore_point` before any effect; no PITR (local
   dev) → `501 restore_unsupported`.
1. Vault `prepareRestore(restoreId, at)`: an in-memory `restoring` flag with a 60 s TTL (device routes and enroll
   → `503 restore_in_progress` + `Retry-After`; upgrades refused); streams sockets close 1013
   `restore_in_progress`; the buffer is dropped; `vault_meta.pending_restore_id = restoreId`; return `{bookmark:
   getBookmarkForTime(at), devices}`. The config DO stores both in the journal row.
2. Vault `rewind(restoreId, bookmark)`: `last_restore_id == restoreId` → already finished, go to 4. Otherwise
   `onNextSessionRestoreBookmark(bookmark)` and `ctx.abort()` (the RPC throws by design).
3. Vault `finishRestore(restoreId, devices)`:
   - `last_restore_id == restoreId` → no-op, current epoch.
   - `pending_restore_id` still set → the rewind did not happen (a real rewind erases the marker, written after
     T) → back to 2.
   - any write since this runtime booted (commit, checkpoint, enroll, code) → back to 2, so content is exactly T.
   - Else one `transactionSync`: replace the device table, delete all codes, mint a new epoch, set
     `last_restore_id` and `last_restore_at`. Then every streams socket closes 1001.
4. Delete the journal row; `200 {vaultEpoch}` (synchronous: the operator waits a few seconds). A failure before
   this → `503 restore_incomplete`, and the alarm finishes it.

- **Resume** (a second press, or the alarm with platform retries): if the vault still has `pending_restore_id ==
  restoreId` (not rewound), rerun 1 to refresh the snapshot; then always 2 → 3 → 4. Step 2 re-arms the same
  bookmark, which erases anything written while the vault sat rewound.
- **Authority freeze.** While a journal row exists, the config DO refuses that vault's revoke, owner-code and
  reset-streams with `409 restore_in_progress` (operator routes already pass the config DO, so it costs nothing).
  Vault delete wins: it deletes the journal row first. An enroll that lands in the rewound vault is dropped by the
  re-rewind (fail-closed: re-pair).
- **Invariants.** Cold path only: the operator route is the sole entry, and the journal, steps and alarm never touch
  a device path. The vault DO never calls the config DO; no device route gains a hop. Rows: config 3 (insert,
  update, delete); vault 1 (the marker, which the rewind erases) + finish.
- **Residual window.** No crash: one internal RPC between abort and finish; upgrades re-check the device table,
  and a write in the window sends finish back to 2. Crash: at most the alarm delay (≈ 30 s plus retries) of
  rewound content under the old epoch, healed by finish. `GET /operator/state` lists journal rows, so the console
  shows "Restore in progress".
- *Tests:* T-RESTORE-RESUME-WB (fake PITR port; crash between every pair of RPCs; final devices == pre-restore
  devices, no codes, new epoch, content == T, no journal row), T-RESTORE-MANUAL (deployed, by hand).

**D8c epoch param.** Feed, read and checkpoint take an optional `epoch=`.
- The check runs right after bearer auth, before any other validation or effect. Absent → no check.
- Mismatch (empty included) → `409 {"error":"vault_generation_mismatch","vaultEpoch":"<current>"}`.
- *Tests:* T-EPOCH-MISMATCH, T-EPOCH-MATCH, T-EPOCH-ABSENT.

**D9 Blobs (R2 only).**
- Address `^[0-9a-f]{64}$`: format check only, no SHA-256 check. PUT overwrites. Body ≤ 100 MB
  (`maxBlobUploadBytes` = 100000000), else 413. *Why 100 MB:* it is Cloudflare's request body limit on the Free and
  Pro plans; the edge answers a larger body with its own 413 before the Worker runs
  (https://developers.cloudflare.com/workers/platform/limits/). A Business (200 MB) or Enterprise (up to 5 GB) zone
  still gets 100 MB. The PUT needs a `Content-Length`, else `411 length_required`, and the body streams to R2
  (`bucket.put(key, request.body)`, which needs a known length): it is never buffered, since a body near the cap
  would fill most of the 128 MB isolate. `exists` takes at most 50 entries, more is `400 too_many_addresses`; any entry
  that is not an address makes it `400 invalid_address` (E2EE design §19 A4: never a silent "absent").
- No `YAOS_BUCKET` → `503 attachments_unavailable` and `capabilities.attachments=false`.
- **R2 key `v/<vaultId>/<address>` (mandatory)**, with no generation. Vault delete purges the prefix. *Why:* the
  content address is the identity, so identical bytes are the same blob across resets, restores and epoch bumps.
- *Why opaque:* E2EE addresses are HMAC(kAddr, sha256) (e2ee-design.md §10.1), which the server cannot check; the
  client verifies on download. *Tests:* T-BLOB-OPAQUE, T-BLOB-KEY-RESET (both SKIP when `attachments=false`),
  T-BLOB-UNAVAILABLE.
- **GC routes (E2EE design §19 A3).** The client's mark-and-sweep needs a list and a delete that cannot remove a
  blob re-uploaded during the sweep (relay-wire §11.3.1).
  - `GET /vault/:id/blobs?cursor=` → `{items:[{address,uploadedAt}],next}`: an R2 `list` of `v/<vaultId>/`, at most
    1000 items (R2's maximum). The cursor is the page's last address, sent as `startAfter`. An empty truncated R2
    answer is followed with R2's own cursor, at most 10 list calls a request; then `503 list_incomplete` +
    `Retry-After: 5`, never `next: null` while R2 says truncated.
  - `POST /vault/:id/blobs/delete {ifUploadedBefore, addresses}` → `{results:[{address,result,uploadedAt?}]}` in
    request order, `result` one of `deleted`, `newer`, `absent`. 1–100 distinct addresses. R2 `head` of each, 6 in
    flight (the Workers limit on simultaneous open connections), then one R2 `delete(keys)` of those uploaded
    strictly before the cutoff. A PUT refreshes `uploaded`, so a re-upload after the cutoff survives. R2 has no
    conditional delete, so a PUT between an address's head and the batch delete is lost (accepted, cold path; the
    client handles it). A full call is 102 subrequests to Cloudflare services (100 heads, 1 delete, 1 DO call),
    within the Free plan's 1000 a invocation, none external.
  - Order: bucket (503), formats and the delete body (400, 413), then the vault DO's `POST /blobs/gc-auth`: bearer
    (401), restore (503), and 60 authenticated requests a minute per vault DO in memory, a batch delete counting as
    one (`429 too_many_attempts` + Retry-After). No config call, no DO write, no cross-DO coordination.
  - *Tests:* T-BLOB-GC-LIST, T-BLOB-GC-DELETE, T-BLOB-GC-RACE, T-BLOB-GC-LIMIT, T-BLOB-EXISTS-STRICT (WB).

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
- **GC'd originals.** An entry with `seq ≤ gcSeq` can't be byte-compared: answer `deduped:true` with the original
  seq; the checkpoint covers it.
- **Rows read, worst case.** Every sealed segment is ≥ 64 KiB (an end-of-commit seal needs ≥ 64 KiB, a mid-commit
  seal > 1.5 MB − 1 MiB). So one scan reads ≤ 64 segments + 1 head = **65 rows** (≤ W + 1.5 MB), once per stream
  per runtime, or once per eviction under the memory cap.
  The 5M budget allows ≈ 76.9k cold scans/day; a realistic load (200 wakes × 10 hot streams) is ≈ 130k rows/day (2.6%).
- **CPU.** 200k tiny rows can exceed 10 ms. Parse keys only; P3 measures the cold scan. If it is still over,
  chunk the scan and gate that stream's commits on it.
  - *Measured (P3a, Node):* the worst case (4 MiB of 25 B rows, 168,467 rows) parses in 15.7 ms median, so the
    fallback is built. Steps are 16,384 rows (median 1.2–1.35 ms, p95 ≤ 4.4 ms), and the window read is charged
    one step unit per 256 B. Local workerd agrees (≈ 15 ms full parse, ≈ 2 ms per step); production CPU is
    measured in P5.
- **Memory bound.** The minimum row is 21 B (seq 1, deviceId 1+16, cfid 1+1, len 1), so one stream holds
  ≤ 199,728 entries, about 12 MB at about 60 B/entry (typical 250 B rows: ≤ 17k entries, about 1 MB). DO-wide cap:
  262,144 entries (about 16 MB), by LRU eviction of whole streams; an evicted stream rescans (≤ 65 rows).
- Update §5.4 (section 5). *Tests:* T-DEDUPE-LARGE (3×600 KiB), T-DEDUPE-SMALL (400×4 KiB), T-DEDUPE-CONFLICT,
  T-DEDUPE-COLD-WB.

**H3 Commit-failure typing.** The relay classifies its own commit errors; the `decorateControl` rewrite goes.
- Daily limit → `VAULT_ERROR cf_daily_limit {cause:"durability_failed", kind, resetAt, message, stream,
  clientFrameIds}`.
- Anything else → `durability_failed` plus an additive `retryAfterMs = round(min(30000, 1000·2^(n−1)) ·
  (0.5 + 0.5·rand))`, where n counts consecutive failed commits in the runtime and resets on success.
- The checkpoint, feed and read handlers map daily-limit errors to `503 cf_daily_limit` themselves.
- *Why:* errors are typed at the source, so there is no latch race. *Tests:* T-COMMIT-DAILY-WB, T-COMMIT-RETRY-WB (WB,
  new IDs), T-DAILY (BB, via `POST /vault/:id/debug/simulate-daily-limit`, only with `YAOS_DEBUG_ROUTES=1`).

**H4 Authority before write_forbidden.** Resolved by design: no roles, `canWrite` always true, and the D7 gate
shuts in the revoke turn. *Tests:* covered by T-REVOKE-GATE and T-READY-SHAPE.

**H5 Socket cache.** A `Map<WebSocket, Attachment>` with per-device lists, each attachment parsed once per socket
per runtime; maintained on accept, close and error, rebuilt from `ctx.getWebSockets()` after a wake (skipping
revoked devices, D7). *Why:* today `streamSockets()` walks every socket on every call. *Test:* T-SOCKET-CACHE-WB
(WB, new ID).

**H6 Per-device limits.**
- One in-memory token bucket per deviceId (256 KiB/s, 2 MiB burst, full after a wake), shared by its sockets. An
  overdraft closes the overdrawing socket (BACKPRESSURE, 1013).
- Cap of 4 sockets per device: a 5th connect closes that device's oldest socket with 1001 `device_socket_limit`,
  then accepts. This runs before the vault-wide check, so a device at its cap can always reconnect.
- Five live clients on one device would evict each other forever, so the client backs off ≥ 30 s on
  `device_socket_limit`.
- The vault-wide cap of 1000 (`429 stream_socket_limit`, `Retry-After: 1`) stays.
- *Why:* the limit must bind the writer, not the socket. Ghost sockets after a network switch are the usual 5th.
  *Tests:* T-RATE-DEVICE, T-RATE-SOCKET, T-SOCKET-CAP-DEVICE.

**H7 Retired-stream GC.**
- When `coversSeq == lastSeq`, the head UPDATE also sets `open=NULL, open_rows=0, tail_first=NULL, gc_seq=lastSeq`.
  Sealed segments are all ≤ N and deleted as today; the head row stays. Cost: still 1 row (no indexed column in SET).
- Client note: sealed segments of a retired stream are only collected if the client writes a final checkpoint.
- Update §8. *Tests:* T-RETIRED-GC, T-PARTIAL-GC.

**H8 minIntervalMs.**
- Default 1000 (`YAOS_STREAMS_GC_MIN_INTERVAL_MS` still overrides), echoed in `VAULT_READY.limits.groupCommit`.
- The idle flush waits `max(idleMs, lastCommitAt + 1000 − now)`; the max (1500 ms) and bytes (64 KiB) triggers stay.
- Small writes: ≤ 1 commit/s/vault, about 2–4 rows/s while typing, so 100k rows ≈ 7–14 h of continuous editing.
- Large writes are not bounded: the 64 KiB trigger still commits back to back (≤ 4/s/device at the rate gate).
  Accepted, and stated in §11.5.
- *Tests:* T-MININTERVAL-READY, T-MININTERVAL-TIMING (≥ ~900 ms between back-to-back commits).

**Latency additions after the rewrite** (built on client-remake as 18ea6fd and 2c3afd1, carried here on 2026-10-07 so
that server code changes only on this branch and client branches merge it):
- *Leading-edge commit.* An append that finds the buffer empty with no commit in the last `gcQuietMs` (1500) commits
  after `gcLeadMs` (20) instead of the idle window; appends inside the 20 ms join it. The wait is
  `max(leadAt − now, lastCommitAt + minIntervalMs − now)`, so H8 still holds: the lead fires only after ≥ 1.5 s
  without a commit. Cost: at most one extra commit per burst start, at most one lead commit per quietMs. Echoed as
  `groupCommit.leadMs`/`quietMs`; `YAOS_STREAMS_GC_LEAD_MS` / `_QUIET_MS` override (quiet 0 = off). Before it, an
  isolated local edit reached the peer's disk after 417 ms, about 300 ms of it the idle window (2c3afd1).
- *Batched read.* `GET /vault/:id/streams/read` also takes `r=<after>.<0|1>.<name>` entries (at most
  `readBatchMaxStreams`, 128) with one `maxBytes` budget; the response has one page per entry, in order, ending early
  when the budget runs out. One request per stream made a 1000-note bootstrap take about a minute on the deployed
  relay (about 220 ms per request); a batch reads up to 128 streams per request. Errors `400 invalid_read_entry`,
  `400 batch_too_large`.
- *Tests:* tests/server/streams-relay.ts (lead commit with H8, batch budget, entry parsing); streams-hardening.ts
  T-MININTERVAL-TIMING runs with the lead off (`gcQuietMs: 0`) so the idle timing stays exact.

**BASELINE** (unchanged behaviour, must stay green): T-OVERSIZE-1009, T-CKPT-MULTICHUNK (2.5 MB), T-TWO-SOCKETS,
T-HAPPY.

---

## 5. Contract delta against relay-wire.md

Classes: **additive** (new; old clients unaffected), **relaxation** (the server accepts or promises more),
**tightening** (it accepts or promises less), **removal** (gone).

| § | Old → new | Class | Client action |
|---|---|---|---|
| 2.1 | Capabilities: keep `claimed`, `streams:1`, `attachments`, `maxBlobUploadBytes`, `serverVersion`. Drop `schemaVersion`, `protocolVersion`, `snapshots`, `recoveryJobs`, `settingsSync`, `semanticCanvas`, `bulkCreate`, `relayBodies`, `storageFormatVersion`, `snapshotFormatVersion`, `settingsFormatVersion`, `update*` | removal | none (pairing.ts reads only the kept five) |
| 2.2 | Claim body unchanged; the response drops `mobileSetupQrDataUrl` (G25, O12); already claimed → `409 already_claimed` | removal | none (the client never read it) |
| 2.3 | + `GET …/devices`, `DELETE …/devices/:deviceId`, `POST …/reset-streams`, `POST …/restore`; `/provision` → 404; `DELETE /operator/vaults/:id` takes `{"confirmVaultId"}` (D5) | additive / removal | none |
| 2.4 | Pairing code: "8–512 printable" → `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$` after trim; malformed → `400 invalid_code`; unknown → `404 invalid_code` (was `unknown_code`) | tightening | none: `enrollHttpError` maps both codes; strip any client-only key part |
| 2.4 | Same `enrollmentRequestId` + deviceId + token hash → replay 200; same id, other body → `409 enrollment_request_conflict` (D3) | additive | none (pairing.ts already re-sends the identical body) |
| 2.4 | `202 authorization_fence_pending` → never sent | removal | none (the retry loop becomes dead code) |
| 2.4 | 200 body: exactly `host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration` (D3) | removal | none |
| 2.5 | Pairing-code response `{pairingCode, expiresAt, purpose, obsidianUrl, mobileSetupUrl?}`; purpose `device` only (absent = device; else `400 invalid_purpose`) | tightening | none |
| 2.6 | Ticket wire unchanged; issued by the vault DO | none | none |
| 2.7 | Removed: `403 capability_denied`, `409 vault_<state>`, `503 vault_draining`; `404 unknown_vault` → `401 unauthorized` (§2.2). `409 vault_generation_mismatch` gains `vaultEpoch`. + D8b: `503 restore_in_progress` with `Retry-After`, `409 restore_in_progress`, `503 restore_incomplete`, `400 invalid_restore_point`, `501 restore_unsupported` | removal / additive | none |
| 3.1 | `unclaimed` frame never sent (D4); DO-level `409 authority_superseded` and `403` at upgrade removed; `unauthorized` and `update_required` frames unchanged; 429 stays | removal | treat as `unauthorized` (already mapped) |
| 3.2 | `canWrite` always true; D6 constants; the `write_forbidden` note is removed; `groupCommit.minIntervalMs` 0 → 1000 | removal / tightening | read `limits`; set receipt timeouts ≥ maxMs + RTT |
| 4.3 | `STREAM_APPEND_REJECTED write_forbidden` removed. `VAULT_ERROR durability_failed` + `retryAfterMs` (ms, number) | removal / additive | when present, wait `retryAfterMs` before resending |
| 5.1 | Idle flush deferred to `lastCommitAt + minIntervalMs` | tightening | none |
| 3.2, 5.1 | Leading-edge commit: `groupCommit.leadMs` 20, `quietMs` 1500; an append after ≥ 1500 ms without a commit commits after 20 ms (H8 still holds) | additive | none |
| 7.1 | Batched read: `/streams/read?r=…&r=…`, `limits.readBatchMaxStreams` 128, one byte budget per batch | additive | use it when the limit is present |
| 5.4 | Dedupe scope (text below) | relaxation | none |
| 6, 7, 8 | Optional `epoch=<vaultEpoch>`; mismatch or empty → `409 {"error":"vault_generation_mismatch","vaultEpoch"}` before any effect | additive | send it; on 409 switch to the returned epoch (new local DB) |
| 8 | GC text (below) | tightening | write a final checkpoint at `lastSeq` to retire a stream |
| 10 | 1001 also means "replaced by a newer socket of the same device" (reason `device_socket_limit`); 4403 only on revoke; + 1013 `restore_in_progress` (D8b) | additive | back off ≥ 30 s on `device_socket_limit` |
| 11.1 | Rate gate per socket → per device; + "Streams sockets per device: 4, a 5th evicts the oldest (1001 `device_socket_limit`)"; group commit row gains "1000 ms min interval" | tightening | one socket per vault per device |
| 11.2 | Permissions table and the 5 s authority cache removed; revoke shuts the gate at once (D7) | removal | none |
| 11.3 | `<sha256 hex>` → `<64 lowercase hex address>`; no hash check; `400 hash mismatch` removed; PUT overwrites; capability names gone | relaxation / removal | verify downloads client-side |
| 11.3 | + `GET /vault/:id/blobs?cursor=` and `POST /vault/:id/blobs/delete` (blob GC: 60 requests/min per vault, page 1000, a batch of 1–100 addresses, `503 list_incomplete`); `exists` with a malformed entry → `400 invalid_address` instead of dropping it, and more than 50 entries → `400 too_many_addresses` instead of answering the first 50 (E2EE design §19 A3, A4) | additive / tightening | send only well-formed addresses, `exists` batches ≤ 50 and delete batches ≤ 100; on 429 or 503 wait `Retry-After` |
| 11.4 | Unchanged; the simulate route exists only with `YAOS_DEBUG_ROUTES=1` | none | none |
| 11.5 | + three identity tables; enroll 2 rows, revoke 1, ticket 0; + "the 64 KiB trigger still commits back to back" (H8) | additive | none |
| 13 | `YAOS_STREAMS` flag gone; the Node/Docker host gone | removal | none |
| 14 | Everything listed → 404, including "Still used": `me`, `members`, `devices` (vault-level), `invitations`, `device-links`, `principals/*`, `ownership/*`, `governance` | removal | none (`src/` calls none of them) |
| 15 | HTTP routes no longer pay a config-DO hop; receipt p50 rises toward 1 s for back-to-back commits | informational | none |
| 16 | `role` type stays `"owner" \| "member"`; only `"owner"` is sent | none | none |

New §5.4 "Dedupe scope":

> Duplicates are detected in the pending buffer (vault-wide by `(deviceId, clientFrameId)`, comparing stream and
> bytes) and against every committed row among the newest 4 MiB (stored row bytes) of the stream. Outside that
> window a resend is appended again with a new seq. The window covers more than one burst plus one max payload
> plus one commit batch, so every resend this section requires is deduped. The window is kept in memory only. A
> stream's first append in a runtime builds it in chunks, and that stream's frames wait in the pending buffer
> until it is installed: their receipts come later, and none is lost.

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
  pending_restore_id TEXT,             -- D8b: set by prepare, erased by a real rewind
  last_restore_id TEXT,                -- D8b: step 2 skip, finish idempotency
  last_restore_at INTEGER
) WITHOUT ROWID;
CREATE TABLE device (
  token_hash BLOB PRIMARY KEY,         -- SHA-256(deviceToken)
  device_id TEXT NOT NULL, device_name TEXT NOT NULL,
  enrollment_request_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL
) WITHOUT ROWID;                       -- no secondary index: revoke scans (a few rows)
CREATE TABLE pairing_code (
  code_hash BLOB PRIMARY KEY,          -- SHA-256(secret)
  purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
  used_request_id TEXT, used_device_id TEXT   -- D3 replay key
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
| Enroll replay (D3) | none | 0 |
| Pairing / owner code | INSERT pairing_code (+1 per pruned row) | 1 |
| Ticket | none (key and devices in memory) | 0 |
| Revoke | DELETE device | 1 |
| Reset | DELETE H heads + S segments + C chunks; UPDATE meta | H+S+C+1 |
| Restore prepare (D8b) | UPDATE meta (marker; the rewind erases it) | 1 |
| Restore finish (D8b) | replace D device rows; DELETE P codes; UPDATE meta | ≈ D+P+1 |
| Commit | per touched stream: head UPDATE/INSERT (last_seq indexed) = 2; +1 per sealed segment | 2/stream + 1/seal |
| Checkpoint | DELETE old chunks (k₀) + INSERT new chunks (k₁) + DELETE collected segments (g) + UPDATE head (SET has no `last_seq`) | k₀+k₁+g+1 |
| Retired GC (H7) | same head UPDATE | +0 |
| Dedupe index (H2) | memory only | 0 |
| Blob routes, blob GC (D9) | none (bearer check and GC limit in memory; the bytes live in R2) | 0 |

### 6.3 Config DO schema

```sql
CREATE TABLE operator (id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash BLOB NOT NULL, claimed_at INTEGER NOT NULL) WITHOUT ROWID;   -- SHA-256(recovery key ≥ 32 chars)
CREATE TABLE session (token_hash BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE vault (vault_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE restore_journal (vault_id TEXT PRIMARY KEY, restore_id TEXT NOT NULL, at INTEGER NOT NULL,
  bookmark TEXT, devices BLOB,                                          -- set after prepare; token hashes only
  created_at INTEGER NOT NULL) WITHOUT ROWID;                           -- D8b; alarm while rows exist
```

`claimed` = the operator row exists. Rows written: claim 3 here (operator, vault, session) + 2 in the vault DO
(meta, code); login 1 (+1 per pruned session); logout 1; create vault 1 + 1 in the vault DO; delete vault 1 + the
vault DO's `deleteAll()` (not measured); restore 3 (insert, update, delete).

---

## 7. Acceptance matrix

"scratch-3" is today's `yaos-relay2-scratch-3` (legacy server, `YAOS_STREAMS=true`, no R2). BB results are
measured: `experiments/logs/conformance-scratch3-baseline-20261005T215906Z.json` and
`conformance-scratch3-flags-20261006T050159Z.json`; the revoke rows from `conformance-scratch3-revoke-20261006T051325Z.json`.
These three ran uncommitted suite versions, so their check names can differ from the committed suite (for example
T-ENROLL-BODY); the runner now records `<sha>+dirty` in that case. Second measurement: the same legacy commit under
local `wrangler dev` (`conformance-local-legacy-20261006T060730Z.json`) gives the same status on all 50 BB tests, so
local dev stands in for deployed in P2–P4; only timings differ (round trip ≈ 0.4 ms vs 80 ms). `*` marks a WB test:
it never runs against scratch-3, so the entry is a guess at today's code. BB files live in `e2e/conformance/tests/`,
WB files in `tests/server/` (WB file names are suggestions).

| ID | What | Kind | scratch-3 | Where |
|---|---|---|---|---|
| T-HAPPY | enroll 2 devices, append b:/ns, receipts, provisional/committed, feed, read, checkpoint | BB | PASS | happy.ts |
| T-TWO-SOCKETS | two devices see each other's frames live | BB | PASS | socket.ts |
| T-OVERSIZE-1009 | binary > 1 MiB + 1 KiB closes 1009 | BB | PASS | socket.ts |
| T-CKPT-MULTICHUNK | 2.5 MB checkpoint round-trips (3 chunks) | BB | PASS | checkpoint.ts |
| T-ENROLL-200 | first enroll is 200 with the §2.4 fields, never 202 | BB | PASS | onboarding.ts |
| T-HOTPATH | zero config-DO calls on the 7 device paths | WB | FAIL* | hotpath.ts |
| T-PAIR-FORMAT | minted codes match the D3 regex, prefix = vaultId | BB | FAIL | onboarding.ts |
| T-PAIR-MALFORMED | malformed code → 400 invalid_code | BB | FAIL | onboarding.ts |
| T-PAIR-UNKNOWN-VAULT | unknown vault, and unknown secret on a known vault → 404 invalid_code | BB | FAIL (404 unknown_code) | onboarding.ts |
| T-PAIR-USED | second use → 409 used_code | BB | PASS | onboarding.ts |
| T-PAIR-NOWRITE | unknown vault: 0 rows written, no DDL | WB | FAIL* | pairing.ts |
| T-ENROLL-REPLAY | identical retry → 200, same deviceId, vaultId, generation; token works | BB | PASS | flags.ts |
| T-ENROLL-CONFLICT | same id, other deviceId or token → 409 enrollment_request_conflict; original token works, other 401 | BB | PASS | flags.ts |
| T-ENROLL-BODY | exactly the six client fields | BB | FAIL (legacy principalId, extra fields) | flags.ts |
| T-TICKET-CROSS-VAULT | vault A ticket on vault B → 1008 unauthorized | BB | PASS | onboarding.ts |
| T-TICKET-BAD | tampered, garbage or missing ticket → 1008 unauthorized | BB | PASS | onboarding.ts |
| T-UNKNOWN-VAULT-401 | valid bearer on an unknown vault → 401 on ticket, pairing-code, feed, read, checkpoint | BB | PASS | flags.ts |
| T-LEGACY-404 | the D5 legacy list → 404 | BB | FAIL | operator.ts |
| T-CONSOLE-ROUTES | `GET /`, `GET /mobile-setup` → 200 HTML; CORS preflight not 404 | BB | PASS | flags.ts |
| T-PROVISION-404 | `POST …/provision` → 404 | BB | FAIL (200) | flags.ts |
| T-VAULT-DELETE-CONFIRM | missing or wrong confirmVaultId → 400; match → 200, sockets 1001, bearer 401 | BB | FAIL (409 destroy_confirmation_required) | flags.ts |
| T-DEVICES-LIST | deviceId and deviceName, no token material | BB | FAIL (404) | operator.ts |
| T-READY-SHAPE | D6 constants, every §3.2 field | BB | PASS | socket.ts |
| T-REVOKE-GATE | no frame the revoked socket sends after the revoke response commits (incl. after idle) | BB | PASS | revoke.ts |
| T-REVOKE-SILENCE | the revoked socket gets no data-bearing message after the revoke response | BB | PASS | revoke.ts |
| T-REVOKE-BUFFER | frames buffered for group commit at revoke never commit, no receipt | BB | FAIL (23/23 committed) | revoke.ts |
| T-REVOKE-4403 | error frame and close frame 4403 each < 1 s; TCP end recorded | BB | FAIL (route; legacy owner route: 207 / 211 ms deployed, 6 / 10.5 ms local; TCP end ≈ 10 s in both) | operator.ts |
| T-REVOKE-401 | revoked bearer → 401 on ticket, feed, read, pairing-code | BB | FAIL (route; legacy: all 401) | operator.ts |
| T-RESET | new epoch, empty streams, 1001 closes, devices kept | BB | FAIL (its restore probe: 404 on legacy, deployed and local; 501 without PITR applies to the rewrite only) | operator.ts |
| T-RESTORE-RESUME-WB | fake PITR port, crash after each step; resume ends with snapshot devices, no codes, new epoch, no journal row | WB | FAIL* | restore.ts |
| T-RESTORE-MANUAL | restore to T: content rewound, devices as of the request, codes gone, epoch rotates (deployed only) | manual | n/a | manual |
| T-EPOCH-MISMATCH | wrong or empty epoch → 409 + vaultEpoch, no effect | BB | FAIL | checkpoint.ts |
| T-EPOCH-MATCH | matching epoch → normal | BB | PASS | checkpoint.ts |
| T-EPOCH-ABSENT | no param → normal | BB | PASS | checkpoint.ts |
| T-BLOB-OPAQUE | non-SHA 64-hex address PUT/GET/exists, overwrite | BB | SKIP (no R2) | misc.ts |
| T-BLOB-KEY-RESET | a blob survives reset-streams byte-identical and in `exists` | BB | SKIP (no R2) | flags.ts |
| T-BLOB-UNAVAILABLE | 503 attachments_unavailable, attachments=false | BB | PASS | misc.ts |
| T-BLOB-GC-LIST | pages of 1000 in address order, cursor = last address, uploadedAt from R2, stable under deletes; empty truncated R2 answers followed with R2's cursor (≤ 10 calls), else 503 list_incomplete + Retry-After | WB | n/a (new route) | blobs.ts |
| T-BLOB-GC-DELETE | one batch: older → deleted; at or after the cutoff → newer; missing → absent; request order; heads (6 in flight) then one delete; 100 addresses accepted, 101 → 400; other vaults untouched | WB | n/a (new route) | blobs.ts |
| T-BLOB-GC-RACE | a re-upload after the sweep's cutoff survives; a PUT between the head and the delete is deleted (the documented window) | WB | n/a (new route) | blobs.ts |
| T-BLOB-GC-LIMIT | 60 authenticated GC requests/min per vault (a 100-address batch is one) → 429 + Retry-After; 400s and 413 before the DO; 401 before R2 | WB | n/a (new route) | blobs.ts |
| T-BLOB-EXISTS-STRICT | a malformed `exists` entry → 400 invalid_address, more than 50 entries → 400 too_many_addresses, no R2 HEAD | WB | FAIL* (legacy dropped the entry, answered the first 50) | blobs.ts |
| T-CODEC-UTF8 | invalid UTF-8 → 1008 | BB | PASS | socket.ts |
| T-CODEC-SURROGATE | `ED A0 80` → 1008 | BB | PASS | socket.ts |
| T-CODEC-OVERLONG | `C0 AF` → 1008 | BB | PASS | socket.ts |
| T-CODEC-NONMINIMAL | `0x82 0x00` → 1008 | BB | FAIL | socket.ts |
| T-CODEC-TRAILING | trailing byte → 1008 | BB | PASS | socket.ts |
| T-CODEC-VALID | `"b:é✓😀"` accepted | BB | PASS | socket.ts |
| T-DEDUPE-LARGE | 3×600 KiB, reconnect, resend → deduped, original seqs | BB | FAIL | commit.ts |
| T-DEDUPE-SMALL | 400×4 KiB resend → deduped | BB | FAIL | commit.ts |
| T-DEDUPE-CONFLICT | same id, other bytes → client_frame_id_conflict + seq | BB | PASS | socket.ts |
| T-DEDUPE-COLD-WB | the same after a runtime restart; ≤ 65 rows read | WB | FAIL* | dedupe.ts |
| T-DAILY | simulated limit → VAULT_ERROR cf_daily_limit; checkpoint 503 | BB | SKIP (legacy's switch is `YAOS_TEST_ONLY_DEBUG_ROUTES`, unset; the rewrite uses `YAOS_DEBUG_ROUTES=1`) | misc.ts |
| T-COMMIT-DAILY-WB | the relay types the daily limit itself | WB | PASS* (same wire) | relay-commit.ts |
| T-COMMIT-RETRY-WB | durability_failed + retryAfterMs, backoff, reset | WB | FAIL* | relay-commit.ts |
| T-SOCKET-CACHE-WB | attachment parsed once per socket per runtime; wake rebuild skips revoked devices | WB | FAIL* | socket-cache.ts |
| T-RATE-DEVICE | two sockets of one device share one bucket → 1013 | BB | FAIL | commit.ts |
| T-RATE-SOCKET | one socket overdraft → BACKPRESSURE + 1013 | BB | PASS | commit.ts |
| T-SOCKET-CAP-DEVICE | 5th socket evicts the oldest with 1001 | BB | FAIL | commit.ts |
| T-RETIRED-GC | ckpt at lastSeq → gcSeq=lastSeq, read = checkpoint only | BB | FAIL | checkpoint.ts |
| T-PARTIAL-GC | ckpt below lastSeq → open survives | BB | PASS | checkpoint.ts |
| T-MININTERVAL-READY | VAULT_READY minIntervalMs 1000 | BB | FAIL | socket.ts |
| T-MININTERVAL-TIMING | back-to-back commits ≥ ~900 ms apart | BB | FAIL | socket.ts |
| T-ROWS-WB | every §6.2 row count under cfRowModel | WB | n/a | rows.ts |

---

## 8. Flag log and open items

Review flags:

- F1 → accepted (mandatory), now in D3.
- F2 → accepted, now in D3.
- F3 → accepted (mandatory), now in D9.
- F4 → accepted, now in D4.
- F5 → accepted, now in §2.2 and D5.
- F6 → accepted, now in D5.
- F7 → accepted, now in D5.
- F8 → accepted, now in D5.
- F9 → replaced by the new D8b design (approved 2026-10-06).
- F10 → accepted, now in D3.
- F11 → accepted, now in §2.2.
- F12 → accepted, now in H2.
- F13 → accepted, now in H6.
- F14 → accepted, now in H8.
- F15 → decided and done on this branch, now in §2.3.
- F16 → accepted, now in D8a.
- F17 → flipped (buffered frames of a revoked device are dropped), now in D7.
- F18 → accepted, now in H2.

Raised during the fold, now resolved:

- O1 D3 replay scope → key = code + `enrollmentRequestId` + deviceId + token hash; `deviceName` ignored; a revoked
  device → `409 used_code`. Now in D3.
- O2 D3 enroll body → exactly the six fields `readEnrollment` reads; no D6 constants. Now in D3.
- O3 D7 wake rebuild → kept: H5's rebuild skips and closes 4403 sockets whose device is gone.
- O4–O8 D8b gaps (authority drift, stuck flag, writes in the window, concurrent restores, loose ends) → the D8b
  rewrite: config-DO-run steps, alarm resume, `pending_restore_id` marker, re-rewind on writes, authority freeze,
  flag TTL, PK reservation, synchronous 200, error codes.

P1 gap calls (accepted by the coordinator; each is marked `DECISIONS-GAP` in code):

- G1 No `update-manifest.json` in the release (§1 removes update-metadata).
- G2 Config DDL runs on the singleton's first construction.
- G3 `shared/socketLiveness.ts` trimmed to what the relay uses (semanticEpoch is gone).
- G4 `version.ts` keeps only `SERVER_VERSION`.
- G5 `/enroll` body cap 64 KiB (same as claim).
- G6 `:deviceId` path segment uses the legacy enroll deviceId pattern.
- G7 `GET /` and `GET /mobile-setup` are placeholders until P4.
- G8 Unexpected Worker failure → `500 internal_error`.
- G9 Non-JSON enroll body → `400 invalid_code`.
- G10 The Worker checks `streamsVersion` before forwarding; the ticket is checked in the vault DO.
- G11 Malformed blob address → `400 invalid_address`.
- G12 `compatibility_date = "2026-04-07"` (`web_socket_auto_reply_to_close` on); wrangler 4.147.0.

P2 and P4 gap calls (accepted; marked `DECISIONS-GAP` in code). G7 is closed: router.ts serves the P4 pages.

- G13 Operator login limiter: in memory, 20 failures/min → `429 too_many_attempts` (D3's numbers).
- G14 A vault not in the registry → `404 unknown_vault` on operator routes.
- G15 CSRF: every operator write needs a same-origin `Origin`; JSON writes also need the Content-Type; GETs need
  neither (SameSite=Strict carries them).
- G16 A frame dropped by revoke tells holders `STREAM_PROVISIONAL_DROPPED` with reason `commit_failed`.
- G17 Enroll replay ignores code expiry (it needs the original deviceToken, so it grants nothing new).
- G18 Enroll of a deviceId that is enrolled under another code → `409 device_exists`.
- G19 A valid ticket on a non-upgrade request → `426`.
- G20 Vault names: 1–80 chars, else `400 invalid_name`.
- G21 The session cookie is always `Secure` (browsers treat `http://localhost` as secure).
- G22 Claim failing after the config write → `503 claim_incomplete`, with the session cookie set.
- G23 Vault-delete R2 purge: at most 20 batches of 1000 per request, then `503 purge_incomplete` (retry).
- G24 The D3 enroll limiter counts 404, 410 and `409 used_code`; malformed bodies don't count.
- G25 Operator response shapes (the console reads only these): state `{vaults:[{vaultId,name,createdAt}],
  pendingRestores:[{vaultId,at}]}`; devices `{devices:[{deviceId,deviceName,enrolledAt}]}`; owner-code adds
  `mobileSetupUrl`. Neither claim nor owner-code carries a QR; the console draws it (O12).
- G26 The console neither claims nor creates a vault (the user's call, 2026-10-08): only a client's "Create a new
  vault" may pin a vault's encryption, so a console-made vault was a dead end. An unclaimed server's console says to
  run that command in Obsidian; the client sends `/claim` or `/operator/vaults` itself.
- G27 The entry module (`worker.ts`) exports only the fetch handler and the DO classes: workerd treats every named
  export as an entrypoint and refuses to start on a constant. The route table is `router.ts`; a WB test guards it.

P3a gap calls (accepted; marked `DECISIONS-GAP` in code):

- G28 The daily-limit up-front refusal uses the last classified kind.
- G29 H2 build steps are 16,384 rows; the window read is charged one unit per 256 B.
- G30 Cold builds run one at a time, in queue order (a cold stream can wait behind a large build).
- G31 Build steps run once per incoming message and once per timer flush. A forced flush builds inline; a failed
  flush fails the frames it held.
- G32 The per-device rate bucket survives reconnects and is deleted only on revoke.
- G33 While a stream is gated, seq order across streams can differ from arrival order; per stream it is kept.
- O10 (accepted risk) Timer-driven build steps share the CPU budget of the last incoming message, since only
  requests and messages reset it (DO limits page). One message and then silence on a worst-case stream runs
  ≈ 10 steps (≈ 13 ms) in one window, over Free's 10 ms; the platform tolerates infrequent overruns ("built-in
  flexibility", Workers limits page). A vault-DO alarm per step would give each a fresh budget; add it only if
  P5 shows `exceededCpu`. P5: none, but scratch-3's account is Workers Enterprise, so Free's 10 ms is not enforced
  there and cannot show up. Worker CPU p50 0.6 ms (the old server: 2.4 ms). Over 10 ms (GraphQL
  `workersInvocationsAdaptive`): claim 64 ms and owner-code 7–46 ms in the Worker, both rendering the setup QR
  (moved to the console page, O12; Worker max since: 6.1 ms), and VaultDO 4 MiB stream reads 21–24 ms. Still open
  until a Free account is measured.
- O9 → resolved: a daily-limit failure on any route, including one thrown by a DO RPC, is `503 cf_daily_limit`
  with Retry-After (router.ts:187-188; WB in tests/server/reset.ts). Revoke under the latch changes nothing and
  says so; the device keeps its read access until the reset (≤ 24 h). Kept: a gate shut in memory only would not
  survive eviction.

P3b gap calls (accepted; marked `DECISIONS-GAP` in code):

- G34 `POST /vault/:id/blobs/exists` body cap 64 KiB → `413 body_too_large` (50 addresses are ≈ 3.5 KiB).
- G35 A blob GET is always `application/octet-stream` with `nosniff` and `no-store`: blobs share the console's
  origin, so an uploaded HTML or SVG body never renders.
- G36 A restore body that is not a JSON object counts as `{}` (no `at` → `400 invalid_restore_point`).
- G37 The restore alarm re-arms itself while journal rows remain, after the newest row's age clamped to 30 s..1 h
  (about doubling per alarm). The age is read from `created_at`, so an eviction does not reset the backoff (P5: an
  in-memory counter re-armed every 30 s on scratch-3).
- G38 One run rewinds at most 3 times, then `503 restore_incomplete`; the alarm carries on.
- G39 `at` is a date-time with optional seconds, ≤ 3 fraction digits and an explicit zone (`Z` or ±hh:mm).
- G40 `at` is validated even when a restore is pending; the pending one then resumes with its journaled `at`.
- G41 A vault that answers `unknown_vault`, or whose journal row vanished mid-run, ends the run `404 unknown_vault`;
  `restore_unsupported` and `invalid_restore_point` from the vault drop the row.
- G42 An `at` before the vault was created → `400 invalid_restore_point`, with no PITR call. So does an `at` that
  Cloudflare's PITR history does not reach (P5: "Requested time is before this database existed.", or "This
  database has no history." before the first snapshot): nothing was done to the vault, and the journal row is
  dropped.
- G43 Finish reads "`pending_restore_id` still set" as "equals this restoreId": a restore in flight at T leaves its
  own marker in the rewound state, and rewinding never clears that one.
- G44 Enroll's restore 503 runs before the code is read, so a malformed body also gets it.
- G45 The device routes' restore 503 runs after auth and D8c (no oracle); blob and debug routes count as device
  routes.
- G46 An upgrade during a restore is refused after the ticket check, with the error frame and 1013
  `restore_in_progress`; a non-upgrade request with a valid ticket gets the 503.
- G47 TEST-ONLY simulate-daily-limit: `enabled` must be a boolean (else `400 invalid_request`); `200 {ok, enabled}`.
- O11 (accepted risk) Step 0 issues the journal INSERT and `setAlarm` in one synchronous turn (config/restore.ts
  :126-130), so the platform should commit them together (write coalescing); not verified on the platform. A
  daily-limit failure injected at `setAlarm` alone (WB) leaves a row without an alarm: the vault is untouched
  (step 1 never ran), but its authority actions answer `409 restore_in_progress` until the operator presses restore
  again, which resumes the journaled `at`.

E2EE asks (design §19 A2–A4) gap calls (proposed on branch server-remake-e2ee-asks, for review):

- G48 The blob GC limit is 60 authenticated requests a minute per vault DO, shared by list and batch delete (a
  batch of up to 100 addresses is one request), in memory (the D3 limiter, generalized as `WindowLimiter`). A
  refused request does not count; strangers cannot spend it. 60/min holds a looping device to one DO request a
  second, each at most 10 R2 lists or 100 heads and 1 delete.
- G49 The GC list cursor is the last address of the page, passed to R2 as `startAfter`, not R2's own cursor: the
  Worker can check it (`400 invalid_cursor`), it cannot leave the vault's prefix, and deletes between pages do not
  move it. `next` is null once R2 says the listing is not truncated. R2 may answer truncated with no objects; the
  Worker then follows R2's own cursor inside the same request (never returned to the client) for at most 10 list
  calls, else `503 list_incomplete` with `Retry-After: 5`. The 10 and the 5 s are judgement calls.
- G50 The batch delete body is JSON, at most 16 KiB (100 addresses are about 6.6 KiB), else `413 body_too_large`.
  `addresses` is 1–100 addresses (`400 invalid_addresses`, `too_many_addresses`, `invalid_address`); a repeated
  address is `400 duplicate_address`, not merged, so the results match the request 1:1. `ifUploadedBefore` is a
  JSON number that is a safe integer ≥ 0 (a string is refused), else `400 invalid_if_uploaded_before`. One bad
  field refuses the whole call before the DO. Every address gets a result, `absent` included.
- G51 `exists` checks the count (more than 50 → `400 too_many_addresses`) and every entry before any R2 HEAD; the
  silent first-50 slice is gone (the client already chunks at 50).
- G52 The CORS `Access-Control-Expose-Headers` list is gone with the `X-YAOS-Content-*` headers nothing sets.
- G53 The batch delete HEADs 6 addresses at a time, the Workers limit on connections waiting for headers
  (https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections); `exists` keeps the
  legacy 4. The single-address `DELETE /vault/:id/blobs/:addr` it replaced had no users and is removed.

P5 findings:

- O12 → resolved (the user's call, 2026-10-06: the console draws it). The setup QR was rendered in the Worker
  (`qrcode-generator` `make()`: 8 ms cold, 2.6 ms warm on a laptop for the 195-character URL, version 10), which made
  claim and owner-code the only Worker routes over Free's 10 ms CPU (O10). Now the console page inlines
  qrcode-generator 2.0.4's browser build (`dist/qrcode.js`, 56 KB) verbatim as its first nonce script; a wrangler
  Text rule bundles it as text, and the Node tests alias the import to the same file (tests/mocks/qrcodeScript.ts).
  The page encodes setupQr.ts's mobile setup URL on `location.origin` as the SVG the Worker sent. Claim and
  owner-code drop `mobileSetupQrDataUrl` (G25); the console was its only reader and the client never read it. WB:
  tests/server/console.ts matches the drawn modules to the library's for that URL. Headless Chrome on local
  `wrangler dev` (d51c3ae): the encoder runs under the CSP, and jsQR decodes both QRs (claim, owner-code) to the
  exact URL; no page error or CSP violation. On scratch-3 (version 4de93251), the same check signs in and decodes 9
  owner-code QRs to the exact URL. The one failed request is the 401 from `GET /operator/state` before sign-in,
  which shows the sign-in form (console.ts:150). Worker CPU in the minute of those 9 owner-code calls and 10 other
  console requests: max 2.6 ms, p50 1.6 ms (was 7–46 ms). Claim cannot run again on claimed scratch-3. Its Worker work
  is now what login and owner-code do: RPCs, a cookie and a URL (router.ts:261-304). Suite on 4de93251:
  `conformance-scratch3-o12-20261006T132806Z.json`, 48 pass, 0 fail, the same 2 SKIP; Worker CPU over the run max
  6.1 ms, p50 0.5–0.9 ms per minute.
- O13 A refused upgrade (relay-wire §3.1: accept, error frame, close, 101; vault/cloudflare.ts) logs as a VaultDO
  `scriptThrewException` "Network connection lost" on scratch-3. Clients get the frame and the close code (the
  refusal rows pass); the cost is noise in error analytics.
- O14 Two smoke receipts took 1525 and 1660 ms (the next ones 457 and 373 ms) with the same delay at both peers, so
  the commit itself was late. Unexplained; untested guess: frames held during the dedupe index build and
  rescheduled (relay.ts:684-689). p90 only; no check failed.
- O15 (accepted; platform) A restore lands on Cloudflare's latest PITR snapshot at or before `at`, not at `at`.
  Measured on scratch-3 (one frame every 2 s, restored every 2 s): snapshots about a minute apart, the first 45–55 s
  after the vault's init, plus one just before each rewind. So a restore can drop up to a minute of content before
  `at`, and a vault has no restore point in its first minute. The `200` cannot say which snapshot (a bookmark
  carries no time); the console's restore text, confirm and result say "the last snapshot at or before".
  A restore to a point before an earlier restore works (history survives a restore).
- O16 (accepted risk) A step-1 error that is permanent but not classified (G42 lists the two PITR ones seen) keeps
  the journal row: `503 restore_incomplete`, the alarm at ≤ 1 h, and the vault's revoke, owner-code and reset
  frozen (`409 restore_in_progress`) until the vault is deleted; there is no cancel. Seen once on scratch-3, from
  the unclassified "before this database existed", now classified.

## 9. Work plan

| Phase | Work | Exit criterion |
|---|---|---|
| P0 Conformance baseline | BB suite in `e2e/conformance/` for every BB row of section 7; run against scratch-3 and local `wrangler dev` | The suite runs end to end; scratch-3 results recorded, with every difference from the section 7 guesses explained |
| P1 Host skeleton | New Worker router, vault DO and config DO classes; streams core behind ports; legacy `server/src` deleted; README "Cloudflare only". The Node host, Docker and `packages/cli` are already gone on this branch, with the harness adapter in `tests/server/helpers/` | Ported streams WB tests green; T-LEGACY-404 and T-HOTPATH harness in place; `tsc`/lint clean |
| P2 Identity | Claim, login and sessions, vaults, owner code, D3 codes, enroll (replay, D3), D4 tickets, devices list and revoke (D7 gate) | D2–D7 BB + BASELINE green on local dev; T-PAIR-NOWRITE, T-HOTPATH, T-ROWS-WB (identity rows) green |
| P3 Hardening | H1–H8, D8a/D8c, D9 (`v/<vaultId>/<address>` keys); D8b | Every BB row except T-RESTORE-MANUAL green locally (blob rows with local R2); all WB green; H2 cold-scan CPU and D8a DROP+CREATE billing measured |
| P4 Console | `GET /` page and `GET /mobile-setup` (D5) | Manual run on local dev: claim → vault → QR → enroll → revoke → reset; no external assets |
| P5 Deploy over scratch-3 | The coordinator deploys: migration v3 deletes the old DO classes, then v4 adds the two new ones (one migration doing both failed with `10067` at the 500-namespace cap: the API counts the new classes before the deletions) | The full suite is green on scratch-3 except the documented SKIPs; T-RESTORE-MANUAL done once by hand; §15 latencies re-measured |

Status 2026-10-06: P0–P3 done. Combined local run at 15e9bf3: `conformance-local-final-20261006T105356Z.json`,
49 pass, 0 fail, 1 SKIP (T-BLOB-UNAVAILABLE needs an unbound bucket; it passes in
`conformance-local-p3b-nobucket-20261006T104800Z.json`). P4 manual run done on local dev (Chrome, desktop and 375 px): claim → owner code with
QR and `obsidian://` link → enroll (replay 200, reuse `409 used_code`) → revoke from the Devices list (error frame
`authority_superseded` +25 ms, list empty, token `401`) → reset (device kept, socket 1001, old epoch `409`) → restore
(`501 restore_unsupported` message) → vault create and delete → sign out and in → `/mobile-setup` (fragment dropped,
`connect-src 'none'` blocks fetch, foreign host and bad code refused). No external request. Fixed on the way: `.mono`
inputs overflowed the card at 375 px; the `invalid_restore_point` text now names the vault's creation (G42).

Status 2026-10-06 (P5): deployed over scratch-3 in two steps (v3, then v4; §9 row). Suite at c754d59:
`conformance-scratch3-p5-20261006T113415Z.json`, 47 pass, 1 fail, 2 SKIP (T-BLOB-UNAVAILABLE: the bucket is bound;
T-DAILY: no debug route). The fail, T-CODEC-VALID ("timeout waiting for VAULT_READY"), was the network: the Worker
logged `responseStreamDisconnected` 40 ms in and the vault DO's fetch `canceled` after 1 ms, on a client behind
WARP; three re-runs pass (`conformance-scratch3-codecvalid-rerun{1,2,3}-*.json`). e2e/relay/smoke.ts, with `Origin`
on operator writes (G15), 31/31 three times (`client-e2e-smoke-deployed-new-{1,2,3}-*.json`). §15 p50 medians, old
deployed → new: ticket 107 → 91; socket connect 317 → 170; peer PROVISIONAL 57 → 61; own receipt 370 → 989; peer
COMMIT_NOTICE 357 → 994; peer COMMITTED 395 → 374; ping 67 → 64; 12 × 8 KiB burst 467 → 1150; feed 249 → 97; read
page 238 → 93; checkpoint put 266 → 117. The three slower rows are H8: smoke sends each append right after the last
receipt, inside the 1 s `minIntervalMs`; its first sample, from idle, is 372 ms (old 405). relay-wire §15 (the text
after the table) and :163 (`minIntervalMs: 0`) are updated in the PR into client-remake, with :56 (O12).
T-RESTORE-MANUAL failed first: PITR refused T, 11 s after the vault's init, and the runner retried forever with the
vault's authority frozen; fixed in 55cfd32 and f9ce3a1 (G37, G42, O15). Re-run on 55cfd32 (version 243e812e) with T
and T2 each 75 s after the writes they must keep and the vault's first snapshot awaited: 42 pass, 0 fail
(`restore-manual-scratch3-20261006T125029Z.json`). Final suite at f9ce3a1 (version 249ab495):
`conformance-scratch3-p5-final-20261006T125917Z.json`, 48 pass, 0 fail, the same 2 SKIP. P5 is done. CPU: O10,
O12. Open: O13, O14, O16 (O12 resolved after P5).
