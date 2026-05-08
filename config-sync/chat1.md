› one of the biggest things asked by users, is obsidian config + plugins sync, essentially, sync for .obsidian.

    i'd like to explore this, and i feel this is the current actual feature, other than a few hotfixes, that makes the most sense to work on.

    the scenarios possible:
    - user 'pours' in everything from one motherload (simpler)
    - user has two vaults already, and wants to setup sync (need to think, how to converge)

    the .obsidian folder contains things like .trash, some things like the workspace are changed on every load, and certain plugin settings can be nasty big.

    i want to know: what all exists in the .obsidian folder, and for this, i've setup the obsidian developer docs for you to peruse in exhaustive depth: ~/github/obsidian-developer-docs

  what other possibilities, cases can you think of? where do you envision things can go wrong?

  if you had to think from scratch, how would you implement this feature/


• You want a real design pass on .obsidian sync before we commit to an implementation, so I’m going to read the current plugin structure and then mine the local Obsidian developer docs for what actually lives
  under .obsidian, which pieces are safe to sync, and which are likely to cause churn or breakage.

• I’ve got the repo shape and the docs mirror loaded. Next I’m narrowing onto two things: how this plugin currently models sync and what Obsidian itself documents about vault config, workspaces, plugins, and
  hidden state under .obsidian.

• I’m pulling on the exact storage docs now. The main risk with .obsidian sync is that it mixes stable preferences with highly ephemeral UI state, so I want the answer grounded in what Obsidian itself calls “per-
  vault data” rather than guessing from anecdote.

• One useful doc signal already popped out: plugins are explicitly told not to hardcode .obsidian, because the config directory can be renamed. That means if we build this feature around literal .obsidian, we’ll
  miss custom configDir vaults from day one.

• I’ve got the documented side. I’m also going to sample a few real local vault config directories from your QA/test vaults, because the docs tell us the APIs and principles, but not the practical filename spread
  we’ll have to classify in a sync feature.

• I’ve got one concrete vault inventory now. Next I’m checking the shape of the major JSON files so we can separate “stable user intent” from “session/UI churn” rather than just sorting by filename.

• Another concrete API constraint emerged: Obsidian only guarantees external-change reload hooks for plugin data.json, not arbitrary files under plugin folders. So if we sync .obsidian/plugins/<id>/... wholesale,
  a lot of plugins may not notice the change until restart, or may stomp it back on next save.

• I’m checking one more thing before I synthesize: whether Obsidian exposes any official plugin-management API we could lean on. If it doesn’t, “sync plugins” becomes mostly a filesystem/config problem plus some
  careful reload choreography.

• I’m also scanning for mobile-specific workspace files and more plugin data.json samples, just to avoid accidentally designing this as a desktop-only shape when your manifest is mobile-compatible.

• I have enough context now. I’m grabbing line-numbered references for the few facts worth anchoring directly in the answer, then I’ll lay out a concrete classification, failure model, and an implementation plan.

• One more important API-level constraint showed up: hidden folders aren’t accessible through the regular Vault API, so a config-sync feature will almost certainly need the adapter path rather than the usual vault
  file APIs. That changes the implementation shape quite a bit.

