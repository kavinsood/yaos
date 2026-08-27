# Current architecture

## Runtime boundaries

The shipped Obsidian plugin is built from `src/` into `main.js`. It contains the sync engine and diagnostics runtime. Diagnostics collection is inert until enabled.

The QA harness under `qa/` is not shipped. QA scenarios use a separately built product bundle with `__YAOS_QA_HARNESS_ENABLED__=true`; production code does not import QA implementations. A release contains `main.js`, `manifest.json`, and `styles.css`.

`FlightTraceController` owns the client diagnostics lifecycle. Product code emits through the published flight envelope and taxonomy; there is no second persistent logger.

## Identity and provisioning

A claimed Worker is one operator-owned control plane. The server hashes the operator recovery key and uses short-lived, revocable browser sessions for console operations. The global registry owns vault records, per-vault device memberships, one-use pairing codes, pending deletion obligations, and the socket-ticket signing key.

One operator can create multiple vaults. A physical installation may enroll different folders in different vaults, but each device identity, membership, and bearer belongs to exactly one vault. A pairing code selects that vault and creates a new device identity; credentials are never copied between enrolled folders.

Vault creation is a recoverable provisioning saga:

1. The registry reserves a unique `vaultId` and `vaultGeneration` in `provisioning` state.
2. The vault Durable Object idempotently creates schema-4 metadata and an empty root in SQLite.
3. The registry activates the matching generation and, for claim, publishes the first pairing code.
4. A failure remains recorded as retryable provisioning state; it is not exposed as an active partial vault.

`vaultGeneration` identifies one storage incarnation of a vault and scopes every R2 key and asynchronous job. `runtimeEpoch` identifies one live Durable Object runtime and prevents receipts or capabilities from being mistaken for evidence from another runtime.

## Schema-4 vault authority

Schema 4 replaces the vault-wide content monolith with one structural root document and independent Markdown body documents:

- the root Yjs document carries `pathToId`, attachment references and metadata, attachment tombstones, and schema metadata;
- every Markdown file has a stable file/body identity and its own Yjs document whose text key is `body`;
- SQL catalog events bind body identity, canonical path, lifecycle, durable generation, content hash, and size at a vault sequence;
- folders are derived from paths; empty folders have no synchronized identity.

The root is a server-published structural view: client root sockets may negotiate and receive updates but cannot mutate it. Structural changes become authoritative only after the server durably commits lifecycle records and returns receipts; the corresponding root mutation is then published. Markdown content becomes authoritative only through a device-scoped candidate identified by device ID, candidate ID, and SHA-256 digest. Candidate retries are idempotent, candidate-ID reuse with different bytes is rejected, and a fresh create cannot publish a root path before its exact body candidate is durable.

Renames and folder moves can commit as structural batches before one root transaction is published. Deletes tombstone catalog identity and reject later stale body candidates. This preserves cross-file structural atomicity without keeping all Markdown bodies resident in one Yjs document.

The exact product pins are:

| Boundary | Version |
|---|---:|
| Document schema | 4 |
| Durable SQL storage format | 1 |
| Socket protocol | 1 |
| Recovery snapshot format | 2 |

Missing or mismatched schema or protocol declarations fail admission with `update_required`. Mixed writers are unsupported.

## Store and runtime ownership

The vault Durable Object contains separate durable and live owners:

- `VaultStore` composes the SQLite document, catalog, bootstrap, recovery-authority, receipt, pin, and deletion stores. SQLite is the durable source for root/body generations, vault sequence, lifecycle, and recovery authority.
- `VaultDocumentCache` owns loaded Yjs documents and pending updates. It may evict only clean, unpinned bodies that have no open socket.
- `VaultSocketService` owns root and body WebSocket sessions. The root socket is structural; a body socket is admitted only for an active body.
- `VaultLifecycleService` owns durable create, rename, delete, and revive ordering plus root publication checks.
- `VaultCandidateService` owns device-scoped body candidate admission, idempotency, and durable receipts.

On the client, `VaultSync` owns the root, transport, durable candidate queue, and lifecycle submission. `BodyManager` loads and persists bodies independently and evicts only clean, settled, unpinned bodies. `DiskMirror`, `ReconciliationController`, and `EditorBindingManager` retain filesystem/editor preservation responsibilities. `BlobSyncManager` owns the optional non-Markdown plane.

## SQL bootstrap and steady-state sync

A new or reset client bootstraps without R2:

1. The server flushes loaded documents and creates a time-bounded SQL history pin at one vault sequence.
2. The client verifies the schema-4 root checkpoint.
3. It pages the SQL catalog and fetches each referenced body at the pinned boundary.
4. Each body is identity-, generation-, size-, hash-, and path-checked before disk settlement.
5. The client catches up from the ordered SQL feed, rechecks current heads before mutation, and records unresolved bodies for retry.
6. The bootstrap is completed and its history pin is released.

