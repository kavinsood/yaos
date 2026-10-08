# YAOS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

**A zero-terminal, real-time sync engine for Obsidian, powered by your own Cloudflare Worker.**

YAOS syncs your Obsidian vaults live across your devices, with CRDT merging. It is built for one person. Each
server has one operator, and holds any number of vaults. Each device is paired with a one-time code and can be
revoked on its own.

<img src="https://github.com/user-attachments/assets/ee937050-8a05-4d56-9c5f-3ae5003496fc" alt="YAOS syncing a note across desktop and mobile in real time" width="720" />

No terminal, `.env` file, database setup, or R2 bucket is required for note sync.

[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

## How it compares

YAOS runs on infrastructure in your Cloudflare account. The server only relays changes; merging happens on your
devices.

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
2. **Install YAOS.** Install the plugin from Obsidian's Community plugins on each device.
3. **Create the vault in Obsidian.** On one device, run **YAOS: Create a new vault** and enter the Worker URL.
   - On a new server this claims it: save the operator recovery key it shows in your password manager. It is shown
     only once, and it is the only way to sign in to the console. It cannot be reset.
   - The vault and its encryption keys are made on this device. The server never makes a vault.
4. **Pair more devices.** On a device that is already paired, open YAOS settings and choose **Pair another device**.
   - On a phone, scan the QR code and tap **Connect Obsidian**.
   - On a computer, open YAOS settings, choose **Pair this device**, and enter the server URL and the code.
   - A code works once and expires after 15 minutes.

The operator recovery key opens the server console. It is not a device credential; never paste it into plugin
settings.

## One operator, vaults and devices

- **One operator.** The person who claims the server is its only operator, and the console at the Worker URL is
  theirs. YAOS has no members, invitations or roles. Every paired device can read and change its whole vault.
- **Vaults.** One server holds any number of vaults. Create each one in Obsidian with **YAOS: Create a new vault**;
  the console only lists, restores and deletes them. Each vault syncs on its own.
- **Lost every device?** **Pair a device** on the vault in the console gives a one-time code for that existing vault.
  An encrypted vault also needs its recovery key on the device.
- **Devices.** A device stays paired until you revoke it. **Devices** on a vault lists them.
  - **Revoke** cuts a device off at once: its connections close, and changes it had not yet synced are dropped. To
    use it again, pair it again.
  - Revoking cannot erase files already on that device.
- **Reset streams** deletes the vault's synced content on the server and starts it over. You must type the vault
  ID first. Devices stay paired and upload again from their files, and attachments are kept.
- **Delete vault** removes the vault, its devices and its attachments for good. You must type the vault ID first.

## Attachments (optional R2)

Notes sync through Durable Object storage and need no R2.

Images, PDFs and other non-note files sync through an R2 bucket bound as `YAOS_BUCKET`. The shipped
`server/wrangler.toml` binds a bucket named `yaos`. Without the binding:
- the server reports attachments as off;
- the console's header line says so;
- the server refuses attachment uploads;
- notes keep syncing.

Uploads are limited to 100 MB per file, Cloudflare's request size limit on the Free and Pro plans. Reset and restore keep attachments; deleting a vault removes them.

<a href="https://youtu.be/Z7xCMEYfdFM">
  <img src="https://img.youtube.com/vi/Z7xCMEYfdFM/maxresdefault.jpg" width="480" alt="Watch the R2 setup video" />
</a>

## Restore to a point in time

**Restore** in the console rewinds a vault's synced content to any moment in the last 30 days. It uses Cloudflare's
Durable Object point-in-time recovery.
- Device pairings stay as they are now: a restore rewinds content, never access.
- Unused pairing codes are cancelled.
- The vault gets a new epoch, which tells devices that the server content was replaced.
- Restore needs a deployed Worker. Local development (`wrangler dev`) has no point-in-time recovery, and the console
  says so.

Separately, each device can keep daily zip snapshots of its notes (YAOS settings, **Daily recovery snapshots**).

## Works with local tools

Obsidian vaults remain ordinary local files. Changes made by editors, scripts, Git tools, or agents enter the same reconciliation path and can synchronize across paired devices.

## Hosting: Cloudflare only

YAOS runs only on Cloudflare: one Worker with two Durable Object classes (a `VaultDO` per vault and one `ConfigDO` per server), plus an optional R2 bucket for attachments. There is no self-hosted Node or Docker server and no headless CLI client. The server core sits behind small storage, socket and clock ports so its tests run on Node; that is a test seam, not a hosting option.

The server is an opaque relay. It never interprets payloads, checkpoints, stream names or blob contents.

Moving from a pre-rewrite server is a fresh deployment, not an upgrade. There is no data migration: the deploy's Durable Object migration deletes the old classes (`VaultSyncServer`, `ServerConfig`, `RecoveryJob`) together with their stored data, the new server starts unclaimed, and each device re-seeds it from its local files.

## Troubleshooting

**YAOS: re-pair device.** The device was revoked in the console, or its vault was deleted. Pair it again with a new
code (**Pair this device**).

**Lost the operator recovery key.** The server stores only a hash of the key, so nobody can recover or reset it.
Paired devices keep syncing, but no one can sign in to the console.

**Restore says the server cannot restore.** Point-in-time recovery exists only on a deployed Worker, and only for the
last 30 days. A time outside that window is refused before anything changes.

**Restore incomplete.** The console shows this banner when a restore was interrupted. Pairing, revoking and
resetting that vault wait until it finishes. The server finishes it on its own within about a minute, or you can
press **Restore** to resume it now.

**YAOS: daily limit.** On the Workers Free plan, Durable Objects allow 100,000 rows written per day. Past that the
server refuses writes until the limit resets; the console shows the reset time.

**Attachments do not sync.** If the console's header line says attachments are off, add the `YAOS_BUCKET` R2 binding
and redeploy. Also check **Sync attachments** and **Maximum attachment size (MB)** in YAOS settings. The server
accepts at most 100 MB per file (Cloudflare's request size limit); an encrypted vault fits a little less, about 98.5 MB.

**Files not syncing.** Check **Excluded paths** in YAOS settings. Then use **Export diagnostics**, which saves a
file without note contents or credentials. If sync seems stuck, use **Rebuild local cache**.

## Engineering documentation

- [docs/server-rewrite/DECISIONS.md](./docs/server-rewrite/DECISIONS.md): the server design, including its route
  table.
- [docs/client-remake/relay-wire.md](./docs/client-remake/relay-wire.md): the wire contract that design amends (see
  its section 5).

## License

[0-BSD](LICENSE)
