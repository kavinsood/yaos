# Legacy parity: the old client against the new one

This document lists every user-facing feature of the old YAOS client, says where the feature lives in the new client
(`src/`), and records what was decided about it. It is the checklist for "nothing the old client did was lost by
accident". Every decision is either a port, an implementation done for parity (with its commit), a deliberate drop
(with its reason), or a gap that is still missing.

## Notation

- `adfa7a7:src/<path>:<line>` is the old client at commit `adfa7a7`, the last commit before it was deleted in
  `ee31181`. Read it with `git show adfa7a7:src/<path>`. Root files of that tree are cited as `adfa7a7:styles.css`,
  `adfa7a7:package.json` and `adfa7a7:yaos-plugin-api.d.ts`.
- A plain `src/<path>:<line>` is the new client at HEAD. The lines were checked at `3003810`.
- `DESIGN §x.y` is a section of `docs/client-remake/DESIGN.md`. Sections are cited by name, not by line.
- In a Legacy or New cell, a bare `:<line>` after a citation refers to the same file as the citation before it.

## Decision values

| Value | Meaning |
|---|---|
| `ported` | The new client already had the feature, or an equivalent, before this parity work. The form can differ (a notice instead of a settings row, an automatic step instead of a command). |
| `implemented (<commit>)` | Added to the new client during the parity work, in that commit. |
| `dropped: <reason>` | Left out on purpose. The reason is a DESIGN section or a short explanation. |
| `missing: <why / size>` | Not in the new client, and either wanted or not yet decided. |
| `TBD-D` | A wave-2 item that another change is still working on. The row is filled in when that change lands. |

## Summary

<!-- summary:start -->
(counts are filled in at the end)
<!-- summary:end -->

## 1. Settings sync and its allowlist

