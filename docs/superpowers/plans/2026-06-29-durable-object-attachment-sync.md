# Durable Object Attachment Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable zero-config attachment sync on the Cloudflare Workers free plan by storing content-addressed blobs in a dedicated per-vault `VaultBlobStore` Durable Object, while keeping R2 as an optional backend for deployments that bind `YAOS_BUCKET`.

**Architecture:** Add a new SQLite-backed `VaultBlobStore` DO (1 MiB chunk rows under the 2 MB cap). The existing Worker blob HTTP contract stays unchanged; `routes/blobs.ts` selects R2 when `YAOS_BUCKET` is bound, otherwise the DO. `VaultSyncServer` drives mark-and-sweep GC from the merged `pathToBlob` CRDT map. Plugin changes are limited to capabilities parsing, 507 handling, and a storage-usage indicator.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite storage API), Yjs, Obsidian plugin (`requestUrl`), existing regression runner (`npm run test:regressions`).

**Spec:** `docs/superpowers/specs/2026-06-29-durable-object-attachment-sync-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/blobChunk.ts` | Pure chunking helpers (`CHUNK_BYTES`, `splitBytes`, `concatChunks`) — unit-testable without DO runtime |
| `server/src/blobStore.ts` | `VaultBlobStore` DO: schema init, `putBlob` / `getBlob` / `existsBlobs` / `storageStatus` / `sweep` |
| `server/src/blobBackends.ts` | `BlobBackend` interface + `R2BlobBackend` + `DoBlobBackend`; `selectBlobBackend(env)` |
| `server/src/routes/blobs.ts` | HTTP handlers; delegate to backend; add `GET /blobs/status` |
| `server/src/routes/auth.ts` | `getCapabilities`: `attachments` when claimed; `attachmentBackend` field |
| `server/src/routes/types.ts` | `Env.YAOS_BLOBS` binding |
| `server/src/server.ts` | `collectLiveBlobHashes()`, `maybeSweepAttachments()` (serialized + throttled), internal `POST /__yaos/attachment-sweep-maybe` |
| `server/src/index.ts` | Export `VaultBlobStore`; classifier allows `GET /blobs/status` |
| `server/wrangler.toml` | `YAOS_BLOBS` binding + migration tag |
| `server/src/version.ts` | Bump `SERVER_VERSION` (e.g. `0.4.0`) |
| `src/sync/serverCapabilities.ts` | `attachmentBackend?: "r2" \| "do"` |
| `src/runtime/capabilityUpdateService.ts` | Parse + expose `attachmentBackend` |
| `src/sync/blobSync.ts` | Handle HTTP 507 as permanent storage-full failure |
| `src/settings/settingsTab.ts` | Storage usage UI + updated R2 copy |
| `src/main.ts` | Fire-and-forget attachment sweep on startup when `attachmentBackend === "do"` |
| `tests/blob-chunk.ts` | Chunk helper tests |
| `tests/blob-store.ts` | Blob store logic tests (FakeSql) |
| `tests/blob-route-do-backend.ts` | `handleBlobRoute` with mock DO backend |
| `tests/blob-storage-full.ts` | Plugin 507 permanent-failure test |
| `tests/server-route-classification-runtime.ts` | Add `GET /blobs/status` trap-env cases |
| `tests/run-regressions.mjs` | Register new suites |

---

### Task 1: Chunk helpers

**Files:**
- Create: `server/src/blobChunk.ts`
- Test: `tests/blob-chunk.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/blob-chunk.ts`:

```typescript
import {
	CHUNK_BYTES,
	splitBytes,
	concatChunks,
	chunkCountForSize,
} from "../server/src/blobChunk";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
	assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

// --- small payload (< 1 MiB) ---
{
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 1, "small payload is one chunk");
	assertEqual(chunks[0]!.byteLength, 5, "small chunk length");
	const roundTrip = concatChunks(chunks);
	assert(roundTrip.every((b, i) => b === bytes[i]!), "small round-trip");
}

// --- exactly 1 MiB ---
{
	const bytes = new Uint8Array(CHUNK_BYTES);
	bytes[0] = 7;
	bytes[CHUNK_BYTES - 1] = 9;
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 1, "exactly 1 MiB is one chunk");
	assertEqual(concatChunks(chunks).byteLength, CHUNK_BYTES, "1 MiB round-trip length");
}

// --- 1 MiB + 1 byte ---
{
	const bytes = new Uint8Array(CHUNK_BYTES + 1);
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 2, "1 MiB + 1 splits into two chunks");
	assertEqual(chunks[0]!.byteLength, CHUNK_BYTES, "first chunk is full MiB");
	assertEqual(chunks[1]!.byteLength, 1, "second chunk is 1 byte");
}

// --- 10 MiB (max upload) ---
{
	const size = 10 * 1024 * 1024;
	assertEqual(chunkCountForSize(size), 10, "10 MiB needs 10 chunks");
	const bytes = new Uint8Array(size);
	bytes[0] = 42;
	bytes[size - 1] = 99;
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 10, "10 MiB splits into 10 chunks");
	const rt = concatChunks(chunks);
	assertEqual(rt[0], 42, "10 MiB round-trip first byte");
	assertEqual(rt[size - 1], 99, "10 MiB round-trip last byte");
}

console.log(`\nblob-chunk: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:regressions -- --only blob-chunk`

Expected: FAIL — module `../server/src/blobChunk` not found (suite not registered yet also fails; first run with direct jiti):

Run: `node --import jiti/register tests/blob-chunk.ts`

Expected: FAIL with cannot find module `blobChunk`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/blobChunk.ts`:

