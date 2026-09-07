# Current architecture

## Runtime boundaries

The shipped Obsidian plugin is built from `src/` into `main.js`. It contains the sync engine and diagnostics runtime. Diagnostics collection is inert until enabled.

The QA harness under `qa/` is not shipped. QA scenarios use a separately built product bundle with `__YAOS_QA_HARNESS_ENABLED__=true`; production code does not import QA implementations. A release contains `main.js`, `manifest.json`, and `styles.css`.

`FlightTraceController` owns the client diagnostics lifecycle. Product code emits through the published flight envelope and taxonomy; there is no second persistent logger.

`ObsidianHostAdapter` is the sole boundary for capability-checked undocumented
Obsidian behavior, including leaf identities and the community-plugin manager.
Its scoped patch registry observes only demonstrated product needs and always
stands down safely when the host behavior is unavailable or replaced. The
supported behavior matrix is in [Obsidian host compatibility](obsidian-host-compatibility.md).

`plugin.api` is a separate, versioned data-only projection for other plugins.
It exposes immutable collaboration authority, member/presence summaries,
coordinator, settlement, and preservation facts without Yjs documents,
credentials, invitation secrets, providers, diagnostics, or mutation controls.
Consumers reacquire after `yaos:api-ready`; unload fences retained handles.
The contract is in [Public plugin API](public-api.md).

The headless client under `packages/cli` hosts the same `VaultSync`, `BodyManager`, `DiskMirror`, and reconciliation policy on a local Linux filesystem. It is Markdown-only, stores its complete principal/device authority tuple and schema-7 retry/cache state in machine-local SQLite, and never copies another enrollment's bearer.

The Cloudflare Worker classes are thin platform wrappers around portable `ControlPlaneRuntime`, `VaultRuntime`, and `RecoveryJobRuntime` compositions. `packages/server-node` supplies Node-specific SQLite/KV, actor, WebSocket, alarm, and filesystem-object mechanisms to those same domain owners; it does not implement a second sync policy.

## Identity and provisioning

A claimed Worker is one operator-owned control plane. The server hashes the operator recovery key and uses short-lived, revocable browser sessions for console operations. The global registry owns vault records, stable vault-scoped principals, owner/member memberships, separately revocable device credentials, purpose-bound one-use codes, ownership transfers, authorization-change obligations, security audit events, pending deletion obligations, and the socket-ticket signing key. The operator provisions and repairs infrastructure but is not implicitly a vault content actor.

One operator can create multiple vaults. Every active vault has exactly one owner; every other active principal is a full member. Owner and member have the same complete-vault content authority, while only the owner governs people, recovery, audit, policy, metadata, ownership transfer, and destruction. There are no viewer, delegated-admin, folder-ACL, or permission-toggle modes.

A physical installation may enroll different folders in different vaults, but each device identity and bearer belongs to one principal in exactly one vault. **Invite person** creates a member principal and its first device. **Add my device** creates another independently revocable credential for the current principal. These code purposes are not interchangeable, and credentials are never copied between enrolled folders.

Vault creation is a recoverable provisioning saga:

1. The registry reserves a unique `vaultId` and `vaultGeneration` in `provisioning` state.
2. The vault Durable Object idempotently creates schema-7 metadata and an empty root in SQLite.
3. The registry moves the matching generation to `awaiting_owner` and, for claim, publishes the one-use owner-bootstrap code.
4. Owner enrollment installs the first complete principal/device authority fence and then activates the vault.
5. A failure remains recorded as retryable provisioning or authorization-change state; it is not exposed as an active partial vault.

`vaultGeneration` identifies one storage incarnation of a vault and scopes every R2 key and asynchronous job. `runtimeEpoch` identifies one live Durable Object runtime and prevents receipts or capabilities from being mistaken for evidence from another runtime.

## Schema-7 vault authority

Schema 7 retains the schema-6 root/body, semantic-frontmatter, component-settlement, and revisioned-attachment architecture while adding human collaboration authority:

- the root Yjs document carries `pathToId`, attachment references and metadata, attachment tombstones, and schema metadata;
- every Markdown file has a stable file/body identity and its own Yjs document whose text key is `body`;
- SQL catalog events bind body identity, canonical path, lifecycle, durable generation, content hash, and size at a vault sequence;
- folders are derived from paths; empty folders have no synchronized identity.
- a generation-scoped SQL mirror carries current principal membership and device credential revisions;
- durable content mutations record the admitted principal and device without claiming character-level authorship.

