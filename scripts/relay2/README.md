# Relay v2 harness (`scripts/relay2/`)

The harness for PHASE2-RELAY-SPIKE-V2 §6/§7/§8.2. The same client code runs against baseline (flag off) and relay
(`YAOS_RELAY_BODIES=true`) deploys; only the protocol adapter differs. Run everything from the worktree root:
`node tests/run-typescript.mjs --test-aliases <file.ts> ...`. Long runs: `nohup ... > $EXP_ROOT/logs/relay2/... &`
and poll. Outputs, contexts and tails live under `$EXP_ROOT/logs/relay2/` (never in git; contexts hold device
tokens, mode 600, never printed).

`k3/` (byte-ops bench) and `reset/` (lease reset / K2) belong to other agents and are not covered here.

## 1. Deploy (`deploy.sh`)

```
zsh scripts/relay2/deploy.sh yaos-relay2-<name> [--relay on|off] [--var K=V]... [--no-debug-routes]
                             [--src <tree>] [--require-clean] [--dry-run]
```

- Names must start with `yaos-relay2-`. Real deploys only. Each worker gets one context/claim, so use a fresh name per run set.
- Generates the gitignored `server/wrangler.relay2-<suffix>.toml` from `experiments/wrangler.exp.template.toml`, with a drift check against `server/wrangler.toml`.
- The default vars are `YAOS_TEST_ONLY_DEBUG_ROUTES=true` (simulate-restart) and `YAOS_ENABLE_ADMIN_ROUTES=true` (debug/compact). Baseline and relay must differ only in `YAOS_RELAY_BODIES`.
- Writes `logs/relay2/deploy-<name>.json` with the version id, bundle raw/gzip KiB, startup ms, vars, spikeSha, srcTree and dirtyServerFiles. It then polls `/api/capabilities` until it returns 200.
- For full-n runs, use `--require-clean`, or `--src` pointing at a clean checkout of a pinned SHA. Otherwise the bundle includes whatever is uncommitted in `server/src`, and `dirtyServerFiles > 0` flags it.

## 2. Context (`context.ts`)

```
node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts --host <url> [--devices A,B,C] [--seed standard|none]
```

- Claims the worker, creates devices and writes `logs/relay2/context-<worker>.json`.
- The standard seed is 100 × 4 KiB notes (`r2-small-000..099`) plus `r2-lat`. It goes through the production import path.
- Scenario bodies are created on demand by bench.ts. Extra devices are added through the invite flow (`addDevice`).

## 3. Bench (`bench.ts`)

```
node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <scenario> --host <url> --out <json>
     [--n N] [--adapter base|relay|relay-nosv|relay-nocand] [--tail] [scenario flags]
```

Every run writes one JSON file per brief §6.1:
- Metadata: worker, deploymentVersionId, baseSha, spikeSha, spikeDirty, deployedSpikeSha, vars, edge colo/cf-ray, `competingProcesses` (from pgrep of other harness runs and tails), argv and adapter.
- Raw samples, plus summaries that drop the first 10 samples of each latency series (`discarded`/`lost` are recorded).
- A `convergence` block and `convergencePass`. A, B, a fresh C synced from scratch, the HTTP GET body and the recorded head hash must agree on text and state vector.

`--tail` runs `wrangler tail` for the duration of the run and records `tailFile`.

The table lists the defaults, followed by the flags and results used for small-n validation. All small-n validations ran on flag-off scratch workers, and every one had convergence PASS. For full n, drop the small-n flags.