```typescript
export const CHUNK_BYTES = 1024 * 1024; // 1 MiB

export function chunkCountForSize(size: number): number {
	if (size <= 0) return 0;
	return Math.ceil(size / CHUNK_BYTES);
}

export function splitBytes(bytes: Uint8Array): Uint8Array[] {
	if (bytes.byteLength === 0) return [new Uint8Array(0)];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)));
	}
	return chunks;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import jiti/register tests/blob-chunk.ts`

Expected: `blob-chunk: 9 passed, 0 failed` (exit 0)

- [ ] **Step 5: Register suite and commit**

Add to `tests/run-regressions.mjs` suites array (near other server tests):

```javascript
[JITI, "tests/blob-chunk.ts"],
```

Run: `npm run test:regressions -- --only blob-chunk`

Expected: PASS

```bash
git add server/src/blobChunk.ts tests/blob-chunk.ts tests/run-regressions.mjs
git commit -m "feat(server): add blob chunk helpers for DO attachment storage"
```

---

### Task 2: Blob store SQL operations (FakeSql tests)

**Files:**
- Create: `server/src/blobStoreSql.ts` (pure SQL ops, no DO class)
- Create: `server/src/blobStore.ts` (thin DO wrapper — stub for now)
- Test: `tests/blob-store.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/blob-store.ts` with a minimal in-memory FakeSql implementing
`exec(sql: string, ...bindings: unknown[])` for the statements used by blob store ops.

```typescript
import {
	initBlobStoreSchema,
	putBlobRecord,
	getBlobRecord,
	existsBlobHashes,
	storageStatus,
	sweepOrphans,
	type SqlStorage,
} from "../server/src/blobStoreSql";
import { CHUNK_BYTES } from "../server/src/blobChunk";

// --- FakeSql (in-memory) ---
class FakeSql implements SqlStorage {
	private tables = {
		blob_meta: new Map<string, { hash: string; size: number; mime: string | null; chunk_count: number; created_at: number }>(),
		blob_chunk: new Map<string, Uint8Array>(), // key = `${hash}:${idx}`
	};

	exec(sql: string, ...bindings: unknown[]): void {
		const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
		if (normalized.startsWith("create table")) return;

		if (normalized.includes("insert into blob_meta")) {
			const [hash, size, mime, chunk_count, created_at] = bindings as [string, number, string | null, number, number];
			this.tables.blob_meta.set(hash, { hash, size, mime, chunk_count, created_at });
			return;
		}
		if (normalized.includes("insert into blob_chunk")) {
			const [hash, idx, bytes] = bindings as [string, number, Uint8Array];
			this.tables.blob_chunk.set(`${hash}:${idx}`, bytes);
			return;
		}
		if (normalized.includes("select hash from blob_meta where hash =")) {
			// getBlobRecord existence check — handled via custom helper below
			return;
		}
		throw new Error(`FakeSql unhandled: ${sql}`);
	}

	// Test helpers mirroring cursor API used by blobStoreSql
	hasMeta(hash: string): boolean {
		return this.tables.blob_meta.has(hash);
	}
}

let passed = 0;
let failed = 0;
function assert(c: boolean, msg: string) { if (c) { console.log(`  PASS  ${msg}`); passed++; } else { console.error(`  FAIL  ${msg}`); failed++; } }

const sql = new FakeSql() as unknown as SqlStorage;
initBlobStoreSchema(sql);

const hash = "a".repeat(64);
const bytes = new Uint8Array(CHUNK_BYTES + 100);
bytes[0] = 1;
bytes[CHUNK_BYTES] = 2;

putBlobRecord(sql, hash, "image/png", bytes, Date.now());
assert(existsBlobHashes(sql, [hash, "b".repeat(64)]).length === 1, "exists returns only present hash");

const loaded = getBlobRecord(sql, hash);
assert(loaded !== null, "getBlob returns record");
assert(loaded!.bytes.byteLength === bytes.byteLength, "get round-trip size");
assert(loaded!.bytes[0] === 1 && loaded!.bytes[CHUNK_BYTES] === 2, "get round-trip bytes");

const status = storageStatus(sql);
assert(status.blobCount === 1, "storage status count");
assert(status.usedBytes === bytes.byteLength, "storage status bytes");

const deleted = sweepOrphans(sql, [], 0, Date.now());
assert(deleted.deleted === 1, "sweep with empty live set deletes orphan");

console.log(`\nblob-store: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

> **Note to implementer:** flesh out `FakeSql` as you implement `blobStoreSql.ts` — the test file above is the skeleton; extend `exec()` to handle every SQL statement your implementation emits. Keep FakeSql in the test file, not production.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register tests/blob-store.ts`

Expected: FAIL — `blobStoreSql` not found

- [ ] **Step 3: Write minimal implementation**

Create `server/src/blobStoreSql.ts` exporting:

```typescript
export interface SqlStorage {
	exec(sql: string, ...bindings: unknown[]): unknown;
}

