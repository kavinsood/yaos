# Current architecture

## Runtime boundaries

The shipped Obsidian plugin is built from `src/` into `main.js`. It contains the sync engine and the debug/diagnostics runtime. Debug collection is inert unless the user enables it.

The QA harness lives under `qa/` and is not shipped. QA scenarios use a separate product build compiled with `__YAOS_QA_HARNESS_ENABLED__=true`. Production code may depend on interfaces in `src/observability/`; it must not import QA implementations. CI guards enforce the source and bundle boundaries.

A release contains `main.js`, `manifest.json`, and `styles.css`. Generated bundles and `qa-runs/` evidence are not tracked.

The diagnostics runtime used to ship as a second `telemetry.js` bundle loaded through filesystem access and `new Function`. That split did not create isolation—the bundles shared one realm and broad host handles—but it did add mobile and loader failure modes. Isolation now comes from read-only types, source boundaries, and production-bundle guards instead.

`FlightTraceController` is the single client observability lifecycle: it owns the recorder session, HTTP trace context, server-trace polling, periodic/debounced checkpoints, runtime error capture, export, retention, and shutdown. Product code emits through the published flight envelope/taxonomy; there is no second persistent logger or parallel trace session.

## Vault model

The user-owned surface remains ordinary local files. Yjs provides causal shared state beside those files; the disk bridge exists so Obsidian, scripts, and external tools do not have to treat a proprietary database as the only usable vault.

One vault maps to one Durable Object room and one vault-wide Yjs `Y.Doc`.

The document contains:

- stable file identity and path metadata;
- Markdown `Y.Text` values;
- blob path/hash references and tombstones;
- schema metadata.

A folder has no independent CRDT identity. Folder moves are represented as batches of file-path changes. Empty folders are not synchronized.

The monolith preserves one replication stream and structural transactions such as a multi-file folder rename. Its ceiling is memory, not stored bytes: unmergeable Yjs structs cost roughly 117 bytes each and remain for the life of the resident document. Measurement showed that ordinary state encoding already flattens V8 ropes; rebuilding the document does not remove Yjs structs and temporarily raises memory, so re-materialisation was removed rather than kept as an unsafe escape hatch.

Tombstoned Markdown bodies are reaped after their grace period while tombstone metadata remains to prevent stale-device resurrection. Sharding is not a local optimization: it changes consistency, bootstrap, persistence, recovery, and migration. Sharded bodies are therefore not part of `main`.

## Client synchronization

`VaultSync` owns the local Yjs document, IndexedDB provider, remote provider, file identity, and reconciliation inputs. `ReconciliationController` coordinates authority decisions. `DiskMirror` materializes CRDT state and observes ordinary local files. `EditorBindingManager` connects open Markdown editors to their `Y.Text`. `BlobSyncManager` handles non-Markdown files through R2.

