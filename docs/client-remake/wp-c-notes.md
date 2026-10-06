# WP-C notes: log-side engine

Branch `client-remake-wp-c` (base 6adc552, includes f531c9d). Everything under `src/engine/{store/repo.ts,adapters,ingest,body,sync,runtime}`
and `e2e/client/`. No frozen-file changes (`git diff <base> -- src/core src/ports src/engine/store/schema.ts` is empty).

## What is built

**Store** — `store/repo.ts`: every DESIGN §e.2 transaction (tFeedPage, tReadPage, tEdit, tLive, tOutbox, tSent, tSnapshot,
tPatchStreams, quarantine/release, ...) on a serial write queue with a stream-row cache; `txLabel` per tx (used by the crash sweep).

**Adapters** (only place with browser globals):
- `idbStorage.ts` — StoragePort over IndexedDB (takes an `IDBFactory` + `IDBKeyRange`, so fake-indexeddb works in Node).
- `wsRelay.ts` + `relayFrames.ts` (wire codec) + `relayHttp.ts` — RelayPort per `relay-wire.md`; liveness override option.
- `noopCrypto.ts` (suite 0), `webHash.ts`, `webClock.ts`, `webRandom.ts`, `httpBlob.ts`.
- `storageConformance.test.ts` — one suite run against idbStorage and any in-memory StoragePort.

**Ingest** — `ingest/gate.ts` (§d.4 gate: outer/inner decode, kind/stream binding, Yjs structural check (`yjsCheck.ts`,
disallowed types, canvas), size caps, refs, checkpoints → pass / quarantine reason), `ingest/envelope.ts` (seal/open).

**Body**:
- `yjsCounters.ts` — the only `Y.encodeStateAsUpdate` / `Y.mergeUpdates` call sites, counted (hygiene test enforces it).
- `frameBuilder.ts` — open frame per doc, keystroke batching (`OPEN_FRAME_IDLE_MS` 100 / `OPEN_FRAME_MAX_MS` 300), merges
  the frame's own small updates only, never stored ones; caps; chunking into `x:` chunks + `bodyUpdateRef`.
- `frames.ts` (sealing, ns/cfg frames, initial chunking), `refs.ts` (ref resolution), `handles.ts` (residency, bound docs),
  `compaction.ts` (scratch Y.Doc, counted encode), `checkpoints.ts` (checkpoint duty, CAS outcomes).
- `sender.ts` — rank-ordered sending: ns/cfg window (`NS_SEND_WINDOW` 32, opened by `openNs`), inflight-bytes cap (head-of-line
  frame always allowed), buffered high water → 50 ms defer, TokenBucket min(1 MiB, burstBytes) at 192 KiB/s (half rate 10 min
  after backpressure), refusals (durability retry 1 s, daily-limit hold, forbidden → read-only, frame-id-conflict → poison),
  1008/1009 probe mode (one frame in flight; a repeat close poisons the suspect).

**Sync** — `cursor.ts`, `catchUp.ts` (reads, late receipts, adoptable settles, fresh / union / fold checkpoints, disputed freeze),
`ingestRow.ts`, `nsRuntime.ts` (ns fold, held reconcile, candidates).

**Runtime** — `engine.ts` (`LogEngine`: start/stop, createDoc/editDoc/applyLocalUpdate/rename/delete, bind/unbind, docText,
releaseQuarantine, flush/isIdle/waitIdle, disconnect/reconnect, status/diagnostics), `sessionLoop.ts`, `relayPolicy.ts`
(§i.6 table + full-jitter backoff), `liveIngest.ts` (live queue, overflow → stale → read), `docRuntime.ts`, `maintenance.ts`
(compaction + checkpoint scheduling), `outboxCache.ts`, `mirrors.ts` + `mirrorIo.ts` (outbox/synced side-file mirrors,
IDB-loss recovery), `status.ts`, `options.ts`, `context.ts`, `testHarness.ts`.

**E2E** — `e2e/client/{onboard,smoke,engineKit,engines}.ts`, own `tsconfig.json` (`npx tsc -p e2e/client/tsconfig.json`).

## Tests

