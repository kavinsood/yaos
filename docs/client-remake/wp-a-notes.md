# WP-A notes: fold, codecs, paths, sim log

Branch `client-remake-wp-a` (worktree `experiments/yaos-client-wp-a`). All six acceptance criteria of DESIGN §k.3 WP-A
pass. `npm run typecheck:client` and `npm run test:client` are green.

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Codecs round-trip; canonical re-encode rejects non-minimal input; malformed ns/cfg frames fold as empty | done (`codec.test.ts`, `folds.test.ts`, `cfg.test.ts`) |
| 2 | E1–E12 (§c.14) as unit tests | done (`core/ns/fold.test.ts`) |
| 3 | 10k-op fold fuzz (§l.4), 1000 seeds | done: 1000 seeds × 10 000 ops, **PASS, 1700.2 s wall** |
| 4 | pathKey: ß/ss, Σ/σ/ς, İ, NFC/NFD, unassigned rejected; tables reproducible from UCD 15.1 | done (`paths.test.ts`, `scripts/gen-casefold.mjs --check`) |
| 5 | `SimRelay` conforms to relay-wire.md | done (`src/sim/relay*.test.ts`, 26 tests) |
| 6 | `MemStoragePort` crash semantics and tx-inactive detection | done (`storage.test.ts`) |

## Commits

```
1cf29ea paths: frozen Unicode 15.1 case-fold + assigned tables (generator), pathKey, §c.2 validation
b2b0e6c codecs: strict lib0 reader/writer, ids, envelope, nsOps, cfgOps, checkpoint/blobChunk/bodyUpdateRef
a3bf1e5 codecs: nsFoldV1, cfgFoldV1 (layout defined), outbox/synced side-file mirrors
2739cd3 ns fold: placement, op rules, dedupe ring, prune, upgradeRules halt, V1/V2 verify, V3 candidates, overlay; E1-E12
74ae133 10k-op ns fold fuzz; faster path validation
f85dff7 cfg fold, canonical JSON, projection helpers, cfg fuzz
7132125 sim VirtualClock and SeededRandom
4b85710 sim MemStoragePort; clock.beforeNextTimer
927f464 SimRelay: engine, store, session/adapter, links, faults; core delivery tests
4c41277 SimRelay conformance tests (dedupe, faults, closes, HTTP); env daily latch lifts with the env
```

(Each commit is prefixed `client-remake(wp-a):`. There is also this notes commit.)

## Files built

Core. These are pure: no I/O, timers, Date, Math.random, yjs, DOM or node imports. They typecheck under the strict
tsconfig.

- `src/core/paths/`:
  - `casefold15_1.ts`, `assigned15_1.ts` (generated);
  - `pathKey.ts` (`caseFold15_1`, `foldKey`, `pathKey`, `prefixKeys`);
  - `validate.ts` (§c.2 rules, `pathInvalidReason`, `segmentInvalidReason`, `isValidPath`, `isAssigned15_1`);
  - `segments.ts` (byte length, split, leaf/parent, ext, trims).
- `src/core/codec/`:
  - `lib0.ts`: strict `Reader`/`Writer`, `CodecError`, utf8, hex, `bytesEqual`, `concatBytes`, `compareCodeUnits`;
  - `ids.ts`: base64url, docId/clientFrameId/contentHash checks, `newDocId`/`newClientFrameId` on a RandomPort;
  - `envelope.ts`: outer/inner, bounded inflate, AADs, `checkBinding`, `sealEnvelope`/`openEnvelope`, `identityCrypto`;
  - `nsOps.ts`, `cfgOps.ts`;
  - `contents.ts`: checkpoint, blobChunk (later deleted with the `x:` carrier), bodyUpdateRef;
  - `nsFoldV1.ts`, `cfgFoldV1.ts`;
  - `mirrors.ts`: outbox/synced side-file mirrors, `pickMirror`.