The root is a server-published structural view: client root sockets may negotiate and receive updates but cannot mutate it. Structural changes become authoritative only after the server durably commits lifecycle records and returns receipts; the corresponding root mutation is then published. Markdown content becomes authoritative only through a device-scoped candidate identified by device ID, candidate ID, and SHA-256 digest. Candidate retries are idempotent, candidate-ID reuse with different bytes is rejected, and a fresh create cannot publish a root path before its exact body candidate is durable.

Renames and folder moves can commit as structural batches before one root transaction is published. Deletes tombstone catalog identity and reject later stale body candidates. This preserves cross-file structural atomicity without keeping all Markdown bodies resident in one Yjs document.

The exact product pins are:

| Boundary | Version |
|---|---:|
| Document schema | 7 |
| Durable SQL storage format | 2 |
| Socket protocol | 3 |
| Recovery snapshot format | 2 |
| Settings sync format | 1 |
| Control-plane identity format | 3 |

Missing or mismatched schema or protocol declarations fail admission with `update_required`. Mixed writers are unsupported.

## Store and runtime ownership

The vault Durable Object contains separate durable and live owners:

- `VaultStore` composes the SQLite document, catalog, bootstrap, recovery-authority, receipt, pin, and deletion stores. SQLite is the durable source for root/body generations, vault sequence, lifecycle, and recovery authority.
- `VaultDocumentCache` owns loaded Yjs documents and pending updates. It enforces body-count, a 48 MiB encoded-Yjs-state proxy budget, and a 16 MiB transient/pending budget and may evict only clean, unpinned bodies with no open socket. Known count, encoded-state, and transient pressure at body WebSocket admission returns a bounded `429` with the exact pressure reason and a one-second retry hint; unknown reconstruction/storage failures retain the generic error path. Encoded state is a representation bound, not server heap measurement. The client `BodyManager` independently bounds a versioned 48 MiB loaded-body resident estimate; temporary and shared estimates are reported separately pending RFC 09 policy. The client estimate's evidence and limits are defined in [body residency accounting](residency-accounting.md).
- `VaultSocketService` owns root and body WebSocket sessions. The root socket is structural; a body socket is admitted only for an active body.
- `VaultLifecycleService` owns durable create, rename, delete, and revive ordering plus root publication checks.
- `VaultCandidateService` owns device-scoped body candidate admission, idempotency, and durable receipts.
- The collaboration control plane owns principal profiles, memberships, devices, invitations, device links, transfer offers, authorization-change sagas, and audit. The vault-side authority mirror validates every forwarded actor tuple and installs revocation/transfer fences in the same serialized mutation domain as content work.
- `SettingsSyncStore` owns bounded principal-scoped settings environments in tables inside the same vault Durable Object. The storage key is `principalId + configDirKey`; its monotonic environment revision orders file rows, plugin/theme intents, tombstones, and version-gated plugin data. Settings never enter root/body Yjs documents or R2 and one principal cannot read another principal's environment.

On the client, `VaultSync` owns the root, transport, durable candidate queue, and lifecycle submission. `BodyManager` loads and persists bodies independently and evicts only clean, settled, unpinned bodies. `DiskMirror`, `ReconciliationController`, and `EditorBindingManager` retain filesystem/editor preservation responsibilities. `BlobSyncManager` owns the optional non-Markdown plane.

The client `SettingsSyncEngine` is a separate serialized lifecycle. It gates on active authority, `vault.settings.personal.sync`, exact server capability, and settings format; scopes one environment by the current principal plus the sanitized basename of the active Obsidian configuration directory; watches only the allowlist; and owns LWW reconciliation. A pre-existing remote environment requires an explicit user decision. Before the first mutation, the client persists the complete ordered plan in IndexedDB under the exact host, vault generation, folder, principal, membership revision, device credential revision, and configuration key. Only successful seed/take/replace commits acceptance. A stale authority tuple can neither resume nor authorize the queue.

## SQL bootstrap and steady-state sync

A new or reset client bootstraps without R2:

