# Operations

## Deployment boundary

Schema 7, protocol 3, and control-plane identity format 3 form one breaking collaboration boundary. Older clients are rejected before partial synchronization, and schema-7 clients never open an older local cache.

For a fresh deployment:

1. preserve the ordinary vault files on at least one trusted device;
2. deploy and claim the current server;
3. save the operator recovery key and the one-use owner-bootstrap code;
4. enroll the trusted origin folder as the owner so its local files can enter schema 7;
5. use **Add my device** for another owner installation or **Invite person** for a collaborator.

An existing schema-6 deployment requires an operator-reviewed identity migration because old device records cannot reveal which devices belong to one person. Select the owner devices explicitly; they become one owner principal, while every ungrouped device becomes a separate full member principal. Settle or preserve old queued work, install the complete vault authority mirror, invalidate old tickets/sockets, and only then activate schema 7/protocol 3. Historical operations remain `legacy_unattributed`; migration never invents a person identity for them.

Do not manually reuse old plugin caches. Exact admission fails closed, but bypassing the guided migration can strand authority or settings state.

The Deploy button creates a detached deployment repository. Upstream changes do not update it automatically. After this breaking cutover, ordinary releases can use the generated repository's updater workflow so deployment and rollback remain Git-visible.

## Required Durable Object configuration

Every current deployment must bind all three Durable Object classes:

```toml
[[durable_objects.bindings]]
name = "YAOS_SYNC"
class_name = "VaultSyncServer"

[[durable_objects.bindings]]
name = "YAOS_CONFIG"
class_name = "ServerConfig"

[[durable_objects.bindings]]
name = "YAOS_RECOVERY_JOBS"
class_name = "RecoveryJob"
```

The migration history must include the SQLite recovery-job class:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultSyncServer", "ServerConfig"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RecoveryJob"]
```

`YAOS_RECOVERY_JOBS` and migration `v2` are part of the current deployment shape even when no R2 bucket is configured. Omitting either makes recovery unavailable and prevents safe generation purge when a configured bucket contains vault objects.

## Optional R2 capability

Markdown root/body sync, durable receipts, and bootstrap use Durable Object SQLite and require no R2 bucket.

To enable attachments and recovery, bind `YAOS_BUCKET`:

```toml
[[r2_buckets]]
binding = "YAOS_BUCKET"
bucket_name = "your-bucket-name"
```

Recovery is available only when both `YAOS_BUCKET` and `YAOS_RECOVERY_JOBS` exist. Capabilities report attachment and recovery availability separately from core sync.

All blob and recovery keys are scoped by both `vaultId` and `vaultGeneration`. Do not copy objects between generation prefixes or place unrelated objects under a YAOS generation prefix.

## Node server runtime

The Node 24 server uses the same schema-7 collaboration and sync domain runtimes as the Worker. Build with `npm run build:server-node`, then run:

```sh
YAOS_NODE_HOST=127.0.0.1 \
YAOS_NODE_PORT=8787 \
YAOS_NODE_DATA_DIR=/srv/yaos \
node packages/server-node/dist/server.mjs
```

The data directory contains the process lock, control-plane SQLite, generation-scoped vault and recovery-job databases, and immutable object storage. One process owns a data directory. Startup applies forward-only SQLite migrations and refuses databases written by a newer binary. `/health` reports process liveness; `/health/ready` reports storage, lock, migration, and drain readiness without exposing vault identity or paths.

Recovery alarms persist deadlines and dispatch leases. A process death resumes overdue work; three consecutive abandoned dispatch leases quarantine that job until the explicit retry command. Quarantined recovery work does not block note sync or server startup. Immutable object publication writes and flushes a sibling temporary file, atomically links it into place, and validates rather than overwrites an existing winner.

Retry only a quarantined alarm, with the server stopped so the command can take exclusive ownership of the same data directory. The exact syntax is `--retry-alarm <vault|recovery-job> <actor-name>`; use the actor kind and name printed by the quarantine log:

```sh
npm run build:server-node
YAOS_NODE_DATA_DIR=/srv/yaos \
node packages/server-node/dist/server.mjs \
  --retry-alarm recovery-job 'ACTOR_NAME_FROM_QUARANTINE_LOG'