- `src/core/ns/`:
  - `fold.ts`: `foldNsFrame`, `foldNsFrameWith`, `NsFoldRules`, `nsFoldHalted`;
  - `index.ts`: state/index constructors, `buildIndex`, `cloneNsFold`, `indexesEqual`;
  - `place.ts`: placement, suffixes, recases;
  - `overlay.ts`: `overlayPending`;
  - `verify.ts`: V1/V2;
  - `candidate.ts`: V3 candidate seqs and digest ring.
- `src/core/cfg/`:
  - `fold.ts`: LWW fold, op checks, `overlayPendingCfg`, register keys;
  - `json.ts`: canonical JSON;
  - `projection.ts`: JSON key projection/diff, community-plugins, data.json gate;
  - `verify.ts`: cfg V1/V2.

Sim. No node imports; these also typecheck under the strict tsconfig.

- `src/sim/clock.ts`: `VirtualClock`, `realMacrotask`, `realMacrotaskCallback`, `DEFAULT_WALL_START_MS` (2026-01-01Z).
- `src/sim/random.ts`: `SeededRandom` (sfc32), `hashLabel`.
- `src/sim/storage.ts`: `MemStoragePort` (IDB semantics, crash/commit hooks, tx-inactive), `compareKeys`, `memStorageError`.
- `src/sim/relay.ts`: `SimRelay` (the `RelayPort`) and re-exports. Implementation modules:
  - `a-relay-util.ts`: limits, options, wire messages, sizes, validation;
  - `a-relay-link.ts`: FIFO `TimedQueue`;
  - `a-relay-store.ts`: segment store, dedupe window, feed/read, checkpoint CAS + GC;
  - `a-relay-session.ts`: socket plus wsRelay-style adapter;
  - `a-relay-engine.ts`: admission, group commit, fan-out, faults;
  - `a-relay-testkit.ts`: `connectPeer`, `frame`, `trace`, `pump` (usable by WP-D sims).

Script: `scripts/gen-casefold.mjs [--ucd DIR] [--check]`. It downloads `CaseFolding.txt` and `DerivedAge.txt` 15.1.0 into
a temp dir; the raw UCD files are never committed. `--check` regenerates in memory and fails on any diff.

## Tests

`npm run test:client` (whole WP-A tree): **97 tests, 0 failures, 7.5 s wall** (user 11.8 s).

| File | Tests | Covers |
|------|------:|--------|
| `core/paths/paths.test.ts` | 12 | ß/ẞ/SS, Σσς, İ/ı, NFC/NFD, legacy collision fixtures, ASCII fast path, table well-formedness, unassigned/post-15.1, §c.2 rules, byte limits |
| `core/codec/codec.test.ts` | 10 | lib0 strictness, ids, envelope (seal/open, AAD, binding, bounded inflate), nsOps/cfgOps, contents |
| `core/codec/folds.test.ts` | 5 | nsFoldV1/cfgFoldV1 canonical round-trip and rejection, mirrors |
| `core/ns/fold.test.ts` | 22 | E1–E12, op rules, prune, halt, V1/V2, V3 candidates, overlay |
| `core/ns/fuzz.test.ts` | 2 | 10k-op fuzz (default 4 seeds) and generator coverage of every outcome |
| `core/cfg/cfg.test.ts` | 9 | cfg fold, V1/V2, projection, community-plugins, data.json gate, cfg fuzz (20 seeds, about 1.8 s) |
| `sim/clock.test.ts` | 4 | (dueAt, insertion) order, promise chains settle between timers, runUntil/runUntilIdle, onError, heap churn |
| `sim/random.test.ts` | 2 | pinned sequences (WP-D stand-in compatible), fork |
| `sim/storage.test.ts` | 5 | IDB auto-commit / tx-inactive, microtask chains never trip it, nested tx without deadlock, crash-before/after, quota, lose-connection, crash at every commit boundary = consistent prefix |
| `sim/relay.test.ts` | 5 | R1/R2/R3 ordering, group-commit timers, provisional/notice join, buffering and close, R2 random fuzz (5 seeds) |
| `sim/relay-dedupe.test.ts` | 4 | pending dedupe/conflict, store dedupe + R7 older-seq notice, dedupe window expiry (R4), batch dedupe, pre-seal |
| `sim/relay-faults.test.ts` | 5 | restart (STREAM_RESEND loss), restart-before/after, commit hook, durability, daily limit (latch and env) |
| `sim/relay-close.test.ts` | 7 | 1009, 1008, 1013 token bucket, write_forbidden, 4403 supersede/revoke, 1006 drop, 1001 drain, connect failures, resetEpoch, link FIFO/serialization |
| `sim/relay-http.test.ts` | 5 | feed paging, read paging (bytes/rows), checkpoint CAS order + GC + R5 read rules, arrival-time HTTP, network_error |