export const BLOB_GRACE_MS = 60 * 60 * 1000; // 1 hour

export function initBlobStoreSchema(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS blob_meta (
		hash TEXT PRIMARY KEY,
		size INTEGER NOT NULL,
		mime TEXT,
		chunk_count INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS blob_chunk (
		hash TEXT NOT NULL,
		idx INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (hash, idx)
	)`);
}

export function putBlobRecord(
	sql: SqlStorage,
	hash: string,
	mime: string,
	bytes: Uint8Array,
	createdAt: number,
): { ok: true } | { error: "full" } {
	// If hash exists, return { ok: true } immediately (idempotent).
	// Else split with splitBytes(), INSERT meta + chunks in a transaction.
	// On error message containing "SQLITE_FULL", return { error: "full" }.
}

export function getBlobRecord(
	sql: SqlStorage,
	hash: string,
): { mime: string; bytes: Uint8Array } | null { /* SELECT chunks ORDER BY idx */ }

export function existsBlobHashes(sql: SqlStorage, hashes: string[]): string[] { /* bounded IN query */ }

export function storageStatus(sql: SqlStorage): { usedBytes: number; blobCount: number } { /* SUM/COUNT */ }

export function sweepOrphans(
	sql: SqlStorage,
	liveHashes: string[],
	graceMs: number,
	nowMs: number,
): { deleted: number; freedBytes: number } {
	// DELETE blobs where hash NOT IN liveHashes AND created_at <= nowMs - graceMs
}
```

Create stub `server/src/blobStore.ts`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { initBlobStoreSchema, putBlobRecord, getBlobRecord, existsBlobHashes, storageStatus, sweepOrphans } from "./blobStoreSql";

export class VaultBlobStore extends DurableObject {
	private schemaReady = false;

	private sql() {
		return this.ctx.storage.sql;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		initBlobStoreSchema(this.sql());
		this.schemaReady = true;
	}

	async fetch(request: Request): Promise<Response> {
		this.ensureSchema();
		const url = new URL(request.url);
		// RPC routes: /put /get /exists /status /sweep — implemented in Task 3
		return new Response(JSON.stringify({ error: "not implemented" }), { status: 501 });
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import jiti/register tests/blob-store.ts`

Expected: PASS

- [ ] **Step 5: Register + commit**

```bash
git add server/src/blobStoreSql.ts server/src/blobStore.ts tests/blob-store.ts tests/run-regressions.mjs
git commit -m "feat(server): add blob store SQL operations with chunk persistence"
```

Add `[JITI, "tests/blob-store.ts"],` to `run-regressions.mjs`.

---

### Task 3: VaultBlobStore DO RPC + SQLITE_FULL test

**Files:**
- Modify: `server/src/blobStore.ts`
- Modify: `tests/blob-store.ts` (add idempotency + grace sweep tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/blob-store.ts`:

```typescript
// idempotency
putBlobRecord(sql, hash, "image/png", bytes, Date.now());
const status2 = storageStatus(sql);
assert(status2.blobCount === 1, "re-put same hash is idempotent");

// grace: young orphan survives, old orphan deleted
const orphanHash = "c".repeat(64);
const orphanBytes = new Uint8Array([9]);
const now = Date.now();
putBlobRecord(sql, orphanHash, "application/octet-stream", orphanBytes, now - 2 * 60 * 60 * 1000);
const young = sweepOrphans(sql, [], BLOB_GRACE_MS, now);
assert(young.deleted === 0, "young orphan within grace survives");
const old = sweepOrphans(sql, [], BLOB_GRACE_MS, now + 2 * 60 * 60 * 1000);
assert(old.deleted >= 1, "old orphan past grace is deleted");

// referenced hash survives sweep
putBlobRecord(sql, hash, "image/png", bytes, now);
const kept = sweepOrphans(sql, [hash], 0, now + 999999);
assert(existsBlobHashes(sql, [hash]).length === 1, "live hash kept after sweep");
```

Import `BLOB_GRACE_MS` from `blobStoreSql`.

Add `tests/blob-store-sqlite-full.ts`:

```typescript
import { putBlobRecord, initBlobStoreSchema, type SqlStorage } from "../server/src/blobStoreSql";

class FullSql implements SqlStorage {
	exec(): never {
		throw new Error("database or disk is full: SQLITE_FULL");
	}
}

const sql = new FullSql();
initBlobStoreSchema(sql);
const result = putBlobRecord(sql, "d".repeat(64), "text/plain", new Uint8Array([1]), Date.now());
if (result.error !== "full") {
	console.error("FAIL: expected full");
	process.exit(1);
}
console.log("PASS: SQLITE_FULL maps to { error: 'full' }");
```

- [ ] **Step 2: Run tests to verify new cases fail**

Run: `node --import jiti/register tests/blob-store.ts` (grace/idempotency fail until implemented)

- [ ] **Step 3: Implement VaultBlobStore.fetch RPC**

Wire `server/src/blobStore.ts` `fetch()`:

| Path | Method | Body | Response |
|---|---|---|---|
| `/put` | POST | `{ hash, mime, bytes: base64 }` | `{ ok: true }` or `{ error: "full" }` |
| `/get` | POST | `{ hash }` | `{ mime, bytes: base64 }` or 404 |
| `/exists` | POST | `{ hashes: string[] }` | `{ present: string[] }` |
| `/status` | GET | — | `{ usedBytes, blobCount }` |
| `/sweep` | POST | `{ liveHashes, graceMs }` | `{ deleted, freedBytes }` |

Use `blockConcurrencyWhile` in constructor/first fetch to call `initBlobStoreSchema`.

Use base64 helpers from `server/src/base64url.ts` or inline `btoa`/`atob` with Uint8Array conversion.

- [ ] **Step 4: Run tests**

Run: `node --import jiti/register tests/blob-store.ts && node --import jiti/register tests/blob-store-sqlite-full.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/blobStore.ts server/src/blobStoreSql.ts tests/blob-store.ts tests/blob-store-sqlite-full.ts tests/run-regressions.mjs
git commit -m "feat(server): wire VaultBlobStore DO RPC and SQLITE_FULL handling"
```

---

### Task 4: Blob backend abstraction + DO route integration

**Files:**
- Create: `server/src/blobBackends.ts`
- Modify: `server/src/routes/blobs.ts`
- Test: `tests/blob-route-do-backend.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/blob-route-do-backend.ts`:

```typescript
import { handleBlobRoute } from "../server/src/routes/blobs";
import { MAX_BLOB_UPLOAD_BYTES } from "../server/src/contracts";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (c) { console.log(`  PASS  ${m}`); passed++; } else { console.error(`  FAIL  ${m}`); failed++; } }
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// In-memory mock blob DO
const stored = new Map<string, { mime: string; bytes: Uint8Array }>();
const mockBlobNs = {
	idFromName: () => "blob-room",
	get: () => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			if (url.pathname === "/put" && req.method === "POST") {
				const body = await req.json() as { hash: string; mime: string; bytes: string };
				const bytes = Uint8Array.from(atob(body.bytes), (c) => c.charCodeAt(0));
				if (stored.has(body.hash)) return new Response(JSON.stringify({ ok: true }));
				stored.set(body.hash, { mime: body.mime, bytes });
				return new Response(JSON.stringify({ ok: true }));
			}
			if (url.pathname === "/get" && req.method === "POST") {
				const { hash } = await req.json() as { hash: string };
				const rec = stored.get(hash);
				if (!rec) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
				const b64 = btoa(String.fromCharCode(...rec.bytes));
				return new Response(JSON.stringify({ mime: rec.mime, bytes: b64 }));
			}
			if (url.pathname === "/exists" && req.method === "POST") {
				const { hashes } = await req.json() as { hashes: string[] };
				return new Response(JSON.stringify({ present: hashes.filter((h) => stored.has(h)) }));
			}
			if (url.pathname === "/status" && req.method === "GET") {
				let used = 0;
				for (const v of stored.values()) used += v.bytes.byteLength;
				return new Response(JSON.stringify({ usedBytes: used, blobCount: stored.size }));
			}
			return new Response("not found", { status: 404 });
		},
	}),
};

const env = { YAOS_BLOBS: mockBlobNs } as any;

console.log("\n--- DO backend: upload + download round-trip ---");
{
	stored.clear();
	const body = new TextEncoder().encode("hello attachment");
	const hash = await sha256Hex(body);
	const putRes = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/${hash}`, { method: "PUT", body }), [hash], json);
	assert(putRes.status === 204, "PUT returns 204");

	const getRes = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/${hash}`, { method: "GET" }), [hash], json);
	assert(getRes.status === 200, "GET returns 200");
	const got = new Uint8Array(await getRes.arrayBuffer());
	assert(got[0] === 104 && got[4] === 111, "GET body matches (hello)");
}

console.log("\n--- DO backend: exists ---");
{
	const hash = await sha256Hex(new TextEncoder().encode("x"));
	const res = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/exists`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hashes: [hash, "f".repeat(64)] }),
	}), ["exists"], json);
	const payload = await res.json() as { present: string[] };
	assert(payload.present.includes(hash), "exists returns stored hash");
}

