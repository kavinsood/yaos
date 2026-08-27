# Sync and conflict contract

This is the current schema-4 contract for `main`. [BACKLOG.md](BACKLOG.md) contains only evidenced unresolved risks and missing external-scale proof.

## Subjects

| Subject | Current mechanism |
|---|---|
| Vault structure | One root Yjs document plus a durable SQL catalog |
| Markdown | One independently loaded Yjs body per stable file identity |
| File lifecycle | Durable create, rename, delete, and revive records followed by root publication |
| Folders | Derived from paths; empty folders are not synchronized |
| Attachments and special formats | Generation-scoped, content-addressed R2 objects when configured |
| Recovery | Optional asynchronous recovery-v2 snapshots when R2 and `RecoveryJob` are configured |
| `.obsidian` | Not synchronized |

Canvas, Excalidraw, Base, and other non-Markdown formats use the attachment plane rather than Markdown character merging.

## Vault, membership, and transport scope

One server hosts multiple independent vaults. A physical installation may enroll different folders in different vaults, but each device identity and bearer is one vault membership. Each local folder stores that membership and has its own schema-4 IndexedDB database.

A pairing code selects one vault and is consumed once. Pairing creates a new full-peer membership; it never copies another folder's bearer. Leave revokes one membership and keeps disk files. Operator kick revokes one membership. Operator destroy revokes the full vault before generation-scoped physical cleanup.

All vault HTTP requests use a device bearer and vault ID. WebSocket URLs never carry that long-lived bearer. The client exchanges it for a short-lived device ticket; root and body handshakes require the ticket plus exact `schemaVersion=4` and `protocolVersion=1`. Membership and active vault state are checked before every admission.

The root socket carries structural state. Each active Markdown body has a separate socket opened only while the client needs it. Attachment bytes and recovery artifacts do not travel through body sockets.

## Durable authority

Authority is split by domain:

- SQL metadata binds `vaultId` to one `vaultGeneration`.
- The durable SQL sequence, catalog, lifecycle records, document heads, candidate receipts, and recovery authority are the server source of truth.
- The root Yjs document is the replicated structural view: path-to-body identity, attachment references, tombstones, and schema metadata.
- A Markdown body Yjs document owns only one file's text.
- IndexedDB stores the local root, bodies, pending candidates, lifecycle intents, bootstrap progress, and disk baselines. It is a retry/cache boundary, not the shared conflict winner.
- Disk and live editors are observed local authorities subject to reconciliation and preservation rules.
- An R2 recovery point becomes restore input only through an explicit restore; it never becomes the live server authority directly.

`vaultGeneration` fences one vault incarnation. `runtimeEpoch` fences receipts and job capabilities to one server runtime. Neither may be inferred from display names.

## Body candidates and structural lifecycle

A local Markdown update is persisted as a device-scoped candidate before submission. Candidate identity is the tuple of device ID, body ID, candidate ID, and digest.

The server:

1. rejects candidates for inactive bodies;
2. verifies the declared SHA-256 digest against bounded bytes;
3. returns the same receipt for an exact retry;
4. rejects reuse of a candidate ID with different bytes;
5. commits body generation and catalog content metadata atomically.

A fresh create has an additional fence: its lifecycle intent names the exact candidate ID and digest. The path cannot become active in the root until that body candidate is durable. Rename, delete, and revive similarly commit durable lifecycle state before root publication. Batched structural operations publish in one root transaction after every receipt is durable.

A delete tombstones the body identity. A stale device cannot submit another candidate to an inactive body. Revival is a new explicit lifecycle transition, not an accidental consequence of an old body update.

## Bootstrap and catch-up

Fresh or reset local state bootstraps from SQLite, not R2:

1. obtain a pinned boundary descriptor;
2. verify the root checkpoint hash and schema;
3. page active catalog heads;
4. fetch and verify each body identity, generation, size, content hash, and safe path;
5. settle disk conservatively;
6. replay the ordered SQL feed to the current high-water mark;
7. recheck current heads before each mutation and release the pin only on completion.

Concurrent rename/delete/create activity is resolved against current heads. If the feed floor has advanced beyond a client's cursor, it returns to a fresh pinned bootstrap. An interrupted bootstrap and unresolved body settlement persist locally for retry; neither is treated as successful convergence.

## Ordinary edits

A local Markdown edit enters its body Yjs document and IndexedDB candidate queue. A remote update enters the body first and is then materialized by `DiskMirror`; sockets do not write disk directly.

Watcher changes are coalesced. YAOS-authored disk writes carry an expected content fingerprint. A matching event is suppressed; a mismatch is new external input. Time alone is never proof that YAOS authored an event.

Attachment bytes are uploaded before their structural reference. Upsert, delete, and rename intents are persisted in the generation-scoped local database with a stable operation ID before submission; they are removed only after the server atomically commits the root/catalog mutation and the returned root is saved locally. Lost responses and restarts replay the same operation. Root sockets never accept direct attachment-map writes.