### Fuzz timing

The fuzz is configured by environment variables:

```
YAOS_FUZZ_SEEDS=1000 npm run test:client -- core/ns/fuzz   # full run (default: 4 seeds)
YAOS_FUZZ_SEED=123   npm run test:client -- core/ns/fuzz   # reproduce one seed (failures print this line + a ddmin-minimized frame list)
YAOS_FUZZ_SEED_START=500 / YAOS_FUZZ_OPS=10000              # shard offset / ops per seed
YAOS_CFG_FUZZ_SEEDS=200 npm run test:client -- core/cfg     # cfg fuzz (default 20)
```

The 1000-seed run used commit 74ae133; no ns, paths or codec code changed after it. It ran in one process:
`YAOS_FUZZ_SEEDS=1000 node --import jiti/register --test --test-name-pattern=seed src/core/ns/fuzz.test.ts`.

- Result: `ns fold fuzz: 1000 seeds x 10000 ops in 1700.2 s`, PASS.
- Timing: real 1701.14 s, user 1739.16 s, sys 14.73 s.
- That is about 1.7 s per 10k-op seed.

What the fuzz does per seed:

- 3–8 devices emit frames against lagged snapshots of the fold.
- Inputs are adversarial:
  - a casefold/NFC/reserved-name path alphabet;
  - resends inside and outside the ring;
  - malformed frames;
  - rare upgradeRules;
  - a small tombstone cap on half the seeds.

What it checks:

- every V2 invariant after every frame;
- the incremental index equals the rebuilt one;
- at 50 cut points, `decode(encode(state))` plus folding the rest gives the same final bytes;
- folding the whole sequence twice gives identical bytes and events;
- a failure prints the seed and a delta-debugged minimal frame list.

## Deviations from DESIGN

These are deliberate. Each was decided without asking, as the brief allowed.

1. **cfgFoldV1 layout is defined by WP-A.** §b.5 only says "same shape as nsFoldV1". The layout (`src/core/codec/cfgFoldV1.ts`) is:
   - varuint formatVersion=1, varuint coversSeq;
   - the device rings, as in nsFoldV1;
   - json registers keyed by `file\0topLevelKey`, then file registers, then plugin registers;
   - each register list is sorted ascending and holds `u8 present`, an optional value, and a version;
   - a version is `(varuint seq, varuint index, varstring deviceId)`.
2. **Mirrors take a hash port.** The outbox/synced mirror codecs live in `core/codec/mirrors.ts`.
   - They use local structural types, because core cannot import `engine/store/schema.ts`.
   - They take an async `Pick<HashPort, "sha256">` for the checksum, because core has no sha256 of its own.
   - V3 digests (`nsFoldDigest`) take the same parameter.
3. **SimRelay is port-level, not wire-level.**
   - `SimRelaySession` plays the wsRelay adapter's role: wire message → `RelayEvent` (held PROVISIONALs, notice join, receipts → head, VAULT_ERROR → refused).
   - The server-side semantics are mirrored from `server/src/streams` (store.ts, relay.ts).
   - WP-C's real wsRelay adapter is therefore not exercised by SimRelay (see gaps).
4. **STREAM_RESEND is eager.** `restart()` sends STREAM_RESEND{head} to every open socket at once. The server sends it lazily, on the socket's next message or accept after a wake. The client-visible sequence is the same.
5. **Extra sim modules.** DESIGN lists `src/sim/{relay,storage,clock,random}.ts`. The relay is split into `a-relay-*.ts` helpers to stay reviewable; `relay.ts` is the public entry.
6. **V2 does not bound `deleteBaseBodySeq` by coversSeq.** It is author-supplied, not a fold seq.

