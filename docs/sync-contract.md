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
| Obsidian settings | Allowlisted paths and package intents in a named, bounded SQL environment |

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
- Named settings environments live in a SQL sidecar inside the vault Durable Object. They are not part of the root/body Yjs documents, attachment objects, or recovery R2 objects.

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

## Settings environments

### Scope, storage, and allowlist

Settings scope is the vault plus `configDirKey`, the sanitized basename of `app.vault.configDir`; there is no user principal. The key must be 1–64 characters and cannot be `.`, `..`, contain NUL, `/`, or `\`. Folder names such as `.obsidian` and `.obsidian-mobile` therefore select distinct named environments in the same vault.

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

An explicit take/replace decision and its complete apply plan precede the first disk or package mutation. Queue and later acceptance identities are exactly `hostHash + vaultId + vaultGeneration + folderKey + deviceId + configDirKey`; records with any other identity never authorize or resume work. The acceptance marker commits only after successful seed/take/replace, while a crash during take resumes the already-consented queue before that marker exists. The runner checkpoints the first unexecuted step after every attempt, resumes the same ordered plan at startup, pauses when its runtime generation is inactive, and clears only after all steps complete. A malformed record is not executed. Individual quarantined or failed steps are reported and skipped so later steps can proceed; a crash before checkpoint replays the current idempotent step.

A full take/manual apply orders: ordinary root JSON except `appearance.json`/`workspaces.json`; CSS snippets; `appearance.json`; theme installs; `appearance.json` again when themes were installed; plugin installs; version-gated plugin data; plugin enabled/disabled state; plugin/theme tombstones; then `workspaces.json`. This keeps workspace activation out of the apply path; a missing or newly changed local manifest still holds plugin data until a later gate sees all three versions equal.

Stopping the runtime waits for the serialized settings operation, removes watchers/timers, and restores the exact Obsidian installer hooks. Re-enrollment and **Leave this vault** retire only the old membership's exact apply queue and acceptance and clear deferral; configuration files remain on disk. Device revocation blocks subsequent bearer requests. Vault destruction makes the environment inaccessible immediately and removes the settings sidecar when that generation's vault SQL is deleted.

Settings sync starts only after enrollment, exact `settingsSync=true` capability, and `settingsFormatVersion=1`. Its HTTP route requires the current device bearer and selected vault; the public router supplies trusted device/vault/generation authority to the vault runtime and does not forward the bearer. Exactly one format declaration is required. If capability is absent, format is incompatible, the local switch is off, initialization is deferred, or a decision is still required with no durable consented queue, settings mutation/watch loops do not run and note sync remains unaffected.

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
- Settings capability absent, settings format mismatch, local switch off, deferred choice, decision-required state without a durable consented queue, or detected clash: pause settings sync only; continue note sync. A crash during an already-consented take resumes its exact queue before acceptance commits.
- Invalid settings JSON/hash/path, stale queue identity, or plugin-data version mismatch: quarantine or reject the settings item; never widen the allowlist or overwrite the held local value.
- Restricted/backgrounded/missing package installer: skip or durably pause the package step as specified; continue file LWW where safe.

Headless clients and Docker packaging are outside the current contract. Large benchmark/soak, deployed Cloudflare behavior, broader real desktop settings/recovery, and all mobile settings/recovery claims are outside current evidence; see [QA](qa.md).
