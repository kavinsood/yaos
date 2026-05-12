# YAOS sync invariants

Status: **Draft v0** (2026-05-09). Promoted to `Accepted v1` only after
the Phase 0.5 verification pass against code is complete.

This document turns the sync contract (`sync-contract.md`) into a list of
machine-checkable rules with stable IDs. Every rule has:

- a category (correctness / safety / visibility / operational / security);
- a current owner (where the code lives today);
- a target owner (where it should live; same as current if no migration
  planned);
- a current status (`implemented`, `partial`, `missing`, `suspected_broken`,
  `target_only`);
- a verification state (`verified` if read against code in this draft;
  `pending` otherwise — closed by the Phase 0.5 pass);
- at least one regression-test sketch.

Categories are not all "invariants" in the strict correctness sense.
Visibility and operational rules are still requirements; calling them
invariants is a vocabulary compromise. Each entry is labeled.

ID stability: numbering is by category, not chronology. Retired entries
keep their ID and are marked retired with a reason.

---

## Correctness invariants

### `INV-EDIT-01` — One authority per Y.Text per recovery cycle

Category: correctness. Current owner: `sync/editorBinding.ts`,
recovery paths in `src/main.ts` and `runtime/reconciliationController.ts`.
Target owner: extracted `sync/editorRecovery.ts`. Current status:
`partial` (frontmatter RFC documents the rule; full enforcement under
test is pending). Verified: pending.

A single recovery cycle may apply at most one observed-content authority
to a given `Y.Text`. Disk-and-then-editor application in the same cycle
is forbidden.

- Test sketch: editor-bound file with disk 576B, CRDT 560B, editor 608B;
  run recovery; assert exactly one authority applied; second pass is
  no-op.

### `INV-EDIT-02` — Healing after disk recovery does not write

