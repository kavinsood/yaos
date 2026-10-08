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
  - **K_e**: the 32-byte vault key of key epoch `e` (`e ≥ 1`). The relay's ticket-signing key (`server/src/vault/ticket.ts`,
    DECISIONS D4) is unrelated; it was called "vault key" at 7208184 and is the "ticket key" since server ask A8 (f3ef81ba).
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
| Attachment equality with a known file | **Mitigated** | The address is `HMAC(kAddr, sha256)`, not sha256 (§10.1). |
| Exact frame, checkpoint and blob sizes | **Mitigated (bucketed)** | Padmé leaks O(log log M) bits per size, with ≤ 12 % overhead [Padmé] (§7.3). |
| Plaintext sha256 and size in HTTP headers | **Mitigated** | The client never sends `X-YAOS-Content-*`, and at 7208184 the server neither sets nor reads them. Server ask A2 dropped the stale CORS names (cd335f64). |
| Number of streams, i.e. roughly the number of notes plus canvases | Accepted | One stream per doc is the relay's cost model (relay-wire §11.4). |
| Stream class (`b:` vs `c:` vs `ns`/`cfg`/`k`) | Accepted | The relay's provisional broadcast keys on `b:`/`c:` (`server/src/streams/protocol.ts:52-54`). |
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
| No streaming AEAD in WebCrypto | **[S]** [w3c-webcrypto-73] | Each blob is sealed in one call, up to the relay's 100 MB cap (§10.3) |
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
  spec is inconsistent. Irrelevant here: the largest message is a blob under the relay's 100 MB cap (§7.3).
- **Rule: roll at 2^23.** A device starts a roll (§11.4) when either:
  - `headSeq − firstSeq(e) ≥ 2^23`, where `firstSeq(e)` is the seq of epoch e's winning `k` record; or
  - its own seal count under e reaches 2^22. This count is kept lazily in IDB meta and covers re-seals that
    never commit.

  Each subkey (kFrame, kCkpt, kBlob, kWrap) has its own budget. All of them see at most as many seals as frames
  committed (one per frame; at most one checkpoint or blob per frame), so one trigger covers all of them. Blob seals
  with no frame of their own (a refresh or repair PUT, `src/engine/blobs/touch.ts`) are in the own seal count: the
  write gate counts every seal, blobs included (`onSeal`, `src/engine/keyring/writeGate.ts:44-50`).
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
 from K_1 only (vault lifetime, never rotated), info I(purpose, 1):
     kAddr    HMAC-SHA-256  blob addresses                 purpose "addr"
     kDiag    HMAC-SHA-256  diagnostics hashes             purpose "diag"
RK         35-byte recovery key (§13)
 └ KEK_RK = HKDF-SHA-256(ikm = RK[0..32], salt = "yaos-hkdf-v1", info = I("recovery-kek", 0))   AES-GCM-256

