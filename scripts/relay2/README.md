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

## 6. Pending the relay deploy

- Every adapter path (`relay*`) matches docs/relay2-protocol.md as of commit 81c45ab, but none has been run against a flag-on worker yet.
- Still to check against a flag-on worker: envelope acceptance, echo matching, `rejects` capture, 1013/4409 close handling and C4 relay counters.
- The L5 relay variant needs the socket-layer echo timing described above.
- Relay-specific checks still to write once the server lands: the compaction-lease / semantic-reset HTTP flows, C3 `ywasmLinearMemoryBytes` from diagnostics `relay`, and B1 "socket survives" (on relay, a socket closed with 1008 counts as a failure).
