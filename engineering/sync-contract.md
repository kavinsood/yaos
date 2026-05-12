# YAOS sync contract

Status: **Draft v0** (2026-05-09). Promoted to `Accepted v1` only after
Phase 0.5 verification against code is complete and the invariants
document has the same status.

This document describes what YAOS promises to do with vault state, and
what it explicitly does not. It is fact-first: where current code does
not yet honor a promise, that gap is named with `Gap (current)` and a
reference to the invariant that closes it.

Vocabulary: `sync-vocabulary.md`. Invariants and reason codes:
`sync-invariants.md`.

## Subjects of sync

YAOS treats the following as distinct subjects with distinct contracts:

- **Markdown file text** — the entire content of `.md` files including
  the YAML frontmatter fence. Synced as a single per-file `Y.Text` inside
  the vault `Y.Doc`. The body/frontmatter split is a target architecture,
  not the current model. Saying "body sync" is a future contract; today's
  contract is "Markdown file text."
- **Frontmatter (logical view)** — a structural projection of the YAML
  fence used by the `safety` subsystem for validation. Not a separate
  sync subject in the current implementation.
- **Attachments** — non-markdown files (images, PDFs, audio, video) and
  blob-shaped formats including `.canvas`, `.excalidraw`, `.base`. Synced
  via `attachments`.
- **File and folder identity** — paths, renames, deletes. Files have
  CRDT-tracked identity; folders do not have first-class CRDT
  representation today (see Q9).
- **Snapshots** — server-captured historical states, restored on demand.
  Not part of live sync.
- **Plugin settings (`.obsidian/`)** — out of scope.

## Contract questions

### Q1. Who is authoritative — editor, disk, CRDT, IndexedDB, remote, snapshot?

Authority is per-event, not per-file. Default precedence during a normal
edit cycle, highest first:

1. `editor` — when the file is editor-bound and the user is actively
   editing.
2. `crdt` — when `text` is live and no editor binding exists for that
   file.
3. `remote` — incoming server updates merge into `crdt` via Y.js merge
   semantics; never applied directly to `disk` or `editor`.
4. `disk` — disk changes are observed by `diskImport` and applied to
   `crdt` subject to `safety`.
5. `snapshot` — only authoritative inside an explicit user-invoked
   restore.

IndexedDB is a local persistence cache for `crdt`, not an authority. A
failed IndexedDB load fails closed; the plugin does not silently continue
with an empty state.

### Q2. When can disk overwrite CRDT?

When all of the following hold:

- `diskImport` is enabled and the path is not excluded.
- The file is not editor-bound, or the editor's text matches disk.
- `safety` does not block the transition.
- The path is not under an active tombstone newer than the disk
  modification timestamp.

Disk content is then applied to `crdt` as a single authority for that
recovery cycle. No second authority may be applied to the same `Y.Text`
in the same cycle (`INV-EDIT-01`).

### Q3. When can CRDT overwrite disk?

When `text` is live and a remote update advances the per-file `Y.Text`
beyond what disk reflects, the new state is written to disk by
`diskMirror`, subject to:

- `safety` does not block the transition.
- The file is not currently being written by the user (suppression
  window during active editor input).
- The path has not been tombstoned remotely.

CRDT-to-disk writes that originate from local YAOS repair must not be
re-observed as remote writebacks (`INV-SAFETY-02`).

### Q4. When must YAOS create a conflict copy?

Today: never. Y.js merge semantics resolve concurrent body edits without
explicit conflict files. Cases that would warrant conflict copies are
handled by `safety` quarantine (frontmatter, growth) or by tombstone
retention (delete-vs-edit).

This is a deliberate non-goal for v0. Ambiguous local/remote divergence
that cannot be resolved by Y.js merge **must preserve both states** rather
than silently picking a winner (`INV-CONFLICT-01`). If preservation
requires conflict files, they are introduced as an explicit subsystem
feature.

### Q5. When must YAOS quarantine instead of syncing?

`safety` quarantines a path when, on inbound or outbound application:

- Frontmatter contains duplicate keys, broken fences, or unparseable YAML.
- A single transition grows frontmatter beyond a guarded threshold
  without a corresponding structural change (growth burst).
- A repair cycle would require applying two distinct observed-content
  authorities to the same `Y.Text` in one pass (`INV-EDIT-01`).

Quarantine pauses propagation for that path. Body sync for unaffected
paths continues. The pause emits a reason code, surfaces a throttled
notice, and persists bounded diagnostic metadata.

### Q6. What happens if Obsidian is closed before a push completes?

The local `crdt` is persisted to IndexedDB on every applied update. On
next launch the plugin loads from IndexedDB before opening the WebSocket.
Pending local updates that were never sent are retransmitted as part of
the normal Y.js sync handshake.

Gap (current): "pending local updates not yet acknowledged" is not
exposed as a user-visible count. `INV-OFFLINE-01` closes this in Phase 1.

### Q7. What happens if device B is offline for days?

When device B reconnects:

- `connection` re-establishes; `text` enters `catchingUp`.
- Server delivers the accumulated state vector diff.
- `crdt` advances; `diskMirror` writes resulting changes to disk subject
  to `safety`.
- If device B's local `crdt` advanced offline, those updates are sent in
  the same handshake.

The contract: **devices do not need to be online simultaneously**
(`INV-CONTRACT-01`). The server is the persistence point.

Gap (current): catch-up completion is not visibly distinguished from "no
new state available." `INV-OFFLINE-02` closes this in Phase 1.

### Q8. What happens if an external app writes a file while Obsidian is closed?

On next launch, `diskImport` scans changed paths against the disk index.
Files with newer mtime or differing hash are classified per
`externalEditPolicy`:

- `alwaysImport` (default) — apply to `crdt` subject to `safety`.
- `ask` — surface a prompt before applying.
- `never` — log and skip with reason `diskImport.external_edits_disabled`.

Bulk imports during scan are subject to the same `safety` and `exclude`
rules as live edits (`INV-DISK-03`).