I(purpose, e) = utf8("yaos/v1/" + purpose) ‖ 0x00 ‖ utf8(vaultId) ‖ 0x00 ‖ varuint e
```

- HKDF is from [RFC5869]. The base key is imported with `extractable:false` ([WebCrypto] §33.4.2), and derived keys
  take `extractable:false` explicitly ([WebCrypto] §14.3.7).
- Every subkey is 32 bytes: AES-GCM with `length: 256`, HMAC with `hash: "SHA-256", length: 256` (WebCrypto's HMAC
  default would be the 64-byte block size). The golden vectors (§20.1) pin this.
- Subkeys are derived **lazily** per epoch on first use and memoised (`src/engine/adapters/webCryptoSuite1.ts`). A
  normal session touches the newest epoch's set plus kAddr and kDiag: at most 7 `deriveKey` calls.
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
  - Id: `"yaos-" + hex(base64urlDecode(vaultId))`: the vaultId's 16 bytes in lowercase hex, 37 chars. SecretStorage
    ids must match `/^[a-z0-9-]+$/` and be at most 64 chars, and the vaultId's own case-sensitive base64url
    alphabet does not fit. Hex of its bytes does, with no hash: the main thread never hashes (DESIGN §d.2, §k.2). The
    id is per vault because the mobile store is shared across vaults (§3).
  - **Strict vaultId.** The client accepts a vaultId only if it is exactly 22 chars of canonical base64url (16 bytes;
    server/src/vaultId.ts `VAULT_ID_PATTERN`, DECISIONS §2.1; canonical means the 4 unused low bits of the last char are
    0, as the server's `randomBase64Url(16)` mints it). Canonical makes the id and its bytes one-to-one, so one secret
    id names one vault. The enroll response (`readEnrollment`), data.json (`sanitizeIdentity`, the creation marker) and
    `secretIdFor` all refuse anything else, untrimmed and unrepaired. The setup link never carries a vaultId
    (`parseSetupLink` rejects one), so neither the server nor the link can name another vault's secret.
  - Value: JSON `{ "v": 1, "vaultId", "suite": 1, "keys": [{ "e", "k": b64url(K_e) }], "records": [b64url(k record)] }`.
  - The records are kept so they can be re-published after a reset or restore (§11.5). They are not secret.
  - Value size limits **[U]** (WP-E0, §23.3).
- **NEVER persist a key in IndexedDB.** Chromium writes stored CryptoKeys' raw bytes in plaintext **[M]**. WebKit
  adds keychain IPC, lock-state failures and an index bug (§3).
- **NEVER persist a key in `data.json`** (`<configDir>/plugins/yaos/data.json`). Folder sync and backup tools copy
  the config dir.
- **NEVER put keys or RK in** logs, `StatusSnapshot`, `DiagnosticsBundle`, `Error` messages, notices or the URL bar.
  Protocol fields that carry keys are marked SECRET, like `relay.credential` (`src/protocol/messages.ts:61-62`).
- **The suite pin** (`e2ee: { suite: 0 | 1 }`, not secret) lives in `data.json` next to the device token.
  - If the pin says 1 and the secret is missing, the device enters phase `key-missing`: re-key by QR or RK.
  - **No pin** (just enrolled by a key-less code, or `data.json` lost) means the device writes nothing until a pin
    arrives from an authenticated source (§12.4). Nothing the server says sets or lowers a pin.
  - A pin is never lowered: 1 → 0 does not exist (§15.2).
- **Startup.** `getSecret` may return null before the store has loaded. Wait for SecretStorage's `changed` event
  for up to 5 s (`KEY_STORE_WAIT_MS`) before deciding the key is missing. The store loads everything at app start,
  then fires `changed` ([S] asar). A suite-1 start waits; an unpinned or suite-0 start reads nothing.
- **Linux desktop without an OS keyring.** SecretStorage stores plaintext and Obsidian shows
  `msgSecretsNotEncrypted` ([S] asar). YAOS tells the user once per vault, with a notice the first time it stores or
  loads a key on such a device (`isEncryptionAvailable()` is false; runtime-only, not in obsidian.d.ts). The
  "shown" flag lives in the vault's local storage (`App.loadLocalStorage` / `saveLocalStorage`), never in
  `data.json`. The vault-folder trust level applies.
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
   - **Raw-key retention.** `k` records wrap raw keys (§11.1), and WebCrypto refuses `wrapKey` on a
     non-extractable key (`InvalidAccessError`, [WebCrypto] §14.3.11; **[M]** in
     `webCryptoSuite1.keys.test.ts`). So the worker keeps the raw bytes of K_e, in worker memory only, exactly
     while a wrap or the host hand-off may still need them: a key not yet exported to main, a pending (generated,
     not yet adopted) key, and every epoch ≥ the seal epoch (the next roll's or revoke's `prevWrap`). Older raw
     bytes are zero-filled when the seal epoch moves past them. Keys from `init.crypto` count as exported.
3. New keys (adopted by roll, entered by QR or RK) are produced in the worker and posted back once in
   `keyringChanged` (SECRET). Main persists them to SecretStorage.
4. The engine never runs on main (DESIGN §g.5): the worker is the only carrier, and every carrier failure is terminal,
   with no restart and no UI-thread fallback (`src/host/engineHost.ts:1-17`). Tests and the sim run the same code over
   the in-process pair.

### 6.4 Side files and local state (DESIGN §e.4)

| File | Content under suite 1 | Verdict |
|---|---|---|
| Outbox mirror | `sealed` bytes, i.e. ciphertext. Re-opened with keys by `recoverFromMirror` (`src/engine/runtime/mirrorIo.ts:144`) | Fine |
| Synced mirror | Plaintext docId, path, contentHash, seqs | Accepted: the vault folder holds the same plaintext |
| Local snapshots (zip) | Plaintext | Accepted (local). Uploads go through `putAt` → `sealBlob` (`src/engine/snapshots/remote.ts:56`, `src/engine/blobs/blobStore.ts:52-57`) |
| IndexedDB `tail`, `snapshots`, `baseText`, ... | Plaintext (T_receipt stores outbox content, DESIGN §e.2) | Accepted (non-goal: local at-rest encryption) |
| Diagnostics bundle | Hashes MUST be `HMAC(kDiag, ·)`, not sha256 (DESIGN §j.7). Pseudonym = the first 12 hex of `CryptoPort.diagHash(salt ‖ 0x00 ‖ value)`; the per-bundle random salt stays, so two bundles do not correlate unless the user shares both (`src/engine/compose/diagnosticsBundle.ts`) | Done in WP-E2 |

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
pad (suite 1 only, inside the AEAD; added and stripped by the envelope codec, §18.2)
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
| coversSeq (checkpoints) | As today. The inner `CheckpointContent.coversSeq` check stays (DESIGN §b.1); it runs in the ingest gate (`src/engine/ingest/gate.ts`), after the envelope codec opened the bytes. |
| address (blobs) | The server cannot serve one blob's bytes at another address. The reader also checks sha256 after opening (`getOpened`, `src/engine/blobs/blobStore.ts:98-100`; body refs use it too, `src/engine/body/refs.ts:49`). |

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
- The padding lives **inside** the AEAD. The envelope codec adds and strips it for frames and checkpoints (§18.2), so
  `CryptoPort.seal/open` stay pure AEAD; the suite-1 `sealBlob/openBlob` add and strip it for blobs
  (`src/core/codec/padme.ts`). Suite 0 does not pad.
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
      (`src/engine/body/checkpoints.ts:288-292`, `:333-336`).
  - Blobs. `maxBlobUploadBytes` = 100 MB = 100000000 B, Cloudflare's request body limit on the Free and Pro plans
    (DECISIONS D9; a larger request gets the edge's own 413).
    - [D] For lengths in [2^26, 2^27), Padmé pads to multiples of 2 MiB. The largest padded plaintext that fits
      with header and overhead is 47 × 2 MiB = 98566144 B. Sealed = header + 28 + padded, and the header is 3 B at
      keyEpoch 1 and 10 B at the largest keyEpoch, 2^53 − 1 (`src/core/codec/sealedBlob.ts:20-26`): 98566175 B at
      keyEpoch 1, 98566182 B at the largest. 48 × 2 MiB seals to 100663327 B at keyEpoch 1, over the cap.
    - So the largest suite-1 plaintext is `maxSealedBlobPlaintext(100000000)` = **98566143**, the 0x80 marker
      included. Suite 1 has no cap of its own: `maxSealedBlobPlaintext(cap)` derives it from whatever transport cap
      the relay reports (`src/core/codec/sealedBlob.ts`).
    - `BlobPort.maxBlobBytes` stays the transport cap. The engine compares plaintext against what still fits it once
      sealed (`storePlaintextCap`, `src/engine/blobs/blobStore.ts`).
- **Row cost.** relay-wire §11.4: a commit costs 2 rows per touched stream, plus 1 per sealed ~64 KiB segment.
  Padding changes only the bytes.
  - [D] Small frames grow to 256 B. 100 such frames in one commit are 25 KiB, still one segment.
  - Large frames grow by ≤ 12 %, so segment rows grow by ≤ 12 % on bulk writes.
  - Storage grows by the same bound.

## 8. Replay and reorder

### 8.1 What each stream class needs

| Server action | ns / cfg | body / canvas | checkpoints | k | snap |
|---|---|---|---|---|---|
| Re-commit an old frame's exact bytes as a new row | **Rejected**: clientFrameId ring (DESIGN §c.3) plus the frameNo window (§8.2) | Harmless: a Yjs update whose structs are known is a no-op | n/a | Later duplicates lose (first valid wins, §11.3) | Harmless: a record is immutable per snapshot id and a tombstone is final, so a duplicate is a no-op and a replayed add cannot undo a delete |
| Re-attribute to another device or stream | Rejected by the AAD (§7.2) | same | same (stream) | same | same |
| Reorder concurrent frames | Accepted. The relay owns the order; frameNo accepts any legitimate reorder (§8.2) | CRDT | n/a | first in seq wins | Commutative under the same two rules |
| Serve an older checkpoint, withhold rows | Accepted (§2.3) | Accepted | Accepted | Withholding k blocks new epochs (DoS only) | Accepted: a hidden snapshot is unavailable (DoS only) |
| Fork: different views per device | Accepted (§2.1 non-goal) | | | | |

- **`snap`** is the snapshot index stream that the recovery work adds (branch `client-remake-recovery`; not built
  here). It holds one small record per uploaded snapshot (id, part addresses, sizes, sha256s); a delete is a
  tombstone. Its replay class is **index/LWW-like**: per snapshot id, the first valid add wins and a tombstone is
  final. That is why it needs no frameNo: the two rules make a replay or a reorder converge to the same index.
  Snapshot ids are random and never reused.

### 8.2 frameNo

- **Writer.**
  - frameNo is a counter per (deviceId, stream), for `ns` and `cfg` only. It is strictly increasing across that
    device's frames on the stream, and gaps are allowed.
  - `next = 1 + max(own right edge R in the fold state, own frameNos above the fold (own tail rows and receipts
    not yet folded), the outbox for the stream (poisoned included), the epoch-migration floor, earlier
    allocations of this runtime)` (`FoldRuntime.allocFrameNo`, `src/engine/sync/foldRuntime.ts`). The receipt
    writes the own tail row with its frameNo, so the max survives a restart before the row is folded.
  - The **first allocation of every runtime** (engine start) adds **NS_DEDUPE_RING** (64). This skips any number
    that a frame may have used while it was in flight when IndexedDB was lost.
  - Allocation and the outbox write share the engine's edit chain (`src/engine/runtime/logApi.ts`), so frameNo
    order is outbox order.
  - No new persistent counter: the fold state (in IDB and in checkpoints), own tail rows and the outbox already
    hold it.
  - Epoch migration (DESIGN §c.12 step 3) carries the device's highest own frameNo per stream into the new DB as
    meta `frameNoFloor` (max-merged, never lowered), so new frames never reuse numbers from the abandoned timeline.
- **Send window, restated over frameNo** (DESIGN §c.3). Own frame `f` may be sent only when every own frame with
  frameNo ≤ `f − NS_SEND_WINDOW` (32) is receipted. Equivalently (`Sender.window`, `src/engine/body/sender.ts`):
  `f < u + NS_SEND_WINDOW`, where `u` is the lowest frameNo among the stream's unreceipted own frames. Poisoned
  frames never send, so they do not hold `u` down; only body frames are ever `held`.
- **Reader.** State per (deviceId, stream): a right edge R and a 64-bit bitmap, as in RFC 4303 §3.4.3 [RFC4303]
  (window ≥ 32, 64 preferred; `src/core/replayWindow.ts`).
  - `f = 0` on an ns/cfg frame never reaches the fold: the inner decoder rejects it as `malformed` (and the
    encoder throws). A row that failed the gate is folded with frameNo 0 and skips the window.
  - Order per frame, after open and decode: (ns only) the upgradeRules pre-scan, then the clientFrameId ring
    (`ignored/duplicate-frame`), then the window:
    1. `f ≤ R − 64`: `ignored/replay-stale`.
    2. `R − 64 < f ≤ R` with the bit set: `ignored/replay-duplicate`.
    3. Otherwise accept: record the clientFrameId in the ring, set the bit (if `f > R`, shift and set `R = f`),
       then fold the ops.
  - A rejected frame emits one frame-level event (index −1), folds as empty and advances coversSeq; neither the
    ring nor the window changes. Malformed ops behind a valid frameNo still enter the ring and the window.

  The state changes only after open and decode succeed. RFC 4303 updates the window "only if the integrity
  verification succeeds".
- **Why no legitimate frame is ever rejected** [D]. Let `f` be an honest frame that has not committed yet. Then
  `u ≤ f`, so every own frame ever sent is `< f + 32`, so `R < f + 32` and `f > R − 64`: never stale. frameNos are
  distinct, so `f`'s bit is clear: never a duplicate. Every later commit of an already committed frame is rejected
  (ring or bit). This holds whatever order the relay commits in, with no relay dedupe, across reconnects with
  copies lingering on old sockets, and across restarts with IndexedDB intact. It is a property test
  (`src/core/ns/replayExactness.test.ts`, 150 seeds × 1500 steps), which also shows that without the send window
  some honest frame goes stale.
- **Boundary (open).** If IndexedDB is lost while an old socket still holds frames that the relay commits *after*
  the new runtime's first frames, those old frames can land at or below `R − 64` and are rejected as stale. The
  +64 skip prevents collisions, not this. Their content came from a local state that no longer exists; disk stays
  the truth (DESIGN §c.12).
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
  - every relay payload (`ns`, `cfg`, `b:`, `c:`, `snap`);
  - every checkpoint;
  - every blob: attachments, oversize body updates behind `bodyUpdateRef`, and uploaded snapshot bundles (multi-part
    zips indexed by `snap`; each part stored through `src/engine/snapshots/remote.ts:56`);
  - the key material inside `k` records (§11).
- **Visible to the server:**
  - stream names: `b:`/`c:` + a random docId, plus `ns`, `cfg`, `k`, `snap`;
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
- WP-E6a renamed the log carrier's streams `x:<sha256>` → `x:<address>`. That carrier was later deleted (stream
  `x:`, the `blobChunk` content, `blobChunkStream`): blob bytes go only to the blob store, and no stream name holds
  a blob hash or address (DESIGN §j.1).
- **Dedupe** is per vault. Identical plaintexts get identical addresses, so a `has` hit can skip the upload
  (`putSealed`, `src/engine/blobs/blobStore.ts:40-48`, for frames and attachments; snapshot parts batch the same
  check, `src/engine/snapshots/remote.ts:48-56`). There is no cross-vault dedupe: kAddr differs per vault.
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
- `openBlob` failures (`src/core/codec/sealedBlob.ts`): an unknown blobFormat or a suite byte other than 1 is
  `unsupported-suite`; truncation, a non-minimal varuint, keyEpoch 0, a body shorter than 28 bytes, or a valid tag
  over bad padding is `malformed`; then `unknown-key` and `auth-failed` as for frames. All of them are
  "unavailable" to the download path below.
- The suite-1 `sealBlob` seals under `sealEpoch()`. It has no size cap of its own; callers never pass more than
  fits the transport cap once sealed (§7.3).
- A blob stays under its upload epoch forever. Rolls and revokes never re-seal blobs. A revoked device can read old
  blobs it can fetch, which follows from §14.4.
- **PUT overwrites** (DECISIONS D9). Two devices uploading the same file put two different ciphertexts at one
  address. Either opens and verifies, so last-writer-wins is harmless.
- **Download.** `get` → `openBlob(address, sealed)` → the sha256 must equal the reference. Any failure is
  "unavailable" and is retried with backoff, as today (DESIGN §j.1). After the key is verified and 3 retries
  over ≥ 3 min have failed, the referencing row is quarantined as deterministic.
  - Implemented in WP-E6a. `getOpened` (`src/engine/blobs/blobStore.ts:90-102`) classifies each attempt, and
    `BlobFailureStreaks` (`:110-130`) applies the rule. Only these count: `auth-failed`, `malformed`,
    `suite-downgrade` or a sha256 mismatch under a verified sealing key, or a header that does not parse.
    Absent, transport errors, `unknown-key`, `unsupported-suite` and anything under an unverified key reset the
    count.
  - A body/canvas ref freezes the doc `blob-corrupt` (§9.3; `src/engine/runtime/docRuntime.ts:225-244`). No
    QuarantineRecord is written, because the row holds no sealed blob; `releaseQuarantine` unfreezes it and the
    count starts over.
  - An attachment is quarantined in memory on the blob queue (notice `blob-quarantined`,
    `src/engine/blobs/blobQueue.ts:571-574`), because an ns row cannot be quarantined. A restart retries.
  - A snapshot restore fails `content_corrupt` only on a deterministic failure or an absent part. A
    reader-dependent failure fails the request with no corruption notice (`src/engine/snapshots/remote.ts:81-89`).

### 10.3 No chunking

- One AEAD call per blob. WebCrypto has no streaming AEAD [w3c-webcrypto-73]; a blob is at most the relay's
  100 MB cap (§7.3).
- [M] At ≥ 2 GB/s on desktop, sealing 10 MiB takes ~5 ms; 95 MB seals in 70 ms and opens in 63 ms (node, below).
  Mobile is **[U]** (budget §16).
- [M] Blob-sized transient buffers besides the plaintext itself (`scripts/bench-e2ee.mjs`, `benchBlobMemory`):
  - Up: 3. The padded copy (AES-GCM takes one contiguous input; `pad`, `src/core/codec/padme.ts:30-35`, called at
    `src/engine/adapters/webCryptoSuite1.ts:139`), the ciphertext, and one `Blob` request body. `sealBlob` returns
    the parts `[header ‖ nonce, ciphertext]`; the transport joins them once. `put` is not async, so only the `Blob`
    is reachable while the PUT runs. The PUT runs over XMLHttpRequest since 5a55d3be, which reads the `Blob` as a
    stream (`src/engine/adapters/httpBlob.ts:415-422`).
  - Down: 3. The response body, the plaintext (unpad is a view), and the exact-size copy handed to main. A GET
    with a `Content-Length` is read into one buffer of that size as chunks arrive (`readBody`), where
    `arrayBuffer()` held every chunk until it joined them; only the plaintext is reachable once it is open.
  - The WebCrypto outputs are inherent. So is the input copy the spec makes encrypt/decrypt take, which Node does not count.
- [M] Peak RSS at 95 MB (node 26, one process per path, above a gc()'d baseline that already holds the input;
  N = 95 MB; 2026-10-07): bare `subtle.encrypt` / `decrypt` 2.00 N (the floor: WebCrypto's input copy and its
  output); `sealBlob` 3.05 N (the floor plus the padded copy); `openBlob` 2.03 N; `httpBlob.get` 1.08 N (2.07 N
  with `arrayBuffer()`); `putSealed` through `httpBlob` 5.12 N and `getOpened` plus the copy for main 4.11 N, both
  including garbage not yet collected (reachability after gc(): during the PUT only the `Blob`; after the open only
  the plaintext). These were measured with the fetch PUT, before 5a55d3be. The bench now drives `httpBlob.put`
  through a stub XMLHttpRequest whose `send()` runs the same body extraction (`scripts/bench-e2ee.mjs:307-309`),
  and has not been re-run for this document.
- **Several transfers at once.** The figures above are per transfer. The blob queue runs transfers concurrently
  within a byte budget (`Budgets.blobBytesInFlight`, 64 MiB on desktop, `src/core/limits.ts:243`, `:259`), and each
  transfer counts at least `BLOB_TRANSFER_MIN_COST` = 4 MiB (`:205`). A transfer larger than the budget runs alone,
  so the bytes held stay within max(budget, one blob), plus the seal and open copies of those bytes
  (`src/engine/blobs/blobQueue.ts:34-41`). A transfer never blocks a reconcile pass: the plan job claims it
  (`claimUpload` / `claimDownload`, `:342`, `:358`), and the queue wakes a pass over its docs when it settles.
- **Caps.**
  - Suite 1 plaintext ≤ `maxSealedBlobPlaintext(maxBlobBytes)`: 98566143 at the relay's 100 MB (§7.3). Above
    that, or above the attachment size setting, the file is not synced (skip notice) and nothing is uploaded.
    **[M]** A deployed Worker (workers.dev, code 7602a7bf, 2026-10-07T22:54Z,
    `experiments/logs/client-e2e-typing-xfer-deployed2-20261007T225440Z.json`) took a 100000000 B suite-0
    attachment and a 98566143 B suite-1 one (98566175 B sealed at keyEpoch 1, §7.3); each arrived sha256-identical
    on the peer.
  - A PUT answered 413, by the relay or by Cloudflare's edge (whatever the body), refuses that blob for the life
    of the engine: one notice, no outage record, no retry; changed bytes are a new hash and are tried
    (`src/engine/blobs/blobQueue.ts:542-547`, `runUpload`).
  - No blob store (`blob = null`): attachments are not synced (fail closed, DESIGN §j.1). The log carries no
    blob bytes.

### 10.4 Garbage collection

The server cannot see which blobs a vault references (under suite 1 it sees opaque addresses), so blob GC is a
client mark-and-sweep against the server's list and batch conditional delete (server ask A3, built: relay-wire
§11.3.1). The same code runs under suite 0. Implemented in WP-E6b.

- **Server part** (relay-wire §11.3.1; these routes post-date the 7208184 baseline, so their lines are at 7cf68234,
  `server/src/router.ts:640-687`):
  - `GET /vault/:id/blobs?cursor=` pages `{address, uploadedAt}` in address order, 1000 a page. It may answer
    `503 list_incomplete` with Retry-After.
  - `POST /vault/:id/blobs/delete {"ifUploadedBefore", "addresses"}` takes 1–100 addresses and answers
    `deleted | newer | absent` for each. R2 has no conditional delete, so all the heads run first and then one
    delete (`:825-834`).
  - Both routes share 60 requests a minute per vault: `429` with Retry-After (`server/src/vault/host.ts:418-424`
    at 7cf68234).
- **Client ports.** `BlobPort.list` and `BlobPort.deleteIfUploadedBefore` (`src/ports/blob.ts:63-69`, batches of
  ≤ `BLOB_DELETE_BATCH` = 100).
  - The HTTP adapter retries 429/503 after Retry-After, at most 5 calls, waits of ≤ 65 s, abortable on engine stop
    (`src/engine/adapters/httpBlob.ts:59-62`, `:305-322`). Each attempt, its reply included, ends at a deadline
    sized to what it can move: about 17 s for a list page and 15.5 s for a delete batch (`relayHttpDeadlineMs`,
    15 s plus the bytes at 64 KiB/s, `src/core/deadline.ts:63-65`; `httpBlob.ts:72-74`).
  - `SimBlobStore` (`src/sim/blobStore.ts`) stamps `uploadedAt` from the sim clock, refreshes it on PUT, and has
    hooks for the HEAD→delete race.
- **Trigger.** Only the Obsidian command "Clean up unused server attachments": one `cleanUpAttachments` command,
  one sweep in the worker, one notice. It says what was deleted, what was kept as newer, what was repaired or
  lost, or why nothing was deleted (`src/host/ui/attachmentsCleanup.ts`). There is no schedule, status row,
  settings row or progress UI.
  - Path: `src/engine/compose/runtimeOps.ts:150-153` → `src/engine/runtime/blobGc.ts` (preconditions, live set)
    → `src/engine/blobs/gc.ts` (sweep).
  - It runs in the writer runtime (a VaultRuntime), which exists only while `PinGate` is open
    (`src/engine/compose/pinGate.ts:148-162`, §12.4). A closed device (unpinned, or suite 1 without the newest
    winner's key) runs the KeyReader instead, which answers the command `refused: "keys-unverified"` with zero
    counts (`src/engine/compose/keyReader.ts:188-191`).
  - One sweep at a time (`busy`); engine stop aborts it (`interrupted`). The session loop declaring the relay link
    dead aborts the sweep's store calls in flight too: they go through the engine's `TransferLink`
    (`src/engine/blobs/transferLink.ts:1-7`, `src/engine/runtime/context.ts:128`), and a list or delete that fails so
    ends the sweep `interrupted` (`src/engine/blobs/gc.ts:157-160`).
- **Grace** `EngineTuning.blobGcGraceMs` = 7 days (`src/engine/runtime/options.ts:58-63`, `:91`). It is a tuning
  knob: the e2e uses 8 s.

**Preconditions.** Fail closed: any failure deletes nothing and names the reason in the notice. A live set
computed from a partial view would delete live data.

| Refusal | Check | Where |
|---|---|---|
| `no-store` | The vault has a blob store (VAULT_READY `attachments`) | `src/engine/runtime/blobGc.ts:103` |
| `keys-unverified` | Suite 1: the sealing epoch is ≥ 1 and verified, and so is K_1, because addresses use the kAddr of K_1 (§5.1). And the in-session write gate is open (`writeGate.ts`): a device revoked mid-session, or behind a newer winner it has no key for, is refused before it lists, because its deletes would be refused anyway | `:104-111` |
| `offline`, `read-only` | A relay session, and it is writable | `:112-113` |
| `not-caught-up` | `ns`, `cfg` and `snap` are read to the relay's head now, in this session (`SessionLoop.readFresh`, `src/engine/runtime/sessionLoop.ts:306-327`), and none is stale | `:125-127` |
| `fold-incomplete` | No quarantined `ns` / `cfg` / `snap` row. Every fold is complete: not halted, its snapshot decodes, and each tail row opened, passed the gate, decodes, is folded and (for `snap`) has a known record version (`FoldRuntime.gap`, `src/engine/sync/foldRuntime.ts:181-202`; `src/engine/sync/snapRuntime.ts:56-58`) | `:128-133` |
| `body-unreadable` | Every body/canvas row the relay still serves opens for this reader. A reader-dependent failure (`isReaderDependent`, `src/engine/ingest/envelope.ts:58`: unsupported version or suite, unknown key, a bad tag under an unverified key) may hide a ref, so it refuses. A deterministic failure is skipped, because no reader can resolve it | `:160-161`, `src/engine/blobs/bodyRefs.ts` |
| `addressing-mismatch` | Safety net: nothing is deleted until the listing shows one of the addresses that the committed folds reference (else any live one). A listing that never shows one refuses. This guards against a wrong suite or key, under which every live address looks unknown | `src/engine/blobs/gc.ts:117-118`, `:150`, `:153-155` |

- **K_1 after a roll.** A device that joins at epoch ≥ 2 (installKey by QR or RK) still gets K_1 verified: the
  keyring opens each winner's `prevWrap` with the next epoch's verified key and checks the kcv
  (`src/engine/keyring/evaluate.ts:112-130`, `:158-164`). So the K_1 condition does not lock out late joiners, and
  GC keeps requiring it (test: `src/engine/compose/keyReader.test.ts:227`, a QR join at epoch 2 and an RK join
  at epoch 3; e2e: `e2e/client/e2ee.ts` step 5).

**Live set** (`src/engine/runtime/blobGc.ts:135-165`). The `blobAddress` of:
- every ns entry's blob, tombstones included. Tombstones stay in the fold until the count-based prune
  (`TOMBSTONE_CAP` 20000, hysteresis 1000; `src/core/limits.ts:20-21`, `src/core/ns/fold.ts:224-226`);
- every `cfg` file blob, and every part of every record in the `snap` fold. A `del` removes the record, and
  readers recompute part addresses from the sha256 (`src/engine/snapshots/remote.ts:47`, `:74`). See
  `committedBlobHashes`, `src/engine/blobs/touch.ts:32-39`;
- every own outbox frame not yet committed (`frameBlobHashes`, `touch.ts:41-70`). For a `bodyUpdateRef` this is
  the sha256 of the frame's content;
- the blob queue: pending and running transfers, both directions (`BlobQueue.liveHashes`);
- every `bodyUpdateRef` the relay still serves on the body/canvas stream of each ns entry and of each stream this
  device holds.
  - "Unresolved" means readable by a joiner. A read from 0 gets the checkpoint plus the rows above `gcSeq`
    (`server/src/streams/store.ts:476-523`), and checkpoints hold Yjs state, never refs.
  - So rows above `gcSeq` are scanned: a probe read after `MAX_SAFE_INTEGER` returns `lastSeq`/`gcSeq` only
    (`server/src/streams/relay.ts:252-257` accepts it as a cursor, `:922-935` answers), then the rows are read from
    `gcSeq`. If compaction meanwhile moves `gcSeq` past the cursor, the scan restarts at the new `gcSeq`
    (`src/engine/blobs/bodyRefs.ts:83-84`).

**Sweep** (`src/engine/blobs/gc.ts:96-195`). Calls are sequential and honour Retry-After.
1. R1 cutoff probe (below).
2. Mark (above).
3. Page `list`. An address is a candidate if it is not live and was uploaded before the cutoff; an unreferenced
   address uploaded later counts as `keptNewer`. Candidates are deleted in batches of ≤ 100 with the same cutoff,
   so the store re-checks the upload time and a re-upload meanwhile answers `newer`.
4. R4 repair (below).
5. Delete the probe. This is best effort: a stray probe is garbage for a later sweep.
6. Prune put times older than grace/2 (`src/engine/runtime/blobGc.ts:93-96`).

**Races.**
- **R1, clock skew.** `uploadedAt` is R2's clock, so a device clock days ahead must not shrink the grace.
  - The cutoff is taken on the store's clock. The sweep PUTs 1 byte at a random probe address and asks
    `deleteIfUploadedBefore([probe], 0)`, which answers `newer` with R2's upload time T. Then
    cutoff = T − grace (`gc.ts:197-210`).
  - If the probe fails, cutoff = device now − grace − `GC_CLOCK_SKEW_MARGIN_MS` (1 day, `gc.ts:34`).
  - Why not the `Date` header:
    - it is the Worker's clock, not the clock that stamps `uploadedAt`;
    - the server exposes no response headers to CORS (`server/src/` sets no `Access-Control-Expose-Headers`), and
      `Date` is not a CORS-safelisted response header, so a browser `fetch` cannot read it;
    - the probe needs no new route and behaves the same under miniflare.
  - The probe runs before the mark. R3 depends on that order.
- **R2, orphan reuse.** `putSealed` skipped the PUT when `exists` found the address. Re-adding bytes whose blob is
  a long orphan would then rely on an object that a concurrent sweep may delete before the new reference commits.
  - Now a found address is reused only if the committed folds reference its hash, or this device PUT it less than
    grace/2 ago. The folds count only while they are current: a session, not halted, not stale
    (`src/engine/runtime/context.ts:372-376`).
  - The put time is persisted (meta `blobPut:<address>`), so it survives a restart.
  - Otherwise the device PUTs again, which refreshes `uploadedAt` (`touch.ts:134-138`,
    `src/engine/blobs/blobStore.ts:44-57`).
  - A snapshot reusing parts of a live `snap` record still skips them (committed), so unchanged parts are not
    uploaded again.
- **R3, a pending reference.** A device offline for longer than the grace, with a reference in its outbox.
  - Before the sender sends an own frame that references blobs (ns `create`/`setBlob` of a blob, cfg `filePut` of
    a blob, `snap` put, a `bodyUpdateRef` through the store), each hash must be committed or have a fresh own PUT.
    Otherwise it is PUT again (`touch.ts:169-249`):
    - from local bytes: the frame's own content for a `bodyUpdateRef`, else a vault file, config file or own
      snapshot part with that sha256 (`src/engine/compose/vaultRuntime.ts:283-309`);
    - without local bytes, the stored object is re-PUT verbatim;
    - a store error holds that frame (and later frames of its stream, `src/engine/body/sender.ts:414-417`) with
      backoff instead of sending an unprotected reference.
  - Changes from the first proposal:
    - a cleared frame stays cleared for only grace/4 (monotonic clock), and a new session re-checks every frame.
      So a frame committed at S had a PUT at P ≥ S − 3/4·grace;
    - the verbatim re-PUT, and holding on store errors.
  - Why it holds: if the sweep's mark did not see the frame, then S > mark > probe time T. So
    P > T − 3/4·grace > cutoff, and the store answers `newer`.
- **R4, the HEAD→delete window.** A PUT that lands after the store's head of an address and before its one delete
  is deleted anyway and reported `deleted` (relay-wire §11.3.1).
  - After its deletes, the sweep marks again: `ns`/`cfg`/`snap` to head, plus body rows committed since the first
    mark.
  - A deleted address that is live now is uploaded again from the plaintext sha256-checked bytes this device
    holds (own outbox, vault file, config file, own snapshot part): `repaired`.
  - Without bytes it is counted `lost`. The notice asks the user to add the file again from the device that has it
    (`gc.ts:162-186`).
- **What remains unrepairable or unchecked:**
  - another device PUTs a long-orphaned address inside the HEAD→delete window (at most 17 rounds of 6 heads,
    sub-second), and either its reference commits after the R4 re-read, or this device has no bytes (`lost`).
    That device's R2 sees its own fresh PUT and sends the reference, so readers then see the blob as absent until
    someone uploads it again. Closing this needs a conditional delete or a server-side touch (a server change, not
    made);
  - R2 and R3 decide on this device's committed view, which may be slightly stale. For example, a committed entry
    that is replaced and pruned meanwhile;
  - device wall-clock jumps backwards by more than grace/4 between a PUT and its reuse check. A future put time
    already counts as stale;
  - the fallback cutoff covers device↔R2 skew of ≤ 1 day only;
  - references inside rows already folded into a local snapshot or relay checkpoint, under a newer `snap` version
    or encoding this reader ignored before it was upgraded. `FoldRuntime.gap` checks only the tail;
  - a relay restore to before a sweep. Blobs are not epoch-scoped (relay-wire §11.3), so references restored by
    the rewind may name deleted blobs;
  - a verbatim R3 refresh gives this device no plaintext for a later R4 repair;
  - a failed re-mark leaves the deletes unchecked; the notice detail says so.
- **Scale caveat (user, 2026-10-07).** The sweep is O(N) on the client. It lists every blob address (~50k on a
  heavy vault) and does set arithmetic against the live set on whatever device runs it, possibly a phone. Before
  the safety net sees a witness, the candidates accumulate as well. It will buckle on heavy vaults, and is
  acceptable for v1 only because it is a cold, manual path. A sweep of N blobs with D orphans costs about
  N/1000 + D/100 requests (≥ that many seconds at the limit), plus 2 for the probe. Future directions, not designed
  here: a resumable sweep with a persisted cursor, and a live set kept incrementally from the ns fold instead of
  rebuilt per run.
- Alternative: server refcounts. Rejected: the server cannot see references under E2EE, and keeping refs
  consistent across DOs would be a distributed transaction.

## 11. Keyring stream `k`

The keyring is an ordinary relay stream named `k`. The relay treats stream names as opaque, so it needs no server
change (`server/src/streams/protocol.ts:62-63`; server ask A9). `streamClass` gains `"keyring"` (`src/core/types.ts:79`).
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
- **An open revoke is stored too.** A revoke the device holds open (pending, no winner for its epoch: the device is
  `revoked-epoch`) is stored after the winners, at most `STORED_OPEN_REVOKES` (4, `src/engine/keyring/book.ts:51`).
  After a reset or restore that drops it from `k`, the device stays `revoked-epoch` (it writes and rolls nothing)
  until it is re-keyed, and then re-publishes it. A revoke winner is re-published even when `k` has another record
  for its epoch (a roll taken after the reset): revoke outranks roll (§11.3), so devices that took the roll stop
  instead of forking. A stored revoke the device cannot judge is never re-published; a re-key revoke under the RK
  (`revokeRekey`) ends it, and it is no longer stored (`src/engine/keyring/openRevokeReset.test.ts`).
- **Genesis position.** Enable writes the genesis record only on the creation path, at `VAULT_READY.head = 0` (§15.1). Readers do not rely on its
  position: validity alone decides.

## 12. Pairing

### 12.1 Pick: a plugin-drawn QR carrying the key in a client-only link

```
obsidian://yaos?action=setup&host=<host>&pairingCode=<vaultId.secret>&key=<b64url(u8 1 ‖ varuint e ‖ K_e)>
```

1. The paired device calls `POST /vault/:id/auth/pairing-code` (DECISIONS §2.2), as today.
2. It builds the link locally, extending `buildSetupLink` (`src/host/ui/pairing.ts:789`; the `key` value is
   `encodeKeyParam`, `:734`).
   - `key` holds the newest winning epoch and its key: 1 + 1 + 32 bytes, 46 base64url characters.
   - Older keys come from the `prevWrap` chain (§11.1).
   - The vaultId is already inside the pairing code (DECISIONS D3).
3. The plugin draws the QR itself, with `qrcode` 1.5.4 (+9.6 KB gzip **[M]**, §23).
4. The new device scans it. Obsidian hands the parameters to `registerObsidianProtocolHandler`
   (`src/host/ui/registerUi.ts:220`). `parseSetupLink` (`src/host/ui/pairing.ts:822`) accepts `key` or `suite`
   (§12.4), never both (they join `SETUP_LINK_KEYS`, `pairing.ts:814`, which rejects unknown keys).
5. **The key is stripped before `/enroll`.** DECISIONS D3 requires exactly this: "A future client-only key part
   must be stripped before `/enroll`". The key goes into the pending identity, in memory only. After enroll, the
   device reads `k`, checks kcv and walks the chains (§11.3). It then persists the keys and the suite pin.

Rules:

- **NEVER put a key in any URL the server serves**, including the fragment of `GET /mobile-setup`.
  - That page is a static Worker response whose JS reads `location.hash` (`server/src/console/mobileSetup.ts:47`).
  - Its `connect-src 'none'` CSP is set by the same server, so it is no guarantee.
  - The pair modal no longer shows `mobileSetupUrl`, under **both** suites: `requestPairingCode` drops it
    (`src/host/ui/pairing.ts:443-453`). That page is server-drawn, so it can carry only a key-less join, and a
    key-less join is blocked (§12.4). The plugin draws the `obsidian://` QR itself instead (iOS Camera opens it, §3).
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
  de-duplicates repeats (`uniqueDeviceName`, `server/src/vault/host.ts:544`).
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
- **No migration, no inference.** A `data.json` without `e2ee` is unpinned, whatever else it holds. A device paired
  before this design (a stored identity, a synced vault, a full IndexedDB) is blocked like any key-less join and is
  settled only by (i) or (ii). There is no "absent means suite 0" rule. Nothing is inferred from a stored pairing,
  from local state or from anything the server says. Leaving the vault (unpair, another vault or relay) drops the
  pin and forgets the keys (§6.1).