```

The command clears quarantine and schedules another durable attempt; it does not run the server. Restart the server normally after it succeeds.

The public claim, enrollment, ticket, root/body, bootstrap, settings, attachment, recovery, and deletion contracts match the Worker.

## Docker deployment

`Dockerfile` packages the production Node host as a non-root, read-only-root-filesystem container. `compose.yaml` exposes port 8787, gives the process one persistent `yaos-data` volume at `/data`, drops Linux capabilities, and uses `/health/ready` for health checks.

For a local build:

```sh
YAOS_PUBLIC_ORIGIN=https://sync.example.com \
YAOS_BIND=127.0.0.1:8787 \
docker compose up --build -d
```

`YAOS_PUBLIC_ORIGIN` is the exact external `http(s)` origin placed into setup and enrollment responses. Set it when TLS terminates at a reverse proxy. It accepts no credentials, path, query, or fragment. The proxy must preserve `Host`, pass WebSocket `Upgrade`/`Connection` headers, disable response buffering for WebSockets, and forward traffic to container port 8787. YAOS does not trust forwarded-protocol headers.

Released images are published only under an exact repository release tag:

```sh
YAOS_IMAGE=ghcr.io/kavinsood/yaos-server:<version> \
YAOS_PUBLIC_ORIGIN=https://sync.example.com \
docker compose pull

YAOS_IMAGE=ghcr.io/kavinsood/yaos-server:<version> \
YAOS_PUBLIC_ORIGIN=https://sync.example.com \
docker compose up -d
```

Do not run two server containers against one volume. The second process fails with exit 17 rather than sharing SQLite and object ownership.

### Backup and restore

The named volume is the complete backup boundary. Stop the server before copying it so the SQLite databases, alarm leases, and immutable objects share one point in time:

```sh
docker compose stop server
docker run --rm \
  --mount type=volume,source=yaos-data,target=/data,readonly \
  --mount type=bind,source=\"$PWD\",target=/backup \
  node:24-bookworm-slim \
  tar -C /data -czf /backup/yaos-data.tgz .
docker compose start server
```

Restore only into an empty volume while the server is stopped:

```sh
docker compose down
docker volume rm yaos-data
docker volume create yaos-data
docker run --rm \
  --mount type=volume,source=yaos-data,target=/data \
  --mount type=bind,source=\"$PWD\",target=/backup,readonly \
  node:24-bookworm-slim \
  tar -C /data -xzf /backup/yaos-data.tgz
