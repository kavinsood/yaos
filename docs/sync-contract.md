# Sync contract

Status: the user-facing guarantees of the plugin in `src/` and their limits, as of `sim-port` (2026-10-21). Every
statement here restates [DESIGN](client-remake/DESIGN.md) (section letters §x.y below), its invariants I1–I6
(§a) and the simulator's quiescence invariants (§l.3), or [e2ee-design](client-remake/e2ee-design.md). Where they
disagree, they win and this page is the bug. Known gaps are listed in §13, not hidden in the sections above it.

Terms: a **device** is one paired Obsidian vault folder. A **note** is a `.md` file, a **canvas** a `.canvas` file,
an **attachment** any other file. **Synced** means the relay committed the change and returned a receipt. The
**relay** is your Cloudflare Worker.

---

## 1. What is never lost

- **A local edit stays until the relay has it** (I1). Every edit enters a durable outbox in IndexedDB before it is
  sent, and leaves only on the relay's receipt (§e.2 `T_edit` / `T_receipt`). In the ≤ about 316 ms before that
  commit, the copy on disk is Obsidian's own save of the file (§d.4). Offline time, restarts and crashes do not
  drop outbox records; the outbox has no size limit and is never evicted (§e.3).
- **No file is destroyed without a recoverable copy** (I2). YAOS never deletes a file permanently. A remote delete
  moves the file to the system trash or the vault's `.trash`, per YAOS's **Deleted files go to** setting, which by
  default follows Obsidian's own; Obsidian's "Permanently delete" also goes to `.trash` (§h `TrashMode`). Every
  overwrite, rename and trash carries a precondition on the bytes it expects (§f.2); a conflicting overwrite writes a
  conflict copy first (§f.3, §f.7).
- **One device's bad update cannot spread** (I4). Every incoming row passes one gate; a body row that fails is
  quarantined and its note frozen, and the file on disk is left alone (§d.6). A malformed namespace frame folds as
  empty on every device.
- After the simulator heals its faults it checks exactly these (§l.3): every token typed into an editor or written
  to disk, and not removed by a later user action, is in the converged vault or a conflict copy; every file version
  that existed on any disk is in the vault, the trash, a conflict copy or a snapshot.

The exceptions are listed in §13: a conflict copy not yet written when the engine dies, Obsidian's own save
overwriting an external write before YAOS sees it, the non-atomic preconditions, and coalesced disk changes under a
concurrent delete.

## 2. Convergence

- Once every device is online and idle, all devices hold the same files, byte for byte (§l.3 1): same paths
  (compared by case-folded key on case-insensitive disks), same contents, same namespace state. Canvases converge as
  canonical JSON, not byte for byte: a file that differs only in formatting is not rewritten (§j.2).
- The namespace is a deterministic fold of the relay's log: the same log gives the same tree on every device (I3,
  §c). Nothing a writer sends is rejected; conflicts resolve inside the fold.
- Latency: an isolated edit reaches a peer in roughly the relay's leading-edge commit plus a round trip; sustained
  writes pace at about one commit per second per vault (integration-notes §5 "Latency"). The relay must be
  reachable; there is no peer-to-peer path.

## 3. Concurrent edits

| Case | Result |
|---|---|
| Two devices edit the same note | Merged character-wise by the note's Yjs document. Both edits survive. Concurrent edits inside one word can duplicate the word rather than interleave its letters (wp-d-notes "Concurrent edits interleaved inside words"). |
| An external program edits a note while YAOS also has remote changes for it | A line-level 3-way merge against the last synced text (§f.3). Non-overlapping changes merge; overlapping, differing changes keep the synced (CRDT) side in the note and put the whole disk text in a **conflict copy**. |
| No base is known (fresh device, recovered store) and the two sides differ | No-base conflict: the remote text keeps the path, the local text goes to a conflict copy (§f.3, §j.5). |
| Either side above 2 Mi characters, or the diff above its edit cap, and both sides changed | Not merged: conflict copy (`too-large`, §f.3). A change on one side only still applies. |
| Canvas | Different nodes and edges merge; the same record changed on both sides (or changed on one, deleted on the other) keeps the synced side and conflict-copies the disk bytes. Across devices, fields are last-writer-wins and a text node's text merges character-wise (§j.2). An invalid canvas file is never merged or overwritten. |
| Two devices change the same attachment | Keep both: the later one is conflict-copied to a new name and synced as a new attachment, and the winner's bytes take the original path (§c.8, example E8). |
| Two devices change the same setting | Last writer (in relay order) wins, per top-level JSON key or per whole file. No copy (§c.11). |

