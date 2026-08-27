# Operations

## Deploy and claim

Use the repository's **Deploy to Cloudflare** button. It targets `server/`, provisions the Worker and Durable Object bindings, and starts unclaimed. Visit the Worker URL and choose **Claim**.

Claiming creates three separate things:

- an operator recovery key, which you must save and which opens the server console;
- a Personal vault with a server-generated `vaultId`;
- a one-use pairing code for the first Obsidian folder.

The server stores a hash of the operator key, not the key itself. The claim page returns the pairing link and QR code once; the pairing code expires after 15 minutes and cannot be reused. The default deployment is Markdown-only and needs no secret environment variable.

### Optional R2

To enable attachments and snapshots, create an R2 bucket and bind it as `YAOS_BUCKET`. If the dashboard cannot add the binding, add this to the generated deployment repository's `wrangler.toml` and push:

```toml
[[r2_buckets]]
binding = "YAOS_BUCKET"
bucket_name = "your-bucket-name"
```

Capabilities refresh dynamically after deployment.

## Enroll and operate devices

In an unenrolled Obsidian folder, open **YAOS settings → Setup**, enter the Worker URL and a fresh pairing code, then choose **Enroll**. A setup link performs the same exchange. `POST /enroll` consumes `{pairingCode, deviceName}` and returns the folder's `deviceToken`, `vaultId`, `deviceId`, and display `name`.

The plugin persists the complete enrollment as `host`, `deviceToken`, `vaultId`, and `deviceId`. Each device has a distinct ID and bearer token; never copy one enrolled folder's credentials into another. To add a device, use **Pair another device** or the server console and consume a new one-use code.

Opening a setup link or entering a code while the folder is already enrolled always requires explicit confirmation, even for an empty folder. The confirmation names the destination server because every local note will become eligible to sync there. After successful enrollment, YAOS best-effort revokes the old device membership and clears its folder cache and receipt candidate before storing the new identity; a failed old-server revocation remains visible in that server's console for operator cleanup.

An enrolled device can:

- show and refresh the vault's device roster;
- rename itself;
- create another one-use pairing code;
- export only its own device credentials;
- leave the vault.

**Leave this vault** revokes the current device when the server is reachable, clears this folder's enrollment and folder-scoped IndexedDB cache, stops sync, and keeps ordinary files on disk. If server revocation cannot complete, local leave still completes and the operator can kick that membership from the console.

## Operator console

Open the Worker URL and sign in with the operator recovery key. The browser receives a short-lived HTTP-only session cookie; the recovery key is not a device credential and does not belong in plugin settings.

Signing out revokes the presented operator session in server storage before clearing the cookie. A copied session cookie cannot continue authorizing console operations after successful logout.

The console can create, rename, and destroy vaults; list and kick enrolled devices; mint or revoke unused pairing codes; and configure the deployment repository used by the updater. Add-device and invite codes have the same authority: either enrolls a full peer on the selected vault.

Destroying a vault is different from leaving or kicking a device. It first removes the vault and all memberships from admission, then attempts to delete its Durable Object storage and R2 prefix. Partial cleanup is stored as a retryable obligation and returns a pending result rather than false success; the console exposes retry until both stores complete. The console requires typing the vault nickname before enabling the initial action.

## Authentication and admission

Public setup routes are narrowly scoped:

- `POST /claim` accepts `{operatorRecoveryKey}` only while unclaimed;
- `POST /enroll` accepts `{pairingCode, deviceName}` and consumes that code once;
- `GET /api/capabilities` reports `claimed`, attachment/snapshot availability, size and version metadata, and the exact schema version.

Vault HTTP routes use `Authorization: Bearer <deviceToken>` and the vault ID in the path. `POST /vault/:vaultId/auth/ticket` exchanges that bearer for a short-lived ticket tied to the device and vault.

WebSocket admission at `/vault/sync/:vaultId` requires both `ticket` and `schemaVersion`. Membership is rechecked on every handshake, so leaving or operator revocation invalidates even a ticket that has not expired. Missing credentials, missing schema declaration, or a schema mismatch fail closed before sync room admission.

## Update an existing deployment

The Deploy button creates a detached repository. Upstream pushes do not update it automatically.

Git is the update boundary because the generated deployment already owns the Worker configuration. Re-running initial deployment can create a new project path; server self-mutation would require Cloudflare credentials. Applying a release artifact as an ordinary repository commit keeps deployment and rollback visible without either risk.

1. Set the generated deployment repository URL in the operator console or YAOS settings.
2. Run **Initialize updater** once if the repository lacks the workflow.
3. Run **Open update action** and choose update or revert.
4. Cloudflare deploys the resulting repository commit.

Update metadata uses patch semantics so one device cannot clear established server configuration with empty values.

## Local development

```sh
npm install
cd server && npm install && cd ..
npm run build
npm run test:ci
```

Run the unclaimed Worker directly when needed:

```sh
cd server
npm run dev
```

Open the local Worker URL to claim it, then enroll every live client with a distinct one-use pairing code.

## Manual deployment

```sh
cd server
npm install
npm run deploy
```

## Schema updates

Client and server currently admit exactly schema 3. A schema bump requires coordinated updates to:

- `src/sync/schema.ts`;
- `server/src/version.ts`;
- `scripts/guard-schema-version.mjs`.

Exact admission is deliberate: a writer using an incompatible CRDT shape can corrupt shared state. Do not deploy a mixed writer fleet. Admission rejects absent or mismatched schema declarations with `update_required`.

Schema 4 and settings sync are not shipped behavior.

## Release gates

```sh
npm run build
npm run typecheck:tests
npm run typecheck:qa
npm run test:ci
npm run lint
npm run guard:production-bundles
npm run guard:no-tracked-generated-artifacts
npm run guard:no-any
```

`test:ci` runs regression suites and the separately accountable local Wrangler integration driver. The driver claims the server, enrolls device-scoped clients, and covers exact schema admission, provider connection, sequential sync, snapshots, hardening, ticket refresh, and socket admission.

Real-device and external-deployment evidence is separate; see [QA](qa.md) and [BACKLOG](BACKLOG.md).

## Troubleshooting

- **Unauthorized/Auth rejected:** confirm this folder is still in the selected vault's roster. Re-enroll with a fresh code or ask the operator to mint one.
- **Pairing code rejected:** codes work once and expire after 15 minutes. Mint a new code; do not retry one consumed by another enrollment.
- **R2 not configured:** add `YAOS_BUCKET`; Markdown remains available without it.
- **Cloudflare build/dashboard instability:** retry once, then commit the binding/configuration through the generated repository. Record the failed deployment commit SHA in any issue.
- **Files not syncing:** check exclusions, file-size limits, connection status, and diagnostics.
- **Server receipt waiting:** reconnect and allow the folder-scoped local cache to load. A receipt is latest-state confirmation, not other-device delivery.

## Current limits and next block

- Each vault is one vault-wide Yjs document in its own room.
- Empty folders are not synchronized.
- Attachment upload cap is 10 MB by default.
- Text persistence is bounded by SQLite row/statement limits and the checkpoint/journal policy.
- Server memory is bounded by the 128 MB isolate and CRDT struct growth.
- Per-vault storage accounting and limits, broader operator recovery, and sharding are next-block work.
- Native Windows, headless clients, Docker packaging, `.obsidian` settings sync, and schema 4 are not current behavior.
