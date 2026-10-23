# One device identity per store (design)

Status: approved 2026-10-21 (owner decisions in §12.1). Phases 1–5 are built (§12.2 "Landed" notes; phase 5 on
`identity/phase5-hygiene`, without ring compaction, decision 6). Written on branch `design/identity-per-store` off `sim-port` (eaf05881).
Fixes BACKLOG [CLONED-ID](../BACKLOG.md) and [FRAMENO-IDB](../BACKLOG.md). Section letters (§x.y) are
[DESIGN](DESIGN.md); "e2ee §n" is [e2ee-design](e2ee-design.md). **[U]** = not verified; **[inferred]** = follows
from verified facts but was not tested directly.

## Summary

1. Today the device identity (deviceId + device token) lives in `<configDir>/plugins/yaos/data.json`, which travels
   with the vault folder. Two stores can then share one deviceId: a fresh IndexedDB on the same machine (seed 222),
   or a copied/synced vault folder (a clone). Every replay window, own-frame check and relay rule assumes they never do.
2. Invariant: **a deviceId is used by exactly one store (one IndexedDB), ever.**
3. The identity moves **into the store**: the IndexedDB `meta.identity` record holds deviceId and token, and a new
   store always gets a new identity. The DB is named by a per-install key kept in `app.saveLocalStorage` (Obsidian
   scopes it to that vault registration; verified in the 1.14.4 asar), so the identity cannot travel with the folder.
4. data.json keeps only a **pairing grant**: a credential minted at pairing that lets an install register new store
   identities. Sharing it is fine: a clone just registers its own device. It replaces the device token in data.json
   and is no stronger than that token is today, which can already mint pairing codes.
5. Clones become new devices with no detection needed. After IndexedDB loss the new store fences its predecessor (one
   retire call) and re-issues the predecessor's mirrored unsent frames under its own identity. Nothing is lost.
6. Removed: the wall-clock frameNo floor, the 64 skip, `renumberBlind`, `frameNoFloor` and the "earlier store"
   branches. Changed: pairing, data.json shape, engine start, `Repo.open`, mirrors (`state/<deviceId>/`), server
   (grants, register/retire routes, tombstones), console. About 1.5–2k lines changed across the client and server.
7. One device per wipe, clone or epoch reset adds device rows. Retiring devices (self, successor, inactivity) keeps
   the server list short. Fold replay windows stay forever (~40 B per device and stream), and so do their 64-id
   rings (decision 6: no compaction).
8. No wire or format compatibility cost: the remade client has not shipped. Dev vaults re-pair once (§13).
9. Five phases, each landable on its own (§12). The owner's decisions are in §12.1: the grant lives in data.json
   (clones join automatically).

---

## 1. Problem and invariant

### 1.1 Where the identity lives today

- Minted by the client at pairing: `generateDeviceId` / `generateDeviceToken` (`src/host/ui/pairing.ts:119-126`),
  `prepareEnrollment` (`:297`), sent by `runEnrollment` (`:344`), checked by `readEnrollment` (`:398`).
- Stored as `YaosPluginData.identity: PairedIdentity` (`src/host/ui/api.ts:23-30`) in data.json. The plugin loads it
  with `loadData()` (`src/host/plugin.ts:87`). It reaches the engine as `relay.credential` (`src/host/pluginController.ts:63-65`).
- Enrolled server-side: `enroll` (`server/src/vault/host.ts:527-583`) inserts a `device` row
  (`server/src/vault/schema.ts:14-18`), keyed by token hash and deviceId (`server/src/vault/devices.ts`).
- The relay stamps the socket's deviceId on every frame (`server/src/streams/relay.ts:742`, `:762`).
- The frame AAD binds it (`frameAad`, `src/core/codec/envelope.ts:173-176`; e2ee §7.2).
- The store is named by it: `yaos2:<vaultId>:<epoch>:<deviceId>` (`dbName`, `src/engine/store/schema.ts:31-33`).

### 1.2 Two failures, one cause

**IndexedDB loss (seed 222).** The new store reuses the deviceId but knows only its committed frames. A frame the dead
store had in flight and the new store's first frame can share a frameNo. Whichever commits second folds as
`replay-duplicate` (`src/core/ns/fold.ts:277-286`, `src/core/cfg/fold.ts:209-218`), so a create is lost. Stopgaps:
- the wall-clock floor (44748cb2, f47950cb; `FoldRuntime.skip`, `src/engine/sync/foldRuntime.ts:320-331`);
- `renumberBlind` (`:340-364`, run by `renumberBlindFrames`, `src/engine/runtime/logApi.ts:98-122`, from
  `SessionLoop.afterStartReads`, `src/engine/runtime/sessionLoop.ts:508-514`);
- the planner re-creating an own create that never folded (d1f8a750).

**Clones.** Two installs run with the same deviceId and the same token. Nothing detects it. The repros
(`/tmp/clone-check/engine-cloneId.test.ts`, `sim-cloneId.test.ts`, log `all.log`) show:
- renames reverted on every device;
- `keep.md` trashed;
- frames ignored as `replay-duplicate`.

Each twin takes the other's frames for its own.

### 1.3 The invariant

> **A deviceId is used by exactly one store, ever.** A store is one IndexedDB database with its outbox. A new DB means
> a new deviceId, for any reason: first pairing, clone, IDB loss, `rebuildLocalCache`, `DB_SCHEMA_VERSION` bump,
> vaultEpoch change. A deviceId never returns after its store is gone.

### 1.4 Code that relies on it today

Each site below assumes `deviceId === self` means "this store wrote it":

| Site | What breaks when two stores share an id |
|---|---|
| frameNo allocation, `src/engine/sync/foldRuntime.ts:306-318`; replay windows, `src/core/ns/fold.ts:270-288`, `src/core/cfg/fold.ts:204-220` | Numbers collide: one store's frame is `replay-duplicate` or `replay-stale` |
| `foldEffects` `mine`, `src/engine/compose/foldBridge.ts:52` → own-fold rules, `src/engine/reconcile/ownFold.ts:72-74` (rename) | The twin's rename moves this store's synced record as if done here: reverts, trashes |
| `classifyRow` receipt path, `src/engine/sync/ingestRow.ts:105-108`; `settleAdoptable` `:112` | A twin's row with a cfid in the local outbox would read as a receipt (cfids are random, so only a theoretical collision) |
| provisional ignore, `src/engine/runtime/docRuntime.ts:378` | The twin's provisionals are dropped |
| `lostCreateBody`, `src/engine/compose/logPort.ts:74-78` | The twin's pending create looks lost: this store may upload a duplicate initial body |
| restore duty and bodyVersion, `src/engine/store/repo.ts:503-508`, `:583`, `:602-603` | Own rows past `lastOwnSeq` are treated as "an earlier store's" |
| own-row filter, `src/engine/runtime/context.ts:450-451` | Comment: "own plain rows are an earlier store's" |
| own edge and ring, `src/engine/sync/nsRuntime.ts:102-106`, `src/engine/sync/cfgRuntime.ts:58-62` | Mixes two stores' numbering |
| snapshot floors and own list, `src/engine/snapshots/remote.ts:41`, `:62-64`, `snapshotJob.ts:132-138`; floor per author, `src/core/snap/fold.ts:89` | Twins prune each other's uploads through one floor |
| keyring own records, `src/engine/keyring/keyringRuntime.ts:208` | A twin's `k` append settles this store's flow |
| `adoptKey(deviceId, cfid)`, `src/engine/runtime/context.ts:91-93` | Adopt bookkeeping is shared |
| relay token bucket, `server/src/streams/relay.ts:651-655`; socket cap 4 per device, `protocol.ts:40`, `relay.ts:503-507` | Twins share one rate budget and evict each other's sockets |
| relay pending dedupe `frameKey(deviceId, cfid)`, `relay.ts:742`; H2 window, `server/src/streams/dedupe.ts` | Safe only because cfids are random |
| revoke (`host.ts:687-699`, `relay.ts:1006-1025`) and the device list (`host.ts:673-678`) | Both twins are revoked, or listed, as one device |

