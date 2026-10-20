# Architecture

Status: overview for a new contributor, as of `sim-port` (2026-10-21). It names the parts and how data moves
between them, and links to the normative documents for detail:

- [client-remake/DESIGN.md](client-remake/DESIGN.md) ("DESIGN"): the plugin in `src/`. Section letters (§x.y)
  below refer to it.
- [client-remake/e2ee-design.md](client-remake/e2ee-design.md) ("e2ee-design"): crypto suite 1.
- [client-remake/relay-wire.md](client-remake/relay-wire.md): the client ↔ relay wire contract.
- [server-rewrite/DECISIONS.md](server-rewrite/DECISIONS.md): the server, its route table and storage.
- [client-remake/integration-notes.md](client-remake/integration-notes.md): how the parts were put together, bugs,
  deviations from DESIGN (§4) and honest gaps (§5).
- [sync-contract.md](sync-contract.md): what a user can rely on. [BACKLOG.md](BACKLOG.md): open work.

Where this page and those documents disagree, they win.

---

## 1. The shape in one paragraph

YAOS has two programs. The **server** (`server/`) is one Cloudflare Worker with two Durable Object classes and an
optional R2 bucket. It is an opaque relay: an authenticated, ordered, durable mailbox that sequences and stores
bytes it never decodes. The **client** (`src/`) is the Obsidian plugin. It owns all meaning: the namespace,
merging, validation, checkpoints, settings and snapshots. The client is split across two threads. The Obsidian main
thread (`src/host`) holds only CodeMirror state and raw disk I/O. A Web Worker runs the **engine**
(`src/engine`), which holds every Yjs document, the IndexedDB store and the network. Pure logic (`src/core`) is
shared by both and by the deterministic simulator (`src/sim`).

## 2. Layers

| Layer | Where | Owns | Never |
|---|---|---|---|
| core | `src/core` | Pure, total functions: envelope and op codecs, path rules and `pathKey`, the namespace fold (`ns/`), the settings fold (`cfg/`), the snapshot index and bundle format (`snap/`), the three-tree planner and brake (`plan/`), the one merge engine and minimal diff (`merge/`), canonical Markdown/Canvas hashes (`hash/`), limits (`limits.ts`), shared types (`types.ts`) | I/O, timers, `Date`, `Math.random`, Yjs, DOM (DESIGN §k.1, §k.2) |
| ports | `src/ports` | The interfaces between the engine and the world: `RelayPort` (contract R1–R7 in its header), `StoragePort`, `BlobPort`, `CryptoPort`, `HashPort`, `ClockPort`, `RandomPort`, `VaultPort`, `WorkspacePort`, `PlatformPort`, side files. Normative, with their doc comments (DESIGN §h) | Implementation |
| protocol | `src/protocol` | Main ↔ worker messages, status shape, errors, and two carriers: `workerTransport` (the product) and `inlineTransport` (tests, sim, harnesses only) (DESIGN §g) | Logic |
| engine | `src/engine` | Runs in the worker. `store/` (IDB schema and every transaction), `ingest/` (the one gate), `body/` (replicas, frame builder, sender, compaction, checkpoints), `sync/` (catch-up, cursor, fold runtimes), `runtime/` (session loop, live ingest, maintenance tick, mirrors, relay policy), `reconcile/` (scan, planner runs, merge jobs, intents), `blobs/`, `settings/`, `snapshots/`, `keyring/` (E2EE), `compose/` (wires it all: `ProtocolEngine`, `VaultRuntime`, `PassScheduler`, bound docs), `adapters/` (IDB, WebSocket + HTTP relay, HTTP blob, WebCrypto) | `obsidian`, `host/**`; browser globals outside `adapters/` |
| host | `src/host` | Obsidian main thread: `plugin.ts`, `PluginController`, `HostRuntime`, `EngineHost` (starts and watches the worker), `BindingManager` + `bodyClient`/`collab` (editors as clients of the worker replica), `DiskExecutor` (disk ops with preconditions), Obsidian vault/workspace/config-dir/side-file adapters, `keys/` (suite pin, SecretStorage), `ui/` | Yjs, `lib0`, `y-protocols`, hashing (`core/hash`), the in-process carrier, any `engine/**` module except `host/entry.ts` → `engine/workerMain` |
| sim | `src/sim` | In-memory relay, storage, vault, workspace, network and blob store on a virtual clock and seeded randomness; devices, actors, faults, invariants, the seeded runner and minimizer (DESIGN §l) | Being bundled or imported by product code |
| server | `server/src` | `router.ts` (route table), `vault/` (Vault DO: devices, pairing codes, bearer and ticket auth, revoke, reset, restore steps), `streams/` (store, relay, dedupe: sequencing, group commit, checkpoint CAS and row GC), `config/` (Config DO: operator credential, sessions, vault registry, restore journal), `console/` (operator console and mobile setup pages) | Decoding payloads, checkpoints, stream names or blob contents |

