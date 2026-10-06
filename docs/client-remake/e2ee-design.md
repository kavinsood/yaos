# YAOS client remake: crypto suite 1 (single-user E2EE)

Status: proposed, normative once accepted. Owner: architect. Extends [DESIGN.md](DESIGN.md); where this document
changes a shape named there, §18 gives the DESIGN diff. Scope is **single-user** end-to-end encryption: one person,
several devices, one vault. Shared E2EE vaults are out of scope. §2.4 lists what this design keeps open for them.

- Conventions as in DESIGN: MUST / NEVER are hard rules. "Alternative:" lines record a rejected option in one line.
- Evidence tags on claims:
  - **[M]** measured by the spike in this worktree (`src/host/spike/cryptoProbe.ts`, §23);
  - **[S]** read in a cited source (spec, RFC, paper or source file at a pinned commit);
  - **[D]** derived here by calculation from cited inputs (the calculation is shown);
  - **[U]** unverified: needs a device or is not stated anywhere I could find.
- Terms:
  - **K_e**: the 32-byte vault key of key epoch `e` (`e ≥ 1`). "Vault key" in `server/src/auth/ticket.ts` is the relay's
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
    once held is also possible, because PITR restore is a legitimate server feature ([CF-PITR]);
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
| Stream class (`b:` vs `c:` vs `x:` vs `ns`/`cfg`/`k`) | Accepted | The relay's provisional broadcast keys on `b:`/`c:` ([server] `streams/protocol.ts:52-54`). |
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
| WKWebView accepts a **zero-length** GCM IV; Chrome throws | **[M]** macOS WKWebView (`capacitor://localhost`), Chrome 154 | Enforce 12 bytes ourselves (§4.2) |
| Throughput, AES-256-GCM 1 MiB seal | **[M]** Chrome ~3000 MiB/s (0.334 ms, n=899); WKWebView (macOS) 2174 MiB/s seal / 5556 MiB/s open; Node 0.19 ms | Per call at 64 B: 5.5 µs (Chrome), 12 µs (WKWebView) sequential; ~2.4 µs batched |
| Pure-JS XChaCha20-Poly1305 (@noble/ciphers) 1 MiB | **[M]** ~284–297 MiB/s Chrome, ~241 MiB/s WKWebView; README 340 MiB/s [noble] | 8–13× slower than WebCrypto GCM |
| `app.secretStorage` exists (`setSecret`/`getSecret`/`listSecrets`, synchronous; ids lowercase alphanumeric plus dashes; no delete) | **[S]** `obsidian.d.ts:458`, `:5635` (npm `obsidian` 1.13.1); `@since 1.11.4`; plugin `minAppVersion` 1.13.0 | |
| Desktop SecretStorage uses Electron `safeStorage`. Without OS encryption it stores **plaintext** and warns (`msgSecretsNotEncrypted`) | **[S]** `obsidian-1.14.4.asar`, bytes ~3571300–3572700 (read-only); same in 1.13.7 | Linux without a keyring: plaintext |
| Mobile SecretStorage uses the Capacitor plugin `SecureStorage` under the bare key `"secrets-encrypted"`, so it is shared across vaults | **[S]** same asar (mobile adapter); that it is backed by Keychain/Keystore **[U]** (inferred from the name) | Namespace ids per vault (§6.2) |
| `crypto.subtle` requires a secure context; custom schemes count as secure in WebKit; a worker inherits it | **[S]** [WebCrypto] §10; WebKit `SecurityOrigin.cpp` L101-102, `WorkerGlobalScope.cpp` L204-210 | Obsidian iOS origin `capacitor://localhost` **[U]** |
| No streaming AEAD in WebCrypto | **[S]** [w3c-webcrypto-73] | Blobs ≤ 10 MiB are sealed in one call (§10.3) |
| Obsidian mobile WebViews and desktop Electron behave like the above | **[U]** | §23.3 lists the device runs |