## Decisions

### Codec

- **Strict varuints.** Non-minimal varuints are malformed everywhere: frames, folds and mirrors. So are values above 2^53−1.
  - lib0's `readVarUint` accepts non-minimal input, and lib0's string encoder is inconsistent on lone surrogates.
  - So `lib0.ts` is a custom strict Reader/Writer. Tests show it is byte-compatible with lib0.
- **Strings.** `Writer.varstring` refuses lone surrogates. The reader uses fatal UTF-8 decoding. A BOM is kept.
- **Envelope rules:**
  - suite 0 with keyEpoch ≠ 0 → malformed;
  - unknown kind code → malformed;
  - unknown formatVersion → unsupported-version; suite ∉ {0,1} → unsupported-suite. Both halt the reader.
  - Unknown flag bits are ignored. Decoded content is uncompressed; flags are kept as on the wire.
- **Deflate.** Empty or invalid deflate, or inflating past the bound, → malformed.
  - Inflate is streaming fflate in 4 KiB input chunks.
  - The bound defaults to `max(64 MiB, MAX_DOC_TEXT_CHARS*3 + 1 MiB)`.
- **Checkpoints.** A coversSeq mismatch, or an encoding not allowed for the stream class, → `kind-stream-mismatch`.
- **Ops.** `decodeNsOps` / `decodeCfgOps` return `null` when malformed; the caller folds the frame as `ops: []`. nsOps bodies tolerate forward-compatible tails.

### Paths

- Surrogates and noncharacters are excluded from the assigned table.
- Full case folding uses statuses C and F, with no Turkic T mappings: İ → `i` + U+0307, and ı stays distinct.
- Reserved-stem comparison uses ASCII lowercasing. This is safe because no non-ASCII character folds into those letters.
- pathKey is segment-wise. Folder prefix keys come from `prefixKeys`.

### ns fold

- **Old frames.** `seq <= coversSeq` returns `[]` and changes nothing (a caller error).
- **upgradeRules halt.** The upgradeRules pre-scan runs before dedupe.
  - A halt returns exactly one `ignored/rules-version` event: index = the offending op, docId null.
  - The state, including coversSeq, is unchanged. `nsFoldHalted(events)` detects a halt.
  - A known upgradeRules is noop if its version ≤ foldRulesVersion. Otherwise the version is set → applied (docId null).
- **Duplicates and malformed frames.** A duplicate frame gives one frame-level event, and coversSeq still advances. A malformed frame (`ops: []`) enters the ring and advances coversSeq.
- **restore** also checks invalid-path / kind-mismatch, after restore-not-current, the same as rename.
- **Ancestor collisions.** An ancestor that is a live file gives `seg (n)` for n = 2..10000, trimmed to the byte budget. An empty segment → invalid-path.
  - A path over a byte limit after ancestor adjustment is treated as a leaf collision and goes through the suffix loop.
- **Case-only renames.** A caseOnlyRename recase is skipped (the existing casing is adopted) if any affected path would exceed 1024 bytes.
  - Recases are deferred until the leaf succeeds.
  - Recased entries keep their lastTouchSeq.
- **Leaf suffixes.** The forms are tried in order: ` (n)`, then ` (docId[0..8])`, then ` (docId)`.
  - The stem is trimmed by code points. Trailing dots and spaces are stripped only when the stem was trimmed.
  - Each candidate is checked with `segmentInvalidReason`, plus an NFC check when trimmed.
- **Identical creates.** A create that duplicates a live entry (same kind, contentHash ∈ {createHash, blob.hash}) → merged.
- **Prune.** Tombstones are sorted by (lastTouchSeq, docId).
  - A deleted target's aliases are removed before it, even if that overshoots below CAP − HYSTERESIS.
  - There is one `pruned` event, with docIds in removal order, index −1 and docId null.