The import rules are enforced by `scripts/check-deps.mjs` in CI (`npm run check:deps`), including the transitive
`mainReach` check and the allow-list of whole-document reads on main (DESIGN §k.2).
`scripts/guard-no-real-time.mjs` keeps `src/core`, `src/engine` and `src/protocol` on `ClockPort` / `RandomPort`,
which is what makes the simulator deterministic.

**One bundle, one carrier.** `main.js` is a single esbuild bundle of `src/host/entry.ts`. The worker's script is the
bundle's own wrapper function source, started from a Blob URL; in the worker `entry.ts` starts only the engine
(DESIGN §g.1, integration-notes D2). There is no UI-thread fallback: if the worker cannot start, or IndexedDB cannot
open inside it, the runtime stops and says so (DESIGN §g.4, §g.5). A release is `main.js` + `manifest.json`.

## 3. Data model

- **Streams** (DESIGN §b.2). The relay holds per-vault streams of opaque rows, totally ordered by a contiguous
  vault-wide `seq`:
  - `ns`: the namespace. Ops `create`, `rename`, `delete`, `restore`, `setBlob`. Every device folds it the same
    way into `NsFoldState` (DESIGN §c). Paths, case folding and collisions are decided by the fold, never by a
    writer being rejected.
  - `b:<docId>` / `c:<docId>`: one Yjs document per note / canvas. The relay broadcasts these provisionally.
  - `cfg`: settings, LWW registers (DESIGN §c.11, §j.3). `snap`: the uploaded-snapshot index (§j.4). `k`: the E2EE
    keyring (e2ee-design §11).
  - No stream carries attachment bytes. Attachments, oversized updates and snapshot parts go to the blob store; the
    log carries only their hash and size (DESIGN §j.1).
- **Envelope** (DESIGN §b.1). Every payload is one envelope: a plaintext header (format, crypto suite, key epoch)
  and a sealed inner part (kind, `authorNsSeq`, flags, `frameNo`, content). Suite 0 is identity; suite 1 is
  AES-256-GCM with Padmé padding and an AAD binding vault, stream, device and frame id (e2ee-design §7).
- **Checkpoints** (DESIGN §b.5, §d.9) are client-written state covering a stream up to `coversSeq`, put by CAS. They
  let the relay garbage-collect rows. Body checkpoints are unioned into local state; ns/cfg/snap checkpoints are
  verified (canonical re-encode plus structural invariants) before they replace a fold.
- **vaultEpoch** is the relay's vault generation. Seqs mean nothing across epochs. Operator reset and restore mint
  a new one; the client then migrates (DESIGN §c.12).

## 4. Data flow

### 4.1 An edit in an open note

1. Each CodeMirror transaction's `ChangeSet` goes to the view's client on main (`host/bodyClient.ts`) and leaves,
   coalesced ≤ 16 ms, as `bodyPush` (changed ranges and inserted text only) (DESIGN §d.3).
2. The worker applies a push that fits as one Yjs transaction on the **only** replica of that note
   (`compose/boundBody.ts`), and sends the resulting entry to every other view of the doc.
3. The frame builder batches updates (100 ms idle / 300 ms max) and `T_edit` commits an **outbox** record to
   IndexedDB *before* the frame is sent (DESIGN §d.4, §e.2). Until then the edit is durable through Obsidian's own
   save of the file, which the engine never writes for a bound note.