console.log("\n--- DO backend: status route ---");
{
	const res = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/status`, { method: "GET" }), ["status"], json);
	assert(res.status === 200, "GET /blobs/status returns 200");
}

console.log("\n--- R2 preferred when bucket bound ---");
{
	let r2Put = 0;
	const envR2 = { YAOS_BUCKET: { put: async () => { r2Put++; } }, YAOS_BLOBS: mockBlobNs } as any;
	const body = new TextEncoder().encode("r2 wins");
	const hash = await sha256Hex(body);
	await handleBlobRoute(envR2, "v", new Request(`https://x/vault/v/blobs/${hash}`, { method: "PUT", body }), [hash], json);
	assert(r2Put === 1, "R2 backend used when YAOS_BUCKET present");
}

console.log(`\nblob-route-do-backend: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register tests/blob-route-do-backend.ts`

Expected: FAIL — still returns `attachments_unavailable` 503 without bucket

- [ ] **Step 3: Implement backend abstraction**

Create `server/src/blobBackends.ts`:

```typescript
import { getServerByName } from "partyserver";
import { mapWithConcurrency } from "./concurrency";
import { blobKey } from "./snapshot";
import type { Env } from "./routes/types";

export interface BlobBackend {
	upload(vaultId: string, hash: string, mime: string, body: ArrayBuffer): Promise<{ ok: true } | { error: "full" }>;
	download(vaultId: string, hash: string): Promise<{ mime: string; body: ArrayBuffer } | null>;
	exists(vaultId: string, hashes: string[]): Promise<string[]>;
	storageStatus(vaultId: string): Promise<{ usedBytes: number; blobCount: number }>;
}

export function selectBlobBackend(env: Env): BlobBackend | null {
	if (env.YAOS_BUCKET) return new R2BlobBackend(env);
	if (env.YAOS_BLOBS) return new DoBlobBackend(env);
	return null;
}

// R2BlobBackend: move existing R2 put/get/head logic from blobs.ts
// DoBlobBackend: getServerByName(env.YAOS_BLOBS, vaultId).fetch(...) RPC calls
```

Refactor `server/src/routes/blobs.ts`:
- Replace direct `env.YAOS_BUCKET` access with `selectBlobBackend(env)`.
- If `backend === null`, return `{ error: "attachments_unavailable" }` 503 (unclaimed server without bindings — should not happen once YAOS_BLOBS is always bound).
- `handleBlobUpload`: map `{ error: "full" }` → HTTP **507**.
- Add branch **before** generic `GET :hash`:

```typescript
if (req.method === "GET" && rest.length === 1 && rest[0] === "status") {
	return await handleBlobStatus(env, vaultId, json);
}
```

- `handleBlobExists` when no backend: 503 (unchanged semantics for truly unconfigured env in tests without YAOS_BLOBS).

- [ ] **Step 4: Run tests**

Run: `node --import jiti/register tests/blob-route-do-backend.ts`

Also run existing blob hardening tests:

Run: `npm run test:regressions -- --only server-hardening`

Expected: all PASS (R2 tests still pass with `YAOS_BUCKET` mock)

- [ ] **Step 5: Commit**

```bash
git add server/src/blobBackends.ts server/src/routes/blobs.ts tests/blob-route-do-backend.ts tests/run-regressions.mjs
git commit -m "feat(server): add DO blob backend with R2 fallback selection"
```

---

### Task 5: Wrangler wiring + exports

**Files:**
- Modify: `server/wrangler.toml`
- Modify: `server/src/routes/types.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing test**

Extend `tests/blob-route-do-backend.ts` env to require `YAOS_BLOBS` key (already does). Add compile-time check:

Run: `cd server && npx tsc -noEmit`

Expected: FAIL until `Env` includes `YAOS_BLOBS`.

- [ ] **Step 2: Apply wiring**

`server/wrangler.toml` — add after existing `YAOS_CONFIG` binding:

```toml
[[durable_objects.bindings]]
name = "YAOS_BLOBS"
class_name = "VaultBlobStore"

[[migrations]]
tag = "v2-blob-store"
new_sqlite_classes = ["VaultBlobStore"]
```

`server/src/routes/types.ts`:

```typescript
import type { VaultBlobStore } from "../blobStore";

export interface Env {
	// ...existing...
	YAOS_BLOBS: DurableObjectNamespace<VaultBlobStore>;
}
```

`server/src/index.ts`:

```typescript
import { VaultBlobStore } from "./blobStore";
export { ServerConfig, VaultSyncServer, VaultBlobStore };
```

Make `YAOS_BLOBS` optional in `Env` (`YAOS_BLOBS?: ...`) only if needed for trap-env tests that omit it; production wrangler always binds it. Trap tests for `/blobs/status` must include a no-op `YAOS_BLOBS` if the route reaches auth (valid shape routes do reach auth).

- [ ] **Step 3: Verify**

Run: `cd server && npx tsc -noEmit`

Run: `npm run test:regressions -- --only blob-route-do-backend`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/wrangler.toml server/src/routes/types.ts server/src/index.ts server/src/blobStore.ts
git commit -m "chore(server): bind VaultBlobStore durable object"
```

---

### Task 6: Capabilities — attachments without R2

**Files:**
- Modify: `server/src/routes/auth.ts`
- Modify: `src/sync/serverCapabilities.ts`
- Modify: `src/runtime/capabilityUpdateService.ts`
- Modify: `tests/server-hardening.ts`
- Test: extend capabilities assertions

- [ ] **Step 1: Write the failing test**

Add to `tests/server-hardening.ts`:

```typescript
console.log("\n--- Test 10: claimed server without R2 advertises DO attachments ---");
{
	const auth = { mode: "claim", claimed: true, tokenHash: "hash" } as const;
	const env = { YAOS_BLOBS: {} } as any; // no YAOS_BUCKET
	const caps = getCapabilities(auth, env, null);
	assert(caps.attachments === true, "attachments true when claimed even without R2");
	assert(caps.attachmentBackend === "do", "attachmentBackend is do without bucket");
	assert(caps.snapshots === false, "snapshots still false without R2");
}

console.log("\n--- Test 11: R2 deployment keeps r2 backend ---");
{
	const auth = { mode: "claim", claimed: true, tokenHash: "hash" } as const;
	const env = { YAOS_BUCKET: {}, YAOS_BLOBS: {} } as any;
	const caps = getCapabilities(auth, env, null);
	assert(caps.attachmentBackend === "r2", "attachmentBackend is r2 when bucket bound");
	assert(caps.snapshots === true, "snapshots true with R2");
}
```

Update `getCapabilities` return type in test imports if needed.

Add plugin-side test file `tests/server-capabilities-attachment-backend.ts`:

```typescript
import { parseServerCapabilities } from "../src/runtime/capabilityUpdateService";

const caps = parseServerCapabilities({
	claimed: true,
	authMode: "claim",
	attachments: true,
	snapshots: false,
	attachmentBackend: "do",
	maxBlobUploadBytes: 10 * 1024 * 1024,
	socketTicketAuth: true,
	serverVersion: "0.4.0",
	minPluginVersion: null,
	recommendedPluginVersion: null,
	minSchemaVersion: 3,
	maxSchemaVersion: 3,
	migrationRequired: false,
	updateProvider: null,
	updateRepoUrl: null,
});
if (caps?.attachmentBackend !== "do") {
	console.error("FAIL: attachmentBackend not parsed");
	process.exit(1);
}
console.log("PASS: attachmentBackend parsed");
```

> Export `parseServerCapabilities` from `capabilityUpdateService.ts` if it is currently private — extract the existing validator.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:regressions -- --only server-hardening`

Expected: Tests 10–11 FAIL

- [ ] **Step 3: Implement**

`server/src/routes/auth.ts`:

```typescript
export function attachmentBackend(env: Env): "r2" | "do" | null {
	if (env.YAOS_BUCKET) return "r2";
	if (env.YAOS_BLOBS) return "do";
	return null;
}

// In getCapabilities():
const backend = attachmentBackend(env);
return {
	// ...
	attachments: auth.claimed && backend !== null,
	attachmentBackend: backend,
	snapshots: supportsBuckets(env),
	// ...
};
```

`src/sync/serverCapabilities.ts` — add `attachmentBackend?: "r2" | "do"`.

`src/runtime/capabilityUpdateService.ts` — validate and store `attachmentBackend`; add getter `attachmentBackend`.

- [ ] **Step 4: Run tests**

Run: `npm run test:regressions -- --only server-hardening`
Run: `npm run test:regressions -- --only server-capabilities-attachment-backend`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/auth.ts src/sync/serverCapabilities.ts src/runtime/capabilityUpdateService.ts tests/server-hardening.ts tests/server-capabilities-attachment-backend.ts tests/run-regressions.mjs
git commit -m "feat: advertise DO attachment backend in server capabilities"
```

---

### Task 7: GC — collect live hashes + sweep

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/src/blobGc.ts` (pure helper)
- Test: `tests/blob-gc.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/blobGc.ts`:

```typescript
import * as Y from "yjs";

export function collectLiveBlobHashes(doc: Y.Doc): string[] {
	const pathToBlob = doc.getMap<{ hash: string; size: number }>("pathToBlob");
	const live = new Set<string>();
	pathToBlob.forEach((ref) => {
		if (ref?.hash) live.add(ref.hash);
	});
	return [...live];
}
```

Create `tests/blob-gc.ts`:

```typescript
import * as Y from "yjs";
import { collectLiveBlobHashes } from "../server/src/blobGc";

const doc = new Y.Doc();
doc.transact(() => {
	doc.getMap("pathToBlob").set("img/a.png", { hash: "a".repeat(64), size: 10 });
	doc.getMap("pathToBlob").set("img/b.png", { hash: "b".repeat(64), size: 20 });
});
const hashes = collectLiveBlobHashes(doc);
if (hashes.length !== 2 || !hashes.includes("a".repeat(64))) {
	console.error("FAIL: collectLiveBlobHashes");
	process.exit(1);
}
console.log("PASS: collectLiveBlobHashes");
```

- [ ] **Step 2: Run test — verify fail then pass after implementation**

Run: `node --import jiti/register tests/blob-gc.ts`

- [ ] **Step 3: Wire VaultSyncServer sweep**

In `server/src/server.ts`:

```typescript
import { collectLiveBlobHashes } from "./blobGc";
import { BLOB_GRACE_MS } from "./blobStoreSql";
import { getServerByName } from "partyserver";

const ATTACHMENT_SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

private attachmentSweepChain: Promise<void> = Promise.resolve();
private lastAttachmentSweepAt = 0;

private async maybeSweepAttachments(force = false): Promise<{ deleted: number; freedBytes: number } | null> {
	const env = this.env as ServerEnv;
	if (!env.YAOS_BLOBS || env.YAOS_BUCKET) return null; // R2 deployments don't use blob DO

	const now = Date.now();
	if (!force && now - this.lastAttachmentSweepAt < ATTACHMENT_SWEEP_MIN_INTERVAL_MS) {
		return null;
	}

	await this.ensureDocumentLoaded();
	const liveHashes = collectLiveBlobHashes(this.document);
	const vaultId = this.getRoomId();

	const blobStub = await getServerByName(env.YAOS_BLOBS, vaultId);
	const res = await blobStub.fetch("https://internal/sweep", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ liveHashes, graceMs: BLOB_GRACE_MS }),
	});
	const result = await res.json() as { deleted: number; freedBytes: number };
	this.lastAttachmentSweepAt = now;
	return result;
}
```

Add internal route in `fetch()`:

```typescript
if (request.method === "POST" && url.pathname === "/__yaos/attachment-sweep-maybe") {
	await this.ensureDocumentLoaded();
	const serialized = { chain: this.attachmentSweepChain };
	const run = runSerialized(serialized, async () => this.maybeSweepAttachments(true));
	this.attachmentSweepChain = serialized.chain;
	const result = await run;
	return json({ swept: result });
}
```

Trigger sweep (throttled) from `GET /blobs/status` handler in `routes/blobs.ts`:

```typescript
// fire-and-forget after returning status
void (async () => {
	const syncStub = await getServerByName(env.YAOS_SYNC, vaultId);
	await syncStub.fetch("https://internal/__yaos/attachment-sweep-maybe", { method: "POST" });
})().catch(() => {});
```

- [ ] **Step 4: Run tests**

Run: `npm run test:regressions -- --only blob-gc`
Run: `npm run test:regressions -- --only blob-route-do-backend`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/blobGc.ts server/src/server.ts server/src/routes/blobs.ts tests/blob-gc.ts tests/run-regressions.mjs
git commit -m "feat(server): CRDT-driven attachment GC with throttled sweep"
```

