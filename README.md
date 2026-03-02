# YAOS

Real-time, shared-state sync for Obsidian.

YAOS is not a timer-based file mover. It treats your vault as collaborative state: markdown edits are CRDT operations, not delayed file copies, so open notes update across devices immediately and merge without last-write-wins conflicts.

Obsidian already has an excellent paid sync product, and for most people it is the best "just works" option. YAOS exists for the narrower case where you want a self-hosted, local-first setup with the same core property that matters most: when you type on one device, the other device should reflect shared state, not eventually notice that a file changed.

That design choice is the whole point. Git, cloud drives, timer-based sync plugins, and even tools like Syncthing are fundamentally moving files around. YAOS is built around the idea that note-taking feels better when sync behaves like a live collaborative editor while still preserving a normal local Obsidian vault on disk.

For the deeper design rationale and recent hardening work, see **[ENGINEERING.md](ENGINEERING.md)**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos)

## Why YAOS exists

Most alternatives solve a different problem:

- **Git** is great for deliberate commits, not tiny note edits across devices all day
- **Cloud drive clients** replicate files, but they do not understand shared editing state
- **Many sync plugins** scan, upload, and sleep; they are file movers running on a timer
- **Syncthing** gets closer to real-time, but it is still syncing files, not collaborative state

Those tools can absolutely be good enough, and for some people they are the right tradeoff. YAOS exists because there is a real difference between "my files eventually converge" and "my note is shared state right now."

## Features

- **Real-time sync** — Changes propagate instantly over WebSocket
- **Conflict-free** — CRDT-based merging, not last-write-wins
- **Offline-first** — Full offline support with IndexedDB persistence; syncs when reconnected
- **Attachment sync** — Images, PDFs, and other files sync via R2 object storage (optional)
- **Snapshots** — Daily automatic + on-demand backups to R2 with selective restore
- **Remote cursors** — See where collaborators are editing (optional)
- **Mobile support** — Works on Android/iOS with reconnection hardening

## Performance

The production bundle is currently about **235 KB raw / 69 KB gzipped** — small enough to stay invisible at startup.
It keeps that footprint by externalizing Obsidian and CodeMirror, so the shipped code is just the sync engine: Yjs, persistence/network bindings, fast diffing, and snapshot compression.

## Requirements