4. The sender sends by rank (bound bodies first) under a token bucket and in-flight budget (DESIGN §i.1, §i.6). The
   relay group-commits (relay-wire §5.1), broadcasts, then returns a receipt; `T_receipt` moves the record from the
   outbox to the local tail.
5. On a peer, the row passes the **ingest gate** (verify → decode in scratch → check → apply, or quarantine;
   DESIGN §d.6). If the note is open it reaches the editor as an entry, rebased over unconfirmed local changes and
   applied outside undo history; otherwise the doc is marked dirty and the planner writes it to disk.

### 4.2 A file event (external edit, create, rename, delete)

1. The host's vault feed turns Obsidian events into `vaultEvents` hints; a startup or periodic scan sends the full
   listing as `observations` (DESIGN §f.6). Events only mark paths dirty (invariant I6).
2. The engine hashes what changed (the host never hashes) and runs the pure planner over three trees: **R**emote
   (the committed fold plus own pending ops), **L**ocal (the disk, a stat cache confirmed by hash) and **S**ynced
   (the last state known equal on both, the merge base) (DESIGN §f.1, §f.2).
3. The plan is checked by the **safety brake** (DESIGN §f.5), then run: ns ops become `nsOps` frames; content
   changes run the one merge engine (diff3 over texts, applied to Yjs as a minimal diff under a CAS; DESIGN §f.3);
   disk ops go to the host as `diskOps` batches, each with a write precondition (DESIGN §f.2).
4. Writes, renames and trashes the engine asked for are recorded for echo suppression (DESIGN §f.4); a periodic
   full reconcile (5–15 min by device class, backing off while idle) catches anything the watcher missed.

Remote namespace changes take the reverse path: the fold's outcome changes R, the next pass plans
`diskRename` / `diskMaterialize` / `diskTrash`, and own ops that lost a race (suffixed, merged, `rev-mismatch`)
become loser renames, rebinds or keep-both copies (DESIGN §c.13).

### 4.3 Attachments and settings

- **Attachments** (DESIGN §j.1): upload the sealed bytes to R2 first, then commit the `create` / `setBlob` that names
  their hash. Transfers run in a background queue under a byte budget, with persisted backoff. Without an R2 binding
  attachments are not synced at all (fail closed).
- **Settings** (DESIGN §j.3): allow-listed files under the config dir sync through `cfg`, JSON per top-level key,
  other files whole, picked up on full passes and focus.

## 5. Local storage

- **IndexedDB**, one database per `(vaultId, vaultEpoch, deviceId)`, opened in the worker (DESIGN §e). Stores:
  `meta`, `streams`, `snapshots` + `tail` (committed rows, compacted locally, DESIGN §d.8), `outbox` (never
  evicted), `quarantine`, `synced` + `baseText` (the S tree and merge bases), `localTree` (the L stat cache),
  `intents` (multi-step disk ops), `cfgBase`, `blobQueue`. IDB is a rebuildable cache, not the source of truth.
- **Side files** in `<configDir>/plugins/yaos/state/` (DESIGN §e.4): A/B **outbox mirror** (keeps frame identity
  across IDB loss), A/B **synced mirror** (tells "unchanged since sync" from "edited offline" after IDB loss), and
  local snapshot parts. IDB loss recovery imports them (DESIGN §i.5).
- **Keys** (suite 1) live in Obsidian SecretStorage, never in IndexedDB or `data.json` (e2ee-design §6).
- **Snapshots** (DESIGN §j.4): zip bundles of the vault's files kept on the device (daily, and before brake approval,
  epoch migration, IDB recovery and restore), optionally uploaded as blobs and indexed in `snap`.

## 6. The relay

- Routes (DECISIONS §2.2): claim and operator console (Config DO); enroll by one-time pairing code; a device bearer
  for HTTP routes; a short-lived ticket for the streams WebSocket (`GET /vault/:id/ws/streams`); feed, read and
  checkpoint over HTTP; blobs over HTTP to R2.
