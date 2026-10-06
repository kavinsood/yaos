# Relay v2 harness (`scripts/relay2/`)

The harness for PHASE2-RELAY-SPIKE-V2 §6/§7/§8.2. Outputs, contexts and tails live under `$EXP_ROOT/logs/relay2/`
(never in git; contexts hold device tokens, mode 600, never printed).

The bench itself (`context.ts`, `bench.ts`, `lib/`, `scenarios/`, the `wb/` and `b3/` scenario drivers, the L5
baseline, `gqlfill.ts`, `runall.sh`, `runfast.sh`, `reset/b5.ts` and the lease client) drove the legacy plugin client:
`VaultSync`, its production import path and the CLI SQLite store. It was deleted together with that client
(`client-remake(legacy)`); read it from git history. The results it produced are in `RECEIPTS.md`,
`docs/rfc-relay-bodies.md` and section 3 below.

What remains does not depend on any client:

- `deploy.sh`, `cf-cred.sh`, `cf-token.mjs`: scratch deploys and credentials (section 1).
- `gql.ts`, `b3/gqlclasses.ts`, `b3/r2list.ts`, `tail.sh`, `analyze.py`, `tailparse.py`: CPU and cost readers (section 2).
- `convergence.ts`, `summarize.py`, `progress.py`, `costmodel*.py`, `wb/wbmodel.py`: analysis of recorded runs.
- `catalog-rows-read.ts`, `wb/plan-compare.ts`, `wb/sql-capture.mjs`, `wb/corpus.ts`: server store probes and the
  deterministic corpus generator.
- `k3/` (byte-ops bench) and `reset/` (semantic reset builder and policy, K2), tested by
  `tests/server/relay2-reset-*.ts`.


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

## 2. CPU / cost tooling

- `zsh scripts/relay2/tail.sh <worker|url> [label]` runs `wrangler tail --format json` into `logs/relay2/tail-<name>-<label>-<ts>.jsonl`. It refuses names outside `yaos-relay2-*` and unsets `CLOUDFLARE_API_TOKEN` so the OAuth login is used.
- `python3 scripts/relay2/analyze.py <run.json> [--tail f] [--out f]` matches every sample list that has `sentAtWall` to DO ws-message tail events. It corrects for the median clock offset with a 400 ms window and reports per-sample cpu/wall plus per-window, whole-run and alarm totals. Tail units are ms. It uses `tailparse.py`.
- `node ... scripts/relay2/gql.ts --worker <name|url> --start ISO --end ISO` (or `--run run.json [--window <key>]`) queries two GraphQL datasets for the VaultSyncServer namespace:
  - `durableObjectsInvocationsAdaptiveGroups`: requests, wall time and cpu quantiles per type.
  - `durableObjectsPeriodicGroups`: cpuTime, rowsRead/rowsWritten and ws message counts per minute. Windows are padded to whole minutes.
  - Units are µs. The token comes from the wrangler OAuth config, is refreshed with `wrangler whoami` and is never printed. Analytics lag 1–3 min.

**Caveat, tail is lossy.** During C1 on the busy scratch-1, zero ws-message events arrived (20 request events only). On the idle scratch-2, 15/15 matched. Always check `matched/total` in the analyze output, and cross-check totals with gql.ts periodic cpuTime.

## 3. Relay validation (flag on) and what is still pending

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

The X3 11–15 s opens were a network blip: the per-phase X3 shows 1 MB opens at 0.5–0.6 s and 5 MB at about 1 s, dominated by transfer time. The L5 relay variant (`--mode relay,relay250`) and `relay-nocand` (MB sweep) were exercised in round 3 (see RECEIPTS.md).