The old client synced a whole plugin and theme "environment", with seed and replace decisions and optional plugin
installs. The new client syncs per-key registers (`cfg`, DESIGN §j.3). It has no environment, so the environment
controls have no counterpart.

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| "Sync Obsidian settings" toggle | adfa7a7:src/settings/settingsTab.ts:575 | src/host/ui/settingsTab.ts:186-193 | ported |
| Settings sync default | adfa7a7:src/settings/settingsStore.ts:130 (on) | src/host/ui/api.ts:54 (off) | ported (off is kept on purpose, so nothing syncs until the seed question is answered) |
| Root JSON allowlist (the 14 core settings files) | adfa7a7:src/sync/settingsSync/allowlist.ts:3-18 | src/engine/settings/allowlist.ts:20-35 | implemented (97a9651) |
| Files never synced (workspace.json, workspace-mobile.json, file-recovery.json, publish.json, types.json) | adfa7a7:src/sync/settingsSync/allowlist.ts:20-27 | src/engine/settings/allowlist.ts:12-15 | ported |
| CSS snippets | adfa7a7:src/sync/settingsSync/allowlist.ts:47-50 | src/engine/settings/allowlist.ts:10, :64 | ported |
| Themes | adfa7a7:src/sync/settingsSync/apply.ts:282 (installed from the catalog), :478 (uninstall) | src/engine/settings/allowlist.ts:10 (theme.css and manifest.json are copied as files); src/engine/settings/cfgPlan.ts:303 (removal) | ported (the mechanism is new: files, not a catalog install) |
| Plugin data.json | adfa7a7:src/sync/settingsSync/allowlist.ts:51-55 | src/engine/settings/allowlist.ts:9; src/engine/settings/cfgPlan.ts:285 | ported |
| data.json version gate | adfa7a7:src/sync/settingsSync/dataJsonGate.ts:14 | src/engine/settings/allowlist.ts:100; src/engine/settings/cfgPlan.ts:305-307 | ported |
| Version-mismatch notice ("settingsSync hold ... Update plugin") | adfa7a7:src/sync/settingsSync/apply.ts:364-368 | src/engine/settings/cfgNotices.ts:15, :66; src/engine/settings/cfgSync.ts:168-169 | implemented (59c7bea) |
| Plugin skip list (yaos, yaos-qa-harness); YAOS never overwrites itself | adfa7a7:src/sync/settingsSync/types.ts:17; adfa7a7:src/sync/settingsSync/apply.ts:305 | src/engine/settings/allowlist.ts:38 | ported |
| Files that must never be written | adfa7a7:src/sync/settingsSync/apply.ts:30 | src/engine/settings/allowlist.ts:64 (closed allowlist) | ported |
| Community plugin enablement | adfa7a7:src/sync/settingsSync/pluginIntent.ts:17-26 (install intents; community-plugins.json itself unsynced at adfa7a7:src/sync/settingsSync/allowlist.ts:23) | src/engine/settings/allowlist.ts:36; src/engine/settings/cfgPlan.ts:241 | ported (the mechanism is new: enable or disable per plugin id, installed plugins only) |
| Plugin enabled elsewhere but not installed here | adfa7a7:src/sync/settingsSync/apply.ts:301 (installs it) | src/engine/settings/cfgPlan.ts:266 ("not-installed" hold); src/engine/settings/cfgNotices.ts:114-115 (notice) | implemented (59c7bea) as a hold with a notice; the install itself is dropped: DESIGN §m.2 (plugin install/update flows) |
| Desktop-only plugins held on mobile | adfa7a7:src/sync/settingsSync/apply.ts:309-312; adfa7a7:src/sync/settingsSync/pluginIntent.ts:61 | src/engine/settings/cfgPlan.ts:266; src/engine/compose/vaultRuntime.ts:219 | implemented (13068c6, 66c8a4c) |
| "Automatically install remote plugins and themes" setting | adfa7a7:src/settings/settingsStore.ts:131; adfa7a7:src/settings/settingsTab.ts:667; adfa7a7:src/sync/settingsSync/obsidianPluginInstall.ts:46 | MISSING | dropped: DESIGN §m.2 (plugin install/update flows) |
| Plugin uninstall | adfa7a7:src/sync/settingsSync/apply.ts:423 | MISSING | dropped: plugin code is never synced (DESIGN §j.3; src/engine/settings/allowlist.ts:12-13) |
| Per-mismatch Update / Promote pin / Remove rows | adfa7a7:src/settings/settingsTab.ts:687-707 | MISSING | dropped: version-mismatch list UI; the notices cover it |
| Environment plugin and theme rows | adfa7a7:src/settings/settingsTab.ts:708-721 | MISSING | dropped: no environment model (DESIGN §j.3) |
| Per-file size cap (1 MB) | adfa7a7:src/sync/settingsSync/types.ts:2; adfa7a7:src/sync/settingsSync/apply.ts:262-265 | src/engine/settings/cfgPlan.ts:183-187 | implemented (59c7bea) |
| Total cap (256 files, 4 MB) | adfa7a7:src/sync/settingsSync/types.ts:3, :7 | src/engine/settings/cfgPlan.ts:97-114 | implemented (59c7bea) |
| Invalid JSON is not applied | adfa7a7:src/sync/settingsSync/apply.ts:267 | src/engine/settings/cfgPlan.ts:245 ("unparseable" skip); src/engine/settings/cfgNotices.ts:17 | ported |
| Restart/reload notice after a settings write | adfa7a7:src/sync/settingsSync/apply.ts:643-649 (app.json and hotkeys.json only, :34) | src/engine/settings/cfgPlan.ts:200; src/engine/settings/cfgSync.ts:194; src/host/pluginController.ts:33 | implemented (a0031d0); asking on every JSON write is kept on purpose |
| "Restart required" settings row | adfa7a7:src/settings/settingsTab.ts:682 | MISSING | dropped: the reload notice replaces it (a0031d0) |
| Clash pause (Obsidian Sync, Remotely Save, Self-hosted LiveSync, Relay) | adfa7a7:src/sync/settingsSync/clash.ts:1-10; adfa7a7:src/sync/settingsSync/engine.ts:198-201; adfa7a7:src/settings/settingsTab.ts:672 | src/engine/settings/clash.ts:12-16, :41, :49; src/engine/settings/cfgSync.ts:157-159 | implemented (59c7bea) |
| First-enable seed: "seed from this device" or "take the remote seed" | adfa7a7:src/sync/settingsSync/engine.ts:212-222, :343, :363; adfa7a7:src/settings/settingsTab.ts:601, :624 | src/host/ui/settingsTab.ts:43-64, :372-376; src/protocol/messages.ts:43; src/engine/settings/cfgSync.ts:166 | implemented (13068c6, 4b8ca1a) |
| "Decide initial seed later" | adfa7a7:src/settings/settingsTab.ts:647 | src/host/ui/settingsTab.ts:43-64 (closing the question leaves settings sync off) | implemented (4b8ca1a) |
| First pass on a new device does not let an empty view win | adfa7a7:src/sync/settingsSync/engine.ts:1085 (probeBlank) | src/engine/settings/cfgSync.ts:161-163; src/engine/compose/vaultRuntime.ts:219 | implemented (66c8a4c) |
| "Apply remote environment" and "Replace remote settings environment" buttons | adfa7a7:src/settings/settingsTab.ts:592, :656 | MISSING | dropped: per-key projection is automatic, and there is no environment (DESIGN §j.3) |
| Settings sync state rows (config-folder key, state, environment, pending apply queue) | adfa7a7:src/settings/settingsTab.ts:580-590 | MISSING | dropped: no environment model; skips surface as notices |
| "Ignored unknown configuration files" list | adfa7a7:src/sync/settingsSync/allowlist.ts:74; adfa7a7:src/settings/settingsTab.ts:677; adfa7a7:src/sync/settingsSync/status.ts:15 | MISSING | dropped: unknown root JSON list (coordinator decision) |
| Server capability check for settings sync | adfa7a7:src/sync/settingsSync/engine.ts:160 | MISSING | dropped: settings ride the stream protocol, so there is nothing to probe |
| Apply only while Obsidian is in the foreground | adfa7a7:src/sync/settingsSync/engine.ts:425-432; adfa7a7:src/sync/settingsSync/apply.ts:206-210 | MISSING | dropped: foreground-only settings apply (coordinator decision) |
| Change detection | adfa7a7:src/sync/settingsSync/watch.ts:10 (2 s poll), :11 (data.json debounce) | src/engine/settings/cfgSync.ts:91-139 (a snapshot of the config folder on every settings pass) | ported (the cadence is new: full passes and focus) |