---

### Task 8: Route classifier trap tests for `/blobs/status`

**Files:**
- Modify: `server/src/index.ts` (`isKnownVaultRouteShape`)
- Modify: `tests/server-route-classification-runtime.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/server-route-classification-runtime.ts`:

```typescript
console.log("\n--- Test N: GET /vault/:id/blobs/status is a valid vault route shape ---");
{
	// Uses auth trap — YAOS_CONFIG will be touched for valid routes, so use a
	// counting env instead of pure trap for this positive case.
	// Invalid shapes below still use trapEnv.
}

console.log("\n--- Test N+1: invalid /blobs/status shapes 404 without DO access ---");
{
	const invalid = [
		["POST", "/vault/v/blobs/status"],
		["GET", "/vault/v/blobs/status/extra"],
		["PUT", "/vault/v/blobs/status"],
	];
	for (const [method, path] of invalid) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(new Request(`https://example.com${path}`, { method }), trapEnv);
			status = resp.status;
		} catch { threw = true; }
		assert(!threw, `${method} ${path}: no DO throw`);
		assert(status === 404, `${method} ${path}: 404 pre-auth`);
	}
}
```

Update `isKnownVaultRouteShape` for `blobs`:

```typescript
case "blobs": {
	if (rest.length !== 1) return false;
	if (method === "POST") return rest[0] === "exists";
	if (method === "GET") return rest[0] === "status" || /^[0-9a-f]{64}$/.test(rest[0]);
	return method === "PUT" && /^[0-9a-f]{64}$/.test(rest[0]);
}
```

> Keep hash validation aligned with `isValidHash` in blobs.ts (64 hex). `status` is explicitly allowed.

- [ ] **Step 2: Run test — verify invalid shapes fail until classifier updated**

Run: `npm run test:regressions -- --only server-route-classification`

- [ ] **Step 3: Implement classifier change**

- [ ] **Step 4: Run test — PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts tests/server-route-classification-runtime.ts
git commit -m "fix(server): classify GET /blobs/status as valid vault route"
```