## Reconciliation authority

Authority is selected for each observed transition:

- a live editor is authoritative for active user input;
- a durable server body is authoritative for accepted remote state;
- disk content is candidate local input;
- a recovery item is authoritative only for the explicit selection being restored.

No pass may apply two incompatible observed-content authorities to the same body. Preservation precedes convergence: read/stat failure is uncertainty, never permission to delete or overwrite.

### Closed-file divergence

With baseline hash `B`, disk hash `D`, and body hash `C`:

- `D == C`: no conflict;
- `D != B` and `C == B`: import disk;
- `D == B` and `C != B`: write body state to disk;
- both changed and differ: preserve both before applying the policy-selected winner.

Without a trustworthy per-file baseline, modification time may be used only as documented evidence. Ambiguity follows conservative conflict preservation.

### Open/editor-bound divergence

When editor, disk, and body all disagree and no single authority is proven:

1. preserve the losing content in a Markdown sibling conflict note;
2. keep the selected version at the original path;
3. converge the body only after preservation succeeds.

If artifact creation fails, convergence must not discard either side. Repeated identical recovery attempts are quarantined, and monotonic-growth detection separately stops amplification-shaped loops.

### Attachment conflict

If an attachment changes locally during a remote download, YAOS keeps the local file at the original path, writes remote bytes to a local-only conflict artifact, suppresses that artifact from immediate upload, and notifies the user. Markdown conflict artifacts synchronize normally; attachment conflict artifacts do not.

## Remote file deletion

Remote deletion uses baseline evidence:

| Baseline | Local state | Decision |
|---|---|---|
| Known | Matches baseline | Apply configured trash/delete policy |
| Known | Differs | Preserve local work and explicitly revive |
| Missing or unreadable | Exists | Preserve unresolved; do not revive automatically |

Unresolved paths remain guarded from later scan/import resurrection until explicit local create, modify, or delete establishes new intent. Deleted Markdown content may later be reaped, but its tombstone identity remains.

## Recovery-v2 contract

Ordinary Markdown sync and SQL bootstrap do not depend on recovery storage. If either R2 or `RecoveryJob` is absent, the recovery API reports unavailable and core sync continues.

Capture is asynchronous. The vault authority pins one SQL boundary; a generation-scoped job materializes verified content, builds bounded active/deleted/attachment manifest trees, and publishes one immutable format-2 root. `complete_with_gaps` is a successful terminal state only because every unavailable entry and its reason remain explicit.

Restore is asynchronous and selection-scoped. The client must:

1. back up every existing target before replacement;
2. recheck that the target still matches the reviewed state;
3. validate snapshot root, manifest entry, content hash, body identity, and generation;
4. use normal body candidates and lifecycle receipts;
5. settle disk before reporting an item restored;
6. report changed, skipped, and failed items individually.

GC and purge can delete only keys under the exact `vaultId`/`vaultGeneration` prefixes authorized by the vault authority.

## Receipts and status language

The receipt contract is candidate-based, not state-vector dominance:

- a durable body receipt identifies device, candidate, digest, body generation, vault sequence, `vaultGeneration`, and `runtimeEpoch`;
- the local candidate remains pending until that exact durable receipt is persisted;
- lifecycle receipts separately confirm structural operations before root publication;
- reconnect retries are idempotent.

Permitted claims:

- root or body provider connected;
- initial provider synchronization completed;
- a named local candidate was durably accepted by the server;
- a named lifecycle operation was durably committed;
- historical receipt time, explicitly historical.

Forbidden claims:

- another device materialized the change;
- socket-open alone proves persistence;
- a precise count of edits awaiting other-device delivery;
- an old runtime epoch confirms current state.

## Failure posture

- Corrupt or inconsistent SQL state: fail closed.
- Wrong vault generation, stale candidate, inactive body, or mismatched digest: reject.
- Missing or invalid ticket/schema/protocol declaration: reject before room admission.
- Revoked membership: remove admission immediately, persist a device-fence obligation, terminate active sockets, and retain operator-visible retry state until the vault runtime acknowledges the fence.
- IndexedDB or bootstrap settlement failure: retain retry state; do not claim readiness.
- Unknown filesystem deletion baseline: preserve.
- Missing R2: disable attachments and recovery; continue Markdown root/body sync.
- Missing `RecoveryJob`: disable recovery; continue Markdown root/body sync.
- Recovery job retry/gap/failure: expose the state; do not report false completion.
- Diagnostics persistence failure: lose bounded diagnostics; continue sync.

Settings sync, headless clients, and Docker packaging are outside the current contract. Large benchmark/soak, deployed Cloudflare, and real mobile recovery claims are also outside current evidence; see [QA](qa.md).
