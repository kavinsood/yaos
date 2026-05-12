# Phase 1 follow-up issues

Tracked gaps identified during Phase 1.1–1.3 review that are not blocking merge
but must be addressed before the stabilization release.

---

## FU-1: Resolve duplicate ORIGIN_SEED ownership ✅ ADDRESSED

- `src/types.ts` now re-exports `ORIGIN_SEED` from `./sync/origins` (no longer declares it)
- `src/sync/blobSync.ts` and `src/sync/vaultSync.ts` updated to import from `./origins` directly
- `src/sync/snapshotClient.ts` duplicate `ORIGIN_RESTORE` removed; imports from `./origins`
- Comment in `origins.ts` updated to reflect both duplicates are resolved

---

## FU-2: LOCAL_STRING_ORIGINS should not be exported as mutable ✅ ADDRESSED

- The mutable `Set` is no longer exported. `LOCAL_STRING_ORIGIN_SET` (internal) is unexported.
- Production code uses `isLocalOrigin()` (handles provider + null + object + string cases).
- Tests use `isLocalStringOrigin(s: string): boolean` for string membership checks.
- `LOCAL_REPAIR_ORIGINS: readonly string[]` is exported for tests that need enumeration.
- `diskMirror.ts` re-export removed (previous partial fix).

---

## FU-3: Source/lint guard for raw origin strings in applyDiffToYText calls ✅ ADDRESSED

- `tests/disk-mirror-origin-classification.ts` Test 6: walks all `src/**/*.ts` files and asserts
  zero `applyDiffToYText(..., "raw-string")` call sites (regex scan)
- All current `src/` call sites use named constants; the test will catch any future regression

---

## FU-4: Pre-auth runtime test — DO namespace not touched on rejection ✅ ADDRESSED

**Runtime test:** `tests/server-pre-auth-runtime.ts` — 22 assertions (updated from 19).

`rejectUnauthorizedVaultRequest` in `server/src/routes/auth.ts` now returns
`AuthRejection | null` where `AuthRejection = { response: Response; reason: PreAuthRejectionReason }`.
No duplicated decision tree — `index.ts` wrapper logs `rejection.reason` directly.

Covered:
- `rejectUnauthorizedVaultRequest`: typed reason + correct HTTP status for all three rejection codes + null for authorized
- `handleSyncSocketRoute` (non-WebSocket): same three codes, DO trap never fires
- WebSocket upgrade path: not testable in Node.js (`WebSocketPair` is Cloudflare-only); auth gate logic is identical for WS/non-WS — this boundary is honest in the ledger and should remain so

**Open:** full WebSocket upgrade runtime path still untested. See static test `server-pre-auth-trace.mjs` for source-level coverage of that path.

---

## FU-5: Pure buildDiagnosticsBundle() + service-level test ✅ ADDRESSED

`buildDiagnosticsBundle` lives in `src/diagnostics/diagnosticsBundle.ts` — a pure,
Obsidian-free module. `diagnosticsService.ts` imports and re-exports it. Tests import
from `diagnosticsBundle.ts` directly and need no Obsidian mock.

`DiagnosticsService.runExport()` is a thin wrapper: gather data → call `buildDiagnosticsBundle`
→ check `leakDetected` → write file → show Notice.

`buildDiagnosticsBundle(input, { includeFilenames, salt? })` accepts an optional fixed salt
for reproducible test output (side-effect-free rather than claiming "pure").

**Runtime test:** `tests/diagnostics-bundle.ts` — 27 assertions covering:
- Safe mode: host/vaultId/deviceName → "(redacted)"
- Safe mode: token → `{ present: bool }` only (no prefix, no length)
- Safe mode: known vault paths absent from serialised bundle
- Safe mode: server URL / vault ID / device name absent
- Safe mode: `leakDetected: false` when redaction succeeds
- Safe mode: unseeded path in `serverTrace` caught by regex redactor (not just known-path replacement)
- Full mode: all sensitive fields present
- Hash diff counts correct

---

## FU-6: recordTrace recursion — add server-level behavioral test