---

## 2. Where the per-store identity lives

### 2.1 Requirements

- (a) It survives app restarts and normal operation.
- (b) It does not travel with the vault folder or with sync tools: iCloud, Dropbox, Syncthing, obsidian-git.
- (c) It is lost with its store. If it can outlive the store, it must still never serve a second store.

### 2.2 Platform facts (verified in `~/Library/Application Support/obsidian/obsidian-1.14.4.asar`, read-only)

- `App.loadLocalStorage(k)` is `localStorage.getItem(this.appId + "-" + k)`, JSON-parsed, and
  `saveLocalStorage` mirrors it (asar offset ≈4701610). `this.appId` is the app constructor's argument (≈4662096).
- On desktop the appId is the vault's key in `~/Library/Application Support/obsidian/obsidian.json`
  (`{"vaults": {"a5d60f2cb4de05ee": {"path": ...}}}`). That file is app-global, not in the vault folder.
  - A folder copied and opened as a new vault gets a new registry entry, so a new appId. **[inferred]** from the
    registry shape.
  - Mobile appId derivation: **[U]**.
- **Obsidian Sync does exactly this.** It keeps its state in an IndexedDB named `<appId>-sync` (≈4501759). It stores
  `appId` in that state, and on mismatch it pauses and resets (`e.appId && e.appId !== this.app.appId`, ≈4502148).
- **SecretStorage.**
  - Desktop: the Electron `safeStorage` blob is saved with `app.saveLocalStorage("secrets-encrypted", …)` (≈3571596),
    so it is **per appId**: not shared between vaults, not synced.
  - Mobile: Capacitor `SecureStorage` under the bare key `"secrets-encrypted"`, shared across vaults (e2ee §3).
    iCloud Keychain sync of that item: **[U]**.
  - New finding beyond e2ee §3: a desktop clone of a suite-1 vault has no keys. It is `key-missing` until a QR or RK
    re-key, under both the current and the proposed design.
- **IndexedDB** is per origin. On desktop every vault shares `app://obsidian.md`, so the DB name must tell two
  registrations of the same vault (same vaultId) apart.
- **Mobile eviction.** WebKit can evict an origin's web storage (IndexedDB and localStorage together) under storage
  pressure. Whether Obsidian's `capacitor://localhost` origin is subject to the 7-day ITP cap: **[U]**. Android
  WebView eviction: **[U]**. The design must survive either store vanishing at any time. It does: losing either
  produces a new store and a new identity, never reuse.

### 2.3 Options

| Option | (a) | (b) | (c) | Notes |
|---|---|---|---|---|
| data.json (today) | yes | **no** | **no** | The bug |
| **IndexedDB `meta.identity`** (in the store) | yes | yes | **yes, by construction** | The store must be findable without its deviceId: name it by an install key (below) |
| `saveLocalStorage` only | yes | yes (per appId) | no: localStorage and IDB can be lost separately (`rebuildLocalCache`, schema bump, IDB corruption) | A "is this DB fresh?" check would stand between the id and reuse: the bug class this removes |
| SecretStorage | yes | desktop yes; mobile shared across vaults, so two copies of one vault on a phone share it | no | Same objection, and mobile is not per-registration |

### 2.4 Recommendation

1. **The identity lives in the store.** Extend `MetaIdentity` (`src/engine/store/schema.ts:40-50`) with `deviceToken`
   (SECRET), `host`, `deviceName` and `grantId`. The record is written in the transaction that creates the DB, so
   identity and store are created and lost together. The token is not a crypto key, so e2ee §6.1's "never persist a
   key in IndexedDB" does not apply. The IDB sits in the app profile, which is strictly better than data.json in the
   vault folder.
2. **The DB name uses an install key, not the deviceId:** `yaos3:<vaultId>:<vaultEpoch>:<installKey>`.
   - `installKey` is 16 random bytes, base64url, stored with `app.saveLocalStorage("yaos-install-" + hex(vaultId), …)`.
     That API is public (`obsidian.d.ts:472-480`) and is scoped by appId.
   - If the key is lost, the store cannot be found: a new key, a new store, a new identity. The old DB is an orphan
     (§6.4). That is the safe direction.
   - Alternative: use `app.appId` directly. It is not in `obsidian.d.ts`, but `loadLocalStorage` and Obsidian Sync
     depend on it. Same semantics, one less moving part, but undocumented.
3. **The same localStorage record carries the lineage:**
   `{v:1, installKey, current:{deviceId, retireKey}|null, predecessors:[deviceId…≤8]}`. It is not an identity: it can
   only name the store this install had last, so the next store can find that store's mirrors (§5) and fence it. A
   clone has an empty record.
4. Main writes the record and the worker owns the DB. The worker reports `storeIdentity{deviceId, retireKey}` after it
   mints, and main saves it. If a crash loses that write, the lineage is one store behind. The cost: a missed
   predecessor fence (§5.2 falls back) and an orphan device row (auto-retired, §6).

Requirement (c) holds structurally: no code path can open a socket as a deviceId without opening the DB that holds
its token.

---

## 3. The pairing grant (the enrollment credential)

### 3.1 What it is

- A **per-pairing** credential, not one vault-wide secret: `grant = {grantId, grantSecret}`.
- Minted by `/enroll` in exchange for a pairing code. Stored in data.json in place of `identity`:
  `{host, vaultId, grantId, grantSecret, grantName}`.
- Server rows: `grant(grant_id, secret_hash, name, created_at, revoked_at)`. `device` gains `grant_id`,
  `retire_hash` and `last_seen_day`. A new `retired_device(device_id)` table holds tombstones.
  - *As built (phase 1):* the table is `pairing_grant` (`grant` is a SQL keyword) and also keeps the enroll request id
    and the day counter of §3.3; `pairing_code` gains `used_grant_id` for the replay (DECISIONS §6.1).
- Why per pairing: revoking one lost laptop's pairing leaves the other installs alone. The console can show a grant as
  the "device" users think of, with its stores nested (§6.3).

### 3.2 Routes (all new or changed; free, pre-ship)

| Route | Auth | Effect |
|---|---|---|
| `POST /enroll {pairingCode, enrollmentRequestId, grantName}` | pairing code | Uses the code, creates the grant, returns `{vaultId, grantId, grantSecret, vaultGeneration}`. Same replay rule as today (`host.ts:584-598`). Optionally also registers the first device in the same turn |
| `POST /vault/:id/auth/device {deviceId, deviceToken, retireKeyHash, deviceName}` | grant secret, or the bearer of a live device of the same grant | Inserts the device under the grant. Idempotent for the same deviceId and token hash. `409 device_exists` for another token. `409 device_retired` if the id is tombstoned. Rate limited (§3.3) |
| `POST /vault/:id/auth/device/retire {deviceId, retireKey}` | retire key | D7 revoke of that one device (row deleted, tombstoned, buffered frames dropped, sockets closed: `host.ts:687-699`) |
| `DELETE /vault/:id/auth/device` | device bearer | Self-retire. The client already calls it (`retireDeviceEnrollment`, `pairing.ts:498-511`); the server answers 404 today |
| `DELETE /vault/:id/auth/grant` | grant secret | Leave: revokes the grant and its devices |
| `POST /vault/:id/auth/pairing-code` | device bearer (as today, `host.ts:511-519`) | Unchanged |
| operator: `GET …/grants`, `DELETE …/grants/:id`, `DELETE …/devices/:id` (exists) | operator | Console (§6.3) |