1. The server flushes loaded documents and creates a time-bounded SQL history pin at one vault sequence.
2. The client verifies the schema-7 root checkpoint.
3. It pages the SQL catalog and fetches each referenced body at the pinned boundary.
4. Each body is identity-, generation-, size-, hash-, and path-checked before disk settlement.
5. The client catches up from the ordered SQL feed, rechecks current heads before mutation, and records unresolved bodies for retry.
6. The bootstrap is completed and its history pin is released.

Bootstrap never treats an unreadable local path as permission to overwrite or delete it. Rename races, disappearing heads, feed-floor reset, and changed generations are settled against current SQL heads. IndexedDB is scoped by vault generation and local folder; it is a retry/cache boundary and pending-work journal, not a conflict authority.

After bootstrap, the root socket carries structural changes and body sockets are opened only for active consumers. Body candidates are persisted in IndexedDB before submission. The server returns a durable receipt containing the candidate identity, body generation, vault sequence, `vaultGeneration`, and `runtimeEpoch`; only an exact receipt clears that candidate.

## Filesystem reconciliation

Local watcher events are coalesced. Markdown changes use text diffs rather than replace-all updates. Server-origin changes enter a body document before `DiskMirror` materializes them.

Writes are serialized per path and carry an expected content fingerprint. A watcher event is suppressed only when observed content matches the expected write; elapsed time alone is not evidence of authorship. Disk/editor/CRDT disagreement follows preservation-before-convergence rules in the [sync contract](sync-contract.md).

## Settings sync

Settings sync is enabled by default after enrollment and belongs to the current principal. The shared scope is `vaultId + principalId + configDirKey`, where the last component is the named, sanitized configuration-folder key. Different principals never share settings, and ownership transfer does not reveal or confiscate either person's environment. Different keys such as `.obsidian` and `.obsidian-mobile` remain independent within one principal. An existing remote environment is not applied without this device's explicit seed/take/replace decision; a take first persists its exact-authority queue, then commits acceptance only after apply succeeds, while defer withholds the decision. The synchronized file set remains closed to selected root JSON, `snippets/*.css`, and community-plugin `data.json`; device-local and excluded state remains local.

The vault SQL sidecar stores settings format 1. Every accepted mutation advances one safe integer environment revision, and each changed row receives that revision. Clients use the last acknowledged hash and revision to distinguish newer server state, dirty local state, first-seen files, and acknowledged deletion. Seed is create-once; replace atomically publishes a complete local snapshot and tombstones omitted live plugins and themes.

Plugins and themes synchronize as repository/version intents, enabled state, and explicit tombstones. A plugin tombstone removes its live intent and plugin data. Plugin `data.json` can move in either direction only when the local manifest version, shared intent pin, and data-row version are identical and the plugin is not tombstoned. Binaries are never stored by YAOS: installation resolves Obsidian's published catalogs and GitHub repositories, requires explicit auto-install consent, and pauses at install steps while the app is backgrounded.

Inbound JSON must decode, hash correctly, and parse before replacement; invalid JSON is quarantined while the local file and remaining apply steps are preserved. Official Obsidian Sync, Remotely Save, LiveSync, or System3 Relay pauses this subsystem as a clash. Missing capability, a format mismatch, the local off switch, deferral, or a clash does not stop note sync.

## Attachments

Non-Markdown files, including Canvas, Excalidraw, Base, images, and PDFs, use whole-file content-addressed R2 objects. After bytes are durable, the client persists a generation-scoped attachment operation before submitting its stable operation ID. The server validates the object and commits the root mutation with its attachment catalog event before broadcasting it. Lost responses, publication failures, and restarts replay the same upsert/delete/rename intent; root sockets never accept direct attachment-map writes.

Without `YAOS_BUCKET`, attachment sync is unavailable while root/body Markdown sync, SQL persistence, and SQL bootstrap continue normally.

## Recovery-v2

Recovery is optional and requires both R2 and the `RecoveryJob` Durable Object binding. It is not on the request path for ordinary Markdown sync.

The vault object remains the authority for fixed-boundary plans, history pins, recovery leases, catalogs, restore authority, and GC marks. Deterministically named `RecoveryJob` objects own alarm-driven execution and durable job progress for projection, capture, restore, garbage collection, and purge.