`npm run test:client`: 253 pass, 1 skipped (`YAOS_BENCH`-gated timing), 27 files. `npm run -s typecheck:client` green.

| file | n | file | n | file | n |
|---|---|---|---|---|---|
| httpBlob | 4 | idbStorage | 10 | noopCrypto | 4 |
| relayFrames | 10 | relayHttp | 13 | storageConformance | 42 |
| webClock / webHash / webRandom | 3/2/2 | wsRelay | 31 | frames | 8 |
| sender | 9 | gate | 8 | catchup | 4 |
| compactionCas | 4 | crash | 4 | engine | 1 |
| hygiene | 4 | keystrokeBench | 1 (+1 skip) | largeUpdate | 2 |
| mirrors | 39 | provisional | 5 | quarantine | 5 |
| recovery | 3 | relayPolicy | 4 | memStorage / simRelay (stand-ins) | 11 / 20 |

Acceptance (§k.3 WP-C) → tests:
1. crash at every tx boundary → `runtime/crash.test.ts`;
2. gate + quarantine + `releaseQuarantine` → `ingest/gate.test.ts`, `runtime/quarantine.test.ts`;
3. frame builder (5 MB, 1000 keys, zero encodes; caps, chunking, refs) → `runtime/keystrokeBench.test.ts`, `body/frames.test.ts`, `runtime/largeUpdate.test.ts`;
4. provisional adopt/settle/drop, R7, STREAM_RESEND, send window → `runtime/provisional.test.ts`, `body/sender.test.ts`;
5. catch-up, checkpoint union, compaction exactness, checkpoint CAS → `runtime/catchup.test.ts`, `runtime/compactionCas.test.ts`;
6. e2e against the real relay → `e2e/client/engines.ts` (below).

## Benchmark (keystrokeBench)

5 MB doc: create 52 ms. 1000 keystrokes:
- burst: 4 frames, 21.9 µs/key sync (33 ms total);
- paced: 1000 frames, 68.6 µs/key sync;
- `encodeStateAsUpdate` 0 / 0, `mergeUpdates` 4 / 0;
- one compaction 36 ms.

`YAOS_BENCH=1` timing:

| doc | burst | paced |
|---|---|---|
| 50 KB | 13.6 µs/key | 107.6 µs/key, 0.26 ms/frame beyond pacing |
| 5 MB | 15.2 µs/key | 85.9 µs/key, 0.26 ms/frame beyond pacing |

Compaction is disabled inside the measured window.

## Crash sweep

Baseline scenario: 37 commits (open×1, tFeedPage×1, tReadPage×2, tEdit×12, tLive×13, tOutbox×2, tSnapshot×3, tPatchStreams×2,
tSent×1). Every commit is crashed before and after, then restarted and checked: V accounting probe, every durable frame committed exactly once.

| mode | probes | probed rows | durable checked | time |
|---|---|---|---|---|
| crash before | 42 | 373 | 319 | ~1.2 s |
| crash after | 83 | 762 | 652 | ~1.2 s |

## E2E (real relay, 3 headless engines a/b/c)

Stack: wsRelay + relayHttp, idbStorage on fake-indexeddb (one factory per device, kept across restarts), suite-0 crypto, web
clock/hash/random, `blob: null`, in-memory side files. Scenarios:
- create/edit;
- merge-edit / keystroke / burst-typing latency;
- concurrent edits, rename/delete;
- offline edits on both sides + reconnect;
- 1.3 MB update via `x:` chunks;
- checkpoint duty, fresh device catch-up;
- restart from IDB, IDB loss → mirror recovery;
- relay restart (local only);
- final invariants: cursor at head, outbox empty, nothing frozen or quarantined.

Run:
```sh
URL=$(zsh scripts/relay-dev/start-local.sh --fresh | tail -1)
node --import jiti/register e2e/client/engines.ts --host "$URL" --label local --relay-restart
zsh scripts/relay-dev/stop-local.sh
# deployed: --host https://yaos-relay2-scratch-3.kavinsood.workers.dev --label deployed (operator context file, no restart)
```
Reports go to `$YAOS_E2E_LOG_DIR` (default `experiments/logs/`). Device tokens are scrubbed and the report is checked for them.

