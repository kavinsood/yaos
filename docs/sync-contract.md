# Sync and conflict contract

This is the current schema-10 contract. [BACKLOG.md](BACKLOG.md) contains only evidenced unresolved risks and missing external-scale proof.

## Subjects

| Subject | Current mechanism |
|---|---|
| Vault structure | One root Yjs document plus a durable SQL catalog |
| Markdown | One independently loaded Yjs body per stable file identity |
| File lifecycle | Durable create, rename, delete, and revive records followed by root publication |
| Folders | Derived from paths; empty folders are not synchronized |
| Attachments and special formats | Generation-scoped, content-addressed R2 objects when configured |
| Recovery | Optional asynchronous recovery-v2 snapshots when R2 and `RecoveryJob` are configured |
| Obsidian settings | Allowlisted paths and package intents in a principal-owned, named SQL environment |

Explicitly promoted JSON Canvas 1.0 files use a dedicated semantic plane with
stable identity, typed field groups, Y.Text card content, explicit order,
tombstones, exact common bases, and revision-fenced disk/view projection.
Unpromoted, invalid, unsupported, or oversized Canvas files remain attachments.
Base and other non-Markdown formats continue to use the attachment plane.
Excalidraw may also be explicitly promoted: it then uses native element records,
lower-nonce reconciliation, atomic scene batches, Drawing-room replay and
snapshots, and durable resource manifests rather than Yjs.

## Vault, membership, and transport scope

One server hosts multiple independent vaults. Each active vault has exactly one owner and any number of members. Both roles are full content peers for the complete vault; only the owner governs membership, other people's devices, recovery, audit, vault policy and metadata, ownership transfer, and destruction. YAOS has no viewer role, delegated administrator, folder ACL, or per-person capability toggle.

A principal is a stable vault-scoped person identity; a device is one separately revocable credential-bearing installation for that principal. **Invite person** creates a member principal and first device. **Add my device** adds a device to the current principal. Both codes are one-use, expire, and are purpose-bound. Each local folder stores its complete principal/membership/device authority tuple and has its own schema-10 IndexedDB database.

All vault HTTP requests use a device bearer and vault ID. The control plane resolves a trusted actor containing vault generation, principal ID, membership revision, device ID, credential revision, owner/member role, policy version, and capability digest; the vault runtime accepts no caller-asserted identity. WebSocket URLs never carry the long-lived bearer. The client exchanges it for a short-lived protocol-8 ticket bound to the deployment, exact actor, purpose, document, and semantic epoch. Root, body, semantic Canvas, and Excalidraw handshakes require exact `schemaVersion=10` and `protocolVersion=8`, the current semantic epoch, current control-plane authority, current vault-mirror authority, and exact application liveness.

RFC-14 Excalidraw presence shares the Drawing socket but remains outside every durable synchronization contract. Full replacement states are authenticated by their socket actor, bounded, rate-limited, coalesced, and expired after 15 seconds. Receivers derive monotonic local deadlines from relative expiry. Dropped presence is repaired by periodic full-state refresh; it is never replayed and cannot change scene sequence, conflict resolution, resources, files, or recovery state.

Leave revokes a member principal and all of their devices while keeping ordinary files. Revoking a member's final device has the same membership effect. The owner cannot self-leave or revoke the last owner device. Owner loss is repaired by an audited, operator-issued one-use recovery code. Operator destroy revokes the full vault before generation-scoped physical cleanup.

Attachment heads are revisioned. Every active reference and tombstone carries the operation ID which created it. Upsert, delete, and rename publications name the exact revisions they expect; revision comparison, root mutation, catalog events, and the replay ledger commit atomically under the vault mutation lease. Reusing an operation ID succeeds only for the same canonical request digest. Clients persist publications in a transactionally allocated local sequence, distinguish committed, durably pending, and superseded outcomes, and never silently rebase a superseded operation.

Attachment publication preserves these invariants:

1. only the current local path and runtime intent may hand work to the durable publication queue;
2. every mutation names the exact observed or projected revisions it replaces;
3. revision comparison, root mutation, catalog events, and replay identity commit atomically;
4. every active and deleted attachment head has one opaque revision;
5. an operation ID replays only with the same canonical mutation identity;
6. retry never rebases a mutation onto a newer head;
7. later local intent becomes an ordered successor after durable handoff;
8. revision mismatch retires the operation and dependent successors into reconciliation;
9. published hash and size describe the immutable bytes selected by that intent;
10. rename fences both source and target and never silently overwrites a collision;
11. runtime stop invalidates publication synchronously before teardown awaits;
12. no transfer, intent, or publication crosses vault generation, enrollment, folder, or runtime scope.

The root socket carries structural state. Each active Markdown body has a separate socket opened only while the client needs it. Attachment bytes and recovery artifacts do not travel through body sockets.

## Durable authority

Authority is split by domain:

- SQL metadata binds `vaultId` to one `vaultGeneration`.
- The control plane owns principal profiles, owner/member memberships, device credentials, invitation/device-link purpose, and security audit.
- The vault SQL mirror owns current principal and device revisions at the durable mutation boundary.
- The durable SQL sequence, catalog, lifecycle records, document heads, candidate receipts, and recovery authority are the server source of truth.
- The root Yjs document is the replicated structural view: path-to-body identity, attachment references, tombstones, and schema metadata.
- A Markdown body Yjs document owns only one file's text.
- IndexedDB stores the local root, bodies, pending candidates, lifecycle intents, bootstrap progress, and disk baselines. It is a retry/cache boundary, not the shared conflict winner.
- Disk and live editors are observed local authorities subject to reconciliation and preservation rules.
- An R2 recovery point becomes restore input only through an explicit restore; it never becomes the live server authority directly.
- Principal-owned named settings environments live in a SQL sidecar inside the vault Durable Object. They are not part of root/body Yjs, attachment objects, or recovery R2 objects.

`vaultGeneration` fences one vault incarnation. `runtimeEpoch` fences receipts and job capabilities to one server runtime. Neither may be inferred from display names.

Every durable mutation revalidates its trusted actor inside the same serialized vault boundary that installs authority changes. If the mutation orders first it commits under the old authority; if the fence orders first the mutation fails with `authority_superseded`. The client must not relabel or replay queued work under a different membership or credential revision. It preserves that work locally, while an exact operation-ID and request-digest lookup may recover only an outcome already committed by the same actor.

Root awareness preserves one live instance per device/socket. The server rewrites identity-bearing awareness fields from the vault authority mirror, so peers see the principal display name/color and the actual device ID rather than caller-selected identity. UI may group devices under a person, but transport state remains per device.

## Body candidates and structural lifecycle

A local Markdown update is persisted as an authority-scoped candidate before submission. Candidate identity retains device ID, body ID, candidate ID, and digest, while admission and durable attribution additionally bind the current principal, membership revision, and device credential revision.

The candidate digest names the encoded Yjs update bytes, not the note's logical
text. Catalog content hashes and disk baselines name canonical Markdown bytes
under [`markdown-lf-v1`](canonical-markdown.md); exact disk fingerprints remain
separate self-write evidence.

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

## Settings environments

### Scope, storage, and allowlist

