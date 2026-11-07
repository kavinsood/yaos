# YAOS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

**A zero-terminal, real-time sync engine for Obsidian, powered by your own Cloudflare Worker.**

Your notes sync live across devices, with CRDT merge semantics instead of conflicted-copy workflows, delayed file sync, or database-heavy hosted services.

<img src="https://github.com/user-attachments/assets/ee937050-8a05-4d56-9c5f-3ae5003496fc" alt="YAOS syncing a note across desktop and mobile in real time" width="720" />

No terminal, no `.env` files, no database setup required.

[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

## How it compares

YAOS chooses live Markdown CRDT sync on infrastructure you deploy in your Cloudflare account. That gives fast cross-device editing, with explicit limits around durability receipts, attachments, empty folders, and non-Markdown plugin files.

| | Conflicts | Real-time | Deployment | No terminal | Free |
|---|:---:|:---:|:---:|:---:|:---:|
| **iCloud / Dropbox** | Conflicted copies | No | No | Yes | Yes |
| **Obsidian Sync** | Rare | Delayed | No | Yes | $96/yr |
| **Git / LiveSync** | Manual | Varies | Self-hosted / self-deployed | No | Yes |
| **Relay / Screengarden** | No | Yes | No | Yes | Freemium |
| **YAOS** | **CRDT merge** | **Yes** | **Self-deployed Cloudflare** | **Yes** | **$0** |

YAOS uses [Yjs CRDTs](https://yjs.dev) to keep one live vault state moving across devices instead of asking them to take polite turns uploading files and hoping nothing collides.

If you want the official, fully managed experience, pay for Obsidian Sync and support the team. If you want a fast, self-deployed, local-first alternative on your own Cloudflare account, welcome to YAOS!

## Get started

YAOS has two parts: an Obsidian plugin and a small Cloudflare server you deploy to your own account. The Worker setup page walks you through the remaining steps, so you don't need to memorize this.

<a href="https://youtu.be/xeS126_XK9Q">
  <img src="https://img.youtube.com/vi/xeS126_XK9Q/maxresdefault.jpg" width="480" alt="Watch the setup walkthrough" />
</a>

**1. Deploy your server**
Click **Deploy to Cloudflare** above. Cloudflare creates a Worker in your account.

**2. Claim your server**
Open the Worker URL. Click **Claim** to lock the server to you and generate your setup token.

**3. Install the plugin**
Install YAOS from the Obsidian Marketplace.

**4. Connect your vault**
From the claim page, open the setup link or scan the QR code. YAOS fills in the connection details automatically.

That's it. Your vault is syncing.

### Sync a separate vault on the same server

In an already connected vault, open **YAOS settings → Sync status → Set up a separate vault**. This generates a fresh vault ID and displays a QR code and setup links without changing the current vault.

Create or open the new local vault in Obsidian, install YAOS there, and use the generated setup link with that vault active. Save the link to connect additional devices to that same vault; opening **Set up a separate vault** again generates another independent vault ID. Use **Pair another device** instead when you want to sync the current vault on another device.

Treat setup links and QR codes like passwords. Vaults have separate sync data, but share the server token; this is not per-vault access control.

## Attachments and snapshots

Text sync works out of the box. To sync images, PDFs, and other attachments, add a Cloudflare R2 bucket — it takes about a minute.

<a href="https://youtu.be/Z7xCMEYfdFM">
  <img src="https://img.youtube.com/vi/Z7xCMEYfdFM/maxresdefault.jpg" width="480" alt="Watch the R2 setup video" />
</a>

R2 also enables daily automatic snapshots and on-demand point-in-time backups. You can browse snapshots, diff against current state, and selectively restore individual files. If you skip R2, text sync still works — you just won't have attachment sync or snapshots.

## Works with AI agents

Because Obsidian vaults are just local Markdown files, YAOS plays unusually well with scripts, CLI tools, and AI agents that edit files directly on disk. The CRDT state stays aligned with the filesystem, so changes from any source — git, shell scripts, agents writing to disk — propagate cleanly across devices instead of falling back to conflicted-copy workflows.

If you're building agentic workflows on top of Obsidian vaults, YAOS gives you the sync infrastructure so you don't have to wire up your own.

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: The server doesn't have a `YAOS_BUCKET` binding yet. See the [R2 setup video](https://youtu.be/Z7xCMEYfdFM).

**Cloudflare deploy/dashboard issues**: If build queue or dashboard behavior is flaky, see [operations](./docs/operations.md#troubleshooting), including the `wrangler.toml` R2-binding fallback.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening, and then raise an issue on GitHub.

**Diagnostics**: Use **Show sync debug info** for local inspection. Safe diagnostics exports redact server URL, vault ID, device name, and vault paths.

## License

[0-BSD](LICENSE)