| metric | local (27/27, 24.9 s) | deployed scratch-3 (26/26, 32.4 s) |
|---|---|---|
| engine start | 10–13 ms | 520–623 ms |
| converge p50 | 415 ms | 878 ms |
| merge edit → peer view | p50 5.4 / p95 7.5 ms | p50 50 / p95 55 ms |
| single keystroke → peer view | p50 106 ms (100 ms idle close) | p50 153 / p95 250 ms |
| burst typing (150 keys @30 ms) → peer | p50 176 / p95 303 ms, 15 frames | p50 227 / p95 563 ms, 15 frames |
| offline both sides → reconnect converge | 662 ms (2 reads) | 1441 ms |
| 1.3 MB update | 651 ms | 730 ms |
| checkpoint after idle | 2.8 s | 352 ms |
| fresh device catch-up | 84 ms (1 feed page, 11 reads) | 1317 ms |
| restart from IDB converge | 325 ms (0 reads) | 1191 ms |
| relay restart → all live | 41 ms after the relay was ready | n/a |

Report files:
- `client-e2e-wpc-engines-local-20261005T201622Z.json` (sha e72147c);
- `client-e2e-wpc-engines-deployed-20261005T201715Z.json`;
- adapter smoke: `client-e2e-wpc-smoke-local-20261005T201759Z.json` (56/56).

Checkpoint CAS conflicts between a and b show up as expected (a `{ok:2, conflict:1, skipped:1}`, b `{ok:2, conflict:1}`).

**Relay findings: none.** No relay bugs were found and `server/` is untouched.

## Decisions / deviations

- `editDoc` is a merge edit: its frame closes at once. Keystrokes go through `applyLocalUpdate` on a bound doc and are batched.
- `quarantinedRows` counts undismissed records only. `frozenReason` is the latest quarantine reason. Release clears stale
  `frozen:*` notices.
- oversize-local discards the unsent update and drops the replica (reloaded from storage). A bound handle is dropped, so the
  `onDocFrozen(docId, reason)` hook was added to `EngineOptions` and the host must re-bind.
- Live-queue overflow is bounded by payload-holding rows only (`liveQueueMaxRows`).
- Engine boot closes the first session if boot fails after connect.
- Repo txs carry a `txLabel`. The sender's local `window` was renamed to `nsWindow`.
- relayPolicy:
  - backoff: full jitter, floor min(100, base), attempt clamped to [0, 30];
  - superseded: re-ticket once immediately, then `SUPERSEDED_RETRY_MS`;
  - daily-limit: max(1 s, Retry-After ?? 1 h);
  - 1013 / backpressure: ≥ 5 s.

## Stand-ins integration must replace

Everything under `src/engine/sync/__standins__/` is temporary. Map:

| stand-in | replace with (client-remake) | notes |
|---|---|---|
| `bytes.ts` (Reader/Writer/CodecError/toHex/fromHex/utf8/bytesEqual/concatBytes) | `core/codec/lib0.ts` | rename `toHex`→`bytesToHex`, `fromHex`→`hexToBytes`, `utf8`→`utf8Encode` |
| `envelopeCodec.ts` (outer/inner, AADs, bodyRef, blobChunk, checkpointContent) | `core/codec/envelope.ts` + `core/codec/contents.ts` | `encodeBodyRef`/`decodeBodyRef` → `encodeBodyUpdateRef`/`decodeBodyUpdateRef`; envelope.ts also has `sealEnvelope`/`openEnvelope`/`checkBinding`, which can replace `ingest/envelope.ts` internals |
| `nsOps.ts` | `core/codec/nsOps.ts` | |
| `nsFold.ts` (minimal fold, `pathKeyStandin`, `buildIndex`) | `core/ns/fold.ts` (`foldNsFrame`), `core/ns/index.ts` (`buildIndex`, `newNsFoldState`), `core/codec/nsFoldV1.ts` | the stand-in lacks folder casing, pruning and edit-beats-delete; its pathKey is NFC + lowercase, not the frozen table; ns halt is via `nsFoldHalted` |
| `ids.ts` (`newDocId`, `newFrameId`, `isId`) | `core/codec/ids.ts` | `newFrameId` → `newClientFrameId(random)` |
| `memStorage.ts` (+ crash `CommitDecision` hook) | `sim/storage.ts` `MemStoragePort` | superset. Its default `inactive: "idb"` auto-commits a tx that awaits something foreign; repo txs don't, and conformance passes. One stand-in test needs `inactive: "off"`. Sims must pass `beforeNextTimer` |
| `simRelay.ts` | `sim/relay.ts` `SimRelay` | same test API (`pauseCommits`/`resumeCommits`/`settled`/`restart`/`rows`/`streams`/`checkpoint`/`gcSeq`/`head`). Real group-commit timers (300 ms idle / 1500 ms max), segment GC, daily-limit latch until 00:00 UTC (the stand-in used 60 s) |