Category: correctness. Current owner: `sync/editorBinding.ts` (`heal()`).
Target owner: same. Current status: `partial` per
`engineering/frontmatter-integrity-rfc.md` ("bound-file recovery now uses
non-writing binding repair after disk-authority recovery"). Verified:
documented in RFC; code path not re-read in this draft.

After a disk-authority recovery, the matching `heal()` in the same cycle
must use non-writing binding repair. Editor content may not be applied
to the same `Y.Text` in the same cycle.

- Test sketch: instrument `heal()`; after disk-authority recovery, assert
  zero CRDT writes from the heal call.

### `INV-SAFETY-02` — Local repairs do not round-trip as remote writebacks

Category: correctness. Current owner: `sync/diskMirror.ts`,
`sync/editorBinding.ts`. Target owner: same. Current status:
`suspected_broken` (issue #22 symptoms suggest residual round-trip;
needs harness coverage). Verified: pending.

A write originated by YAOS local repair must not be observable as a
remote writeback in the same cycle. Repairs are tagged at origin; the
observability and conflict-detection paths must distinguish self-
originated writes from peer-originated writes.

- Test sketch: emit a repair write; assert no `diskImport.external_modify_detected`
  fires for the same path/hash within the suppression window.

### `INV-DISK-02` — Tombstone beats stale resurrection

Category: correctness. Current owner: `sync/vaultSync.ts` tombstone path.
Target owner: same. Current status: `implemented` (per
`engineering/warts-and-limits.md` retention rationale). Verified: pending.

A disk-side create at a path with an active tombstone is admitted only
if the create event is newer than the tombstone's last-applied
generation.

- Test sketch: tombstone at gen N; replay stale create from gen N-1;
  assert rejection with `diskImport.path_tombstoned`.

### `INV-CONFLICT-01` — Ambiguous divergence preserves both states

Category: correctness. Current owner: not centralized. Target owner:
`sync/conflictPolicy.ts` (new). Current status: `target_only`. Verified:
n/a.

When local and remote states diverge in a way Y.js merge cannot resolve
(or where merge would silently discard structure — e.g. malformed
frontmatter on both sides), both states must be preserved. Today this is
realized as quarantine; a conflict-copy mechanism is the alternative if
preservation requires it.

- Test sketch: TBD — depends on chosen preservation mechanism.

### `INV-PATH-01` — Path normalization is stable and collisions are detected

Category: correctness. Current owner: `sync/vaultSync.ts:425-430`
(`normPath` → Obsidian `normalizePath`). Target owner: dedicated
`utils/path.ts`. Current status: `missing` per Phase 0.5 verification —
`normalizePath` does not NFC-normalize and does not detect case
collisions. Verified: 2026-05-09.

YAOS normalizes Unicode to NFC and path separators consistently. YAOS
detects case-colliding paths across devices and surfaces a reason code
when collisions occur. YAOS does not blindly fold case into the CRDT
key — that would corrupt valid case-sensitive vaults.

Cross-platform identity is **not** promised: Linux can host `Foo.md`
and `foo.md` simultaneously while macOS/Windows cannot. The invariant
is detection plus reason-code surfacing, not unification.

- Test sketch: NFC vs NFD pairs hash to the same key; case-colliding
  pairs surface `safety.path_case_collision` (reserved); Linux-only
  case-distinct pairs are preserved.

### `INV-CONTRACT-01` — Devices do not need simultaneous presence

Category: correctness. Current owner: structural. Target owner: same.
Current status: `target` (the system is designed for it; the open
report #24 indicates a violation in practice). Verified: pending —
needs end-to-end test.

Sync is server-mediated. No code path may require two clients online
simultaneously to exchange state.

- Test sketch: device A edits, closes; device B opens later; assert B
  receives A's edits without A reconnecting.

### `INV-CONTRACT-02` — One sync engine per vault

Category: correctness. Current owner: not implemented. Target owner:
detection in `sync/vaultPathPolicy.ts` (new). Current status:
`target_only`. Verified: n/a.

YAOS does not support running concurrently with another sync engine on
the same vault. The plugin **warns** on detected cloud-storage paths;
it does not refuse to run. Documentation says so without hedging.

- Test sketch: simulate vault path under iCloud; assert warning emitted
  with reason `connection.vault_path_unsafe_external_sync`; assert sync
  still runs.

---

## Safety requirements

### `INV-SAFETY-01` — Pauses surface a reason and a resume path

Category: safety. Current owner: `sync/frontmatterGuard.ts`,
`sync/frontmatterQuarantine.ts`. Target owner: same. Current status:
`partial` (reason emission exists per RFC; explicit resume action UI is
Phase 2). Verified: pending.

Any path paused emits a reason code, surfaces a throttled notice, and
exposes an explicit resume action. Sync for unaffected paths continues;
the paused path itself is not propagated until resolved. (The current
architecture stores body and frontmatter in the same per-file `Y.Text`,
so a per-file pause halts both. A future split into separate body and
frontmatter subjects could relax this to body-continues-on-frontmatter-
pause; until that split lands, this invariant must not promise it.)

### `INV-SAFETY-03` — Quarantine state is restart-safe

Category: safety. Current owner: `sync/frontmatterQuarantine.ts`.
Target owner: same. Current status: `implemented` per RFC. Verified:
pending.

Quarantined paths and reasons survive plugin reload. Resume actions are
available after restart.

### `INV-FOLDER-01` — Empty folder support is explicit

Category: safety (data preservation). Current owner: not centralized.
Target owner: `sync/folderPolicy.ts` (new). Current status: `missing`
per Phase 0.5 verification — no folder cleanup code exists, no
materialization metadata is captured. Verified: 2026-05-09.

YAOS must take an explicit position on empty folders. The v0 default
is **(c) documented non-support**: empty folders are not synced; this
is named in the contract and in user-facing docs. Users who delete a
folder on device A may see an empty orphan folder on device B until
they remove it manually. This is acceptable while explicit.

Bounded artifact cleanup (variant **b**) — removing only empty folders
that YAOS can prove were created as materialization artifacts for
replicated file paths or as part of a remote folder-delete operation —
requires materialization metadata that does not exist today
(`folderCreatedByYaosMaterialization`, `createdForPath`,
`createdAtGeneration`). Implementing cleanup without that metadata
risks deleting user-created empty folders. **Forbidden.**

First-class folder entries (variant **a**) — folders gain CRDT identity
and tombstones — is a Phase 2+ candidate.

Indiscriminate empty-folder deletion is forbidden under any variant.

- Test sketch: user-created empty folder must survive a reconciliation
  cycle; v0 acceptance is "orphan folder remains" with documentation
  acknowledging it.

### `INV-DELETE-03` — Remote delete uses configured trash/delete semantics

Category: safety. Current owner: `sync/vaultSync.ts` delete path.
Target owner: same. Current status: `pending verification`. Verified:
pending.

A locally-applied remote delete uses the configured deletion policy
(move to system trash, move to Obsidian trash folder, or hard delete).
The default is system trash to preserve recovery.

---

## Visibility requirements

These are not correctness invariants. They are user-facing requirements
that the engine must satisfy so users can trust and debug the system.

### `INV-AUTH-01` — Connection facts are independently exposed

Category: visibility. Current owner: `runtime/connectionController.ts`.
Target owner: same. Current status: `partial`. Verified: pending.

`connection` reports three independent facts: server reachable, auth
accepted, WebSocket open. The headline state collapses these per the
overall-state rules in `sync-vocabulary.md`, but the facts are always
exposed in status detail and debug summaries.

### `INV-OFFLINE-01` — Pending state is exposed

Category: visibility. Current owner: not present. Target owner:
`runtime/syncStatus.ts` (new). Current status: `missing`. Verified:
n/a.

A client must surface, at minimum: last-local-edit-observed,
last-local-edit-pushed (with ack level), last-remote-update-pulled,
pending-local-files, pending-blob-uploads. Visible in the status
surface and the debug summary.

### `INV-OFFLINE-02` — Catch-up reports availability

Category: visibility. Current owner: `runtime/connectionController.ts`,
`sync/vaultSync.ts`. Target owner: same. Current status: `missing`.
Verified: pending.

A device reconnecting after offline must report whether new server
state was available and applied. Silent no-op on reconnect is forbidden.

### `INV-EDIT-03` — Editor binding state is reported

Category: visibility. Current owner: `sync/editorBinding.ts`,
`runtime/editorWorkspaceOrchestrator.ts`. Target owner: same. Current
status: `partial`. Verified: pending.

`editor` reports one of: `bound`, `rebinding`, `unbound`, `failed`,
`suppressed`. "Could not resolve active editor" is the `unbound` or
`failed` state with a reason code, not a silent log.

### `INV-DISK-01` — Every skip emits a reason code

Category: visibility. Current owner: `sync/diskMirror.ts`,
`sync/diskIndex.ts`. Target owner: same. Current status: `partial`
(some skips already emit; full coverage Phase 2). Verified: pending.

Every skipped disk-import action emits a structured event with a reason
code from the registry.

### `INV-DELETE-02` — Remote delete is observable

Category: visibility. Current owner: `sync/vaultSync.ts`. Target owner:
same. Current status: `partial`. Verified: pending.

A locally-applied remote delete emits a structured event including
path, file id, source device, action taken, and result.

### `INV-BLOB-01` — R2 absence is named at every skip site

Category: visibility. Current owner: `sync/blobSync.ts`,
`runtime/attachmentOrchestrator.ts`. Target owner: same. Current
status: `partial`. Verified: pending.

When `attachments` is `disabled` due to missing R2, every operation
that would touch a blob path emits an event with reason
`attachments.r2_not_configured`.

### `INV-BLOB-02` — Bucket binding mismatch is named

Category: visibility. Current owner: `sync/blobSync.ts`. Target owner:
same. Current status: `pending verification`. Verified: pending.

If R2 capability is reported but the expected bucket binding
(`YAOS_BUCKET`) is missing, `attachments` enters `blocked` with reason
`attachments.r2_bucket_binding_missing`, distinct from `disabled`.

### `INV-EXT-01` — External-edit policy is single, explicit, observable

Category: visibility. Current owner: `sync/externalEditPolicy.ts`.
Target owner: same. Current status: `partial`. Verified: pending.

Edits originated outside the live editor are imported per a single
policy: `alwaysImport`, `ask`, `never`. Visible in status. Each import
event records which policy applied.

### `INV-ACK-01` — Pushed/fetched timestamps define their ack level

Category: visibility. Current owner: not present. Target owner:
`runtime/syncStatus.ts` (new). Current status: `missing`. Verified:
2026-05-09 (no ack tracking exists in code).

Any "pushed" or "fetched" timestamp surfaced in UI must declare which
ack level it represents. A "Pushed at" label that only means
`provider.send()` was called is forbidden.

Ack levels for v0:

- `sent` — provider has put the update on the WebSocket. Reportable
  today.
- `serverAcked` — server has accepted the update into in-memory room
  state. Requires a small server-side counter or per-update receipt;
  Phase 1 work.
- `durable` — server has persisted the update to checkpoint or journal
  storage. **Not exposed in v0.** y-partyserver hibernation makes
  storage-commit notification non-trivial; promising it without the
  mechanism would be the kind of fake precision the contract forbids.
  Reserved for a future invariant revision once a commit-notification
  channel exists.

---

## Operational requirements

### `INV-OBS-01` — Observability cannot affect availability

Category: operational. Current owner: `runtime/traceRuntimeController.ts`,
server-side trace persistence. Target owner: same. Current status:
`implemented` per `engineering/warts-and-limits.md` (fail-open).
Verified: documented; code path not re-read in this draft.

Trace persistence may fail, drop, or sample. It must never affect
`text` availability, `connection` lifecycle, or room availability.

### `INV-OBS-02` — Trace writes are bounded with explicit budgets

Category: operational. Current owner: `runtime/traceRuntimeController.ts`,
server-side trace persistence. Target owner: same. Current status:
`partial` (per-entry bounding present; aggregate budgets being tightened
under issue #40). Verified: pending.

Concrete budgets:

- `max_trace_bytes_per_entry`: 16 KiB (current code:
  `MAX_TRACE_ENTRY_BYTES` in `server/src/traceStore.ts`). Verified
  2026-05-09.
- `max_trace_entries_per_room`: 200 rolling window (current code:
  `MAX_DEBUG_TRACE_EVENTS` in `server/src/server.ts`). Verified
  2026-05-09.
- `max_trace_writes_per_minute_per_room`: not currently enforced.
  Phase 1 deliverable for issue #40. Draft target: 600.
- `pre_auth_durable_writes`: must be 0. **Currently violated** —
  `server/src/index.ts:35-67` (`rejectUnauthorizedVaultRequest`)
  persists trace entries before auth completes for unclaimed,
  server_misconfigured, and unauthorized rejection paths. Phase 1
  fix: drop these writes entirely or aggregate at the worker
  in-memory level.

- Test sketch: replay 10k typing events; assert DO request count stays
  within budget; assert no pre-auth writes.

### `INV-CAP-01` — Capability changes propagate without reload

Category: operational. Current owner: `runtime/capabilityUpdateService.ts`.
Target owner: same. Current status: `partial`. Verified: pending.

Server capability changes reflect in subsystem states without plugin
reload, or surface as `capabilities.runtime_refresh_required` in a
`blocked` state. Silent divergence is forbidden.

### `INV-CAP-02` — Version skew is named

Category: operational. Current owner: capability handshake in
`runtime/capabilityUpdateService.ts`. Target owner: same. Current
status: `partial`. Verified: pending.

Incompatible plugin/server versions place `connection` in `blocked`
with reason `connection.server_update_required` or
`connection.plugin_update_required`.

### `INV-SCHEMA-01` — Schema/cache skew blocks loudly

Category: operational. Current owner: not centralized. Target owner:
`runtime/schemaGate.ts` (new). Current status: `target_only`.
Verified: n/a.

A client may join a room only if its supported schema range overlaps
both the room schema and its local cache schema. Otherwise it blocks
and offers reset/rebuild/migrate actions. Silent reuse of incompatible
cached state is forbidden.

### `INV-AUTH-02` — Fresh install on claimed server routes to add-device

Category: operational. Current owner: `runtime/setupLinkController.ts`,
settings UI. Target owner: same. Current status: `pending verification`.
Verified: pending.

A fresh install (no local sync state) connecting to an already-claimed
server routes to "add device to sync network," not the deploy/claim
screen.

### `INV-DISK-03` — Bulk imports follow the same gates as live edits

Category: operational. Current owner: `sync/diskMirror.ts`. Target
owner: same. Current status: `pending verification`. Verified: pending.

Imports detected during startup or forced reconciliation are subject to
the same `safety` and `exclude` rules as live edits. Bulk paths may
not bypass guards.

### `INV-SPECIAL-01` — Special files route through explicit policy

Category: operational. Current owner: `sync/blobSync.ts` extension
routing. Target owner: `sync/specialFilePolicy.ts` (new). Current
status: `partial`. Verified: pending.

Files with structured non-markdown formats (`.canvas`, `.excalidraw`,
`.base`, etc.) route through an explicit policy that names which
subsystem handles them. The policy is visible in docs and in the
diagnostic surface.

---

## Security requirements

### `INV-SEC-01` — No pre-auth state mutation

Category: security. Current owner: server route handlers. Target
owner: same. Current status: `implemented` per zero-config-auth and
do-hardening notes. Verified: pending.

No client request mutates server state before authentication completes.
This includes Durable Object writes, room storage, R2, and trace
persistence.

### `INV-SEC-02` — Diagnostics never include secrets or content by default

Category: security. Current owner: `diagnostics/diagnosticsService.ts`.
Target owner: same. Current status: `partial`. Verified: pending.

Default debug summary contains: plugin/server versions, platform,
subsystem states, event names, reason codes, counts, timings. It does
not contain credentials or vault file content. Filenames are excluded
by default; an explicit second action includes them with a warning.

### `INV-SEC-03` — Setup links have explicit lifetime and scope

Category: security. Current owner: `runtime/setupLinkController.ts`.
Target owner: same. Current status: `pending verification`. Verified:
pending.

Setup/device-link tokens have bounded TTL, single-device claim scope,
and revocability. Tokens never appear in diagnostics or logs.

### `INV-SEC-04` — Claim flow is single-owner unless intentionally reset

Category: security. Current owner: server claim route. Target owner:
same. Current status: `implemented` per zero-config-auth notes.
Verified: pending.

A server is claimed once. Re-claim requires explicit reset. The locked
state is reported explicitly without enumerating credentials or device
identifiers.

---

## Documentation requirement

### `INV-DOC-01` — Public claims map to invariants

Category: documentation. Owner: README, landing page, marketing copy,
release notes. Current status: `target_only`.

Every public claim YAOS makes maps to one or more invariants in this
document. Claims that do not map are removed or promoted to invariants.
Audit cadence: per release.

---

## Reason code registry

Reason codes are namespaced: `<subsystem>.<code>`. Each entry has a
definition; `userMessage` is filled when a code has live emitters.
Codes without emitters today are marked `(reserved)`.

Schema:

```ts
type ReasonDefinition = {
  code: string;                     // e.g. "attachments.r2_not_configured"
  subsystem: SubsystemName;
  severity: "info" | "notice" | "warning" | "error" | "data_protection";
  invariant?: string;               // e.g. "INV-BLOB-01"
  recoverability: "automatic" | "user_action" | "developer_bug" | "external_service";
  userMessage?: string;             // plain-language UI copy; may be omitted while reserved
  maintainerMessage: string;        // engineering-facing explanation
  includeInDebugSummary: boolean;
};
```

### Connection
- `connection.server_unreachable`
- `connection.auth_rejected`
- `connection.websocket_unavailable`
- `connection.websocket_closed_unexpectedly`
- `connection.server_update_required`
- `connection.plugin_update_required`
- `connection.vault_path_unsafe_external_sync` (warning)

### Editor
- `editor.active_editor_unresolved`
- `editor.binding_failed`
- `editor.binding_suppressed_by_safety`
- `editor.non_markdown_active_leaf`

### Disk import
- `diskImport.excluded_by_user_pattern`
- `diskImport.too_large`
- `diskImport.unsupported_extension`
- `diskImport.path_tombstoned`
- `diskImport.external_edits_disabled`
- `diskImport.remote_newer_than_local`
- `diskImport.duplicate_file_id`
- `diskImport.external_modify_detected` (info; emitted to test `INV-SAFETY-02`)

### Delete
- `delete.local_detected`
- `delete.remote_applied`
- `delete.tombstone_revived`
- `delete.rename_inferred`
- `delete.move_inferred`

### Safety
- `safety.frontmatter_duplicate_key`
- `safety.frontmatter_invalid_yaml`
- `safety.frontmatter_broken_fence`
- `safety.growth_burst_blocked`
- `safety.repair_amplifier_prevented`

### Attachments
- `attachments.r2_not_configured`
- `attachments.r2_bucket_binding_missing`
- `attachments.blob_too_large`
- `attachments.blob_upload_failed`
- `attachments.blob_download_failed`

### Observability
- `observability.trace_dropped_bounded`
- `observability.trace_storage_unavailable`

### Capabilities
- `capabilities.runtime_refresh_required`
- `capabilities.schema_skew_blocked` (reserved for `INV-SCHEMA-01`)

---

## Issue and incident map

GitHub issues are one source of evidence. They are not the only one. The
incident ledger below also tracks user reports from Discord, Reddit, DMs,
and Cloudflare logs. Each entry maps to one or more invariants; entries
that cannot be mapped are flagged `diagnose first` rather than forced
into a category.

### GitHub issues (open)

| Issue | Title (abbrev.) | Mapped invariants | Notes |
| --- | --- | --- | --- |
| #41 | Failed Cloudflare deployment | `diagnose first` | Heterogeneous: npm, wrangler, dependency pinning, transient build infra. Some instances may map to `INV-AUTH-02`/`INV-CAP-02`; classify per case from logs. |
| #40 | Exceeded DO 100k req/day | `INV-OBS-01`, `INV-OBS-02` | Bounded trace persistence with concrete budgets. P0. |
| #38 | Directory deletions/moves not synced | `INV-FOLDER-01`, `INV-DELETE-01` (visibility) | Phase 1 ships bounded artifact cleanup; Phase 2 first-class folders. |
| #25 | Editor-bound infinite loop | `INV-EDIT-01`, `INV-EDIT-02`, `INV-SAFETY-02` | Canonical recovery amplifier. P0. |
| #24 | Device not syncing when other offline | `INV-CONTRACT-01`, `INV-OFFLINE-01`, `INV-OFFLINE-02`, `INV-ACK-01` | Contract claim plus ack-level visibility. P0. |
| #23 | Canvas & Excalidraw sync issues | `INV-BLOB-01`, `INV-SPECIAL-01` | Reason surfacing closes most reports; first-class support is Phase 4. |
| #22 | Sync loop glitching | `INV-EDIT-01`, `INV-EDIT-02`, `INV-SAFETY-02` | Same class as #25. P0. |
| #19 | `.base` & bulk clipping | `INV-DISK-03`, `INV-EXT-01`, `INV-SPECIAL-01` | Bulk import uniformity + special-file policy. |

### Incident ledger (skeleton)

External-source incidents follow this schema. Initial entries to be
populated from the most recent 12 weeks of Discord, Reddit, and DM
reports. The ledger lives at the bottom of this document and grows
append-only.

```text
Incident:    <stable id, e.g. INC-2026-04-09-FRONTMATTER-LOOP>
Source:      <github | discord | reddit | dm | cloudflare-log | internal>
Symptom:     <user-visible description>
Subsystem:   <canonical name>
Invariants:  <INV-* ids, or "diagnose first">
Evidence:    <log/screenshot pointer; redacted>
Repro:       <minimal steps, or "open">
Test:        <regression-test ID, or "open">
Docs:        <doc/status change required, or "none">
State:       <open | diagnosing | mapped | fixed | won't-fix>
```

Initial entries (placeholders to be filled in Phase 0.5):

- `INC-2026-04-09-FRONTMATTER-AMPLIFIER` — frontmatter loop on
  `Bathroom floor clean.md`. Maps to `INV-EDIT-01`, `INV-SAFETY-02`.
- `INC-DM-LOCKED-SERVER-SECOND-PC` — second-PC user confused by locked
  server screen. Maps to `INV-AUTH-02`.
- `INC-REDDIT-TASKNOTES-CHARACTER-DELETION` — duplicated icons / merged
  lines after disabling TaskNotes. Maps to `INV-SAFETY-01`,
  `INV-CONFLICT-01`.

Filling the ledger from real sources is the second deliverable of
Phase 0.5.

---

## Release gates

Phase numbers are promises, not enforcement. Release gates are crisp and
testable. The next stability release ships when all of the following
hold; nothing in the "must not ship" list lands.

### Must ship

- `INV-EDIT-01` orchestration-level integration test (not just
  `applyDiffToYText` building block).
- `INV-EDIT-02` assertion test that `heal()` is not called from
  recovery cycles.
- `INV-SAFETY-02` origin-suppression confirmation: read
  `diskMirror.flush*` paths and confirm `disk-sync-recover-bound`
  origin writes are suppressed (or document why they are safe to
  propagate).
- `INV-AUTH-01` decomposed connection facts surfaced in status
  (serverReachable, authAccepted, websocketOpen as independent
  booleans, plus a headline state).
- `INV-OFFLINE-01` pending counts surfaced.
- `INV-ACK-01` ack levels labeled in any "pushed/fetched" UI. v0
  exposes `sent` and `serverAcked` only; `durable` is forbidden until
  a server-side commit-notification mechanism exists.
- `INV-OFFLINE-02` catch-up availability reported on reconnect with
  applied-update counts.
- `INV-OBS-02` per-minute write rate limit added; pre-auth writes
  removed (root cause of #40).
- `INV-SEC-01` pre-auth state mutation eliminated from
  `rejectUnauthorizedVaultRequest`.
- `INV-SEC-02` diagnostics export split into safe-summary (no
  filenames) and explicit second action with warning. Default is the
  safe summary.
- `INV-CONTRACT-01` two-client harness test asserting offline-handoff
  works without simultaneous presence (closes #24 verification).
- `INV-FOLDER-01` documented non-support of empty folders (variant
  **c**); README and contract updated. Bounded cleanup deferred.

### Must not ship

- `.obsidian/` settings sync.
- Docker runtime.
- Headless CLI merge.
- First-class canvas / excalidraw / `.base` support.
- New status dashboard UI beyond the minimal status panel needed for
  the items above.
- `durable` ack-level exposure (no mechanism exists).
- Bounded folder cleanup (variant **b**) without materialization
  metadata.
- Any feature whose claim does not map to an invariant
  (`INV-DOC-01`).

---

## Process rules

- PR descriptions reference the `INV-*` ID(s) preserved or established
  and the regression test that guards them. PRs that cannot reference
  an invariant are either rejected or trigger a new invariant entry.
- New reason codes require an entry in the registry above before they
  appear in code.
- Issues that cannot be mapped to an invariant are flagged
  `diagnose first` and not closed by speculative fixes.
- This document and the contract are revised in the same change when an
  invariant is added, removed, or weakened.
