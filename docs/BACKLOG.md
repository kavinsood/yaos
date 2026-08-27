# Main backlog

Canonical list of unfinished work on current `main`. The multivault control plane, operator recovery key, pairing enrollment, device memberships, mandatory socket tickets, and exact schema admission have landed; completed cutover work is not carried here. Current product defects remain until their own closure evidence exists.

Each item names current evidence, required work, and closure evidence. Historical discussion remains in Git history. Per-vault storage accounting, operator recovery, and sharding are the named next architecture block; schema 4, settings sync, headless clients, and Docker packaging are not shipped.

## Priority definitions

- **P0:** known correctness/data-preservation or current user incident.
- **P1:** required evidence or hardening for a confidence-heavy release.
- **P2:** bounded engineering debt; carry only while its owning code survives integration.
- **External:** closure depends on a reporter or real device/deployment unavailable to CI.

## P0 correctness and user incidents

### SYNC-01 — offline local delete is resurrected on re-enable

**State:** Known product bug with a hard failing two-device regression. The product still resurrects the deleted file.

**Evidence:** `qa/controllers/two-device-scenarios/issue22-reconnect.ts`, scenarios `issue-22-disable-reenable-local-delete-remote-unchanged` and `issue-22-disable-reenable-local-delete-remote-edits`. Both fail closed on resurrection, failed delete propagation, or a delete-vs-edit conflict that drops a side. When the file is absent on disk but still present in CRDT, `VaultSync.reconcileVault()` places it in `createdOnDisk`; `ReconciliationController` writes it back. The implementation cannot distinguish a file missing because this device has never materialized it from a file that this device previously indexed and deleted while YAOS was disabled.

**Required work:**

1. Define startup classification using the persisted disk index: known indexed path now absent versus path never materialized locally.
2. Ensure unreadable/skipped paths cannot be mistaken for confirmed deletion.
3. Propagate a proven offline delete without allowing a stale device to delete a genuinely new remote file.
4. Preserve conflicting remote edits according to the delete/conflict contract. Do not convert the existing scenarios back to warning-only acceptance.

**Closure:** Focused regression fails before the fix and passes after it; re-enable keeps the file absent on the deleting device; the remote device observes the intended delete or an explicitly preserved conflict; unreadable-path and new-device materialization cases remain safe.

### SYNC-02 — bound-file re-enable can discard one changed side

**State:** Open correctness gap with real iPad trace history.

**Evidence:** `ReconciliationController.handleBoundFileSyncGap` has `localOnly`, `crdtOnly`, and ambiguous branches. If disk and CRDT both changed from the persisted baseline but the editor equals one side, the equality shortcut can select that side without invoking the full closed-file three-way classifier. A recorded ordering produced remote CRDT at the original path and discarded the local iPad edit without an artifact.

**Required work:**

1. Compute baseline, disk, and CRDT hashes before the local-only/CRDT-only shortcut.
2. When both sides differ from baseline and from each other, run the same preserve-conflict classification used for closed files.
3. Preserve the losing version before applying the winner.
4. Keep current `crdt-current-no-op` and recovery-lock skips.
5. Cover provider-sync-versus-reconcile ordering, not only the pure classifier.

**Closure:** Deterministic regression proves preservation and convergence; a real iPad re-enable run reproduces the relevant ordering and retains both versions.

### ISSUE-19 — `.base` rollback and bulk-clipping misses

**State:** Open GitHub issue from YAOS 1.6.0.

**Evidence:** User reports local `.base` layout changes later disappearing and one of several iOS Web Clipper-created Markdown files failing to reach desktop until renamed. `.base` currently uses the attachment plane; bulk-created Markdown uses ordinary file admission.

**Required investigation:** Treat these as two failure shapes until evidence joins them. Reproduce `.base` write/restart/reconnect through attachment hashing and download conflict policy. Reproduce a burst of iOS-created Markdown files and trace watcher admission, dirty-set draining, disk-index advancement, CRDT creation, provider receipt, and desktop materialization. Do not convert `.base` to Markdown character merging as a symptom fix.

