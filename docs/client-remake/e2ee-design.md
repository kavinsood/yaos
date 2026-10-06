# YAOS client remake: crypto suite 1 (single-user E2EE)

Status: **accepted and normative** (the user approved it and resolved every §22 decision on 2026-10-07). Owner:
architect. Extends [DESIGN.md](DESIGN.md); where this document
changes a shape named there, §18 gives the DESIGN diff. Server baseline: the rewritten relay merged into
`client-remake` at 7208184 (PR #82; `docs/server-rewrite/DECISIONS.md`). It is an opaque byte sequencer: streams,
checkpoint CAS, R2 blobs at `v/<vaultId>/<address>`, operator-only revoke/reset/restore, and no server-side
recovery or snapshots (DECISIONS §1, §2.1, D7, D8a, D8b, D9). Server line references are at 7208184.

Scope is **single-user** end-to-end encryption: one person, several devices, one vault. Shared E2EE vaults are out
of scope (DECISIONS §1 removes them server-side too). §2.4 lists what this design keeps open for them.

- Conventions as in DESIGN: MUST / NEVER are hard rules. "Alternative:" lines record a rejected option in one line.
- Evidence tags on claims:
  - **[M]** measured by the spike in this worktree (`src/host/spike/cryptoProbe.ts`, §23);
  - **[S]** read in a cited source (spec, RFC, paper or source file at a pinned commit);
  - **[D]** derived here by calculation from cited inputs (the calculation is shown);
  - **[U]** unverified: needs a device or is not stated anywhere I could find;
  - **[User]** confirmed by the user on 2026-10-07 (their devices or Obsidian's documentation). Not measured by the
    spike and not read in a source here, so it is kept apart from [M] and [S] (§23.3).
- Terms:
  - **K_e**: the 32-byte vault key of key epoch `e` (`e ≥ 1`). "Vault key" in `server/src/vault/ticket.ts` (DECISIONS D4) is the relay's
    ticket-signing key and is unrelated (server ask A8).
  - **keyEpoch** (this document) vs **vaultEpoch** (the relay generation, DESIGN §c.12). They are independent.
  - **RK**: the recovery key (§13). **k**: the keyring stream (§11).
  - **S_rot**: the seq at which a revoke-kind keyring record committed (§14).
  - **decision Dn** is a user decision, resolved in §22. **DECISIONS Dn** is a server decision in
    `docs/server-rewrite/DECISIONS.md`. **An** is a server ask (§19).

Contents: [1](#1-summary) summary · [2](#2-threat-model) threat model · [3](#3-platform-facts) platform facts ·
[4](#4-cipher) cipher · [5](#5-key-hierarchy) keys · [6](#6-key-storage) storage · [7](#7-envelope-v2-aad-and-padding)
envelope · [8](#8-replay-and-reorder) replay · [9](#9-what-is-sealed-and-open-failures) failures ·
[10](#10-blobs) blobs · [11](#11-keyring-stream-k) keyring · [12](#12-pairing) pairing · [13](#13-recovery-key)
recovery · [14](#14-rotation-and-revocation) rotation · [15](#15-enable-migrate-disable) enable/migrate ·
[16](#16-performance-budget) performance · [17](#17-lost-server-features-and-client-replacements) lost features ·
[18](#18-shape-changes-and-design-diffs) shape changes · [19](#19-asks-for-the-server-rewrite) server asks ·
[20](#20-test-plan) tests · [21](#21-work-packages) work packages · [22](#22-decisions-resolved) decisions ·
[23](#23-spike-verified-vs-needs-a-device) spike · [24](#24-references) references.

---

## 1. Summary

1. Suite 1 = **AES-256-GCM via WebCrypto**, random 96-bit nonce, 128-bit tag. Zero bundle cost. No WASM.
2. Each **key epoch** has a random 32-byte K_e. HKDF-SHA-256 derives non-extractable subkeys per purpose.
3. Keys live in **Obsidian SecretStorage** (OS keychain on desktop and mobile). NEVER in IndexedDB or `data.json`.
4. The **AAD** binds the header, vaultId, stream, deviceId and clientFrameId. It does not bind seq (assigned
   later) or vaultEpoch (restore keeps old rows).
5. **Replay** of ns/cfg frames is rejected by a sealed per-device `frameNo` with an RFC 4303-style 64-wide window.
   Body updates are idempotent CRDT updates, so their replay is harmless.
6. **Padmé padding** inside the AEAD, with a 256-byte floor, buckets frame, checkpoint and blob sizes.
7. **Blobs** are addressed by `HMAC(kAddr, sha256)` and sealed in one AEAD call. GC is client mark-and-sweep.
8. A **keyring stream `k`** carries wrapped epoch keys: a backward chain for new devices and a forward chain for
   automatic rolls.
9. **Pairing** is by QR or link. The key travels in a client-only URL parameter. The server-visible pairing code
   carries no key. The **recovery key** (56 Crockford base32 characters) handles the all-devices-lost case. A device
   with no suite pin writes nothing; the pin never comes from the server (§12.4).
10. **Revocation** starts a new epoch that devices cannot follow from old keys. Kept devices re-key by QR or RK. A
    revoked device keeps everything it already decrypted.

## 2. Threat model

### 2.1 Actors and goals

| Actor | Capabilities assumed | Goal of this design |
|---|---|---|
| Relay operator, Cloudflare, anyone with DO/R2 read access or a PITR copy | Reads and writes every stored byte; reorders, drops, replays and forges rows; serves different views to different devices; reads all HTTP metadata | **Confidentiality** of content, paths, names, settings and attachments. **Integrity**: forged or altered rows are rejected. Replays within one vaultEpoch are rejected for ns/cfg and harmless elsewhere. |
| Network attacker | TLS-terminated traffic only | Nothing beyond what TLS already gives. |
| Revoked device (holds old keys, token revoked) | Everything it decrypted. With server collusion: reads new ciphertext under old keys, and seals valid old-epoch rows | It cannot read anything sealed under epochs after the revoke. Old-epoch rows committed after the revoke are rejected (§14.3). |
| Lost device that has **not** been revoked | Everything | None. Revoke it (§14). |
| Other Obsidian plugins, local malware, OS account | Full access to the vault folder, IndexedDB and SecretStorage | **Out of scope.** Plugins already have full access to everything (§6.1). |

- **Non-goals:**
  - availability (the server can always withhold);
  - fork consistency: the server can show two devices different histories. Rollback to any state the server
    once held is also possible, because PITR restore is a legitimate operator feature (DECISIONS D8b, [CF-PITR]);
  - local at-rest encryption: IndexedDB `tail`/`snapshots` and the vault files on disk hold plaintext;
  - hiding that YAOS is used, or when.
- **The user is the trust anchor** for the vault's suite. A device writes nothing until its suite pin comes from an
  authenticated source, so a lying server cannot downgrade it (§12.4).

### 2.2 Metadata: mitigated vs accepted

| Metadata | Status | How |
|---|---|---|
| Note, folder and attachment names; paths; tree shape | **Mitigated** | Only in sealed ns frames. docIds are 16 random bytes. |
| File contents and settings | **Mitigated** | Sealed. |
| Attachment equality with a known file | **Mitigated** | The address is `HMAC(kAddr, sha256)`, not sha256. `x:` stream names use the same address (§10.1). |
| Exact frame, checkpoint and blob sizes | **Mitigated (bucketed)** | Padmé leaks O(log log M) bits per size, with ≤ 12 % overhead [Padmé] (§7.3). |
| Plaintext sha256 and size in HTTP headers | **Mitigated** | The client never sends `X-YAOS-Content-*`, and at 7208184 the server neither sets nor reads them. Server ask A2 drops the stale CORS names. |
| Number of streams, i.e. roughly the number of notes plus canvases | Accepted | One stream per doc is the relay's cost model (relay-wire §11.4). |
| Stream class (`b:` vs `c:` vs `x:` vs `ns`/`cfg`/`k`) | Accepted | The relay's provisional broadcast keys on `b:`/`c:` (`server/src/streams/protocol.ts:53`). |
| Which stream was touched when, and by which device | Accepted | Row timing, seq order and deviceId are relay-visible by design. This reveals editing activity per note. |
| Bucketed sizes and growth of each stream | Accepted | Residual after padding. |
| Device count, deviceName, IPs, user agents, connection times | Accepted | deviceName defaults to a neutral label under suite 1 (§12.3). |
| Blob count, bucketed blob sizes, blob equality inside the vault | Accepted | Needed for dedupe (§10.2). |
| Key-roll and revoke events (rows in `k`) | Accepted | |
| Compression ratio of a frame | Accepted for single-user | Deflate runs before padding. Only the author's own content shares a compression window, so there is no attacker-chosen plaintext. Revisit for shared vaults (§2.4). |

### 2.3 What the server can still do (said plainly)

- Withhold rows, checkpoints or blobs, or delete the vault.
- Reorder concurrent frames within the rules the relay already has. It chooses the seq order. Clients cannot tell
  this from honest concurrency.
- Serve an older checkpoint together with a withheld tail. This is a rollback of one stream as seen by a device
  that bootstraps.
- After a vaultEpoch change (restore or reset), splice in genuine frames from the abandoned timeline. The reader's
  replay window restarts with the epoch (§8.4). The client treats a vaultEpoch change as "disk is the truth"
  (DESIGN §c.12), which bounds the damage to a 3-way merge.
- With a revoked device's help: read anything sealed under the keys that device held, and test guessed attachment
  contents against new blob addresses (kAddr is not rotated: §14.4, decision D4).

### 2.4 Not painting shared vaults into a corner

These choices keep shared E2EE open:

- keyEpoch in every header, and no trial decryption;
- a separate `k` stream whose records can grow per-member wraps;
- per-device frameNo windows;
- blob addressing under a vault-scoped key.

Shared vaults will additionally need:

- **key commitment:** AES-GCM is not committing [LGR21]; a malicious member holds keys;
- per-member wraps, by public key or SAS;
- a compression-oracle review;
- signatures if members must not impersonate each other. AEAD with a shared key gives group authenticity only.

## 3. Platform facts

What the design relies on, and how sure we are. Spike numbers are on an Apple M4 Pro.

| Fact | Status | Evidence |
|---|---|---|
| AES-GCM, HKDF, HMAC and `getRandomValues` work inside a Blob-URL worker | **[M]** Chrome 154 (headless, macOS), Node 26.5 | `run-e2ee` spike, §23 |
| Published KATs pass: AES-256-GCM (GCM spec test case 16), HKDF (RFC 5869 A.1), HMAC (RFC 4231 TC2) | **[M]** Node, Chrome 154 | `cryptoProbe.ts`; [GCM-spec], [RFC5869], [RFC4231] |
| Tampered ciphertext, tag, AAD or nonce throws `OperationError` | **[M]** | `cryptoProbe.test.ts:50-59` |
| A key imported with `extractable:false` refuses export (`InvalidAccessError`). HKDF base-key import with `extractable:true` is a `SyntaxError` | **[M]**; **[S]** [WebCrypto] §14.3.10, §33.4.2 | |
| A derived key's extractable flag comes from the `deriveKey` argument | **[S]** [WebCrypto] §14.3.7; **[M]** | |
| `getRandomValues` above 65536 bytes throws `QuotaExceededError` | **[M]**; **[S]** [WebCrypto] §10.1.1 | |
| A CryptoKey stored in IndexedDB survives a restart | **[M]** Chrome 154 | `idbKey` step |
| …but its **raw key bytes sit in plaintext** in Chrome's IDB LevelDB files | **[M]** Chrome 154; **[S]** [WebCrypto] §13.5 ("may expose the contents of the key material"); Chromium `v8_script_value_serializer_for_modules.cc` L596/600, `components/webcrypto/algorithm_implementation.cc` L125-131 @39d5b374 | Found by grepping the profile directory |
| WebKit wraps stored CryptoKeys with a per-app master key in the keychain. Workers block on sync IPC for it | **[S]** WebKit `SerializedCryptoKeyWrapCocoa.mm` L66-83, L220-268 @55d19429; `WorkerGlobalScope.cpp` L537-575 | Lock-state behaviour **[U]** |
| WebKit: a record holding a CryptoKey breaks index queries | **[S]** [WebKit-177350] (still NEW) | |
| WKWebView accepts a **zero-length** GCM IV; Chrome throws | **[M]** macOS WKWebView (`capacitor://localhost`), Chrome 154 | Enforce 12 bytes ourselves (§4.1) |
| Throughput, AES-256-GCM 1 MiB seal | **[M]** Chrome ~3000 MiB/s (0.334 ms, n=899); WKWebView (macOS) 2174 MiB/s seal / 5556 MiB/s open; Node 0.19 ms | Per call at 64 B: 5.5 µs (Chrome), 12 µs (WKWebView) sequential; ~2.4 µs batched |
| Pure-JS XChaCha20-Poly1305 (@noble/ciphers) 1 MiB | **[M]** ~284–297 MiB/s Chrome, ~241 MiB/s WKWebView; README 340 MiB/s [noble] | 8–13× slower than WebCrypto GCM |
| `app.secretStorage` exists (`setSecret`/`getSecret`/`listSecrets`, synchronous; ids lowercase alphanumeric plus dashes; no delete) | **[S]** `obsidian.d.ts:458`, `:5635` (npm `obsidian` 1.13.1); `@since 1.11.4`; plugin `minAppVersion` 1.13.0 (`manifest.json:5`). **[User]** confirmed: present since 1.11.4 | |
| Desktop SecretStorage uses Electron `safeStorage`. Without OS encryption it stores **plaintext** and warns (`msgSecretsNotEncrypted`) | **[S]** `obsidian-1.14.4.asar`, bytes ~3571300–3572700 (read-only); same in 1.13.7 | Linux without a keyring: plaintext |
| Mobile SecretStorage uses the Capacitor plugin `SecureStorage` under the bare key `"secrets-encrypted"`, so it is shared across vaults | **[S]** same asar (mobile adapter). Backed by the iOS Keychain: **[User]**. Android Keystore **[U]** | Namespace ids per vault (§6.1) |
| `crypto.subtle` requires a secure context; custom schemes count as secure in WebKit; a worker inherits it | **[S]** [WebCrypto] §10; WebKit `SecurityOrigin.cpp` L101-102, `WorkerGlobalScope.cpp` L204-210 | Obsidian iOS: WKWebView treats `capacitor://localhost` as a secure context, so `crypto.subtle` works **[User]** |
| No streaming AEAD in WebCrypto | **[S]** [w3c-webcrypto-73] | Blobs ≤ 10 MiB are sealed in one call (§10.3) |
| The stock iOS Camera (iOS 11+) recognises a QR holding an `obsidian://` link and offers to open Obsidian | **[User]** | Android camera apps **[U]** |
| Obsidian mobile WebViews and desktop Electron behave like the above (throughput, zero IV, Android) | **[U]**, except the [User] rows above | §23.3 lists the device runs |

## 4. Cipher

### 4.1 Suite 1 = AES-256-GCM (WebCrypto)

- `CryptoSuite.aes256gcm = 1`. Id 1 was "reserved XChaCha20-Poly1305" and never shipped, so it is reassigned.
- Sealed bytes: `nonce(12) ‖ ciphertext ‖ tag(16)`, i.e. 28 B of overhead.
- `tagLength` MUST be passed explicitly as 128. Shorter tags are on the way out of SP 800-38D ([NIST-GCM-rev]).
- The nonce MUST be 12 bytes from `crypto.getRandomValues`. Both `seal` and `open` MUST check `nonce.length === 12`
  before calling WebCrypto: WKWebView accepted a 0-byte IV **[M]**, and [WebCrypto] §29.4 sets no minimum.
- NEVER use counter or deterministic nonces. Several devices seal under the same key with no coordination.
- NEVER trial-decrypt. The key comes from the header's `keyEpoch` (§5). A missing key is `unknown-key`.
- Alternative: XChaCha20-Poly1305 in pure JS (@noble/ciphers 2.4.0). Rejected because:
  - it is 8–13× slower at 1 MiB **[M]** and adds 4.9 KB gzip [noble];
  - the key sits in the JS heap;
  - the Cure53 audit covers 0.6.0, not 2.x [Cure53-NBL];
  - its IRTF draft is dead [XChaCha-03].
  
  Its one advantage, a large nonce space, is covered by rolling epochs (§4.2).
- Alternative: libsodium.js. It always ships WASM (~306 KB gzip), which the client forbids.

### 4.2 Limits and the roll budget

- **Random-nonce collisions.** NIST requires the IV-collision probability to stay ≤ 2^-32 and caps random-IV use at
  2^32 invocations per key ([NIST-GCM] §8, §8.3). The CFRG limits assume nonces never repeat and do not cover random
  explicit nonces ([CFRG-limits] §5.1, §7.1).
  - [D] For q random 96-bit nonces under one key, P(collision) ≈ q²/2^97. q = 2^23 gives 2^-51.
  - The same figure appears in [noble] README L366-388.
- **Confidentiality.** [CFRG-limits] §6.2.1 gives `CA ≤ (s + q + 1)² / 2^129`, with s counted in 16-byte blocks.
  - [D] Worst case: 2^23 frames, every one a full 1 MiB (2^16 blocks), so s ≤ 2^39. CA ≤ 2^78/2^129 = 2^-51.
- **Integrity.** [CFRG-limits] §6.2.2 gives `IA ≤ 2·v·(L+1)/2^128`.
  - [D] For L = 2^16, one forgery attempt succeeds with probability 2^-111. 2^40 attempts give 2^-71.
- **Message length.** At most 2^39−256 **bits** ([NIST-GCM] §5.2.1.1). [WebCrypto] §29.4.1 says "bytes"; the
  spec is inconsistent. Irrelevant here, since nothing exceeds 10 MiB.
- **Rule: roll at 2^23.** A device starts a roll (§11.4) when either:
  - `headSeq − firstSeq(e) ≥ 2^23`, where `firstSeq(e)` is the seq of epoch e's winning `k` record; or
  - its own seal count under e reaches 2^22. This count is kept lazily in IDB meta and covers re-seals that
    never commit.

  Each subkey (kFrame, kCkpt, kBlob, kWrap) has its own budget. All of them see at most as many seals as frames
  committed (one per frame; at most one checkpoint or blob per frame), so one trigger covers all of them.
- [D] At the free plan's 100k rows/day, 2^23 frames take ≥ 84 days of writing at the limit. In practice a roll
  happens once in years.

### 4.3 Key commitment

AES-GCM is not key-committing [LGR21] [DGRW18] [ADGKLS22]; see also [RFC9771] §4.3.3. In a single-user vault every
key is honestly generated and none is known to the adversary, so invisible-salamander attacks do not apply. The
KCV (§5.2) commits keyring records to their key. Shared vaults MUST add a commitment block per envelope (§2.4).

## 5. Key hierarchy

### 5.1 Keys

```
K_e        32 random bytes per key epoch, e ≥ 1           (stored: SecretStorage §6; travels: QR §12, k wraps §11)
 └ HKDF-SHA-256(ikm = K_e, salt = "yaos-hkdf-v1", info = I(purpose, e)), every output non-extractable:
     kFrame   AES-GCM-256   frames                         purpose "frame"
     kCkpt    AES-GCM-256   checkpoints                    purpose "checkpoint"
     kBlob    AES-GCM-256   blob bytes                     purpose "blob"
     kWrap    AES-GCM-256   prevWrap / nextWrap in k       purpose "wrap"
     kKcv     HMAC-SHA-256  key check value                purpose "kcv"
 from K_1 only (vault lifetime, never rotated):
     kAddr    HMAC-SHA-256  blob addresses, x: names       purpose "addr"
     kDiag    HMAC-SHA-256  diagnostics hashes             purpose "diag"
RK         35-byte recovery key (§13)
 └ KEK_RK = HKDF-SHA-256(ikm = RK[0..32], salt = "yaos-hkdf-v1", info = I("recovery-kek", 0))   AES-GCM-256

I(purpose, e) = utf8("yaos/v1/" + purpose) ‖ 0x00 ‖ utf8(vaultId) ‖ 0x00 ‖ varuint e
```

- HKDF is from [RFC5869]. The base key is imported with `extractable:false` ([WebCrypto] §33.4.2), and derived keys
  take `extractable:false` explicitly ([WebCrypto] §14.3.7).
- Subkeys are derived **lazily** per epoch on first use. Startup derives the newest epoch's set plus kAddr and
  kDiag: 7 `deriveKey` calls.
- **Why kAddr and kDiag live for the whole vault.**
  - ns, refs and snapshots carry only the plaintext sha256, and the address must be recomputable from it in any
    epoch. Rotating kAddr would change every address, so blobs would need re-uploading (decision D4).
  - Diagnostics from different epochs stay comparable.
- **No per-stream or per-doc subkeys.** The AAD already separates streams. Per-doc keys would cost one `deriveKey`
  per stream at bootstrap (thousands) for no gain against this threat model.
- Alternative: one key for everything. Rejected: separate subkeys give separate nonce budgets, and
  KCV/addresses/diagnostics stay independent of the encryption key.

### 5.2 Key check value (KCV)

`kcv(e) = HMAC-SHA-256(kKcv_e, "yaos/v1/kcv" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ varuint e)[0..16]`

- It is published in each `k` record (§11). A key whose KCV matches the winning record for its epoch is
  **verified**.
- Under a verified key, `auth-failed` is deterministic (§9.2). Under an unverified key it is reader-dependent.
- It is safe to publish: it is a PRF output under a key derived from K_e, and it reveals nothing about K_e.

## 6. Key storage

### 6.1 Rules

- **Store.** Epoch keys MUST be stored in Obsidian SecretStorage (`app.secretStorage`, §3), as **one secret per
  vault**.
  - Id: `"yaos-" + hex(sha256(utf8(vaultId)))[0..32]` (ids are lowercase alphanumeric plus dashes). The vaultId is
    hashed because the mobile store is shared across vaults (§3).
  - Value: JSON `{ "v": 1, "vaultId", "suite": 1, "keys": [{ "e", "k": b64url(K_e) }], "records": [b64url(k record)] }`.
  - The records are kept so they can be re-published after a reset or restore (§11.5). They are not secret.
  - Value size limits **[U]** (WP-E0, §23.3).
- **NEVER persist a key in IndexedDB.** Chromium writes stored CryptoKeys' raw bytes in plaintext **[M]**. WebKit
  adds keychain IPC, lock-state failures and an index bug (§3).
- **NEVER persist a key in `data.json`** (`<configDir>/plugins/yaos/data.json`). Folder sync and backup tools copy
  the config dir.
- **NEVER put keys or RK in** logs, `StatusSnapshot`, `DiagnosticsBundle`, `Error` messages, notices or the URL bar.
  Protocol fields that carry keys are marked SECRET, like `relay.credential` (`src/protocol/messages.ts:56`).
- **The suite pin** (`e2ee: { suite: 0 | 1 }`, not secret) lives in `data.json` next to the device token.
  - If the pin says 1 and the secret is missing, the device enters phase `key-missing`: re-key by QR or RK.
  - **No pin** (just enrolled by a key-less code, or `data.json` lost) means the device writes nothing until a pin
    arrives from an authenticated source (§12.4). Nothing the server says sets or lowers a pin.
  - A pin is never lowered: 1 → 0 does not exist (§15.2).
- **Startup.** `getSecret` may return null before the store has loaded. Wait for SecretStorage's `changed` event
  for up to 5 s before deciding the key is missing. The store loads everything at app start, then fires `changed`
  ([S] asar).
- **Linux desktop without an OS keyring.** SecretStorage stores plaintext and Obsidian shows
  `msgSecretsNotEncrypted` ([S] asar). YAOS adds a persistent status notice, and the vault-folder trust level
  applies.
- **Forget keys** (leave the vault or disable the device) writes `""`. There is no delete API. Whether `""` is
  accepted is **[U]**.
- **Trust.** Any plugin in the vault can read any secret. Non-extractable CryptoKeys are hygiene, not a boundary:
  they keep keys out of accidental exports and structured clones. Plugins already have full access (§2.1).

### 6.2 What survives what

| Loss | Keys | Effect |
|---|---|---|
| IndexedDB (cleared, evicted, corrupted) | Survive in SecretStorage | Normal re-bootstrap from the relay. frameNo restarts above the folded right edge (§8.2). The outbox mirror re-opens with the keys. |
| SecretStorage (app reinstall, localStorage cleared) | Lost on this device | `key-missing`, read-only. Re-key by QR from another device or by RK. |
| `data.json` | Survive, but are orphaned | The pin is lost too. Re-enroll (new device token and deviceId): a key-less join, so the device is blocked until a QR or the RK (or, for a suite-0 vault, a suite-0 pairing link) settles it (§12.4). |
| Every device | Gone | RK path (§13.3). Without the RK the data is unrecoverable, by design. |

### 6.3 Worker hand-off

1. Main reads the secret and posts the raw keys **once**, in `init.crypto` (§18.4), with the buffers in the
   transfer list. Main keeps no copy and re-reads SecretStorage when it needs one (QR display, §12).
2. The worker imports each K_e as an HKDF base key with `extractable:false`, derives subkeys, and zero-fills the
   buffers. This is best-effort: JS cannot guarantee erasure.
3. New keys (adopted by roll, entered by QR or RK) are produced in the worker and posted back once in
   `keyringChanged` (SECRET). Main persists them to SecretStorage.
4. Inline mode runs the same code on main.

### 6.4 Side files and local state (DESIGN §e.4)

| File | Content under suite 1 | Verdict |
|---|---|---|
| Outbox mirror | `sealed` bytes, i.e. ciphertext. Re-opened with keys by `recoverFromMirror` (`src/engine/runtime/mirrorIo.ts:162`) | Fine |
| Synced mirror | Plaintext docId, path, contentHash, seqs | Accepted: the vault folder holds the same plaintext |
| Local snapshots (zip) | Plaintext | Accepted (local). Uploads go through `sealBlob` (`src/engine/snapshots/snapshotJob.ts:129-130`) |
| IndexedDB `tail`, `snapshots`, `baseText`, ... | Plaintext (T_receipt stores outbox content, DESIGN §e.2) | Accepted (non-goal: local at-rest encryption) |
| Diagnostics bundle | Hashes MUST be `HMAC(kDiag, ·)`, not sha256 (`src/engine/compose/runtimeOps.ts:150-153`; DESIGN §j.7) | Change in WP-E2 |

## 7. Envelope v2, AAD and padding

### 7.1 Layout

```
outer (plaintext)
  u8      formatVersion   1 (see below)
  u8      cryptoSuite     0 = none; 1 = aes256gcm
  varuint keyEpoch        0 iff suite = 0; ≥ 1 for suite 1
  bytes   sealed          suite 0: inner verbatim
                          suite 1: nonce(12) ‖ AES-GCM(kFrame | kCkpt, inner ‖ pad, AAD §7.2) ‖ tag(16)
inner
  u8      kind            EnvelopeKindCode
  varuint authorNsSeq
  varuint flags           initial | adopted | deflate | fromDisk
  varuint frameNo         NEW. ns/cfg frames: per-(deviceId, stream) counter ≥ 1 (§8.2); 0 for every other kind
  bytes   content         rest; deflate-raw iff flags & deflate (unchanged)
pad (suite 1 only, inside the AEAD; added and stripped by the CryptoPort)
  0x80 ‖ 0x00*            to padmeLen(len(inner) + 1)                                   (ISO/IEC 7816-4 style)
```

- **formatVersion.**
  - client-remake has not shipped, so the change lands **in place** as formatVersion 1.
  - If any build that writes the old layout reaches users first, it MUST ship as formatVersion 2 instead. Old
    rows then stay `unsupported-version` for new readers (and vice versa), which is reader-dependent (§9).
- **Deflate** stays before padding (§2.2). The padded length hides most of the compression ratio.

### 7.2 AAD v2

```
frames:      "yaos/f2" ‖ u8 formatVersion ‖ u8 cryptoSuite ‖ varuint keyEpoch
               ‖ varstring vaultId ‖ varstring stream ‖ varstring deviceId ‖ varstring clientFrameId
checkpoints: "yaos/c2" ‖ u8 formatVersion ‖ u8 cryptoSuite ‖ varuint keyEpoch
               ‖ varstring vaultId ‖ varstring stream ‖ varuint coversSeq
blobs:       "yaos/b2" ‖ u8 blobFormat ‖ u8 cryptoSuite ‖ varuint keyEpoch ‖ varstring vaultId ‖ varstring address
k wraps:     §11.2
```

| Field | Bound because |
|---|---|
| Header (format, suite, keyEpoch) | A relabelled header fails the AEAD. It does not rely only on key separation. |
| vaultId | No transplant between vaults. HKDF info binds it as well (§5.1). |
| stream | A frame or checkpoint moved to another stream fails. |
| deviceId | **New.** The relay asserts the row's deviceId (relay-wire §4.1). Without this binding, the server could re-attribute a frame, shifting dedupe and replay state (§8) and the planner's own-frame matching (DESIGN §c.13). deviceId is client-chosen at enroll (relay-wire §2.4), so it is known at seal time. T_adopt seals under the adopter's own deviceId (DESIGN §d.5, unchanged). |
| clientFrameId | Frame identity. Unique per device across the vault (relay-wire §1). |
| coversSeq (checkpoints) | As today. The inner `CheckpointContent.coversSeq` check stays (DESIGN §b.1). |
| address (blobs) | The server cannot serve one blob's bytes at another address. The reader also checks sha256 after opening (`src/engine/body/refs.ts:50-59`). |

- **seq is NOT bound.** The relay assigns it after the append (relay-wire §5). Order is protected per device by
  frameNo (§8), not by the AEAD.
- **vaultEpoch is NOT bound.** A PITR restore keeps every row written before the restore point and mints a new
  epoch (DECISIONS D8b: "content == T", "mint a new epoch"). With the epoch bound, every restored row would fail to
  open. The cost is §8.4.
- Alternative: bind seq by sealing after the receipt. Rejected: the relay needs the bytes in order to assign seq.

### 7.3 Padding

```
padmeLen(n):  m = max(n, 256); E = floor(log2 m); S = floor(log2 E) + 1; z = E − S
              return ceil(m / 2^z) · 2^z
seal:  p = inner ‖ 0x80 ‖ 0x00 × (padmeLen(len(inner) + 1) − len(inner) − 1)
open:  strip trailing 0x00, then require one 0x80; anything else is bad-padding
```

- Padmé [Padmé] leaks O(log log M) bits of a length M, with at most 12 % overhead. Frames, checkpoints and blobs all
  use it. The 256-byte floor hides keystroke-sized frames (decision D3).
- The padding lives **inside** the AEAD and is added and stripped by the suite-1 CryptoPort. Suite 0 does not pad.
- A valid tag with bad padding means a key holder sealed garbage. That is **deterministic** malformation (§9.2).
- **Limits change** (`src/core/limits.ts`).
  - The relay closes 1009 above `maxBinaryMessageBytes` = 1049600 (relay-wire §3.2). Treat it as 1 MiB of payload.
    - [D] For lengths in [2^19, 2^20), Padmé pads to multiples of 2^14 = 16 KiB. 64 × 16 KiB is exactly 1 MiB,
      which leaves no room for the header and the 28 B of AEAD overhead. So the largest padded inner is
      63 × 16 KiB = 1032192 B.
    - `MAX_FRAME_CONTENT_BYTES` therefore drops from `1 MiB − 4 KiB` to **`1 MiB − 32 KiB`** (1015808). That
      leaves ≥ 16 KiB for the inner header, marker and outer header, under every suite, so suites behave alike.
    - `MAX_INLINE_UPDATE_BYTES` follows it. Slightly more updates take the ref path (DESIGN §b.6).
  - Checkpoints. `maxCheckpointBytes` = 4194304 (relay-wire §3.2; Worker cap 4 MiB, DECISIONS §2.2).
    - [D] For lengths in [2^21, 2^22), Padmé pads to multiples of 64 KiB.
    - The writer's existing `sealed.length > maxCheckpointBytes` branch handles the ≤ 12 % growth
      (`src/engine/body/checkpoints.ts:174-176`).
  - Blobs. `maxBlobUploadBytes` = 10 MiB (DECISIONS D9).
    - [D] For lengths in [2^23, 2^24), Padmé pads to multiples of 256 KiB. The largest padded plaintext that fits
      with header and overhead is 39 × 256 KiB = 10223616 B.
    - So `MAX_BLOB_PLAINTEXT_BYTES` (suite 1) = **10223615**, the 0x80 marker included.
    - `BlobPort.maxBlobBytes` stays the transport cap. The engine compares plaintext against the suite's cap.
- **Row cost.** relay-wire §11.4: a commit costs 2 rows per touched stream, plus 1 per sealed ~64 KiB segment.
  Padding changes only the bytes.
  - [D] Small frames grow to 256 B. 100 such frames in one commit are 25 KiB, still one segment.
  - Large frames grow by ≤ 12 %, so segment rows grow by ≤ 12 % on bulk writes.
  - Storage grows by the same bound.

## 8. Replay and reorder

### 8.1 What each stream class needs

| Server action | ns / cfg | body / canvas | x: chunks | checkpoints | k | snap |
|---|---|---|---|---|---|---|
| Re-commit an old frame's exact bytes as a new row | **Rejected**: clientFrameId ring (DESIGN §c.3) plus the frameNo window (§8.2) | Harmless: a Yjs update whose structs are known is a no-op | Duplicate index, ignored (DESIGN §j.1) | n/a | Later duplicates lose (first valid wins, §11.3) | Harmless: a record is immutable per snapshot id and a tombstone is final, so a duplicate is a no-op and a replayed add cannot undo a delete |
| Re-attribute to another device or stream | Rejected by the AAD (§7.2) | same | same | same (stream) | same | same |
| Reorder concurrent frames | Accepted. The relay owns the order; frameNo accepts any legitimate reorder (§8.2) | CRDT | by index | n/a | first in seq wins | Commutative under the same two rules |
| Serve an older checkpoint, withhold rows | Accepted (§2.3) | Accepted | Accepted | Accepted | Withholding k blocks new epochs (DoS only) | Accepted: a hidden snapshot is unavailable (DoS only) |
| Fork: different views per device | Accepted (§2.1 non-goal) | | | | | |

- **`snap`** is the snapshot index stream that the recovery work adds (branch `client-remake-recovery`; not built
  here). It holds one small record per uploaded snapshot (id, part addresses, sizes, sha256s); a delete is a
  tombstone. Its replay class is **index/LWW-like**: per snapshot id, the first valid add wins and a tombstone is
  final. That is why it needs no frameNo: the two rules make a replay or a reorder converge to the same index.
  Snapshot ids are random and never reused.

### 8.2 frameNo

- **Writer.**
  - frameNo is a counter per (deviceId, stream), for `ns` and `cfg` only. It is strictly increasing across that
    device's frames on the stream, and gaps are allowed.
  - Normally `next = 1 + max(own right edge in the fold state, highest frameNo in the outbox for the stream)`.
  - On **every engine start**, the first value is that max **+ NS_DEDUPE_RING** (64). This skips any number that
    a frame may have used while it was in flight when IndexedDB was lost.
  - No new persistent counter: the fold state (in IDB and in checkpoints) and the outbox already hold it.
  - Epoch migration (DESIGN §c.12 step 3) also carries the device's highest own frameNo per stream into the new DB,
    so new frames never reuse numbers from the abandoned timeline.
- **Send window, restated over frameNo** (DESIGN §c.3). Own frame `f` may be sent only when every own frame with
  frameNo ≤ `f − NS_SEND_WINDOW` (32) is receipted.
- **Reader.** State per (deviceId, stream): a right edge R and a 64-bit bitmap, as in RFC 4303 §3.4.3 [RFC4303]
  (window ≥ 32, 64 preferred). After a frame with frameNo `f` opens and decodes:
  1. `f = 0`: malformed. Fold as empty.
  2. `f ≤ R − 64`: event `ignored/replay-stale`. Fold as empty.
  3. `R − 64 < f ≤ R` with the bit set: `ignored/replay-duplicate`.
  4. Otherwise accept and set the bit. If `f > R`, shift the bitmap and set `R = f`.
  
  The state changes only after open and decode succeed. RFC 4303 updates the window "only if the integrity
  verification succeeds".
- **Why no legitimate frame is ever rejected** [D]. When frame `f` was sent, every own frame ≤ `f − 32` had
  already committed. So any frame that commits after `f` has a frameNo > `f − 32` ≥ `R − 64`. The rule is exact
  for honest writers. The same argument already makes the clientFrameId ring exact (DESIGN §c.3).
- The clientFrameId ring stays. frameNo covers replays older than the ring's 64 ids.
- The `nsFoldV1` and `cfgFoldV1` checkpoint encodings gain `(deviceId → R, bitmap)` and become V2 (§18.2). Suite 0
  uses the same code: one path, so the sim covers it.
- Alternative: bind seq or a hash chain of predecessors in the AAD. Rejected: seq is unknown at seal time, and a
  per-device hash chain breaks on IndexedDB loss and on poisoned frames.

### 8.3 Within one vaultEpoch

R only grows, so every replay of an old ns/cfg frame is rejected, whatever its age. Body replays are no-ops.

### 8.4 Across vaultEpochs

A restore or reset starts a fresh fold, so the reader state restarts too. A server can then splice genuine
pre-restore frames from the abandoned timeline into the new epoch. This is accepted (§2.3), for three reasons:
- the restore is visible to the user as an epoch migration;
- disk is the truth (DESIGN §c.12);
- the carried-over frameNo (§8.2) keeps new frames from colliding with spliced ones.

## 9. What is sealed, and open failures

### 9.1 Sealed vs visible

- **Sealed under suite 1:**
  - every relay payload (`ns`, `cfg`, `b:`, `c:`, `x:`, `snap`);
  - every checkpoint;
  - every blob: attachments, oversize body updates behind `bodyUpdateRef`, and uploaded snapshot bundles (today one
    zip, `src/engine/snapshots/snapshotJob.ts:129-130`; multi-part bundles indexed by `snap` on the recovery branch);
  - the key material inside `k` records (§11).
- **Visible to the server:**
  - stream names: `b:`/`c:` + a random docId, `x:` + a keyed address, plus `ns`, `cfg`, `k`, `snap`;
  - the number and timing of `snap` rows, i.e. how often snapshots are uploaded (part sizes are padded blobs);
  - deviceId and clientFrameId (both random);
  - the outer envelope header (format, suite, keyEpoch);
  - `k` record headers;
  - deviceName;
  - HTTP metadata.
- **Suite pin.** The CryptoPort instance *is* the device's pin (§6.1, §12): a suite-1 port knows the vault is
  encrypted. A device with no pin has no CryptoPort: it reads `k` and nothing else, and seals nothing (§12.4).

### 9.2 Classification

`OpenFailure` grows from three reasons to five (§18.1). Readers classify a failure like this:

| Situation | Reason | Class |
|---|---|---|
| Suite 1 port reads a **suite 0** envelope | `suite-downgrade` (new) | **Deterministic.** Otherwise the server could inject plaintext frames |
| Suite 0 port reads a suite 1 envelope | `unsupported-suite` | Reader-dependent. Phase `key-missing`: "this vault is encrypted", re-key (§12) |
| Suite ≥ 2, or unknown `formatVersion` | `unsupported-suite` / `unsupported-version` | Reader-dependent (upgrade) |
| keyEpoch not held | `unknown-key` | Reader-dependent (re-key, or the `k` record not read yet) |
| Tag fails under a **verified** key (§5.2) | `auth-failed` | **Deterministic** |
| Tag fails under an **unverified** key | `auth-failed` | Reader-dependent |
| Nonce field shorter than 12 bytes, or sealed shorter than 28 | `malformed` | Deterministic |
| Valid tag, bad padding | `bad-padding` (new) | Deterministic |
| keyEpoch older than the newest revoke epoch, and the row committed after S_rot | `stale-epoch` (engine rule, §14.3) | Deterministic |

`isReaderDependent(reason, keyVerified)` replaces `isReaderDependent(reason)` (`src/engine/ingest/envelope.ts`).
A device with no suite pin never reaches this table: it opens nothing (§12.4).

### 9.3 Actions (extends the DESIGN §d.6 table)

| Class | ns / cfg | body / canvas / x | checkpoint |
|---|---|---|---|
| Deterministic | Fold as an empty frame (§c.3), plus a diagnostics event | Quarantine, freeze doc | Treat as absent: bootstrap from the tail; event |
| Reader-dependent | **Halt** the fold at the row: phase `key-missing` or `upgrade-required`. Rows wait in `tail` | Quarantine, freeze. Automatically released and re-gated on `keyringChanged` (§6.3) | Treat as absent until new keys arrive |
| `stale-epoch` | Fold as empty (`ignored/stale-epoch`) | **Ignored, no quarantine, no freeze** (the author re-seals, §14.3). A causal hole is handled by the existing rule (§d.6 step 3) | Rejected as absent |
| frameNo replay (§8.2) | Fold as empty (`ignored/replay-*`) | n/a | n/a |

- **Quarantine records keep the sealed bytes** (they already do, `QuarantineRecord.bytes`), so
  `releaseQuarantine` and the automatic re-gate can re-open them after a re-key (`src/engine/runtime/quarantineRelease.ts`).
- **Catch-up order** is `k` → `ns` → `cfg` → bodies (DESIGN §d.7 gains `k` in front). Keys are verified before
  anything else is opened, so `auth-failed` under an unverified key is rare in practice.
- **New phase `key-missing`** (`EnginePhase`, §18.4). It has three causes:
  - the device has **no suite pin** (§12.4): `keyMissing` is `"no-pin"`, or `"encrypted-vault"` once it has read a
    `k` genesis;
  - the ns/cfg fold halted on a key it does not have;
  - `k` shows an epoch above every key this device holds (a revoke it was left out of).

  The device is read-only: it seals nothing, uploads no blob, and its outbox is held. An unpinned device does not
  even run the reconcile, so it has no outbox. The status names the remedy: "Scan a re-key code from another
  device, or enter the recovery key".

## 10. Blobs

### 10.1 Addressing and dedupe

- `address = hex(HMAC-SHA-256(kAddr, sha256(plaintext)))`: 64 lowercase hex characters. It matches the server's
  only check, `^[0-9a-f]{64}$`, with no hash verification (DECISIONS D9). The R2 key is `v/<vaultId>/<address>`.
- ns entries, refs and snapshot records keep the **plaintext sha256**. The address is recomputed with the
  vault-lifetime kAddr (§5.1) in any epoch.
- `x:` streams become **`x:<address>`** (66 bytes, under the 256-byte cap in `server/src/streams/protocol.ts:16`).
  `blobChunkStream(hash)` (`src/core/types.ts:66`) becomes `blobChunkStream(address)` at every caller (`src/engine/body/frames.ts:84,129`, `src/engine/runtime/blobChunks.ts:33,48,75`). The `blobChunk`
  content still carries the sha256, now sealed.
- **Dedupe** is per vault. Identical plaintexts get identical addresses, so `exists` skips the upload
  (`src/engine/body/frames.ts:75-77`, `src/engine/blobs/blobQueue.ts:195-198`). There is no cross-vault dedupe: kAddr differs per vault.
- **Accepted leak.** Equality of two attachments inside one vault, and blob count and bucketed sizes (§2.2).
- Alternative: convergent per-blob keys `K = H(plaintext)`. Rejected: they allow confirmation of guessed files by
  anyone with the ciphertext, and add a key per blob for no single-user gain.

### 10.2 Sealed blob format

```
u8      blobFormat   = 1
u8      cryptoSuite  = 1
varuint keyEpoch     sealing epoch at upload
bytes   nonce(12) ‖ AES-GCM(kBlob_e, plaintext ‖ pad §7.3, AAD "yaos/b2" §7.2) ‖ tag(16)
```

- Suite 0 is unchanged: address = sha256, and the bytes are raw.
- A blob stays under its upload epoch forever. Rolls and revokes never re-seal blobs. A revoked device can read old
  blobs it can fetch, which follows from §14.4.
- **PUT overwrites** (DECISIONS D9). Two devices uploading the same file put two different ciphertexts at one
  address. Either opens and verifies, so last-writer-wins is harmless.
- **Download.** `get` → `openBlob(address, sealed)` → the sha256 must equal the reference. Any failure is
  "unavailable" and is retried with backoff, as today (DESIGN §j.1). After the key is verified and 3 retries
  over ≥ 3 min have failed, the referencing row is quarantined as deterministic.

### 10.3 No chunking

- One AEAD call per blob. WebCrypto has no streaming AEAD [w3c-webcrypto-73], and blobs are ≤ 10 MiB.
- [M] At ≥ 2 GB/s on desktop, sealing 10 MiB takes ~5 ms. Mobile is **[U]** (budget §16).
- Peak memory is about 3 × 10 MiB transient (plaintext, padded copy, ciphertext).
- **Caps.**
  - Suite 1 plaintext ≤ `MAX_BLOB_PLAINTEXT_BYTES` = 10223615 (§7.3). Above that the file is not synced (notice),
    as today above 10 MiB.
  - Log path (no R2, `blob = null`): chunk frames are ordinary sealed frames. [D] A 768 KiB chunk pads to
    784 KiB, under the frame cap. `MAX_LOG_BLOB_BYTES` (8 MiB) is unchanged.

### 10.4 Garbage collection

- **Today** (suite 0 as well): the server has no blob list or delete route (DECISIONS §2.2). Blobs live until the
  vault is deleted (R2 prefix purge, DECISIONS D5). E2EE changes nothing here until server ask A3.
- **With A3: client mark-and-sweep.** Cold path: a user command or at most monthly, on one device.
  1. Live set: the addresses of every sha256 referenced by ns entries (live, plus tombstones inside retention),
     unresolved `bodyUpdateRef`s, every part address named by a non-tombstoned `snap` record (§8.1), and the
     local blob queue. The sweep reads `ns` and `snap` to head first. A server that withholds `snap` rows can make
     the sweep delete snapshot parts, but it can delete them itself anyway (availability is a non-goal, §2.1).
  2. Page through `GET /vault/:id/blobs` (A3), which returns addresses and upload times.
  3. For each address that is not live and was uploaded more than 7 days ago, call
     `DELETE /vault/:id/blobs/:addr?ifUploadedBefore=<ms>` (A3).
     - The condition is checked against the R2 object's upload time, so a concurrent re-upload (PUT refreshes it)
       survives.
     - The grace period covers the gap between a put and the ns frame that references it (DESIGN §j.1 "only after
       the put succeeds").
- **Scale caveat (user, 2026-10-07).** The sweep is O(N) on the client: it lists every blob address (~50k on a heavy
  vault) and does set arithmetic against the live set on whatever device runs it, possibly a phone. It will buckle
  on heavy vaults. It is acceptable for v1 only because it is a cold, manual path. Future directions, not designed
  here: a resumable sweep with a persisted cursor, and a live set kept incrementally from the ns fold instead of
  rebuilt per run.
- Alternative: server refcounts. Rejected: the server cannot see references under E2EE, and keeping refs
  consistent across DOs would be a distributed transaction.

## 11. Keyring stream `k`

The keyring is an ordinary relay stream named `k`. The relay treats stream names as opaque, so it needs no server
change (`server/src/streams/protocol.ts:16`; server ask A9). `streamClass` gains `"keyring"` (`src/core/types.ts:74`).
`k` frames carry a **k record** as payload, not an envelope. `k` has no checkpoints: a vault sees a handful of
records in its lifetime, and each is under 256 bytes.

### 11.1 Record layout

```
u8       recordFormat = 1
u8       cryptoSuite  = 1
varuint  e            epoch this record introduces (≥ 1)
u8       kind         1 genesis | 2 roll | 3 revoke
varuint  prevEpoch    0 for genesis, else e − 1
bytes16  kcv          kcv(e) (§5.2)
varbytes nextWrap     roll only:            AES-GCM(kWrap_prevEpoch, K_e)
varbytes prevWrap     roll and revoke:      AES-GCM(kWrap_e, K_prevEpoch)
varbytes recoveryWrap genesis and revoke:   AES-GCM(KEK_RK, K_e)
```

Absent wraps are empty `varbytes`. Every wrap is `nonce(12) ‖ ct(32) ‖ tag(16)`.

| Kind | Who can obtain K_e from it | Purpose |
|---|---|---|
| genesis | RK holders (`recoveryWrap`), QR holders (direct) | Enable (§15). Anchors the RK chain |
| roll | Holders of K_{e−1} (`nextWrap`), RK holders via the chain | Nonce-budget roll (§4.2). Automatic on every device |
| revoke | RK holders, QR holders. **Not** holders of K_{e−1}, by design | Revocation (§14). A device left out cannot follow |

- **Backward chain.** `prevWrap` lets anyone holding K_e recover every older key: old checkpoints, old blobs and
  K_1 (for kAddr and kDiag).
- **RK path.** Unwrap the newest genesis or revoke record's `recoveryWrap`, then follow `nextWrap` forward through
  later rolls and `prevWrap` backward to K_1.

### 11.2 Wrap AAD

```
"yaos/k2" ‖ u8 recordFormat ‖ u8 cryptoSuite ‖ varstring vaultId ‖ varuint e ‖ u8 kind ‖ varuint prevEpoch
  ‖ bytes16 kcv ‖ u8 role            role: 1 next | 2 prev | 3 recovery
```

- The AAD binds the role, so a wrap cannot be moved to another field, record or vault.
- vaultEpoch is not bound, for the same reason as §7.2: records must survive a restore and be re-published
  verbatim (§11.5).

### 11.3 Validity and winner selection

Records are processed in seq order. A device holds a **key set** H (SecretStorage, §6). Each epoch has a winning
record: the first valid one, with these rules.

- **Validity is judged against the keys this device holds.** The recovered key must:
  - match `kcv`;
  - open `prevWrap` (if present) to a key whose kcv matches the winner for prevEpoch.

  How the device gets K_e:
  - roll: it holds K_{e−1} (the winner's key);
  - genesis and revoke: it holds K_e directly (QR), or RK is in hand.

  A record the device cannot evaluate is **pending**, not invalid.
- **Revoke outranks roll for the same epoch, whatever the seq order.** A roll for epoch e is not adopted while any
  record of kind revoke for an epoch ≥ e exists, pending or valid.
  - This stops a revoked device colluding with the server. It holds K_{r−1}, and could otherwise forge a roll for
    epoch r that every device holding K_{r−1} would accept. It cannot forge a revoke record, because that needs a
    `recoveryWrap` under KEK_RK.
- **Winners are sticky.** A winner, once decided, is stored with its record in SecretStorage (`records`, §6.1)
  and never re-decided. Later records for the same epoch are ignored (event `keyring/duplicate`), even if valid.
  Byte-identical re-publishes are a no-op.
- **Keys entered out of band are authoritative.** If a QR key or an RK unwrap for epoch e conflicts with `k`'s
  record for e (kcv mismatch), the record is rejected (event `keyring/conflict`).
- **Phase `key-missing`** (§9.3) is entered when a pending genesis or revoke record has an epoch above every key
  held, or when an ns/cfg row names an unknown epoch. While in it, the device seals nothing. Leaving it needs a QR
  or RK re-key (§12, §13).
- **What a hostile server can do with `k`** (§2.3):
  - append garbage records: a device ignores ones it can evaluate, and ones it cannot may push it into
    `key-missing` (denial of service only);
  - withhold or reorder records: delays only, since every honest record is self-validating;
  - fork views between devices: a non-goal (§2.1). The fork case for revocation is in §14.3.
- **Catch-up order** is `k` to head, then ns, cfg, bodies (§9.3). Live `k` rows are processed before anything
  queued behind them.

### 11.4 Roll

1. Trigger (§4.2). Let e = (highest winning epoch) + 1.
2. Generate K_e with `getRandomValues`. Build the roll record. Post `keyringChanged {pending: e}` so main persists
   K_e **before** the append, and a crash after the commit cannot lose the key.
3. Append the record to `k` and wait for its receipt at seq s.
4. Read `k` through s.
   - If this device's record is the winner for e, it adopts e: new seals use e.
   - If another device won (a concurrent roll), it discards K_e and adopts the winner's key from `nextWrap`.
5. Other devices adopt e when they read the record.

Rows already sealed under e−1 stay valid. Outbox frames are not re-sealed: a roll is hygiene, not a compromise.

- Alternative: a deterministic ratchet `K_e = HKDF(K_{e−1})`. Rejected: no record would be needed, but everyone
  holding any old key could derive every future key, which makes revocation impossible.

### 11.5 Re-publish after reset or restore

- A reset empties every stream, and a restore to T drops records committed after T (DECISIONS D8b, `server/src/vault/host.ts:686`, `:767`).
- On the first VAULT_READY in a new vaultEpoch, a device reads `k` to head. It then appends, in epoch order,
  every stored record whose epoch has no record in `k`.
- The bytes are verbatim, so the records validate exactly as before. Concurrent re-publishes from two devices
  produce byte-identical duplicates, which are harmless.
- Every device keeps all records (§6.1), so any device can re-publish. A device restoring from RK alone needs the
  genesis or a revoke record to be present. After a reset where no device survives, the vault holds nothing
  readable anyway.
- **Genesis position.** Enable writes the genesis record only on the creation path, at `VAULT_READY.head = 0` (§15.1). Readers do not rely on its
  position: validity alone decides.

## 12. Pairing

### 12.1 Pick: a plugin-drawn QR carrying the key in a client-only link

```
obsidian://yaos?action=setup&host=<host>&pairingCode=<vaultId.secret>&key=<b64url(u8 1 ‖ varuint e ‖ K_e)>
```

1. The paired device calls `POST /vault/:id/auth/pairing-code` (DECISIONS §2.2), as today.
2. It builds the link locally, extending `buildSetupLink` (`src/host/ui/pairing.ts:485`).
   - `key` holds the newest winning epoch and its key: 1 + 1 + 32 bytes, 46 base64url characters.
   - Older keys come from the `prevWrap` chain (§11.1).
   - The vaultId is already inside the pairing code (DECISIONS D3).
3. The plugin draws the QR itself, with `qrcode` 1.5.4 (+9.6 KB gzip **[M]**, §23).
4. The new device scans it. Obsidian hands the parameters to `registerObsidianProtocolHandler`
   (`src/host/ui/registerUi.ts:152`). `parseSetupLink` (`pairing.ts:501`) accepts `key` or `suite` (§12.4), never
   both (they join `SETUP_LINK_KEYS`, `pairing.ts:494`, which rejects unknown keys today).
5. **The key is stripped before `/enroll`.** DECISIONS D3 requires exactly this: "A future client-only key part
   must be stripped before `/enroll`". The key goes into the pending identity, in memory only. After enroll, the
   device reads `k`, checks kcv and walks the chains (§11.3). It then persists the keys and the suite pin.

Rules:

- **NEVER put a key in any URL the server serves**, including the fragment of `GET /mobile-setup`.
  - That page is a static Worker response whose JS reads `location.hash` (`server/src/console/mobileSetup.ts:47`).
  - Its `connect-src 'none'` CSP is set by the same server, so it is no guarantee.
  - The pair modal stops showing `mobileSetupUrl` (`src/host/ui/pairModal.ts:194`) under **both** suites. That page
    is server-drawn, so it can carry only a key-less join, and a key-less join is blocked (§12.4). The plugin draws
    the `obsidian://` QR itself instead (iOS Camera opens it, §3).
- **The link is a secret.** It is shown only after an explicit "Show pairing QR" click and hidden when the code
  expires (15 min, DECISIONS D3) or the modal closes. It is never logged.
  - "Copy setup link" stays, for phone → desktop and for desktops without a camera, with a warning: "This link
    contains your vault key. Send it only over a channel you trust (AirDrop, a cable), never a chat app."
- **Opening an `obsidian://` QR from the stock camera.** iOS Camera (iOS 11+) recognises it and offers to open
  Obsidian **[User]**. Android is **[U]** (§23.3). Fallbacks, in order:
  1. the copied link;
  2. pair with the code alone; the device then stays blocked until the recovery key is entered (§12.4).
- Alternative: SAS or ECDH pairing, where the new device and the old one agree a key through the relay and the
  user compares a short code (decision D5). Rejected for v1:
  - it needs an interactive two-device protocol over relay streams, with its own state machine and timeouts;
  - X25519 support in mobile WebViews is **[U]**;
  - a QR has the same trust root (the user's eyes on both screens) with no protocol.
- Alternative: in-plugin QR scanning. Rejected: camera permission inside Obsidian mobile is **[U]**, and it needs
  a QR decoder dependency.

### 12.2 Enroll from the operator console

The console mints owner codes (DECISIONS D5, `POST /operator/vaults/:id/owner-code`). Its page and QR are served by
the server (the console draws `obsidian://yaos?action=setup&host&pairingCode` and a `/mobile-setup#…` QR,
`server/src/console/console.ts:158-169`), so they can never carry the key, and nothing they carry is trusted. A
device paired this way is a **key-less join** (§12.4): it stays blocked until it gets the recovery key or a QR from
one of the user's devices. It can never set suite 0 and never reaches the creation path (§15.1).

### 12.3 Device name

- deviceName is plaintext on the server, shown in the console and stored in device rows
  (`server/src/vault/host.ts:544`).
- The default is already a platform label such as "iPhone" or "Mac" (`src/host/ui/deviceName.ts`). The server
  de-duplicates repeats (`uniqueDeviceName`, `host.ts:544`).
- Under suite 1 the pair modal shows a hint next to the name field: "Visible to the server operator". No server
  change is needed (decision D6).

### 12.4 Suite pin, key-less joins and downgrade

**Fail closed.** If the pin says suite 1, the device is suite 1, and without the key it does not write. A device
with **no pin** writes nothing at all:
- no frame on any stream (`k` included), no checkpoint, no blob, no ns entry;
- no reconcile, so no outbox;
- it may enroll and read `k`, and that is all.

No screen anywhere offers to continue without encryption.

**A pin comes from exactly one of three sources.** All three are authenticated by the user or by this device;
none is something the server says.

| # | Source | Pin | Accepted only if |
|---|---|---|---|
| (i) | A key from a plugin-drawn pairing or re-key QR/link (§12.1, §14.2 step 3), or the RK (§13.3) | 1 | The key's kcv matches a valid `k` genesis or revoke record (§11.3). With no matching record (`k` empty, hidden or garbage) the device stays unpinned and blocked. It keeps the key in memory and retries as `k` arrives, and never persists an unverified key |
| (ii) | A plugin-drawn pairing link from a device already pinned to suite 0, carrying `suite=0` | 0 | This device has never read a `k` genesis for the vault (`keyringSeen`, below), and `k` read to head now is empty |
| (iii) | This device creating a brand-new vault (§15.1) | 1, or 0 by the D2 opt-out | The device made the vault-creating call itself, and then read `VAULT_READY.head = 0` and an empty `k` (§15.1) |

- `parseSetupLink` accepts `key` or `suite=0`, never both, and no other `suite` value (a key implies suite 1).
- `data.json` holds `e2ee` as one of: absent (unpinned), `{suite: null, keyringSeen: true}`, `{suite: 0}` or
  `{suite: 1}`. `keyringSeen` is sticky. It is set the first time an unpinned device reads a `k` genesis for its
  vault, and from then on (ii) is refused.

**Key-less join.** This is any enrollment by a code that arrived without `key` or `suite`:
- a code typed into the pair modal;
- an `obsidian://yaos?action=setup` link without them, including the console's link and its `/mobile-setup` QR
  (`server/src/console/console.ts:158-169`), and the `obsidianUrl` in a claim response shown by the console
  (relay-wire §2.2);
- `resumePendingEnrollment` (`src/host/ui/pairFlow.ts:114`) of any of those.

After a key-less join the device enrolls, stays unpinned and reads `k`:
- `k` has a genesis record → `keyringSeen`, phase `key-missing` with `keyMissing: "encrypted-vault"`;
- `k` is empty → phase `key-missing` with `keyMissing: "no-pin"`. It **stays blocked**. An empty `k` is what an
  unencrypted vault looks like, and also what a server hiding `k` looks like. This holds even at
  `VAULT_READY.head = 0`: an empty vault reached by a key-less join is not a creation (§15.1).

The blocked screen offers exactly two actions, and says why:

> YAOS can't tell whether this vault is end-to-end encrypted. The server says it holds no encryption key record,
> but a server can hide one, so this device will not sync until one of your own devices or your recovery key
> settles it.
> [Enter recovery key] [Scan QR from one of your devices]

(For `"encrypted-vault"` the first sentence reads "This vault is end-to-end encrypted.")

- **"Scan QR from one of your devices"** says: on a device that already syncs this vault, open YAOS → "Pair a
  device" (or "Show re-key QR") and scan it with the camera.
  - A suite-1 device's QR carries the key: source (i).
  - A suite-0 device's pairing QR carries `suite=0`: source (ii).
- **No re-enrollment.** The blocked device is already enrolled. When a setup link names the vault it is enrolled in
  (the vaultId is inside the pairing code, DECISIONS D3), it takes only `key` or `suite` from the link and does not
  enroll again. The code expires unused after 15 min.
- **No third button.** Nothing on this screen sets suite 0, enables encryption or creates a vault.

**Rules kept.**
- A suite-0 device that sees a `k` genesis stops: phase `key-missing`, `keyMissing: "encrypted-vault"`. It seals
  nothing and never switches suite by itself (§15.2).
- A suite-1 device treats every suite-0 row as deterministic malformation (`suite-downgrade`, §9.2). A server that
  hides `k` and shows suite-0 rows cannot make a pinned device accept plaintext.

**Residual risk.** Sources (i) and (ii) trust the user to take the QR or link from their own device's YAOS screen
(§2.1). A hostile server, or any web page, can draw an `obsidian://yaos` link:
- one with `suite=0`, while it hides `k`; or
- one with a key of its own, plus a forged genesis for that key.

A user who scans such a link from anywhere but their own device gets a device that writes on the attacker's terms.
The mitigations:
- the honest console draws only key-less links;
- the plugin never tells the user to scan anything the server serves;
- the pair modal shows "End-to-end encryption: On" or "Off (from this link)" before pairing.

What no longer exists is **downgrade by omission**. A user who does what the honest console says, and scans its
QR, ends up blocked, not downgraded.

## 13. Recovery key

### 13.1 Format

- `RK = 32 random bytes ‖ first 3 bytes of SHA-256(those 32)`: 35 bytes.
- Crockford base32 gives 56 characters, shown as `YAOS-RK1-` plus 14 groups of 4, e.g.
  `YAOS-RK1-0000-0000-…` (fake).
- Decoding ignores case, dashes and spaces, and maps `I`/`L` to `1` and `O` to `0`.
- The 24-bit checksum catches typos before any crypto: 1 in 16.7M misses.
- KEK_RK = HKDF(RK[0..32]) (§5.1). The key has full entropy, so no password KDF is needed.

### 13.2 Lifecycle

- **Created** at enable, on the creating device (§15.1).
  - Shown **once** with Copy, plus the advice "Store it outside this vault: a password manager or paper".
  - The user confirms by retyping 2 random groups. Enable cannot finish until they do.
- **NEVER stored by YAOS**: not in SecretStorage, `data.json`, IndexedDB or logs. The device holds it only
  transiently while unwrapping or wrapping.
- **Used for:**
  - adding a device without another device at hand (§12.4);
  - the all-devices-lost case (§13.3);
  - every revoke, which needs `recoveryWrap` (§14.2).
- **Change it** ("I lost it" or "it leaked"). This runs a revoke-kind rotation that generates a new RK
  (§14.2). The old RK still opens everything up to that rotation; that is inherent, since the old RK unwraps the
  old genesis.
- Alternative: derive a P-256 recovery key pair from RK, so that a revoke wraps to its public key without the RK
  being entered. Rejected for v1: deterministic EC private-key import needs the public point, i.e. EC scalar math
  that WebCrypto does not expose (JWK import requires `x` and `y`; whether PKCS#8 without them imports is **[U]**).

### 13.3 All devices lost

1. Operator console → the vault → "Owner code" (`POST /operator/vaults/:id/owner-code`, DECISIONS §2.2). The
   console shows the code and its QR.
2. On a new device, pair with the owner code. That is a key-less join, so the device enrolls and stays blocked
   (§12.4). Choose "Enter recovery key".
3. The RK is never sent anywhere. The device reads `k` to head, and unwraps the newest genesis or revoke
   record's `recoveryWrap`. It checks kcv, walks `nextWrap` forward and `prevWrap` back to K_1 (§11.1), stores
   the keys, and bootstraps normally.
4. Every revoke wraps K_r under the RK in force at that time (§14.2), so the current RK opens the newest record.
   An older, replaced RK opens only the epochs before the rotation that replaced it: the device reads that much
   and stays in `key-missing` for the rest.

Without the RK, and with no device left: **the data is unrecoverable, by design.** The operator can delete the
vault. Any local copy of the files on disk can seed a new vault.

## 14. Rotation and revocation

### 14.1 Kinds of rotation

| Trigger | Record kind | Who acts | Other devices |
|---|---|---|---|
| Nonce budget (§4.2) | roll | Any device, automatically | Adopt automatically (`nextWrap`) |
| Revoke a device | revoke | The user, on a kept device, with the RK | Re-key by QR or RK (`key-missing` until then) |
| Change the RK (lost or leaked) | revoke, with a new RK | The user | Same as revoke |
| Suspected key leak | revoke | The user | Same as revoke |

### 14.2 Revoke flow

1. **Revoke the device in the operator console** (DECISIONS D7: `DELETE /operator/vaults/:id/devices/:deviceId`,
   operator-only). The gate shuts in the revoke turn: no frame of that device commits afterwards, and its bearer
   gets 401 on every device route. The client cannot revoke; there is no device route for it (D7).
2. **On a kept device, run "Re-key after revoking a device"** (command and settings button).
   - The user enters the RK, or chooses "Generate a new recovery key" (shown and confirmed as in §13.2).
   - The device builds a revoke record for `r = highest epoch + 1`: kcv, `prevWrap` and `recoveryWrap`, and no
     `nextWrap`.
   - It persists K_r as pending (§11.4 step 2), appends the record, gets the receipt at seq **S_rot**, reads `k`
     through S_rot, and adopts r if its record won (§11.3).
   - Steps 1 and 2 may run in either order: the revoked device cannot follow r either way. Revoke-first is the
     documented order, so the device stops writing sooner.
3. **Re-key every other kept device.** The re-keying device shows a re-key QR,
   `obsidian://yaos?action=rekey&key=<b64url(u8 1 ‖ varuint r ‖ K_r)>`, with no pairing code because these
   devices are already enrolled. Each other device scans it, or enters the RK. It checks kcv against `k`
   (§11.3), stores K_r and leaves `key-missing`.
4. **Own frames sealed under an epoch < r that commit after S_rot** are stale (§14.3), so readers ignore them.
   Their author handles them as in `refused frame-id-conflict` (DESIGN §i.6 table):
   - body: re-seal the same update under a fresh clientFrameId, since Yjs updates are idempotent;
   - ns and cfg: re-plan the ops under a fresh frame id.

   Unsent outbox frames under an epoch < r are re-sealed under r before sending.
5. **Checkpoints.** Nothing is forced. New checkpoints are sealed under r at the normal cadence (DESIGN §d.9
   checkpoint policy). Old checkpoints with coversSeq ≤ S_rot stay valid.

### 14.3 Stale-epoch rule

For the winning revoke epoch r, committed at S_rot in the current vaultEpoch:
- a frame with `keyEpoch < r` and `seq > S_rot` is **stale**: ignored, not quarantined (§9.3);
- a checkpoint with `keyEpoch < r` and `coversSeq > S_rot` is rejected (treated as absent).

Devices that have not re-keyed still learn r from the record header, so they apply the rule too.

- **After a reset or restore**, S_rot is the seq of the re-published revoke record (§11.5). Between the new
  vaultEpoch's first row and that re-publish, the server could inject old-epoch frames that the revoked device
  sealed. This is an integrity risk only: the revoked device learns nothing new. It is bounded by the first kept
  device to reconnect, and accepted.
- **Fork** (non-goal, §2.1). A server that hides the revoke record from device X, and shows X a roll for r forged
  with K_{r−1}, makes X adopt a key the revoked device knows. X's later writes are then readable by the revoked
  device. A QR or RK re-key of X overrides it (out-of-band keys are authoritative, §11.3). The UX tells the user
  to re-key **every** kept device, which closes this.

### 14.4 What a revoked device keeps (said plainly)

- **Everything it ever decrypted**: the notes, attachments and settings on its disk, and its IndexedDB.
  Revocation cannot unsend them.
- **Every key up to epoch r−1**, plus kAddr and kDiag (vault lifetime, §5.1). With the server's help it can:
  - read every row and blob sealed before the revoke (old-epoch rows are never re-sealed);
  - recognise a file it knows if it is uploaded again later, since the address is the same (§2.3).
- **What it loses:** every row sealed under an epoch ≥ r, and all write access (D7).
- **Deep rotation (decision D4).** Rotating kAddr means re-uploading every blob under new addresses, then deleting
  the old ones (needs server ask A3). The cost is one PUT per blob and egress for the whole vault, and the only gain
  is closing the "recognise a re-upload" leak. Decided (D4, §22): not now; an optional "Deep re-key" command
  later.
- Alternative: re-seal all history under r on revoke. Rejected: the revoked device already holds the plaintext,
  so it gains nothing. It costs a full rewrite of the vault, i.e. rows and day budget.

## 15. Enable, migrate, disable

### 15.1 Enable: the creation path (new vaults only)

Encryption is chosen only on the **creation path**: a YAOS "Create a new vault" flow in which this device makes
the vault-creating server call itself. The plugin has no such flow today:
- every pairing is a key-less enroll by code (`enroll` and `pairDevice`, `src/host/ui/pairing.ts:392`, `:397`);
- an unclaimed server is refused with "Open it in a browser to claim it first" (`pairing.ts:232-233`).

WP-E5 adds the flow.

**Definition.** A device is on the creation path for vault V if and only if, in one flow that the user started from
YAOS's own "Create a new vault" command or button, all three steps hold:
1. **This device sent the call that created V,** and read V's vaultId from the response:
   - **Unclaimed server** (`GET /api/capabilities` says `claimed: false`): `POST /claim` (relay-wire §2.2,
     `server/src/router.ts:213`).
     - The claim creates the first vault (`CLAIM_VAULT_NAME`, `router.ts:69`) and returns its `pairingCode`.
     - The operator recovery key is generated on main, then shown and confirmed as the console does
       (`server/src/console/console.ts:247-258`).
   - **Claimed server**, in this order:
     - `POST /operator/login` (`router.ts:215`) with the operator recovery key typed into this flow;
     - `POST /operator/vaults {name}` (`:221`);
     - `POST /operator/vaults/:id/owner-code` (`:435`) for that vaultId;
     - `POST /operator/logout`.
2. **It enrolled with the code from step 1.** The code must name that vaultId, and it never leaves memory: it is
   not displayed, not put in a link and not logged.
3. **After enrolling, it read `VAULT_READY.head = 0`** (relay-wire §3.2) **and read `k` to head, empty.**

Only then does the screen show "End-to-end encryption: On", preselected, with the opt-out (decision D2). If any check
fails, the flow aborts with "The server returned a vault that is not empty" and sets no pin. The device stays
unpinned and blocked (§12.4).

- **Never entered from:**
  - the protocol handler (`src/host/ui/registerUi.ts:152`) or `parseSetupLink`;
  - a typed or scanned code;
  - the console's QR or link, or a claim response's `obsidianUrl`;
  - `resumePendingEnrollment`.

  All of those are key-less joins (§12.4).
- **Crash recovery.**
  - Right after step 1's response, main writes `creating: {vaultId}` to `data.json`. Nothing else writes it.
  - On restart, an enrolled, unpinned device whose vaultId equals `creating.vaultId` resumes at step 3. Every other
    unpinned device is blocked (§12.4).
  - The marker is removed once a pin is set.
- **Secrets.** The operator recovery key is held only for step 1. It is never stored, and the §6.1 NEVER rules
  apply to it. The settings hint "The operator key stays in the console" (`src/host/ui/settingsTab.ts:116`) gains an
  exception for this flow.
- **`Origin` [U].** `/claim` and the operator routes require JSON and an `Origin` equal to the server's origin
  (`server/src/router.ts:117-127`, DECISIONS D5).
  - Whether Obsidian's `requestUrl` can send that `Origin` on desktop and mobile is **[U]**. E5 checks it first.
  - If it cannot, server ask A11 applies (§19).
- **What a lying server gains.** It could return an existing vault in step 1 and fake an empty one in step 3.
  - Under suite 1 (the default), the device seals under a fresh K_1 that the server never sees. That is a fork
    (§2.1), and the server learns nothing.
  - Under the opt-out, the device uploads in plaintext only what the user chose to upload in plaintext.
  - A join never offers this choice.
- **Console-created vaults** cannot be set up by a device. That covers `POST /operator/vaults` from the console page
  and the vault a console claim makes. Every device that reaches one is a key-less join and stays blocked. The
  console stays useful for revoke, for owner codes on the RK path (§13.3), and for delete.

Enable steps (suite 1):
1. generate K_1 and the RK;
2. show the RK and require the retype confirmation (§13.2);
3. append the genesis record to `k` as the vault's first frame, and hold every ns frame until it is receipted;
4. persist the keys and the record (§6.1), then set the pin `e2ee: {suite: 1}`.

**Opt-out (suite 0):** set the pin `e2ee: {suite: 0}`. No `k` record is written. Other devices join by source (ii)
links (§12.4).

- A crash before step 3's receipt leaves an empty vault. The retry, resumed through `creating`, regenerates
  everything. Pending keys are dropped because the record never won.

### 15.2 Migrate an existing vault, or turn encryption off

Both mean **a new vault** (decision D7):
1. In the plugin, run "Create a new vault" (§15.1) with encryption On, or Off by the opt-out. The device leaves the
   old vault first. The initial reconcile uploads every file from disk.
2. Pair the other devices with the plugin-drawn QR (§12.1), or the suite-0 link (§12.4).
3. Delete the old vault in the console. Deletion runs `deleteAll()` and then purges the R2 prefix `v/<vaultId>/`
   (DECISIONS D5, D9).
   - Durable Object PITR keeps 30 days of history [CF-PITR]. Whether it can still restore after `deleteAll()` is
     **[U]**, so the old plaintext may linger at Cloudflare for up to 30 days.

- **Suites never coexist in a vault.** One pin per device. A suite-1 device treats suite-0 rows as malformed
  (§9.2). A suite-0 device reading suite-1 rows halts (`unsupported-suite`, reader-dependent).
- Alternative: migrate in place with reset-streams (D8a), then re-upload under suite 1. Rejected (decision D7):
  - reset keeps R2 blobs (D9 has no generation in the R2 key), so plaintext attachments stay readable until the
    blob GC (A3) exists;
  - PITR keeps the plaintext timeline anyway;
  - the result is a new vault in all but name, with confusing pairing.
- Alternative: mixed suites during a migration window. Rejected: a downgrade path, and two code paths in every
  reader.

## 16. Performance budget

### 16.1 Inputs

- **[M]** desktop (§3):
  - 1 MiB AES-256-GCM seal: Chrome ~3000 MiB/s; WKWebView (macOS) 2174 MiB/s seal, 5556 MiB/s open;
  - per-call floor 5.5 µs (Chrome) and 12 µs (WKWebView), sequential at 64 B.
- **[U]** mobile, assumed **10× worse**: 100 MiB/s and 0.1 ms per call, until §23.3 measures it.
- Calls per operation:

| Operation | Crypto calls |
|---|---|
| Frame seal or open | 1 AES-GCM, plus 1 padding copy |
| Blob up | sha256 (already done today), 1 HMAC (address), 1 AES-GCM |
| Blob down | 1 AES-GCM, sha256 (already done today) |
| Engine start | 1 HKDF import per held epoch, plus 7 `deriveKey` (§5.1) |
| Older epoch, first use | 5 `deriveKey`, lazily |
| Re-key | ≤ 3 unwraps per record walked, plus 1 kcv per epoch |

### 16.2 Budgets (MUST hold; WP-E7 measures them)

| Path | Desktop | Mobile (assumed) | Note |
|---|---|---|---|
| Typing: one frame per `OPEN_FRAME_IDLE_MS` (100 ms, `src/core/limits.ts:56`) | ≤ 0.05 ms per frame | ≤ 0.5 ms | Below 1% of the frame interval |
| Bootstrap, 10k docs, 200 MiB of checkpoints and tail | ≤ 0.3 s total crypto | ≤ 3 s (10k × 0.1 ms + 200 MiB ÷ 100 MiB/s) | Downloading 200 MiB dominates |
| One 10 MiB blob | ≤ 10 ms | ≤ 100 ms | Plus 3 × 10 MiB transient memory (§10.3) |
| Engine start | ≤ 5 ms | ≤ 20 ms | |
| Bundle | +0 KB (WebCrypto) | | `qrcode` +9.6 KB gzip **[M]**, plus ~2 KB of base32 and record code [D] |

Crypto is never on the hot path. Bootstrap is bound by the network and the planner, not by AES. If a mobile run
(§23.3) misses a budget by more than 2×, the fallback is to batch opens with `Promise.all` (the spike measured
~2.4 µs per call batched, §3). No format change is needed.

### 16.3 Transaction rule (correctness, not speed)

- WebCrypto promises settle on a task, not a microtask. Awaiting one inside an IndexedDB transaction body lets the
  transaction auto-commit early, and later writes then fail.
- **NEVER await a CryptoPort or HashPort call inside a `runTx` body** (`src/engine/adapters/idbStorage.ts:187`).
  Seal before the transaction and open after it.
- **Static audit (this worktree).** Every crypto call site seals or opens outside the transaction body:
  - `src/engine/runtime/docRuntime.ts:109, :246, :256`;
  - `src/engine/runtime/engine.ts:167, :225`;
  - `src/engine/sync/ingestRow.ts:36`;
  - `src/engine/sync/catchUp.ts:112`;
  - `src/engine/runtime/quarantineRelease.ts:28`;
  - `src/engine/runtime/mirrorIo.ts:186`.

  The engine is changing in parallel, so this is re-checked by test, not by reading.
- **Why the sim cannot see it today.** `identityCrypto` resolves on microtasks (`src/core/codec/envelope.ts:242`).
  `MemStoragePort` trips `tx-inactive` only when a body awaits a macrotask (`src/sim/storage.ts:29-44`).
- **Fix (WP-E7).** A `DelayedCrypto` double settles every call after `setTimeout(0)`. Any future crypto await
  inside a transaction then fails the sim and the unit tests, exactly as on a device.

## 17. Lost server features and client replacements

The rewritten server already verifies nothing about content (DECISIONS §2.1, D9). Suite 1 makes that a property
rather than an accident.

| Feature (legacy or possible) | Under suite 1 | Client replacement |
|---|---|---|
| Server check that a blob's bytes match its sha256 | Impossible: opaque address | AEAD tag plus sha256 after open (`src/engine/body/refs.ts:50-59`) |
| `X-YAOS-Content-SHA256` / `-Size` headers | Would leak the plaintext hash and size. At 7208184 they are only still named in the CORS expose list (`server/src/http.ts:7`); nothing sets or reads them | The client never sends them. Server ask A2 removes the stale names |
| Server-side debugging of content | Impossible | Diagnostics carry `HMAC(kDiag, ·)` hashes (§6.4). The user shares a bundle and correlates locally |
| Point-in-time restore (D8b) | **Still works**: opaque rows rewind | Old keys stay in the keyring. `k` is re-published (§11.5) |
| Blob garbage collection | The server cannot see references | Client mark-and-sweep (§10.4), blocked on A3 |
| Cross-vault dedupe | Impossible: kAddr is per vault | None, by design |
| Server search, publish or web view | Impossible | None (out of scope) |
| Server-held key recovery | Never existed | RK (§13) |
| Operator snapshot or recovery routes, server backup alarm | Removed by the rewrite (DECISIONS §1, D5). The server never parses note content and has no backup alarm (user decision, 2026-10-07) | The client snapshot exporter: opaque multi-part bundles uploaded as sealed blobs and indexed by the sealed `snap` stream (§8.1, §9.1; recovery branch). `snap` part addresses are in the GC live set (§10.4). Otherwise operator PITR (D8b) |
| Server-side size accounting per vault | Still works, but sizes are padded (§7.3) | n/a |

## 18. Shape changes and DESIGN diffs

The client remake has not shipped, so formats change **in place**: envelope `formatVersion` stays 1, and the
checkpoint encodings and IDB schema are edited rather than versioned. If a build ships before WP-E2 lands, bump
`DB_SCHEMA_VERSION` to 2 (`src/engine/store/schema.ts:19`) instead and treat an old DB as lost (DESIGN §i.5).

### 18.1 `src/ports/crypto.ts`

```ts
export type BlobAddress = Brand<string, "BlobAddress">;   // suite 0: sha256 hex; suite 1: HMAC(kAddr, sha256) hex
export type SealPurpose = "frame" | "checkpoint";
export type OpenFailure =
  | "unknown-key" | "auth-failed" | "unsupported-suite"
  | "suite-downgrade"          // NEW: suite-1 port given suite-0 bytes (§9.2)
  | "malformed";               // NEW: nonce < 12 bytes or sealed < 28 bytes (§4.1)
export type OpenResult = { readonly ok: true; readonly plaintext: Uint8Array } | { readonly ok: false; readonly reason: OpenFailure };

export interface CryptoPort {
  /** Suite for new seals; also this device's pin (§9.1). */
  readonly suite: CryptoSuite;
  /** Epoch for new seals (0 for suite 0). Changes when a roll or revoke is adopted; read it once per seal. */
  sealEpoch(): number;
  /** held: key present; verified: kcv matched the winning k record (§5.2). Suite 0: {held: e === 0, verified: true}. */
  keyState(keyEpoch: number): { readonly held: boolean; readonly verified: boolean };
  /** keyEpoch is the one already written into the header (the AAD binds it), so a concurrent roll cannot split them. */
  seal(input: { readonly purpose: SealPurpose; readonly keyEpoch: number; readonly aad: Uint8Array; readonly plaintext: Uint8Array }): Promise<Uint8Array>;
  open(input: { readonly purpose: SealPurpose; readonly suite: CryptoSuite; readonly keyEpoch: number; readonly aad: Uint8Array; readonly sealed: Uint8Array }): Promise<OpenResult>;
  /** Whole sealed-blob format incl. header and padding (§10.2). Suite 0: identity. */
  sealBlob(input: { readonly address: BlobAddress; readonly plaintext: Uint8Array }): Promise<Uint8Array>;
  openBlob(input: { readonly address: BlobAddress; readonly sealed: Uint8Array }): Promise<OpenResult>;
  blobAddress(hash: ContentHash): Promise<BlobAddress>;
  /** Diagnostics digest, 16 hex chars. Suite 0: sha256 prefix; suite 1: HMAC(kDiag, bytes) prefix (§6.4). */
  diagHash(bytes: Uint8Array): Promise<string>;
}

/** Suite-1 adapter only; used by the keyring engine (WP-E3). Raw keys never cross this interface outward. */
export interface KeyringCrypto {
  generate(e: number): Promise<void>;                                  // new K_e, held as pending
  install(e: number, raw: Uint8Array): Promise<void>;                  // QR / RK path; zero-fills raw
  kcv(e: number): Promise<Uint8Array>;
  wrap(role: "next" | "prev" | "recovery", e: number, aad: Uint8Array, rk?: Uint8Array): Promise<Uint8Array>;
  unwrap(role: "next" | "prev" | "recovery", e: number, aad: Uint8Array, wrapped: Uint8Array, rk?: Uint8Array): Promise<boolean>;
  markVerified(e: number): void;
  setSealEpoch(e: number): void;
  drop(e: number): void;                                               // discard a pending key that lost
  exportForHost(): readonly { readonly e: number; readonly k: Uint8Array }[]; // only for keyringChanged (§18.4)
}
```

- `openBlob` returns a result rather than `Uint8Array | null`, so the caller can classify the failure (§10.2).
  The callers that change are `src/engine/body/refs.ts:58-59` and `src/engine/blobs/blobQueue.ts:204`.
- **The suite-0 adapter** (`src/engine/adapters/noopCrypto.ts`) and `identityCrypto`
  (`src/core/codec/envelope.ts:242`) implement the new shape. `sealEpoch()` returns 0.
- **The suite-1 adapter is new**, at `src/engine/adapters/webCryptoSuite1.ts` (WP-E1). It holds non-extractable
  CryptoKeys only.

### 18.2 Envelope, codec, limits, fold

- `src/core/envelope.ts`:
  - `CryptoSuite = { none: 0, aes256gcm: 1 }`, replacing the reserved `xchacha20poly1305: 1`;
  - `AAD_FRAME_PREFIX = "yaos/f2"`, `AAD_CHECKPOINT_PREFIX = "yaos/c2"` and the new `AAD_BLOB_PREFIX = "yaos/b2"`,
    `AAD_KEYRING_PREFIX = "yaos/k2"`;
  - the inner layout gains `varuint frameNo` after `flags`. It is 0 for kinds outside ns and cfg, and non-zero
    for ns and cfg (§8.2);
  - `EnvelopeOpenResult.reason` gains `"suite-downgrade"` and `"bad-padding"` (§9.2). Replay is a fold
    decision, not an open failure: `NsIgnoreReason` (`src/core/types.ts:232`) and the cfg equivalent gain
    `"replay-stale"`, `"replay-duplicate"` and `"stale-epoch"` (§8.2, §14.3);
  - `CheckpointEncoding`: `nsFoldV1` and `cfgFoldV1` are redefined in place to carry the replay window (named
    V2 in this document).
- `src/core/codec/envelope.ts`:
  - `bindingAad` (lines 155-162) writes the §7.2 fields: header plus deviceId for frames, header for checkpoints;
  - padding (§7.3) is applied when `suite ≠ 0`, between the inner encoding and `seal`, and stripped after `open`.
- `src/core/types.ts`:
  - `NsFoldState` and `CfgFoldState` gain `readonly replay: Map<DeviceId, { r: number; bits: bigint }>` (64-bit
    window);
  - `StreamClass` gains `"keyring"`, and `streamClass("k") === "keyring"`;
  - `blobChunkStream(address: BlobAddress)`.
- `src/core/limits.ts`:
  - `MAX_FRAME_CONTENT_BYTES` (:49, today 1 MiB − 4 KiB) → 1015808 (§7.3);
  - new `MAX_BLOB_PLAINTEXT_BYTES_SUITE1 = 10223615`;
  - new `REPLAY_WINDOW = 64`, `ROLL_SEQ_SPAN = 2 ** 23`, `ROLL_OWN_SEALS = 2 ** 22`,
    `PADME_FLOOR_BYTES = 256`, `KEY_STORE_WAIT_MS = 5000`.
- `QuarantineReason` (`src/engine/store/schema.ts:186`) gains `"crypto-downgrade"` and `"envelope-padding"`.

### 18.3 IndexedDB (`src/engine/store/schema.ts`)

| Store / record | Change |
|---|---|
| `OutboxRecord` (:156) | + `keyEpoch: number` (the epoch inside `sealed`, for the revoke re-seal, §14.2); + `frameNo: number \| null` (ns/cfg) |
| `MetaRecord` | + `MetaKeyring {key: "keyring"; sealEpoch; epochs: {e, firstSeq, kind, verified}[]; revokeEpoch: number \| null; sRot: Seq \| null; ownSeals: number}`. **No key bytes** (§6.1) |
| `MetaRecord` | + `MetaFrameNoFloor {key: "frameNoFloor"; ns: number; cfg: number}`, written by epoch migration (§8.2) |
| ns and cfg fold state records | Carry `replay` (V2 encoding) |
| `StreamRecord.cls` | Accepts `"keyring"` |
| `tail` for `k` | Holds `k` records like any stream. There is no snapshot, since `k` has no checkpoints |

No store or index is added or removed, so `upgrade()` (`src/engine/adapters/idbStorage.ts:465`) is unchanged.

### 18.4 Protocol (`src/protocol/*`)

```ts
// messages.ts — EngineInitConfig (:46) gains:
/** SECRET (keys): never logged or echoed. Buffers are transferred, and main keeps no copy (§6.3). */
readonly crypto:
  | { readonly suite: null; readonly creating: boolean }   // unpinned (§12.4): reads `k` only, writes nothing
  | { readonly suite: 0 }
  | { readonly suite: 1; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[] };

// UserCommand (:132) gains (all SECRET payloads, transferred):
| { readonly t: "enableE2ee"; readonly rk: Uint8Array }                       // creation path only (§15.1): genesis at head = 0
| { readonly t: "installKey"; readonly source: "qr"; readonly e: number; readonly k: Uint8Array }   // §12.1, §14.2 step 3
| { readonly t: "installKey"; readonly source: "rk"; readonly rk: Uint8Array }                      // §12.4, §13.3
| { readonly t: "pinSuite0"; readonly source: "link" | "create" }             // §12.4 (ii) / (iii): ok only if `k` is empty at head
| { readonly t: "revokeRekey"; readonly rk: Uint8Array }                      // §14.2; a new RK is generated on main

// EngineToMain (:187) gains:
| { readonly t: "keyringChanged"; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; // SECRET
    readonly records: readonly Uint8Array[]; readonly pending: number | null }   // main persists before replying
```

- `status.ts`: `EnginePhase` gains `"key-missing"`, already named in DESIGN §c.3. `StatusSnapshot` gains
  `e2ee: { suite: 0 | 1 | null; sealEpoch: number; keyMissing: "no-pin" | "no-key" | "revoked-epoch" |
  "encrypted-vault" | null; keyringSeen: boolean; creatable: boolean }`. There are no secrets in status.
  - `suite: null` is an unpinned device (§12.4).
  - `creatable` is true only for an engine started with `creating: true` that has read `VAULT_READY.head = 0` and
    an empty `k` (§15.1 step 3).
  - **The engine never sets a pin.** Main sets it from (i) `keyringChanged` after a verified key, (ii) and (iii)
    from a successful `pinSuite0` or `enableE2ee`. Main then restarts the engine with the pinned config.
  - `enableE2ee` and `pinSuite0 {source: "create"}` are refused unless `creatable`. `pinSuite0 {source: "link"}`
    is refused if `keyringSeen` or `k` is non-empty.
- **Persist-before-use.** The engine does not seal under a new epoch until main acknowledges `keyringChanged`
  (the result of the same rid). A crash can therefore never leave committed rows under a key no device stored.
- The RK and QR keys are generated and shown on main (UI). The worker never displays them, and main never logs them.

### 18.5 relay-wire.md

| Section | Change |
|---|---|
| §1 Model | Note that stream `k` (keyring) is client-defined and opaque to the relay, like every stream |
| §2.4 Enroll | "Any client-only key part of a setup link is stripped before `/enroll`" (DECISIONS D3) |
| §11.3 Blobs (:464, stale) | Rewrite to DECISIONS §5 row 11.3: opaque `^[0-9a-f]{64}$` addresses, no hash verification, R2 key `v/<vaultId>/<address>`, PUT overwrites, ≤ 10 MiB. Drop `X-YAOS-Content-SHA256` / `-Size` (server ask A1, A2) |
| §11.1 Limits | Note that suite-1 payloads are padded, so the client caps content at 1015808 bytes (§7.3) |

### 18.6 DESIGN.md diffs

```diff
 §b.1 Envelope (:43)
-  u8      cryptoSuite     0 = none (v1); 1 = reserved XChaCha20-Poly1305
+  u8      cryptoSuite     0 = none; 1 = AES-256-GCM (e2ee-design.md)
   …
   varuint flags           initial | adopted | deflate | fromDisk
+  varuint frameNo         ns/cfg: per-device counter ≥ 1 (§c.3); other kinds 0
   bytes   content         rest; deflate-raw (fflate) iff flags & deflate
-  - frames: `"yaos/f1" ‖ varstring vaultId ‖ varstring stream ‖ varstring clientFrameId`;
-  - checkpoints: `"yaos/c1" ‖ varstring vaultId ‖ varstring stream ‖ varuint coversSeq`.
+  - frames: `"yaos/f2" ‖ header ‖ vaultId ‖ stream ‖ deviceId ‖ clientFrameId`;
+  - checkpoints: `"yaos/c2" ‖ header ‖ vaultId ‖ stream ‖ coversSeq` (e2ee-design §7.2).
+- **Padding.** Suite ≠ 0: Padmé inside the AEAD, 256 B floor (e2ee-design §7.3).
-- **E2EE later.** Suite 1 swaps the `CryptoPort` only. No layout changes: blob addresses become `HMAC(vaultKey, hash)`.
+- **E2EE.** Suite 1 is specified in e2ee-design.md. Blob addresses are `HMAC(kAddr, sha256)`.

 §b.2 Streams: table gains   | `k` | keyring | k records (no envelope) | none | yes | any device |

 §c.3 Frame-level rules (:290)
+2a. **Replay window** (ns/cfg). frameNo `f` vs per-device (R, 64-bit bitmap): f = 0 malformed; f ≤ R−64 or a
+    set bit → `ignored/replay-*`, fold as empty. Update only after open and decode (e2ee-design §8.2).
-own ns frame `k` may be sent only when every own ns frame ≤ `k − NS_SEND_WINDOW` (32) is receipted;
+own ns frame with frameNo `f` may be sent only when every own frame with frameNo ≤ `f − NS_SEND_WINDOW` is receipted;

 §d.6 Ingest gate (:782) table gains rows:
+| `suite-downgrade`, `bad-padding`, `auth-failed` under a verified key | deterministic (as malformation) |
+| `auth-failed` under an unverified key | reader-dependent |
+| stale-epoch (e2ee-design §14.3) | ignored; ns/cfg fold as empty; bodies not quarantined |

 §d.7 Catch-up (:840)
+0. **Keyring.** Read `k` to head and settle keys (e2ee-design §11.3) before any other stream.

 §h Ports (:1399): replace the CryptoPort block with e2ee-design §18.1.

 §j.1 Blobs (:1657)
-  - Attachments ≤ `MAX_LOG_BLOB_BYTES` (8 MiB) ride stream `x:<sha256>` as `blobChunk` frames
+  - Attachments ≤ `MAX_LOG_BLOB_BYTES` (8 MiB) ride stream `x:<blobAddress>` as `blobChunk` frames
+- **GC.** Blobs are never deleted until the server has list and delete routes; then client mark-and-sweep (e2ee-design §10.4).

 §j.7 Diagnostics (:1766)
-  - recent events (… **hashed** paths),
+  - recent events (… paths hashed with `CryptoPort.diagHash`: HMAC(kDiag) under suite 1),
+  - never key material, recovery keys or setup links.
```

## 19. Asks for the server rewrite

Baseline: 7208184. No ask is on the hot path, and none adds cross-DO coordination.

| # | Ask | Why | Priority |
|---|---|---|---|
| A1 | Rewrite relay-wire §11.3 (:464) to DECISIONS §5 row 11.3: opaque `^[0-9a-f]{64}$` addresses, no hash check, R2 key `v/<vaultId>/<address>`, PUT overwrites | The doc still describes sha256 addresses that the server verifies | Doc, before WP-E6a |
| A2 | Drop `X-YAOS-Content-SHA256, X-YAOS-Content-Size` from `CORS_EXPOSE_HEADERS` (`server/src/http.ts:7`) | Stale names for plaintext-revealing headers. Nothing sets them, but they invite reintroduction | Trivial |
| A3 | `GET /vault/:id/blobs?cursor=` → `{items: [{address, uploadedAt}], next}` (R2 `list` with prefix `v/<vaultId>/`), and `DELETE /vault/:id/blobs/:address?ifUploadedBefore=<ms>` (R2 `head` then `delete`). Device bearer. Cold path, low rate limit | Blob GC (§10.4). Without it, blobs live until the vault is deleted, under any suite | Before WP-E6b |
| A4 | `POST …/blobs/exists`: answer `400` on a malformed entry instead of silently dropping it (`server/src/router.ts:624-650` filters with `BLOB_ADDRESS_PATTERN`) | A client bug in HMAC addressing would look like "absent" and cause re-uploads forever | Low |
| A5 | Keep restore carrying the pre-restore device rows (already true, DECISIONS D8b "Crosses the rewind: the device rows only") | A revoked device must stay revoked after a restore (§14.3) | Confirm only |
| A6 | Keep minting a fresh random epoch on reset and restore (already true, D8, D8a, D8b) | The client re-publishes `k` on a new epoch (§11.5) | Confirm only |
| A7 | *(withdrawn)* Neutral device names. Already accepted: any string, de-duplicated by `uniqueDeviceName` (`server/src/vault/host.ts:544`) | | None |
| A8 | Rename "vault key" in `server/src/vault/ticket.ts` (DECISIONS D4) to "ticket key" in code and docs | Avoids confusion with K_e in reviews and in incident response | Low |
| A9 | Keep stream names opaque: no server-side meaning for `k` or any prefix (`server/src/streams/protocol.ts:16`, `:53`) | `k` needs no server change | Confirm only |
| A10 | Keep `MAX_STREAM_CHECKPOINT_BYTES` (`server/src/streams/protocol.ts:25`, 4 MiB) and the 1 MiB frame cap stable, or announce changes in VAULT_READY limits | Suite-1 padding is computed against them (§7.3) | Confirm only |
| A11 | *(conditional)* Let the plugin's creation path (§15.1) reach `/claim`, `/operator/login`, `/operator/vaults` and `/operator/vaults/:id/owner-code`. Today they demand a same-origin `Origin` (`server/src/router.ts:117-127`). For example, accept a JSON request with **no** `Origin` header, which browsers always send on such POSTs | Only if E5 finds that Obsidian's `requestUrl` cannot send `Origin: <host>`. Without it a device cannot create a vault, so no vault can be set up | Before WP-E5, if needed |

Not asked: a device-list route for clients (the console covers revoke, D7); server-side key storage of any kind;
per-vault crypto flags on the server (the suite is client-pinned, §12.4).

## 20. Test plan

### 20.1 Known-answer tests (WP-E1)

- **Published vectors**, run under Node WebCrypto and headless Chrome (the spike harness):
  - AES-256-GCM: GCM spec test case 16 [GCM-spec] (already in `src/host/spike/cryptoProbe.ts`);
  - HKDF-SHA-256: RFC 5869 A.1–A.3 [RFC5869];
  - HMAC-SHA-256: RFC 4231 TC1–TC7 [RFC4231].
- **YAOS golden vectors**, committed as hex:
  - inputs: fake key `K = 00 01 … 1f`, vaultId `AAAAAAAAAAAAAAAAAAAAAA`, and a seeded `RandomPort` for nonces;
  - outputs: each subkey's kcv, kAddr of a fixed hash, one frame per envelope kind, one checkpoint, one blob,
    genesis/roll/revoke records, an RK encode/decode, and a setup link.
  - **Cross-checked by a second implementation** in the test: Node `node:crypto` (`createCipheriv`, `hkdfSync`,
    `createHmac`), not WebCrypto, so one implementation's bug cannot certify itself.
- Codec property tests: Padmé round-trip and bucket monotonicity, varuint and base32 round-trips, and
  canonical-encoding rejection (as in WP-A).

### 20.2 Tamper, replay and downgrade (measured, WP-E7)

Each test counts outcomes and asserts **all** of them; none samples a single case.
- **Bit flips.**
  - For every sealed type (frame, checkpoint, blob, k wrap), flip each byte of header, nonce, ciphertext and tag:
    every byte for objects ≤ 4 KiB, and 4096 seeded positions otherwise.
  - Assert `failures == flips`, with the expected reason per region: header → `auth-failed` or `malformed`; tag or
    ciphertext → `auth-failed`.
- **AAD substitution.** Change each bound field in turn (vaultId, stream, deviceId, clientFrameId, coversSeq,
  address, keyEpoch, suite, role) and assert `auth-failed`, 100%.
- **Cross-type confusion.** Open a frame as a checkpoint, a blob as a frame, a `next` wrap as `prev`: all fail.
- **Replay (sim relay in hostile mode).** Re-append recorded genuine ns and cfg frames as new rows, at ages of 1,
  63, 64, 65, 1000 and 10⁵ own frames. Assert the fold digest is identical to a run without the replays, over 1000
  seeds, and that events `ignored/replay-*` or `duplicate-frame` account for every injected row.
- **Re-attribution.** Rewrite a row's deviceId: `auth-failed`, 100%.
- **Downgrade.**
  - Inject suite-0 rows into a suite-1 vault: every one is `suite-downgrade`, and the folds are unchanged.
  - **Hidden `k`, key-less join.** Hide `k` from a fresh device that joins with a key-less code, including the
    console's link and its `/mobile-setup` QR, at `head = 0` and at `head > 0`. Each must end in `key-missing` with
    `"no-pin"` and zero writes: no frame on any stream, no blob PUT, no checkpoint, no outbox record, no ns entry.
    The only actions offered are "Enter recovery key" and "Scan QR from one of your devices".
  - **The pin never comes from the server.** Count every path that sets a pin. Over all key-less-join seeds, a
    suite-0 pin and `creatable` occur 0 times.
  - **Suite-0 link after a genesis.** After an unpinned device has read a `k` genesis, the server hides `k` and a
    `suite=0` link arrives: refused (`keyringSeen`), and nothing is written.
  - **Creation path.** Step 1 returns a vault with `head > 0` or a non-empty `k`: abort, no pin, no write. A
    `creating` marker for another vaultId is ignored. The protocol handler cannot reach the flow.
  - **Unverified key.** A QR key with no matching `k` record leaves the device unpinned, and nothing is
    persisted.
  - A suite-0 device that sees a `k` genesis stops with `"encrypted-vault"` and issues no seal.
- **Stale epoch.** After a revoke, inject old-epoch frames sealed with K_{r−1}: all ignored, no quarantine, and
  the fold digest is unchanged.
- **Keyring forgery.** Garbage records, a roll for r forged with K_{r−1} after a revoke (§11.3), and duplicate
  records: no device adopts a wrong key.

### 20.3 Simulation with suite 1 (WP-E7)

- `SimConfig.crypto: "none" | "suite1"`. Suite 1 uses the real adapter on Node WebCrypto, wrapped in
  `DelayedCrypto` (§16.3).
- **The existing fault matrix runs unchanged under suite 1**, with the same seed counts as suite 0
  (`src/sim/faults.ts:32-48`). The invariants (`src/sim/invariants.ts`) must hold.
- **New faults:**
  - `keyStoreLoss {dev}`: SecretStorage wiped, so the device goes `key-missing`, then re-keys by a sim QR;
  - `keyRoll {dev}`: forced roll, including concurrent rolls on two devices;
  - `revoke {dev, by}`: console revoke, then re-key;
  - `epochRestore`: PITR-like rewind plus a new epoch, so `k` must be re-published;
  - `hostileReplay`, `hostileDowngrade` (suite-0 rows, and `k` hidden from key-less joins, §20.2).
- **Leak checks in sim:** the relay sees only bucketed payload sizes (§7.3), and no stream name contains a
  plaintext hash.
- **At-rest leak check (desktop, WP-E4):** after an integration run, grep the IndexedDB LevelDB, `data.json`,
  the diagnostics bundle and the logs for every key and the RK in hex and base64url. Expect zero hits (the same
  method found Chrome's plaintext CryptoKey bytes, §3).

## 21. Work packages

There is one agent per package. Sizes: S ≈ 1 agent-day, M ≈ 2–3, L ≈ 4–6. Every package passes
`npm run -s typecheck:client`, `node scripts/check-deps.mjs` (0/0) and `npm run test:client`.

| WP | Scope (owned paths) | Depends on | Done when | Size |
|---|---|---|---|---|
| **E0** Device runs | `src/host/spike/**`: add a SecretStorage probe (set/get/restart, 64 KiB value, `""`, locked device) and an Android `obsidian://` QR scan check (iOS is [User]-confirmed, §23.3) | none (needs a human with devices) | §23.3 open rows filled with [M] rows | S |
| **E1** CryptoPort + suite-1 adapter | `src/ports/crypto.ts` (§18.1), `src/engine/adapters/webCryptoSuite1.ts`, `noopCrypto.ts`, `identityCrypto` | none | §20.1 KATs and golden vectors pass under Node WebCrypto and the `node:crypto` cross-check; 12-byte nonce check; non-extractable keys only | M |
| **E2** Envelope v2 | `src/core/envelope.ts`, `src/core/codec/**` (AAD v2, Padmé, frameNo, fold V2 encodings), `src/core/{ns,cfg}/**` (replay window), `src/core/limits.ts`, the send window over frameNo, `diagHash` in `runtimeOps.ts:150-153` | E1 shape | Codec round-trips; replay window unit tests including the §8.2 exactness argument as a property test; suite 0 still passes the whole suite | M–L |
| **E3** Keyring engine | `src/engine/keyring/**` (record codec, validity, winners, roll, revoke, re-publish, stale-epoch), the catch-up order (`k` first), phase `key-missing` | E1, E2 | §11 and §14.3 rules as unit tests; the forged-roll and duplicate-record tests in §20.2 | L |
| **E4** Host key storage + protocol | `src/host/keys/**` (SecretStorage adapter, 5 s wait, pin incl. unpinned and `keyringSeen`, Linux notice), `src/protocol/**` (§18.4: unpinned config, `pinSuite0`), persist-before-use; the engine's unpinned mode (reads `k` only) | E1 shape | Restart keeps keys; IDB wipe keeps keys; at-rest leak check (§20.3) is zero; an unpinned engine issues zero writes | M |
| **E5** Pairing, RK, revoke UX | `src/host/ui/**`: QR (`qrcode`), the `key`/`suite` link parameters stripped before `/enroll`, the blocked key-less screen (§12.4), the "Create a new vault" creation path with its `Origin` check first (§15.1), RK show/confirm/enter, revoke re-key, re-key QR, hiding `mobileSetupUrl` under both suites, device-name hint | E3, E4 | UI tests for each flow; `/enroll` request bodies asserted key-free; the link is never in logs; no path from a link, code or console QR reaches the creation flow or a suite-0 pin | L |
| **E6a** Blob addressing and format | `src/engine/body/frames.ts` blob path, `src/engine/blobs/blobQueue.ts`, `src/engine/body/refs.ts`, `src/engine/runtime/blobChunks.ts`, `blobChunkStream(address)` | E1, E2 | Sealed-blob golden vector; dedupe via `has`; `x:` names carry no hash | S |
| **E6b** Blob GC | `src/engine/blobs/gc.ts`, `BlobPort.list/deleteIf` | **A3** | Mark-and-sweep against a sim blob store with races (re-upload during the sweep survives) | M |
| **E7** Verification | `DelayedCrypto`, sim `crypto: "suite1"`, new faults, the §20.2 measured tests, a perf bench against the §16 budgets | E1–E3 | The suite-1 fault matrix is green at suite-0 seed counts; every §20.2 assertion holds | M |
| **E8** Docs | Apply §18.5 and §18.6 to relay-wire.md and DESIGN.md | E2 merged | Docs match the code | S |

Order: E0 ∥ E1 → E2 ∥ E4 → E3 ∥ E6a → E5 ∥ E7 → E8. E6b waits for A3.

## 22. Decisions (resolved)

The user decided all eight on **2026-10-07**, each by the recommended option. Nothing in this document is pending
on them.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | How kept devices get the new key after a revoke | **(a) Manual re-key by QR or RK on each device.** No automatic ECDH key distribution | Revocation is rare. ECDH would need a device PKI and X25519 in mobile WebViews **[U]** |
| D2 | Encryption for new vaults | **(a) On by default. Opt-out only on the creation path** (§15.1); never on a join (§12.4) | Turning it on later means a new vault (§15.2), so the RK ceremony belongs at setup |
| D3 | Padding | **(a) Padmé with a 256 B floor** | ≤ 12 % overhead and hides keystroke-sized frames. A 1 KiB floor costs about 4× bytes on typing frames for little gain |
| D4 | Deep rotation of kAddr on revoke | **(a) No, for now. (b), an optional "Deep re-key" command (re-upload all blobs; needs A3), later** | A revoked device already has the files. The gain is only recognising re-uploads |
| D5 | Pairing transport | **(a) QR or link with the key in a client-only parameter** (§12.1) | Same trust root as SAS, with no protocol. The iOS camera hand-off is [User]-confirmed (§3); SAS/ECDH stays the upgrade path if Android fails |
| D6 | Device names under suite 1 | **(a) Keep the platform default ("iPhone") plus a "visible to the operator" hint** | Neutral by default; the console still needs a usable name for revoke |
| D7 | Migrating an existing vault, or turning encryption off | **(a) Create a new vault, then delete the old one** (§15.2) | Reset keeps plaintext blobs in R2 (D9); in place saves nothing real |
| D8 | Recovery key at revoke | **(a) Ask for the existing RK, with "generate a new one" as an option** | Fewer ceremonies; a new RK is offered when the RK is lost or leaked |

Also decided by the user on 2026-10-07, outside this table:
- **Downgrade.** Fail closed (§12.4). There is no "Continue unencrypted", and a device with no pin writes nothing.
- **Recovery.** The server never parses note content and has no backup alarm. Backups are the client snapshot
  exporter (sealed blobs plus the `snap` index stream) or operator PITR (§17).

## 23. Spike: verified vs needs a device

### 23.1 How to run

- Build: `node scripts/build-spike.mjs --out <path>/yaos-spike.zip`. The script smoke-checks the bundle in Node:
  the CJS plugin loads against a stub `obsidian`, and the worker IIFE answers ping, probe and crypto inside
  `node:vm`. It copies the zip only if every check passed.
- The artifact for this design is `experiments/yaos-spike.zip`, sha256
  `711d1b1b5f6e4facb474f57dcea2b115cfd99d0d0def6032573a673530046d78`. It contains `yaos-spike/main.js` (64621 B)
  and `manifest.json`.
- Install the `yaos-spike` folder into a **throwaway** vault's plugins directory, then run the command "Run E2EE
  crypto probes only" (`run-e2ee`, `src/host/spike/main.ts:36`). The report modal can be copied, and the report is
  also saved.
- Unit tests: `npm run test:client -- spike` (`src/host/spike/cryptoProbe.test.ts` and others).
- The spike code is commit e8503d8. It is throwaway and never ships.

### 23.2 Verified

| Claim | Where | Evidence |
|---|---|---|
| WebCrypto AES-GCM / HKDF / HMAC / `getRandomValues` inside a Blob-URL worker | Chrome 154 headless (macOS), Node 26.5, Node `vm` worker smoke | [M] |
| KATs: GCM TC16, RFC 5869 A.1, RFC 4231 TC2 | Node, Chrome 154 | [M] |
| Tamper, wrong AAD and wrong nonce all reject | Node, Chrome 154 | [M] `cryptoProbe.test.ts:50-59` |
| Non-extractable import and derive; the export is refused | Node, Chrome 154 | [M] |
| A CryptoKey in IDB survives a restart, **and its raw bytes are plaintext on disk** | Chrome 154 profile directory | [M] grep, plus [S] Chromium source (§3) |
| WKWebView accepts a 0-byte GCM IV | macOS WKWebView harness (`capacitor://localhost`) | [M] |
| Throughput and per-call cost | Chrome, macOS WKWebView, Node | [M] (§3, §16) |
| @noble/ciphers XChaCha is 8–13× slower | Chrome, WKWebView | [M] |
| `qrcode` 1.5.4 adds 9.6 KB gzip | esbuild bundle of a minimal QR-to-canvas call | [M] |
| SecretStorage API shape; desktop safeStorage with a plaintext fallback; mobile `SecureStorage` key shared across vaults | `obsidian.d.ts`, `obsidian-1.14.4.asar` (read-only) | [S] |

### 23.3 Confirmed by the user, and still needing a device (WP-E0)

**[User] confirmed 2026-10-07.** The user stated these. The spike did not measure them and no source was read for
them here, so they are tagged [User], not [M] or [S].

| Fact | Used in |
|---|---|
| `app.secretStorage` exists since Obsidian 1.11.4, and the plugin's `minAppVersion` is 1.13.0 (`manifest.json:5`) | §3, §6.1 |
| Mobile `SecureStorage` is backed by the iOS Keychain | §3, §6.1 |
| `crypto.subtle` works on Obsidian iOS, because WKWebView treats `capacitor://localhost` as a secure context | §3, §4 |
| The stock iOS Camera (iOS 11+) recognises a QR holding an `obsidian://` deep link and offers to open Obsidian | §3, §12.1, D5 |

**Still open (WP-E0).** These need a human with devices, which is outside E1 and E2:

| Platform | Run | Open question |
|---|---|---|
| Obsidian iOS (WKWebView) | `run-e2ee` in the worker and on main | Throughput vs §16; zero-IV behaviour as on macOS |
| | SecretStorage probe | Is the Keychain item readable while the device is locked (background sync)? Value size limit (try 64 KiB)? Is `""` accepted? Does it survive app restart and update? |
| | Camera app scanning an `obsidian://` QR | Do the parameters arrive intact? (The hand-off itself is [User].) |
| Obsidian Android (System WebView) | Same three runs | Keystore-backed? Camera / Google Lens handling of custom schemes; low-end phone throughput |
| Obsidian desktop (Electron) macOS, Windows | `run-e2ee`, SecretStorage probe | safeStorage availability; throughput (expected ≈ Chrome) |
| Obsidian desktop Linux, with and without a keyring | SecretStorage probe | Plaintext fallback and `msgSecretsNotEncrypted` as read in the asar |
| Obsidian `requestUrl`, desktop and mobile | Send `POST /claim` with `Origin: <host>` | Is the header sent as set? (§15.1; server ask A11 if not) |
| Cloudflare (not a device) | Restore after `deleteAll()` | Can PITR bring back a deleted vault's rows (§15.2)? Not stated in [CF-PITR] |

The Obsidian app binary was never launched for this design. Every Obsidian fact above is [S] from read-only files,
[User], or [U].

## 24. References

- [GCM-spec] D. McGrew, J. Viega, "The Galois/Counter Mode of Operation (GCM)", NIST modes submission (rev. 2005),
  Test Case 16. The canonical NIST URL has moved **[U]**. The vector is reproduced in
  `src/host/spike/cryptoProbe.ts:64` and passes under two independent implementations.
- [RFC5869] HKDF. https://www.rfc-editor.org/rfc/rfc5869
- [RFC4231] HMAC-SHA-2 test vectors. https://www.rfc-editor.org/rfc/rfc4231
- [RFC4303] IPsec ESP, anti-replay window §3.4.3. https://www.rfc-editor.org/rfc/rfc4303
- [RFC9771] Properties of AEAD algorithms, §4.3.3. https://www.rfc-editor.org/rfc/rfc9771#section-4.3.3
- [WebCrypto] W3C Web Cryptography API (editor's draft; section numbers as read for this design).
  https://w3c.github.io/webcrypto/
- [w3c-webcrypto-73] Streaming encryption, an open issue. https://github.com/w3c/webcrypto/issues/73
- [NIST-GCM] NIST SP 800-38D (2007). https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
- [NIST-GCM-rev] NIST SP 800-38D Rev. 1 drafts. https://csrc.nist.gov/pubs/sp/800/38/d/r1/iprd
- [CFRG-limits] draft-irtf-cfrg-aead-limits-13. https://www.ietf.org/archive/id/draft-irtf-cfrg-aead-limits-13.txt
- [XChaCha-03] draft-irtf-cfrg-xchacha-03 (expired). https://www.ietf.org/archive/id/draft-irtf-cfrg-xchacha-03.txt
- [noble] @noble/ciphers README, L366-388 and L454-515 @fe43367.
  https://github.com/paulmillr/noble-ciphers/blob/fe4336756e8b352ea520d8bd6e8547552e352189/README.md
- [Cure53-NBL] Cure53 audit of the noble crypto libraries. https://cure53.de/audit-report_noble-crypto-libs.pdf
- [LGR21] Len, Grubbs, Ristenpart, "Partitioning Oracle Attacks", USENIX Security 2021.
  https://www.usenix.org/conference/usenixsecurity21/presentation/len
- [DGRW18] Dodis, Grubbs, Ristenpart, Woodage, "Fast Message Franking: From Invisible Salamanders to Encryptment",
  CRYPTO 2018. https://eprint.iacr.org/2019/016
- [ADGKLS22] Albertini, Duong, Gueron, Kölbl, Luykx, Schmieg, "How to Abuse and Fix Authenticated Encryption
  Without Key Commitment", USENIX Security 2022. https://eprint.iacr.org/2020/1456
- [Padmé] Nikitin, Barman, Lueks, Underwood, Hubaux, Ford, "Reducing Metadata Leakage from Encrypted Files and
  Communication with PURBs" (Padmé, ≤ 12 % overhead, O(log log M) leakage). https://arxiv.org/abs/1806.03160
- [CF-PITR] Cloudflare Durable Objects SQLite storage API, "PITR (Point In Time Recovery) API" (30 days; silent on
  `deleteAll()`). https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- [WebKit-177350] IndexedDB index queries with CryptoKey values. https://bugs.webkit.org/show_bug.cgi?id=177350
- Chromium `components/webcrypto/algorithm_implementation.cc` L125-131 @39d5b374.
  https://chromium.googlesource.com/chromium/src/+/39d5b374831be4c1e548ad822b71f3a60216a885/components/webcrypto/algorithm_implementation.cc#125
- WebKit `SerializedCryptoKeyWrapCocoa.mm`, `WorkerGlobalScope.cpp`, `SecurityOrigin.cpp` @55d19429 (lines in §3).
- Server: `docs/server-rewrite/DECISIONS.md` and `server/src/**` at 7208184 (lines inline).