## 2. Commands and the command palette

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| "Reconnect to sync server" | adfa7a7:src/commands.ts:34 | MISSING (src/host/ui/commands.ts:42 "Restart sync engine" is the manual recovery) | dropped: reconnecting is automatic (online, visible, resume; DESIGN §i.4) |
| "Force reconcile vault with sync state" | adfa7a7:src/commands.ts:45 | src/host/ui/commands.ts:32 ("Sync now (full rescan)") | ported |
| "Use semantic sync for active Canvas" / "Use attachment sync for active Canvas" | adfa7a7:src/commands.ts:56, :67 | MISSING | dropped: every .canvas is a canvas stream; there is no attachment mode to switch to (DESIGN §j.2) |
| "Import untracked files now" | adfa7a7:src/commands.ts:79 | src/host/ui/commands.ts:32 (every full scan imports new files) | ported |
| "Reset local cache (re-sync from server)" | adfa7a7:src/commands.ts:99 | src/host/ui/commands.ts:40; src/host/ui/engineActions.ts:18 | ported |
| "Nuclear reset (wipe sync state and reseed from disk)" | adfa7a7:src/commands.ts:216 | src/host/ui/commands.ts:40 ("Rebuild local cache"); src/host/ui/engineActions.ts:18 | ported |
| "Take snapshot now" | adfa7a7:src/commands.ts:108 | src/host/ui/commands.ts:38 | implemented (f236cbe) |
| "Show recovery readiness and job status" | adfa7a7:src/commands.ts:118 | MISSING | dropped: the snapshot browser replaces it |
| "Browse and restore snapshots" | adfa7a7:src/commands.ts:128 | src/host/ui/commands.ts:39 | implemented (f236cbe) |
| "Cleanup old snapshots (apply retention policy)" | adfa7a7:src/commands.ts:138 | src/engine/snapshots/snapshotJob.ts:139, :228 (retention runs after every snapshot) | ported |
| "Resume interrupted restore" | adfa7a7:src/commands.ts:147 | MISSING | dropped: interrupted restore resume; a restore takes a safety snapshot first, so running it again is safe |
| "Export portable vault backup" | adfa7a7:src/commands.ts:157 | MISSING | dropped: the vault is plain files, and "Create snapshot now" writes a zip |
| "Settings sync: apply remote environment" / "replace remote environment with this device" | adfa7a7:src/commands.ts:166, :174 | MISSING | dropped: no environment model (DESIGN §j.3) |
| "Settings sync: seed from this device" / "take the remote seed" / "decide initial seed later" | adfa7a7:src/commands.ts:182, :190, :198 | src/host/ui/settingsTab.ts:43-64 (asked when settings sync is turned on) | implemented (4b8ca1a) |
| "Settings sync debug: install calendar via Obsidian" | adfa7a7:src/commands.ts:206 | MISSING | dropped: DESIGN §m.2 (plugin install/update flows) |
| Export debug trace, and with file names | adfa7a7:src/telemetry/installTelemetryRuntime.ts:253, :258 | src/host/ui/commands.ts:33-34 ("Export diagnostics", "... (include file names)") | implemented (5d42e55) |
| Clear debug trace | adfa7a7:src/telemetry/installTelemetryRuntime.ts:263 | MISSING | dropped: DESIGN §m.2 (telemetry and observability); the event ring lives in memory only |

