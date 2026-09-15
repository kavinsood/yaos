# Obsidian Excalidraw Host Feasibility Findings

## Verdict

Current upstream has removed the largest capture blocker: `onSceneChangeHook`
is now an explicit ExcalidrawAutomate API. YAOS does not need to intercept React
`onChange` or patch plugin internals for scene capture on the current release.

Applying a remote scene is also feasible through the public
`ExcalidrawView.updateScene()` facade with
`captureUpdate: CaptureUpdateAction.NEVER`. `NEVER` is explicitly documented
by upstream for remote updates and keeps those updates out of local undo/redo.

There is still no clean “apply without dirtying/autosave” API. Current plugin
code detects the changed scene version in `onChange()` and calls `setDirty()`.
This is not a blocker and should not be defeated with semaphore mutation:
remote state needs eventual materialization into the Obsidian file. YAOS should
suppress network echo in its adapter using element-version/origin bookkeeping,
while permitting the plugin's normal dirty/save path.

## Pinned source

- Repository: `zsviczian/obsidian-excalidraw-plugin`
- Commit: `a601c3f470bf9dc5273cf1af074338f4ef265349`
- Commit time: `2026-09-08T19:56:39+02:00`
- Manifest version: `2.27.3`
- Minimum Obsidian: `1.8.7`
- Embedded Excalidraw fork: `@zsviczian/excalidraw@0.18.135`
- Local source used: `/tmp/yaos-obsidian-excalidraw-source`

The root `package.json` version is `2.2.5`, but the distributable plugin version
is the version in `manifest.json` (`2.27.3`). Capability detection must be used
instead of trusting either number.

## Exact seams

### Capture

- `src/view/components/ExcalidrawRoot.ts:190` delegates the React Excalidraw
  `onChange(elements, appState, files)` callback to `view.onChange(...)`.
- `src/view/ExcalidrawView.ts:5456` calls `triggerSceneChangeHooks(...)` after
  the plugin has performed its own state/dirty processing.
- `src/view/ExcalidrawView.ts:3830` implements hook dispatch and scene-version
  filtering.
- `src/view/ExcalidrawView.ts:3894` enforces `trackElements` and/or selected
  `appStateKeys`, then calls the registered callback.
- `src/shared/ExcalidrawAutomate.ts:4357` exposes the supported
  `onSceneChangeHook` shape. It supplies complete elements, app state, rendered
  `BinaryFiles`, the originating view, and the EA instance.
- `src/constants/assets/startupScript.md:306` documents the hook for plugin
  scripts. The release notes state it was added in `2.26.0`.
- Do not assume whether the callback's React-provided array retains every
  tombstone across bundled Excalidraw versions. When the hook fires, snapshot
  `view.excalidrawAPI.getSceneElementsIncludingDeleted()` and diff that against
  the adapter's last accepted scene. `onExcalidrawIncrement` is a richer
  internal event but should not be the primary compatibility seam.

Registration should use `plugin.ea.onSceneChangeHook` with
`trackElements: true`. Preserve and chain any pre-existing callback; restore it
on YAOS unload. Since this is a single property, YAOS must multiplex its own
subscribers rather than let repeated setup overwrite the callback.

### Apply

- `src/view/ExcalidrawView.ts:7589` exposes public `updateScene(scene,
  shouldRestore?)`; it normalizes indices, can repair/restore bindings, and
  delegates to `excalidrawAPI.updateScene()`.
- `src/constants/constants.ts:418` defines `CaptureUpdateAction`. At line 432,
  `NEVER` is specifically documented for remote updates and initialization.
- Use `view.updateScene({ elements, files?, captureUpdate: "NEVER" }, false)`.
  Send a complete reconciled scene per accepted server batch initially; the
  plugin synchronizes invalid fractional indices before applying it.
- `view.excalidrawAPI` additionally provides `getSceneElements()`,
  `getSceneElementsIncludingDeleted()`, `getAppState()`, `getFiles()`,
  `addFiles()`, and `updateScene()`. Prefer the view facade for elements and
  direct API methods only for capability gaps such as collaborators/files.

### Dirty state, autosave, and echo

- `src/view/ExcalidrawView.ts:5328` receives Excalidraw increment events.
  Durable element increments call `setDirty()`.
- Independently, `src/view/ExcalidrawView.ts:5303` compares the live scene hash
  with `previousSceneVersion` and calls `setDirty()` on a change.
- `src/view/managers/ViewSaveCoordinator.ts:470` advances revision state and
  schedules/reset autosave when `setDirty()` runs.
- `src/view/managers/ViewSaveCoordinator.ts:407` autosaves dirty scenes when
  editing/freedraw/semaphore guards allow it.
- Therefore `CaptureUpdateAction.NEVER` means “not undoable,” not “not dirty.”
  A source-only proof cannot guarantee which increment classification the
  Excalidraw fork emits, but the scene-version fallback is sufficient to show
  that a settled remote element change becomes dirty.

Recommended behavior:

1. Before applying a server batch, record its `operationId` and the accepted
   `(elementId, version, versionNonce, isDeleted)` winners.
2. Apply with `captureUpdate: NEVER`.
3. The scene hook will observe the resulting scene. Diff it normally, then
   filter exact winners already accepted from the server. Do not use a timed
   boolean “ignore next onChange”; React scheduling and concurrent local edits
   make that unsafe.
4. Permit the plugin to mark dirty and autosave. Route the resulting file write
   through the Excalidraw semantic projection/mirror so it does not become a
   competing opaque-file update.
5. Never call `view.clearDirty()` after remote apply: it can erase evidence of
   a concurrent local edit, and it mutates the coordinator's revision baseline.

### Presence