- **As built (phase 1, DECISIONS §10).** Changes from the table above, each for a reason:
  - The **client mints `grantSecret`** and sends it in the enroll body (`{pairingCode, enrollmentRequestId,
    grantSecret, grantName}`); the server mints `grantId` and keeps only SHA-256(secret). The D3 replay must answer
    the same 200 after a lost response, and a server that keeps only a hash cannot return a secret it minted (G56).
  - Grant credentials ride `Authorization: Grant <secret>`, a scheme of their own, so a grant is never mistaken for a
    device bearer (G57).
  - `/enroll` does not also register the first device: the client registers right after (one more request, one code
    path).
  - Register needs `retireKeyHash` (64 lowercase hex). The device name is the grant name; a body `deviceName` is
    ignored. Registering marks the store seen today.
  - Retire by key of a device that is gone or unknown is `200 {retired: false}`; a wrong key `401` (G60).
  - The operator listing is `GET …/devices` with a `grants` array added, not a separate `GET …/grants` (G61);
    "Revoke pairing" is `DELETE …/grants/:grantId`.
  - `POST /auth/pairing-code` takes the grant secret too (decision 3), beside the bearer.
  - **Additive.** The old `/enroll` body (a device, no grant) still works, so the current client enrolls unchanged
    until phase 2. Such a device has no grant: it cannot register stores (`403 grant_required`), but its bearer still
    mints codes and self-retires.
- **Tickets and sockets are unchanged.** They use the store's device token (`relayHttp.ts:279`, `host.ts:617-632`).
- The register route runs on the existing enroll path's DO turn discipline: hash first, then one synchronous
  decide-and-write turn (`host.ts:536-581`).

### 3.3 Abuse and rate limits

- **Anyone with data.json can register devices.** Compare today: anyone with data.json *is* the device and can mint
  pairing codes, so they can already enroll any number of devices. The grant adds no capability. It does add
  visibility (devices are listed per grant) and a cut that does not need the victim's token (revoke the grant).
- Limits, per grant:
  - at most 20 registrations a UTC day and 50 live devices (decision 4). At the cap, registration answers `409
    device_limit`; nothing is retired to make room (G59: the proposal's "retire the oldest not seen for 7 days" is
    dropped, since inactivity retirement after 90 days is phase 5 and a refusal never retires a store with unsent
    edits).
  - Wrong secrets count against the existing per-DO failure limiter, 20 a minute (`server/src/vault/pairing.ts:9-11`,
    `host.ts:528-529`).
- **Tombstones.** A retired deviceId can never register again. Ids are random 128-bit values, so this is a guard for
  "ever", not a collision fix. Note that today a revoked id can be enrolled again with a fresh code: the
  `device_exists` check (`host.ts:555-559`) sees only live rows.

### 3.4 Revocation and rotation

- **Revoke pairing** (operator): the grant and all its devices. Their stores get 401. Registration answers
  `401 grant_revoked`, and the install falls back to unpaired. Notes stay on disk. This is today's "revoke device"
  outcome, at the grant level.
- **Remove device** (operator): one store is retired. If its install still holds a valid grant, it comes back as a new
  device on its next start (§4, row "revoked store"). The console must say so: to block an install, revoke its pairing.
- **Existing devices on revoke (as built):** revoking a pairing retires every live device of it in the same turn
  (D7 per device: buffered frames dropped, sockets 4403, bearer 401) and tombstones them. Removing one device
  leaves the grant and its other devices alone.
- **Rotate the grant secret** (phase 5; §12.2 has the as-built details):
  - `POST …/grants/:id/rotate` (operator) issues a new secret.
  - Live stores fetch it with their device token (`GET /vault/:id/auth/grant`) and rewrite data.json.
  - A thief holding only an old data.json is cut off. Legitimate installs do not re-pair.
  - Today there is no equivalent: revoking a leaked token always forces a re-pair.

### 3.5 Relation to the pairing code flow and the device token

- The pairing code still pairs an install. Its result changes from a device to a grant.
- `pendingEnrollment` (`api.ts:44`, retried at load) becomes a pending grant enrollment.
- The device token stops appearing in data.json, settings (`settingsModel.ts:204`) and the pair modal. It lives only
  in the store and the worker.
- Main needs it today for `requestPairingCode` (`pairing.ts:452-482`) and the retire call. Either route these through
  the worker, or let the grant secret authenticate `POST /auth/pairing-code`. The second is simpler; decided so
  (decision 3) and built in phase 1.

### 3.6 E2EE

- **Keys are vault-wide.** K_e per key epoch; HKDF info binds purpose, vaultId and epoch, not the device (e2ee §5.1).
  The wrap AAD has no deviceId (§11.2). Keys live in SecretStorage, one secret per vault (§6.1).
- So a new store needs **no key enrollment**:
  - same install: it reads the same secret;
  - clone: it is `key-missing` on desktop, where SecretStorage is per appId (§2.2), until a QR or RK re-key, exactly
    as a clone is today.
- **No per-device crypto state survives the change, except:**
  - the frame AAD binds the deviceId, so a predecessor's sealed frames cannot be resent as-is (§5.2);
  - the own seal count for the roll trigger (e2ee §4.2) is per store. A new store starts at 0. The vault-wide
    `headSeq − firstSeq(e)` trigger still bounds the key. This is already true after IDB loss today.
- **Revoke flow (e2ee §14.2):** step 1 becomes "revoke the **pairing**". Revoking only the device lets the holder of
  the grant register again. Re-key (steps 2–4) and the stale-epoch rule (§14.3) do not change: they key on keyEpoch
  and seq, not on deviceId.
- `storedKeyringRecords` and `findKnownEpoch` (`src/engine/compose/knownEpoch.ts:26-73`) filter DB names by
  deviceId. They filter by installKey instead.

---

## 4. Lifecycle

"Mint" = generate deviceId (16 B), token (32 B) and retireKey (32 B) in the worker (the same generators as
`pairing.ts:119-126`), then register them (§3.2). Minting needs the network. That is no new restriction: a store
cannot be created offline today either. A fresh store must first learn the vaultEpoch from the relay
(`LogEngine.start`, `src/engine/runtime/engine.ts:62-70`; `findKnownEpoch` → connect first).

| Case | What happens |
|---|---|
| **First pairing** | Pair: data.json gets the grant. Engine start: no DB for `(vaultId, installKey)`, so mint, register and connect (learn the epoch). Create `yaos3:…` with the identity in `meta.identity`. Report it to main, which writes the lineage `current` |
| **App start, existing store** | `findKnownEpoch(installKey)` names one DB. Open it and read the identity. Offline start works as today (§e.1). The grant is not touched |
| **IDB lost, same install** | No DB, but the lineage names `current = P`. Mint S and fence P with its retireKey (best effort). Then predecessor recovery (§5.2): P's mirrors are re-issued as S's frames. Lineage: `current = S`, P pushed onto `predecessors` |
| **Clone** (copied or synced folder; new appId) | No localStorage record: a new installKey and empty lineage. Mint and onboard (§j.5). Others' `state/<id>/` dirs are foreign: ignored and never deleted |
| **Store revoked by the server** (ticket 401) | Try registering a successor with the grant. **Grant valid:** the old store is intact, so this is an orderly replacement. Flush the outbox to the mirror, mark P as predecessor, delete the DB and run the IDB-lost path. No fence call needed: the relay gate already shut P (`relay.ts:1006-1025`). **Grant revoked:** phase `unpaired`, as today's "Pair this device again" (`statusBar.ts:147`) |
| **Offline at first start** | As today: the engine waits and retries (`retryStartNow`, `protocolEngine.ts:358-364`). Disk edits stay on disk, mirrors stay. Nothing is written to the log |
| **Offline after IDB loss** | Same: no epoch is known, so nothing starts until online. Today's offline IDB-loss start fails the same way (no DB, no epoch) |
| **vaultEpoch change** (§c.12) | The new epoch's DB is a new store, so **mint a new identity**. Authenticate the registration with the old store's live device token (or the grant). Step 6 (delete the old DB once live) also self-retires the old id (`DELETE /auth/device`). `frameNoFloor` is no longer needed (§7). Path bases and doc deletes carry over unchanged: they are disk-path state, not identity |
| **`rebuildLocalCache`, `DB_SCHEMA_VERSION` bump, `Repo.open` mismatch** (`engine.ts:84-89`) | Today these delete and reopen under the same deviceId. Now: flush the mirror, delete the DB, mint, and run predecessor recovery with the old id as P (self-retired, since its token is still in hand) |
| **data.json lost, store intact** | The store keeps its identity. Today a lost data.json means re-pair (e2ee §6.2). Optionally (phase 5) the store re-fetches the grant with its token and rewrites data.json. The suite pin is lost with data.json and still needs an authenticated source (§12.4), unchanged |
| **Re-pair to another vault** | New grant. The old grant is left with `DELETE /auth/grant` (replaces `retireDeviceEnrollment` in the pair modal, `pairModal.ts:107`). The old store goes with its vaultId's DBs |