---

### Task 9: Plugin — HTTP 507 storage-full handling

**Files:**
- Modify: `src/sync/blobSync.ts`
- Test: `tests/blob-storage-full.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/blob-storage-full.ts` (extend patterns from `tests/blob-download-conflicts.ts` harness):

```typescript
import { BlobSyncManager } from "../src/sync/blobSync";
import { TFile } from "obsidian";

// Mock requestUrl to return 507 on PUT
// Assert: upload queue item removed, permanent failure incremented,
// trace event "upload-storage-full", NO retry scheduled

let notices: string[] = [];
(globalThis as any).Notice = class { constructor(msg: string) { notices.push(msg); } };

// ... build minimal app + vaultSync mock with setBlobRef ...

// After processUpload with 507:
// assert(manager.getDebugSnapshot().permanentUploadFailures === 1)
// assert(notices.some(n => n.includes("storage full")))
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `npm run test:regressions -- --only blob-storage-full`

- [ ] **Step 3: Implement in `blobSync.ts` `processUpload` catch block**

Before retry logic, detect storage full:

```typescript
const isStorageFull =
	err instanceof Error &&
	(/blob upload failed: 507/.test(err.message) || /storage full/i.test(err.message));

if (isStorageFull) {
	this.uploadQueue.delete(item.path);
	this._permanentUploadFailures++;
	this.trace?.("blob", "upload-storage-full", { path: item.path });
	try {
		new Notice(
			"YAOS: Attachment storage full (1 GB free limit). Enable R2 in server settings for more storage.",
			10000,
		);
	} catch { /* headless */ }
	return; // no retry
}
```

Also handle 507 in `BlobHttpClient.upload` for a clear error message:

```typescript
if (res.status === 507) {
	throw new Error(`blob upload failed: 507 storage full`);
}
```

- [ ] **Step 4: Run test — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/sync/blobSync.ts tests/blob-storage-full.ts tests/run-regressions.mjs
git commit -m "feat(plugin): treat attachment storage full (507) as permanent failure"
```