| Scen | What | Default n / key flags | Validated small-n (worker) |
|---|---|---|---|
| L1 | WS ping RTT floor | `--n 100 --spacing 200` | n default, p50 88 ms (s1) |
| L2 | A→B keystroke propagation + origin ack, 4 KiB note | `--n 300 --spacing 500 --note-bytes 4096` | n30 p50 412 / ack 412 (s1) |
| L3 | propagation on a body with a long replayed history | `--n 50 --replay-rate 25` | n15 `--replay-rate 200`, p50 345 (s1) |
| L4 | typing-trace replay (sustained stream) | `--n <trace frames> --rate 25` | n300 per-frame p50 293 / p90 458 (s1) |
| L6 | cold vs warm open-to-current | `--n` | p50 cold 612 / warm 629 (s1) |
| L7 | edit to HTTP head/GET visible (recorded hash) | `--spacing 300` | n15 head 281 / get 297 (s1) |
| C1 | DO CPU per edit, small and heavy body (use `--tail` + analyze.py / gql.ts) | `--n 40 --spacing 2300 --which both --replay-rate 100` | n12 (s1, tail lost); n15 tail 15/15 matched, cpu p50 2 ms (s2) |
| C3 | resident memory vs open bodies (+ big bodies) | `--big 32 --steps 1,8,32,100 [--skip-big] [--seed-only]` | `--big 4 --steps 1,8,32` (s2) |
| C4 | vault sequence / journal rows per edit and per reconnect | `--n 50 --reconnects 20 --spacing 1500` | seq/edit 1, seq/reconnect 0 (s1) |
| B1 | idle/hibernation then edit on the existing socket; simulate-restart | `--idle 150000` | `--idle 30000` (s1, s2); see note |
| B2 | stale catch-up (trace body) | `--edits 50 [--skip-trace]` | 607 ms (s1) |
| B3 | bootstrap with edited bodies | `--edited 20` | 3212 ms, 0 mismatches (s1) |
| B4 | device revoke mid-stream | `--stream-interval 50 --pre-stream 2000` | close 4403, 0 appends after revoke (s1) |
| B7 | small-note latency under a 5 MiB/s flood on another body | `--n 40 --mibps 5 --flood-ms 30000 --chunk 65536` | n15 `--flood-ms 10000`, p50 change -6.8% (s1) |
| B8 | body delete: close, reopen, GET | `--n` | close 1008 "body deleted", reopen 409 (s1) |
| X1 | socket ramp to failure + probe latency at each step | `--steps 100,250,500,1000,2000 --probe-n 30 --concurrency 25 --stop-fail 0.5` | `--steps 20,40 --probe-n 12`: base 429 `body_socket_limit` at 32 (s1, s2) |
| X2 | max append rate within 2× RTT floor | `--rates 25,...,800 --step-ms 10000 --bodies 1,10 [--no-stop]` | `--rates 25,50,100 --step-ms 4000` (s1) |
| X3 | large notes 1/5/10 MB (+ compaction when admin routes) | `--sizes-mb 1,5,10` | `--sizes-mb 1,5` (s2) |
| X4 | stale catch-up ceiling (HTTP envelope vs socket reopen) | `--bodies 100 --edits 50` | `--bodies 10 --edits 5` (s1) |
| diag | dump diagnostics | | |

Worker key: s1 is yaos-relay2-scratch-1 and s2 is yaos-relay2-scratch-2.

Notes on the behaviour seen on base:
- **B1:** base closes a socket that outlived its runtime with 1008 "socket authority mismatch" on the next runtime-dependent frame. That frame is the first edit after the DO was evicted; the runtime epoch had already changed after 30 s idle. `wakeProbe` records the close and then `recovery`: `closeAfterEditMs`, `reconnectToVisibleMs` and `clientPathMs` (their sum, which is what an immediately reconnecting client pays). `editToVisibleViaReconnectMs` includes the probe's 15 s wait, so do not report it as latency. On s2 at 30 s idle: warm propagation was 351 ms; after eviction the clientPath was 1332 ms (close 164 ms, then reconnect-to-visible 1168 ms); after simulate-restart it was 1350 ms.
- **X1:** base caps a vault at `MAX_BODY_SOCKETS=32` body sockets (429 `body_socket_limit`). Once saturated, X1 frees two slots for the probe (`probeFreedSlots`) and closes all but one socket before convergence.
- **L4:** the per-frame latency shows a sawtooth that points to base broadcast batching.

### Protocol adapters (`lib/rawClient.ts`)

- `base` (default): current wire protocol. The ack is BODY_COMMITTED matched by content.
- `relay` / `relay-sv`: sends `__YPS:{type:"BODY_UPDATE_ENVELOPE", bodyId, bodyEpoch, clientFrameId, payloadDigest, candidateId, candidateDigest, contentHash, size, stateVector, frameKind}` immediately before each binary step2/update, following docs/relay2-protocol.md. The ack is BODY_COMMITTED with `relay:true` and a matching `clientFrameId` (`requireEcho`: an ack without an echo never matches).
- `relay-nosv` / `relay-nocand`: the same envelope without stateVector or candidate fields, to exercise the paths where the hash is not recorded.
- `BODY_UPDATE_REJECTED`, `VAULT_BACKPRESSURE` and error frames are collected in `client.rejects`.
- `diagnostics()` merges the `relay` object from `GET /vault/:id/diagnostics` when `debug/recent` lacks it. C4 reads relay counters from there.