- **Event docIds.** unknown-docid and duplicate-docid events carry `op.docId`. Other events carry the target after alias redirect.
- **V2 strictness:**
  - deleted entries: `deletedSeq === lastTouchSeq`;
  - merged entries: `createdSeq === lastTouchSeq` and the same kind as the target;
  - path validity is checked for every entry; the kind check only for live and deleted entries.
- **Rules override.** `NsFoldRules` (tombstone cap, hysteresis, ring size, knownRulesVersion) exists for tests and the fuzz. Production calls `foldNsFrame`.
- **Overlay.** `overlayPending` folds a clone with pseudo-seqs `coversSeq + 1 + i`.
- **Fuzz replays.** A halting frame is a no-op row in replays.

### cfg fold and projection

- **No allowlist.** The fold rejects only structurally invalid ops (`invalid-op`):
  - a bad config path or plugin id;
  - valueJson that is not canonical JSON (sorted keys, compact);
  - a bad blob hash.
- **Versions.** A write with an equal value still bumps the version (`same`). Deleting an absent key creates a tombstone. `stale` is only a guard.
- **Shared rules.** The ring and coversSeq rules are the same as ns. The cfg checkpoint header has foldRulesVersion 1. The op index bound reuses `MAX_NS_OPS_PER_FRAME`.
- **Projection:**
  - an unparsable local file is never overwritten;
  - untouched values are re-serialized, accepting big-int precision loss;
  - new keys are appended in sorted order;
  - output is 2-space JSON.
- **community-plugins.** A removal becomes `enabled:false`. `yaos` is excluded. Ids are sorted.
- **data.json gate.** Two-way equality: the local manifest version must equal the op's pluginVersion. There is no legacy intent pin.

### Clock and random

- **API-compatible supersets** of WP-D's stand-ins (`src/sim/__standins__/{clock,random}.ts` there), so integration is an import swap. SeededRandom sequences are pinned identical by a test.
- **VirtualClock time.** `now() = wallStart + monotonic + skew`; `skewWall(ms)` moves wall time only.
- **Settling.** Before every timer, the loop awaits one real macrotask, so promise chains settle before virtual time moves.
- **`beforeNextTimer(fn)`** runs fn before virtual time next moves. MemStoragePort uses it for its idle check.

### MemStoragePort

- **Superset of WP-C's stand-in** (`src/engine/sync/__standins__/memStorage.ts` there).
- **Auto-commit by default.** The default `inactive: "idb"` emulates IndexedDB auto-commit. When a tx body awaits something foreign (no own request pending at the macrotask/beforeNextTimer check), the tx commits its writes so far, and later ops throw tx-inactive.
  - WP-C's stand-in only detected this after the body settled.
  - One WP-C stand-in test sleeps inside a tx; it needs `inactive: "off"`.
  - Scratch run against WP-C's tests: storage conformance 44/44; stand-in tests 10/11 in idb mode and 11/11 in off mode.
- **Sims must pass `beforeNextTimer: clock.beforeNextTimer`.**
- **Added commit decisions:**
  - `quota`: the tx rejects with quota, and the port stays alive;
  - `lose-connection`: every handle of the db closes abnormally.
- **Crashes.** `crash()` returns a new port holding exactly the committed state. `requestPersistence()` always returns true.

### SimRelay

- **Server mirroring:**
  - Group commit uses real ClockPort timers: idle 300 ms, re-armed per admission; max 1500 ms from the first pending frame; pending payload ≥ 64 KiB commits immediately.
  - The token bucket runs on `clock.monotonic()`.
  - The dedupe window and GC are segment-based, exactly as the server: open segment plus the newest sealed segment while open rows < tail rows; pre-seal before 1.5 MB; seal after a commit at ≥ 64 KiB.
  - The checkpoint CAS order is stream_not_found → conflict → not_advancing → ahead_of_stream. Before the CAS come forbidden, invalid args, too-large and the daily limit.
  - GC deletes sealed segments with lastSeq ≤ coversSeq, never the open one.