**Conflict copies** are named `<name> (conflict <device label> <YYYY-MM-DD HHmm>)<ext>` in the same folder, with
` 2`, ` 3`, … when taken (§f.7). They are ordinary files: they sync to every device, attachments included. Deleting
one is a normal delete. A burst of more than 200 conflict copies in one plan or 10 minutes is held by the brake (§5).

## 4. Names, moves and deletes

- **Same path, different files.** The first create in relay order keeps the path; later ones are renamed on their
  own device to `name (2).md`, `(3)`, … (§c.4). Links are not rewritten. A notice lists the renamed files.
- **Same path, same content** (two devices importing the same vault): merged into one file, no copy (§c.5, §c.13).
- **Case.** Paths compare case-insensitively everywhere, with frozen Unicode 15.1 case folding and NFC, even on
  case-sensitive disks (§c.2). All files under one folder share one folder casing; the newest case-only rename sets
  it.
- **Rename vs delete:** the rename wins, in either order (§c.6, §c.7, example E6).
- **Edit vs delete:** an edit the deleting device had not seen restores the file with that edit (§c.7, example
  E7). A local edit beats a remote delete; a remote edit beats a local delete (§f.2).
- **Concurrent renames** of one file: the last in relay order wins.
- **Not synced** (stay local, never deleted by YAOS): paths that are not portable (§c.2): any segment starting with
  `.`, the characters `\ * " < > : | ?`, control characters, Windows-reserved names (`con`, `nul`, `com1`, …), a
  segment ending in `.` or space, a segment over 255 bytes or a path over 1024 bytes. Also everything matched by
  **Excluded paths**. A non-portable file gets a notice.

## 5. Safety brake

Before a plan runs, the brake holds its destructive part when it looks like an accident (§f.5; thresholds in
`src/core/limits.ts`):

| Brake | Holds when |
|---|---|
| `listing-shrank` | The vault listing has under half the synced files (vault not mounted, folder moved): every destructive op |
| `mass-delete-local` / `mass-delete-remote` / `mass-overwrite` | More than max(50, 20 % of synced files) local deletes, remote deletes, or overwrites that shrink a file of ≥ 4 KiB below half |
| `conflict-flood` | More than 200 conflict copies |

Counts are per plan and per rolling 10 minutes, so a slow drip also trips it. The rest of the plan runs. The user
approves (a recovery snapshot is taken first when snapshots are on) or rejects (held remote deletes leave the files;
held local deletes are re-created). Approval applies only to the exact set of held ops it was shown.

## 6. Offline and the relay's limits

- Offline, everything keeps working locally; edits accumulate in the outbox and go out on reconnect: note bodies at
  once, namespace and settings frames only after the device has read those streams again (§d.7 "Reconnect order").
  Nothing destructive is planned until the namespace is caught up (§f.2).
- A device that comes back after files were deleted elsewhere: unchanged local copies go to the trash (braked);
  locally edited ones are restored with the edit (§f.2). A device offline long enough for the namespace to prune its
  tombstones (more than 20,000 deleted entries) handles its stale files the same way, re-creating edited ones as new
  files (§c.9).
- **Daily limit** (Workers Free: 100k rows written a day). When the relay refuses writes, sending stops until the
  reset, reads continue and edits keep filling the outbox (§i.6). The client paces itself before that (a daily frame
  budget per device class).
- **Revoked device.** The relay refuses it at once; the engine stops with "re-pair device" (§i.6). Edits it had not
  yet sent never reach the relay. They are still in its local files, and re-pairing imports those files as a fresh
  device (§j.5: identical files adopted, differing ones conflict-copied). Revocation cannot erase files already on
  the device.
- **Upgrade required.** A vault written by a newer YAOS stops only the affected part (namespace, settings or
  snapshots) and says "update required"; note bodies keep syncing (§c.10). Nothing is guessed under old rules.

## 7. Losing IndexedDB

IndexedDB is a rebuildable cache (§e). If it is lost or corrupt, or the user runs **Rebuild local cache**, the
engine rebuilds it from the relay, the files on disk and the side-file mirrors in
`<configDir>/plugins/yaos/state/` (§i.5):

- the outbox mirror restores unsent frames under their original ids, so they are deduplicated rather than
  duplicated;
- the synced mirror tells files unchanged since the last sync (adopted, no I/O) from files edited offline (merged);
  a file changed on both sides becomes a no-base conflict copy;
- without mirrors, recovery is a fresh-device onboarding: identical files adopted, differing ones conflict-copied.

Since identity-per-store phase 2, a lost store is replaced by a store with a new device identity, and the mirrors of
the lost one (under `state/<old deviceId>/`) are not imported yet (phase 3). Every IndexedDB loss therefore takes the
"without mirrors" path: a file edited offline gets a conflict copy instead of a merge, and deletes, renames and canvas
reorders that were not sent yet are lost with the store. Text is never lost (it is on disk).