docker compose up -d
```

If `YAOS_DATA_VOLUME` overrides the volume name, use that exact name in backup and restore commands.

### Upgrade and rollback

Before changing an image tag, take a stopped-volume backup. Pull an exact new tag, start it, and wait for `/health/ready`. Storage migrations are forward-only. Rollback means stopping the new image and restoring the pre-upgrade volume backup before starting the old image; never point an old image at a volume already opened by a newer storage format.

Retry a quarantined alarm only with the service stopped:

```sh
docker compose stop server
docker compose run --rm server --retry-alarm recovery-job 'ACTOR_NAME_FROM_QUARANTINE_LOG'
docker compose start server
```

## Claim and vault provisioning

Open the fresh server URL and choose **Claim**. Save the operator recovery key; the server stores only its hash. Claim reserves a Personal vault, provisions its schema-7 SQL root in `awaiting_owner`, and returns a one-use owner-bootstrap code. The first successful owner enrollment and authority fence activate the vault. The operator identity controls deployment recovery and provisioning; it is not automatically a content principal.

Provisioning is a three-step saga: registry reservation, idempotent vault-runtime provisioning, then matching-generation activation. A partial failure remains in `provisioning` state with a retryable error and cannot admit devices as an active vault.

The operator console can create additional vaults through the same saga. Vault display names are not routing or storage identities.

## Enroll and operate devices

In an unenrolled folder, enter the server URL and a fresh setup code in YAOS or open its setup link. Enrollment returns a bearer plus the selected vault generation, principal ID, owner/member role, membership revision, device ID, credential revision, and fixed capability snapshot.

Every active vault has exactly one owner. Every other principal is a full member with the same read/write authority over the complete vault. Only the owner manages invitations, other people and devices, recovery, audit, vault policy/metadata, ownership transfer, and destruction. Permissions are fixed; there are no viewers, delegated administrators, folder ACLs, or custom toggles.

A principal represents one vault-scoped person; devices are separately revocable installations. **Add my device** issues a device-link code for the current principal. **Invite person** issues a member-invitation code that creates a new principal and first device. Codes expire after 15 minutes, work once, and cannot be substituted across purposes. Never copy one folder's bearer or IndexedDB cache to another.

Before enrollment, the client persists a random request ID, device ID, bearer, and code locally. The server stores only hashes and a bounded replay record, so a lost response retries the exact enrollment without creating a second device or principal. The owner-bootstrap enrollment carries origin-import authority; later invited/device-link folders join from SQL and never upload their disk as initial shared authority.

An enrolled person can inspect the member roster, rename their own profile and devices, revoke their own non-final device, add another device, or leave if they are a member. The owner can invite/remove members and manage every device. Revoking a member's final active device revokes that membership.

**Leave this vault** revokes the current member and all of their devices when reachable, stops sync, clears this folder's enrollment and schema-7 IndexedDB cache, and keeps ordinary files and configuration on disk. The owner cannot leave or revoke the final owner device. If the owner loses every device, the operator issues an audited one-use owner-recovery code; the operator does not become a vault participant.

Ownership transfer is offered by the current owner to one active member. The target must explicitly accept before one atomic authority fence changes the target to owner and the former owner to member. An unaccepted offer can be cancelled or expires; the vault never exposes zero or two owners.

Membership, device, and ownership changes stop new admission before the vault installs their durable fence. Active sockets for affected principals/devices close after installation. If a local operation belongs to an older membership or credential revision, YAOS preserves it as unpublished work and does not silently replay it under new authority. Exact committed-outcome lookup is only for recovering a lost response to work that already committed.

## Headless Linux client

The headless client requires Node 24 and a local Linux filesystem. Build it with `npm run build:cli`. Enroll each directory as a distinct device:

```sh
YAOS_HOST=https://sync.example.workers.dev \
YAOS_PAIRING_CODE=... \
node packages/cli/dist/yaos.mjs enroll /srv/vault