- Semantics (relay-wire §5): appends from every socket are group-committed in one transaction (300 ms idle,
  1.5 s max, 64 KiB, a leading-edge commit for an isolated edit, at most about one commit per second per vault),
  receipts go out only after the commit, `(deviceId, clientFrameId)` appends are idempotent within a dedupe
  window, `b:`/`c:` appends are broadcast provisionally, and subscriptions decide which body rows are pushed and
  which arrive as skips to read later (§5.6).
- Operator actions (DECISIONS D7, D8a, D8b): revoke a device, reset streams, point-in-time restore, delete a vault.
  Reset and restore change the vaultEpoch.
- Budget: designed for the Workers Free plan (100k rows written a day); the client meters its own writes (daily soft
  budget, checkpoint settle caps) and holds on the relay's daily-limit latch (DESIGN §i.6, §d.9).

## 7. E2EE at a glance

Suite 1 is chosen once, on the "Create a new vault" path, and never changes for that vault (e2ee-design §15). Each
key epoch has a random 32-byte key; HKDF derives per-purpose subkeys. The keyring stream `k` carries wrapped keys
(backward chain for new devices, forward chain for automatic rolls). New devices get the key from a plugin-drawn QR
or link (the server-visible pairing code carries no key) or from the 56-character recovery key. Revoking a device is
an operator action followed by a re-key on a kept device; frames sealed under an older epoch that commit after the
revoke are ignored. Blob addresses are `HMAC(kAddr, sha256)`. ns/cfg replay is rejected by a sealed per-device
`frameNo` with a 64-wide window (e2ee-design §8.2). The threat model and what the server can still do are in
e2ee-design §2.

## 8. Tests

| Command | What runs | Where |
|---|---|---|
| `npm run test:client` | Every `src/**/*.test.ts` except `*.sim.test.ts`, under `node:test` through jiti: unit tests, composed-engine tests, the first seeds of every sim matrix (`src/sim/smoke.test.ts`) and the committed regression plans (`src/sim/regressions/`) | CI job `client`, with `typecheck:client`, `check:deps`, `guard:no-real-time` |
| `npm run test:sim` | Every `*.sim.test.ts`: the sim matrices (`src/sim/testkit/sweep.ts`, 200 seeds at the base count) and measured runs, one process per unit, costliest first. `YAOS_SIM_SEEDS`, `YAOS_SIM_FIRST`, `YAOS_SIM_SHARD`, `YAOS_SIM_JOBS` | CI job `sim`, 3 shards |
| `npm run test:ci` | Repo guards plus every suite under `tests/server/` and `tests/contracts/` (`tests/run-suites.mjs`): the relay, auth, console, blobs, reset/restore | CI job `build`, with `build`, `typecheck:tests`, `guard:no-any` and the server typecheck |
| nightly `sim-soak.yml` | `sim:soak` (one process per core, swarm profiles: random fault subsets, storms, randomized tuning, canvas, suspend) and the CI matrices at 1000 seeds from a random first seed over 4 shards; skipped when nothing the sim exercises changed | GitHub schedule |

- **The simulator** (DESIGN §l, `src/sim/run.ts`). Each device is the real composed engine over the inline carrier,
  with a simulated vault, workspace and storage, all on one virtual clock with seeded randomness (Yjs client ids
  included), so a seed reproduces exactly. `SimRelay` mirrors `server/src/streams` message for message. Actors type,
  edit files, rename, delete, import, paste, use attachments and settings; faults drop sockets, restart the relay,
  crash commits and apps, wipe IndexedDB, reset the epoch, skew clocks and stall blobs. After healing the run checks
  the quiescence invariants (DESIGN §l.3: convergence, no lost edit, nothing destroyed without a copy, fold
  determinism, clean state, bounds, no blobs on the log). A failure is minimized by ddmin; `npm run sim:replay`
  replays a saved plan. `src/sim/coverage.ts` counts which engine paths a run exercised; the keys still at zero are
  listed in [wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues".
- **Other runners.** `npm run test:sim-suite1` (the matrices under suite 1 plus the E2EE fault matrix),
  `scripts/sim-suspend.mjs` (the background flush budget), `npm run bench:e2ee`, and the end-to-end harnesses under
  `e2e/` (full clients against a local or deployed relay; integration-notes §7). Real-device runs are manual
  (integration-notes §9).