- `src/view/components/ExcalidrawRoot.ts:185` delegates official React
  `onPointerUpdate` to `view.onPointerUpdate`.
- `src/view/ExcalidrawView.ts:5179` makes `onPointerUpdate` public, but exposes
  no corresponding hook. It includes scene coordinates, pointer/laser tool,
  button state, and active pointers.
- Safe fallback: install a lifetime wrapper around the individual view's public
  `onPointerUpdate`, call the original first, then emit rate-limited presence.
  Restore the exact original on detachment. Capability-test the method on each
  view; do not patch the prototype globally.
- Remote collaborators can be supplied through the underlying Excalidraw API's
  `updateScene({ collaborators })`. This requires a real-host probe because the
  plugin view facade's local type and bundled fork behavior were not executed.
- Selection and viewport are already present in the scene hook's `appState`.
  Register only the keys needed for presence, e.g. `selectedElementIds`,
  `scrollX`, `scrollY`, and `zoom`; keep them out of durable scene messages.

## Resources and nested drawings

The hook's `files` argument is the rendered Excalidraw `BinaryFiles` map. That
is sufficient to render a browser scene, but it is not the authoritative
Obsidian dependency description.

- `src/view/ExcalidrawView.ts:4703` exposes `getScene()`, which returns live
  elements, selected persisted app state, and only referenced API files.
- `src/shared/ExcalidrawData.ts:2277` exposes per-drawing registries for embedded
  files, equations, local Markdown images, and Mermaid sources.
- `src/shared/EmbeddedDataRegistries.ts:33` mirrors those registries into
  session-wide master maps for cross-drawing copy/paste.
- `src/shared/ExcalidrawAutomate.ts:3477` exposes
  `getPathForImageFileId()`, but explicitly warns that the index is only a
  session cache, not persistent authority.
- `src/view/ExcalidrawView.ts:3151` exposes `loadSceneFiles(...)`, and
  `ExcalidrawView.ts:308` exposes the file publication helper around
  `excalidrawAPI.addFiles()`.
- Markdown drawings store JSON or compressed JSON under `## Drawing`, while
  source references/equations appear under `## Embedded Files`. Local rendered
  Markdown-image bodies use marker-delimited blocks. See
  `src/shared/excalidrawMarkdownParsing.ts:14` and
  `src/shared/ExcalidrawData.ts:1575`.

Same-vault collaboration should synchronize scene elements and a typed resource
manifest, not recursively transmit note bodies. Manifest entries should
distinguish `vault-file`, `external-url`, `equation`, `mermaid`,
`local-markdown-render`, and `nested-excalidraw`. Obsidian peers resolve vault
references locally and can request/render missing resources through the plugin.

Browser publication must be a separate explicit act. Publish chosen rendered
binary snapshots to YAOS storage; do not follow a nested drawing or Markdown
embed automatically. Equations/Mermaid may be published as rendered binaries
unless the owner explicitly chooses to expose source. Local Markdown renders
must default to withheld because their source may include private note content.

## Recommended adapter

Create a capability-gated `ObsidianExcalidrawHostAdapter` with one attachment
per live `ExcalidrawView`:

1. Discover the plugin by ID and views by `getLeavesOfType("excalidraw")`.
2. Require `plugin.ea.onSceneChangeHook`, `view.updateScene`,
   `view.excalidrawAPI`, and standard scene getters. If unavailable, disable
   realtime for that view and show a compatibility diagnostic.
3. Chain one global scene hook and demultiplex by `view.file.path`/semantic
   drawing identity. Snapshot `getSceneElementsIncludingDeleted()`, then produce
   element diffs with explicit tombstones.
4. Attach per-view pointer wrappers only while a promoted drawing is open.
5. Apply accepted server winners through `view.updateScene` with `NEVER` and
   filter echoes by exact element-version ledger.
6. Let plugin autosave materialize the scene. Integrate the disk write with a
   semantic projection router rather than clearing dirty state.
7. Build resource manifests from image elements plus `excalidrawData`
   registries; treat `BinaryFiles` as render cache, not permission authority.

Do not patch React props, `onChange`, `setDirty`, `clearDirty`, autosave timers,
or `ViewSaveCoordinator`. Those are higher-risk and unnecessary at current
upstream HEAD.

## Static experiment

Run:

```sh
OBSIDIAN_EXCALIDRAW_SOURCE=/tmp/yaos-obsidian-excalidraw-source \
  node spikes/excalidraw/host/assert-host-seams.mjs
```

The assertion checks the hook, React delegation, public apply facade, remote
capture mode, dirty paths, pointer delegation, and resource registries. It is a
source compatibility sentinel, not a runtime behavioral test.

## Still requires real Obsidian validation

- Whether `updateScene(... NEVER)` invokes the scene hook synchronously or on a
  later React turn, and its exact `onIncrement` classification.
- Concurrent local input during a remote batch, especially text editing,
  binding repair, grouping, reorder indices, undo/redo, and deletion.
- `files` propagation and `addFiles()` behavior for PNG/JPEG/SVG/PDF, equations,
  Mermaid, Markdown renders, external URLs, and nested drawings.
- Collaborator map rendering, pointer/laser display, selection colors, and
  viewport/follow behavior in the bundled fork.
- View lifecycle across leaf close/reopen, popout migration, plugin reload,
  workspace restore, and two views of one drawing.
- Desktop-to-desktop and desktop-to-mobile convergence, background suspension,
  iOS memory pressure, and touch/stylus pointer frequency.
- Plugin versions before `2.26.0`: the supported scene hook is absent and YAOS
  should require an upgrade rather than silently install invasive capture
  patches for the first release.

No installed local `obsidian-excalidraw-plugin` build or user drawing fixtures
were available in the active vault, so no real-host/mobile test was claimed.