Engine start becomes: host init (no deviceId; grant plus host) → worker: find or create the store → identity →
`self`. `EngineInitConfig.deviceId` (`vaultRuntime.ts:179`, `:247`, `protocolEngine.ts:228`, `:239`, `:314`) goes
away. `config.sideState` (seeded at init, `protocolEngine.ts:237`) is read after identity instead, through the
existing worker side-file reads (`hostRuntime.ts:277-313`).

---

## 5. The old store's frames and mirrors

### 5.1 In-flight frames

A frame the dead or twin store had in flight commits under its own deviceId and folds as another device's frame. This
is correct: it is a real edit, with its own replay window and no collision. The §8.2 "boundary (open)" in e2ee
disappears too: a late old frame is no longer stale against the new store's numbers, because the two never share a
window.

### 5.2 Mirrors, and recovery from IDB loss

**Layout.** Side files move to `<configDir>/plugins/yaos/state/<deviceId>/{outbox-a,outbox-b,synced-a,synced-b}.bin`
and `state/<deviceId>/snapshots/` (`SideFileName`, `src/ports/vault.ts:98-105`). The headers already carry vaultId,
epoch and deviceId (§e.4).
- A store reads and writes only its own dir, plus its lineage predecessors' dirs during recovery.
- It never deletes a dir it does not own: deleting a synced folder's foreign dir would delete a live twin's mirror on
  the twin's machine.

**Recovery (IDB lost; replaces `recoverFromMirror`, `src/engine/runtime/mirrorIo.ts:144-183`, `engine.ts:139-145`).**
Fresh store S, predecessor P from the lineage:

1. **Fence.** Retire P with its retireKey (`POST /auth/device/retire`). From the D7 revoke turn on, no row of P can
   commit: the gate is shut and the relay drops P's buffered frames (`relay.ts:1006-1025`). If P is already gone,
   that counts as done.
2. **Read P's mirror.** Open each frame with AAD deviceId = P (today `mirrorIo.ts:158` uses `c.self`). Keys are
   vault-wide (§3.6). Import the frames as **inherited** records, which cannot be sent, in their mirror order with
   their `dependsOn` links.
3. **Commit check, after the ns/cfg/k start reads.** Hook the existing point where sends open (`afterStartReads`,
   `sessionLoop.ts:506-519`).
   - An inherited ns/cfg frame committed iff its cfid is in P's ring or its frameNo is covered by P's replay window.
     P's ring holds its last 64 frames, and §8.2's send window keeps P's in-flight frames within 32 of its edge.
   - Committed frames are dropped.
   - Body and canvas frames are re-issued whatever their state: Yjs updates are idempotent.
4. **Re-issue.** Each frame still uncommitted becomes an own S frame: a new cfid, a new frameNo from S's allocator,
   sealed under S, in the same order. Adoptable records whose source committed meanwhile settle as today. Ops are not
   re-planned. They are P's intents on this same disk, as P would have resent them.
5. **Synced mirror.** Import P's synced mirror as today (§i.5 step 3: `hasBase = false`, `bodyVersion = null`).
6. **Local snapshots.** Move `state/P/snapshots/` to `state/S/snapshots/`. S's retention (`remote.ts:62-64`) counts
   S together with its lineage, and prunes P's remote uploads with `del` ops (`src/core/snap/record.ts:70`; any device
   may `del`).
7. **Delete `state/P/`** once S's own mirror reaches generation ≥ 1. Nothing is destroyed before its replacement
   exists (§i.5).

**Without the fence:** the retireKey is missing (a crash before main saved it) or the call fails. Step 3 then runs
after the session's first full read *and* at least one relay flush interval after S's socket opened. P's process is
dead (its store is gone on this install), so only the relay's pending buffer could still commit a P frame, and that
buffer flushes within one commit interval. This window is accepted. The fence makes it exact.

**Without lineage** (both web storages evicted, or a clone): no predecessor, so DESIGN §i.5 "without mirrors" applies.
That is onboarding: identical files adopted, differing ones conflict-copied. P's dir stays until a later store of the
same lineage, or the user, removes it. Today's IDB loss without mirrors behaves the same.

**Clones never adopt a twin's mirror.** The twin is alive and sends those frames itself. Replaying them would apply
P's intents twice, and late enough to revert later changes.

**`lostCreateBody`** (`logPort.ts:74-78`): `e.createdBy === c.self` becomes `createdBy ∈ {self} ∪ lineage`. Only this
install has the file whose initial body was lost. A twin's create is the twin's to upload: two devices uploading one
initial text would duplicate it in Yjs.

---

## 6. Device-list growth and retirement

### 6.1 Growth

Each event adds one device row:
- per install: each IDB loss, clone, `rebuildLocalCache` and schema bump;
- per device: each vaultEpoch change (reset or restore, operator actions).

Device rows are read once per DO runtime ("rows read per runtime = meta 1 + devices N", `devices.ts:1-2`), so N must
stay small.

### 6.2 Retirement

Retired rows are deleted and tombstoned. A tombstone is one indexed read at registration and is never loaded into
`DeviceMap`. Four ways a device is retired:
- **Self:** the epoch migration's old id (§4), and an orderly replacement's old id.
- **Successor:** the predecessor fence (§5.2).
- **Inactivity:** a device not seen for 90 days (decision 4; phase 5) is retired lazily, at the next registration, device
  status query or listing (built in phase 5, §12.2).
  - "Seen" is `device.last_seen_day`, written at ticket issue at most once per UTC day: ≤ 1 row per device per day.
  - This deviates from §6.1's "0 rows per bearer auth". The owner accepted it (decision 4); DECISIONS §6.1, §6.2 and
    D4 state it. Phase 1 records `last_seen_day`; the 90-day retirement itself is phase 5.
  - A retired store that comes back replaces itself (§4, revoked row).
- **Operator:** "Remove device".

### 6.3 Console

- List grants: name, paired date, last seen (max over its devices), number of live devices.
- Expand a grant to its devices: id prefix, registered, last seen.
- Actions: **Revoke pairing** (blocks) and **Remove device** (tidies). §3.4 has the semantics.
- Device names come from the grant name. `uniqueDeviceName` (`server/src/vault/pairing.ts:34-40`) would otherwise
  produce "Mac 7" after a few wipes.

### 6.4 Client-side per-device state

**Fold replay windows** (`state.replay`, `state.recentFrames` in ns and cfg; checkpointed in nsFoldV1 / cfgFoldV1):
- A window is R plus a 64-bit bitmap plus the deviceId, about 40 B. **Keep windows forever.** An honest relay already
  refuses a retired device's appends (`validateActor`). A *malicious* relay can re-commit any old genuine frame, and
  only the window rejects that (e2ee §8.1). Pruning a retired device's window would reopen the replay, and the client
  cannot verify "retired" anyway: the server says so.
