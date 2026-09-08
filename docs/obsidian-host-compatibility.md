# Obsidian host compatibility

YAOS treats Obsidian's documented plugin API as the default boundary. A small
adapter owns the few observed host behaviors that are not declared by the
published type definitions. Product code must not reach those behaviors
directly.

## Supported baseline

The release baseline is Obsidian `1.13.x`. The adapter capability-checks every
undocumented member so older, newer, mobile, or restricted hosts degrade
safely instead of assuming an implementation detail is present.

| Capability | Host behavior | YAOS use | Safe fallback |
| --- | --- | --- | --- |
| Leaf identity | optional `WorkspaceLeaf.id` | distinguish concurrent editor bindings | canonical file path |
| Community-plugin manager | optional `app.plugins` operations and manifest map | opt-in settings environment install/enable work | skip that step and retain the queued plan/manual instruction |
| Community-plugin observation | `installPlugin` and `enablePluginAndSave` | record user-initiated catalog installs for settings sync | no observation; no host operation is changed |
| Workspace refresh | internal workspaces plugin lookup | refresh workspace names after settings apply | no refresh |
| Canvas view/controller | `view.file`, `setViewData`, `canvas.getData`, `importData`, `requestSave` | prove view ownership and project one semantic batch | keep the open view host-owned and defer remote projection |
| Canvas mutation/history | `markDirty`, `markMoved`, `applyHistory` | coalesce local capture and observe definitive undo/redo boundaries | capture at native save/load boundaries only |
| Canvas active text | node `isEditing` and `text` | preserve an actively edited card across bulk import | hold remote text behind the editor commit boundary |

The adapter's patch registry is intentionally narrow. It installs one wrapper
per host target and method, calls the original exactly once with its original
receiver and arguments, and notifies observers only after success. Observer
failures cannot alter the host result. Releasing an observer is idempotent;
the original method is restored only when YAOS still owns the wrapper. If a
third party has replaced it, YAOS stands down rather than overwriting that
plugin.

Tests cover missing capabilities, return/receiver preservation, asynchronous
rejection preservation, listener isolation, exact restoration, and foreign
replacement safety. Adding a new private host dependency requires an adapter
method, an entry in this table, and focused coverage.
