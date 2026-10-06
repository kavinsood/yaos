# YAOS client remake: crypto suite 1 (single-user E2EE)

Status: proposed, normative once accepted. Owner: architect. Extends [DESIGN.md](DESIGN.md); where this document
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
  - **[U]** unverified: needs a device or is not stated anywhere I could find.
- Terms:
  - **K_e**: the 32-byte vault key of key epoch `e` (`e ≥ 1`). "Vault key" in `server/src/vault/ticket.ts` (DECISIONS D4) is the relay's
    ticket-signing key and is unrelated (server ask A8).
  - **keyEpoch** (this document) vs **vaultEpoch** (the relay generation, DESIGN §c.12). They are independent.
  - **RK**: the recovery key (§13). **k**: the keyring stream (§11).
  - **S_rot**: the seq at which a revoke-kind keyring record committed (§14).

Contents: [1](#1-summary) summary · [2](#2-threat-model) threat model · [3](#3-platform-facts) platform facts ·
[4](#4-cipher) cipher · [5](#5-key-hierarchy) keys · [6](#6-key-storage) storage · [7](#7-envelope-v2-aad-and-padding)
envelope · [8](#8-replay-and-reorder) replay · [9](#9-what-is-sealed-and-open-failures) failures ·
[10](#10-blobs) blobs · [11](#11-keyring-stream-k) keyring · [12](#12-pairing) pairing · [13](#13-recovery-key)
recovery · [14](#14-rotation-and-revocation) rotation · [15](#15-enable-migrate-disable) enable/migrate ·
[16](#16-performance-budget) performance · [17](#17-lost-server-features) lost features ·
[18](#18-shape-changes-and-design-diffs) shape changes · [19](#19-asks-for-the-server-rewrite) server asks ·
[20](#20-test-plan) tests · [21](#21-work-packages) work packages · [22](#22-decisions-for-the-user) decisions ·
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
   carries no key. The **recovery key** (56 Crockford base32 characters) handles the all-devices-lost case.
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
- **The user is the trust anchor** for the vault's suite: §12.4 covers downgrade by a lying server.

### 2.2 Metadata: mitigated vs accepted

| Metadata | Status | How |
|---|---|---|
| Note, folder and attachment names; paths; tree shape | **Mitigated** | Only in sealed ns frames. docIds are 16 random bytes. |
| File contents and settings | **Mitigated** | Sealed. |
| Attachment equality with a known file | **Mitigated** | The address is `HMAC(kAddr, sha256)`, not sha256. `x:` stream names use the same address (§10.1). |
| Exact frame, checkpoint and blob sizes | **Mitigated (bucketed)** | Padmé leaks O(log log M) bits per size, with ≤ 12 % overhead [Padmé] (§7.3). |
| Plaintext sha256 and size in HTTP headers | **Mitigated** | The client never sends `X-YAOS-Content-*`. Server ask A2 removes them. |
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
| `app.secretStorage` exists (`setSecret`/`getSecret`/`listSecrets`, synchronous; ids lowercase alphanumeric plus dashes; no delete) | **[S]** `obsidian.d.ts:458`, `:5635` (npm `obsidian` 1.13.1); `@since 1.11.4`; plugin `minAppVersion` 1.13.0 | |
| Desktop SecretStorage uses Electron `safeStorage`. Without OS encryption it stores **plaintext** and warns (`msgSecretsNotEncrypted`) | **[S]** `obsidian-1.14.4.asar`, bytes ~3571300–3572700 (read-only); same in 1.13.7 | Linux without a keyring: plaintext |
| Mobile SecretStorage uses the Capacitor plugin `SecureStorage` under the bare key `"secrets-encrypted"`, so it is shared across vaults | **[S]** same asar (mobile adapter); that it is backed by Keychain/Keystore **[U]** (inferred from the name) | Namespace ids per vault (§6.1) |
| `crypto.subtle` requires a secure context; custom schemes count as secure in WebKit; a worker inherits it | **[S]** [WebCrypto] §10; WebKit `SecurityOrigin.cpp` L101-102, `WorkerGlobalScope.cpp` L204-210 | Obsidian iOS origin `capacitor://localhost` **[U]** |
| No streaming AEAD in WebCrypto | **[S]** [w3c-webcrypto-73] | Blobs ≤ 10 MiB are sealed in one call (§10.3) |
| Obsidian mobile WebViews and desktop Electron behave like the above | **[U]** | §23.3 lists the device runs |

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
  take `extractable:false` explicitly (§14.3.7).
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
  - Value size limits **[U]**.
- **NEVER persist a key in IndexedDB.** Chromium writes stored CryptoKeys' raw bytes in plaintext **[M]**. WebKit
  adds keychain IPC, lock-state failures and an index bug (§3).
- **NEVER persist a key in `data.json`** (`<configDir>/plugins/yaos/data.json`). Folder sync and backup tools copy
  the config dir.
- **NEVER put keys or RK in** logs, `StatusSnapshot`, `DiagnosticsBundle`, `Error` messages, notices or the URL bar.
  Protocol fields that carry keys are marked SECRET, like `relay.credential` (`src/protocol/messages.ts:56`).
- **The suite pin** (`e2ee: { suite: 1 }`, not secret) lives in `data.json` next to the device token. If the pin
  says 1 and the secret is missing, the device enters phase `key-missing`: re-key by QR or RK.
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
| `data.json` | Survive, but are orphaned | Re-enroll: new device token and new deviceId. Re-key by QR or RK. |
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
| address (blobs) | The server cannot serve one blob's bytes at another address. The reader also checks sha256 after opening (`src/engine/body/refs.ts:58-59`). |

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

| Server action | ns / cfg | body / canvas | x: chunks | checkpoints | k |
|---|---|---|---|---|---|
| Re-commit an old frame's exact bytes as a new row | **Rejected**: clientFrameId ring (DESIGN §c.3) plus the frameNo window (§8.2) | Harmless: a Yjs update whose structs are known is a no-op | Duplicate index, ignored (DESIGN §j.1) | n/a | Later duplicates lose (first valid wins, §11.3) |
| Re-attribute to another device or stream | Rejected by the AAD (§7.2) | same | same | same (stream) | same |
| Reorder concurrent frames | Accepted. The relay owns the order; frameNo accepts any legitimate reorder (§8.2) | CRDT | by index | n/a | first in seq wins |
| Serve an older checkpoint, withhold rows | Accepted (§2.3) | Accepted | Accepted | Accepted | Withholding k blocks new epochs (DoS only) |
| Fork: different views per device | Accepted (§2.1 non-goal) | | | | |

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
  - every relay payload (`ns`, `cfg`, `b:`, `c:`, `x:`);
  - every checkpoint;
  - every blob: attachments, oversize body updates behind `bodyUpdateRef`, and uploaded snapshot zips
    (`src/engine/snapshots/snapshotJob.ts:129-130`);
  - the key material inside `k` records (§11).
- **Visible to the server:**
  - stream names: `b:`/`c:` + a random docId, `x:` + a keyed address, plus `ns`, `cfg`, `k`;
  - deviceId and clientFrameId (both random);
  - the outer envelope header (format, suite, keyEpoch);
  - `k` record headers;
  - deviceName;
  - HTTP metadata.
- **Suite pin.** The CryptoPort instance *is* the device's pin (§6.1, §12): a suite-1 port knows the vault is
  encrypted.

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
- **New phase `key-missing`** (`EnginePhase`, §18.4). It has two causes:
  - the ns/cfg fold halted on a key it does not have;
  - `k` shows an epoch above every key this device holds (a revoke it was left out of).

  The device is read-only: it seals nothing, and its outbox is held. The status names the remedy: "Scan a re-key
  code from another device, or enter the recovery key".

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
     unresolved `bodyUpdateRef`s, kept uploaded snapshots, and the local blob queue.
  2. Page through `GET /vault/:id/blobs` (A3), which returns addresses and upload times.
  3. For each address that is not live and was uploaded more than 7 days ago, call
     `DELETE /vault/:id/blobs/:addr?ifUploadedBefore=<ms>` (A3).
     - The condition is checked against the R2 object's upload time, so a concurrent re-upload (PUT refreshes it)
       survives.
     - The grace period covers the gap between a put and the ns frame that references it (DESIGN §j.1 "only after
       the put succeeds").
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
- **Genesis position.** Enable writes the genesis record when `VAULT_READY.head = 0` (§15). Readers do not rely on its
  position: validity alone decides.

## 12. Pairing

### 12.1 Pick: a plugin-drawn QR carrying the key in a client-only link

```
obsidian://yaos?action=setup&host=<host>&pairingCode=<vaultId.secret>&key=<b64url(u8 1 ‖ varuint e ‖ K_e)>
```

1. The paired device calls `POST /vault/:id/auth/pairing-code` (DECISIONS §2.2), as today.
2. It builds the link locally, extending `buildSetupLink` (`src/host/ui/pairing.ts:456`).
   - `key` holds the newest winning epoch and its key: 1 + 1 + 32 bytes, 46 base64url characters.
   - Older keys come from the `prevWrap` chain (§11.1).
   - The vaultId is already inside the pairing code (DECISIONS D3).
3. The plugin draws the QR itself, with `qrcode` 1.5.4 (+9.6 KB gzip **[M]**, §23).
4. The new device scans it. Obsidian hands the parameters to `registerObsidianProtocolHandler`
   (`src/host/ui/registerUi.ts:136`). `parseSetupLink` accepts `key` (it joins `SETUP_LINK_KEYS`, `pairing.ts:465`).
5. **The key is stripped before `/enroll`.** DECISIONS D3 requires exactly this: "A future client-only key part
   must be stripped before `/enroll`". The key goes into the pending identity, in memory only. After enroll, the
   device reads `k`, checks kcv and walks the chains (§11.3). It then persists the keys and the suite pin.

Rules:

- **NEVER put a key in any URL the server serves**, including the fragment of `GET /mobile-setup`.
  - That page is a static Worker response whose JS reads `location.hash` (`server/src/console/mobileSetup.ts:47`).
  - Its `connect-src 'none'` CSP is set by the same server, so it is no guarantee.
  - Under suite 1 the pair modal hides `mobileSetupUrl` (`src/host/ui/pairModal.ts:192`).
- **The link is a secret.** It is shown only after an explicit "Show pairing QR" click and hidden when the code
  expires (15 min, DECISIONS D3) or the modal closes. It is never logged.
  - "Copy setup link" stays, for phone → desktop and for desktops without a camera, with a warning: "This link
    contains your vault key. Send it only over a channel you trust (AirDrop, a cable), never a chat app."
- **Opening an `obsidian://` QR from the stock camera is [U]** on iOS and Android (§23.3). Fallbacks, in order:
  1. the copied link;
  2. pair with the code alone, then enter the recovery key (§12.4).
- Alternative: SAS or ECDH pairing, where the new device and the old one agree a key through the relay and the
  user compares a short code (decision D5). Rejected for v1:
  - it needs an interactive two-device protocol over relay streams, with its own state machine and timeouts;
  - X25519 support in mobile WebViews is **[U]**;
  - a QR has the same trust root (the user's eyes on both screens) with no protocol.
- Alternative: in-plugin QR scanning. Rejected: camera permission inside Obsidian mobile is **[U]**, and it needs
  a QR decoder dependency.

### 12.2 Enroll from the operator console

The console mints owner codes (DECISIONS D5, `POST /operator/vaults/:id/owner-code`). Its page and QR are served by
the server, so they can never carry the key. A device paired this way follows §12.4: it needs the recovery key.

### 12.3 Device name

- deviceName is plaintext on the server, shown in the console and stored in device rows
  (`server/src/vault/host.ts:544`).
- The default is already a platform label such as "iPhone" or "Mac" (`src/host/ui/deviceName.ts`). The server
  de-duplicates repeats (`uniqueDeviceName`, `host.ts:544`).
- Under suite 1 the pair modal shows a hint next to the name field: "Visible to the server operator". No server
  change is needed (decision D6).

### 12.4 Key-less links and downgrade

A link or code without `key` may lead to an encrypted vault (owner code, or the user typed the code). The server
cannot be trusted to say which (§2.1), so **the user decides**:

> This setup link has no encryption key.
> If this vault is end-to-end encrypted, enter its recovery key or scan a pairing QR from one of your devices.
> [Enter recovery key] [Scan QR instead] [Continue unencrypted]

- "Continue unencrypted" pins suite 0. If `k` later shows a genesis record, the device stops with "This vault is
  encrypted" (phase `key-missing`) and seals nothing.
- A suite-1 device treats every suite-0 row as a deterministic malformation (`suite-downgrade`, §9.2). A server
  that hides `k` and shows suite-0 rows cannot make a pinned device accept plaintext.
- **Residual risk.** A user who picks "Continue unencrypted" for a vault the server hides as empty writes
  plaintext. This is the cost of having no server-side truth. The default focus is "Enter recovery key".

## 13. Recovery key

### 13.1 Format

- `RK = 32 random bytes ‖ first 3 bytes of SHA-256(those 32)`: 35 bytes.
- Crockford base32 gives 56 characters, shown as `YAOS-RK1-` plus 14 groups of 4, e.g.
  `YAOS-RK1-0000-0000-…` (fake).
- Decoding ignores case, dashes and spaces, and maps `I`/`L` to `1` and `O` to `0`.
- The 24-bit checksum catches typos before any crypto: 1 in 16.7M misses.
- KEK_RK = HKDF(RK[0..32]) (§5.1). The key has full entropy, so no password KDF is needed.

### 13.2 Lifecycle

- **Created** at enable (§15), on the enabling device.
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
2. On a new device: Pair → the owner code → the key-less prompt (§12.4) → "Enter recovery key".
3. The device enrolls (the RK is never sent anywhere), reads `k` to head, and unwraps the newest genesis or revoke
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
  is closing the "recognise a re-upload" leak. Recommended: no. It is an optional "Deep re-key" command later.
- Alternative: re-seal all history under r on revoke. Rejected: the revoked device already holds the plaintext,
  so it gains nothing. It costs a full rewrite of the vault, i.e. rows and day budget.

## 15. Enable, migrate, disable

### 15.1 Enable: new vaults only

- Encryption is chosen **when the first device pairs to a new vault**, i.e. when `VAULT_READY.head = 0`
  (relay-wire §3.2). The pairing screen shows "End-to-end encryption: On" preselected (decision D2).
- Enable steps:
  1. generate K_1 and the RK;
  2. show the RK and require the retype confirmation (§13.2);
  3. append the genesis record to `k` as the vault's first frame, and hold every ns frame until it is receipted;
  4. persist the keys and the record (§6.1), then set the pin `e2ee: {suite: 1}`.
- `head > 0` with no genesis means the vault already has plaintext. Enable is refused with "Encryption can
  only be turned on for a new vault" and a link to §15.2.
- A crash before step 3's receipt leaves an empty vault. The retry regenerates everything; pending keys are dropped
  because the record never won.

### 15.2 Migrate an existing vault, or turn encryption off

Both mean **a new vault**:
1. In the console, "Create vault" (DECISIONS D5).
2. Pair this device to it with encryption On (or Off). The initial reconcile uploads every file from disk.
3. Pair the other devices with the QR (§12).
4. Delete the old vault in the console. Deletion runs `deleteAll()` and then purges the R2 prefix `v/<vaultId>/`
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