Settings scope is `vaultId + principalId + configDirKey`, where `configDirKey` is the sanitized basename of `app.vault.configDir`. The key must be 1–64 characters and cannot be `.`, `..`, contain NUL, `/`, or `\`. Folder names such as `.obsidian` and `.obsidian-mobile` select distinct environments for the same principal. Different principals cannot read or mutate one another's environments, and ownership transfer does not move settings between people.

The exact file allowlist is:

- root JSON: `app.json`, `appearance.json`, `hotkeys.json`, `graph.json`, `daily-notes.json`, `templates.json`, `backlink.json`, `page-preview.json`, `note-composer.json`, `switcher.json`, `bookmarks.json`, `workspaces.json`, `core-plugins.json`, and `core-plugins-migration.json`;
- one-level `snippets/*.css`;
- community-plugin `plugins/<id>/data.json`, represented in the plugin-data table rather than the ordinary-file table.

`workspace.json`, `workspace-mobile.json`, `community-plugins.json`, `file-recovery.json`, `publish.json`, `types.json`, unknown root JSON, YAOS/QA-harness plugin data, manifests, JavaScript, CSS theme packages, and all other paths remain local. Unknown root JSON is surfaced but never silently admitted. Plugin and theme binaries are never uploaded to YAOS, Yjs, SQL, or R2.

Settings format `1` uses environment, file, plugin-intent, theme-intent, tombstone, and plugin-data tables inside the vault Durable Object. A named environment has one monotonic safe-integer `envRev`; every accepted item mutation advances it once and assigns the same revision to the changed row. Corrupt rows, exhausted revision space, duplicate snapshot identities, invalid UTF-8/JSON, bad hashes, traversal, and exceeded bounds fail closed.

### Initialization and LWW

Settings sync defaults on after enrollment, but a pre-existing remote environment cannot apply to a new local identity without an explicit user decision. A take/replace action authorizes work for the exact host, vault, generation, folder, device, and configuration key; its full apply queue is durable before the first mutation, and acceptance commits only after the operation succeeds. An unseeded or decision-required environment offers:

- **Seed from this device** atomically creates revision 1 from this folder and records acceptance only after the seed succeeds; it fails if another device seeded first;
- **Take the remote seed** persists the exact-identity apply queue, applies the existing remote environment, then records acceptance;
- **Decide initial seed later** records deferral without authorizing or applying the environment and leaves note sync running;
- **Replace remote settings environment** explicitly authorizes and atomically replaces the live snapshot with this device, advances the revision, creates plugin/theme tombstones for previously live entries omitted by the replacement, and records acceptance after success.

For ordinary allowlisted files, the client remembers each acknowledged hash and server revision. Equal hashes are a no-op. A newer server revision beats local divergence; otherwise unacknowledged/dirty local content uploads. First-seen remote-only content downloads, first-seen local-only content uploads, acknowledged local absence deletes the remote row, and acknowledged remote absence deletes the local file. Deleting a file advances `envRev` and removes that row; plugin/theme deletion uses tombstones instead.

Inbound bodies must match SHA-256 and every JSON body must parse before disk mutation. Invalid inbound JSON is quarantined: the local file is retained and later queue steps continue. Invalid local JSON is not uploaded. `app.json` or `hotkeys.json` apply marks restart required; `workspaces.json` refreshes workspace names but never changes the active layout.

### Plugins, themes, and consent

A plugin intent contains catalog ID, GitHub repository, pinned version, and enabled state. A theme intent contains catalog name, GitHub repository, and pinned version. A plugin or theme tombstone removes the corresponding live server intent; a plugin tombstone also removes its server plugin-data row. A later matching live intent clears its tombstone. Applying a plugin tombstone disables/unloads/uninstalls it and removes its local plugin directory when the host permits; host failures are reported and folder removal that leaves a loaded plugin requires restart. Applying a theme tombstone removes the local theme directory and reports restart guidance in case it was active.

Plugin `data.json` may upload or apply only when three versions are present and identical: the local installed manifest, the shared plugin intent pin, and the plugin-data row version. A tombstone closes the gate. Mismatch holds the data, exposes update/promote/remove actions, and never rewrites it under a different plugin version.

YAOS resolves package repositories from Obsidian's published plugin/theme catalogs and obtains package manifests/binaries from Obsidian/GitHub at the pinned version; the YAOS server stores only intent metadata. **Automatically install remote plugins and themes** is separate explicit consent and is off by default. Without it, file LWW continues only after environment acceptance, while remote package changes wait for manual **Apply remote environment** or a per-plugin action. Install steps run only in the foreground; background suspension checkpoints before the install. Restricted mode, desktop-only plugins on mobile, missing Obsidian installer APIs, or installation failure skip that step, report the reason, and continue safe later steps.

### Durable apply and lifecycle

An explicit take/replace decision and its complete apply plan precede the first disk or package mutation. Queue and later acceptance identities are exactly `hostHash + vaultId + vaultGeneration + folderKey + principalId + membershipRevision + deviceId + deviceCredentialRevision + configDirKey`; records with any other identity never authorize or resume work. The acceptance marker commits only after successful seed/take/replace, while a crash during take resumes the already-consented queue before that marker exists. The runner checkpoints the first unexecuted step after every attempt, resumes only under the same active authority, and clears only after all steps complete. A malformed or superseded record is not executed.

A full take/manual apply orders: ordinary root JSON except `appearance.json`/`workspaces.json`; CSS snippets; `appearance.json`; theme installs; `appearance.json` again when themes were installed; plugin installs; version-gated plugin data; plugin enabled/disabled state; plugin/theme tombstones; then `workspaces.json`. This keeps workspace activation out of the apply path; a missing or newly changed local manifest still holds plugin data until a later gate sees all three versions equal.

Stopping the runtime waits for the serialized settings operation, removes watchers/timers, and restores the exact Obsidian installer hooks. Re-enrollment and **Leave this vault** retire only the old authority's exact apply queue and acceptance and clear deferral; configuration files remain on disk. Device or membership revocation blocks subsequent bearer requests. Ownership transfer preserves both principals' separate settings. Vault destruction makes every environment inaccessible immediately and removes the settings sidecar when that generation's vault SQL is deleted.

Settings sync starts only after enrollment, active authority with `vault.settings.personal.sync`, exact `settingsSync=true`, and `settingsFormatVersion=2`. Its HTTP route requires the current device bearer and selected vault; the public router supplies the full trusted actor and the vault runtime derives the principal namespace rather than trusting a path parameter. Exactly one format declaration is required. If authority or capability is absent, format is incompatible, the local switch is off, initialization is deferred, or a decision is still required with no durable consented queue, settings loops do not run and note sync remains unaffected.

The clash set is official Obsidian Sync (`sync`), Remotely Save (`remotely-save`), LiveSync (`obsidian-livesync`), and System3 Relay (`system3-relay`), with official Sync taking precedence in the reported reason.

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

Capture is asynchronous. The vault authority pins one SQL boundary; a generation-scoped job materializes verified content, builds bounded active/deleted/attachment manifest trees, and publishes one immutable format-2 root. `complete_with_gaps` is a successful terminal state only because every unavailable entry and its reason remain explicit. Recovery points contain content, never principals, memberships, devices, invitations, revocations, authority changes, settings environments, or security audit.

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
- durable mutation attribution records the admitted principal and device at commit boundaries, without claiming character-level authorship;
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
- Revoked device or membership: remove new admission immediately, persist an idempotent authorization change, install it in the serialized vault mutation order, close affected sockets, and retain retry state until the vault runtime acknowledges the fence.
- Ownership transfer: require target acceptance, atomically swap the two membership roles through one multi-subject fence, and never expose zero or two owners.
- Lost mutation response followed by authority change: permit only exact committed-outcome lookup; never replay new work under stale or newly acquired authority.
- IndexedDB or bootstrap settlement failure: retain retry state; do not claim readiness.
- Unknown filesystem deletion baseline: preserve.
- Missing R2: disable attachments and recovery; continue Markdown root/body sync.
- Missing `RecoveryJob`: disable recovery; continue Markdown root/body sync.
- Recovery job retry/gap/failure: expose the state; do not report false completion.
- Diagnostics persistence failure: lose bounded diagnostics; continue sync.
- Settings authority/capability absent, settings format mismatch, local switch off, deferred choice, decision-required state without a durable consented queue, or detected clash: pause settings sync only; continue note sync. A crash during an already-consented take resumes only its exact principal/device authority queue before acceptance commits.
- Invalid settings JSON/hash/path, stale queue identity, or plugin-data version mismatch: quarantine or reject the settings item; never widen the allowlist or overwrite the held local value.
- Restricted/backgrounded/missing package installer: skip or durably pause the package step as specified; continue file LWW where safe.

The Docker server preserves this contract through the shared Node host; its volume, lifecycle, health, backup, and upgrade boundaries are defined in [operations](operations.md#docker-deployment). The headless client implements the Markdown subset described there. Large benchmark/soak, deployed Cloudflare behavior, broader real desktop settings/recovery, and all mobile settings/recovery claims are outside current evidence; see [QA](qa.md).
