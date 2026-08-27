# Operations

## Deployment boundary

Schema 4 is a breaking storage and cache boundary. It does not read or migrate schema-3 room state, snapshot-v1 objects, or schema-3 IndexedDB databases.

For the schema-4 cutover:

1. preserve the ordinary vault files on at least one trusted device;
2. deploy a fresh Worker/storage deployment from the current `server/`;
3. claim it and provision the first vault;
4. enroll the trusted origin folder with the first pairing code so its local files can enter schema 4;
5. enroll every joining folder with a distinct new pairing code and a fresh schema-4 local cache.

Do not point a schema-4 plugin at a schema-3 deployment or reuse a schema-3 plugin cache. Exact admission fails closed, but manually reusing storage bypasses the supported boundary.

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

## Claim and vault provisioning

Open the fresh Worker URL and choose **Claim**. Save the operator recovery key; the server stores only its hash. Claim reserves a Personal vault, provisions its schema-4 SQL root, activates the exact generation, and returns one pairing code.

Provisioning is a three-step saga: registry reservation, idempotent vault-runtime provisioning, then matching-generation activation. A partial failure remains in `provisioning` state with a retryable error and cannot admit devices as an active vault.

The operator console can create additional vaults through the same saga. Vault display names are not routing or storage identities.

## Enroll and operate devices

In an unenrolled folder, enter the Worker URL and a fresh pairing code in YAOS setup or open the setup link. Enrollment returns a `deviceToken`, `deviceId`, and selected `vaultId`.

Each folder/device identity belongs to exactly one vault membership. A physical installation may enroll different folders in different vaults, but every membership has its own device ID and bearer. Never copy one folder's token or IndexedDB cache to another.

The first claim pairing code carries a one-use origin-import role. Before enrollment, the client persists a random request ID, device ID, device token, and pairing code locally. The server stores only hashes and a bounded replay record, so a lost response retries the same enrollment and origin grant without creating a second device. Every later device/invite code is a joining role: joining folders bootstrap from SQL and never upload their disk as initial shared authority.

An enrolled device can inspect its vault roster, rename itself, mint another one-use pairing code, export only its own credentials, or leave. Pairing codes expire after 15 minutes and work once.

**Leave this vault** revokes the current membership when reachable, stops sync, clears this folder's enrollment and schema-4 IndexedDB cache, and keeps ordinary files on disk. If revocation fails, local leave still completes and the operator can remove the stale membership.

## Operator console

The operator recovery key signs in to the console and is never a plugin credential. The browser receives a short-lived HTTP-only session. Sign-out revokes the presented session before clearing its cookie.

The console creates and renames vaults, lists and revokes devices and unused pairing codes, creates enrollment links, reports provisioning failures, and tracks pending deletion and device-fence obligations. A failed device runtime fence remains visible after membership removal and can be retried without restoring membership.

## Recovery operations

With recovery capability available:

- **Take snapshot now** queues an asynchronous recovery-v2 capture;
- daily capture may queue when the client is connected and no capture is active;
- **Show recovery readiness and job status** reports projection, capture, and restore state;
- **Browse and restore snapshots** lists immutable recovery roots and looks up bounded manifest branches;
- restore can select Markdown paths, attachment paths, deleted identities, or the complete recovery point.

Capture and restore continue in alarm-driven `RecoveryJob` objects after Obsidian closes. `queued`, active phase, `retrying`, `complete`, `complete_with_gaps`, `failed`, and `cancelled` are meaningful states. Do not report a retry or terminal gap as complete coverage.

Before applying a restore item, the client creates a local backup and verifies that the target has not changed since review. Changed targets are skipped rather than overwritten. Body and lifecycle mutation still pass through normal schema-4 durable receipts.

Recovery roots and manifest/content objects are immutable. Recovery catalog deletion, retention, GC, and purge are asynchronous; UI completion means the corresponding durable state reached its terminal contract, not that another device has materialized anything.

## Vault deletion