- The ring is up to 64 cfids per device, about 1.5 KB per device and stream. For devices whose last frame is more than
  K seqs old, the ring looks redundant for every ns/cfg frame: frameNo ≥ 1 is mandatory (§8.2), and the window alone
  rejects every re-commit. Compacting those rings to empty needs a `FOLD_RULES_VERSION` bump and a `verify` change
  (`src/core/ns/verify.ts:136`, `src/core/cfg/verify.ts:41` require ring ≥ 1). Not done (decision 6). Sized: 1,000 retired
  devices cost about 40 KB per checkpoint with compacted rings, 1.5 MB without.

**Other client state:**
- Snapshot floors (`snapFoldV1`, one entry per author): small. Dead devices' uploads are pruned by their lineage
  successor (§5.2), else they stay until a user deletes them. Today's dead devices behave the same.
- **Orphan DBs** (localStorage lost, IDB kept): enumerate `yaos3:<vaultId>:*`. Delete those whose `meta.identity`
  deviceId the server reports retired (as built in phase 5: one `POST /auth/device/status` for all of them; "unknown"
  is kept, §12.2). Never delete on age alone: on a shared desktop origin, another registration of the same vault owns
  DBs too.

---

## 7. Code that goes, and code that changes

### 7.1 Removable (once the invariant holds)

| Code | Why it can go |
|---|---|
| Wall-clock floor: `WALL_FLOOR_MAX`, `wallMs`, the clock part of `skip` (`foldRuntime.ts:40-41`, `:107-110`, `:320-331`, `engine.ts:107`) | A new store's own edge is 0 under a never-used id: no collision is possible |
| The NS_DEDUPE_RING skip of the first allocation, and the re-skip "once the fold shows an own frame above every allocation" (`foldRuntime.ts:306-318`) | Every own number is in this store's outbox, own tail rows (written by T_receipt) or fold R. Allocation and the outbox write share the edit chain (§8.2), so `next = 1 + max(known)` is exact. NS_DEDUPE_RING itself stays: it sizes the ring |
| `renumberBlind`, `renumberBlindFrames`, its call (`foldRuntime.ts:340-364`, `logApi.ts:98-122`, `sessionLoop.ts:511-514`) and the repo's renumber-reseal bookkeeping (`repo.ts:163`) | "Allocated before the store knew its committed frames" cannot happen. **Keep** the gate that opens ns/cfg sends only after the start reads: the late-receipt reads (§d.7) and stale-epoch resealing (e2ee §14.2 step 4) need it |
| `frameNoFloor`: `MetaFrameNoFloor`, `raiseFrameNoFloor`, the carry (`schema.ts:71-80`, `repo.ts:172-173`, `:220`, `:233`, `:248-257`, `:875-876`, `protocolEngine.ts:129`, `:270`, `:378-384`, `engine.ts:83`, `:105-106`, `options.ts:146`, `vaultRuntime.ts:93`, `:180`) | The new epoch's store has a new id. The e2ee §8.4 splice argument then rests on separate windows, not on a carried floor |
| "Earlier store" branches: `repo.ts:503-508` (`|| seq > r.lastOwnSeq`), `:583`, `:602-603`; `context.ts:450-451` | Every own row is receipted by this store, so the clause reduces to `deviceId !== self`. It can stay as a harmless guard |
| d1f8a750's "own create that never folded" re-create in the planner | Becomes unreachable for collisions. **Keep it**: it is also the right answer for a create that was refused or poisoned. Verify before removing |

Net: about −250 lines in src, plus their tests. The planner/ownFold logic itself does not change: it was right, its
input was wrong.

### 7.2 Must change (rough size, including tests)

| Area | Change | Size |
|---|---|---|
| Server | `grant` and `retired_device` tables, `device` columns; `/enroll` → grant; register, retire, self-retire and leave routes; tombstones; per-grant limits; `last_seen_day`; lazy inactivity retirement; operator grant routes | ~500 src + ~600 tests |
| Console (`server/src/console/console.ts`) | Grants with nested devices; revoke pairing vs remove device; texts | ~150 |
| Pairing and data (`pairing.ts`, `api.ts`) | Grant enrollment, pending-grant retry, sanitizers; device token out of data.json | ~200 |
| Plugin controller and UI (`pluginController.ts`, `pairModal.ts`, `settingsTab.ts`, `settingsModel.ts`, `statusBar.ts`) | Host identity without deviceId; lineage record via `saveLocalStorage`; `storeIdentity` message; leave and re-pair; device info read from the worker | ~250 |
| Protocol (`src/protocol/messages.ts`) | `EngineInitConfig` without deviceId and credential; plus grant, installKey, lineage; `storeIdentity` event | ~60 |
| Engine start and store (`engine.ts:62-110`, `repo.ts:200-238`, `schema.ts`, `knownEpoch.ts`, `protocolEngine.ts`, `vaultRuntime.ts`) | Find or create the store by installKey; mint and register on create; token in `meta.identity`; `self` from the store; epoch migration mints and self-retires | ~350 |
| Relay adapters (`relayHttp.ts`, `wsRelay.ts`, `webEngine.ts`) | Credential from the store; register call | ~80 |
| Mirrors and recovery (`mirrorIo.ts`, `mirrors.ts`, `syncedMirror.ts`, `sideFiles.ts`, `vault.ts:98-105`) | `state/<deviceId>/`; inherited records; commit check; re-issue; snapshot dir move | ~350 |
| Planner input (`logPort.ts:74-78`), snapshots (`remote.ts`, `snapshotJob.ts`) | Lineage-aware `lostCreateBody` and retention | ~80 |
| Sim (`src/sim/device.ts:191`, `:287`, `faults.ts`, `run.ts:546`, invariants keyed by device name) | Identity per sim store; `idbWipe` mints; new faults (§10) | ~300 |
| Docs | DESIGN §c.12, §e, §e.4, §i.5; e2ee §6.2, §8.2, §8.4, §14.2; relay-wire §2.4; operations | ~150 lines of prose |

---

## 8. Clone detection and data.json races

- **No detection is needed for correctness:** a clone is a new device. A one-time notice still helps when a fresh
  store finds `state/<other>/` dirs written in the last day and has no lineage: the folder is being copied or synced
  by another tool. The text: "This vault folder looks synced by another tool as well. YAOS works, but two sync tools
  on one folder produce conflicting copies; exclude `.obsidian/plugins/yaos/` from the other tool." Optional, phase 4.
- **data.json is synced by those tools too.** Plugin settings writes from two machines race, and the sync tool's last
  writer wins. Field by field:
  - **Fine to share:** grant, host, vaultId, engine settings, the suite pin (vault-level, never lowered: §6.1).
  - **Must be per install:** move these to the localStorage record.
    - `creating` (§15.1, "this device created that vault and may still choose its encryption"): a synced marker
      could make a twin think it created the vault.
    - `pendingEnrollment` (`api.ts:44`).
    - `deviceLabel` (`api.ts:35`): conflict-copy names would collide.
    - `showStatusBar`: a preference.
  - Under the current design these fields are wrong for clones as well. This design just makes the split explicit.

---

## 9. Security review (deltas)

| Threat | Today | Proposed |
|---|---|---|
| Stolen data.json (git push, iCloud share, backup) | The thief *is* the device: a live token. It can open sockets and mint pairing codes. Revoke = the victim re-pairs too | The thief holds a grant and can register devices, with the same capability class and rate limits. Each device is listed under its grant. Revoke pairing = the victim re-pairs. With rotation (§3.4) only the thief is cut off. No live session token in the vault folder |
| Stolen IndexedDB (app profile) | Nothing secret | The device token of that store. Profile access already implies plugin-level access (e2ee §2.1) |
| Malicious relay: replay | Rejected by per-device windows (e2ee §8.1) | Unchanged; windows kept forever (§6.4). New stores do not weaken it |
| Malicious relay: membership | Can invent devices, refuse enrolls | Same, plus refusing registration (DoS) and false "retired" claims. The client never prunes on them |
| Planted mirror in `state/<P>/` | Not applicable | Suite 1: forging needs K_e (AEAD with deviceId P). Suite 0: whoever writes the folder can edit notes anyway. Only lineage predecessors' dirs are ever read |
| Registration flood | Not applicable (pairing codes are one-shot) | Per-grant limits; the failure limiter; tombstones |

