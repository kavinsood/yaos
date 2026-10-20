# Operations

How to deploy, run and update the YAOS server. The user-facing setup is in the root [README](../README.md); the
server's design, route table and storage schema are in [DECISIONS](server-rewrite/DECISIONS.md) (cited as D*n*,
H*n* and §*n* below); the wire contract is [relay-wire](client-remake/relay-wire.md).

## What runs

One Cloudflare Worker (`server/`, entry `server/src/worker.ts`) with two Durable Object classes and an optional R2
bucket:

| Binding | Class / resource | Holds |
|---|---|---|
| `YAOS_VAULT` | `VaultDO`, one per vault (`idFromName(vaultId)`) | The vault's epoch and ticket key, its devices, pairing codes and every stream row and checkpoint (§6.1). |
| `YAOS_CONFIG` | `ConfigDO`, one per server (`idFromName("config")`) | The operator key hash, operator sessions, the vault registry and the restore journal (§6.3). |
| `YAOS_BUCKET` | R2 bucket (optional) | Attachments and other blobs, under `v/<vaultId>/<address>` (D9). |

- **One operator, any number of vaults.** The person who claims the server is its only operator. There are no
  members, invitations or roles (D1; [collaboration.md](collaboration.md)).
- **Opaque relay.** The server stores and forwards sealed frames, checkpoints and blobs. It never interprets
  payloads, stream names or blob contents, and never merges: merging runs on the devices.
- **Cloudflare only.** There is no Node, Docker or self-hosted server and no headless CLI client. The server core
  sits behind small storage, socket and clock ports so its tests run on Node; that is a test seam, not a hosting
  option.

## Deploying

**Deploy button.** The README's **Deploy to Cloudflare** button deploys `server/` into a new repository in the
user's account. The new server starts **unclaimed**. `server/.env.example` is intentionally empty: the Deploy flow
turns any assignment in it into a secret prompt, and YAOS needs none.

**By hand.** From `server/`: `npm ci`, then `npm run deploy` (`wrangler deploy`). `npm run dev` runs `wrangler dev`
locally (real workerd, local DO SQLite).

**`server/wrangler.toml`** is the deployment shape:

- the `YAOS_VAULT` and `YAOS_CONFIG` Durable Object bindings;
- migrations `v1`, `v2` (the pre-rewrite classes), `v3` (deletes them and their data: `VaultSyncServer`,
  `ServerConfig`, `RecoveryJob`) and `v4` (adds `VaultDO` and `ConfigDO`). Keep all four: Cloudflare applies only
  the tags a Worker has not seen. They are two tags because the API counts a migration's new classes before its
  deletions against the account's 500-namespace cap (error `10067`); an account at the cap deploys with `v3` alone
  first, then with `v4` (§9 P5);
- the R2 binding `YAOS_BUCKET` to a bucket named `yaos` (see Attachments);
- `observability.logs` on;
- a `Text` rule that bundles `qrcode-generator`'s browser build into the console page.

**Claiming.** The first **YAOS: Create a new vault** in Obsidian against an unclaimed server sends `POST /claim`
with a new operator recovery key. One request initializes the first vault, claims the server (operator, vault and a
session) and returns an owner pairing code (D5). The key must be at least 32 characters; the server keeps only its
SHA-256, so it cannot be recovered or reset. On a claimed server, Create a new vault signs in with the key and
creates the vault through the operator routes (`src/host/ui/createVault.ts`). The console never claims a server or
creates a vault.

## The operator console

`GET /` on the Worker URL. Sign in with the operator recovery key: the session is an HttpOnly, Secure,
SameSite=Strict cookie that lasts 7 days, and 20 failed logins a minute answer `429 too_many_attempts`. Operator
JSON routes require `Content-Type: application/json` and a same-origin `Origin`. Per vault the console offers:

- **Pair a device:** a one-use pairing code (55 characters, `<vaultId>.<secret>`), its QR code and an
  `obsidian://` link. A code expires after 15 minutes (D3). This is also the way back in when every device is lost;
  an encrypted vault then also needs its recovery key on the device.
- **Devices:** the paired devices and **Revoke**. A revoke deletes the device in one turn: its unsent frames are
  dropped, its sockets get `authority_superseded` and close 4403, and its bearer and tickets get `401` from then on
  (D7). Revoking cannot erase files already on the device.
- **Reset streams:** behind the typed vault ID. Deletes every stream row and mints a new epoch; devices stay paired
  and re-upload from their files; attachments are kept (D8a).
- **Restore:** rewinds the vault's synced content to a point in the last 30 days with Durable Object
  point-in-time recovery. Device pairings stay as they are now, unused codes are cancelled, and the vault gets a new
  epoch (D8b). The restore is journaled in the config DO; an interrupted one shows **Restore incomplete**, holds that
  vault's pairing, revoke and reset, and is finished by an alarm within about a minute or by pressing Restore
  again. `wrangler dev` has no point-in-time recovery and answers `501 restore_unsupported`.
- **Delete vault:** behind the typed vault ID. Closes sockets, deletes the vault DO's storage, purges the vault's R2
  prefix and then the registry row. An incomplete purge answers `503 purge_incomplete` and can be retried.

## Attachments (R2)

Notes, canvases, the namespace, settings and the snapshot index ride the Durable Object streams and need no R2.
Attachments, oversized updates, large settings files and snapshot parts upload as blobs to `YAOS_BUCKET`.

