# Phase 0.5 verification report

Date: 2026-05-09. Status: in-progress; covers the priority list from the
combined reviewer instructions (Tier 1 corruption, Tier 2 trust, Tier 3
operational/security, Tier 4 data preservation).

This is a verification report, not a design document. For each invariant,
the matrix below names the exact files read, the evidence, the test
state, the recommended action, and whether the gap blocks Phase 1.

Status values: `verified_enforced`, `verified_partial`, `verified_missing`,
`verified_violated`, `unverified_blocked`.

No runtime code was modified in this pass. Three documentation corrections
applied as part of false-claim removal (`INV-PATH-01` weakening, `durable`
ack scope, "body sync" leftover wording) — those are listed at the end.

---

## Tier 1 — recovery amplifier (corruption class)

### `INV-EDIT-01` — One authority per Y.Text per recovery cycle

- Status: `verified_partial`.
- Files read: `src/runtime/reconciliationController.ts:700-872`,
  `src/sync/editorBinding.ts:233-318`, `src/sync/diskMirror.ts:31-65`,
  `tests/bound-recovery-regressions.mjs`.
- Evidence:
  - `reconciliationController` distinguishes three editor-bound divergence
    classes: `local-only` (line 706), `crdt-only` (line 798), `ambiguous`
    (line 851).
  - The `local-only` and `crdt-only` paths each apply exactly one
    authority (disk) via `applyDiffToYText` and then call
    `editorBindings.repair()` (line 777), not `heal()`. `repair()` does
    not write to `Y.Text` — it reconfigures the binding only
    (`editorBinding.ts:233-290`).
  - `boundRecoveryLocks` (line 774, 846) suppresses re-entry within
    `BOUND_RECOVERY_LOCK_MS`.
  - `ambiguous-divergence` path skips entirely (line 870), preserving
    both states by no-op.
- Test state: `tests/bound-recovery-regressions.mjs` covers the
  `applyDiffToYText` building block; it does not exercise the
  `reconciliationController` orchestration end-to-end. The negative
  scenario (disk-then-heal amplifies) is asserted to confirm the bad
  pattern; the production path no longer uses heal-after-disk-recovery.
- Missing test: integration test that drives `reconciliationController`
  with mocked `editorBindings` and asserts `heal()` is never called in
  the local-only/crdt-only recovery flow.
- Action: add reconciliation-controller integration test before any new
  recovery code lands.
- Blocks Phase 1: **yes** (release-gate item; needs orchestration-level
  test before fix-confidence is claimable).

### `INV-EDIT-02` — Healing after disk recovery does not write

- Status: `verified_enforced`.
- Files read: `src/runtime/reconciliationController.ts:776-789`,
  `src/sync/editorBinding.ts:233-318`.
- Evidence:
  - In the post-disk-authority recovery, the code calls
    `editorBindings?.repair(...)` (line 777). On failure it falls back to
    `rebind()`, which destroys and re-creates the binding without a
    Y.Text write.
  - `heal()` (line 293) IS still defined and writes editor content to
    Y.Text, but it is not called from the recovery paths in
    `reconciliationController`. The only `heal` call sites in the repo
    are inside `editorBinding.ts` itself (post-bind health and
    live-update path), not from recovery.