Can the relay now trust "one socket set per device"? For **accounting**, yes: the token bucket and socket cap
(`relay.ts:503-507`, `:651-655`) now meter one install. It may lower `MAX_STREAM_SOCKETS_PER_DEVICE` or treat a new
socket as superseding older ones. For **security**, no: a duplicated app profile (Migration Assistant, a Time Machine
restore onto a second Mac) still yields two live installs with one store, one appId and one token. Obsidian Sync has
the same exposure. The relay cannot tell that from a reconnect overlap. This is accepted residual risk (decision
7).

---

## 10. Test plan

**Unit (core, server):**
- Allocation: a fresh store's first frameNo is 1. `allocFrameNo` equals `1 + max(known)` after a restart with
  receipted-unfolded frames.
- The commit check over a predecessor's ring and window: committed, uncommitted, stale.
- Lineage record sanitizer.
- Server: grant enroll and replay; register idempotency; `device_exists`; `device_retired`; limits; retire by key;
  self-retire; leave; revoke pairing cascades to devices and closes sockets; the operator listing has no token
  material (T-DEVICES-LIST); inactivity retirement; `last_seen_day` writes at most once a day.

**Engine (`src/engine/runtime/*.test.ts`, startTestEngine with an injected store or identity):**
- The clone repros from `/tmp/clone-check/engine-cloneId.test.ts`, adapted. Two engines start from the same
  data.json/grant on separate storage, so they mint different ids. Assert all of:
  - no `replay-duplicate`;
  - no reverted renames;
  - nothing trashed;
  - all of both twins' docs and cfg values converge.
- IDB loss with mirrors: the predecessor's uncommitted ns rename, delete and create are re-issued once. A committed
  one is not re-issued (in the ring). A body edit arrives.
- IDB loss with the fence unavailable: the commit check after the flush interval.
- An orderly replacement (`rebuildLocalCache`, `Repo.open` mismatch) mints and keeps the outbox.
- A store revoked with a valid grant replaces itself; with a revoked grant it goes `unpaired`.
- Epoch migration mints and self-retires; no `frameNoFloor` key is written.

**Sim:**
- `idbWipe` mints a new sim deviceId: SimDevice decouples `name` from deviceId, and invariants key by name. The
  `run.ts:546` oracle uses the name already.
- Promote seed 222's minimized plan as a regression, checked to fail with the fix reverted (sim/regressions/README):
  `[{"i":18,"gapMs":1096,"fault":{"t":"engineCrash","dev":0}},{"i":131,"gapMs":0,"user":{"t":"attach","dev":0,"name":3,"size":3188}},{"i":20,"gapMs":500,"fault":{"t":"idbWipe","dev":0,"mirrors":false,"downMs":466}}]`
  with config `{"devices":2,"faults":"DEFAULT_FAULTS","faultRate":0.35,"seed":222}`. Run it with the wall floor
  removed. Today it passes only because of the floor.
- New fault `clone{src, dst}`: device dst's vault folder, data.json and `state/` become copies of src's. dst gets a
  fresh storage and a fresh localStorage, and both run. Invariants: convergence, no own-check confusion (a device
  never receipts a frame it did not send), no foreign `state/` dir deleted.
- New fault `syncedConfig{a, b}`: data.json and `state/` kept in sync between two devices, last writer wins after a
  random delay, like iCloud. Checks the per-install split of §8 and that foreign dirs are left alone.
- New fault `webStorageEvict{dev}`: IDB and localStorage lost together (lineage lost). Expect onboarding behaviour
  and nothing destroyed.
- Soak with the floor and renumber code deleted, to confirm the invariant carries the load.

---

## 11. Alternatives considered