## 4. CPU / cost tooling

- `zsh scripts/relay2/tail.sh <worker|url> [label]` runs `wrangler tail --format json` into `logs/relay2/tail-<name>-<label>-<ts>.jsonl`. It refuses names outside `yaos-relay2-*` and unsets `CLOUDFLARE_API_TOKEN` so the OAuth login is used.
- `python3 scripts/relay2/analyze.py <run.json> [--tail f] [--out f]` matches every sample list that has `sentAtWall` to DO ws-message tail events. It corrects for the median clock offset with a 400 ms window and reports per-sample cpu/wall plus per-window, whole-run and alarm totals. Tail units are ms. It uses `tailparse.py`.
- `node ... scripts/relay2/gql.ts --worker <name|url> --start ISO --end ISO` (or `--run run.json [--window <key>]`) queries two GraphQL datasets for the VaultSyncServer namespace:
  - `durableObjectsInvocationsAdaptiveGroups`: requests, wall time and cpu quantiles per type.
  - `durableObjectsPeriodicGroups`: cpuTime, rowsRead/rowsWritten and ws message counts per minute. Windows are padded to whole minutes.
  - Units are µs. The token comes from the wrangler OAuth config, is refreshed with `wrangler whoami` and is never printed. Analytics lag 1–3 min.

**Caveat, tail is lossy.** During C1 on the busy scratch-1, zero ws-message events arrived (20 request events only). On the idle scratch-2, 15/15 matched. Always check `matched/total` in the analyze output, and cross-check totals with gql.ts periodic cpuTime.

## 5. L5 baseline (`l5-cli-baseline.ts`, D8)

```
node tests/run-typescript.mjs --test-aliases scripts/relay2/l5-cli-baseline.ts --host <url> [--n 100] [--mode prod|nodebounce|both]
     [--burst 1] [--burst-interval 80] [--spacing 1500] --out <json>
```

- **Setup.** Runs the real `VaultSync` from `src/sync/vaultSync.ts` in Node through the CLI globals shim (`packages/cli/src/globals.ts`). It uses the real default provider (OwnAwarenessProvider with the fenced WebSocket), the real `NodeVaultDatabase` (CLI SQLite), `createSocketTicketCache`, `createFetchRequester` and `prepareBootstrapRoot`.
- **Measurement.** The script edits through `acquireEditorBody` and Y.Text. It wraps the DB in a Proxy that timestamps `putCandidate` (capture), `confirmPendingCandidate` and `deleteCandidate` (cleared). It reports:
  - `editToClearedMs` (and `lastEditToClearedMs` for bursts)
  - `editToCaptureMs`
  - `captureToClearedMs`
  - `candidateSubmitHttpMs` (the POST `/body/:id/candidate`)
- **Modes.** `prod` keeps the real 250 ms debounce with 2 s maxWait. `nodebounce` sets `candidateDebounceMs`/`candidateMaxWaitMs` to 0.
- **Provider proof.** Each run records the provider proof: root and body sockets opened, VAULT_READY and BODY_COMMITTED counts, and outgoing step1/step2/update frame counts. Convergence is checked by HTTP GET text plus the head hash.

Small-n result (s2, n=14, 10 discarded, so 4 kept):

| Mode | editToCleared p50 | Breakdown |
|---|---|---|
| prod | 531 ms (p90 943) | capture 250 ms, then capture→cleared 281 ms (HTTP 280) |
| nodebounce | 277 ms | HTTP 276 |

**Envelope hook point** (for the relay variant; not implemented, because vaultSync.ts is off-limits): pass a custom `webSocket` constructor through `VaultSync.create({ webSocket })`, the same seam `instrumentedWebSocket` uses. Its `send()` can emit the `__YPS:` BODY_UPDATE_ENVELOPE text frame immediately before each binary step2/update. The fields come from:
- bodyId: the socket URL
- bodyEpoch: `VaultSync.currentBodyEpoch`
- payloadDigest: sha256 of the frame's inner update
- clientFrameId: generated