- Test state: indirect coverage in `bound-recovery-regressions.mjs` test
  3 ("post-recovery health retries stay bounded without editor
  rewrites").
- Missing test: an explicit assertion that `heal()` is never invoked
  during recovery cycles.
- Action: add a stub-based test asserting `heal` call count is zero
  during the reconciliation paths covered by `INV-EDIT-01`.
- Blocks Phase 1: no (enforcement holds; test improves confidence).

### `INV-SAFETY-02` — Local repairs do not round-trip as remote writebacks

- Status: `verified_partial`.
- Files read: `src/sync/diskMirror.ts:31-65`,
  `src/runtime/reconciliationController.ts:749`,
  `src/sync/editorBinding.ts:315`.
- Evidence:
  - `diskMirror.ts` defines `LOCAL_STRING_ORIGINS = { ORIGIN_SEED,
    "disk-sync", ORIGIN_RESTORE }` and `isLocalOrigin()` excludes the
    provider origin from triggering disk writes.
  - Recovery writes use string origins like `"disk-sync-recover-bound"`,
    `"disk-sync-open-idle-recover"`, `"editor-health-heal"`. None of
    these are listed in `LOCAL_STRING_ORIGINS`. They land in the default
    branch of `isLocalOrigin()` (line 50: non-null object → local; null
    → local; string not in set → "remote" via `origin === provider`
    failing).
  - **Risk:** `"disk-sync-recover-bound"` is a string not in
    `LOCAL_STRING_ORIGINS`. By the function logic (line 49: `if (typeof
    origin === "string") return LOCAL_STRING_ORIGINS.has(origin)`), it
    returns `false` — i.e. **treated as remote** — which would cause
    `diskMirror` to write the file back to disk. That is the round-trip
    surface.
  - This warrants direct verification by reading the disk-write
    suppression and rechecking whether `disk-sync-recover-bound` writes
    are intentionally allowed to propagate to disk (which would be
    correct: the recovery aligns CRDT to disk, so disk is already
    correct and the write is a no-op or suppressed by the path
    suppression window).
- Test state: no dedicated test for origin-based round-trip suppression
  during recovery.
- Missing test: a dedicated test that emits a
  `"disk-sync-recover-bound"`-origin write and asserts no
  `diskImport.external_modify_detected` (or equivalent) follow-up event
  fires within the suppression window.
- Action: read `diskMirror.flush*` paths next pass to confirm the
  `"disk-sync-recover-bound"` origin is genuinely suppressed (likely via
  `suppressedPaths`). If not, this is the second leg of the amplifier.
- Blocks Phase 1: **yes** (release-gate item; the origin-set looks too
  narrow and needs confirmation before #22/#25 are claimed fixed).

---

## Tier 2 — handoff trust

### `INV-AUTH-01` — Connection facts are independently exposed

- Status: `verified_missing`.
- Files read: `src/runtime/connectionController.ts:1-301`.
- Evidence:
  - `ConnectionState` is a tagged union: `disconnected | loading_cache |
    connecting | online | offline | auth_failed | server_update_required`
    (lines 9-16).
  - The three independent facts the invariant requires — server
    reachable, auth accepted, WebSocket open — are NOT separately
    exposed. `auth_failed` carries a code, but reachable-but-auth-rejected
    is indistinguishable from reachable-but-WS-closed at the consumer
    level.
  - `getState()` (line 94) collapses everything into one tagged value.
- Test state: none for decomposed facts.
- Missing test: status surface contract test asserting separate
  reachable/authAccepted/websocketOpen booleans.
- Action: add fact decomposition to `ConnectionController` — extend the
  state shape to include `facts: { serverReachable, authAccepted,
  websocketOpen }`. This is engine work, queued for Phase 1.
- Blocks Phase 1: **yes** (release-gate item).

### `INV-OFFLINE-01` — Pending state is exposed

- Status: `verified_missing`.
- Files read: `src/sync/vaultSync.ts` (greps for
  `pendingLocalUpdates|lastPushedAt|lastFetchedAt|serverAcked`).
- Evidence:
  - No matches. Provider-level `synced` boolean exists (y-partyserver
    initial-state-received) but is not the same as pending-local-updates
    or last-pushed timestamp.
  - There is no acknowledgement message protocol from server to client
    confirming individual update acceptance or persistence.
- Test state: none.
- Missing test: end-to-end test asserting "after edit, before
  WebSocket flush, pending count == 1; after flush, pending count == 0."
- Action: design ack channel before this invariant can be honored.
  Likely requires server-side cooperation (counter or message). See
  `INV-ACK-01`.
- Blocks Phase 1: **yes** (release-gate item; the user-visible trust
  signal does not exist).

### `INV-OFFLINE-02` — Catch-up reports availability

- Status: `verified_missing`.
- Files read: `src/runtime/connectionController.ts:152-191`,
  `src/sync/vaultSync.ts:355-365` (`onProviderSync`).
- Evidence:
  - `setupReconnectionHandler` runs `runReconnectReconciliation` and
    logs internally, but emits no structured user-visible event
    distinguishing "applied N updates from generation X" from "no new
    state."
  - `onProviderSync` callback fires on `(synced=true)` regardless of
    whether the diff was empty.
- Test state: none.
- Missing test: reconnection scenario asserting status surface reports
  catch-up outcome explicitly (counts + generation).
- Action: extend `onProviderSync` to carry diff stats (updates applied,
  generation advanced), or instrument `runReconnectReconciliation` to
  emit a `catchup.completed` event with counts.
- Blocks Phase 1: **yes** (release-gate item).

### `INV-ACK-01` — Pushed/fetched timestamps define their ack level

- Status: `verified_missing`.
- Files read: same as `INV-OFFLINE-01`. No ack-level tracking exists.
- Evidence: no `serverAcked`, `durable`, ack-channel, or per-update
  receipt in plugin or server code paths reviewed.
- Action:
  - **Re-scope the invariant** to drop `durable` from the v0 contract.
    Server ack at storage-commit level is non-trivial under
    y-partyserver's hibernation model; promising it now is the kind of
    fake precision the reviewers warned about.
  - **Sent** is reportable today (provider.send() called).
  - **ServerAcked** requires a small server-side change — a counter that
    the server sends back to the client periodically, allowing the client
    to compute "pending = local-applied-count - server-acked-count."
  - **Durable** deferred until checkpoint-commit notification is wired.
  - The contract document already names this scope (Q11) but the
    invariant text should be tightened in the next pass to forbid
    exposing `durable` until the server-side mechanism exists.
- Blocks Phase 1: **yes** (release-gate item; ship `sent` and
  `serverAcked` only).

### `INV-CONTRACT-01` — Devices do not need simultaneous presence

- Status: `unverified_blocked`.
- Files read: server load/save lifecycle (`server/src/server.ts:62-181`),
  client provider lifecycle (`vaultSync.ts` greps).
- Evidence:
  - Server persists via checkpoint+journal; `onLoad`/`onSave` are
    correct in shape.
  - Client persists via y-indexeddb and replays on reconnect.
  - **Issue #24 reports a contract violation in practice.** Without
    end-to-end testing across two simulated devices (one offline, one
    online, then swapped), the structural design cannot be claimed
    verified.
- Test state: none direct. `tests/v2-offline-rename-regressions.mjs` and
  `tests/closed-file-mirror.ts` exist but were not read in this pass.
- Action: build a two-client harness test that forces the issue #24
  scenario. Until that exists, this invariant is blocked from
  verification.
- Blocks Phase 1: **yes** (the invariant is the core product claim; a
  passing harness test is a prerequisite to closing #24).

---

## Tier 3 — operational and security

### `INV-OBS-01` — Observability cannot affect availability

- Status: `verified_enforced`.
- Files read: `server/src/server.ts:306-327`.
- Evidence: `recordTrace` wraps `appendTraceEntry` in try/catch; failures
  are logged via `console.error` but do not throw or affect room
  availability. Matches the explicit fail-open design in
  `engineering/warts-and-limits.md`.
- Test state: server-hardening tests
  (`tests/server-hardening.ts`, `tests/hardening-worker.mjs`) exist;
  not read in this pass.
- Action: confirm hardening tests cover trace persistence failure path.
- Blocks Phase 1: no.

### `INV-OBS-02` — Trace writes are bounded with explicit budgets

- Status: `verified_violated`.
- Files read: `server/src/traceStore.ts:1-219`,
  `server/src/server.ts:18` (`MAX_DEBUG_TRACE_EVENTS = 200`),
  `server/src/index.ts:35-67` (HTTP rejection trace path).
- Evidence:
  - Per-entry bound: 16 KiB (`MAX_TRACE_ENTRY_BYTES`). Note: the draft
    invariant document mistakenly states 4 KiB; corrected below.
  - Per-string bound: 2 KiB. Array items: 20. Object keys: 20. Depth: 4.
  - Per-room rolling cap: 200 (`MAX_DEBUG_TRACE_EVENTS`), enforced via
    list+delete cascade in `appendTraceEntry`.
  - **No per-minute write rate limit.** Every emit triggers a put +
    list + (delete-cascade if over cap). Under hot loops or pathological
    clients, this is the issue #40 surface.
  - **Pre-auth durable writes are NOT zero.** `index.ts:44-65` calls
    `recordVaultTrace` for "unclaimed", "server_misconfigured", and
    "unauthorized" responses **before** `isAuthorized` returns. These
    write to DO storage. This is the most likely root of issue #40 and
    constitutes a `INV-SEC-01` violation (see below).
- Test state: `tests/trace-store.ts` exists; not read in this pass.
- Missing test: pre-auth fuzzing test asserting unauthorized requests
  produce zero DO storage writes.
- Action:
  - Move the rejection traces to a counter or in-memory ring; do not
    persist pre-auth events.
  - Add explicit per-minute and per-day write budgets enforced at
    `appendTraceEntry` entry; refuse silently when over budget.
  - Correct the per-entry budget number in `sync-invariants.md` (16 KiB
    actual, not 4 KiB draft).
- Blocks Phase 1: **yes** (release-gate item; #40 is the existential
  free-tier risk).

### `INV-SEC-01` — No pre-auth state mutation

- Status: `verified_violated`.
- Files read: `server/src/index.ts:35-67`,
  `server/src/server.ts:104-126`.
- Evidence:
  - `rejectUnauthorizedVaultRequest` calls `recordVaultTrace` (which
    persists to DO storage via `appendTraceEntry`) before returning the
    rejection response. This happens for both `unclaimed`/`server_misconfigured`
    and `unauthorized` paths — i.e. pre-auth or failed-auth state is
    mutated.
  - The `/__yaos/document` GET inside the DO returns full Y.Doc state
    without an internal auth check; it relies on the worker entry point
    having gated it. Defensible as defense-in-depth but the entry-point
    gate via `rejectUnauthorizedVaultRequest` runs trace writes before
    the gate decision is final.
- Test state: none for pre-auth write zero-count.
- Missing test: pre-auth fuzz asserting no `trace:*` keys created from
  unauthorized requests.
- Action: same as `INV-OBS-02` — kill pre-auth persistence. Either
  buffer in memory or drop entirely. The trace value of unauthorized
  rejections is operational, not per-room — aggregate them at the
  worker level instead of per-room DO storage.
- Blocks Phase 1: **yes**.

### `INV-SEC-02` — Diagnostics never include secrets or content by default

- Status: `verified_violated`.
- Files read: `src/diagnostics/diagnosticsService.ts:191-258`.
- Evidence:
  - Token is truncated to an 8-char prefix (line 197). Good.
  - Diagnostic export written to `${diagDir}/sync-diagnostics-*.json`
    in the user's vault (line 252). Local-only by default. Good.
  - **However, full vault paths are included by default** in:
    `hashDiff.missingOnDisk` (full paths), `hashDiff.missingInCrdt`
    (full paths), `hashDiff.hashMismatches[].path`, `recentEvents.*`
    (per `vaultSync.getRecentEvents`), `openFiles`, `diskMirror`
    snapshot, `blobSync` snapshot, `serverTrace`.
  - There is no "redact filenames" toggle and no two-tier export
    (safe summary vs. with-filenames). The reviewer's `INV-SEC-02` text
    requires filenames excluded by default with an explicit second
    action.
- Test state: none.
- Missing test: snapshot test of default diagnostic export shape that
  asserts no full paths appear; explicit second-action test that
  asserts paths included with a warning surfaced.
- Action: split export into "summary" (no paths) and "with-filenames"
  (warning-gated). Hash paths to stable per-bundle salts so events can
  still be correlated within a bundle without leaking filenames.
- Blocks Phase 1: **yes** (release-gate item).

---

## Tier 4 — data preservation and structure

### `INV-CONFLICT-01` — Ambiguous divergence preserves both states

- Status: `verified_partial`.
- Files read: `src/runtime/reconciliationController.ts:851-872`.
- Evidence:
  - The `bound-file-ambiguous-divergence` path skips with no Y.Text
    write and emits a structured trace event (line 851-869).
  - "Skip" is preservation by inaction — neither side is overwritten.
    Acceptable for the strict reading of the invariant.
  - **Gap:** there is no user-visible reason code or quarantine entry
    for ambiguous-divergence skips. The user sees "nothing happened" and
    cannot tell that the system is preserving rather than failing.
- Test state: none direct.
- Missing test: ambiguous-divergence reconciliation asserts no Y.Text
  write AND a status-surface entry visible to the user.
- Action: emit a reason code (`safety.ambiguous_divergence_held`,
  reserved) and surface via the safety subsystem.
- Blocks Phase 1: no (preservation works; visibility upgrade is Phase 2).

### `INV-FOLDER-01` — Empty folder support is explicit

- Status: `verified_missing`.
- Files read: greps across `src/sync/` for folder-related code.
- Evidence:
  - No folder-cleanup code path observed.
  - No metadata for "this empty folder was created as a materialization
    artifact for path X" (the precondition the bounded-cleanup variant
    of `INV-FOLDER-01` would require).
  - Issue #38 confirms the half-supported state: deleted/moved folders
    leave orphan empty folders on the destination device.
- Test state: `tests/folder-rename.ts` exists; not read in this pass.
- Action: choose the contract position before code work — current
  recommendation is the `(c)` non-support default for v0 (document, do
  not auto-clean), with `(b)` bounded cleanup as a Phase 2 add-on once
  materialization metadata is captured. The current invariant text in
  `sync-invariants.md` still favors `(b)` immediately; this is too
  aggressive without metadata. Soften in next doc revision.
- Blocks Phase 1: **partially** (release-gate item lists folder
  cleanup; this report recommends downgrading to "documented
  non-support" for the next stability release and deferring `(b)` until
  metadata exists).

### `INV-SCHEMA-01` — Schema/cache skew blocks loudly

- Status: `verified_partial`.
- Files read: `src/sync/vaultSync.ts:380-421`.
- Evidence:
  - `checkSchemaVersion()` returns an error string when stored doc
    schema is newer than client's `SCHEMA_VERSION`.
  - There is no client-cache vs. room-schema check (cached IndexedDB
    state may still apply to a doc that has since moved schema).
  - There is no explicit reset/rebuild/migrate flow offered to the user
    on mismatch — the error is a string returned to a caller.
- Test state: `tests/schema-guard.mjs` exists; not read in this pass.
- Action: add cache-vs-room schema gate; surface mismatch as
  `connection=blocked` with reason `capabilities.schema_skew_blocked`
  and an actionable resolution UI.
- Blocks Phase 1: no (current behavior is fail-loud-string, not
  silent-degrade; the missing piece is action UX, which is Phase 2).

### `INV-PATH-01` — Path normalization is stable

- Status: `verified_missing` (per the invariant's literal current
  wording); the wording is also too strong per Reviewer 1 and is being
  weakened in the doc-correction list below.
- Files read: `src/sync/vaultSync.ts:425-430` (`normPath` →
  `normalizePath` from Obsidian).
- Evidence:
  - `normalizePath` from Obsidian normalizes `/` separators and trims;
    it does NOT NFC-normalize Unicode and does NOT detect
    case-collision across platforms.
  - macOS HFS+ NFD vs Linux NFC, Windows case-insensitive vs Linux
    case-sensitive — none of these are handled.
- Action:
  - **Weaken the invariant text** to: "YAOS normalizes Unicode to NFC
    and path separators consistently. YAOS detects case-colliding paths
    across devices and surfaces a reason code; it does not blindly
    fold case into the CRDT key."
  - Implement NFC normalization at `normPath`. Implement case-collision
    detection as a separate pass (warn, do not collapse).
- Blocks Phase 1: no (correctness improvement; not a release-gate).

---

## Documentation corrections (false-claim removal)

The following corrections are applied to the existing draft docs. They
are not architecture changes — they remove statements the verification
showed to be wrong or too strong.

1. **`INV-PATH-01` weakened** — was "two paths the user would consider
   identical must hash to the same key on every supported platform";
   now "NFC + path-separator normalization, case-collision detection
   without blind case-folding."
2. **`durable` ack scope tightened** — `INV-ACK-01` now forbids
   exposing `durable` ack until a server-side commit-notification
   mechanism exists. `serverAcked` and `sent` are the v0 levels.
3. **"Body sync continues" leftover** — replaced with "sync for
   unaffected paths continues" in `INV-SAFETY-01` and elsewhere.
   Current architecture is one `Y.Text` per file (body + frontmatter),
   so per-file pause cannot mean "body continues, frontmatter pauses."
4. **`INV-OBS-02` per-entry budget** — corrected from 4 KiB (draft
   guess) to 16 KiB (actual `MAX_TRACE_ENTRY_BYTES`).
5. **`INV-FOLDER-01` default** — invariant currently mandates Phase 1
   bounded cleanup; this report recommends documented non-support as
   the v0 default and deferring bounded cleanup until materialization
   metadata exists. The doc revision in this pass softens the language
   to make the choice explicit.

---

## Summary — what blocks Phase 1

Items that are release-gate `Must ship` and currently `verified_missing`
or `verified_violated`:

- `INV-AUTH-01` — connection facts not decomposed.
- `INV-OFFLINE-01` — no pending state exposed.
- `INV-OFFLINE-02` — no catch-up availability report.
- `INV-ACK-01` — no ack levels at all (re-scope to drop `durable` from
  v0).
- `INV-OBS-02` — pre-auth writes occur; no rate limit.
- `INV-SEC-01` — pre-auth state mutation via rejection-trace path.
- `INV-SEC-02` — diagnostics include filenames by default.
- `INV-EDIT-01` (orchestration test missing).
- `INV-SAFETY-02` (origin-set may be too narrow; needs direct
  confirmation in next pass).
- `INV-CONTRACT-01` (unverified; needs two-client harness).

Items that are not release-gate but worth fixing while in the area:

- `INV-EDIT-02` test improvement.
- `INV-CONFLICT-01` ambiguous-divergence reason code.
- `INV-PATH-01` NFC normalization.
- `INV-SCHEMA-01` cache-vs-room gate and resolution UX.

## What was not verified

- `INV-DISK-01..03`, `INV-DELETE-01..03`, `INV-EXT-01`, `INV-BLOB-01..02`,
  `INV-CAP-01..02`, `INV-SAFETY-01/03`, `INV-AUTH-02`, `INV-SEC-03..04`,
  `INV-SPECIAL-01`, `INV-DOC-01`, `INV-CONTRACT-02`. These were outside
  the agreed Phase 0.5 priority list. Pass them through the same matrix
  before Phase 1 closes.
- Existing tests not yet read: `tests/folder-rename.ts`,
  `tests/closed-file-mirror.ts`, `tests/v2-offline-rename-regressions.mjs`,
  `tests/schema-guard.mjs`, `tests/server-hardening.ts`,
  `tests/hardening-worker.mjs`, `tests/trace-store.ts`. They likely
  cover some of the gaps above and would shift status values; left
  unread to keep this pass scoped.
