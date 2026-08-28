# YAOS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

**A zero-terminal, real-time sync engine for Obsidian, powered by your own Cloudflare Worker.**

YAOS synchronizes Markdown live across devices with CRDT merge semantics. One server can host multiple vaults, and every enrolled folder has its own device identity.

<img src="https://github.com/user-attachments/assets/ee937050-8a05-4d56-9c5f-3ae5003496fc" alt="YAOS syncing a note across desktop and mobile in real time" width="720" />

No terminal, `.env` file, database setup, or R2 bucket is required for Markdown sync.

[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

## How it compares

YAOS runs on infrastructure in your Cloudflare account. Markdown content is split into independently loaded CRDT bodies rather than one vault-wide content document.

| | Conflicts | Real-time | Deployment | No terminal | Free |
|---|:---:|:---:|:---:|:---:|:---:|
| **iCloud / Dropbox** | Conflicted copies | No | No | Yes | Yes |
| **Obsidian Sync** | Rare | Delayed | No | Yes | $96/yr |
| **Git / LiveSync** | Manual | Varies | Self-hosted / self-deployed | No | Yes |
| **Relay / Screengarden** | No | Yes | No | Yes | Freemium |
| **YAOS** | **CRDT merge** | **Yes** | **Self-deployed Cloudflare** | **Yes** | **$0** |

If you want the official, fully managed experience, use Obsidian Sync. If you want a self-deployed, local-first alternative on your own Cloudflare account, YAOS is built for that.

## Get started

<a href="https://youtu.be/xeS126_XK9Q">
  <img src="https://img.youtube.com/vi/xeS126_XK9Q/maxresdefault.jpg" width="480" alt="Watch the setup walkthrough" />
</a>

1. **Deploy the server.** Click **Deploy to Cloudflare** above.
2. **Claim it.** Open the Worker URL, click **Claim**, and save the operator recovery key. Claiming provisions a Personal vault and returns a one-use pairing code.
3. **Install YAOS.** Install the plugin from the Obsidian Marketplace.
4. **Enroll this folder.** Open the setup link or scan the QR code. Each additional folder or device needs a fresh pairing code.

The operator key opens the server console. It is not a device credential and must not be pasted into plugin settings.

## Obsidian settings sync

Settings sync is enabled by default after enrollment and is independent of note sync. Before a pre-existing remote environment can change this folder, open **Settings → YAOS → Obsidian settings sync** and choose **Take the remote seed**, **Seed from this device**, or **Decide initial seed later**. The choice is stored for this exact enrollment, folder, device, and configuration-folder name. Use **Replace remote settings environment** only when this device should replace an existing seed.

YAOS synchronizes a closed allowlist of Obsidian JSON files, CSS snippets, community-plugin intents, theme intents, and version-matched plugin `data.json`. It does not store plugin or theme binaries; automatic package installation/removal requires separate explicit consent and is off by default. Settings state is stored in the vault Durable Object's SQLite sidecar, not Yjs or R2. Unsupported servers, an off switch, or a detected settings-sync clash pause settings only; notes continue syncing. See [operations](./docs/operations.md#settings-sync-setup-and-operation) for setup, limits, and recovery behavior.

## Attachments and recovery

Markdown uses Durable Object SQLite and works without R2. Add a `YAOS_BUCKET` R2 binding to synchronize images, PDFs, Canvas files, and other non-Markdown content and to enable asynchronous recovery points.

<a href="https://youtu.be/Z7xCMEYfdFM">
  <img src="https://img.youtube.com/vi/Z7xCMEYfdFM/maxresdefault.jpg" width="480" alt="Watch the R2 setup video" />
</a>

Recovery points can be captured in the background, browsed by path, and selectively restored. A deployment also needs the included `RecoveryJob` Durable Object binding and migration for this capability. See [operations](./docs/operations.md).

## Works with local tools

Obsidian vaults remain ordinary local files. Changes made by editors, scripts, Git tools, or agents enter the same reconciliation path and can synchronize across enrolled devices.

## Headless Linux client

The Node 24 CLI synchronizes Markdown in a local directory without Obsidian. It enrolls as its own vault-scoped device; credentials are generated and stored outside the vault rather than copied from another installation.

```sh
npm run build:cli

YAOS_HOST=https://sync.example.workers.dev \
YAOS_PAIRING_CODE=... \
node packages/cli/dist/yaos.mjs enroll /srv/vault

node packages/cli/dist/yaos.mjs daemon /srv/vault
```

The daemon is Linux/local-filesystem only, Markdown only, and single-process per vault. `.obsidian`, attachments, network filesystems, and rename-identity inference are intentionally outside its contract. See [operations](./docs/operations.md#headless-linux-client).

## Node server runtime

`packages/server-node` runs the same schema-4 control-plane, vault, settings, attachment, and recovery domain owners as the Cloudflare Worker over Node 24, SQLite, WebSockets, and filesystem object storage. It is verified against the Worker by the runtime-blind conformance suite. This is a Node process, not a Docker image or Docker-readiness claim.

See [operations](./docs/operations.md#node-server-runtime).

## Troubleshooting

**Unauthorized or auth rejected:** The folder's membership is missing, revoked, or belongs to another vault. Re-enroll with a fresh pairing code.

**Recovery unavailable:** Recovery needs both `YAOS_BUCKET` and the `YAOS_RECOVERY_JOBS` binding. Markdown sync remains available without R2.

**Cloudflare deployment issues:** See [operations](./docs/operations.md#troubleshooting), including the required Durable Object migration and R2 binding.

**Files not syncing:** Check exclusions and file-size limits, then use **Show sync debug info**. Safe exports redact the server URL, vault and device identity, credentials, and vault paths.

## Engineering documentation

The compact current source set is indexed in [docs/README.md](./docs/README.md).

## License

[0-BSD](LICENSE)