- Obsidian 1.5.0+
- A sync server (see [Server setup](#server-setup))
- For attachment sync / snapshots: an R2 bucket bound to the server

## One-click self-hosting

The default **Deploy to Cloudflare** button above gives you the fastest supported path:

- It deploys the Worker from this repo to your Cloudflare account.
- The default deploy is **text sync first**. No R2 bucket is required up front.
- On first visit to the deployed URL, the server starts in **unclaimed** mode and shows a small setup page.
- That page generates a token in the browser and gives you an `obsidian://yaos?...` setup link you can open on desktop or mobile.

Later, if you want attachments and snapshots, add an R2 binding named `YAOS_BUCKET` in the Cloudflare dashboard and redeploy. The same deployed Worker will begin reporting those features as available.

## Installation

### Manual install (recommended for personal use)

1. Download `yaos.zip` from the [latest release](https://github.com/kavinsood/yaos/releases).

2. Create the plugin folder in your vault:
   ```
   <vault>/.obsidian/plugins/yaos/
   ```

3. Extract `yaos.zip`, then copy `main.js`, `manifest.json`, and `styles.css` into that folder.

4. Restart Obsidian, then enable the plugin in **Settings → Community plugins**.

To update: download the latest `yaos.zip` and replace the old plugin files.

### Build from source

```bash
git clone https://github.com/kavinsood/yaos.git
cd yaos
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## Configuration

After enabling, go to **Settings → YAOS**:

| Setting | Description |
|---------|-------------|
| **Server host** | Your server URL (e.g., `https://sync.yourdomain.com`) |
| **Token** | Paste the token from the YAOS setup link (or from a manual `SYNC_TOKEN` override if you use one) |
| **Vault ID** | Unique ID for this vault (auto-generated if blank). Same ID = same vault across devices. |
| **Device name** | Shown in remote cursors |

### Optional settings

| Setting | Description |
|---------|-------------|
| **Exclude patterns** | Comma-separated prefixes to skip (e.g., `templates/, .trash/`) |
| **Max file size** | Skip files larger than this (default 2 MB) |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **External edit policy** | How to handle edits from git/other tools: Always, Only when closed, Never |
| **Sync attachments** | Enable R2-based sync for non-markdown files |
| **Show remote cursors** | Display collaborator cursor positions |
| **Debug logging** | Verbose console output |

Changes to host/token/vault ID require reloading the plugin.

## Commands

Access via command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Reconnect to sync server** | Force reconnect after network changes |
| **Force reconcile** | Re-merge disk state with CRDT |
| **Show sync debug info** | Connection state, file counts, queue status |
| **Take snapshot now** | Create an immediate backup to R2 |
| **Browse and restore snapshots** | View snapshots, diff against current state, selective restore |
| **Reset local cache** | Clear IndexedDB, re-sync from server |
| **Nuclear reset** | Wipe all CRDT state everywhere, re-seed from disk |

## Snapshots

Snapshots are point-in-time backups of your vault's CRDT state, stored in R2.

- **Daily automatic**: A snapshot is taken automatically once per day when Obsidian opens
- **On-demand**: Use "Take snapshot now" before risky operations (AI refactors, bulk edits)
- **Selective restore**: Browse snapshots, see a diff of what changed, restore individual files
- **Undelete**: Restore files that were deleted since the snapshot
- **Pre-restore backup**: Before restoring, current file content is saved to `.obsidian/plugins/yaos/restore-backups/`

Requires R2 to be configured on the server.

## Mobile (Android/iOS)

The plugin works on mobile with some considerations:

- **Reconnection**: Automatically reconnects when the app resumes from background
- **Battery**: Reduce "Concurrent transfers" in settings to lower battery use during attachment sync
- **Large vaults**: Initial sync may take longer; subsequent syncs are incremental
- **Offline**: Full offline editing works; changes sync when back online

If sync seems stuck after switching networks, use "Reconnect to sync server" from the command palette.

## Server setup

The plugin needs the YAOS Cloudflare Worker server. See **[server/README.md](server/README.md)** for:

- Local development setup
- The default Deploy to Cloudflare flow
- Manual `wrangler` deploys on your own Cloudflare account
- Post-deploy R2 setup for attachments and snapshots
- Optional `SYNC_TOKEN` override for local dev or power users
- Server-side limits and hardening behavior

YAOS is intended to be self-deployed. Your server host, custom domain, and R2 bucket name can be whatever you control; the names shown in the docs are examples, not required identifiers.

## How it works

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content
2. Today, those per-file `Y.Text` values live inside one shared vault-level `Y.Doc`, which keeps collaboration simple and fast for normal-sized note vaults
3. Local markdown filesystem events are coalesced by path and drained into the CRDT at I/O speed, so bursty create/modify storms do not trigger one import per event
4. Live editor edits flow through the Yjs binding to that shared document
5. One vault maps to one Durable Object-backed sync room, so the shared state survives server restarts
6. Offline edits are stored in IndexedDB and sync on reconnect
7. Attachments sync separately via content-addressed R2 storage instead of being forced through the text CRDT
8. Daily and on-demand snapshots exist as a safety net, not as the primary sync mechanism

In practice, that means:

- your vault still exists locally as normal files
- Obsidian keeps behaving like Obsidian
- YAOS keeps the disk mirror and the shared CRDT state aligned instead of asking devices to take polite turns uploading files later

## Releasing

Releases are automated. To cut a release:

```bash
npm version patch  # or minor/major
git push --follow-tags
```

The workflow builds and attaches `yaos.zip` to a GitHub Release.

## Limits and tradeoffs

YAOS is optimized for personal or small-team note vaults, not for arbitrarily huge filesystem trees.

- It currently keeps one shared `Y.Doc` for the vault, which keeps collaboration simple but gives the design a large-vault memory ceiling.
- Tombstones are retained on purpose so stale clients do not resurrect deleted files.
- Blob sync is intentionally conservative: a little less throughput is preferable to a more complex scheduler with harder-to-debug failure modes.

If you want the detailed architecture and the reasoning behind these tradeoffs, read **[ENGINEERING.md](ENGINEERING.md)**.

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: The server does not have a `YAOS_BUCKET` binding yet. See the server README for setup.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

## License

[0-BSD](LICENSE)
