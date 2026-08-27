# Sync and conflict contract

This is the current contract for `main`. [BACKLOG.md](BACKLOG.md) names known violations and missing proof.

## Subjects

| Subject | Current mechanism |
|---|---|
| Markdown | One `Y.Text` per file inside the vault `Y.Doc` |
| File identity | Stable file IDs with CRDT path metadata and tombstones |
| Folders | Derived from file paths; empty folders are not synchronized |
| Attachments and special formats | Whole-file content-addressed R2 objects |
| Snapshots | Full compressed Yjs state plus referenced-blob index |
| `.obsidian` | Not synchronized on `main` |

`.canvas`, `.excalidraw`, `.base`, and other non-Markdown formats use the attachment plane rather than Markdown character merging.

## Vault, membership, and transport scope

One server can host multiple vaults, but each vault remains an independent room and Yjs document. Every local Obsidian folder has its own enrollment and folder-scoped IndexedDB cache, even when another local folder joins the same server vault.

A one-use pairing code selects a vault. `POST /enroll` consumes it and returns a new `deviceToken`, `deviceId`, and the selected `vaultId`; copying another folder's credentials is outside the contract. A device is a full peer only in vaults where it has an active membership. The roster records device ID, display name, enrollment time, and best-effort last-seen time.

All vault HTTP requests use the device bearer and the vault ID in the route. WebSocket sync never accepts a long-lived device credential in its URL: the client first exchanges its bearer for a short-lived, device-scoped ticket. The handshake then supplies exactly the required admission values, `ticket` and `schemaVersion`. Ticket validation is followed by a live membership check, so revocation or leave fails closed before room admission.

Pairing, roster, leave, and destroy have distinct effects:

- pairing creates a new device membership without sharing an existing bearer;
- leave revokes this device, clears this folder's enrollment/cache, and keeps disk files;
- operator kick revokes one selected device;
- operator destroy revokes the vault boundary before requesting cleanup of its room and R2 data.

## Authorities

Authority is chosen for each observed transition, not assigned permanently to a file.

- A live editor is authoritative for active user input.
- CRDT state is authoritative for remote state already accepted into the Yjs document.
- Disk changes are candidate local input and pass through reconciliation and safety policy.
- IndexedDB persists local CRDT state in a database scoped by `vaultId` and local folder key; it is not a separate conflict winner.
- A snapshot becomes authoritative only through an explicit restore.

No reconciliation cycle may apply two incompatible observed-content authorities to the same `Y.Text`.

The governing rule is preservation before convergence. Disk, editor, and CRDT can disagree because of legitimate ordering, not corruption. Choosing a winner before the other state is durable turns that ordering into data loss; read/stat failure is therefore uncertainty and preservation, never proof that deletion or overwrite is safe.

## Ordinary edits

A local Markdown edit enters the local Yjs document and IndexedDB, then synchronizes through the provider. A remote update enters Yjs first and is materialized through `DiskMirror`; it is not written directly from the socket to disk or editor.

YAOS-authored disk writes carry an expected content fingerprint. A matching watcher event is suppressed. A mismatching event is treated as new external input.

External changes made while Obsidian was closed are compared with the disk index on startup. Missing or ambiguous baselines use conservative conflict policy rather than silently claiming certainty.

## Closed-file divergence

With baseline hash `B`, disk hash `D`, and CRDT hash `C`:

- `D == C`: no conflict.
- `D != B` and `C == B`: disk changed; import disk.
- `D == B` and `C != B`: CRDT changed; write CRDT to disk.
- `D != B`, `C != B`, and `D != C`: preserve both and choose the policy-defined winner for the original path.

When no per-file baseline exists, disk modification time may show that disk changed after the last persisted disk index. If that evidence is complete, disk wins the original path and CRDT is preserved. Otherwise CRDT remains the conservative distributed default and disk content is preserved separately.

The mtime policy is heuristic: the persisted timestamp is global, filesystems may have coarse timestamps, and external tools may preserve mtime. [BACKLOG.md](BACKLOG.md) requires real-device proof and tracks the still-open bound-file variant.

## Open/editor-bound divergence

When disk, CRDT, and editor all disagree and no single authority can be selected:

1. Preserve the CRDT version as a Markdown sibling conflict note.
2. Keep the editor/disk version at the original path.
3. Converge CRDT to that original-path version only after preservation succeeds.

If artifact creation fails, convergence must not discard either version. Repeated identical conflict fingerprints are deduplicated within the session.

A known gap remains when both disk and CRDT changed from baseline but the editor matches one side: the current bound-file branches can choose a winner without running the complete three-way classifier. This is BACKLOG `SYNC-02`.

## Attachment conflict

If an attachment target changes locally while a remote download is in flight:

1. Preserve the local file at the original path.
2. Write remote bytes to a local-only conflict artifact.
3. Suppress that artifact from immediate upload.
4. Notify the user.

Attachment conflict artifacts are local-only. Markdown conflict artifacts synchronize normally.

## Remote delete

Remote delete uses evidence, not a Boolean dirty flag.

| Baseline | Local state | Decision |
|---|---|---|
| Known | Matches baseline | Apply configured trash/delete policy |
| Known | Differs | Preserve local file and intentionally revive it |
| Missing or unreadable | File exists | Preserve unresolved; do not revive |

Read/stat failure is uncertainty, not proof that a local file is clean.

`preservedUnresolvedPaths` prevents later scan/import/queue passes from reviving a path that was preserved without a trustworthy baseline. Explicit local create, modify, or delete establishes new user intent and clears the session guard.

A separate known violation exists for a file deleted locally while YAOS is disabled: startup reconciliation can classify the absent known file as materialization missing from disk and recreate it from CRDT. This is BACKLOG `SYNC-01`.

## Tombstones and revival

Markdown and blob tombstones prevent stale devices from silently recreating deleted paths. A locally modified file may intentionally beat a remote delete when a baseline proves the modification. Unknown-baseline content is preserved without clearing the tombstone.

Deleted Markdown bodies may be reaped after the grace period, but tombstone identity remains. Revival creates active state explicitly; transient absence or failed reads must not do so.

## Safety brake

When one reconcile would overwrite more than 20 local files and more than 25% of the vault:

- remote-to-disk overwrites are blocked for that pass;
- additive CRDT files may still be materialized;
- blocked paths do not advance disk-index baselines;
- diagnostics record the count, timestamp, and bounded sample;
- the user receives a notice.

A later safe reconcile or explicit user action may resolve the block.

## Recovery-loop controls

Repeated identical recovery attempts are quarantined after three matching fingerprints within ten minutes. Fingerprints are bounded and session-local. A separate monotonic-growth detector catches the typing-cadence amplification shape. These are safety nets, not proof that every possible recovery loop is impossible.

## Receipt and status language

The receipt tracks latest state, not individual deliveries. WebSocket-open and provider-synced signals cannot prove storage, while per-update acknowledgement would require a queue identity and a different protocol. The client captures its latest local state vector; confirmation requires a dominating server vector and persistence-generation progress under the same server epoch. One receipt may cover several updates.

Candidate state persists locally, but a previous `true` is never restored as current truth after restart. A new server epoch re-baselines the client and withholds confirmation until new persistence progress. This is why the UI exposes neither a pending-update count nor other-device delivery.

Permitted claims:

- provider connected;
- initial provider sync completed;
- latest tracked local state saved by the server, when the durable receipt contract passes;
- last known receipt time, explicitly historical.

Forbidden claims:

- another device received or materialized the change;
- a precise pending-update count;
- `lastLocalUpdateWhileConnectedAt` means sent;
- a historical receipt confirms current state.

## Failure posture

- Persistence corruption: fail the room closed.
- IndexedDB startup failure: fail local sync closed.
- Missing or invalid ticket/schema declaration: reject before room admission.
- Revoked or mismatched device membership: reject HTTP and WebSocket vault access.
- Missing attachment capability: disable attachments/snapshots; continue Markdown.
- Trace persistence failure: lose bounded diagnostics; continue sync.
- Unknown delete baseline: preserve locally without resurrection.
- Conflict artifact failure: do not converge by discarding the unpreserved side.

Per-vault storage accounting, operator recovery beyond current snapshots, and sharding are next-block work. This contract does not claim schema 4, settings sync, a headless client, or Docker packaging.