The new client also has commands that the old one did not: pause and resume (src/host/ui/commands.ts:30-31), review
held changes (:35), pair this device (:36), pair another device (:37), and restart the sync engine (:42).

## 3. Status bar and UI

### 3.1 Status bar

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| Status bar item added on load | adfa7a7:src/main.ts:822 | src/host/ui/registerUi.ts:109 | ported |
| Connection labels (Disconnected, Loading, Connecting, Connected, Offline) | adfa7a7:src/status/statusBarController.ts:36-50 | src/host/ui/statusBar.ts:64-125 (starting, downloading, catching up, synced, syncing, offline, paused) | ported |
| Auth failures (server unclaimed, misconfigured, format unsupported, auth rejected) | adfa7a7:src/status/statusBarController.ts:51-67 | src/host/ui/statusBar.ts:143-147 ("re-pair device"), :158-163 (error with its code) | ported |
| "Update required" | adfa7a7:src/status/statusBarController.ts:68-70 | src/host/ui/statusBar.ts:153-157 | ported |
| "Local storage error" | adfa7a7:src/status/statusBarController.ts:71-73 | src/host/ui/statusBar.ts:58-63 ("stopped (error)") | ported |
| Transfer status suffix | adfa7a7:src/status/statusBarController.ts:78 | src/host/ui/statusBar.ts:167-169 (queued, pending disk writes and pending attachments, in the tooltip) | ported |
| "N files need attention" | adfa7a7:src/status/statusBarController.ts:82-83 | src/host/ui/statusBar.ts:170-176 | ported |
| "Server not saving" | adfa7a7:src/status/statusBarController.ts:89-90 | MISSING | dropped: the server receipts a frame only after it commits it, so unsaved work shows as unsynced changes (DESIGN invariant I1) |
| Daily-limit label | adfa7a7:src/status/statusBarController.ts:94-95 | src/host/ui/statusBar.ts:133-137 | ported |
| "Recovery ..." suffix | adfa7a7:src/status/statusBarController.ts:97-98 | MISSING | dropped: recovery-job UI (the snapshot browser replaces it) |
| Resource-pressure suffix | adfa7a7:src/status/statusBarController.ts:100-101 | MISSING | dropped: DESIGN §m.2 (runtime coordinators); per-class budgets replace residency pressure (src/core/limits.ts:170) |
| Server receipt label | adfa7a7:src/status/statusBarController.ts:121-144 | src/host/ui/statusBar.ts:167 (queued and awaiting-receipt counts in the tooltip) | ported |
| Tooltip | adfa7a7:src/status/statusBarController.ts:178 | src/host/ui/statusBar.ts:184, :284 | ported |

