# Durable Object Attachment Sync — Design

**Date:** 2026-06-29
**Status:** Approved (ready for implementation plan)
**Scope:** Add zero-config attachment sync backed by Cloudflare Durable Objects, so attachments work without the manual R2 setup step, while staying strictly within the Cloudflare Workers **free plan** ($0).

---

## 1. Problem & Goal

YAOS syncs Markdown text out of the box via a per-vault SQLite-backed Durable Object
(`VaultSyncServer`). Attachments (images, PDFs, other binaries) currently sync only
after the user manually creates and binds a Cloudflare **R2 bucket** (`YAOS_BUCKET`).
That manual step is friction and breaks the "zero-terminal, zero-config" promise.

**Goal:** Make attachment sync work automatically with no extra setup, using Durable
Object storage that the deployment already has, at zero cost on the free plan. Keep R2
as an optional escape hatch for users who need more than the free-plan storage ceiling.

**Non-goals:**
- Snapshots/backups (remain R2-only — out of scope).
- The occasional text-sync conflicts mentioned separately (different effort).
- End-to-end / client-side content encryption (explicitly out of scope — see §9).

---

## 2. Free-plan constraints (verified 2026-06-29)

| Constraint | Value | Design consequence |
|---|---|---|
| Storage backend (free) | SQLite-backed DO only | YAOS already uses this; no plan change. |
| Max row / BLOB size | **2 MB** | Attachments **must be chunked** (~1 MiB rows). |
| Storage per DO (free) | **1 GB** | A dedicated blob DO gives ~1 GB attachments per vault. |
| Storage per account (free) | **5 GB total** | Hard account ceiling; GC matters. |
| Requests/day (free) | **100,000** (incl. WebSocket messages) | Keep transfers to **1 HTTP request each**; do Worker↔DO via RPC. |
| Row writes/day (free) | 100,000 | 10 MB upload ≈ 10 row writes — fine. |
| Row reads/day (free) | 5,000,000 | Reassembly reads ≈ chunk count — fine. |
| SQLite storage billing | Free plan **not charged** | "$0" is genuinely achievable. |
| `SQLITE_FULL` behavior | writes fail; reads/deletes still work | Surface gracefully; GC/delete still possible. |

R2's free tier is 10 GB (larger than DO's 1 GB/vault), which is exactly why R2 stays
available as the opt-in path for large vaults.

---

## 3. Architecture (Approach A: dedicated blob DO + CRDT-driven GC)

Blob bytes live in a **new dedicated Durable Object class** per vault, separate from the
sync room. This isolates the blob storage budget and blob I/O from the latency-sensitive
live-sync hot path, and keeps the plugin's transfer client unchanged.

```
Obsidian plugin (BlobHttpClient)
  │  PUT/GET /vault/:id/blobs/:hash, POST /vault/:id/blobs/exists   (unchanged contract)
  ▼
Cloudflare Worker (routes/blobs.ts)
  │  backend = R2 if YAOS_BUCKET bound, else DO
  ├──► R2 (env.YAOS_BUCKET)                  [existing path, unchanged]
  └──► VaultBlobStore DO (env.YAOS_BLOBS)    [new] — chunked SQLite rows
            ▲
            │ sweep(liveHashes, graceMs)   (RPC)
VaultSyncServer DO ── owns merged Y.Doc, computes live hash set, triggers GC
```

**Why the source of truth for GC is the server-side `Y.Doc`:** the sync DO already holds
the merged, convergent CRDT. Reading `pathToBlob` (a `Y.Map<BlobRef>`, `BlobRef = { hash,
size }`) yields the authoritative set of referenced hashes with no cross-device delete
race — avoiding the distributed refcount GC that `engineering/attachment-sync.md` rejects.

---

## 4. Components

### 4.1 `server/src/blobStore.ts` — `VaultBlobStore extends DurableObject` (new)

SQLite schema (initialized once via `blockConcurrencyWhile`):

```sql
CREATE TABLE IF NOT EXISTS blob_meta (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  chunk_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_chunk (
  hash TEXT NOT NULL,
  idx INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (hash, idx)
);
```

RPC methods (called from the Worker via the DO stub):

- `putBlob(hash, mime, bytes: Uint8Array): { ok: true } | { error: "full" }`
  - Idempotent: if `hash` already in `blob_meta`, no-op `{ ok: true }`.
  - Splits `bytes` into `CHUNK_BYTES = 1 MiB` rows; writes meta + all chunks in **one
    transaction**.
  - Catches `SQLITE_FULL` → returns `{ error: "full" }` (no partial write left behind —
    the transaction rolls back).