• I’d frame this as vault config sync, not “mirror .obsidian wholesale”.

  Two grounding points first:

  - The config folder is Vault.configDir, which is usually .obsidian but not guaranteed to be; hardcoding .obsidian would be a mistake. YAOS also currently hard-excludes both the config dir and .trash/ from normal
  sync in src/sync/exclude.ts:10.
  - .trash is not inside .obsidian; Obsidian documents it as a vault-root .trash folder when local trash is used.

  What’s actually in the config dir
  From your local vault sample at /home/kavin/garden/.obsidian, the shape is basically:

  - Stable-ish top-level prefs: app.json, appearance.json, core-plugins.json, community-plugins.json, graph.json, file-recovery.json
  - Personal / volatile state: hotkeys.json, workspace.json
  - User assets: snippets/*.css, themes/<theme>/*
  - Plugin-owned trees: plugins/<id>/data.json, main.js, manifest.json, styles.css, and arbitrary extras

  That last part matters a lot: plugin dirs are not just settings. In your sample, BRAT has brat-migrations.json, and YAOS has diagnostics plus multi-MB log files under its plugin dir. So “sync plugin folders” can
  easily become “sync caches, logs, and remote code deployment”.

  What else to plan for / where this goes wrong

  - Fresh-device bootstrap vs true merge are different products. “Pour from motherload” is easy; “converge two existing setups” needs domain-specific merge rules.
  - workspace.json is very high churn and very device-shaped. Your sample includes lastOpenFiles, active leaf IDs, pane tree, sidebars, and specific open notes. I would not live-sync this by default.
  - Plugin data.json is opaque. It may contain secrets, absolute paths, machine-specific ports, device names, or schema tied to a plugin version.
  - Desktop/mobile divergence is real. Some community plugins are desktop-only; even if the vault sync plugin is mobile-compatible, the synced config may not be.
  - Obsidian documents an external-change hook for plugin data.json, but not for arbitrary files in plugin dirs. So many synced plugin changes won’t hot-apply cleanly without reload/restart.
  - There doesn’t seem to be a nice official plugin-install API in the docs you pointed me to. That means “sync installed plugins” is mostly file syncing plus whatever reload choreography you build.
  - Hidden-folder access changes the implementation: the regular Vault API only sees visible files, so config sync needs the adapter path, not the normal vault file pipeline.
  - Shared vaults across multiple humans are a separate case. Many people want shared notes but private hotkeys, workspace, AI keys, theme choice, or plugin prefs.

  What I’d build
  MVP:

  - Sync only typed, selected config domains:
  - app.json
  - appearance.json
  - core-plugins.json
  - community-plugins.json as desired-state
  - snippets/
  - themes/
  - selected plugins/<id>/data.json
  - Keep off by default:
  - workspace.json
  - hotkeys.json
  - arbitrary plugin subdirs
  - plugin binaries (main.js, styles.css, plugin folder mirroring)

  Merge model:

  - Fresh device: “Import config from another device” as authoritative pull with backup.
  - Existing device: diff UI per domain/file with keep local, take remote, union where sensible.
  - For community-plugins.json, use set-style merge.
  - For plugin data.json, start with file-level local-vs-remote choice, not deep merge.

  Implementation shape:

  - Build a separate configSync subsystem, not a special case in note sync.
  - Enumerate this.app.vault.configDir through vault.adapter / DataAdapter, not Vault.
  - Maintain a manifest of allowed config entries with path, hash, size, domain, updatedAt.
  - Use whole-file sync, not CRDT text, for config files. These files are low-frequency and many should be treated as authoritative units.
  - Before applying remote config, make a timestamped local backup.
  - After applying:
  - If it’s data.json, let the target plugin react if it implements external settings reload.
  - If it’s theme/snippets/top-level prefs, prompt or trigger the lightest safe reload.
  - If it’s plugin code, require explicit advanced opt-in and probably app restart.

  My product instinct:

  - Default feature name: Sync settings and plugin config
  - Advanced feature later: Mirror installed community plugins
  - Separate one-shot tool later: Restore workspace layout from another device

  If you want, I can turn this into a concrete RFC next: file classification matrix, merge policy table, and an implementation plan against the current YAOS architecture.

  Sources:

  - /home/kavin/github/obsidian-developer-docs/en/Reference/TypeScript API/Vault/configDir.md:10
  - /home/kavin/github/obsidian-developer-docs/en/Plugins/Vault.md:6
  - /home/kavin/github/obsidian-developer-docs/en/Plugins/Vault.md:96
  - /home/kavin/github/obsidian-developer-docs/en/Reference/TypeScript API/Plugin/onExternalSettingsChange.md:10
  - /home/kavin/github/obsidian-developer-docs/en/Reference/TypeScript API/Plugin/loadData.md:10
  - /home/kavin/github/obsidian-developer-docs/en/Reference/TypeScript API/Workspace/getLayout.md:10 and /home/kavin/github/obsidian-developer-docs/en/Reference/TypeScript API/Workspace/changeLayout.md:10
  - src/sync/exclude.ts:10