New only: a click opens the held-changes review or the settings (src/host/ui/statusBar.ts:235-238), and the item can
be hidden (src/host/ui/statusBar.ts:270-275; setting at src/host/ui/settingsTab.ts:280).

### 3.2 Notices

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| "Join this folder with a server URL and pairing code." on load when not enrolled | adfa7a7:src/main.ts:849 | MISSING (the status bar says "not paired", src/host/ui/statusBar.ts:57) | dropped: "Join this folder" notice (coordinator decision) |
| Unencrypted HTTP warning | adfa7a7:src/main.ts:857-870 | src/host/ui/pairing.ts:128 (http is refused except on loopback) | ported (stricter: refused, not warned) |
| Initialization failure | adfa7a7:src/main.ts:1518 | src/host/pluginController.ts:151 ("YAOS stopped: ...") | ported |
| Fatal sync notices (unclaimed, revoked, unauthorized, update required) | adfa7a7:src/runtime/fatalSyncNotice.ts:14-55; adfa7a7:src/main.ts:3775 | src/host/ui/statusBar.ts:143-157; src/host/pluginController.ts:151 | ported |
| "YAOS preserved an offline edit as ..." | adfa7a7:src/main.ts:1069 | src/engine/reconcile/context.ts:187, :193-200 | implemented (2d6bac5) |
| Conflict-copy notice (30 s cooldown, suppressed count) | adfa7a7:src/runtime/reconciliationController.ts:2701-2714; adfa7a7:src/sync/blobSync.ts:1827-1830 | src/engine/reconcile/context.ts:193-200; src/core/plan/conflictName.ts:107 (one warning per pass with the count and the first copy) | implemented (2d6bac5) |
| Daily-limit popup (20 s, once per window) | adfa7a7:src/main.ts:2886-2891; adfa7a7:src/sync/dailyLimit.ts:19 | src/host/pluginController.ts:35; src/engine/runtime/context.ts:153-156; src/engine/runtime/dailyLimit.ts:22, :28 | implemented (52d5ea0) |
| Server persistence degraded / restored | adfa7a7:src/main.ts:2900-2909 | MISSING | dropped: no such state (see "Server not saving" in §3.1) |
| Skipped file (too large, or a name other systems cannot store) | adfa7a7:src/sync/blobSync.ts:860, :1077 | src/engine/reconcile/skipNotice.ts:66, :74; src/engine/reconcile/reconciler.ts:207-209 | implemented (c5ca263) |
| Engine warnings (too large, no attachment storage, read failed, invalid canvas) | various | src/host/pluginController.ts:36 (every warn and error notice is shown); src/engine/reconcile/blobJobs.ts:26; src/engine/reconcile/scan.ts:129; src/engine/reconcile/canvasJob.ts:39 | ported |
| "Yaos: Debug mode active — debug API unavailable" | adfa7a7:src/main.ts:3904 | MISSING | dropped: the QA harness and its debug API were deleted (f451274) |

