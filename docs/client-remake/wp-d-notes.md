# WP-D notes: host, protocol carriers, worker, sim runner

Branch `client-remake-wp-d`. Scope: DESIGN §k.3 WP-D. Status of the acceptance criteria:

| # | Criterion | Status |
|---|---|---|
| 1 | Worker and inline transport parity on recorded traces; transfer ownership asserted | done (`src/protocol/transports.test.ts`) |
| 2 | Disk executor honours every `WritePrecondition`; rename via `vault.rename`; trash only | done (`src/host/diskExecutor.test.ts`, `obsidianVault.test.ts`) |
| 3 | Binding: bind-time merge, no echo loop, external-reload interception, `docCredit`, worker kill mid-typing loses nothing | done (`src/host/binding.test.ts`, `src/sim/device.test.ts`) |
| 4 | Lifecycle flush on `pagehide` | done (`device.test.ts`, `pluginController.test.ts`) |
| 5 | Full simulation suite (§l) green on 200 CI seeds | done over the stand-in engine (`src/sim/run.test.ts`); the relay/storage parts of §l wait for integration (see Gaps) |
| 6 | Obsidian smoke on desktop and iOS | node smoke of the production bundle done; the phone runs are manual (steps below) |

## What is built

- **Protocol carriers.** `src/protocol/inlineTransport.ts` is an in-process pair on a pluggable schedule (macrotask by default, the virtual clock in the sim). It has kill/failure semantics. `src/protocol/workerTransport.ts` wraps a `Worker` / `DedicatedWorkerGlobalScope`. Both use the `[T]` transfer helpers (`transferablesOf`, `owned`, `postOwned`), so a transferred buffer is detached on the sender.
- **Worker entry.** `src/engine/workerMain.ts` autostarts only inside a dedicated worker. `importScripts` is the tell: classic Blob-URL workers expose it.
- **Engine host** (`src/host/engineHost.ts`):
  - probe: ping, then init;
  - falls back to inline on no pong within 5 s, on worker storage failure (OR-1), or when no `Worker` exists;
  - ping liveness;
  - restarts on a new generation, so stale messages are ignored;
  - more than 3 restarts in 10 min means inline only;
  - terminal and fatal errors stop the host.
  - Once `stop()` begins, no restart or bring-up can create a carrier, and a half-started carrier is torn down without `onReady`.
- **Host runtime** (`src/host/hostRuntime.ts`): wires the engine host, the bindings and the disk executor.
  - Vault events go to observation batches.
  - It runs scan and reconcile, handles engine requests (disk ops, side files, config dir, status, brake, notices) and lifecycle flushes.
- **Disk executor** (`src/host/diskExecutor.ts`):
  - lane-first slices;
  - every write, rename and trash has a CAS precondition;
  - dependent ops are skipped;
  - a bound-file guard;
  - a config area;
  - bounded reads;
  - I/O failures come back as `reason: "io"` and never throw.
- **Binding manager** (`src/host/binding.ts`), one replica per open doc:
  - bind-time merge;
  - coalesced `localUpdate`;
  - remote updates are never echoed;
  - external-reload interception that merges and, on conflict, writes a conflict copy;
  - `boundSaved` and `docCredit`;
  - restart rebind via `bindDelta`;
  - split views share one replica.
  - Conflict-copy writes retry I/O errors with backoff (250 ms, 1 s, 2 s, 5 s, 10 s, then 30 s) before the merged buffer is saved over the disk side.
- **Obsidian adapters:**
  - VaultPort (`obsidianVault.ts`): text CAS via `vault.process` with an exact-content guard; `vault.create` when the file is absent; `vault.rename` only; `vault.trash` only; empty-folder removal only when the folder has zero children.
  - WorkspacePort (`obsidianWorkspace.ts`): diffs the leaf set, so a mode switch shows up as `file-changed`; wraps `setViewData` per instance (OR-2); unbinds before Obsidian clears the view.
  - ConfigDirPort (`configDir.ts`): writes a temp file, then renames it.
  - Side files and platform: lifecycle events and device facts.
- **Plugin.**
  - `src/host/plugin.ts` is the entry point.
  - `YaosController` (`pluginController.ts`) handles data persistence, runtime lifecycle, run state, commands, and applying settings and identity.
  - UI shells: settings tab, pair and pairing-code modals, brake modal, status bar, setup-link handler, diagnostics export.