The projection job materializes content-addressed Markdown objects needed by recovery. A capture pins one SQL sequence, pages active bodies, deleted identities, and attachments, verifies materialization coverage, builds bounded content-addressed manifest trees, and publishes an immutable `yaos-recovery-v2` root. Jobs are resumable, capability-scoped, bounded per alarm, and may report `complete_with_gaps` when a manifest explicitly records unavailable content.

Browsing follows only the requested manifest branch. Restore is asynchronous and selection-scoped. Before replacement, the client backs up affected local paths and rechecks disk state; it then submits body candidates and lifecycle operations through normal durable paths, settles disk, and reports per-item outcomes. Recovery never replaces the live SQL root/body authority with an R2 snapshot.

GC marks retained recovery and blob roots, acquires bounded sweep leases, and deletes only unmarked generation-scoped objects. R2 unavailability can delay recovery work without making Markdown sync unavailable.

## Authentication, authority, and admission

`POST /claim` initializes the operator control plane and provisions the first vault. `POST /enroll` consumes one purpose-bound code and returns the principal ID, owner/member role, membership revision, device ID, device credential revision, fixed capabilities, bearer, selected vault generation, and origin/joining authority. The client persists its generated request ID and credentials before enrollment; a lost response retries the same hashes and receives the same bounded replay record without storing the plaintext bearer server-side.

Vault HTTP routes require the device bearer and selected vault ID. The public route resolves the current principal, membership, device credential, role, policy version, capability digest, and active generation, then replaces any caller-supplied actor headers with this trusted context before forwarding. The vault runtime verifies the context against its durable authority mirror and checks the fixed capability for the route. Settings routes additionally bind the environment to the admitted principal and require exactly one `settingsFormatVersion=1`.

A short-lived protocol-3 ticket is deployment-, vault-generation-, principal-, membership-, device-, credential-, purpose-, and document-bound; long-lived credentials never appear in socket URLs. Root and body handshakes require exact `schemaVersion=7` and `protocolVersion=3`. Current control-plane authority is checked before runtime admission and the vault mirror checks it again. Protocol liveness still requires exact per-socket acknowledgements; browser `OPEN` alone is not responsive evidence.

Revocation or ownership transfer first prevents new admission, then installs one idempotent authority change in the vault mutation order and closes affected sockets. A mutation ordered before the fence remains committed; one ordered after it fails as `authority_superseded`. Exact operation-outcome lookup can recover a bounded receipt for work that committed before a response was lost, but cannot create new work. The client preserves stale-authority work as unpublished rather than replaying it under new authority.

Leaving revokes a member principal and all of their devices, retires only its exact settings queue and acceptance, clears the folder's schema-7 enrollment cache, and leaves ordinary files and configuration on disk. Revoking a last member device has the same membership result. An owner cannot leave or lose the last device through ordinary self-service; owner loss uses an audited operator-issued recovery code. Recovery restores content only and never rewinds principals, devices, invitations, authority changes, or audit.

## Purge-first vault deletion

Destroy is a fenced saga, not a best-effort room reset:

1. The registry removes the vault, memberships, and pairing capabilities from admission and records the exact deletion obligation.
2. The vault runtime flushes, fences new work, closes sockets, and cancels active capture/restore jobs.
3. If R2 exists, a generation-scoped purge job empties only that generation's `recovery-v2/` and `blobs/` prefixes.
4. Only after purge completes does the operator path delete the vault object's SQLite state.
5. Failure or retry remains visible under the original deletion and purge identities; the vault ID is not reused while cleanup is pending.

When R2 is absent, the R2 phase is already complete and SQL deletion can proceed. This ordering prevents lost SQL authority from making generation-owned objects unaccountable.

## Safety boundaries and deferred evidence

Persistence corruption, invalid identity, wrong generation, stale candidate, and incompatible versions fail closed. Diagnostics fail open. Uncertain filesystem deletion preserves data. Settings JSON and hashes are quarantined before apply, and incompatible settings capability or clashes isolate the settings subsystem. Recovery jobs expose retries and terminal gaps rather than reporting false completeness.

Large-vault benchmark and soak evidence, deployed-Cloudflare recovery/deletion/settings evidence, broader real desktop settings/recovery flows, and all real mobile settings/recovery evidence are deferred; current evidence is described only in [QA](qa.md). The Docker image packages the conformant Node host without changing the shared domain runtimes. Evidenced open risks are tracked in [BACKLOG.md](BACKLOG.md).