- `getBlob(hash): { mime, bytes: Uint8Array } | null`
  - Reads chunks `ORDER BY idx`, concatenates into one buffer.
- `existsBlobs(hashes: string[]): string[]`
  - `SELECT hash FROM blob_meta WHERE hash IN (...)`, bounded batch.
- `storageStatus(): { usedBytes: number, blobCount: number }`
  - `SELECT COALESCE(SUM(size),0), COUNT(*) FROM blob_meta`.
- `sweep(liveHashes: string[], graceMs: number): { deleted: number, freedBytes: number }`
  - Deletes `blob_meta`/`blob_chunk` rows whose hash is **not** in `liveHashes` **and**
    `created_at <= now - graceMs`.

**Chunk size:** 1 MiB keeps each row well under the 2 MB cap (key = 64-hex hash + small
int, negligible) and keeps row counts low (10 MB ⇒ 10 rows).

### 4.2 `server/src/routes/blobs.ts` — backend selection

Introduce a small backend abstraction with two implementations (R2, DO) behind the
existing HTTP handlers. Selection rule:

```
backend = env.YAOS_BUCKET ? R2Backend : DoBackend(env.YAOS_BLOBS)
```

- `PUT /blobs/:hash`: unchanged validation (hash format, `Content-Length`,
  `MAX_BLOB_UPLOAD_BYTES` = 10 MB, server-side SHA-256 re-verification). On DO backend, a
  `{ error: "full" }` result maps to **HTTP 507 Insufficient Storage**.
- `GET /blobs/:hash`: unchanged response shape; DO backend streams reassembled bytes with
  stored `mime`.
- `POST /blobs/exists`: unchanged response `{ present: string[] }`.

The external HTTP contract is **identical**, so the plugin's `BlobHttpClient` needs no
transfer-path changes.

### 4.3 `server/src/routes/blobs.ts` + classifier — new `GET /blobs/status`

Returns `storageStatus()` for the settings UI. Per the documented SECURITY/BILLING
INVARIANT in `server/src/index.ts`, adding this route requires:
1. handler branch in `handleBlobRoute`,
2. allow the shape in `isKnownVaultRouteShape` (`blobs` + `GET` + `rest = ["status"]`),
3. a trap-env regression test in `tests/server-route-classification-runtime.ts` proving
   invalid shapes still 404 before touching `YAOS_CONFIG`/`YAOS_SYNC`.

Routing note: `GET /blobs/status` overlaps with `GET /blobs/:hash`. Since `status` is not
a valid 64-hex SHA-256, the handler must match the literal `status` segment **before** the
generic `:hash` branch (the `:hash` branch already rejects non-hex values).

### 4.4 `server/src/routes/auth.ts` — capabilities

- `attachments`: `true` whenever the server is **claimed** (DO backend always available),
  instead of `supportsBuckets(env)`.
- New field `attachmentBackend: "r2" | "do"` so the client/UI can explain the active
  backend and the 1 GB note.
- `snapshots`: unchanged (`supportsBuckets(env)` — R2 only).
- `maxBlobUploadBytes`: unchanged (10 MB).

`src/sync/serverCapabilities.ts` (`ServerCapabilities`) gains the matching
`attachmentBackend?: "r2" | "do"` field.

### 4.5 `VaultSyncServer` — GC orchestration

The sync DO computes the live hash set from its in-memory `Y.Doc`:

```
liveHashes = unique(values of doc.getMap("pathToBlob").map(ref => ref.hash))
```

then calls `getServerByName(this.env.YAOS_BLOBS, vaultId).sweep(liveHashes, GRACE_MS)`.

Triggers:
- **Periodic:** fold into the existing alarm chain (the same cadence as daily snapshot
  maintenance), so GC needs no new alarm wiring beyond a call site.
- **After bulk deletes:** when a batch of blob tombstones is applied.

**Grace period `GRACE_MS ≈ 1 hour`:** blobs are uploaded *before* their `pathToBlob` ref
is committed (two-phase commit in `blobSync.ts`). The grace window prevents a sweep from
deleting a just-uploaded blob whose ref hasn't landed yet. `created_at` on `blob_meta`
supports this.

### 4.6 `server/src/routes/types.ts` + `wrangler.toml` + `index.ts` — wiring

- `Env` gains `YAOS_BLOBS: DurableObjectNamespace<VaultBlobStore>`.
- `wrangler.toml`: add a `[[durable_objects.bindings]]` for `YAOS_BLOBS` →
  `VaultBlobStore`, and a new `[[migrations]]` tag adding `VaultBlobStore` to
  `new_sqlite_classes`.