- Without the binding, capabilities report `attachments: false`, blob routes answer `503 attachments_unavailable`,
  the console's header says attachments are off, and notes keep syncing.
- A blob upload is at most 100 MB (`maxBlobUploadBytes`), Cloudflare's request-body limit on the Free and Pro plans;
  it needs a `Content-Length` and streams to R2 unbuffered (D9).
- Keys carry no epoch, so reset and restore keep attachments; deleting a vault removes them.
- Devices garbage-collect unreferenced blobs through the list and conditional-delete routes (D9 "GC routes"),
  limited to 60 requests a minute per vault.

## Limits and tuning

- **Workers Free daily limit.** Durable Objects may write 100,000 rows a day on the Free plan. Past it the server
  refuses writes with `cf_daily_limit` (`503` with `Retry-After` on HTTP; a typed control frame on the socket) until
  00:00 UTC (H3, `server/src/dailyLimit.ts`). The client spreads its writes under that budget (DESIGN §d.9
  "Budget"); the Workers Paid plan removes the limit.
- **Sockets.** At most 4 per device (a fifth closes the device's oldest with 1001 `device_socket_limit`) and 1000 per
  vault (`429 stream_socket_limit`) (H6).
- **Requests.** A checkpoint is at most 4 MiB; 20 failed enrolls a minute per vault answer `429
  too_many_attempts`.
- **Variables** (`[vars]` in `wrangler.toml`; all optional):
  - `YAOS_TICKET_TTL_MS`: streams ticket lifetime (default 5 min, D4);
  - `YAOS_STREAMS_*` (`GC_IDLE_MS`, `GC_MAX_MS`, `GC_MAX_BYTES`, `GC_MIN_INTERVAL_MS`, `GC_LEAD_MS`, `GC_QUIET_MS`,
    `RATE_BYTES_PER_SEC`, `BURST_BYTES`, `MAX_SOCKETS`): the relay's group commit, per-device rate and socket cap
    (`readStreamRelayConfig`, `server/src/streams/relay.ts`). Every knob that delays a commit is clamped to 5 s;
  - `YAOS_DEBUG_ROUTES = "1"`: enables `POST /vault/:id/debug/simulate-daily-limit`. Test deployments only.

## Updating

Releases are tagged builds of this repository (`.github/workflows/release.yml`). `npm run build:server-release`
(`build-server-release.mjs`) writes `dist/release-assets/yaos-server.zip`: the server's `src`, `scripts`, package
files, `tsconfig.json`, `.gitlab-ci.yml` and `wrangler.toml`, plus a `yaos-server-manifest.json` with the server
version (`server/src/version.ts`, which must equal `server/package.json`) and the paths an update owns.

A deployed repository updates itself through the **YAOS Server Ops** workflow (`server/.github/workflows/yaos-ops.yml`,
calling `.github/workflows/yaos-ops-reusable.yml`) or the manual jobs in `server/.gitlab-ci.yml`:

- **update** runs `server/scripts/update-from-release.mjs`: it downloads the latest (or a named) release zip,
  replaces the update-owned paths, never touches `.github/`, warns when the deployment's `wrangler.toml` bindings
  drift from the release's, and commits `yaos(server): update to <version>`. A Worker connected to the repository
  (as the Deploy button sets up) redeploys from that commit.
- **revert** runs `server/scripts/revert-last-update.mjs`: `git revert` of the last such commit.

**Fresh-deployment boundary.** The release manifest built from this tree says `deploymentBoundary: "fresh"`, and the
updater refuses such a release. Moving from a pre-rewrite server is therefore a new deployment, not an update:
`v3` deletes the old classes with all their data, the new server starts unclaimed, and each device re-seeds the
vault from its local files. Keep the vault's files on at least one trusted device before switching.

## Cloudflare Access

The plugin sends no Cloudflare Access headers (no service-token support), so an Access policy on the Worker's
hostname blocks devices. The console is protected by the operator key and its session cookie; device routes by the
device bearer, streams tickets and pairing codes.

## Development relays

`scripts/relay-dev/start-local.sh` runs `wrangler dev` with a local R2 bucket for the client e2e harness and
`scripts/relay-dev/deploy.sh` deploys a named test Worker (`yaos-relay2-*`) on a test bucket. Both are maintainer
tools: their headers document the options, and they assume the maintainer's paths and `cf` CLI session.

## Troubleshooting

Device-side symptoms (re-pair, lost operator key, restore refused or incomplete, daily limit, attachments, files not
syncing) are in the README's Troubleshooting section. Server-side:

- **`409 vault_generation_mismatch`:** the vault's epoch changed (reset or restore). Devices migrate on their own
  (DESIGN §c.12).
- **`503 restore_in_progress` / `restore_incomplete`:** a restore has not finished; see Restore above.
- **`401` on every device route after a delete or revoke:** expected. An unknown vault also answers `401`, so the
  server is no oracle for which vaults exist.
- **Logs:** Workers observability logs are on (`wrangler tail`, or the dashboard). A refused WebSocket upgrade logs a
  `scriptThrewException` in the vault DO; it is noise (DECISIONS O13).

Open server items (unexplained slow receipts, the restore journal with no cancel, Free-plan CPU, PITR after
delete) are in [BACKLOG](BACKLOG.md) §4.