- **Options:**
  - `dedupeWindow` means tail rows (server `STREAM_DEDUPE_TAIL_ROWS`), not WP-C's "last N rows of the stream".
  - `sealBytes` is configurable, so window expiry and GC are testable.
- **Sockets and HTTP:**
  - `bufferedBytes()` = uplink bytes not yet delivered to the relay.
  - Per-socket FIFO links: uplink/downlink delay, seeded jitter, `uplinkBytesPerSec`, httpMs, connectMs.
  - HTTP is answered from the state when the request arrives (after httpMs), not from a call-time snapshot.
- **Restart** resets the daily latch and the rate gates (both are per runtime). Pending frames are lost with no receipt.
- **`restart-after` fault.** Rows are written with no fan-out. Origins resend and get a deduped receipt. Commit-only peers recover via resendUnreceipted{head} → feed. This is a real server outcome.
- **Daily limit:**
  - `failNextCommit("daily-limit")` with no retryAfterMs latches until the next 00:00 UTC. WP-C's stand-in defaulted to 60 s.
  - `setDailyLimit(true, ms?)` models the Cloudflare-side limit. Commits fail even after a restart. A latch triggered by it lifts when the env does.
  - `connect()` is never auto-refused for the daily limit; use `setConnectFailure("daily-limit")`.
- **Defaults and test controls:**
  - `settled()` polls every 1 ms of clock time (pump a VirtualClock), with maxTurns 1e6.
  - Listener exceptions are rethrown via queueMicrotask, overridable with `onListenerError`.
  - There are no automatic liveness pings; `ping(target)` delivers a pong as a `head` event.
  - Over `maxSockets`, connect → `unavailable`, retryAfterMs 1000.

## Frozen-file changes

None. Nothing under `src/ports/**`, `src/core/types.ts`, `src/protocol/**`, `docs/client-remake/{DESIGN,relay-wire}.md`,
`package.json` or the tsconfigs was edited. No npm dependencies were added. fflate is the existing dependency.

## Known gaps

- **SimRelay is port-level only.**
  - There is no wire framing, ticket mint or WebSocket upgrade. WP-C's `wsRelay` adapter needs an e2e test against the real relay (`server/`, wrangler dev).
  - `vaultId` is ignored: one SimRelay is one vault.
  - There are no ping or idle timeouts.
  - `update-required`, `unclaimed` and `not-found` only arise via `failNextConnect` / `setConnectFailure` / `inject`.
  - There are no blob routes.
  - `connect()` is not refused automatically under the daily limit.
  - RESEND is eager (see deviations).
- **After a `restart-after` fault**, commit-only peers only recover through `resendUnreceipted{head}` → feed. That is correct behaviour, but tests must pump it.
- **`flush()` / `settled()` need the VirtualClock pumped** (`pump(clock, p)` in `a-relay-testkit.ts`, or `clock.runUntil`).
- **MemStoragePort's tx-inactive detection is heuristic.** It assumes "no own request pending at a real macrotask or beforeNextTimer" means a foreign await. Real IDB is stricter in some engines and looser in others; the true check is the on-device harness.
- **Storage limits are not modelled.** `requestPersistence()` is always true, and there is no eviction. Quota exists only via the commit hook.
- **Fuzz coverage:**
  - `npm run test:client` runs 4 seeds by default. The 1000-seed run (`YAOS_FUZZ_SEEDS=1000`, about 28 min) is manual, not CI.
  - The cfg fold fuzz is 20 seeds × 300 frames (`YAOS_CFG_FUZZ_SEEDS`).
- **Timing is desktop node only.** There are no mobile numbers.
- **The case-fold generator** (`scripts/gen-casefold.mjs`) needs network access to unicode.org, or `--ucd <dir>`. The table is checked in. `--check` diffs it, and the paths test pins well-formedness and the entry count (1530).

## Integration needs

### Swaps for WP-C and WP-D stand-ins

- **WP-D clock and random stand-ins → `src/sim/clock.ts` / `src/sim/random.ts`:**
  - an import swap;
  - same constructor shapes;
  - SeededRandom output is identical for the same seed.