The relay L5 "cleared" point is the BODY_COMMITTED `relay:true` echo. A client-side receipt that clears the pending candidate on that echo needs a vaultSync change; until then the harness would time the echo at the socket layer.

## 6. Relay validation (flag on) and what is still pending

`yaos-relay2-scratch-3` runs relay on (version 3e0b531b), deployed with `--require-clean` from 022f8fd, so the server tree was clean. All 19 scenarios ran at small n with `--adapter relay` (the batch5/batch6 flags). Every run had convergence PASS; outputs are in `runs/scratch3-*-relay.json`.

Behaviour confirmed:
- The envelope is accepted and the `relay:true` echo matches.
- C4 `relayStats` are populated from diagnostics `relay`.
- B7: the flooder is closed with 1013 "relay rate limit" (256 KiB/s knob) while small-note p50 stays flat.
- B1: the socket survives idle (the runtime epoch changed) and simulate-restart, with no 1008.
- X1: 100 sockets open with no failures.
- The unmodified real VaultSync client (L5 script) converges against the relay worker.

Relay compared with base at small n (the n values are too small to cite):

| | Base | Relay |
|---|---|---|
| L1 RTT | 88 | 87 |
| L2 propagation | 412 | 90 (ack 101) |
| L4 per frame | 293 | 116 |
| B1 after idle | 1332 via reconnect | 309 on the same socket |
| X1 cap | 32 | ≥100 |

X3 relay 1/5 MB showed transient 11–15 s opens in one run, during a local `UND_ERR_CONNECT_TIMEOUT` window. A 1 MB recheck gave 1.23 s, so verify at full n.

The X3 11–15 s opens were a network blip: the per-phase X3 (section 7) shows 1 MB opens at 0.5–0.6 s and 5 MB at about 1 s, dominated by transfer time. The L5 relay variant (`--mode relay,relay250`) and `relay-nocand` (MB sweep) are now exercised; see section 7.

## 7. Round-3 additions

New scenarios live in `scenarios/extra.ts`. Cost windows are minute-aligned because `durableObjectsPeriodicGroups` buckets by minute. Each scenario takes an idle window, then the measured windows; gql is queried after `--gql-settle-ms` (180 s; `--no-gql` skips it). DO request units = http requests + inbound WS messages / 20.

| Scen | What | Key flags |
|---|---|---|
| C2 | CPU and rows per update while streaming a trace (µs, periodic cpuTime net of idle) | `--trace quick\|stress --rate 25 --clients 5` (stress: 50k frames, writers A,S1..S4, observer B) |
| C5 | DO requests per burst and per catch-up (WS messages billed 20:1) | `--n <bursts> --burst 8 --burst-interval 125 --burst-gap 3000 --catchups 10 --catchup-edits 10 [--l5 <L5 json>]` |
| C6 | bundle size + startup from the deploy record | `--compare <host>` |
| K1 | checkpoint cost vs tail length | `--tails 50,500,5000 --repeats 3 --trigger compact\|alarm --rate 200`; needs a worker with checkpoint knobs raised (runall `g-k1`) so tails can build |
| MB | micro-batch / write amplification: rows per edit (gql and relay counter) + propagation for l2/burst/stream patterns | `--patterns l2,burst,stream --pattern-seconds 110`; records requested vs effective `microbatchMs` and `clamped` |
| CW | concurrent writers + GET checker: invariant #7 (`x-yaos-content-hash` describes the stored merged state) | `--writers 4 --seconds 60 --edit-ms 200 --get-ms 1000` |