**Closure:** Each shape has a focused failing reproduction, root-cause fix, regression, and reporter-facing build/result. Renaming must not be required to recover a missed create.

### ISSUE-23 — Canvas rollback and Excalidraw save freeze

**State:** Open GitHub issue from YAOS 1.6.1.

**Evidence:** User reports Canvas versions alternating after phone restarts and sporadic whole-Obsidian freezes when Excalidraw saves while YAOS is enabled. Both formats use the attachment plane; Excalidraw's own save behavior may contribute but does not explain a YAOS-only freeze.

**Required investigation:** Reproduce Canvas create/edit/restart across desktop and mobile while recording blob tombstones, hash cache, upload/download queue, and conflict decisions. Profile the Excalidraw save path for synchronous hashing, repeated watcher churn, queue loops, and plugin interaction. Preserve the exact file bytes and operation ordering; do not infer one root cause for both formats without evidence.

**Closure:** Focused reproductions identify the responsible path; Canvas no longer rolls backward/oscillates; Excalidraw save does not freeze Obsidian under the reproduced workload; attachment regressions cover the fixed transitions.

### ISSUE-68 — false receipt warning and idle auth rejection

**State:** Open against 2.1.0.

**Evidence:** Reporter traces show a candidate confirmed by one server echo and then reverted to `serverDominatesCandidate=false` by a later echo with the same encoded byte count. The status bar returns to “local state not yet received.” The same reporter observes `Auth rejected` after idle time and must reload the plugin.

**Required investigation:** Treat receipt state and idle authentication as separate until traces prove a connection. For receipts, reproduce the exact candidate/state-vector/persistence-generation sequence and determine whether remote or maintenance updates replace the candidate, whether a later non-dominating echo is allowed to revoke a valid latest-state receipt, or whether server/client documents diverge despite equal encoded lengths. For auth, capture ticket expiry, proactive refresh, patched provider URL, reconnect attempts, fatal frames, and HTTP ticket refresh result over real idle/sleep timing.

The existing local `ws-ticket-reconnect` suite proves URL patching and short-TTL reconnect under Wrangler; it does not invalidate the field report.

**Closure:** Issue-shaped traces no longer produce a false negative; status language remains exact; a real idle/sleep reconnect succeeds without plugin reload; regression coverage fails on the identified root cause.

## P1 validation and release confidence

### QA-01 — strict Linux+iPad+Android active-edit proof

**State:** Implemented scenario; never executed to its strict contract.

**Evidence:** Existing three-device evidence is passive agreement on a pre-existing hash. The two-desktop active-edit scenario passes, but it is not real mobile evidence.