SHA-256, receipt state, reconciliation statistics, and status rendering each have one source shape. `ServerAckState` plus the VaultSync-owned receipt envelope feeds connection facts, status, diagnostics, and QA; status text derives directly from rich `ConnectionState` rather than a second coarse state machine. Path identity is not one pipeline yet: `canonicalizeVaultPath` is the NFC/separator helper at exclusion, snapshot restore, and path-id boundaries, while `VaultSync`, `DiskMirror`, and `BlobSync` still key mutation on Obsidian `normalizePath`. That cutover is [PATH-01](BACKLOG.md#path-01--nfcnfd-normalization-across-the-full-pipeline).

### Disk to CRDT

Obsidian file events are noisy, duplicated, and non-causal. YAOS coalesces dirty paths and drains them at the pace of disk I/O instead of treating each watcher event as an independent operation.

Markdown changes are applied as diffs rather than replace-all updates. This preserves Yjs identity and editor history better than replacing the complete text.

### CRDT to disk

Writes are serialized per path. Before writing, YAOS records the expected content fingerprint. A later filesystem event is suppressed only when observed content matches that expected write. Time windows may bound retained bookkeeping, but elapsed time alone is not proof that YAOS authored an event.

TTL-only suppression previously confused delayed YAOS events with real external edits. Content acknowledgement makes ownership causal: a matching observed state proves the event corresponds to the expected write; a timer does not. Deletes remain weaker because no post-delete content exists to fingerprint.

### Startup

Plugin startup does not wait for network capability metadata. Capability probes previously made load completion depend on DNS and HTTP even though the metadata was not required to start local state or the provider. Local state and core sync now start first; capabilities refresh in the background.

Attachment observers may start early, but download materialization waits for both Obsidian layout readiness and YAOS startup/reconciliation readiness. Earlier materialization could see a file on disk before Obsidian's in-memory vault view exposed it, producing false absence and `EEXIST` races.

IndexedDB is the local persistence cache for Yjs state. Failure to load it fails closed rather than continuing from an empty local document.

## Server persistence

The Durable Object keeps the vault `Y.Doc` in memory and persists it to SQLite using a checkpoint plus journal:

This shape is a resource decision. Full-state rewrite amplifies every small edit; one row per event spends the daily write budget and grows replay work. Coalesced deltas keep normal saves small without turning typing into database churn.

- full checkpoints are split into rows below Cloudflare's per-row limit;
- coalesced Yjs deltas append to a bounded journal;
- checkpoint state vectors anchor journal replay;
- checkpoint and journal payloads carry SHA-256 integrity checks;
- persistence operations are serialized;
- unreadable or inconsistent storage refuses service rather than constructing an empty vault.

Compaction occurs when the journal exceeds 50 entries or 1 MB. A delta above the normal journal limit, repeated append failure, or content reaping forces a checkpoint rewrite. A Yjs update event—not state-vector change—marks the document dirty because deletion-only changes may leave the state vector unchanged.

Observability is separate and fail-open. Trace failures may lose diagnostics but must not make sync unavailable. Trace entries are individually bounded; pre-authentication and high-frequency admission paths do not write room traces.

A small room metadata sidecar supports schema admission without loading the full document. It is not a second authority for vault content.

## Server receipt

The client tracks its latest local candidate state vector. Server echoes contain the server state vector and persistence-generation metadata. A receipt is granted only when the server state dominates the candidate and the persistence generation has advanced under the same server epoch.

A receipt means the server saved this device's latest tracked local state. It does not mean another device received it, and it is not a per-update pending count.

A new server epoch re-baselines the client and withholds confirmation until new persistence progress is observed. Candidate state is kept in IndexedDB, but a previous `true` receipt is never restored as current truth after plugin restart.

## Attachments

Non-Markdown files, including `.canvas`, `.excalidraw`, and `.base`, use the attachment plane when R2 is configured.

The client hashes the complete file and uses authenticated Worker routes. R2 objects are content-addressed. The server caps attachment uploads at 10 MB by default and bounds concurrent R2 work. YAOS intentionally uses whole-file blobs: block-level delta sync would require content-defined chunking, manifests, reference ownership, and safe distributed garbage collection, while small blocks multiply Cloudflare operation costs for a predominantly write-once attachment workload.

If `YAOS_BUCKET` is absent, attachment and snapshot capabilities are disabled while Markdown sync remains available.

## Snapshots

Current snapshots store a compressed full-Yjs update plus an index of referenced blobs in R2. Automatic creation is semantically deduplicated and retained according to the current snapshot policy. Restore downloads a snapshot into a temporary Yjs document, backs up affected current files, and applies selected content through normal safety paths.

The recovery-v2 and recovery-job designs on feature branches are not current `main` behavior.

## Authentication and schema admission

An unclaimed server is claimed once through the browser setup flow. HTTP routes use a bearer token. WebSocket clients first request a short-lived, vault-scoped HMAC ticket; the long-lived token does not appear in the normal WebSocket URL.

Legacy `?token=` WebSocket authentication remains available during the migration window unless `YAOS_DISABLE_LEGACY_WS_TOKEN=true` is set. `VaultSync` refreshes tickets proactively and patches the provider URL because the current `y-partyserver` reconnect loop does not re-run asynchronous connection parameters.

Plugin and server admit exactly one shared schema version. A mismatch is rejected with `update_required`; mixed-schema writes are not supported.

## Resource and safety boundaries

Cloudflare constraints shaping `main` include:

- 128 MB isolate memory;
- 1 GB per Durable Object and 5 GB per account;
- 100,000 rows written and 5,000,000 rows read per day on the free plan;
- 2 MB SQLite row/BLOB limit and 100 KB SQL statement limit;
- bounded concurrent external operations.

Correctness rules:

- uncertain deletion preserves data;
- corrupt persistence fails closed;
- observability fails open;
- filesystem writes serialize per path;
- conflict preservation precedes convergence;
- safety-brake paths do not advance baselines;
- QA mutation controls never ship in the production bundle.

Known violations and unfinished proofs are tracked only in [BACKLOG.md](BACKLOG.md).