- **Day-1 spike plugin** (`src/host/spike/**`, `scripts/build-spike.mjs`): throwaway OR-1 and OR-2 probes, with a results modal and a Save-report button.
- **Build** (`esbuild.config.mjs`). There are two bundles:
  - The worker IIFE string, exposed as `virtual:yaos-engine-worker` and started from a Blob URL.
  - CJS `main.js`. obsidian, electron, `@codemirror/*` and `@lezer/*` are external.
  - `production` writes `main.js` and `dist/yaos-client/{main.js,manifest.json,yaos/,yaos.zip}`, then runs `scripts/plugin-smoke.mjs`. The smoke checks are:
    - zip layout;
    - no WebAssembly;
    - `main.js` loads as a CJS plugin against a stub `obsidian`, reaches phase `running` on the inline carrier over the in-memory fake vault (`src/sim/fakeObsidian.ts`), never logs the token, and unloads;
    - the worker IIFE answers ping in a `node:vm` context.
- **check-deps** (`scripts/check-deps.mjs`) implements the §k.2 import rules:
  - areas;
  - type-only imports;
  - browser globals only in adapters and stand-ins;
  - no WASM and no `legacy-src`;
  - `sim/**` only from tests.
  - Stand-in imports are warnings. Today there is one: `host/plugin.ts` imports `engine/__standins__/engine`.
- **Sim** (`src/sim/**`):
  - `SimVault`: case profiles, CAS, Obsidian-like events, per-child folder renames, clobber records.
  - `SimWorkspace`: a y-codemirror stand-in, a 2 s save debounce, `setViewData` reloads.
  - `SimDevice`: engine, host, vault, workspace and store over the stand-in hub.
  - Actors, faults, invariants, and a seeded runner with ddmin (`run.ts`).

## Tests

`npm run test:client` (node:test through jiti):

| Area | Tests |
|---|---|
| engineHost | 13 |
| diskExecutor | 8 |
| binding | 7 |
| obsidianVault | 7 |
| obsidianWorkspace | 4 |
| pluginController | 3 |
| configDir | 2 |
| platform | 3 |
| checkDeps | 3 |
| transports | 5 |
| workerMain | 1 |
| device e2e | 6 |
| spike | 18 |
| UI | 64 |
| sim suite | 17 |

The sim suite's 17 tests are 12 seed chunks, 2 reproducibility/replay tests, 1 ddmin test and 4 invariant self-tests.

**Sim seeds.** `YAOS_SIM_SEEDS` sets the count. The default is 200, which is the CI count. One run costs about 50 ms. Scenarios:
- 2 devices, no faults: N seeds;
- 3 devices, seeded faults: N seeds;
- 5 devices, seeded faults: N/4 seeds;
- 2 devices, fault-heavy (`faultRate` 0.35): N/4 seeds.

The default 200-seed run takes about 18 s. `YAOS_SIM_SEEDS=1000`: see the run log at the end.

On failure, the test prints the seed, the violations and a ddmin-minimized plan. Replay it with `runSim(cfg, plan)`.

Other gates that pass:
- `npm run typecheck:client`
- `node scripts/check-deps.mjs` (0 errors, 1 stand-in warning)
- `node esbuild.config.mjs production` (bundle smoke)

## Packaging and installing

**Production plugin.** Build it with `node esbuild.config.mjs production`. This writes:
- `dist/yaos-client/yaos.zip`, containing `yaos/main.js` and `yaos/manifest.json` (manifest id `yaos`, version `3.0.0`, `isDesktopOnly: false`);
- an unpacked copy at `dist/yaos-client/yaos/`.

Install steps. Use a test vault only.
1. Copy the `yaos/` folder to `<vault>/.obsidian/plugins/yaos/`. Use the unzipped `yaos.zip` or `dist/yaos-client/yaos/`.
2. Settings → Community plugins → enable "YAOS".
3. The status bar shows the carrier: worker, or inline with a reason.
4. Until integration, the engine is the stand-in. It works locally only and has no relay.

**Day-1 spike (OR-1 / OR-2).** Build it with `node scripts/build-spike.mjs`. This writes `dist/yaos-client/spike/yaos-spike.zip`, whose top level is `yaos-spike/`. Run it only in a throwaway vault, never a real one.

1. Install the plugin:
   - **iOS:** create a vault named `yaos-spike-test` in Obsidian. Then put `yaos-spike/` into `yaos-spike-test/.obsidian/plugins/` using one of these:
     - iCloud Drive: Files app → Obsidian → `yaos-spike-test`. Unzip the zip there.
     - a-Shell: `unzip yaos-spike.zip -d <vault>/.obsidian/plugins/`.
   - **Android:**
     1. Run `adb push dist/yaos-client/spike/yaos-spike /sdcard/Documents/yaos-spike-test/.obsidian/plugins/`.
     2. Open `/sdcard/Documents/yaos-spike-test` as a vault.
   - **Desktop:** copy `yaos-spike/` into `<test vault>/.obsidian/plugins/`.