**Required work and closure:** Execute the procedure in [QA](qa.md#qa-01-strict-three-device-active-edit). Preserve three untouched bundles, analyzer report, and human summary. Closure requires foreground iOS/Android, a distinct Linux local-edit target hash, both mobile devices settling that exact hash, and `summary.ok: true`.

### QA-02 — real-device conflict-artifact proof

**State:** Desktop proof exists; mobile/tablet proof absent.

**Required work and closure:** Execute [QA](qa.md#qa-02-real-device-conflict-artifact) on real devices. The local offline edit must survive at the original path, remote content must be preserved in a Markdown conflict artifact, that artifact must synchronize to the other devices, and all original paths must converge.

### QA-03 — iPad missing-baseline/cold-relaunch proof

**State:** Desktop classifier and CDP coverage exist; mobile filesystem timing is unproven.

**Evidence:** The current heuristic gives disk the original path only when `diskMtime > lastDiskIndexPersistedAt`; otherwise CRDT wins while disk is preserved separately. The timestamp is global and may be coarse or preserved by external tools.

**Required work:** Kill/suspend Obsidian before disk-index persistence, edit locally, advance remote state, relaunch on iPad, and capture the decision fields (`missingBaselinePolicy`, mtimes, evidence, winner, artifact).

**Closure:** User-visible local work is not silently demoted or lost; the trace matches the documented policy; limitations remain explicit if the filesystem cannot provide decisive evidence.

### QA-04 — live provider/client sequential handoff

**State:** Storage-level and live Worker components exist; full product-visible proof is missing.

**Evidence:** Server persistence tests and Issue #24 experiments prove checkpoint/journal behavior. The missing claim is one layer above storage.

**Required work:** Device A edits through the client, receives the appropriate server receipt, and disconnects. Start Device B cold with A absent. Assert B's Yjs content and ordinary Obsidian file both match A's edit. Ensure the proof does not rely on simultaneous peer presence.

**Closure:** Reproducible integration evidence passes after a server cold-load/eviction boundary and fails if durable handoff is removed.

### QA-05 — real Node-filesystem watcher proof

**State:** Adapter-write and controller tests exist; OS watcher path unproven.

**Required work:** In a real debug-enabled Obsidian instance, modify an open/bound file through `qa/controllers/node-vault-fs.ts::writeNodeFileAndWait`, not the vault adapter. Exercise tab-close/reconcile deferral and preserve the trace.

**Closure:** The OS event reaches the intended controller path, no wrong-authority overwrite occurs, and disk/editor/CRDT converge.

### QA-06 — original reporter validation for the #22 family

**State:** Internal fail/pass evidence exists; no reporter confirmation is recorded.

**Closure:** Reporter validates a fixed build or the project explicitly closes the external-validation requirement with a documented decision. Internal QA must not be relabeled as reporter evidence.

### QA-07 — blank workspace live acceptance

**State:** `qa:prepare` output is hermetically byte-tested but not accepted against a supported Obsidian runtime.

**Required work:** Prepare a fresh vault, open it in Obsidian, and use CDP to verify no Markdown leaf, recent file, or vault-specific path is restored.

**Closure:** Live acceptance records Obsidian version and observed empty workspace state.

### OPS-01 — duplicate-Yjs warning re-check

**State:** The old duplicate-import cause was fixed; at least one later live run reportedly still emitted the warning.

**Required work:** Run the current CI/live entrypoints from a clean checkout and identify the module paths if the warning appears. Distinguish stale generated JS, nested dependency copies, and runner aliasing.

**Closure:** Either reproduce and remove the second import or preserve a clean run proving the current entrypoints load one Yjs copy.

### OPS-03 — Cloudflare WebSocket upgrade coverage boundary

**State:** Node/Miniflare and local Wrangler cover most pre-auth and socket behavior; Cloudflare-specific upgrade handling is not completely represented in Node tests.

**Required work:** Identify the remaining production-only branch rather than adding another broad harness. Exercise it against a deployed Worker if it affects admission or rejection guarantees.

**Closure:** The exact branch has deployed evidence or is removed/refactored into tested platform-independent logic.

## P1 path, reconciliation, and diagnostics

### PATH-01 — NFC/NFD normalization across the full pipeline

**State:** Canonicalization exists at rename admission; storage/import/reconcile do not uniformly use it.

**Evidence:** `findCanonicalPathCollisions()` is tested but has no production caller. `main.ts` can emit a collision trace but explicitly does not resolve it. Case folding is intentionally undecided.

**Required work:** Define the invariant for Obsidian display paths versus CRDT identity keys. Exercise startup scan, create/import, rename, reconcile, and persisted disk index with NFC/NFD variants. Wire collision detection at an admission boundary or delete the unused vault-wide primitive. Do not add platform-dependent case folding without a separate product decision.

**Closure:** No two CRDT identities are created for canonically equivalent paths; collision behavior is deterministic and tested on relevant filesystems; unused detection code is absent.

### REC-01 — local repair must not round-trip as remote writeback

**State:** Representative #22 evidence exists; the exact invariant lacks a focused proof.

**Required work:** Drive a local repair through CRDT, editor binding, DiskMirror suppression, and the resulting watcher event. Assert that the repair-origin write is acknowledged/suppressed and does not return as external input or produce a second semantic update.

**Closure:** Focused test fails when origin/suppression is removed and passes through the real orchestration path.

### REC-02 — full recovery-controller orchestration proof

**State:** Policy and partial controller tests exist; complete orchestration remains uncovered.

**Required work:** In one realistic path prove: disk selected as sole authority when disk/CRDT/editor diverge; `EditorBinding.repair()` selected rather than `heal()` when health requires it; `flushWriteUnlocked` performs the intended disk I/O; suppression fingerprint is installed; second reconciliation pass is a no-op.

**Closure:** One behavioral test covers the complete sequence without replacing dependencies so aggressively that the disputed transitions cannot fail.

### TRACE-01 — direct throttle-summary recursion test

**State:** `recordTrace()` has an `isThrottleSummary` recursion guard; tests do not invoke the recursion shape directly.

**Required work:** Saturate trace throttling, force summary emission, and assert the summary does not recursively create another summary or affect room availability.

**Closure:** Behavioral server test fails if the guard is removed.

### TRACE-02 — structured path-bearing diagnostics

**State:** Safe redaction handles known structured path fields and seeded free-form paths, but product logs still interpolate paths into strings.

**Required work:** Move path values used by support-facing diagnostics into recognized structured fields. Extend event types and redaction tests with each migrated path. Avoid a mechanical logging rewrite unrelated to exported/support data.

**Closure:** Safe bundles contain no raw migrated paths and no longer depend on regex discovery for those events.

### TRACE-03 — explicit safe versus local-only diagnostics contract

**State:** `buildDebugInfo()` and exports carry overlapping safe/local values; the contract depends partly on caller expectations.

**Required work:** Define separate typed payloads or builders for safe export and explicitly confirmed filename-inclusive/local inspection. Server URL, vault ID, device name, tokens, and paths must not cross the safe boundary.

**Closure:** Compile-time separation and runtime leak tests reject insertion of sensitive fields into the safe payload.

### STATUS-01 — distinguish user edits from maintenance updates

**State:** `lastLocalUpdateAt` includes user edits, disk imports, restores, repairs, and maintenance writes.

**Required work:** If UI continues to imply user activity, capture user-edit origin separately. Otherwise rename/remove the claim. Do not infer authorship solely from “local” Yjs origin.

**Closure:** Status copy and source fact have matching semantics, with origin tests for user edit versus repair/restore.

## P2 debt subject to integration survival

### ARCH-01 — planner/mutation split around `reconcileVault`

**State:** `mintAdmissionOpId` callback is a controller-shaped seam in `VaultSync.reconcileVault()` so a decision can be emitted before mutation.

**Decision:** If this code survives the next architecture block, return a seed plan without mutation; let the controller mint IDs, emit decisions, and call `ensureFile`; cut over every caller together.

**Closure:** Callback and compatibility comments are removed, every caller uses the selected ownership boundary, and decision-before-mutation tests remain.

### ARCH-02 — complete or stop TraceSink migration

**State:** Some DiskMirror, provider, recovery, and path-scoped events bypass `FlightTraceSink`.

**Decision:** Enumerate bypasses that still serve a product/support contract. Route those through mapped typed events; delete incidental tracing rather than creating an abstraction solely for completeness.

**Closure:** The documented boundary matches imports/callers; no claim of full dependency inversion while bypasses remain.

### ARCH-03 — narrow telemetry mutable handles

**State:** Telemetry host access remains broader than its read-only sync-state intent, including concrete service handles and the Obsidian `App` for file output.

**Required work:** If the current telemetry runtime survives integration, define minimal read ports for DiskMirror/BlobSync and a narrow diagnostics file-output port. Preserve mobile adapter behavior.

**Closure:** Telemetry cannot call mutation-capable members through its types; tests cover required reads/exports.

### AUTH-02 — auth material in diagnostics

**State:** Current safe exports test common sensitive fields; the device-membership cutover adds carriers that still require explicit leak coverage.

**Required work:** Audit URLs, headers, fatal frames, ticket-fetch errors, pairing/setup links, operator sessions, and server traces. Cover device bearers, socket tickets, pairing codes, operator recovery keys, and session cookies with exact leak fixtures.

**Closure:** Safe/local diagnostic policies intentionally cover each carrier; no credential is persisted in room traces or safe exports.

### STORAGE-01 — decide journal previous-hash chaining

**State:** Checkpoint/journal payloads have individual hashes and strict sequence validation, but no cryptographic previous-segment chain. The old limits document listed this as future work without a concrete incident.

**Decision:** Either name a failure the chain detects that current sequence/hash validation does not, then implement and test it, or close the idea and remove it from planning. Do not carry an unowned “maybe harden” item indefinitely.

### CLEAN-03 — choose snapshot response cutoff

**State:** Snapshot responses still carry deprecated `semanticUnchanged`, `stateVectorHash`, and `computeStateVectorHash` metadata. These read-only fields do not relax exact socket schema admission; state vectors are known to miss deletion-only changes.

**Decision:** Establish the oldest supported plugin/server pair. Remove fields and tests when that support boundary permits, or retain them with one explicit response-compatibility table. The next recovery block may supersede this surface.

**Closure:** No deprecated snapshot field remains without an owned compatibility requirement, and writer schema equality stays mandatory.

### CLEAN-04 — delete historical issue narratives from source comments

**State:** Several production files carry long Issue #40/#22 histories and links to documents being removed.

**Required work:** Keep the invariant, failure consequence, and non-obvious reason adjacent to code. Move no history elsewhere; Git already preserves it. Update the few load-bearing references to this backlog/contract.

## Next architecture block

### STORAGE-02 — authoritative per-vault storage accounting

**State:** Room diagnostics expose useful raw persistence facts and snapshots can estimate listed R2 bytes, but the operator has no authoritative per-vault accounting or enforceable limit.

**Required work:** Define ownership and accounting across Durable Object SQLite, snapshot/blob R2 objects, retries, deletion, and unavailable backends. Surface exact versus estimated values honestly and define policy before enforcing a limit.

**Closure:** Operator-visible totals have a documented denominator, update across create/delete/restore/destroy, and fail safe when one storage plane cannot be counted.

### RECOVERY-01 — operator recovery workflow

**State:** The operator recovery key signs into the console and current snapshots support selective restore. There is no broader shipped workflow for lost operator access, vault-level disaster recovery, or key rotation.

**Required work:** Define threat model, recovery authority, rotation and revocation, backup ownership, and destructive-action confirmation without turning a device credential into operator authority.

**Closure:** Recovery scenarios restore intended access/data, reject unauthorized devices, preserve audit-safe evidence, and have explicit irrecoverable cases.

### SHARD-01 — vault sharding design and cutover

**State:** Each vault remains one Yjs document and one room. Storage accounting and recovery semantics are prerequisites to splitting that authority.

**Required work:** Define shard identity, cross-file transaction behavior, bootstrap, routing, receipts, persistence, snapshot/restore, tombstones, and a safe transition for existing vaults.

**Closure:** Mixed-version admission fails closed, existing vaults transition without data loss, and multi-shard convergence plus recovery have end-to-end evidence.

## External issue closure

| Item | External dependency |
|---|---|
| ISSUE-19 | Reporter-shaped reproduction and preferably reporter validation |
| ISSUE-23 | Excalidraw/Canvas environment and reporter validation |
| ISSUE-68 | Real idle/sleep deployment behavior and reporter validation |
| QA-01/02/03 | Real iPad/Android hardware |
| QA-06 | Original reporter response |

External dependency does not excuse reachable work: build the reproduction, fix, regression, and release candidate first; record exactly what remains external.

## Deliberately excluded

Not backlog unless a new observed problem makes them necessary:

- generic soak/stress expansion;
- Phase 4 or awareness witness relay;
- automated mobile CDP;
- configurable cursor colors;
- native Windows support;
- feature-branch deliverables named at the top of this file;
- dependency-origin re-verification before the corresponding dependency is upgraded.