node packages/cli/dist/yaos.mjs daemon /srv/vault
```

The setup code is read from the environment, never argv. Enrollment persists a replay-stable request ID, generated device ID and bearer, vault generation, principal and membership revisions, device credential revision, role, fixed capabilities, server-minted names, and origin/import authority before the daemon starts. Default state lives under `XDG_STATE_HOME` or `~/.local/state/yaos/headless/`; `YAOS_STATE_DIR` is an explicit state-directory leaf override, not a parent directory. State directories are mode `0700`, credential/database files `0600`, and nothing is written inside the vault except user Markdown.

The daemon prints `YAOS_DAEMON_READY <vaultId>` only after bootstrap, origin import when applicable, provider sync, authoritative disk admission, and durable candidate/lifecycle settlement. Exit `2` is terminal identity/admission failure; exit `17` means another process owns that vault state. `SIGINT` and `SIGTERM` stop input, drain disk work and receipts, close SQLite, and release the lock.

Supported: Markdown, one daemon per local vault, external editor/Git changes, conservative conflict preservation. Unsupported: `.obsidian`, attachments, recovery UI, NFS/SMB/FUSE, and inferred rename identity. A filesystem rename deliberately synchronizes as delete plus create.

## Settings sync setup and operation

Settings sync is enabled by default for a newly enrolled device when the active authority includes `vault.settings.personal.sync` and the server advertises `settingsSync: true` with `settingsFormatVersion: 1`. Note sync remains independent. Open **Settings → YAOS → Obsidian settings sync** and verify the displayed configuration-folder key; it is the sanitized basename of the active Obsidian configuration directory and names an environment for the current principal. `.obsidian` and `.obsidian-mobile` do not share settings, and different vault members cannot read or mutate one another's environments.

On first contact, resolve the named environment before any pre-existing remote settings can apply:

1. If the environment is unseeded, choose **Seed from this device** to make this folder its initial authority. The create is atomic and fails if another device seeded first.
2. If an environment already exists, choose **Take the remote seed** to authorize it for this exact host/vault/generation/folder/device/configuration identity. YAOS persists the complete queue before applying it and commits acceptance only after the take completes.
3. Choose **Replace remote settings environment** instead when this device must replace the current principal's existing environment; replacement tombstones omitted synchronized plugins/themes and commits acceptance only after success.
4. Choose **Decide initial seed later** to withhold acceptance and leave settings unchanged while notes continue syncing.

After initialization:

- **Apply remote environment** explicitly applies the current remote files and package intents;
- **Replace remote settings environment** atomically makes this device's allowlisted snapshot current for this principal and tombstones synchronized plugins/themes omitted by this device;
- **Automatically install remote plugins and themes** separately consents to foreground package installation/removal and is off by default;
- per-plugin **Update**, **Promote pin**, and **Remove from settings environment** actions resolve the displayed three-version mismatch;
- selecting an environment plugin/theme removes it from that principal's synchronized state through a tombstone. Plugin removal attempts local disable/unload/uninstall and directory removal; theme removal deletes its local theme directory. Either may require restart when loaded state outlives removed files.

Do not enable another settings-sync product at the same time. YAOS pauses settings sync when official Obsidian Sync, Remotely Save, LiveSync, or System3 Relay is enabled; disable the clash and refresh YAOS. Turning **Sync Obsidian settings** off, deferring, a capability/version mismatch, or a clash affects settings only.

An explicit take/replace decision authorizes an apply plan, which is persisted before its first mutation and resumes from its checkpoint after restart for that exact identity. The acceptance marker is written only after successful seed/take/replace, so a crash during take resumes the already-consented queue first. Package installation pauses while Obsidian is backgrounded. Keep Obsidian in the foreground for install steps. Invalid inbound JSON, oversize entries, restricted community-plugin mode, desktop-only plugins on mobile, missing installer APIs, and individual install failures are reported without widening the allowlist; safe later steps continue.

The synchronized files are exactly the root JSON and CSS/plugin-data paths listed in the [settings contract](sync-contract.md#scope-storage-and-allowlist). `app.json` and `hotkeys.json` may require an Obsidian restart. Applying `workspaces.json` refreshes names but does not switch the current layout. Plugin and theme binaries are fetched from Obsidian/GitHub at their pinned versions and are never stored in the Worker, Yjs, or R2.

Leaving or replacing enrollment retires only that exact principal/membership/device/folder/configuration acceptance and apply queue. It does not delete local configuration files. Device or membership revocation makes later settings HTTP requests unauthorized. Ownership transfer leaves both principals' environments where they are. Destroying a vault makes settings inaccessible with the vault and removes its SQL sidecar only when the generation's vault deletion completes.

## Operator console

The operator recovery key signs in to the console and is never a plugin credential. The browser receives a short-lived HTTP-only session. Sign-out revokes the presented session before clearing its cookie.

The console creates/provisions vaults, performs the explicit schema-6 identity migration, issues owner-bootstrap or owner-recovery codes, reports provisioning failures, and tracks pending deletion and authorization-change obligations. The operator remains outside ordinary content presence and attribution. Failed vault authority fences stay retryable without restoring the revoked credential or membership.

Vault rename and ordinary destruction originate with the enrolled owner. A rename is replay-safe shared metadata and never renames local folders. Destruction is a durable owner request which does nothing until the operator confirms that exact request; confirmation then runs the existing R2-first, room-second purge workflow. The separately named emergency-destruction repair path requires a recorded reason and must not be used as a silent substitute for owner authorization. Final deletion removes vault-scoped identities, invitations, transfers, authorization changes, and security events while retaining the bounded governance outcome needed to make retries unambiguous.

## Recovery operations

With recovery capability available:

- **Take snapshot now** queues an asynchronous recovery-v2 capture;
- daily capture may queue when the client is connected and no capture is active;
- **Show recovery readiness and job status** reports projection, capture, and restore state;
- **Browse and restore snapshots** lists immutable recovery roots and looks up bounded manifest branches;
- restore can select Markdown paths, attachment paths, deleted identities, or the complete recovery point.

Capture and restore continue in alarm-driven `RecoveryJob` objects after Obsidian closes. `queued`, active phase, `retrying`, `complete`, `complete_with_gaps`, `failed`, and `cancelled` are meaningful states. Do not report a retry or terminal gap as complete coverage.

Before applying a restore item, the client creates a local backup and verifies that the target has not changed since review. Changed targets are skipped rather than overwritten. Body, lifecycle, and attachment mutations still pass through normal schema-7 actor authority, durable receipts, and attachment revision checks. Recovery contains content only; it cannot restore or roll back principals, memberships, devices, codes, transfers, revocations, audit, or settings.

Recovery roots and manifest/content objects are immutable. Recovery catalog deletion, retention, GC, and purge are asynchronous; UI completion means the corresponding durable state reached its terminal contract, not that another device has materialized anything.

## Vault deletion

Destroy differs from device leave:

1. the registry immediately revokes the vault, principals, memberships, devices, collaboration codes, and socket admission and records a `deletionId`;
2. the vault runtime fences sync and recovery work for the exact `vaultGeneration`;
3. with R2, the deterministic purge job empties only that generation's `recovery-v2/` and `blobs/` prefixes;
4. vault SQL is deleted only after generation purge succeeds;
5. the pending record remains visible and retryable until both phases complete.

Never force SQL deletion ahead of an incomplete R2 purge. SQL contains the authority needed to constrain cleanup to the right generation. Repeating destroy retries the same purge identity; it does not create a new generation.

Without R2, the purge phase is already complete and SQL cleanup can proceed. A pending vault ID remains unavailable for reuse.

## Authentication and version admission

Public setup routes are limited to claim, enrollment, and capability discovery. Vault HTTP routes require the device bearer in `Authorization` and the selected vault ID in the route.

The socket ticket endpoint exchanges that bearer for a short-lived protocol-3 ticket bound to the deployment, vault generation, principal/membership revision, device/credential revision, purpose, and exact document. Root and body sockets require:

- a valid ticket;
- document schema `7`;
- socket protocol `3`;
- active matching authority in both the control plane and vault mirror.

The complete version set is document schema `7`, durable SQL format `2`, socket protocol `3`, recovery snapshot format `2`, settings sync format `1`, and control-plane identity format `3`. These pins change only through a coordinated client/server/storage cutover.

## Updating after the schema-7 cutover

Establish the fresh deployment or complete the guided identity migration described above first. Do not activate schema 7 until every active vault has exactly one owner and its complete principal/device authority mirror is installed.

Future releases may use the generated deployment repository's updater only when their schema, storage, protocol, snapshot, and Durable Object class boundaries remain unchanged. A release changing any pin or required class must declare another fresh or guided cutover rather than relying on code-only revert.

## Operational checks

The Worker capability response distinguishes:

- claimed versus unclaimed state;
- attachment and recovery-job availability;
- server version;
- document schema, durable storage, socket protocol, snapshot format, and settings-format pins;
- settings-sync, attachment, and recovery capabilities.

The vault status surface additionally exposes `vaultGeneration`, `runtimeEpoch`, provisioning time, durable sequence, feed floor, active pins, current authority state, and preserved unpublished-work count. The public plugin API exposes immutable principal/role/capability, member-summary, per-device presence, and authority-revision facts without credentials or mutation controls. Health distinguishes degraded pending persistence from a healthy runtime. Diagnostics are evidence, not a repair mechanism.

## Troubleshooting

- **Unauthorized or auth rejected:** confirm that this principal membership and exact device credential are still active in the selected vault. Use a fresh purpose-correct code if revoked.
- **Authority changed:** queued work tied to the older membership/device revision is preserved locally. Refresh membership; do not relabel it as current work.
- **Owner lost every device:** sign in with the operator recovery key and issue an owner-recovery code. Do not create a replacement member or manually edit identity storage.
- **Invitation rejected:** confirm it is unexpired, unused, issued by the current owner revision, and used for **Invite person**, not **Add my device**.
- **Update required:** client schema or socket protocol does not exactly match the server. Do not attempt mixed-writer operation.
- **Vault provisioning failed:** retry the recorded provisioning saga; do not manually mark the registry record active.
- **Recovery unavailable:** confirm the `RecoveryJob` binding and `v2` migration exist. Recovery additionally needs `YAOS_BUCKET`.
- **Settings environment waits for a decision:** open the Obsidian settings-sync group and choose Seed, Take, or Decide later. A pre-existing remote environment never grants its own acceptance.
- **Settings sync paused for clash:** disable the named official/community settings-sync plugin, then refresh YAOS. Note sync is unaffected.
- **Settings format unsupported:** update the client/server pair; every settings route requires exactly one `settingsFormatVersion=1`.
- **Plugin data held:** make the installed manifest version, shared intent pin, and plugin-data version identical; use Update, Promote pin, or Remove. Do not copy `data.json` across versions.
- **Package install pending:** enable automatic package installation only if you consent, keep Obsidian foregrounded, and confirm community plugins are unrestricted. Install manually when the host API is unavailable.
- **Invalid settings JSON:** repair the named local/remote JSON and retry; quarantine intentionally keeps the local value rather than overwriting it.
- **Attachments unavailable:** add `YAOS_BUCKET`; Markdown continues without it.
- **Recovery job retrying:** inspect its status and bounded error code. Preserve the same job identity so durable progress can resume.
- **Vault cleanup pending:** retry from the console. Do not delete the vault Durable Object manually while generation purge is incomplete.
- **Bootstrap does not settle:** preserve the local cache and diagnostics; unresolved bodies are intentional retry state, not successful readiness.
- **Cloudflare dashboard instability:** make binding and migration changes in the generated deployment repository so the deployed configuration remains auditable.

## Current limits

- Empty folders are not synchronized.
- Attachment upload size is bounded by the server and client caps; publication operations survive response loss and restart.
- Root/body persistence is bounded by Durable Object SQL row, statement, and account limits.
- Server body admission enforces 32 bodies, a 48 MiB aggregate encoded-Yjs-state proxy budget, and a 16 MiB transient/pending reserve. Known cache pressure rejects the body WebSocket handshake with `429`, an exact count/encoded/transient reason, and `Retry-After: 1`; operators should treat it as backpressure rather than an internal failure. The proxy is not a server heap measurement. Client body admission enforces a separate 48 MiB aggregate estimated-cost budget. Only clean, unpinned bodies without open sockets may be evicted.
- Recovery requires R2 and the job binding and may finish with explicit unavailable entries.
- Settings environment key: 1–64 characters; no `.`, `..`, NUL, slash, or backslash. Settings paths: at most 256 characters and must match the closed allowlist without traversal.
- Settings bodies: at most 1,000,000 bytes each and 4,000,000 bytes total per environment. Snapshot requests are at most 6,000,000 bytes; item requests 1,500,000 bytes; GET responses 6,000,000 bytes.
- Settings counts per environment: 256 ordinary files, 256 plugin intents, 64 theme intents, 256 plugin-data rows, and 512 tombstones. IDs are at most 128 characters, repository strings 256, and version strings 64.
- Large benchmark/soak, deployed Cloudflare settings/recovery/deletion, broader desktop settings/recovery, and all real mobile settings/recovery evidence remain deferred.
- Network-filesystem support for headless clients remains future work.