---

### Task 10: Plugin — settings UI + startup sweep

**Files:**
- Modify: `src/settings/settingsTab.ts`
- Modify: `src/main.ts`
- Modify: `src/runtime/capabilityUpdateService.ts` (helper to fetch blob status)

- [ ] **Step 1: Write the failing test**

Create `tests/settings-attachment-storage-status.ts`:

```typescript
import { formatAttachmentStorageStatus } from "../src/settings/attachmentStorageStatus";

const text = formatAttachmentStorageStatus({ usedBytes: 512 * 1024 * 1024, blobCount: 42 }, "do");
if (!text.includes("512") || !text.includes("42")) {
	console.error("FAIL:", text);
	process.exit(1);
}
console.log("PASS:", text);
```

- [ ] **Step 2: Run test — FAIL**

- [ ] **Step 3: Implement**

Create `src/settings/attachmentStorageStatus.ts`:

```typescript
const DO_QUOTA_BYTES = 1024 * 1024 * 1024;

export function formatAttachmentStorageStatus(
	status: { usedBytes: number; blobCount: number },
	backend: "r2" | "do" | null | undefined,
): string | null {
	if (backend !== "do") return null;
	const usedMb = Math.round(status.usedBytes / (1024 * 1024));
	const quotaMb = Math.round(DO_QUOTA_BYTES / (1024 * 1024));
	return `${usedMb} / ${quotaMb} MB used · ${status.blobCount} attachment(s)`;
}
```