Info-level engine notices stay in the status only, except the settings-reload prompt (src/host/pluginController.ts:33-34).

### 3.3 Modals

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| Confirm dialog | adfa7a7:src/ui/ConfirmModal.ts:6 | src/host/ui/confirmModal.ts:16, :48 | ported |
| Pairing-code dialog ("Add my device") | adfa7a7:src/settings/PairDeviceModal.ts:14 | src/host/ui/pairModal.ts:151 | ported (details in §4) |
| Device credentials dialog | adfa7a7:src/settings/DeviceCredentialsModal.ts:3 | MISSING (a masked "Device token" row, src/host/ui/settingsTab.ts:100) | dropped: DeviceCredentials modal (coordinator decision) |
| Rename shared vault dialog | adfa7a7:src/settings/VaultNameModal.ts:3 | MISSING | dropped: governance moved to the server operator console (§18) |
| Three-way conflict dialog | adfa7a7:src/ui/ThreeWayConflictModal.ts:10 | MISSING | dropped: DESIGN §m.2 (ThreeWayConflictModal, externalEditPolicy) |
| Snapshot list, browse and capture-status dialogs | adfa7a7:src/snapshots/recoveryModals.ts:13, :55, :196 | src/host/ui/snapshotsModal.ts:38, :159 | implemented (6ca0411) (details in §5) |

New only: the held-changes review (src/host/ui/brakeModal.ts:9, opened at src/host/ui/registerUi.ts:162-168) and the
settings-seed question (src/host/ui/settingsTab.ts:43-64).

### 3.4 Settings tab: groups, info rows and actions

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| Settings tab registered | adfa7a7:src/main.ts:819-820 | src/host/ui/registerUi.ts:112-120 | ported |
| Inline setup form ("Join this folder", Server URL, Pairing code, Enroll) | adfa7a7:src/settings/settingsTab.ts:231-254 | src/host/ui/settingsTab.ts:103-107, opening src/host/ui/pairModal.ts:28 | ported (the inline form became a dialog) |
| "Deploy your server" link | adfa7a7:src/settings/settingsTab.ts:256-260 (URL at :136) | src/host/ui/pairModal.ts:77 (in the pair dialog) | implemented (5a9b34c) |
| Status rows (Status, Server, Folder, Vault ID, This device) | adfa7a7:src/settings/settingsTab.ts:264-269 | src/host/ui/settingsTab.ts:99-102, :123-125; src/host/ui/settingsModel.ts:162, :203 | ported (there is no Folder row) |
| "Add my device" | adfa7a7:src/settings/settingsTab.ts:270-274 | src/host/ui/settingsTab.ts:108-113 ("Pair another device") | ported |
| "Invite person" | adfa7a7:src/settings/settingsTab.ts:275-280 | MISSING | dropped: governance moved to the server operator console (§18) |
| "Device credentials" | adfa7a7:src/settings/settingsTab.ts:281-285 | MISSING (masked token row, src/host/ui/settingsTab.ts:100) | dropped: DeviceCredentials modal (coordinator decision) |
| "Open server console" (wave 2) | adfa7a7:src/settings/settingsTab.ts:286-290: a settings action "Open this Worker in a browser. The operator key stays in the console." It calls adfa7a7:src/main.ts:3476-3483, which trims the configured server URL, drops a trailing slash, shows "Configure a server URL first." when it is empty, and otherwise calls window.open(host, "_blank", "noopener"). | TBD-D | TBD-D |
| "Leave this vault" (members only) | adfa7a7:src/settings/settingsTab.ts:291-296; adfa7a7:src/main.ts:3584 | src/host/ui/settingsTab.ts:114-119 ("Unpair this device"; local only, the confirm text at :406 points at the server console) | dropped: governance moved to the server operator console (§18) |
| Updates group (versions, refresh, update action, initialize updater) | adfa7a7:src/settings/settingsTab.ts:305-340 | MISSING | dropped: DESIGN §m.2 (plugin install/update flows; see §14) |
| "Attachment storage" status and "Refresh attachment capability" | adfa7a7:src/settings/settingsTab.ts:398-409 | MISSING as a row; only the no-attachment-storage warning (src/engine/reconcile/blobJobs.ts:26) | missing: undecided; small (a read-only row that says whether the server has attachment storage) |
| "Set up attachment storage" video | adfa7a7:src/settings/settingsTab.ts:410-415 (URL at :137) | MISSING | dropped: attachment storage video (coordinator decision) |
| Collaboration group ("Show remote cursors") | adfa7a7:src/settings/settingsTab.ts:460-470 | MISSING | dropped: DESIGN §m.2 (awareness/cursor presence) |
| Operational resource rows (residency, queued work, blockers, body sockets, pressure) | adfa7a7:src/settings/settingsTab.ts:509-543 | MISSING (engine rows at src/host/ui/settingsModel.ts:203) | dropped: DESIGN §m.2 (runtime coordinators) |