Destroy differs from device leave:

1. the registry immediately revokes the vault, devices, and pairing codes and records a `deletionId`;
2. the vault runtime fences sync and recovery work for the exact `vaultGeneration`;
3. with R2, the deterministic purge job empties only that generation's `recovery-v2/` and `blobs/` prefixes;
4. vault SQL is deleted only after generation purge succeeds;
5. the pending record remains visible and retryable until both phases complete.

Never force SQL deletion ahead of an incomplete R2 purge. SQL contains the authority needed to constrain cleanup to the right generation. Repeating destroy retries the same purge identity; it does not create a new generation.

Without R2, the purge phase is already complete and SQL cleanup can proceed. A pending vault ID remains unavailable for reuse.

## Authentication and version admission

Public setup routes are limited to claim, enrollment, and capability discovery. Vault HTTP routes require the device bearer in `Authorization` and the selected vault ID in the route.

The socket ticket endpoint exchanges that bearer for a short-lived device- and vault-scoped ticket. Root and body sockets require:

- a valid ticket;
- document schema `4`;
- socket protocol `1`;
- an active membership and active vault generation.

The complete version set is document schema `4`, durable SQL format `1`, socket protocol `1`, and recovery snapshot format `2`. These pins change only through a coordinated client/server/storage cutover.

## Updating after the fresh schema-4 deployment

The schema-4 server artifact is marked `deploymentBoundary: fresh`; the in-place updater rejects it. Establish the fresh deployment described above first.

Future releases may use the generated deployment repository's updater only when their schema, storage, protocol, snapshot, and Durable Object class boundaries remain unchanged. A release changing any pin or required class must declare another fresh or guided cutover rather than relying on code-only revert.

## Operational checks

The Worker capability response distinguishes:

- claimed versus unclaimed state;
- attachment and recovery-job availability;
- server version;
- document schema, durable storage, socket protocol, and snapshot format pins.

The vault status surface additionally exposes `vaultGeneration`, `runtimeEpoch`, provisioning time, durable sequence, feed floor, and active pins. Health distinguishes degraded pending persistence from a healthy runtime. Diagnostics are evidence, not a repair mechanism.

## Troubleshooting

- **Unauthorized or auth rejected:** confirm that this exact device ID still has membership in the selected vault. Re-enroll with a fresh code if revoked.
- **Update required:** client schema or socket protocol does not exactly match the server. Do not attempt mixed-writer operation.
- **Vault provisioning failed:** retry the recorded provisioning saga; do not manually mark the registry record active.
- **Recovery unavailable:** confirm the `RecoveryJob` binding and `v2` migration exist. Recovery additionally needs `YAOS_BUCKET`.
- **Attachments unavailable:** add `YAOS_BUCKET`; Markdown continues without it.
- **Recovery job retrying:** inspect its status and bounded error code. Preserve the same job identity so durable progress can resume.
- **Vault cleanup pending:** retry from the console. Do not delete the vault Durable Object manually while generation purge is incomplete.
- **Bootstrap does not settle:** preserve the local cache and diagnostics; unresolved bodies are intentional retry state, not successful readiness.
- **Cloudflare dashboard instability:** make binding and migration changes in the generated deployment repository so the deployed configuration remains auditable.

## Current limits

- Empty folders are not synchronized.
- Attachment upload size is bounded by the server and client caps; publication operations survive response loss and restart.
- Root/body persistence is bounded by Durable Object SQL row, statement, and account limits.
- Server body admission enforces 32 bodies, 48 MiB aggregate resident state, and a 16 MiB transient/pending reserve. Client body admission enforces a separate 48 MiB aggregate estimated-cost budget. Only clean, unpinned bodies without open sockets may be evicted.
- Recovery requires R2 and the job binding and may finish with explicit unavailable entries.
- Large benchmark/soak, deployed Cloudflare recovery/deletion, and real mobile recovery evidence are deferred.
- Settings sync, headless clients, and Docker packaging remain future work.