- `index.ts`: `export { VaultBlobStore }`.

### 4.7 Plugin — minimal client changes

- **507 handling** in `blobSync.ts`: a 507 upload response is a non-retryable "storage
  full" terminal state — emit an Obsidian `Notice` ("Attachment storage full — enable R2
  in settings for more than 1 GB"), mark the item as a permanent failure, stop retrying.
- **Storage-usage indicator** in `src/settings/settingsTab.ts`: fetch `/blobs/status`,
  show `usedBytes / 1 GB` and blob count; only meaningful when `attachmentBackend === "do"`.
- **Copy/UX:** "Sync attachments" no longer implies R2 is required; R2 reframed as the
  optional ">1 GB / snapshots" upgrade.

---

## 5. Data flow

**Upload:** plugin hashes file → `POST /blobs/exists` (dedup) → if absent `PUT /blobs/:hash`
(10 MB max, 1 HTTP request) → Worker re-verifies SHA-256 → `putBlob` RPC splits into 1 MiB
rows in a transaction → 204 (or 507 if full) → plugin two-phase commits `pathToBlob` ref.

**Download:** CRDT `pathToBlob` observer fires → `GET /blobs/:hash` (1 HTTP request) →
Worker `getBlob` RPC reassembles chunks → plugin re-verifies SHA-256 → writes to disk
(with existing conflict-artifact safety).

**GC:** sync DO alarm / bulk-delete → collect live hashes from `Y.Doc` →
`sweep(liveHashes, ~1h)` on the blob DO → orphaned rows deleted.

---

## 6. Integrity & security posture (unchanged)

- **Integrity:** SHA-256 content addressing, server re-verifies on upload, client
  re-verifies on download. Identical to the R2 path.
- **In transit:** TLS (HTTPS/WSS) when the server URL is `https` (plugin already warns on
  plain HTTP).
- **At rest:** Cloudflare platform encryption of DO SQLite (same as R2). The Worker sees
  plaintext — this is a self-hosted trust model, **not** zero-knowledge E2E.
- This change neither improves nor weakens encryption (see §9).

---

## 7. Compatibility & migration

- **Existing R2 deployments:** `YAOS_BUCKET` still bound ⇒ `attachmentBackend = "r2"`,
  behavior unchanged. No data migration.
- **New / R2-less deployments:** `attachmentBackend = "do"` automatically; attachments
  work with no setup.
- **No cross-backend migration in v1.** Switching an existing R2 vault to DO (or vice
  versa) is not auto-migrated; documented as a manual/ future concern.
- Bump server version; review `minPluginVersion` so older plugins that key attachment UI
  off `attachments` still behave (they will simply see `attachments: true`).

---

## 8. Testing strategy (TDD)

Server (reuse `tests/mocks/partyserver.ts`):
- `blob_store` chunk round-trip: <1 MiB, exactly 1 MiB, multi-chunk, exactly 10 MB.
- `existsBlobs` returns only present hashes.
- `putBlob` idempotency (re-put same hash is a no-op).
- `sweep` deletes only unreferenced **and** past-grace blobs; keeps referenced and
  within-grace blobs.
- `SQLITE_FULL` → `{ error: "full" }` → route returns 507, no partial rows.
- backend selection: R2 when bucket bound, DO otherwise.
- classifier trap test: `GET /blobs/status` valid; `POST /blobs/status`,
  `GET /blobs/<garbage-method>` invalid shapes 404 pre-auth.

Plugin (reuse `tests/mocks/obsidian.ts`):
- 507 upload → permanent failure + notice, no infinite retry.
- capabilities parsing includes `attachmentBackend`.

---

## 9. Out of scope: end-to-end encryption

YAOS performs **no** content encryption today (verified: all `crypto.subtle` usage is
SHA-256 hashing or HMAC ticket signing). True E2E (client-side AES-GCM with a vault
passphrase) would affect **both** text and attachments and interacts awkwardly with
content-addressed dedup and CRDT merge. It is intentionally excluded from this work and,
if desired, should be a separate brainstorm.

---

## 10. Open considerations (deferred, not blocking)

- **Approach C (sharded blob DOs by hash prefix)** to exceed 1 GB/vault up to the 5 GB
  account cap — documented future option alongside R2.
- **Cross-backend migration tooling** (R2 ⇄ DO).
- **Per-vault storage quota warnings** before hitting the hard 1 GB ceiling.