Bootstrap never treats an unreadable local path as permission to overwrite or delete it. Rename races, disappearing heads, feed-floor reset, and changed generations are settled against current SQL heads. IndexedDB is scoped by vault generation and local folder; it is a retry/cache boundary and pending-work journal, not a conflict authority.

After bootstrap, the root socket carries structural changes and body sockets are opened only for active consumers. Body candidates are persisted in IndexedDB before submission. The server returns a durable receipt containing the candidate identity, body generation, vault sequence, `vaultGeneration`, and `runtimeEpoch`; only an exact receipt clears that candidate.

## Filesystem reconciliation

Local watcher events are coalesced. Markdown changes use text diffs rather than replace-all updates. Server-origin changes enter a body document before `DiskMirror` materializes them.

Writes are serialized per path and carry an expected content fingerprint. A watcher event is suppressed only when observed content matches the expected write; elapsed time alone is not evidence of authorship. Disk/editor/CRDT disagreement follows preservation-before-convergence rules in the [sync contract](sync-contract.md).

## Attachments

Non-Markdown files, including Canvas, Excalidraw, Base, images, and PDFs, use whole-file content-addressed R2 objects. After bytes are durable, the client submits a device-authenticated attachment command; the server validates the generation-scoped object and commits the root mutation with its attachment catalog event before broadcasting it. Root sockets never accept direct attachment-map writes.

Without `YAOS_BUCKET`, attachment sync is unavailable while root/body Markdown sync, SQL persistence, and SQL bootstrap continue normally.

## Recovery-v2

Recovery is optional and requires both R2 and the `RecoveryJob` Durable Object binding. It is not on the request path for ordinary Markdown sync.

The vault object remains the authority for fixed-boundary plans, history pins, recovery leases, catalogs, restore authority, and GC marks. Deterministically named `RecoveryJob` objects own alarm-driven execution and durable job progress for projection, capture, restore, garbage collection, and purge.

The projection job materializes content-addressed Markdown objects needed by recovery. A capture pins one SQL sequence, pages active bodies, deleted identities, and attachments, verifies materialization coverage, builds bounded content-addressed manifest trees, and publishes an immutable `yaos-recovery-v2` root. Jobs are resumable, capability-scoped, bounded per alarm, and may report `complete_with_gaps` when a manifest explicitly records unavailable content.

Browsing follows only the requested manifest branch. Restore is asynchronous and selection-scoped. Before replacement, the client backs up affected local paths and rechecks disk state; it then submits body candidates and lifecycle operations through normal durable paths, settles disk, and reports per-item outcomes. Recovery never replaces the live SQL root/body authority with an R2 snapshot.

GC marks retained recovery and blob roots, acquires bounded sweep leases, and deletes only unmarked generation-scoped objects. R2 unavailability can delay recovery work without making Markdown sync unavailable.

## Authentication and admission

`POST /claim` initializes the operator control plane and provisions the first vault. `POST /enroll` consumes one pairing code and returns a device bearer, device ID, and selected vault ID. Codes expire after 15 minutes and work once.

Vault HTTP routes require the device bearer and vault ID. A short-lived device-scoped ticket is minted for WebSocket use; long-lived credentials never appear in socket URLs. Root and body handshakes require `ticket`, `schemaVersion=4`, and `protocolVersion=1`. Ticket signature, expiry, vault scope, current membership, active vault state, and vault generation are checked before runtime admission. Revocation closes already-active root/body sockets for that device as well as preventing future admission.

Leaving revokes one membership, clears the folder's enrollment and schema-4 IndexedDB cache, and leaves ordinary files on disk. Operator kick revokes one membership. Operator destroy revokes the complete vault boundary.

## Purge-first vault deletion

Destroy is a fenced saga, not a best-effort room reset:

1. The registry removes the vault, memberships, and pairing capabilities from admission and records the exact deletion obligation.
2. The vault runtime flushes, fences new work, closes sockets, and cancels active capture/restore jobs.
3. If R2 exists, a generation-scoped purge job empties only that generation's `recovery-v2/` and `blobs/` prefixes.
4. Only after purge completes does the operator path delete the vault object's SQLite state.
5. Failure or retry remains visible under the original deletion and purge identities; the vault ID is not reused while cleanup is pending.

When R2 is absent, the R2 phase is already complete and SQL deletion can proceed. This ordering prevents lost SQL authority from making generation-owned objects unaccountable.

## Safety boundaries and deferred work

Persistence corruption, invalid identity, wrong generation, stale candidate, and incompatible versions fail closed. Diagnostics fail open. Uncertain filesystem deletion preserves data. Recovery jobs expose retries and terminal gaps rather than reporting false completeness.

Large-vault benchmark and soak evidence, deployed-Cloudflare recovery/deletion evidence, and real mobile recovery evidence are deferred; current evidence is described only in [QA](qa.md). Settings sync, headless clients, and Docker packaging remain future work. Evidenced open risks are tracked in [BACKLOG.md](BACKLOG.md).