**File:** `server/src/server.ts` — `recordTrace()` has an `isThrottleSummary` guard to prevent
the throttle-summary event from spawning another throttle-summary. The current test exercises
`TraceRateLimiter` helpers but does not drive `recordTrace()` directly.

**Fix:** Extract `recordTraceBudgetDecision(event, limiter)` as a testable pure function, or add
a test with a fake `appendTraceEntry` stub that verifies `recordTrace("trace-throttled", ...)` is
never called recursively when the event IS already `trace-throttled`.

---

## FU-7: Path-bearing diagnostic logs should use structured fields

**Files:** `src/diagnostics/diagnosticsService.ts`, and any log/trace call that interpolates path.

The current redactor catches quoted paths and known paths via exact replacement, but this depends
on a convention (quoted paths) that can be broken by future log lines.

**Long-term fix:** Replace log lines like:
```ts
log(`scheduled write for "${path}"`)
```
with structured trace calls:
```ts
trace("disk.write_scheduled", { path, reason })
```
where `path` is a structural key that the deep-walker redacts unconditionally.

This makes safe-mode redaction deterministic and independent of logging convention enforcement.

---

## FU-8: Server ack mechanism (serverAcked level)

**Context:** Phase 1.4 added `lastLocalUpdateWhileConnectedAt` — an observation that a local update
occurred while the transport was open. This is NOT equivalent to "server acknowledged." The ack
model in INV-ACK-01 has three levels: sent / serverAcked / durable. Only the transport-open
observation is implemented.

**Fix:** Add one of:
- server-side monotonically increasing per-room update counter, echoed to clients
- per-client update receipt message from server after applying a Y.js update
- y-partyserver awareness message confirming applied state vector

Until this exists, `lastLocalUpdateWhileConnectedAt` must not be labeled "sent" in any UI.

---

## FU-9a: Server-state offline handoff test ✅ ADDRESSED (Phase 1.5)

`tests/offline-handoff.ts` — 19 assertions covering the **server persistence layer**:
- Basic checkpoint handoff (A writes, server checkpoints, B cold-starts)
- Offline-edit handoff (A edits offline, syncs, B gets offline edits without A present)
- No simultaneous presence required (A explicitly out of scope when B connects)
- Journal-only handoff (no checkpoint, only journal entries)
- Incremental offline sessions (3 sync cycles)
- Content edit survival (Y.Text mutations, not just file creation)
- Tombstone/delete propagation

Scope: `Y.Doc → delta/checkpoint/journal → ChunkedDocStore → Y.Doc`.
Does NOT cover real WebSocket provider, Durable Object hibernation, IndexedDB
client-cache, Obsidian reconciliation, or disk mirror writeback after handoff.

## FU-9b: Live provider/client offline handoff integration test (open)

The full product claim requires one layer above FU-9a: actual VaultSync/provider
lifecycle. The test should:
1. Device A VaultSync instance edits and "disconnects" (provider.disconnect())
2. Server state is persisted (ChunkedDocStore, real or mocked DO)
3. Device B VaultSync instance connects cold, provider syncs
4. Assert CRDT paths/content AND Obsidian-visible vault state match A's edits

This is the test that proves the whole live path, not just persistence. Until it
exists, the offline handoff claim is validated at the storage level only.

---

## FU-10: Verify UpdateTracker origin assumptions against real library behavior ✅ SOURCE AUDIT (current versions only)

**Context:** `UpdateTracker` classifies Y.Doc update origins as remote (provider) / persistence
(IDB load) / local (everything else). These classifications assume:
- y-partyserver uses the provider object as update origin
- y-indexeddb uses the persistence object as update origin

**Verified against library source (y-partyserver@2.1.2, y-indexeddb@9.0.12):**

y-partyserver `dist/provider/index.js`:
  `messageHandlers[messageSync]` calls `syncProtocol.readSyncMessage(decoder, encoder, doc, provider)`
  → `y-protocols/sync.js readSyncStep2` → `Y.applyUpdate(doc, update, transactionOrigin)`
  where `transactionOrigin = provider`. Assumption confirmed. ✓