- **Wall-clock floor (today's stopgap).** Assumes the clock moved forward across the loss, and that the dead runtime
  allocated fewer frames than milliseconds passed. Does nothing for clones (both twins' clocks are current) or for
  own-check confusion. Inflates frameNos to about 2^41. Rejected as the fix.
- **Relay fence** (a new socket of deviceId X supersedes older ones and drops their buffered frames). Solves the
  in-flight race for IDB loss only. Clones then fight: each connect kicks the twin, and own-checks still misfire. In
  this design a fence remains, but per predecessor and exact (§5.2 step 1).
- **Incarnation tag B** (a per-store writer tag in the frame and AAD, with windows keyed by (deviceId, tag); DESIGN
  §i.5 research, e2ee §8.2):
  - Fixes frameNo collisions.
  - But every own-check site (§1.4) has to compare (deviceId, tag). Folds and checkpoints grow by tags. Relay and
    server state (bucket, revoke, device list) still see one device.
  - It is "per-store identity" bolted under a shared id. Rejected: the same scope of change, a weaker result.
- **New deviceId by re-pair** (detect a clone or IDB loss, then ask the user to pair again). It needs a detector: an
  install marker in localStorage, which this design uses anyway. It needs a second device or the console for every
  wipe. A phone that loses IDB unattended stops syncing until the user acts. Rejected: the grant makes the same thing
  automatic.
- **Identity in localStorage only** (§2.3). Rejected: the identity can outlive its store, and a freshness check would
  guard reuse: the bug class this design removes.

---

## 12. Decisions and plan

### 12.1 Decisions (owner, 2026-10-21)

1. **The grant lives in data.json.** A clone joins without a prompt. The folder holds a credential, as it holds the
   device token today, and the grant is no stronger (§3.3, §9).
2. **An epoch change mints a new identity:** one rule, "new DB ⇒ new id". `frameNoFloor` goes in phase 4.
3. **The grant secret authenticates `POST /auth/pairing-code`.** Main keeps no device token. Built in phase 1.
4. **Limits:** 20 registrations a day per grant, 50 live devices per grant, inactivity retirement after 90 days
   (phase 5). Phase 1 only records `last_seen_day`, and its one write per device per day is an accepted deviation
   from the server's "0 rows per bearer auth" (DECISIONS §6.1).
5. **Install key in `app.saveLocalStorage`** (documented API), not `app.appId`. Phase 2.
6. **No replay-ring compaction.** Never prune windows. The ring cost (~1.5 KB per device and stream) is accepted.
7. **Duplicated app profiles** (Migration Assistant, Time Machine onto a second Mac): accepted and documented
   residual risk (§9); no detection.
8. **Keep the d1f8a750 planner re-create** (§7.1) as a safety net.

### 12.2 Phases (each testable and landable alone)

1. **Server grants.** Tables; `/enroll` → grant; register, retire, self-retire and leave routes; tombstones; limits;
   console. Server tests only. The client still enrolls devices the old way: keep the old `/enroll` body until phase 2,
   or switch both in one landing. Either works pre-ship.
   - **Landed** on `identity/phase1-server` (DECISIONS §10, tests/server/grants.ts), additive: the old `/enroll` body
     is kept, so the current client enrolls and syncs unchanged. Also built: retire by key (the successor fence's
     route, used from phase 3), grant pairing codes, `last_seen_day`, "Revoke pairing", and a D8b restore that
     carries grants and tombstones across the rewind. Not built: grant rotation and inactivity retirement (phase 5).
     Old device rows are kept, since the current client uses them.
2. **Per-store identity, no recovery yet.**
   - Client grant pairing; data.json shape; installKey and lineage record.
   - `yaos3:` DB names by installKey, identity in `meta.identity`, mint on create, `self` from the store.
   - Mirrors move to `state/<deviceId>/`.
   - IDB loss falls back to "without mirrors" onboarding.
   - Lands with the clone engine tests and the sim `clone` fault green. The floor and `renumberBlind` are still present
     but inert.
   - **Landed** on `identity/phase2-client`. Deviations:
     - The minted identity waits in a pending DB `yaos3-pending:<vaultId>:<installKey>` until its store is created
       (the store's name needs the epoch, which only a connect as that identity learns); LogEngine drops it right
       before creating the store, so it serves at most one store. A restart before then reuses it.
     - Lineage-aware `lostCreateBody` (a phase-3 item) landed here: without it a doc created by an earlier store of the
       install, whose body was lost with that store, stayed stuck (fault-heavy sim seed 17, `idbWipe` without mirrors).
     - The other phase-3 recovery (fence, mirror import) is not built: every IDB loss is "without mirrors". The sim
       oracle counts every `idbWipe` / `idbLost` as one (the composed mirror-recovery tests are `todo` with phase-2
       variants asserting the conflict copy).
     - Not built: epoch-change minting (phase 4: an epoch migration keeps the store identity), the revoked store's
       successor (built in phase 3), the §8 per-install data.json split (phase 4). A re-pair to the same vault keeps the store.
     - Found: the "abandoned creator" gap (BACKLOG CLONED-ID).
3. **Predecessor recovery.** Fence, inherited records, commit check, re-issue, synced mirror import, snapshot move,
   lineage-aware `lostCreateBody`. Seed 222's plan and the `idbWipe` sim with mirrors green.
   - **Landed** on `identity/phase3-recovery` (DESIGN §i.5 "Predecessor recovery", "Store revoked by the server",
     "Abandoned creates"). The sim oracle is mirror-aware again (only `idbWipe` without mirrors loses the store's
     unsent ops); the two composed mirror-recovery tests run again, and the phase-2 variants now drop the mirrors too.
     As built:
     - The fence runs in the composed engine's identity resolution, right after the pending identity registers and
       before the store's first connect, for every predecessor it holds a key for (the worker's earlier stores and the
       install record's `current`, passed as `EngineInitConfig.predecessor`). Its outcome is recorded with the
       inheritance marker `meta.identity.inherit {dirs, fenced}`, written when the store is created; the import
       (`Repo.tInherit`) clears it in the same transaction, so a crash in between re-runs it.
     - Source: the newest lineage dir with a valid outbox mirror (not only the newest predecessor): a store that died
       before its first mirror leaves its predecessor's dir in place, and a store mirrors what it inherited before it
       sends any of it. The outbox mirror format is 2: re-issued ns / cfg frames carry their `origins`, so a chain of
       losses still finds the identity that may have committed.
     - Commit check: `FoldRuntime.committedTest` (ring, replay window, tail above the fold) per origin, at every session
       start while inherited frames wait (`logApi.checkInherited`), before `renumberBlindFrames`. Without the fence it
       waits `inheritUnfencedWaitMs` (10 s) after the start.
     - Snap-index and keyring frames are not inherited (the snapshot job uploads again; the keyring flow restarts from
       `k`). Local snapshots are copied, and the predecessor's copies removed with its mirrors once this store's
       outbox and synced mirrors are written (`VaultRuntime.dropLineageDirs`): the side-file port deletes files, never
       a dir. Retention and "already uploaded" count the lineage's uploads (`SnapIndexPort.lineage`).
     - A revoked store (phase `revoked`) registers a successor first and only then stops, deletes its store and
       restarts; a refused registration keeps the store (`ProtocolEngine.onStoreRevoked`).
     - Abandoned creator (BACKLOG): a new server route `POST /vault/:id/auth/device/status {deviceIds}` (bearer, ≤ 32
       ids: `live` / `retired` / `unknown`). A body-less doc whose creator reads retired for 30 s is `lostCreateBody`
       on every device. `lostCreateBody` now deletes the empty doc in every case and a holder re-creates its file as a
       new doc (it no longer pushes the file into the empty doc: several holders would each insert the text). The sim
       clone fault no longer skips such windows; it removes the abandoned store's registration 60 s after the clone
       (or at heal), as the console's "Remove device" or phase 5's inactivity retirement would.
     - Seed 222's plan is green, and also with the fence and the wall-clock floor both disabled (a new store has a new
       deviceId and so a fresh replay window), so it is not committed as a regression.
4. **Removal.** Delete the wall floor, the skip, `renumberBlind`, `frameNoFloor` and the earlier-store branches.
   Epoch migration mints and self-retires. Soak. Update DESIGN and e2ee docs. Close CLONED-ID and FRAMENO-IDB. Add the
   optional clone notice and the §8 per-install split of data.json fields.
   - **Landed** on `identity/phase4-removal`. As built:
     - **Removed:** the wall-clock floor (`FoldRuntime.skip`, `WALL_FLOOR_MAX`, `wallMs`; ClockPort's rule is back to
       "never for ordering or fold decisions"), the NS_DEDUPE_RING skip of a runtime's first allocation and its
       re-skip, `renumberBlind` / `renumberBlindFrames` and the `frame-renumbered` diag, the epoch `frameNoFloor`
       (`MetaFrameNoFloor`, the carry through `EngineOptions` / `VaultRuntimeStart` / `ComposedEngine.migration`,
       `ownFrameNoFloor`), and the "earlier store" clauses (`seq > lastOwnSeq` in `tLive`, `tReadPage`,
       `tReleaseQuarantine`; the context comment): an own row without its outbox record is one this store settled.
       `allocFrameNo` is `1 + max(R, own rows above the fold, receipts, the outbox)`: a fresh store starts at 1.
       e2ee-design §8.2 states why that is exact.
     - **The skip was checked, not assumed:** every number is sent only from the outbox written in the allocating
       chain step, and leaves it only through a receipt that writes the own tail row. One hole was found and closed
       instead of keeping the skip: a re-read of an own row that does not open (a reader-dependent gate failure)
       replaced the receipt's row with an unopened one (frameNo 0), hiding the number. `putTail` now never replaces an
       opened row with an unopened copy of the same frame.
     - **Kept:** the gate that opens ns/cfg sends only after the start reads (late receipts §d.7, stale-epoch reseal,
       the inherited commit check); the d1f8a750 planner re-create (decision 8; DESIGN §f.2 now names it a safety net);
       `recoverFromMirror` (own mirror under the same deviceId) for engine tests that start without a store identity:
       production never reaches it (a new store's own dir is empty).
     - **Epoch migration mints** (decision 2). The old store's identity opens only its own DB: a start whose connect
       names an epoch the found store has no DB for ends with `StoreEpochError`, and the composed engine registers a
       pending identity with the grant (no extra connect: the error carries the epoch) and starts again. No fence and
       no frame inheritance (the old outbox goes with §c.12 step 5; its mirrors are of the old epoch and never match),
       but the old dir is the new store's lineage, so its local snapshots (the migration's "epoch" one) move over and
       its files are removed after. At live, `retireOldEpochs` retires each other-epoch DB's identity by its retire key
       (the self-retire) and deletes the DB; a retire without an answer keeps the DB until the next live. Sim test:
       both devices of an epoch reset run as new devices, the old ids read retired, one `yaos3:` DB each.
     - **Two stores at once** (the old epoch's until the new one is live and retires it, or a crash between the
       retire and the delete): the new store's identity names the ones it replaces (`MetaIdentity.supersedes`, written
       when the DB is created), and `resolveStoreIdentity` never picks a superseded store. It used to take the newest
       `createdAtMs`, a wall-clock value: the 1000-seed sweep found a device whose new store was created under a -42 h
       clock skew pick the old, already retired store and fail every start `unauthorized` (seed 602; plan in
       `src/sim/regressions/epoch-mint-skewed-store-pick.json`). `createdAtMs` is now only a last resort among stores
       with no link.
     - **§8 split:** `deviceLabel`, `showStatusBar`, `pendingEnrollment` and `creating` live in a per-install record
       (`App.saveLocalStorage("yaos-local")`, `src/host/localSettings.ts`); data.json holds `version`, the grant, the
       engine settings and the suite pin. The label and status bar flag move once from an older data.json; an older
       `creating` / `pendingEnrollment` is dropped (it could be a twin's), and that data.json is rewritten once
       without them. A label or status bar change never writes data.json.
     - **Clone notice:** the first store of an install with no lineage looks at `state/*/` and says once (flag in the
       per-install record) when another store's mirror was written within a day (`src/host/cloneNotice.ts`).
     - **Abandoned-creator timer:** one timer for every recheck and grace, none while no doc waits on a foreign
       creator; a live creator's recheck doubles from 5 min to 60 min and is asked by the timer itself (the phase-3
       recheck only re-read a cached view); "unknown" is not asked again. timer-audit.md has the row.
     - Not done: `rebuildLocalCache` still restarts on the same store (§4 wants a store reset; BACKLOG
       IDENTITY-HYGIENE). Done in phase 5.
5. **Hygiene (optional).** Inactivity retirement; grant rotation and re-fetch with the device token; orphan DB sweep;
   ring compaction; `rebuildLocalCache` as a store reset.
   - **Landed** on `identity/phase5-hygiene` (DECISIONS §10.1 G66, operations.md "Device identity routes",
     DESIGN §i.5, tests/server/identity-hygiene.ts, src/sim/identityHygiene*.test.ts). As built:
     - **Inactivity retirement** (`VaultHost.retireInactive`, `server/src/vault/host.ts`). A device whose
       `last_seen_day` (or, for a pre-phase-1 enroll, its enroll day) is more than `INACTIVITY_RETIRE_DAYS` (90)
       UTC days before today is retired through the console's path (`retireDevices`: D7, tombstone). No alarm and no
       timer: the scan runs inside `POST /auth/device` (after the restore check and body validation, before the
       limits, so the 50-store cap counts the freed slots), `POST /auth/device/status` (the abandoned-creator query:
       holders ask every 5–60 min while a create waits, so an abandoned create resolves without anyone opening the
       console) and the operator's device list. Cost: the devices are in memory, so 0 row reads; at most one full scan
       per UTC day per runtime (`inactivitySweptDay`, set only once nothing stale is left); writes only for a
       retirement (2 rows each, at most `INACTIVITY_RETIRE_BATCH` = 50 per call, the rest at the next trigger); skipped
       while the daily write limit is latched or a restore runs. A stale device with an open socket (a session older
       than 90 days, the ticket never re-issued) is kept and gets `last_seen_day` today instead (1 row). The threshold
       is `YAOS_INACTIVITY_RETIRE_DAYS` (1–3650, `readInactivityRetireDays`); tests set `inactivityRetireDays`. The
       leftover of a crash between an epoch mint (or a rebuild's) registration and the store's creation is a
       registered identity nobody holds: it is retired the same way. Sim: an abandoned create whose creator store was
       lost with its lineage (no fence) stays body-less while the creator is live, and resolves once the sweep a
       status query runs retires it (`identityHygiene.sim.test.ts`, a slow unit over a few virtual hours across a UTC
       midnight, with the sim registry's threshold at 0 days).
     - **Rotation** (`POST /operator/vaults/:id/grants/:grantId/rotate`, console "Rotate secret"). The server mints
       the secret (32 random bytes, base64url) and replaces `secret_hash` in one UPDATE; the old secret is unknown
       from that moment (401 `unauthorized` on registration, pairing codes, leave). It also stores
       `pairing_grant.secret_wrap`: AES-GCM under an HKDF key derived from the vault's ticket key, AAD vaultId and
       grantId (`server/src/vault/grantWrap.ts`), so `GET /vault/:id/auth/grant` (device bearer) can return it to any live
       store of the grant. A grant never rotated has no wrap: `404 grant_secret_unavailable`, and the client keeps its
       secret. Revoked: `401 grant_revoked`; a pre-grant enroll: `403 grant_required`. The client fetches lazily, when
       the old secret is refused: `registerPending` retries once after `ProtocolEngine.refreshGrant` (fetch, then
       `IdentityPort.useGrant`), and main's pairing-code request sends the `refreshGrant` command and retries once
       (`requestPairingCodeRotating`). The engine posts `grantSecret` to main, which rewrites data.json when the host,
       vault and grantId are still the paired ones (no restart). Clones: a clone that runs a live store of its own is
       an install like any other and fetches it; a copy with no live store (never started, its store removed or lost)
       has no token, registration reads `unauthorized`, and it asks for a re-pair (`pairing-unknown`). "Leave" with a
       stale secret reads 401, already counted as done.
     - **Deviation (G56):** the server held only secret hashes. A rotated secret is also held wrapped, readable by
       the vault DO only (the key never leaves it). A paired secret, which the client minted, is still only hashed.
       A thief who already registered a store from a leaked data.json fetches the rotated secret too: the operator
       removes that store, or revokes the pairing.
     - **Orphan DB sweep** (`sweepOrphanStores`, `src/engine/compose/runtimeOps.ts`). On going live, after
       `retireOldEpochs`: the `yaos3:<vaultId>:*:<key>` and `yaos3-pending:<vaultId>:<key>` DBs of this vault under
       another install key (at most 32), their identities read, one `POST /auth/device/status`, and only the ones that
       read **retired** are deleted. Live and unknown are kept and asked again at a later live (an unknown one may be
       a pending identity another registration of the vault is registering right now on a shared desktop origin, or
       one a restore forgot). No dir is touched: this install's own lineage dirs go with `VaultRuntime.dropLineageDirs`
       (now also for a store that inherited nothing, once its mirrors are written: the predecessor's unsent frames
       are either inherited or the store had none), and another install's `state/<id>/` is never this install's to
       delete. No timer; with no orphan, one `listDatabases` per live and no request.
     - **`rebuildLocalCache` is a store reset** (`ProtocolEngine.resetStore`). It registers a pending identity under
       the grant first; refused (offline, a revoked pairing, the daily limit, a rotated secret it cannot fetch), the
       store keeps running and the command fails with the reason. Then, like a revoked store's replacement
       (`replaceStore`, shared): stop the runtime (the outbox goes to its mirror), delete this install's store DBs,
       start on the registered identity, which fences the old store by its retire key and inherits its unsent frames
       from its mirror; the old dir goes once the new store's mirrors are written. A crash after the registration
       leaves a registered pending identity (consumed at the next start) or, without it, a registered identity nobody
       holds, which inactivity retirement retires. Sim: unsent edits survive the reset, an offline reset changes
       nothing.
     - **Not done:** ring compaction (decision 6), and a lost data.json re-fetched from the store (§4 "data.json
       lost"): data.json is the only place the host and vaultId of the pairing live, so a store has nothing to fetch
       with; that install pairs again (BACKLOG).

## 13. Migration note for dev vaults

No released client has the current format, so there is no in-place migration.
1. Before upgrading, let each dev install go idle with an empty outbox (status "up to date").
2. After upgrading, each install starts unpaired: data.json's old `identity` is dropped by the sanitizer. Pair it again
   with a code from the console or another device.
3. On first start the new build deletes `yaos2:<vaultId>:*` DBs and the flat `state/outbox-*.bin` and
   `state/synced-*.bin` (identity-less legacy layout). Unsent edits there are on disk and are re-derived by the
   onboarding scan.
4. Re-create each server vault in the console: the vault schema is created at vault init and never migrated, so a
   vault made before the current schema does not load.

Optional convenience, if re-pairing many dev installs is a burden: a one-shot `POST /vault/:id/auth/grant-from-device`
(device bearer) that converts the old device row into a grant plus its first device.