Gap (current): the scan does not always detect untracked files added
while closed (issue #19). Phase 2 addresses.

### Q9. What happens if a folder is moved or deleted?

Files inside the folder are individually tombstoned or re-keyed. The
folder itself has no first-class CRDT representation. After file
operations propagate, an empty folder may persist on the destination
device because no operation explicitly removed it (issue #38).

This is a known half-supported state. Resolution is one of three
explicit positions, not "auto-clean empties":

- **(a) First-class folder entries** — folders gain CRDT identity and
  tombstones; arbitrary folder ops sync deterministically.
- **(b) Bounded artifact cleanup** — YAOS removes only empty folders it
  can prove were created as materialization artifacts for replicated file
  paths or as part of a remote folder-delete operation. User-created
  empty folders are preserved.
- **(c) Explicit non-support** — empty folders are documented as not
  synced; users are informed.

v0 ships **(c)**: empty folders are documented as not synced. Bounded
artifact cleanup **(b)** is forbidden until materialization metadata
(which path created the folder, at what generation, by which device)
is captured — without that metadata, "cleanup" cannot distinguish a
YAOS-created artifact from a user-created empty folder, and would
destroy legitimate structure. **(a)** is a Phase 2+ candidate.
Indiscriminate empty-folder deletion is forbidden under any variant.

### Q10. What happens if a blob-like file has no R2 binding?

`attachments` reports `disabled` with reason `attachments.r2_not_configured`.
Every operation that would touch a blob path emits a structured event
with that reason. Markdown text sync continues unaffected.

Files routed through `attachments`:

- All non-markdown extensions outside the configured exclude list.
- Markdown-extension files larger than the configured text ceiling.
- `.canvas`, `.excalidraw`, `.base` and other JSON-shaped formats —
  treated as attachments by current policy.

This routing is explicit per `INV-SPECIAL-01`; first-class support for
specific formats is a Phase 4 candidate. R2 misconfiguration (correct
binding name expected as `YAOS_BUCKET`) yields `attachments.r2_bucket_binding_missing`,
distinct from absent R2 (`INV-BLOB-02`).

### Q11. What does "fully synced" mean, visibly, to a user?

Two ack levels are defined. A user-facing claim of "fully synced" must
specify which level it means.

**Sent** — local update handed to the Y.js provider and put on the
WebSocket.

**Server-acked** — server accepted the update into room state. This is
the level the user actually cares about for trust.

**Durable** — server persisted the update to checkpoint or journal
storage. **Not exposed in v0.** y-partyserver hibernation makes
storage-commit notification non-trivial; promising it without a
mechanism would be the kind of fake precision the contract forbids.
Reserved for a future revision once a commit-notification channel
exists.

Today the plugin can report `sent`. `serverAcked` requires a small
server-side counter or per-update receipt and is Phase 1 work
(`INV-ACK-01`). Until `serverAcked` is wired, "Pushed" timestamps in
UI must be labeled `sent` and only `sent`. A "Pushed at HH:MM" label
that only means `provider.send()` was called and pretends to be
something stronger is forbidden.

A device is fully synced (server-acked level) when:

- `connection` is `live` (reachable, auth accepted, WebSocket open).
- `text` is `live` (not `catchingUp`).
- Pending-local-update count at server-acked level is zero.
- Pending-blob-uploads count is zero (when `attachments` is enabled).
- No `safety` pause is active for paths the user is editing.

These five facts are the user-visible definition. `INV-OFFLINE-01`
requires they be exposed.

## Boundary cases

### Multi-engine vaults

Unsupported. Running another sync engine (iCloud, Dropbox, OneDrive,
Syncthing, Google Drive, Obsidian Sync) on the same vault while YAOS is
active produces undefined behavior. The plugin **warns** when a vault
path matches a known cloud-storage location; it does **not** refuse to
run (`INV-CONTRACT-02`). Documentation says this without hedging.

### Plugin/server version skew

`capabilities` negotiates feature flags on connect. Incompatible versions
put `connection` in `blocked` with reason `connection.server_update_required`
or `connection.plugin_update_required`. Silent degradation is forbidden
(`INV-CAP-02`).

### Schema/cache version skew

A client may join a room only if its supported schema range overlaps both
the room schema and its local cache schema. Otherwise it blocks and
offers reset/rebuild/migrate actions. Silent reuse of incompatible cached
state is forbidden (`INV-SCHEMA-01`).

### Telemetry under stress

`observability` may drop, sample, or fail. It must never affect `text`,
`connection`, or room availability (`INV-OBS-01`). Trace writes are
bounded per entry and per room (`INV-OBS-02`).

### Self-healing

Local repairs originated by YAOS must not be observable as remote
writebacks in the same cycle (`INV-SAFETY-02`). Recovery cycles apply at
most one observed-content authority per `Y.Text` per cycle
(`INV-EDIT-01`). Together these close the editor-bound recovery
amplifier (#22, #25).

### Path normalization

Paths are normalized stably across OS, case-folding, and Unicode
differences before being used as CRDT keys. Two paths that the user would
consider identical must hash to the same key on every supported platform
(`INV-PATH-01`).

### Security boundary

No state mutation occurs before authentication completes (`INV-SEC-01`).
Diagnostics never include credentials or vault content by default
(`INV-SEC-02`). Filename inclusion in diagnostics requires an explicit
second action with a warning.

## What this contract does not promise

- End-to-end encryption.
- Selective per-folder sync.
- Conflict-free merging of arbitrary YAML structures.
- First-class folder operations (Phase 2 candidate).
- First-class canvas, excalidraw, or `.base` semantics (Phase 4
  candidate).
- Synchronization of `.obsidian/` plugin settings.
- Real-time co-editing in the multi-cursor sense.

## Public-claim mapping

Every public claim YAOS makes — README, landing page, marketing copy,
release notes — must map to one or more invariants in this document
(`INV-DOC-01`). Claims that do not map are either removed or promoted
to invariants. This is how documentation stops drifting from code.

## Revision policy

This document changes when an invariant is added, removed, or weakened.
Bug fixes that align code to this contract do not revise it. Feature
work that changes a Q&A answer must update this document and
`sync-invariants.md` in the same change.