- **Harnesses pin explicitly.** The sim and e2e harnesses either set the pin the way a real device gets it, or use
  a clearly test-only fixture that writes the same `data.json` state the real flow writes
  (`src/host/keys/testkit/pinFixture.ts` applies main's own suite-0 transition). `scripts/check-deps.mjs` keeps
  `testkit/**` out of product code, so no production path can pin by fixture.

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

- **"Scan QR from one of your devices"** says: on a device that already syncs this vault, open YAOS → "Pair
  another device" (or "Show re-key QR") and scan it with the camera.
  - A suite-1 device's QR carries the key: source (i).
  - A suite-0 device's pairing QR carries `suite=0`: source (ii).
- **No re-enrollment.** The blocked device is already enrolled. When a setup link names the vault it is enrolled in
  (the vaultId is inside the pairing code, DECISIONS D3), it takes only `key` or `suite` from the link and does not
  enroll again. The code expires unused after 15 min.
- **No third button.** Nothing on this screen sets suite 0, enables encryption or creates a vault. "Create a new
  vault" is not offered to a blocked device either: the command and the settings action are hidden, and
  `createAndEnroll` refuses before any request (`canCreateVault`, `src/host/ui/commands.ts:18-22`;
  `createVault.ts:114`).

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

**As built (WP-E4, with E3 integrated).**
- **One gate at start: `PinGate`** (`src/engine/compose/pinGate.ts:128-168`).
  - It is open for suite 0, and for suite 1 once `Keyring.open` over the records main stored reports
    `keyMissing() === null`: the adapter holds the newest stored winner's key, verified against its record
    (`:117-126`). Unpinned is closed.
  - `writerPorts` (`:159-162`) throws while the gate is closed, and it is the only way to the ports of a
    VaultRuntime (`src/engine/compose/protocolEngine.ts:230-234`). So a closed device cannot build the one thing
    that writes.
- **A closed device runs the KeyReader** (`src/engine/compose/keyReader.ts`) over `readerPorts` (`pinGate.ts:165-167`).
  - Its ports: a relay that connects and reads (`append` throws, `putCheckpoint` rejects; on the creation path it
    appends on `k` only, for the enableE2ee genesis), a clock, a random source, and the adapter's key operations
    without seal, open or any blob op. No storage, blob or hash port reaches it.
  - It reads `k` to head, and again on every live `k` frame.
  - It answers `installKey` (QR or RK; the secret buffer is zero-filled), `pinSuite0` and `enableE2ee`, and refuses
    `revokeRekey`. `cleanUpAttachments` gets `refused: "keys-unverified"` (`keyReader.ts:186-211`).
- **Two ways out of the reader, by pin:**
  - **Unpinned.** A verified key goes to main as `keyringChanged`. Main stores it in SecretStorage
    (`src/host/keys/hostKeys.ts:61-75`; on a suite-0 pin it answers `refused`, `:64`). `pinsFromKeyring`
    (`src/host/keys/pin.ts:163-165`) then pins suite 1, and saves the pin before the engine gets `keyringStored`.
    Main then restarts the engine with the pinned config (`src/host/pluginController.ts:306-311`). A successful
    `enableE2ee` or `pinSuite0` pins the same way (`:295-300`).
  - **Suite 1 without the key** (`"no-key"`, `"revoked-epoch"`). Once main has stored the key, the reader's `onKeyed`
    re-checks the gate, and the engine starts its VaultRuntime in the same process (`protocolEngine.ts:298-310`).
    No restart is needed.
- **`keyringSeen` is sticky.** Main saves it the first time an unpinned engine's status reports it
  (`pluginController.ts:187-190`).
- **Once open, the in-session write gate decides** (`src/engine/keyring/writeGate.ts`). It covers what can shut
  writes later in a session: an open revoke, a newer winner without its key, or `k` not read yet.
  - The runtime's crypto and blob ports are `gatedCrypto` and `gatedBlob` (`src/engine/runtime/context.ts:128-129`).
  - Every writer uses them: the sender, doc frames, the BlobQueue and the SnapshotJob
    (`src/engine/compose/vaultRuntime.ts:234`, `:258`). Blob GC also refuses up front while the gate is shut
    (`src/engine/runtime/blobGc.ts:110-111`).
- **Tests:**
  - `src/engine/compose/pinGate.test.ts`, `keyReader.test.ts`, `src/host/keys/{pin,hostKeys}.test.ts` and
    `src/host/pluginController.test.ts`;
  - the at-rest scan (`src/host/keys/atRest.test.ts`, §20.3);
  - `e2e/client/e2ee.ts`, which runs suite 1 end to end through the real controller on the local relay.

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
   As implemented (WP-E3; `src/engine/sync/ingestRow.ts` `ownCommitCopy`, `src/engine/store/repo.ts` `settleOwn`,
   `src/engine/runtime/reseal.ts`), there is no re-plan:
   - When the receipt of an own frame comes back stale, or held (§14.3, the device has not judged every `k` row
     below it), the author stores the row as a reader would and renames the outbox record to an **unsealed copy**:
     a fresh clientFrameId, empty `sealed`, state pending, and the **same frameNo**. If a held row settles as not
     stale after all, readers fold the copy as `replay-duplicate`, so ns and cfg ops apply once.
   - **Unsent or uncommitted outbox records** with `keyEpoch < r`, and the copies, are re-sealed under the
     current epoch before sending (`OutboxChange {t: "reseal"}`):
     - ns and cfg, and copies, keep their clientFrameId. The sender opens ns and cfg only after the session's
       late-receipt reads, so one still in the outbox then never committed;
     - every other record takes a fresh clientFrameId (a rename at the same outbox order; held dependents are
       re-pointed), since its old id may have committed with other bytes (R4 `frame-id-conflict`). Yjs updates are
       idempotent, so a duplicate is harmless.
   - A suite-1 sender is write-blocked until the session's `k` read, so an offline device learns r before it sends
     anything sealed under an older epoch.
   - Unsealed copies are not mirrored (`selectMirrorFrames`): a mirror recovery re-derives them from disk.
   - `refused frame-id-conflict` for ns and cfg still poisons, as in DESIGN §i.6.
5. **Checkpoints.** Nothing is forced. New checkpoints are sealed under r at the normal cadence (DESIGN §d.9
   checkpoint policy). Old checkpoints with coversSeq ≤ S_rot stay valid.

### 14.3 Stale-epoch rule

For the winning revoke epoch r, committed at S_rot in the current vaultEpoch:
- a frame with `keyEpoch < r` and `seq > S_rot` is **stale**: ignored, not quarantined (§9.3);
- a checkpoint with `keyEpoch < r` and `coversSeq > S_rot` is rejected (treated as absent).

As implemented (WP-E3, `KeyringRuntime.staleCheck`), the rule is decided when the gate judges the row, and the
answer is `"stale"`, `"hold"` or null (always null under suite 0):
- **Hold** means the device cannot judge yet. It applies to a row at seq s if some `k` row below s has arrived but
  is not judged, if `k` was not read on this session, or if the `k` stream is itself stale. A held ns or cfg row is
  stored unopened (`LOCAL_FLAG_UNOPENED`) and halts the fold; a held body row is quarantined `"keyring-hold"`, which
  freezes the doc until it settles. A live batch ends after a `k` event, so rows behind a revoke wait for it.
- **Devices that have not re-keyed** do not learn r from the record header alone: an open revoke (a winning revoke
  for an epoch whose key the device lacks) shuts the write gate (`revoked-epoch`) and holds every row past it.
  When the re-key QR or RK arrives (§14.2 step 3), the held and unopened rows are re-gated: stale ones are
  dismissed and rows under r open.
- A stale ns or cfg row is stored with `LOCAL_FLAG_STALE_EPOCH` and empty content and folds as `"stale-epoch"`;
  a stale body, canvas or `x` row is only accounted: ignored, with no quarantine and no freeze (§9.3).

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
the vault-creating server call itself. Before WP-E5 the plugin had no such flow: every pairing was a key-less enroll
by code, and an unclaimed server was refused with "Open it in a browser to claim it first". Both still hold for
pairing (`fetchCapabilities`, `src/host/ui/pairing.ts:251`, accepts an unclaimed server only with
`allowUnclaimed`, which only `probeServer` passes, `src/host/ui/createVault.ts:67-69`). WP-E5 added the flow
(`src/host/ui/createVault.ts`; §21 "E5 as built").

**Definition.** A device is on the creation path for vault V if and only if, in one flow that the user started from
YAOS's own "Create a new vault" command or button, all three steps hold:
1. **This device sent the call that created V,** and read V's vaultId from the response:
   - **Unclaimed server** (`GET /api/capabilities` says `claimed: false`): `POST /claim` (relay-wire §2.2,
     `server/src/router.ts:256-304`).
     - The claim creates the first vault (`CLAIM_VAULT_NAME`, `router.ts:70`) and returns its `pairingCode`.
     - The operator recovery key is generated on main as the console makes one (32 random bytes, hex,
       `server/src/console/console.ts:248-250`), then shown with Copy and an "I saved the operator key" checkbox
       that enables the claim.
   - **Claimed server**, in this order:
     - `POST /operator/login` (`router.ts:306-320`) with the operator recovery key typed into this flow;
     - `POST /operator/vaults {name}` (`:340-360`);
     - `POST /operator/vaults/:id/owner-code` (`:434-456`) for that vaultId;
     - `POST /operator/logout` (`:322-329`).
   - Every claim, operator and pairing call fails with "no answer within 15 s" when no reply arrives in time
     (`PAIRING_CALL_DEADLINE_MS`, `src/host/ui/pairing.ts:201-212`).
2. **It enrolled with the code from step 1.** The code must name that vaultId, and it never leaves memory: it is
   not displayed, not put in a link and not logged.
3. **After enrolling, it read `VAULT_READY.head = 0`** (relay-wire §3.2) **and read `k` to head, empty.**

Only then does the screen show "End-to-end encryption: On", preselected, with the opt-out (decision D2). If any check
fails, the flow aborts with "The server returned a vault that is not empty" and sets no pin. The device stays
unpinned and blocked (§12.4).

- **Never entered from:**
  - the protocol handler (`src/host/ui/registerUi.ts:220`) or `parseSetupLink`;
  - a typed or scanned code;
  - the console's QR or link, or a claim response's `obsidianUrl`;
  - `resumePendingEnrollment`.

  All of those are key-less joins (§12.4).
- **Not started on a blocked device.** "Create a new vault" starts only on an unpaired device, or on a paired one
  that holds its vault's pin and key (the engine reports nothing missing). A paired device that is blocked for want
  of a key or pin, or whose engine has not reported yet, only takes a key (§12.4). The command, the settings action
  and the modal's first screen check `canCreateVault` (`src/host/ui/commands.ts:18-22`), and `createAndEnroll`
  checks it again: it refuses with "blocked" before any request or write (`src/host/ui/createVault.ts:114`).
- **Crash recovery.**
  - Right after step 1's response, main writes `creating: {vaultId}` to `data.json`. Nothing else writes it.
  - On restart, an enrolled, unpinned device whose vaultId equals `creating.vaultId` resumes at step 3. Every other
    unpinned device is blocked (§12.4).
  - The marker is removed once a pin is set.
- **Secrets.** The operator recovery key is held only for step 1. It is never stored, and the §6.1 NEVER rules
  apply to it. The settings hint now reads "The operator key stays in the console; only "Create a new vault" asks
  for it here, and uses it once." (`src/host/ui/settingsTab.ts:129`).
- **`Origin` [U].** `/claim` and the operator routes require JSON and an `Origin` equal to the server's origin
  (`server/src/router.ts:118-129`, DECISIONS D5).
  - The plugin sends both explicitly on every such call (`operatorHeaders`, `src/host/ui/pairing.ts:552-556`). The
    session goes in a manual `Cookie` header, since `requestUrl` keeps no cookie jar.
  - Checked against the real relay with Node's fetch (`e2e/client/e2ee.ts` steps 1 and 6). Whether Obsidian's
    `requestUrl` sends `Origin` and `Cookie` as set, and hands back `Set-Cookie`, on desktop and mobile is still
    **[U]** (§23.3). The typings say nothing either way: `RequestUrlParam.headers` and
    `RequestUrlResponse.headers` are plain string records (`node_modules/obsidian/obsidian.d.ts:5455`, `:5469`).
  - If it cannot, server ask A11 applies (§19). Until then the flow fails closed with a plain message
    (`forbidden_origin`, `no_session`; `src/host/ui/pairing.ts:608-609`, `:673`).
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
1. In the plugin, run "Create a new vault" (§15.1) with encryption On, or Off by the opt-out, on a device that
   syncs the old vault (it holds that vault's pin and key; a blocked device only takes a key, §12.4). The device
   leaves the old vault first. The initial reconcile uploads every file from disk.
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
| Blob up | 1 sha256 of the bytes read for the transfer (one read, one HashPort digest on WebCrypto, `src/engine/blobs/blobQueue.ts:527`, `:534`; a suite-0 upload does the same), 1 HMAC (address), 1 AES-GCM |
| Blob down | 1 AES-GCM, 1 HashPort sha256 to verify (`getVerified`, `blobQueue.ts:580-584`) |
| Engine start | 1 HKDF import per held epoch, plus 7 `deriveKey` (§5.1) |
| Older epoch, first use | 5 `deriveKey`, lazily |
| Re-key | ≤ 3 unwraps per record walked, plus 1 kcv per epoch |

### 16.2 Budgets (MUST hold; WP-E7 measures them)

| Path | Desktop | Mobile (assumed) | Note |
|---|---|---|---|
| Typing: one frame per `OPEN_FRAME_IDLE_MS` (100 ms, `src/core/limits.ts:67`), sealed after that idle | ≤ 1 ms per frame | ≤ 10 ms | Below 1% of the frame interval. It includes the CPU and WebCrypto worker wake-up: a bare `subtle.encrypt` of 256 B after 100 ms idle alone takes 0.25–0.38 ms **[M]**, so the former 0.05 ms could not be met. The steady-state (back-to-back) cost, 0.019 ms **[M]**, is information only |
| Bootstrap, 10k docs, 200 MiB of checkpoints and the steady-state tail (DESIGN §d.9) | ≤ 0.3 s total crypto | ≤ 3 s (10k × 0.1 ms + 200 MiB ÷ 100 MiB/s) | Downloading 200 MiB dominates |
| One 10 MiB blob | ≤ 10 ms | ≤ 100 ms | Plus 3 × 10 MiB transient buffers each way, one of them WebCrypto's output (inherent), plus WebCrypto's own input copy (§10.3) |
| Engine start | ≤ 5 ms | ≤ 20 ms | |
| Bundle | +0 KB of third-party crypto (WebCrypto) | | `qrcode` +9.6 KB gzip **[M]**. The E2EE code itself is ~15 KB gzip **[M]** (14.8 KB: keyring engine 6.6, compose layer — pinGate, keyReader, hostKeyring — 3.8, host keys 2.1, WebCrypto adapter 1.9, codecs 0.4; `scripts/bench-e2ee.mjs`), accepted |

Crypto is never on the hot path. Bootstrap is bound by the network and the planner, not by AES. The engine opens a
bootstrap in controlled batches: one batched read of ≤ `readPageBytes` (48 streams of a 21 KB checkpoint each), every
member gated concurrently, one batch after another (8 lanes against a non-batched relay). Measured **[M]** (M4 Pro,
Node 26.5, `scripts/bench-e2ee.mjs`, median of 5, load average 1.7–2.1), 10k docs and 205–211 MiB sealed in each case:

| Vault | Opens | Batches of 48 | 8 lanes | `Promise.all` | One by one |
|---|---|---|---|---|---|
| A: checkpoints only | 10,000 | 137 ms | 141 ms | 173 ms | 246 ms |
| S: steady state (the budget): 32 docs with 255 tail rows each | 18,160 | 279 ms | 230 ms | 251 ms | 395 ms |
| C: settle cap reached, one row left on every doc (information) | 20,000 | 235 ms | 246 ms | 308 ms | 397 ms |
| B: stress, 4 tail rows on every doc (information) | 50,000 | 530 ms | 539 ms | 667 ms | 864 ms |

- **S is the budget case.** It is the most the checkpoint policy leaves (DESIGN §d.9). A doc idle for 30 s carries
  fewer than 256 tail rows, and a doc quiet for 2 min carries none. S takes 32 docs still just under the hot cap: a
  heavy user's docs within the worst-case 22 min fallback window. Its 32 long tails are spread one per batch, the slow
  case for batches. Each tail opens in order, so it sets its batch's time. That is the one case where `Promise.all`
  beats batches; both stay inside the budget.
- **B is not a budget.** It is what a vault accumulated before the settle rule (40k tail rows over 10k docs). The
  settle rule now checkpoints such tails once the docs are quiet.
- **Batches stay, with no `Promise.all` fallback.** Everywhere else they beat `Promise.all`. Unbounded concurrency
  queues tens of thousands of operations on the WebCrypto thread pool at once and pays for it in scheduling and
  memory.

### 16.3 Transaction rule (correctness, not speed)

- WebCrypto promises settle on a task, not a microtask. Awaiting one inside an IndexedDB transaction body lets the
  transaction auto-commit early, and later writes then fail.
- **NEVER await a CryptoPort or HashPort call inside a `runTx` body** (`src/engine/adapters/idbStorage.ts:187`).
  Seal before the transaction and open after it.
- **Static audit (this worktree).** Every crypto call site seals or opens outside any transaction body:
  - seals: `src/engine/body/frames.ts:57, :108`; `src/engine/runtime/reseal.ts:51`;
    `src/engine/body/checkpoints.ts:287, :332`; `src/engine/blobs/blobStore.ts:55`;
  - opens through the ingest gate (`gateRow`): `src/engine/runtime/liveIngest.ts:194`;
    `src/engine/sync/catchUp.ts:189`; `src/engine/runtime/quarantineRelease.ts:48, :144, :169`;
  - other opens: `src/engine/runtime/mirrorIo.ts:158`; `src/engine/blobs/bodyRefs.ts:87`;
    `src/engine/blobs/blobStore.ts:96`.

  The engine is changing in parallel, so this is re-checked by test, not by reading.
- **Why a suite-0 sim cannot see it.** The suite-0 ports resolve on microtasks: `createNoopCrypto`
  (`src/engine/adapters/noopCrypto.ts:13`), `identityCrypto` (`src/core/codec/envelope.ts:268`) and the sim's
  HashPort (`src/sim/hash.ts:1-5`). `MemStoragePort` trips `tx-inactive` only when a body awaits a macrotask
  (`src/sim/storage.ts:29-44`).
- **Fix (WP-E7, built).** `DelayedCrypto` settles every CryptoPort, KeyringCrypto and HashPort call after a real
  `setTimeout(0)` (`src/sim/delayedCrypto.ts:1-5`). Sim devices use it for suite 1 and unpinned
  (`src/sim/device.ts:193-195`), so a crypto or hash await inside a transaction fails the sim and the unit tests,
  exactly as on a device.
- **WP-E2 status.** E2 adds no IndexedDB path. frameNo allocation and sealing run on the edit chain before
  `repo.tEdit` (`src/engine/runtime/logApi.ts`), the gate opens before T_receipt, and the receipt only writes the
  already-known frameNo. The double came with WP-E7 (above).

## 17. Lost server features and client replacements

The rewritten server already verifies nothing about content (DECISIONS §2.1, D9). Suite 1 makes that a property
rather than an accident.

| Feature (legacy or possible) | Under suite 1 | Client replacement |
|---|---|---|
| Server check that a blob's bytes match its sha256 | Impossible: opaque address | AEAD tag plus sha256 after open (`getOpened`, `src/engine/blobs/blobStore.ts:98-100`; body refs use it too, `src/engine/body/refs.ts:49`) |
| `X-YAOS-Content-SHA256` / `-Size` headers | Would leak the plaintext hash and size. At 7208184 they are only still named in the CORS expose list (`server/src/http.ts:7`); nothing sets or reads them | The client never sends them. Server ask A2 removed the stale names (cd335f64) |
| Server-side debugging of content | Impossible | Diagnostics carry `HMAC(kDiag, ·)` hashes (§6.4). The user shares a bundle and correlates locally |
| Point-in-time restore (D8b) | **Still works**: opaque rows rewind | Old keys stay in the keyring. `k` is re-published (§11.5) |
| Blob garbage collection | The server cannot see references | Client mark-and-sweep on a user command, over the A3 list and batch delete (§10.4, WP-E6b) |
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
/** Sealed blob as parts in order; the stored object is their concatenation. Suite 1: [header ‖ nonce, AES-GCM output]. */
export type SealedBlobParts = readonly Uint8Array[];
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
  /** Whole sealed-blob format incl. header and padding (§10.2), as parts. Suite 0: identity. */
  sealBlob(input: { readonly address: BlobAddress; readonly plaintext: Uint8Array }): Promise<SealedBlobParts>;
  openBlob(input: { readonly address: BlobAddress; readonly sealed: Uint8Array }): Promise<OpenResult>;
  blobAddress(hash: ContentHash): Promise<BlobAddress>;
  /** Diagnostics digest, 16 hex chars. Suite 0: sha256 prefix; suite 1: HMAC(kDiag, bytes) prefix (§6.4). */
  diagHash(bytes: Uint8Array): Promise<string>;
}

/** Suite-1 adapter only; used by the keyring engine (WP-E3). Raw keys never cross this interface outward. */
export interface KeyringCrypto {
  generate(e: number): Promise<void>;                                  // new K_e, held as pending
  install(e: number, raw: Uint8Array): Promise<"installed" | "same" | "conflict">; // QR / RK path; zero-fills raw
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
  The callers classify through `getOpened` (`src/engine/blobs/blobStore.ts:90-102`): `src/engine/body/refs.ts:49`,
  `src/engine/blobs/blobQueue.ts:584` and `src/engine/snapshots/remote.ts:83`.
- **The suite-0 adapter** (`src/engine/adapters/noopCrypto.ts`) and `identityCrypto`
  (`src/core/codec/envelope.ts`) implement the new shape. `sealEpoch()` returns 0.
  - core hashes content only through an injected HashPort (`digestHex`, `src/core/hash/digest.ts:11`). Its pure-JS
    sha256 takes at most `SYNC_HASH_MAX_BYTES` = 4096 B and throws a RangeError above it, in production too
    (`src/core/limits.ts:100`, `src/core/hash/sha256.ts:22-23`). So `identityCrypto(hash?: HashPort)` takes an
    optional HashPort for `diagHash`; without one, `diagHash` throws. `DIAG_HASH_HEX_CHARS = 16` lives in
    `src/core/codec/envelope.ts`.
- **The suite-1 adapter is new**, at `src/engine/adapters/webCryptoSuite1.ts` (WP-E1), with the primitives in
  `suite1Primitives.ts`. It holds non-extractable CryptoKeys only, plus the raw bytes §6.3 step 2 allows.
  - `sealEpoch()` is 0 until `setSealEpoch`, so a fresh port seals nothing. `seal` throws under an unheld or
    unverified epoch; `setSealEpoch` throws unless the key is verified, and never moves backwards.
  - `open` checks in this order: suite 0 → `suite-downgrade`; suite ≠ 1 → `unsupported-suite`; epoch not held →
    `unknown-key`; sealed < 28 bytes → `malformed`; then the tag. No trial decryption across epochs.
  - `wrap` throws if the raw key it needs is no longer retained (§6.3). `unwrap` returns false and never throws on
    bad bytes, a missing wrapping key or a short RK; a payload for an already-verified epoch is discarded (true).
  - `install` and the constructor's `keys` zero-fill the caller's buffers. `install` refuses to replace a verified
    epoch. `drop` refuses the seal epoch. `exportForHost` returns each not-yet-exported key once.
  - `blobAddress` and `diagHash` need K_1 (§5.1). A device holding a later K_e reaches K_1 down the prevWrap chain
    (§11.1) before it addresses any blob.

### 18.2 Envelope, codec, limits, fold

- `src/core/envelope.ts`:
  - `CryptoSuite = { none: 0, aes256gcm: 1 }`, replacing the reserved `xchacha20poly1305: 1`;
  - `AAD_FRAME_PREFIX = "yaos/f2"`, `AAD_CHECKPOINT_PREFIX = "yaos/c2"` and the new `AAD_BLOB_PREFIX = "yaos/b2"`,
    `AAD_KEYRING_PREFIX = "yaos/k2"`;
  - the inner layout gains `varuint frameNo` after `flags`. It is 0 for kinds outside ns and cfg, and non-zero
    for ns and cfg (§8.2). A violation is `malformed` on decode and a `CodecError` on encode;
  - `EnvelopeOpenResult.reason` gains `"suite-downgrade"` and `"bad-padding"` (§9.2). Replay is a fold
    decision, not an open failure: `NsIgnoreReason` (`src/core/types.ts:253`) and the cfg equivalent gain
    `"replay-stale"`, `"replay-duplicate"` and `"stale-epoch"` (§8.2, §14.3);
  - `CheckpointEncoding`: `nsFoldV1` and `cfgFoldV1` are redefined in place to carry the replay window (named
    V2 in this document).
- `src/core/codec/envelope.ts`:
  - `bindingAad` (lines 188-192) writes the §7.2 fields: header plus deviceId for frames, header for checkpoints;
  - padding (§7.3) is applied when `suite ≠ 0`, between the inner encoding and `seal`, and stripped after `open`;
  - `sealEnvelope` / `openEnvelope` are the one seal/open implementation (`src/engine/ingest/envelope.ts` wraps
    them). They check the kind against the stream class; checkpoint *content* checks (coversSeq, encoding, size)
    stay in the ingest gate. Since WP-E3, `k` rows are not envelopes: the gate stores them as `keyRecord` tail
    rows and the keyring decodes them (§11.1).
- `src/core/types.ts`:
  - `NsFoldState` and `CfgFoldState` gain `readonly replay: Map<DeviceId, { r: number; bits: bigint }>` (64-bit
    window);
  - `StreamClass` gains `"keyring"`, and `streamClass("k") === "keyring"`;
  - `blobChunkStream(address: BlobAddress)` (later deleted with the `x:` carrier).
- `src/core/limits.ts`:
  - `MAX_FRAME_CONTENT_BYTES` (:60) is 1015808, down from 1 MiB − 4 KiB (§7.3);
  - new `MAX_BLOB_PLAINTEXT_BYTES_SUITE1 = 10223615`, since deleted: suite 1's cap is derived from the transport cap
    (§7.3);
  - new `REPLAY_WINDOW = 64` (:38) and `PADME_FLOOR_BYTES = 256` (:78) (WP-E2);
  - `ROLL_SEQ_SPAN = 2 ** 23` (:86) and `ROLL_OWN_SEALS = 2 ** 22` (:88) landed with the roll (WP-E3), and
    `KEY_STORE_WAIT_MS = 5000` (:179) with host key storage (WP-E4): constants arrive with their first user.
- `QuarantineReason` (`src/engine/store/schema.ts:228`) gains `"crypto-downgrade"` and `"envelope-padding"` (WP-E2),
  and `"stale-epoch"` (a stale checkpoint, treated as absent) and `"keyring-hold"` (§14.3 undecided; re-gated after
  the next keyring change) (WP-E3).

### 18.3 IndexedDB (`src/engine/store/schema.ts`)

| Store / record | Change |
|---|---|
| `OutboxRecord` (:190) | + `frameNo: number \| null` (ns/cfg; WP-E2). + `keyEpoch: number` (the epoch inside `sealed`, for the revoke re-seal, §14.2 step 4; WP-E3). An empty `sealed` is an unsealed copy of an own stale commit, sealed before sending |
| `TailRecord` | + `frameNo: number` (0 outside ns/cfg and for rows that failed the gate; WP-E2). Own rows carry the allocator's max across restarts (§8.2) |
| `MetaRecord` | + `MetaKeyring {key: "keyring"; sealEpoch; epochs: {e, firstSeq, kind, verified}[]; revokeEpoch: number \| null; sRot: Seq \| null; ownSeals: number}`. **No key bytes** (§6.1) |
| `MetaRecord` | + `MetaFrameNoFloor {key: "frameNoFloor"; ns: number; cfg: number}`, written by epoch migration (§8.2) |
| ns and cfg fold state records | Carry `replay` (V2 encoding) |
| `StreamRecord.cls` | Accepts `"keyring"` |
| `tail` for `k` | Holds `k` records like any stream. There is no snapshot, since `k` has no checkpoints |

No store or index is added or removed, so `upgrade()` (`src/engine/adapters/idbStorage.ts:465`) is unchanged.

### 18.4 Protocol (`src/protocol/*`)

```ts
// messages.ts — EngineInitConfig (:51) gains:
/** SECRET (keys): never logged or echoed. Buffers are transferred, and main keeps no copy (§6.3). */
readonly crypto:
  | { readonly suite: null; readonly creating: boolean }   // unpinned (§12.4): reads `k` only, writes nothing
  | { readonly suite: 0 }
  | { readonly suite: 1; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[] };

// UserCommand (:203) gains (all SECRET payloads, transferred):
| { readonly t: "enableE2ee"; readonly rk: Uint8Array }                       // creation path only (§15.1): genesis at head = 0
| { readonly t: "installKey"; readonly source: "qr"; readonly e: number; readonly k: Uint8Array }   // §12.1, §14.2 step 3
| { readonly t: "installKey"; readonly source: "rk"; readonly rk: Uint8Array }                      // §12.4, §13.3
| { readonly t: "pinSuite0"; readonly source: "link" | "create" }             // §12.4 (ii) / (iii): ok only if `k` is empty at head
| { readonly t: "revokeRekey"; readonly rk: Uint8Array }                      // §14.2; a new RK is generated on main

// EngineToMain (:304) gains (a request, like hostIo: main answers `result` or `error` with the same rid):
| { readonly t: "keyringChanged"; readonly rid: RequestId; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; // SECRET
    readonly records: readonly Uint8Array[]; readonly pending: number | null }   // main persists before replying

// MainResultValue gains the reply:
| { readonly t: "keyringStored" }   // keyringChanged is stored (persist-before-use)

// ProtocolErrorCode gains:
| "refused"   // a key or pin command the device's pin, state or `k` does not allow; also main's answer to a
              // keyringChanged it must not store (a suite-0 pin). Not retryable.
// PROTOCOL_VERSION 2 → 3.
```

- **`keyringSeen` is not in `init.crypto`** (the shape above is kept verbatim). The engine starts with
  `keyringSeen: false` and reports it in `status.e2ee` once it reads a `k` record; main stores the sticky flag
  from there and enforces it when it handles `pinSuite0 {source: "link"}`
  (`src/engine/compose/vaultRuntime.ts` `e2eeOf`).

- `status.ts`: `EnginePhase` gains `"key-missing"`, already named in DESIGN §c.3. `StatusSnapshot` gains
  `e2ee: { suite: 0 | 1 | null; sealEpoch: number; keyMissing: "no-pin" | "no-key" | "revoked-epoch" |
  "encrypted-vault" | null; keyringSeen: boolean; creatable: boolean }`. There are no secrets in status.
  - `suite: null` is an unpinned device (§12.4).
  - `StatusSnapshot.e2ee` is declared optional only so that older snapshot literals type-check; the engine always
    sets it.
  - `creatable` is true only for an engine started with `creating: true` that has read `VAULT_READY.head = 0` and
    an empty `k` (§15.1 step 3).
  - **The engine never sets a pin.** Main sets it from (i) `keyringChanged` after a verified key, (ii) and (iii)
    from a successful `pinSuite0` or `enableE2ee`. Main then restarts the engine with the pinned config.
  - `enableE2ee` and `pinSuite0 {source: "create"}` are refused unless `creatable`. `pinSuite0 {source: "link"}`
    is refused if `keyringSeen` or `k` is non-empty.
- **Persist-before-use.** The engine does not seal under a new epoch until main acknowledges `keyringChanged`
  (the result of the same rid). A crash can therefore never leave committed rows under a key no device stored.
- The RK and QR keys are generated and shown on main (UI). The worker never displays them, and main never logs them.
- SECRET buffers (`init.crypto` keys, the command's `k` / `rk`, `keyringChanged` keys) are always in the transfer
  list, and the sender zero-fills whatever it still holds after posting (`wipeSecrets`, `src/protocol/workerTransport.ts`).
  A command main refuses itself is zero-filled on main and never posted.
- **Unpinned engine and suite 1 without the key (WP-E4).** `PinGate` (`src/engine/compose/pinGate.ts:128-168`)
  hands a VaultRuntime its ports only for suite 0, or for suite 1 once the stored keyring has the newest winner's
  key verified (`keyMissing() === null`, `:117-126`). Any other start runs the KeyReader (`keyReader.ts`).
  - Its relay session is read-only: `canWrite` is false, `append` throws, `putCheckpoint` rejects. The exception
    is the creation path, where it may append on `k` only, for the genesis.
  - It gets no storage, blob or hash port, and only the adapter's key operations, so it cannot write a frame,
    checkpoint, blob, ns entry, outbox or mirror.
  - It answers the key commands (§12.4 "As built"), and refuses `cleanUpAttachments` with
    `refused: "keys-unverified"` (`keyReader.ts:188-191`).
  - On an unpinned device, main pins suite 1 from the stored `keyringChanged` and restarts the engine. A suite-1
    device opens in the same process once main stores the key (`protocolEngine.ts:298-310`).

### 18.5 relay-wire.md

| Section | Change |
|---|---|
| §1 Model | Note that stream `k` (keyring) is client-defined and opaque to the relay, like every stream |
| §2.4 Enroll | "Any client-only key part of a setup link is stripped before `/enroll`" (DECISIONS D3) |
| §11.3 Blobs | **Applied** (server ask A1): opaque `^[0-9a-f]{64}$` addresses, no hash verification, R2 key `v/<vaultId>/<address>`, PUT overwrites, ≤ `maxBlobUploadBytes` (100 MB), no `X-YAOS-Content-SHA256` / `-Size` (A2) |
| §11.1 Limits | Note that suite-1 payloads are padded, so the client caps content at 1015808 bytes (§7.3) |

### 18.6 DESIGN.md diffs

Applied so far: the §j.1 `x:` stream naming (WP-E6a: DESIGN §b.2, §b.4, §b.6, §d.6, §j.1 then said `x:<address>`).
The `x:` carrier was later deleted, so the §j.1 hunk below is superseded: blobs travel only via the blob store.
**Applied (E8):** every hunk below is now in DESIGN.md, as built. Differences from the hunks: the AAD header is
`u8 formatVersion ‖ u8 suite ‖ varuint keyEpoch`; the replay window sits inside §c.3 step 2, after the ring hit test,
and frameNo 0 never reaches it (decode rejects it; failed rows are stored with frameNo 0 and fold as empty); the `k`
row says commit-only and no checkpoint (the hunk's "yes" was not a broadcast value); stale-epoch snap rows are
accounted, not stored; the keyring read is §d.7 step 3a, after the feed, not step 0; the §j.1 `x:` hunk stays superseded.

```diff
 §b.1 Envelope
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

 §c.3 Frame-level rules
+2a. **Replay window** (ns/cfg). frameNo `f` vs per-device (R, 64-bit bitmap): f = 0 malformed; f ≤ R−64 or a
+    set bit → `ignored/replay-*`, fold as empty. Update only after open and decode (e2ee-design §8.2).
-own ns frame `k` may be sent only when every own ns frame ≤ `k − NS_SEND_WINDOW` (32) is receipted;
+own ns frame with frameNo `f` may be sent only when every own frame with frameNo ≤ `f − NS_SEND_WINDOW` is receipted;

 §d.6 Ingest gate table gains rows:
+| `suite-downgrade`, `bad-padding`, `auth-failed` under a verified key | deterministic (as malformation) |
+| `auth-failed` under an unverified key | reader-dependent |
+| stale-epoch (e2ee-design §14.3) | ignored; ns/cfg fold as empty; bodies not quarantined |

 §d.7 Catch-up
+0. **Keyring.** Read `k` to head and settle keys (e2ee-design §11.3) before any other stream.

 §h Ports: replace the CryptoPort block with e2ee-design §18.1.

 §j.1 Blobs
-  - Attachments ≤ `MAX_LOG_BLOB_BYTES` (8 MiB) ride stream `x:<sha256>` as `blobChunk` frames
+  - Attachments ≤ `MAX_LOG_BLOB_BYTES` (8 MiB) ride stream `x:<blobAddress>` as `blobChunk` frames
+- **GC.** Client mark-and-sweep on the command "Clean up unused server attachments" (e2ee-design §10.4).

 §j.7 Diagnostics
-  - recent events (… **hashed** paths),
+  - recent events (… paths hashed with `CryptoPort.diagHash`: HMAC(kDiag) under suite 1),
+  - never key material, recovery keys or setup links.
```

## 19. Asks for the server rewrite

Baseline: 7208184. No ask is on the hot path, and none adds cross-DO coordination.

| # | Ask | Why | Priority |
|---|---|---|---|
| A1 | Rewrite relay-wire §11.3 to DECISIONS §5 row 11.3: opaque `^[0-9a-f]{64}$` addresses, no hash check, R2 key `v/<vaultId>/<address>`, PUT overwrites | The doc described sha256 addresses that the server verifies | **Done** (relay-wire §11.3) |
| A2 | Drop `X-YAOS-Content-SHA256, X-YAOS-Content-Size` from `CORS_EXPOSE_HEADERS` (`server/src/http.ts:7`) | Stale names for plaintext-revealing headers. Nothing sets them, but they invite reintroduction | **Done** (cd335f64) |
| A3 | `GET /vault/:id/blobs?cursor=` → `{items: [{address, uploadedAt}], next}` (R2 `list` with prefix `v/<vaultId>/`), and a batch conditional delete `POST /vault/:id/blobs/delete {"ifUploadedBefore", "addresses"}` (1–100; R2 `head`s, then one `delete`). Device bearer. Cold path, 60 requests/min per vault | Blob GC (§10.4). Without it, blobs live until the vault is deleted, under any suite | **Done** (relay-wire §11.3.1); used by WP-E6b |
| A4 | `POST …/blobs/exists`: answer `400` on a malformed entry instead of silently dropping it (`server/src/router.ts:624-650` filters with `BLOB_ADDRESS_PATTERN`) | A client bug in HMAC addressing would look like "absent" and cause re-uploads forever | **Done** (29619150: `400 invalid_address`) |
| A5 | Keep restore carrying the pre-restore device rows (already true, DECISIONS D8b "Crosses the rewind: the device rows only") | A revoked device must stay revoked after a restore (§14.3) | Confirm only |
| A6 | Keep minting a fresh random epoch on reset and restore (already true, D8, D8a, D8b) | The client re-publishes `k` on a new epoch (§11.5) | Confirm only |
| A7 | *(withdrawn)* Neutral device names. Already accepted: any string, de-duplicated by `uniqueDeviceName` (`server/src/vault/host.ts:544`) | | None |
| A8 | Rename "vault key" in `server/src/vault/ticket.ts` (DECISIONS D4) to "ticket key" in code and docs | Avoids confusion with K_e in reviews and in incident response | **Done** (f3ef81ba) |
| A9 | Keep stream names opaque: no server-side meaning for `k` or any prefix (`server/src/streams/protocol.ts:62-63`, `:53`) | `k` needs no server change | Confirm only |
| A10 | Keep `MAX_STREAM_CHECKPOINT_BYTES` (`server/src/streams/protocol.ts:25`, 4 MiB) and the 1 MiB frame cap stable, or announce changes in VAULT_READY limits | Suite-1 padding is computed against them (§7.3) | Confirm only |
| A11 | *(conditional)* Let the plugin's creation path (§15.1) reach `/claim`, `/operator/login`, `/operator/vaults` and `/operator/vaults/:id/owner-code`. Today they demand a same-origin `Origin` (`crossSiteRejection`, `server/src/router.ts:124-129`). Proposed change, in `crossSiteRejection`: `const origin = request.headers.get("Origin"); if (origin === null ? !needsJson : origin !== url.origin) return json({ error: "forbidden_origin" }, 403);` and keep the `application/json` check. A cross-site page cannot send a JSON POST without a CORS preflight the server never approves, and browsers always send `Origin` on such POSTs, so a request with no `Origin` and a JSON body comes from a non-browser client | E5 sends `Origin` explicitly (`src/host/ui/pairing.ts:552-556`), and the relay accepts it from Node's fetch (`e2e/client/e2ee.ts`). Needed only if WP-E0 shows that Obsidian's `requestUrl` drops or rewrites the header (§23.3). Without it a device cannot create a vault, so no vault can be set up | Only if WP-E0 finds it needed |

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
  - Split by package, since each lands with the code that produces it:
    - **WP-E1** (`src/engine/adapters/suite1Golden.test.ts`): kcv for K_1 and K_2 (= 20..3f), kAddr of
      sha256("abc"), kDiag, raw frame and checkpoint seals (fixed AAD), a frame under K_2, one sealed blob, and
      next/prev/recovery wraps (fake 35-byte RK = 40..62; fixed AAD, since wrap AAD §11.2 is WP-E3);
    - **WP-E2** (`src/engine/adapters/suite1Envelope.test.ts`): one envelope per kind with the §7.2 AAD and padding;
    - **WP-E3**: genesis/roll/revoke records and the RK encoding;
    - **WP-E5** (`src/host/ui/pairing.test.ts:447-467`): the `key` value for K = 00..1f at e = 1 and e = 300 (varuint
      `ac 02`), the full setup link with a fixed pairing code, its `suite=0` form and the re-key link, each
      decoded back.
  - **Cross-checked by a second implementation** in the test: Node `node:crypto` (`createCipheriv`, `hkdfSync`,
    `createHmac`), not WebCrypto, so one implementation's bug cannot certify itself.
- Codec property tests: Padmé round-trip and bucket monotonicity, varuint and base32 round-trips, and
  canonical-encoding rejection (as in WP-A).

### 20.2 Tamper, replay and downgrade (measured, WP-E7)

Each test counts outcomes and asserts **all** of them; none samples a single case.
- **Bit flips.**
  - For every sealed type (frame, checkpoint, blob, k wrap), flip each byte of header, nonce, ciphertext and tag:
    every byte for objects ≤ 4 KiB, and 4096 seeded positions otherwise.
  - Assert `failures == flips`, with the expected reason per region: header → any open failure (the §9.2 and §10.2
    header rules decide which: `malformed`, `unsupported-version`, `unsupported-suite`, `suite-downgrade`,
    `unknown-key` or `auth-failed`; the test predicts each one and asserts the count per reason); nonce, tag or
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
  (`src/sim/run.test.ts:65-69`: 200, 200, 50 and 50 seeds, plus 20 for the blob stall/slow faults added with the
  background transfer queue, 3fecf30c). The invariants (`src/sim/invariants.ts`) must hold.
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
  - The sim form runs in `test:client` (`src/host/keys/atRest.test.ts`): it scans the fake IndexedDB, `data.json`
    saves, side files, local storage, the vault, logs, statuses, notices and relay rows for raw bytes, hex,
    base64(url), decimal lists and typed-array JSON, outside the vault's own SecretStorage entry. It reports counts
    only. A second test runs a key-holding suite-1 VaultRuntime (enableE2ee, a join by RK, `revokeRekey` to K_2)
    and adds both diagnostics bundles (with and without paths) and their formatted text to the scan.
  - The e2e form (`e2e/client/e2ee.ts`, local relay, R2 by default) scans the same encodings after a run of every key
    flow. It covers the diagnostics bundles, `data.json`, the fake IndexedDB, logs, statuses and notices, the
    vault, side files, the relay's state dir (DO SQLite and emulated R2) and its log, and its own results file.
    Positive controls prove that both scans find a key where one is.

## 21. Work packages

There is one agent per package. Sizes: S ≈ 1 agent-day, M ≈ 2–3, L ≈ 4–6. Every package passes
`npm run -s typecheck:client`, `node scripts/check-deps.mjs` (0/0) and `npm run test:client`.

| WP | Scope (owned paths) | Depends on | Done when | Size |
|---|---|---|---|---|
| **E0** Device runs | `src/host/spike/**`: add a SecretStorage probe (set/get/restart, 64 KiB value, `""`, locked device) and an Android `obsidian://` QR scan check (iOS is [User]-confirmed, §23.3) | none (needs a human with devices) | §23.3 open rows filled with [M] rows | S |
| **E1** CryptoPort + suite-1 adapter | `src/ports/crypto.ts` (§18.1), `src/engine/adapters/webCryptoSuite1.ts`, `noopCrypto.ts`, `identityCrypto` | none | §20.1 KATs and golden vectors pass under Node WebCrypto and the `node:crypto` cross-check; 12-byte nonce check; non-extractable keys only | M |
| **E2** Envelope v2 | `src/core/envelope.ts`, `src/core/codec/**` (AAD v2, Padmé, frameNo, fold V2 encodings), `src/core/{ns,cfg}/**` (replay window), `src/core/limits.ts`, the send window over frameNo, `diagHash` in the diagnostics bundle (`src/engine/compose/diagnosticsBundle.ts`) | E1 shape | Codec round-trips; replay window unit tests including the §8.2 exactness argument as a property test; suite 0 still passes the whole suite | M–L |
| **E3** Keyring engine | `src/engine/keyring/**` (record codec, validity, winners, roll, revoke, re-publish, stale-epoch), the catch-up order (`k` first), phase `key-missing` | E1, E2 | §11 and §14.3 rules as unit tests; the forged-roll and duplicate-record tests in §20.2 | L |
| **E4** Host key storage + protocol | `src/host/keys/**` (SecretStorage adapter, 5 s wait, pin incl. unpinned and `keyringSeen`, Linux notice), `src/protocol/**` (§18.4: unpinned config, `pinSuite0`), persist-before-use; the engine's unpinned mode (reads `k` only) | E1 shape | Restart keeps keys; IDB wipe keeps keys; at-rest leak check (§20.3) is zero; an unpinned engine issues zero writes | M |
| **E5** Pairing, RK, revoke UX | `src/host/ui/**`: QR (`qrcode`), the `key`/`suite` link parameters stripped before `/enroll`, the blocked key-less screen (§12.4), the "Create a new vault" creation path with its `Origin` check first (§15.1), RK show/confirm/enter, revoke re-key, re-key QR, hiding `mobileSetupUrl` under both suites, device-name hint | E3, E4 | **Done** ("E5 as built" below). UI tests for each flow; `/enroll` request bodies asserted key-free; the link is never in logs; no path from a link, code or console QR reaches the creation flow or a suite-0 pin | L |
| **E6a** Blob addressing and format | `src/engine/body/frames.ts` blob path, `src/engine/blobs/blobQueue.ts`, `src/engine/body/refs.ts`, `src/engine/runtime/blobChunks.ts`, `blobChunkStream(address)` (these two later deleted with the `x:` carrier) | E1, E2 | Sealed-blob golden vector; dedupe via `has`; `x:` names carry no hash | S |
| **E6b** Blob GC | `src/engine/blobs/{gc,bodyRefs,touch}.ts`, `src/engine/runtime/blobGc.ts`, `BlobPort.list/deleteIfUploadedBefore` (HTTP adapter, `SimBlobStore`), the `cleanUpAttachments` command and its one notice | **A3** (done) | **Done.** §10.4: fail-closed preconditions, live set, R1–R4. Unit and engine tests against `SimBlobStore` (pagination with deletes, re-upload survives as `newer`, R2 orphan reuse, R3 resume after > grace offline, R4 repair and loss, every refusal deletes nothing, suite 1 HMAC addresses, 429/503 retry, skewed clock); e2e/client/snapshots.ts GC step on the local relay (R2 by default) | M |
| **E7** Verification | `DelayedCrypto`, sim `crypto: "suite1"`, new faults, the §20.2 measured tests, a perf bench against the §16 budgets | E1–E3 | **Done** ("E7 as built" below). The suite-1 fault matrix is green at suite-0 seed counts; every §20.2 assertion holds | M |
| **E8** Docs | Apply §18.5 and §18.6 to relay-wire.md and DESIGN.md | E2 merged | Docs match the code | S |

Order: E0 ∥ E1 → E2 ∥ E4 → E3 ∥ E6a → E5 ∥ E7 → E8. E6b needed A3 (done).

**E3 as built** (where the code differs from the text above; the sections cited are updated):
- §18.4 protocol shapes landed with E3, not E4: `init.crypto`, the five UserCommands, `keyringChanged` (with a
  `rid`), the `keyringStored` reply, the `"refused"` error code, `StatusSnapshot.e2ee` and phase `key-missing`.
  With E4 integrated, main stores `keyringChanged` (refusing it only on a suite-0 pin) and starts each device
  from its pin (§12.4 "As built").
- One write gate (`src/engine/keyring/writeGate.ts`): while `keyMissing` is set, the engine's crypto port
  (`gatedCrypto`) refuses to seal and its blob port (`gatedBlob`) refuses to upload or delete; the sender holds the
  outbox, doc frames are not closed and maintenance writes no checkpoint. The BlobQueue, the SnapshotJob and blob
  GC use the gated ports too (§12.4 "As built"). An open revoke shuts it (`revoked-epoch`).
  There is no "absent means suite 0" default anywhere in the engine.
- §14.3 is decided at gate time with hold and re-gate; own stale commits become unsealed copies (§14.2 step 4).
  Unopened rows are re-gated after every keyring change, which also ends the old halt on ns rows under an
  unknown key.
- An RK that does not open a genesis or revoke `recoveryWrap` leaves the record pending, not invalid: a wrong or
  older RK cannot be told from a forged wrap (`src/engine/keyring/evaluate.ts:92-93`). A device that only has an RK
  older than the latest revoke needs the re-key QR.
- An in-engine runtime restart (a new vaultEpoch, or a retry) reuses the ports, so the crypto port keeps keys
  learned since init.

**E4 integration as built** (E3's names and shapes are kept; §12.4 "As built" and §18.4 hold the details):
- **One gate for closed devices.** `PinGate` covers both unpinned devices and suite-1 devices without the key. The
  separate suite-1 "closed until E3" path is gone. A suite-1 device opens in process once main stores its key;
  an unpinned one is pinned by main and restarted.
- **One in-session gate.** It is `writeGate.ts`, and every blob write, the BlobQueue's and the SnapshotJob's
  included, now goes through `gatedBlob`/`gatedCrypto`. Blob seals count toward the §4.2 roll trigger like frame
  seals.
- **Host keys.** `HostKeyring.persist` is the `keyringChanged` round trip. Main merges the change into
  SecretStorage, replacing a re-exported key for the same epoch (`src/host/keys/secretStore.ts`), and pins only on
  an unpinned device with nothing pending.
- **K_1 after a roll** verifies down the prevWrap chain, so blob GC keeps requiring it (§10.4).
- **End to end:** `e2e/client/e2ee.ts` (enableE2ee, installKey by QR and RK, a sealed note and attachment, a console
  revoke plus re-key, a post-roll join, GC, leak scan) on the local relay.

**E5 as built** (the UI over E3/E4's commands; main does UI and raw I/O only, every check that hashes or reads `k`
runs in the engine):
- **Pure modules, thin modals.** The decisions live in modules with no Obsidian runtime, unit-tested over a fake
  host (`src/host/ui/testkit/fakeUiHost.ts`): `createVault.ts` (§15.1), `keyActions.ts` (links, keys, re-key),
  `recoveryKeyText.ts` (§13.1 text form), `e2eeText.ts` (every user-facing sentence, and the engine refusals mapped
  to plain ones) and `hostWait.ts` (waits on host changes, no polling). The modals (`createVaultModal.ts`,
  `keyModals.ts`, `pairModal.ts`) only draw and call them; they are not unit-tested (Obsidian runtime).
- **Pairing QR (§12.1).** "Pair another device" (`PairingCodeModal`, `src/host/ui/pairModal.ts:223-363`) draws the
  QR itself (`qr.ts`) only after "Show pairing QR", hides it when the code expires or the dialog closes, and blanks
  the canvas. The link's encryption part is `pairingLinkE2ee` (`keyActions.ts:161-167`): `suite=0` on a suite-0
  device, else the key of the epoch this device seals under from SecretStorage (`vaultKeyForQr`,
  `src/host/pluginController.ts:389-401`), else nothing (the modal says why and offers only the code). "Copy setup
  link" carries the §12.1 warning. The link is never logged or put in a notice.
- **Incoming links** go through `routeSetupLink` (`keyActions.ts:42-61`), called by the protocol handler
  (`registerUi.ts:220-225`): ignore, apply or pair, never create. A setup link whose pairing code names the vault
  this device is enrolled in, on the same host, only applies its `key` or `suite=0` (no re-enroll, §12.4); a re-key
  link `obsidian://yaos?action=rekey&key=…` (`buildRekeyLink`, `src/host/ui/pairing.ts:797`) needs a paired device. A key goes
  to the engine as `installKey` "qr" and is zero-filled (`applyLinkE2ee`, `keyActions.ts:111`); while no record
  matches it the key stays in engine memory only, and the blocked screen says so (`PendingQrKeys`,
  `keyActions.ts:239`). The pair modal shows "End-to-end encryption: On" or "Off (from this link)" before pairing
  (`pairModal.ts:116-119`) and the device-name hint "Visible to the server operator" (`:149`).
- **Blocked screen (§12.4)**, `KeyMissingModal` (`keyModals.ts:51-94`): the reason text for `no-pin`, `no-key`,
  `revoked-epoch` or `encrypted-vault` (`e2eeText.ts:17`), a note while a QR key is pending, and exactly two
  buttons, "Scan QR from one of your devices" (it says where the QR is) and "Enter recovery key"
  (`EnterRecoveryKeyModal`, `installRecoveryKey`, `keyActions.ts:140`: format and checksum first, then
  `installKey` "rk"). The status bar opens it in phase `key-missing`; the command "Enter recovery key or scan a QR
  code" and the settings "Encryption" group (actions only, no status rows) reach it too.
- **Create a new vault (§15.1)**, `CreateVaultModal` (`createVaultModal.ts`) over `createVault.ts`:
  - offered and started only unpaired, or paired with the vault's pin and key (`canCreateVault`,
    `commands.ts:18-22`): the command, the settings action and the modal's first screen check it, and
    `createAndEnroll` refuses "blocked" before any request (`createVault.ts:114`). A blocked device only takes a
    key (§12.4);
  - step 1 `createAndEnroll` (`createVault.ts:113-136`): claim (unclaimed: the operator key is generated on main,
    shown with Copy, and "I saved the operator key" enables the claim) or operator login, create, owner code and
    logout (claimed: the key is typed). The key is cleared from the modal as soon as step 1 returns. Main writes
    `creating: {vaultId}` right after the response (`:117`);
  - step 2 enrolls with the in-memory code, which must name that vaultId (`:121`); no `pendingEnrollment`. A
    failure before the identity is stored drops the marker;
  - step 3 `confirmEmptyVault` (`:180`) waits for `status.e2ee.creatable` (head 0 and an empty `k` read on this
    session). A key record or a head above 0 ends the flow with "The server returned a vault that is not empty"
    and no pin; a timeout keeps the marker, and "Finish creating this vault" resumes at step 3
    (`resumableCreation`, `:139`);
  - the choice: "End-to-end encryption: On" preselected (a new RK shown once, confirmed by retyping 2 random
    groups, then `enableE2ee`), or the opt-out, confirmed ("You cannot turn end-to-end encryption on later for this
    vault"), then `pinSuite0` "create".
  - Only `createVault.ts` sends `enableE2ee` or `pinSuite0` "create" or marks a vault, and only the modal reaches
    it, from the command and the settings action (source scans, `createVault.test.ts:356-389`); main refuses both
    without the marker (`pin.ts:68-79`). `pinSuite0` "link" comes only from a `suite=0` link.
- **Recovery key and re-key (§13.2, §14.2, D1, D8).** `RecoveryKeyModal` (`keyModals.ts:176-263`) shows the RK once
  with Copy and "Store it outside this vault: a password manager or paper", then asks for 2 random groups, and
  zero-fills on close. "Re-key after revoking a device" (`RekeyAfterRevokeModal`, `keyModals.ts:335`) takes the
  existing RK or "Generate a new recovery key"; a typed RK becomes the RK in force (D8, `keyActions.ts:210-211`).
  Then "Show re-key QR" (`RekeyQrModal`, `keyModals.ts:274`) draws the re-key link from the stored key, and says to
  re-key EVERY other device the user keeps.
- **Blob GC refusals** now say which gate refused: a closed device (`keyReader.ts`) or a shut in-session gate
  (`blobGc.ts`), `src/host/ui/attachmentsCleanup.ts:31-42`; the test reads both engine literals.
- **End to end** (`e2e/client/e2ee.ts`): device a creates its vault through `createVault.ts` on the fresh,
  unclaimed relay (claim with explicit `Origin`, marker before identity, step 3, encryption On); e creates a
  second vault on the claimed relay with the typed key and opts out; f is sent the encrypted vault by a lying
  create answer and is refused at step 3 with no pin. The leak scan covers the operator key and owner codes too.

**E7 as built** (verification; measured on an M4 Pro with Node 26.5):
- **The sim stays deterministic under suite 1.** `DelayedCrypto` (`src/sim/delayedCrypto.ts`) runs every WebCrypto
  call as RealWork and settles it on the virtual clock, in seed order. The same seed gives the same trace, the same
  digest and byte-identical sealed relay rows, whatever ran before in the process. An explicit plan replays the
  generated run, and ddmin still works (`src/sim/suite1.test.ts`, in `test:client`). Every suite-1 run asserts
  `strays == 0` (no crypto await outside RealWork). A crypto await inside a `runTx` body fails the sim (§16.3).
- **The matrix runs out of band:** `npm run test:sim-suite1` (`scripts/sim-suite1.mjs`; `YAOS_SIM_SEEDS`,
  `YAOS_SIM_JOBS`, `YAOS_SIM_MINIMIZE`). It is 700 runs in 7 matrices:
  - the suite-0 matrix under suite 1: 2 devices with no faults (200 seeds), 3 devices with seeded faults (200),
    5 devices (50), 2 devices fault-heavy (50);
  - `E2EE_FAULTS`: 3 devices (100), 4 devices (50), 2 devices fault-heavy (50).

  It took 194 s wall on 11 workers. 699 of 700 runs were clean, with 0 strays in every run. The one failure (3 devices,
  E2EE faults, seed 88) needed the sim's attachments on the log carrier, which was later deleted. Sim devices now get
  the net's blob store by default (`src/sim/device.ts:196-197`), and the matrix is 700 of 700 clean (156.6 s wall,
  seed 88 included). Since 3fecf30c the script also runs the 3-device blob stall/slow fault matrix (20 seeds, so 720
  runs in 8 matrices, `scripts/sim-suite1.mjs:29`); that count was not re-run for this document.
- **New faults** (`src/sim/e2eeFaults.ts`, weights in `E2EE_FAULTS`, `src/sim/faults.ts`; weight 0 in
  `DEFAULT_FAULTS`, so suite-0 plans draw as before):
  - `keyStoreLoss`;
  - `keyRoll`, concurrent on two devices half the time;
  - `revoke` with a re-key by QR (the RK is the fallback);
  - `epochRestore` to a relay snapshot up to 12 steps back;
  - `hostileReplay` of any row, `k` included;
  - `hostileDowngrade`: forged suite-0 body frames, plus a key-less join while `k` is hidden.

  Each run ends with these checks:
  - no file shows a forged frame;
  - every stored key record is in `k` in this vault epoch (§11.5);
  - every device seals under one epoch;
  - a release dismisses no genuine row;
  - the joiner ends `no-pin` with zero writes, then `encrypted-vault`;
  - the leak checks (§20.3).

  In the 3-device E2EE matrix:
  - rolls: 76 won, 23 lost;
  - revokes: 27 won;
  - QR re-keys: 117;
  - restores: 52;
  - injected rows: 445 replayed, 219 forged;
  - joins: 44 key-less, each refused at every step.
- **§20.2, measured:**
  - `src/engine/adapters/suite1Tamper.test.ts` and `src/engine/keyring/forgery.test.ts` (2763f7d);
  - `src/engine/sync/replay.measured.test.ts` and `src/engine/keyring/staleEpoch.measured.test.ts` (6337e46), over
    1000 seeds:
    - replays: 45,191 injected, 45,191 ignored, 2000/2000 digests equal;
    - stale epoch: 19,669 injected past S_rot, all stale, 0 quarantined;
  - `src/engine/compose/downgrade.test.ts` (6f8fad3). After the E5 merge (d66c0bc), b–e were re-pointed at E5's
    code paths:
    - b also runs E5's UI flows on every blocked device. It found "Create a new vault" reachable there: the command
      was always available, and `createAndEnroll` would claim, write the marker and re-enroll. Fixed fail-closed
      (`canCreateVault`, §15.1 "Not started on a blocked device"); a control shows the same server creates for an
      unpaired device.
    - c counts E5's key-command sites, each behind its guard, and the import graph that reaches them. It shows that
      createVault's two choices send nothing short of `creatable`, and that a `suite=0` link routed into a suite-1,
      suite-0 or `keyringSeen` device is refused on main.
    - d routes the 4 `suite=0` shapes `parseSetupLink` accepts (§12.4 source (ii)) through `routeSetupLink` and
      `applyLinkE2ee`: refused (`keyring-seen`) after the genesis, a re-pair and a restart.
    - e routes 19 link classes x 9 device states through `routeSetupLink`: §12.4's route every time, key-free
      `/enroll` bodies, and no marker call.

  Every assertion holds. The header row of the bit-flip test asserts the reason the §9.2 and §10.2 rules predict, not
  only `auth-failed` or `malformed`.
- **Open questions:**
  - (a) A re-sealed ns or cfg record, or one in flight below the epoch floor, holds the later frames of its stream
    (`src/engine/body/sender.ts:390-412`; `resealOrder.test.ts`).
  - (b) `keyringChanged` before `ready` is stored in arrival order. The first persist waits until SecretStorage has
    loaded (`src/host/keys/hostKeys.ts:50, :68`). A key main did not store is dropped from the adapter
    (`src/engine/keyring/keyring.ts:262-267`, `:331-336`; `persistBeforeReady.test.ts`).
  - (c) Of two concurrent geneses, the first in seq order wins. The other creator cannot judge it, so it stops at
    `pending` and does not adopt its own later record (`src/engine/keyring/evaluate.ts:50-51`, `keyring.ts:184`;
    `concurrentGenesis.test.ts`).
  - (d) The sim is deterministic under suite 1 (above).
  - (e) Blob seals count toward the §4.2 trigger (`src/engine/keyring/writeGate.ts:44-50`). Blob GC refuses
    `not-caught-up` before this connection's `k` read (`src/engine/runtime/blobGc.ts:114`;
    `rollTriggerGcGate.test.ts`).
- **Engine fixes the suite-1 sim found** (each with a failing test first):
  - A reader-dependent quarantine record keeps the whole row, so a re-gate on new keys can open it
    (`src/engine/sync/ingestRow.ts:102-107`).
  - A view on a frozen doc binds once the doc is released, and a quarantine freeze retargets bound views
    (`src/engine/runtime/context.ts:405`, `src/engine/compose/vaultRuntime.ts:356`).
  - A suite-1 session judges nothing before its `k` read (`src/engine/keyring/keyringRuntime.ts:157`).
  - Rows stored after a re-gate are re-checked (`src/engine/runtime/quarantineRelease.ts:159`).
  - Release works by stream (`src/engine/runtime/engine.ts:481-482`), and keeps `keyring-hold` rows
    (`quarantineRelease.ts:51`).
  - Rows a release applies move the stream's body version (`src/engine/store/repo.ts:728-730`).
  - An open revoke is stored and survives a reset (§11.5; `src/engine/keyring/book.ts:51`).
  - A §c.12 migrated loser's synced record is dropped, not moved to the winner (`src/engine/reconcile/diskJobs.ts:67`,
    `src/core/plan/planner.ts:505`). Otherwise its own text became the winner's sync point, and the winner's text
    read as the deletion of its edits.
- **§16.2:** `npm run bench:e2ee` meets every desktop MUST:
  - typing: 0.44 ms per frame after idle;
  - bootstrap S: 281 ms in batches of 48 and 229 ms with 8 lanes;
  - 10 MiB blob: 2.0 ms up and 2.0 ms down;
  - engine start: 0.33 ms;
  - third-party crypto: +0 KB;
  - E2EE code: 15.4 KB gzip.

  Blob temporaries (23c2783): uploads drop from 7 to 3 blob-sized buffers through `httpBlob` and from 4 to 2 in memory.
  Downloads stay at 3.
- **Blob cap = the platform's** (client-remake-cap): the relay takes 100 MB (Cloudflare Free/Pro), suite 1 derives
  98566143 from it (§7.3), and `MAX_BLOB_PLAINTEXT_BYTES_SUITE1` is gone. The attachment setting defaults to the
  most it allows (1 GiB) and offers at most what the vault's relay takes. A 413 refuses the blob, no retry (§10.3).
  `httpBlob` has no fixed timeout on put / get. Since 5a55d3be an idle window ends a transfer that moves no byte
  for `BLOB_TRANSFER_IDLE_MS` (60 s, `src/core/limits.ts:197`; the PUT runs over XMLHttpRequest for its upload
  progress), and the blob queue retries it after its backoff. Peak RSS at 95 MB is in §10.3; `httpBlob.get`
  dropped from 2.07 N to 1.08 N, and the sealed parts are no longer reachable during a PUT.
- **Checkpoint policy** (6aea9b1, DESIGN §d.9): the hot cap is 256 rows or 1 MiB, then 30 s idle. A settle
  checkpoint follows 2 min idle, capped at 1000 puts per device per day (≈ 4k rows, 4 % of the Free plan's 100k). A
  heavy day writes ≈ 2.5k checkpoint rows of ≈ 42.5k.
- **Accepted:**
  - A forged genesis that front-runs creation is a DoS only.
  - Two concurrent revokes under different RKs fork.
  - A stored forged open revoke survives resets. It is a DoS, capped at 4, and `revokeRekey` ends it.
  - A revoke a crash interrupts before its append is not resumed.
  - Quarantine eviction starts at 500 records, and `QUARANTINE_MAX_BYTES` is not enforced.
  - A device that took a roll before the revoker re-published stops and needs a re-pair.
  - A durability-retry frame lets later ns and cfg frames overtake it (`sender.ts:398-401`).
  - `revokeRekey` does not verify the RK before it proposes.
  - A crash between a rebind and its `nsDelete` shows the loser as a duplicate (no data loss).

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
| Obsidian `requestUrl`, desktop and mobile | "Create a new vault" on an unclaimed and on a claimed server | Are `Origin` and a manual `Cookie` sent as set, and does `Set-Cookie` reach `res.headers`? The flow sends them explicitly (`src/host/ui/pairing.ts:552-556`); only Node's fetch against the local relay is verified (`e2e/client/e2ee.ts`). A refusal shows `forbidden_origin` or `no_session`. (§15.1; server ask A11 if not) |
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