y-indexeddb `src/y-indexeddb.js`:
  `fetchUpdates` calls `Y.transact(idbPersistence.doc, ..., idbPersistence, false)` — origin = `idbPersistence`.
  `_storeUpdate` guards `origin !== this` to prevent re-persisting IDB-loaded updates. ✓

Documentation added to `UpdateTracker.attach()` with a re-verify-on-upgrade warning.
**This is a source audit for current versions, not permanent enforcement.** If either
library is upgraded, re-verify the origin contract manually — UpdateTracker will
silently misclassify updates if the assumption breaks without a test catching it.

---

## FU-11: buildDebugInfo() safe/sensitive classification

**Context:** `buildDebugInfo()` includes raw host URL, vault ID, and device name. It is NOT safe
for sharing. Currently it outputs `[local debug — includes server URL and vault ID]` as the first
line (added in Phase 1.4 tightening), but there is no enforcement preventing it from being
included in a safe-mode export or shared in a support context.

**Fix:** Either:
- Rename to `buildLocalDebugInfo()` with a JSDoc comment saying "not shareable"
- Add a safe/full mode parameter that redacts host/vault/device
- Audit all call sites (commands.ts "Copy debug info", "Show sync debug info") and document that
  these commands are local-only

---

## FU-12: Distinguish user edits from maintenance CRDT updates in diagnostics

**Context:** `lastLocalUpdateAt` includes ALL non-provider, non-persistence Y.Doc updates: user
edits via editor binding, disk syncs, snapshot restores, seed operations, schema migrations, and
repair writes. The label "Last local CRDT update" is accurate but a user may read it as "last time
I edited a note."

**Fix:** Add a separate `lastUserEditAt` timestamp that only fires when the y-codemirror binding
or a user-facing action applies a change (i.e., `origin instanceof YSyncConfig` or similar user-
edit indicator). This would let the status UI say "last note edit" with real precision.

---

## FU-13: Eliminate duplicate Yjs import warning in regression suite ✅ ADDRESSED

**Root cause:** Two separate yjs installs — `server/node_modules/yjs` (loaded by server/src imports)
and `node_modules/yjs` (loaded by test files and src imports). Both v13.6.29, different file paths,
treated as different module instances by Node's ESM loader.

**Fix:** `JITI_ALIAS` in `tests/run-regressions.mjs` routes all `"yjs"` specifiers to
`node_modules/yjs/dist/yjs.mjs` (the single root copy), preventing the dual-load:

```js
const ROOT_YJS = fileURLToPath(new URL("../node_modules/yjs/dist/yjs.mjs", import.meta.url));
const JITI_ENV = { ...process.env, JITI_ALIAS: JSON.stringify({ yjs: ROOT_YJS, ... }) };
```

`npm run test:regressions` now emits no Yjs duplicate-import warning. Verified: only
`chunked-doc-store.ts` and `offline-handoff.ts` were affected; all other jiti suites were clean.

---

## FU-14: Full recovery-amplifier controller orchestration test (partially addressed)

**Phase 1.6b addressed:** `tests/disk-mirror-observer.ts` — 17 assertions proving the DiskMirror
observer wiring (the "does not enqueue flushWriteUnlocked" claim):
- `afterTransaction` handler: all 6 recovery origins skip scheduling on closed files
- `afterTransaction` handler: provider origin schedules debounce timer on closed files
- Per-file text observer: recovery origins skip `pendingOpenWrites` on open files
- Per-file text observer: provider origin adds to `pendingOpenWrites` on open files
- Mixed cycle: recovery pass → no timer; provider update → timer set

Uses `tests/mocks/obsidian.ts` + `JITI_ALIAS` to provide a minimal runtime mock for the
obsidian package (no JS runtime exists in the obsidian npm stub).

**Still open — requires full Obsidian runtime or deeper controller stubs:**

1. `ReconciliationController` choosing disk as the only authority (disk=A, CRDT=B, editor=C)
2. `EditorBinding.repair()` path selected (CRDT→editor), NOT `heal()` (editor→CRDT)
3. Second reconciliation pass is no-op at the full controller level
4. Suppression fingerprint behavior
5. `flushWriteUnlocked` actual disk I/O correctness