Nothing is destroyed. Limits: base texts are not mirrored, so recovered files merge without a base when both sides
changed; a delete still waiting to be sent is remembered in the store only (`fileGone`), so a file re-created at
that path meanwhile merges into the old note as a save (integration-notes §5, D17). The frameNo collision IndexedDB
loss can cause is in §13.

## 8. Vault epoch reset (operator reset or restore)

Reset streams and point-in-time restore give the vault a new epoch (DECISIONS D8a, D8b). Each device takes a local
snapshot, then migrates (§c.12): it keeps the old store's synced texts as path-keyed merge bases, re-onboards
against the new epoch from its files, merges edits that were only in its store into the files first, and deletes
the old store once live. Differing files merge 3-way where a trusted base exists, else become conflict copies.
Pairings and attachments are kept.

Limit: the old outbox is dropped (its edits are on disk and re-derived), and a delete made in the old epoch is
re-applied only partly: canvas record deletes and deletes in docs whose ids survive a restore are replayed, but
Markdown text deleted before a reset can come back (§c.12 step 3 "Not carried").

## 9. Attachments

- Attachment bytes go only to the R2 bucket, sealed under E2EE when it is on; the log carries only the hash and
  size, and a reference is committed only after the bytes are stored (§j.1). Every download is verified by hash
  before it is written.
- Without an R2 binding (`YAOS_BUCKET`), attachments are not synced, silently on the client side; local files stay
  and are never deleted. Notes keep syncing.
- Files above the server's limit (100 MB; about 98.5 MB under E2EE) or the user's **Maximum attachment size** are
  not synced and never deleted; a notice says so. A note edit whose single update is too large to send without a
  blob store freezes that note (`oversize-local`, §b.6).
- Unused attachments are removed from R2 only by the manual command **Clean up unused server attachments**, a
  client mark-and-sweep with a 7-day grace that deletes nothing when in doubt (§j.1 GC).

## 10. Settings sync

Off by default (**Sync Obsidian settings**). It syncs an allow-list of the config folder (§j.3): the core JSON
settings files per top-level key, `community-plugins.json` as enable/disable per plugin, `plugins/<id>/data.json`,
`snippets/*.css` and `themes/<name>/{theme.css, manifest.json}`. Never: YAOS's own folder, `workspace.json` /
`workspace-mobile.json`, plugin code, caches, anything unlisted.

- Turning it on asks once whether the vault's or this device's settings win where both exist; nothing is deleted by
  that first pass.
- A plugin's `data.json` applies only when the local plugin version equals the writer's; plugin code is never
  installed by YAOS (a plugin enabled elsewhere but not installed here is held with a notice). Desktop-only plugins
  are not enabled on mobile.
- Paused while Obsidian Sync or a known sync plugin (Remotely Save, Self-hosted LiveSync, Relay) is enabled. Files
  over 1 MB, or past 256 files / 4 MB in total, are held. A change that needs an Obsidian reload shows a notice;
  YAOS never reloads Obsidian.
- Concurrent changes are last-writer-wins with no copy (§3), and changes are picked up on full passes and focus,
  not on file events.

## 11. Snapshots and restore

- With snapshots on (default), each device keeps a daily zip of its notes, canvases and attachments ≤ 1 MiB (7 by
  default), plus snapshots before brake approval, epoch migration, IndexedDB recovery and every restore (§j.4).
  Optional upload makes them restorable from any paired device.
- A restore verifies the whole snapshot first (parts, zip, paths, manifest, digest) and refuses a damaged one as
  `content_corrupt` with nothing written. It takes a safety snapshot, conflict-copies differing files, writes under
  preconditions, and syncs the result like any local edit (the brake applies).
- Operator point-in-time restore (30 days, deployed Workers only) rewinds the relay's content, never pairings; to
  devices it is an epoch reset (§8).

## 12. End-to-end encryption

With suite 1 (chosen when the vault is created, preselected on; e2ee-design §15) the relay and Cloudflare see
ciphertext only for contents, paths, names, settings and attachments; forged or altered rows are rejected; replayed
namespace and settings frames are rejected within an epoch. They still see stream counts, timing, device ids,
bucketed sizes and blob counts, and can withhold or roll back data (e2ee-design §2.2, §2.3). With no device left
that holds the key and no recovery key, the data is unrecoverable, by design (e2ee-design §13.3). A revoked device
keeps everything it already decrypted (e2ee-design §14.4). Local IndexedDB and files are plaintext.

## 13. Known limits