Also:
- `runtime/mirrors.ts` has its own outbox/synced mirror codecs. `core/codec/mirrors.ts` now exists (WP-A); unify on it and check byte compatibility.
- The cfg stream is a stand-in: the gate keeps raw cfgOps (`ingest/gate.ts`), and there is no cfg fold or cfg compaction. Wire in `core/codec/cfgOps.ts` + `cfgFoldV1.ts`.

**Integration feasibility run (scratch copy, not committed).** I extracted `git archive client-remake` + WP-C `src/engine` to
`/tmp`, pointed the engine tests at `sim/relay` + `sim/storage`, and ran `typecheck:client` (clean) and the runtime tests plus storage
conformance: **114/118 pass, 1 skipped**. The 4 failures:
- 2 catch-up tests (checkpoint + GC, union) waited for `gcSeq > 0`, but WP-A GCs only sealed segments (64 KiB seal), and the test
  docs are tiny. With `new SimRelay({ sealBytes: 64 })` both pass.
- The causal-hole test's wait was satisfied before WP-A's group commit landed the filling row. Waiting for `head > h0` fixes it.
- hygiene flags `src/engine/reconcile/testkit/stubLog.ts` (another WP's file in client-remake) calling uncounted Yjs encode/merge.
  Integration needs to either route it through `yjsCounters.ts` or exempt testkits.

With those two test-side changes: 117/118 (only the foreign hygiene hit left). No engine-code changes were needed.

## Honest gaps

- **Storage:** storage `onLost` is not handled in-process (§i.5). The host must restart the engine, which then recovers from the mirror.
- **Epoch:** §c.12 epoch migration is not implemented (4409 → phase `epoch-migrating`, then stop). There is no offline start without a known `vaultEpoch`.
- **Crypto:** suite 0 has no AAD binding, so a swapped clientFrameId is undetectable until E2EE lands.
- **Quarantine:**
  - reader-dependent quarantine is not auto-retried when new keys arrive;
  - `releaseQuarantine` with the key still missing dismisses the rows;
  - there is no quarantine notice (only `frozen:*`);
  - quarantine bytes are not bounded.
- **Refs, checkpoints and docs:**
  - A chunked initial ref depends on the ns create, not on the last chunk.
  - A recovered ref with empty content is guarded but not repaired.
  - Retired checkpoints are not adopted. Provisional refs are not adopted.
  - The ns halt is not retried.
  - There is no docCredit window.
  - Ref tails are not rewritten.
  - A poisoned doc is not rebuilt.
  - Canvas-invalid freezes the doc. Canvas `createDoc` has no initial content.
  - Blob docs are unsupported (`blob: null` in e2e; the local relay has no blob store).
- **Checkpoint outcome coverage:** the "not advancing" outcome can't be reached through SimRelay's normal path; it is tested via a Proxy.
- **Code and tests:**
  - The live queue uses `Array.shift` (O(n) on big queues).
  - The keystroke benchmark disables compaction in the measured window.
  - The e2e scripts are outside `typecheck:client` (own tsconfig).
- **Protocol:** there is no engine-side adapter from the host↔engine protocol (`src/protocol/messages.ts`, inline/worker transports) to `LogEngine`. Hosts call `LogEngine` directly today. The RelayPort wire codec is hand-written against `relay-wire.md`.