2. Settings → Community plugins → turn Restricted mode off → enable "YAOS Spike".
3. Command palette → **"YAOS Spike: Run probes"**. Wait about 45 s and do not touch the probe tab. The results modal then opens.
4. Read the lines:
   - `OR-1: ...`: a Blob-URL worker started and IndexedDB opened inside it, or the reason and the inline fallback result.
   - `OR-2 A/B/C/C2/D/E/R`, one line per scenario:
     - A: `vault.modify` reaches the per-instance `setViewData` wrapper (clear flags);
     - B: an `adapter.write` from another app reaches it (timing, modify event);
     - C: returning "handled" keeps the editor unchanged;
     - C2: merge-in-wrapper, then save writes the merged text;
     - D: a `view.data` restore sticks;
     - E: a dirty editor plus `vault.modify`;
     - R: reading mode.
   - `restore OK` and `cleanup OK` must be yes.
5. Press **Save report**. This writes `yaos-spike-report-<platform>-<stamp>.md` at the vault root, with the verdict lines and the full JSON. Send that file back.

**Pending:** the iOS/Android/desktop OR-1 and OR-2 device runs. They are manual and no results have been collected yet. The production plugin depends on two OR-2 answers:
- **A and C:** the instance wrapper sees external reloads, and "handled" suppresses them.

If B shows that `adapter.write` bypasses the wrapper, those writes reach YAOS only as vault `modify` observations, and the engine's disk-side merge must handle them for bound paths. Record the outcome here.

## Decisions and deviations

- **No `qa-product` build mode.** `esbuild.config.mjs` has `production` and dev only, so `package.json`'s `build:qa-product` and `qa:smoke-ready` are stale (legacy QA harness).
- **manifest.json version 3.0.0.** It is a clean break and there are no users.
- **The sim's `setViewData` clear=true unbinds first,** matching the Obsidian adapter. Loading another file into a view detaches y-codemirror before its content is replaced, so one file's text can never reach another file's doc.
- **Seeded Yjs clientIDs.** `sim/__standins__/seededEntropy.ts` patches `globalThis.crypto.getRandomValues`, which is the object lib0 uses, before yjs loads. `node:crypto` is not used because the main tsconfig has no node types. Same seed gives the same trace and the same digest, in one process and across processes (checked: seed 511, three processes, same digest).
  - Import order matters: a script that imports `yjs` before `sim/run` gets random clientIDs, and the same plan then converges differently from run to run. That is how an apparent "nondeterministic sim" showed up in a debugging script. `SimReport.seededEntropy` says whether the seed took hold, and the reproducibility test asserts it.
- **Harness: Obsidian clobber exemption.** An editor save (`vault.modify`, no precondition) can overwrite an external write before the watcher reports it. YAOS cannot see or prevent that. `SimVault` records a `ClobberRecord`, and the invariants exempt the tokens that save destroyed.
- **Harness: diff-shift rules.** Disk writes reach the CRDT as a minimal prefix/suffix-trimmed diff (DESIGN §f). Two rules follow:
  - Actors never insert a token right before its own first character, and never delete a token that is followed by its own first character.
  - Token survival is matched by identity (`A.15`), not with brackets: a minimal diff may reuse a neighbour's `[` or `]`, and a concurrent delete of that neighbour takes the bracket. Greedy matching keeps `A.1`, `A.15` and `A.12.3` distinct.
  - Whole tokens are peeled off and the rest is matched again (`tokenIdsIn`). The trim can reuse more than a bracket: when the engine sees a token delete and an external insert as one disk change (`[A.6]` → `[A.53] `, both during a background pause), it keeps `[A.`, and a concurrent remote insert at that spot lands inside the new identity: `[A.[B.23] 53]`. Every character of both tokens survives, so this is CRDT interleaving, not loss (3000-seed run, fault-heavy seed 511). A word-aligned diff in the engine would avoid the split; WP-C can choose that, and the invariant accepts both.
- **Stand-in engine fixes the real engine must also have:**
  - retry I/O failures (`IO_RETRY_MS`) for reads, conflict copies and projections;
  - project a doc that is ahead of an unchanged disk (after an app crash);
  - persist before projecting and on `boundSaved`, so the store is never older than the disk. Otherwise a stale store re-derives a delete by diff on restart.
- **Engine host stop is final.** A carrier failure that arrives while `stop()` awaits the shutdown answer used to restart the engine. In the sim, that zombie engine joined the hub under the live device's member id after an app crash, and its edits never came back. Now:
  - `halting` is set at the top of `stop()`;
  - every await in `tryStart` re-checks it;
  - teardown in `stop()` uses the current carrier, because teardown is not idempotent.
- **Conflict copies retry I/O errors** (backoff 250 ms up to 30 s, until written or until unload) before the merged buffer is saved over the disk side. Before this change, a single failed write dropped the external side.
- **A frozen doc stays unbound,** with the notice `doc-frozen`. WorkspacePort has no read-only bind.