Other changes:
- **X3** now records per-open phases (ticket, upgrade, step1→step2, ready), a ping before/after each open, GET TTFB/download and `inferredServerMs` (step1→step2 − cached-GET download − ping). `--repeats 3`.
- **L5 `--typing-probe`** types at 2/8/30 cps for 5 s through the real provider and reports update frames per keystroke. The provider sends one frame per keystroke at every rate (no coalescing).
- **gql bucket attribution.** A periodic bucket is labelled by the minute in which the DO's reporting period began. Traffic that crosses a minute boundary therefore lands in the earlier bucket. Every phase starts all of its traffic, socket opens included, after its boundary. Periodic `inboundWebsocketMsgCount` is 0 for Hibernation-API sockets, so inbound messages are taken from the `hibernation` invocation count. Relay diagnostics counters are in-memory, and `counterResetInWindow` marks a window in which the DO restarted. A reporting period also stays open while the DO is alive, including across a 1-minute quiet gap between phases. It is emitted only when it ends, so a bucket can grow minutes after the last minute is visible. For that reason C2, C5 and MB sleep `--quiet-gap-ms` (240 s) with no sockets or requests after seeding and between phases, which lets the DO evict. gql also waits until the span's periodic totals are unchanged across two queries 60 s apart (`totalsStable`). Each window is flagged `attributionSuspect` if it had traffic but no rows or missing buckets, and MB also reports `runLevel` rows per edit. The stability check also covers invocation counts, because those lag independently of the periodic totals. Because a period is reported only when it ends, often when the DO evicts, the last window can take more than 20 minutes to appear. On C2 base the 01:54 bucket arrived at about 02:17. The inline query therefore gives up after `--gql-attempts` (8) minutes, and `gqlfill.ts` (runall `final` phase, 30 attempts) re-queries every incomplete C2/C5/MB window and recomputes the derived fields in place. The inline result is kept as `gqlInline`, and `gqlBackfilledAt` is set. Validation run: without the gap, stream traffic landed in the burst bucket. With the gap, the l2/burst/stream relay buckets are 11/13.6/13.0 rows per edit, the hibernation invocations are about 2 per edit, and `attributionSuspect` is false everywhere. Relay counters reset on hibernation in most windows, so gql is the source for rows per edit.
- **K1 warm-up compact.** `debug/compact` is vault-wide, so K1 runs a warm-up compact first. Without it, the first measured tail also pays for checkpointing every seeded body.
- **Base closes sockets across DO eviction.** C2, C5 and MB therefore never leave a socket open across a minute-alignment wait. Otherwise base senders are closed with 1008 "socket authority mismatch" (the B1 behaviour).
- **Server-side ms timers.** `lastCheckpointMs` reads 0 because Date.now() does not advance during DO CPU. Use tail cpuTime or gql instead.
- **`convergence.ts`** summarises the §8.2 suite from `<ID>-<variant>.json` files (L2, L4, C2-stress, B2, B3, B5, B6, X1, CW). It reports pass/FAIL/unknown for text, state vector, GET, server hash and invariant #7 (`--require-all` exits 1 on any miss).
- **`runall.sh`** is the resumable full-run orchestrator:

```
zsh scripts/relay2/runall.sh --sha <commit> [--tag rMMDD] [--only g-lat,g-mb,...] [--small] [--dry-run]
```

  - It creates a clean detached worktree for `<commit>` and deploys fresh `yaos-relay2-<tag>-<group>-<variant>` workers with `--require-clean`.
  - A deploy is skipped when the record already matches the sha and vars; `FORCE_DEPLOY=1` overrides this.
  - A run is skipped when its JSON already exists without an `error`. Base/relay order alternates.
  - Outputs go to `results/relay2/raw/` and the manifest to `raw/runall-manifest.jsonl`. Logs go to `logs/relay2/runall-<tag>/`.
  - `--small` writes under `logs/relay2/runall-<tag>-small/` at small n.
  - The final step runs `convergence.ts`.
- **`runfast.sh`** (2026-10-01) replaces `runall.sh` for full runs and finishes in about 2 h instead of overnight:

```
nohup zsh scripts/relay2/runfast.sh --sha <commit> --tag <tag> [--small] [--jobs 10] [--phases id,..] [--lanes A,B] [--no-final] [--dry-run] \
  > ../logs/relay2/runall-<tag>.nohup 2>&1 &
```

  - **One fresh worker per phase.** Each phase (scenario × variant) gets its own worker, `yaos-relay2-<tag>-<phase>[-a<k>]`. There are no quiet gaps and no inline gql waits (`--quiet-gap-ms 0 --no-gql`).
  - **Lane B.** Everything except latency runs `--jobs` at a time, longest first. Lane A workers are provisioned while it runs.
  - **Lane A.** L1–L7, L5, B7 and X2 run strictly one at a time, alternating variant order.
  - **Final stage.** C6 runs first. Then a single `gqlfill.ts --progress` pass, at least 20 min after lane B. It adds `gqlPhase`, the whole-worker totals, and for C2, C5 and MB a `phaseLevel` per-unit figure net of the `SEED-<variant>` phase (deploy + claim + seed only). It also backfills the per-window numbers. Then convergence, then `summarize.py` → `tables.md`.
  - **Trimmed MB.** `MB-<base|strict|lean-mb0|lean-mb10|lean-mb50>-<burst|stream>` only.
  - **C2-stress.** Runs once per build with `--rate 0`, which is max-rate with ack/bufferedAmount backpressure and drops to pacing if a 1013 appears. Only its CPU and rows are used; `latencyUsed: false`.
  - **C5 split.** C5 is split into `C5-bursts-*` and `C5-catchups-*` (`--parts`).
  - **Progress.** `cat <logdir>/progress.json` shows the stage, counts, running/failed lists and per-phase status, worker, start/end and attempt. `progress.jsonl` holds the raw events.
  - **Resume and retry.** A rerun skips any phase with a valid `raw/<phase>.json`. A failed phase retries once on a fresh worker, then is marked `failed`. The per-phase timeout is 45 min (20 min with `--small`).
  - **Worker reuse (`--reuse-pool <file>`).** The account caps Durable Object namespaces at 500 (error 10067), and each worker uses 3. With this flag, phases redeploy onto existing idle `yaos-relay2-*` workers listed in `<file>` instead of creating new ones; the same script and classes keep the same namespaces. Each pool worker serves at most one phase attempt (`state/pool/<w>`, mapping in `state/pool.tsv`). `context.ts --fresh-vault <tag>-<phase>` gives each phase fresh state: it logs in with the worker's operator key, creates a new vault (random vaultId, so a new `VaultSyncServer` DO), enrolls A/B/C and seeds. The old context is kept as `context-<w>.pre-<label>.json` and the old deploy record as `deploy-<w>.pre-<tag>.json`. gql filters by script, namespace and the [deploy, end] window, so it only sees that phase. Workers are never deleted.
- **Round-4 configurations (full run).** `relay` is the production candidate: `YAOS_RELAY_BODIES=true`, `YAOS_RELAY_LEAN_ROWS=true` and `YAOS_RELAY_MICROBATCH_MS=10`. `strict` is `YAOS_RELAY_BODIES=true` with lean off and mb 0; it runs for L2, L4, C1, C2 (quick and stress), C4, B7 and X2. `base` is the flag off with the same lean and mb vars. The `INERT-*-base` diag runs are the evidence that those vars do nothing with the flag off. The MB sweep runs lean on/off × mb 0/10/50/100/250 (`MB-relay-<lean|full>-mb<ms>`), plus `relay-nocand` on the primary config. `final` writes `convergence-suite.json` for relay, and `convergence-suite-<strict|base>.json` for the other two.
- **Resilient raw client (round 3).** Data-path scenarios, meaning everything except B1–B8, X1, X3, X4, C3 and `diag` (`RESILIENT_OFF` in `lib/run.ts`), use clients with `reconnect=true`:
  - **Reconnect.** On any close the client did not initiate, it reconnects with backoff. The exceptions are 4409, 4403, 1008 and 1009, where a resend cannot help.
  - **Resync.** After reconnecting, the client resyncs: it sends its step1, and its step2 answers the server's step1.
  - **Resend.** Relay resends every unacked frame with its original envelope and `clientFrameId`, so candidate dedupe re-acks it. Base flushes the frames it queued while not open.
  - **No silent skips.** A send while not open is queued (`queuedWhileClosed`). A non-resilient client counts it in `droppedWhileClosed`.
  - **Logging.** Every close is recorded with its code, reason, time and origin (`cloudflare-platform` for a 1013 that is not ours). Errors, including `VAULT_ERROR` and `BODY_UPDATE_REJECTED`, and reconnects are recorded too. They land in `connectionEvents` in every JSON and under `convergence.connections`.
  - **Failed convergence.** A failed convergence sets `connectionLoss` and `failureCause`.
- **Frame accounting (round 4 counters).** `frameOutcomes` in L4, C2, C4 and MB parts holds:
  - the diagnostics delta of the no-silent-drops outcome counters;
  - `sumEqualsUpdateFrames`: whether the outcomes sum to `updateFrames`;
  - `updateFramesEqualsClientFrames`: whether `updateFrames` equals the number of non-empty update/step2 frames our clients wrote, resends included.

  The delta is `null` when the DO restarted in the window (`counterResetInWindow`) and `available:false` on base.