- **WP-C memStorage stand-in → `src/sim/storage.ts`:**
  - `new MemStoragePort({ beforeNextTimer: clock.beforeNextTimer })` in sims;
  - plain `new MemStoragePort()` in unit tests;
  - the one stand-in test that sleeps inside a tx needs `{ inactive: "off" }`.
- **WP-C relay stand-in → `src/sim/relay.ts`:**
  - Pass `clock` (a VirtualClock) where the stand-in took `schedule`.
  - For the stand-in's immediate commits, use `groupCommit: { idleMs: 0 }`, or `autoCommit: false` + `commitNow()`.
  - `dedupeWindow` counts tail rows (segment rule), not stream rows.
  - Without an explicit retry, `failNextCommit("daily-limit")` / `setDailyLimit(true)` retry at the next UTC midnight, not after 60 s.
  - `SimSessionInfo` gained `ordinal`.
  - `dropSession` / `supersede` take a `SimTarget` (`DeviceId | sessionId`).

### Exports

core/paths (`src/core/paths/index.ts`):
```ts
caseFold15_1(s: string): string; foldKey(s: string): string            // NFC + case fold
pathKey(path: VaultPath): PathKey; prefixKeys(path: VaultPath): PathKey[]   // every prefix incl. the path, shallow first
pathInvalidReason(path: string): PathInvalidReason | null; isValidPath(path: string): boolean
segmentInvalidReason(seg: string): PathInvalidReason | null; isAssigned15_1(cp: number): boolean
```

core/codec:
```ts
class Reader / Writer / CodecError                                       // strict lib0-compatible
encodeOuter/decodeOuter, encodeInner/decodeInner(plaintext, maxContentBytes = DEFAULT_MAX_CONTENT_BYTES), inflateBounded(z, maxBytes)
frameAad, checkpointAad, bindingAad, checkBinding
async sealEnvelope(crypto, input: SealInput) / openEnvelope(crypto, input: OpenInput) ; identityCrypto  // suite 0
encodeNsOps/decodeNsOps(bytes): NsOp[] | null ; encodeCfgOps/decodeCfgOps(bytes): CfgOp[] | null
contents encode/decode (doc / blob / cfg-file / plugin payloads)
encodeNsFoldV1, decodeNsFoldV1, decodeNsFoldV1Strict ; encodeCfgFoldV1, decodeCfgFoldV1, decodeCfgFoldV1Strict
encodeOutboxMirror/decodeOutboxMirror, encodeSyncedMirror(m, hash)/decodeSyncedMirror, pickMirror
newDocId(random: RandomPort): DocId ; newClientFrameId(random): ClientFrameId
```

core/ns:
```ts
foldNsFrame(state, index, frame: NsFrame): NsFoldEvent[]               // mutates state + index
foldNsFrameWith(rules: NsFoldRules, state, index, frame): NsEvent[] ; DEFAULT_NS_FOLD_RULES ; nsFoldHalted(events)
newNsFoldState(), newNsFoldIndex(), buildIndex(state), cloneNsFold(state, index)
overlayPending(state, index, deviceId, frames: PendingNsFrame[], rules?): NsOverlay   // {state,index,events,touched,halted}
checkNsInvariants(state, index), verifyNsFoldState(state), verifyNsFoldBytes(bytes, expectedCoversSeq), verifyNsCheckpoint(content, relayCoversSeq)
isCandidateSeq(seq), async nsFoldDigest(state, hash), recordDigest(ring, seq, digest), checkDigest(ring, seq, digest): "match"|"mismatch"|"unknown"
NS_CANDIDATE_INTERVAL = 1000, NS_DIGEST_RING = 16
```