The settings sync group (adfa7a7:src/settings/settingsTab.ts:545-723) is covered in §1. The roster, security audit and
governance groups (adfa7a7:src/settings/settingsTab.ts:890-1012) are covered in §18.

New only: the held-changes row (src/host/ui/settingsTab.ts:126-140) and an Actions group: pause, resume, sync now,
create and browse snapshots, export diagnostics, rebuild the local cache, restart the engine (src/host/ui/settingsTab.ts:229-278).

### 3.5 Settings fields

Legacy fields are the keys of `DEFAULT_SETTINGS` (adfa7a7:src/settings/settingsStore.ts:111-146). New fields are
`YaosPluginData` (src/host/ui/api.ts:29) and `EngineSettings` (src/protocol/messages.ts:34), with defaults at
src/host/ui/api.ts:50-58. The settings sync fields are in §1 and the exclude field is in §12.

| Feature | Legacy (file:line) | New (file:line) or MISSING | Decision |
|---|---|---|---|
| Server URL (`host`) | adfa7a7:src/settings/settingsStore.ts:112 | src/host/ui/api.ts:20 (`PairedIdentity`); entered in src/host/ui/pairModal.ts:28 | ported |
| Device credentials (`deviceToken`, `vaultId`, `deviceId`, `vaultGeneration`) | adfa7a7:src/settings/settingsStore.ts:113-115, :125 | src/host/ui/api.ts:20, :128 (validated on load) | ported |
| Person and authority fields (`principalId`, `principalDisplayName` "Your name", `principalColorSeed`, `vaultRole`, revisions, `capabilityDigest`, `authorityCapabilities`) | adfa7a7:src/settings/settingsStore.ts:116-124; adfa7a7:src/settings/settingsTab.ts:344-356 | MISSING | dropped: governance moved to the server operator console (§18) |
| `originImportPending` (import local files after joining) | adfa7a7:src/settings/settingsStore.ts:126 | MISSING (bootstrap imports local files itself, DESIGN §j.5) | dropped: the first import is part of bootstrap |
| Device name, renamed on the server when changed | adfa7a7:src/settings/settingsStore.ts:127; adfa7a7:src/settings/settingsTab.ts:357-367, :789-796 | src/host/ui/settingsTab.ts:144 ("Device label": local, used in conflict-copy names); src/host/ui/pairModal.ts:95 (the name is sent once, at pairing) | dropped: renaming a device after pairing moved to the server operator console (§18) |
| `pendingEnrollment` (an unanswered enrollment kept across restarts) | adfa7a7:src/settings/settingsStore.ts:128; adfa7a7:src/runtime/setupLinkController.ts:60-62 | src/host/ui/api.ts:151; src/host/ui/pairFlow.ts:79, :112; src/host/plugin.ts:131 | implemented (8db4540) |
| `debug` ("Record detailed sync events ...") | adfa7a7:src/settings/settingsStore.ts:129; adfa7a7:src/settings/settingsTab.ts:498-502 | MISSING (the 2000-event ring is always on, src/engine/runtime/context.ts:38) | dropped: DESIGN §m.2 (telemetry and observability) |
| `frontmatterGuardEnabled` | adfa7a7:src/settings/settingsStore.ts:133; adfa7a7:src/settings/settingsTab.ts:493-497 | MISSING | dropped: DESIGN §m.2 (frontmatter family) |
| `maxFileSizeKB` ("Maximum text file size in kilobytes") | adfa7a7:src/settings/settingsStore.ts:135; adfa7a7:src/settings/settingsTab.ts:377-392 | MISSING (fixed `MAX_DOC_TEXT_CHARS`, src/core/limits.ts:70; too-large warning at src/engine/reconcile/mergeJob.ts:70) | dropped: markdown max-size setting (fixed limits in src/core/limits.ts) |
| `externalEditPolicy` ("Edits from other apps": always, closed-only, never) | adfa7a7:src/settings/settingsStore.ts:136; adfa7a7:src/settings/settingsTab.ts:488-492 (options at :138-142) | MISSING | dropped: DESIGN §m.2 (externalEditPolicy) |
| `enableAttachmentSync` ("Sync attachments", default on) | adfa7a7:src/settings/settingsStore.ts:137; adfa7a7:src/settings/settingsTab.ts:416-421 | src/host/ui/api.ts:52; src/host/ui/settingsTab.ts:168 | ported |
| `attachmentSyncExplicitlyConfigured` and its migration | adfa7a7:src/settings/settingsStore.ts:138, :286-292 | MISSING | dropped: legacy settings migration (zero users) |
| Attachment size limit: field text and effective cap (wave 2) | adfa7a7:src/settings/settingsTab.ts:422-441: number field "Maximum attachment size in kilobytes", text "Attachments larger than this are skipped. Maximum N KB.", min 1, max N, and validation that rejects values above N ("Enter N or less."). N is `attachmentSizeCapKB(serverMaxBlobUploadBytes)` (adfa7a7:src/settings/settingsStore.ts:14-23): min(10240, floor(server max upload bytes / 1024)), or 10240 KB (`MAX_ATTACHMENT_SIZE_KB`, :12) when the server reports no cap. Default 10240 KB (:139). Shown only when the server has attachment storage and sync attachments is on. | TBD-D | TBD-D |
| `attachmentConcurrency` ("Parallel transfers", 1-5, default 1) | adfa7a7:src/settings/settingsStore.ts:141; adfa7a7:src/settings/settingsTab.ts:442-456 | MISSING (per-device-class `blobConcurrency` 4/2/2/1, src/core/limits.ts:173, :179, :185, :191) | dropped: attachmentConcurrency setting (fixed per-class budgets, DESIGN §i.2) |
| `showRemoteCursors` | adfa7a7:src/settings/settingsStore.ts:142; adfa7a7:src/settings/settingsTab.ts:460-470 | MISSING | dropped: DESIGN §m.2 (awareness/cursor presence) |
| `updateRepoUrl`, `updateRepoBranch` ("Deployment repository URL", "Deployment default branch") | adfa7a7:src/settings/settingsStore.ts:143-144; adfa7a7:src/settings/settingsTab.ts:478-487 | MISSING | dropped: DESIGN §m.2 (plugin install/update flows) |
| `qaDebugMode` | adfa7a7:src/settings/settingsStore.ts:145; adfa7a7:src/main.ts:694 | MISSING | dropped: the QA harness was deleted (f451274) |

New only: "Deleted files go to" (`trashMode`, §11), "Live edits from other devices" (`provisionalBroadcast`,
src/host/ui/settingsTab.ts:199), daily snapshots and how many to keep (:204, :209), "Upload snapshots to attachment
storage" (:221), and "Show status in the status bar" (:280).