## Frozen and shared file changes

- `tsconfig.json`: `"skipLibCheck": true` (commit b4f74f7). `obsidian.d.ts` does not typecheck against the DOM lib, and the legacy build also used `-skipLibCheck`. No other frozen file was touched.

## Stand-ins (all replaced at integration)

- `src/engine/__standins__/`:
  - `engine.ts`, `engineMessages.ts`, `diskSync.ts`, `docs.ts`: a protocol-complete engine. Docs are keyed by path; it syncs through the hub, has a credit window and does projection. It uses a conservative merge with conflict copies and has no deletes or renames.
  - `hub.ts`: an in-memory relay with a member outbox, resync on join/online, and no echo.
  - `webPorts.ts`: the worker's clock and hash.
- `src/host/__standins__/merge.ts`: MergeFn and `minimalDiff` (WP-B's `core/merge` replaces it).
- `src/sim/__standins__/`:
  - `clock.ts` and `random.ts`: WP-A's merged `sim/clock.ts` and `sim/random.ts` produce the same sequences. Switch the imports.
  - `sha256.ts`: WP-B's `core/hash`.
  - `seededEntropy.ts`: stays.

**INTEGRATION: `createEngine` contract for WP-C.** Two places call it:
- `host/plugin.ts`, for inline: `createEngine(pair.engine, { carrier: "inline", makePorts })`;
- `engine/workerMain.ts`, for the worker: `createEngine(transport, { carrier: "worker", makePorts })`.

`makePorts(config)` builds the IndexedDB, WebSocket and WebCrypto adapters. The engine host expects:
- `ping` answered with `pong` in every phase, including before `init`;
- `init` answered with `ready{protocolVersion}` within 120 s;
- an IndexedDB open failure in the worker answered with error `storage-lost`, non-retryable, which means OR-1 → inline;
- `shutdown` answered with `ok` within 3 s;
- `version-mismatch` and `revoked` are terminal.

The sim's `SimDevice.carrier()` switches the same way, over WP-A's `SimRelay` and `MemStoragePort`.

## Gaps and known issues

- **A pending conflict copy dies with an app crash.** It happens when a copy hits a disk error, Obsidian's 2 s autosave replaces the disk side, and the app crashes before a retry lands. Then the external side is gone. It is a triple fault (conflict, I/O error, crash within the retry window). The sim records these texts (`SimDevice.crashLost`) and exempts exactly them from "destroyed".
- **Binary CAS is not atomic.** It is check-then-`modifyBinary`, narrowed by a stat recheck. Obsidian has no binary `process`.
- `editor:undo` from Obsidian's menu or command can undo remote edits. It is not routed through the Yjs undo manager.
- **Config dir:** there is no listing message and no config rename or trash.
- ESLint does not cover `src/host/**`.
- `obsidianWorkspace`, the y-codemirror attach and `plugin.ts` are tested against fakes, not against real CodeMirror 6 or Obsidian. The phone and desktop spike runs are the real check.
- **Sim coverage (§l), integration pending:**
  - relay faults (socket close points, relay restart/STREAM_RESEND, dedupe expiry);
  - storage crash points;
  - IDB wipe;
  - storms;
  - epoch change;
  - malicious frames;
  - invariant 4 (fold determinism);
  - the outbox/cursor/intent part of 5;
  - invariant 6 (resource bounds).

  The sim types only into bound views. The stand-in has no deletes or renames, so `STANDIN_OPS` sets them to weight 0 and `FULL_OPS` enables them at integration.
- **ci.yml** (not WP-D's file) does not run `npm run test:client`. The 200-seed suite runs from that command.

## Run log

| Run | Result |
|---|---|
| `npm run test:client` (200 seeds) | green, sim part about 18 s |
| `YAOS_SIM_SEEDS=1000` sim suite | green (final code) |
| `YAOS_SIM_SEEDS=3000` sim suite | 150/150 seed chunks green, about 4.5 min. Before the `tokenIdsIn` peel, fault-heavy seed 511 failed (`lost [A.53]`): interleaving, not loss (see Decisions) |
| `typecheck:client`, `check-deps` (0 errors, 1 stand-in warning), `esbuild.config.mjs production` + smoke | green |
| Merge check: `git merge-tree` of this branch with `client-remake` (6fa95f0, WP-A and WP-B merged) | clean; on the merged tree typecheck, check-deps, all client tests (50 seeds) and the production build + smoke pass |

Bugs the larger seed runs found and fixed, in order: the zombie engine after an app crash (seeds 35/64, `halting`); a dropped external side when a conflict-copy write failed (seed 16, retry with backoff); the bracket shift (1000 seeds, seed 974, identity matching); the crash-lost pending copy (seed 551, recorded gap plus exemption); the interleaved identity (3000 seeds, seed 511, peel).