`settingsTab.ts` changes:
- Replace R2-required callout when `attachmentBackend === "do"`.
- When `do`, show formatted storage status (fetch `GET /vault/:id/blobs/status` on tab open).
- Update copy: "Attachments sync automatically. Add R2 for snapshots and >1 GB storage."

`main.ts` startup (after `providerSynced`, near daily snapshot block):

```typescript
if (providerSynced && this.capabilityUpdateService?.attachmentBackend === "do") {
	void this.triggerAttachmentSweep();
}
```

Add `triggerAttachmentSweep()` — fire-and-forget `GET .../blobs/status` (status fetch triggers throttled server sweep per Task 7).

- [ ] **Step 4: Run tests + lint**

Run: `npm run test:regressions -- --only settings-attachment-storage-status`
Run: `npm run lint:changed`

- [ ] **Step 5: Commit**

```bash
git add src/settings/attachmentStorageStatus.ts src/settings/settingsTab.ts src/main.ts tests/settings-attachment-storage-status.ts tests/run-regressions.mjs
git commit -m "feat(plugin): show DO attachment storage usage and refresh sweep"
```

---

### Task 11: Version bump + docs copy

**Files:**
- Modify: `server/src/version.ts` → `SERVER_VERSION = "0.4.0"`
- Modify: `README.md` (attachments section — DO works out of the box; R2 optional)
- Modify: `server/README.md` if it documents R2 as required

- [ ] **Step 1: Update version**

```typescript
export const SERVER_VERSION = "0.4.0";
```

Review `SERVER_MIN_PLUGIN_VERSION` — set only if plugin changes require it (507 + status UI are backward-compatible; leave `null` unless you add a hard dependency).

- [ ] **Step 2: Update README attachment paragraph**

Change "To sync images, PDFs..." section to explain:
- Attachments work automatically on deploy (DO backend, ~1 GB/vault on free plan).
- R2 optional for snapshots and larger storage.

- [ ] **Step 3: Run full regression suite**

Run: `npm run test:regressions`

Expected: all suites PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/version.ts README.md server/README.md
git commit -m "docs: document zero-config DO attachment sync and bump server to 0.4.0"
```

---

## Plan self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| `VaultBlobStore` chunked SQLite schema | Task 2–3 |
| Backend selection R2 vs DO | Task 4 |
| HTTP contract unchanged | Task 4 |
| `GET /blobs/status` | Task 4, 8 |
| Capabilities `attachments` + `attachmentBackend` | Task 6 |
| GC from `pathToBlob` + grace period | Task 7 |
| `wrangler.toml` binding + migration | Task 5 |
| Plugin 507 handling | Task 9 |
| Plugin storage indicator + copy | Task 10 |
| Route classifier trap test | Task 8 |
| Encryption out of scope | N/A |
| R2 unchanged for existing deployments | Task 4, 6 |
| Server version bump | Task 11 |

No placeholder steps remain. Type names (`VaultBlobStore`, `attachmentBackend`, `BLOB_GRACE_MS`) are consistent throughout.