From [wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues",
[integration-notes.md](client-remake/integration-notes.md) §5 and DESIGN; open work is in [BACKLOG.md](BACKLOG.md).

- **Engine death loses an unwritten conflict copy.** A bind or reload conflict copy lives only in worker memory until
  written; if its write fails and the engine dies before a retry lands, it is gone (§d.2, §g.4). The sim counts these
  as `crashLost`.
- **Obsidian's save can overwrite an external write** before the watcher reports it; YAOS cannot see or prevent it
  (wp-d-notes "Harness: Obsidian clobber exemption").
- **Preconditions are not atomic.** Obsidian has no compare-and-swap. A same-length text change, or any binary
  change, not yet visible in the file's stat when YAOS writes can be overwritten (§f.2 "Missed"). Settings writes
  have no precondition at all: a settings file changed between YAOS's read and write is overwritten without a copy
  (integration-notes §5).
- **Coalesced disk changes are applied as minimal diffs.** Several writes seen as one change (app backgrounded,
  between scans) diff against the last text; if another device concurrently deletes the old text, characters the
  diff reused can go with it (wp-d-notes "Remaining: fault-heavy 825"; 53ed8089 replaces changed bracket groups
  whole).
- **Frozen notes can stay frozen.** A note with a quarantined row, or with a causal hole that three re-reads did not
  fill, stops syncing; its file is left alone and status shows "Needs attention" (§d.6). A causal-hole freeze lifts
  by itself once the missing row arrives and the hole closes (3a569113); a hole that never fills stays frozen. Rows
  quarantined for a reader-dependent reason (missing key, newer writer) are retried at every session start. Nothing
  else lifts a quarantine: the `releaseQuarantine` command DESIGN §d.6 describes exists in the protocol, but no
  command or button sends it (BACKLOG QUARANTINE-UI). **Rebuild local cache** starts the store over from the relay.
- **A copied or synced vault folder is a new device.** data.json holds only the pairing grant and the settings a copy
  may share; each IndexedDB store mints and registers its own device identity (identity-per-store §2-4), and the
  per-install fields (device label, status bar, a pending enrollment, the creation marker) live in Obsidian's
  per-vault-registration storage (§8). A copy of the vault folder on another machine, or opened as another vault on
  the same one, has its own store and identity, joins without a prompt, and syncs as a separate device; it never reads
  or writes the other store's mirror dir. YAOS says once when a fresh install finds another store's mirrors written in
  the last day (another tool syncs the folder; exclude `<configDir>/plugins/yaos/` from it, or two tools make
  conflicting copies). A copy counts against the pairing's limits (20 new stores a day, 50 live devices). Copying a
  vault over another one while that device still had a create in flight leaves the note waiting for its initial body
  until the abandoned store is retired (console "Remove device"; DESIGN §i.5 "Abandoned creates"). A grant copied with
  the folder is a credential: revoking the pairing revokes every copy.
- **A duplicated app profile is one device twice.** Copying Obsidian's app profile itself (macOS Migration Assistant,
  a Time Machine restore onto a second Mac) copies the IndexedDB store and its identity: two installs then run as one
  store, and each takes the other's changes for its own. Nothing detects it (identity-per-store decision 7, accepted;
  Obsidian Sync has the same exposure). Removing that device in the console makes each install register a store of its
  own (identity-per-store §4, "Store revoked by the server").
- **Deleted docs keep their body until pruned.** A deleted note's body (relay checkpoint and rows, each store's
  records) stays so a restore can bring it back (DESIGN §c.7). Once the namespace prunes it (past 20000 tombstones,
  §c.9), or for a merged alias, a device writes a `retired` checkpoint and the relay and every store reclaim it (§b.5,
  §d.9).
- **Epoch reset gaps** (§8): Markdown text deleted in the old epoch can return; the bind-time merge of a note open
  across the reset does not use the path base (two conflict copies where a 3-way merge was possible; nothing lost).
- **Fold digests are not compared.** A checkpoint that passes verification but is not the fold of its rows (a buggy
  writer, or a hostile key holder) is adopted without alarm (§b.5).
- **Sim coverage.** Some designed paths never fire in the simulator: malicious peer frames under suite 0, namespace
  pruning, targeted socket-close points, the conflict-flood brake, residency pressure (wp-d-notes "Sim coverage").
  They are covered by unit tests only.
- **Real devices.** The Obsidian adapters are tested against fakes; iOS and Android runs (worker start, IndexedDB in
  the worker, `setViewData` interception, SecretStorage) are manual and partly outstanding (wp-d-notes, e2ee-design
  §23.3). Whether the background flush on `pagehide` / `freeze` finishes before a mobile OS kills the app is
  unmeasured (§i.4, timer-audit F5).
- **Resource pressure.** `memory-pressure` is declared but never raised; residency budgets are enforced only by LRU
  eviction of clean documents (§d.1).