core/cfg:
```ts
foldCfgFrame(state, frame: CfgFrame): CfgFoldEvent[] ; foldCfgFrameWith(rules, state, frame) ; CFG_FOLD_RULES_VERSION = 1
newCfgFoldState(), cloneCfgFold(state), jsonRegisterKey(file, key), splitJsonRegisterKey(k), isValidCfgOp(op)
changedRegisters(events), overlayPendingCfg(state, deviceId, frames)
canonicalJson(value), canonicalizeJsonText(text), isCanonicalJson(text)
projectJsonFile, diffJsonFile, applyJsonKeys, projectCommunityPlugins, diffCommunityPlugins, readCommunityPlugins,
canApplyPluginData, enabledPlugins
checkCfgInvariants(state), verifyCfgFoldBytes(bytes, expectedCoversSeq), verifyCfgCheckpoint(content, relayCoversSeq)
```

sim/clock and sim/random:
```ts
class VirtualClock implements ClockPort {
  constructor(wallStartMs = DEFAULT_WALL_START_MS)                       // 2026-01-01T00:00Z
  now(); monotonic(); skewWall(ms); setTimer(delayMs, fn, label?); clearTimer(h); yieldNow(); sleep(ms)
  pendingTimers(); pendingLabels(); nextDueAt(); settleMicrotasks()
  step(); advance(ms); runUntil(done, horizonMs); runUntilIdle(horizonMs?); beforeNextTimer(fn); onError
}
realMacrotask(), realMacrotaskCallback()
class SeededRandom implements RandomPort {                               // + hashLabel(label)
  constructor(seed); float(); bytes(n); int(n); range(lo, hi); chance(p); pick(xs); weighted(pairs)
  shuffle(xs); exponential(mean); fork(label); token(n = 8)
}
```

sim/storage:
```ts
class MemStoragePort implements StoragePort {
  constructor(options?: MemStorageOptions)  // { inactive?: "idb"|"off", macrotask?, beforeNextTimer?, onForeignAwait? }
  commitCount; foreignAwaits; dead
  setCommitHook((info: CommitInfo) => CommitDecision)  // "commit"|"crash-before"|"crash-after"|"quota"|"lose-connection"
  crashAtCommit(index, "before"|"after"); crash(): MemStoragePort; loseConnection(db)
  dump(db); version(db); open(name, version, stores); deleteDatabase(name); listDatabases(); requestPersistence()
}
compareKeys(a, b), memStorageError(failure, message, cause?)
```

sim/relay (`SimRelay implements RelayPort`; sessions implement `RelaySession`):
```ts
new SimRelay({ clock?, random?, seed?, vaultEpoch?, limits?: Partial<RelayLimits>, readPageRows?, dedupeWindow?,
  sealBytes?, maxSegmentBytes?, groupCommit?: Partial<GroupCommitSpec>, autoCommit?, gcOnCheckpoint?,
  readOnlyDevices?, link?: LinkSpec, maxSockets? })
// LinkSpec { uplinkMs?, downlinkMs?, jitterMs?, httpMs?, connectMs?, uplinkBytesPerSec? }
connect(...); setConnectFailure(reason | null, retryAfterMs = null); failNextConnect(reason, retryAfterMs = null)
pauseCommits(); resumeCommits(); commitNow(); flush(); settled(maxTurns?); quiescent()
restart(); drain(); dropSession(t: SimTarget, code = 1006); supersede(t); revoke(d); unrevoke(d); setReadOnly(d, on)
failNextCommit("durability"|"daily-limit"|"restart-before"|"restart-after", retryAfterMs?)
setCommitHook(({index, reason, frames}) => CommitFault | "commit"); onCommit(fn): Unsubscribe
setDailyLimit(on, retryAfterMs?); backpressure(t); forgetHeldProvisionals(t); inject(t, msg); ping(t)
setHttpFailure(on); setLink(deviceId | null, link); resetEpoch(epoch)
head(); vaultEpoch(); rows(stream, {includeGc?}); streams(); checkpoint(stream); gcSeq(stream)
sessions(): SimSessionInfo[]; session(id); pendingCount(); pendingBytes(); counters(); dailyLimitActive()
store: RelayStore (segments(stream), inDedupeWindow(stream, device, frameId)); engine; onListenerError
```
Test helpers live in `src/sim/a-relay-testkit.ts`: `bytes`, `frame`, `connectRaw`, `connectPeer`, `attach`, `pump`, `trace`.
