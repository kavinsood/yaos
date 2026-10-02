# Relay v3: cutting Cloudflare rows written — complete record

Status as of 2026-10-02. Code: worktree `/Users/kavin/personal/obsidiansync/experiments/yaos-relay2`, branch
`relay-v2-spike`, HEAD `ba57c63` (19 commits on top of `3b66f1b`, where the v2 spike ended). Not pushed.
`yaos/` and `yaos-phase0/` untouched. Workers left deployed (reused `yaos-relay2-v1001-*` pool).

Labels: **measured** = deployed Cloudflare run; **local** = local tests / row accounting; **inferred** = arithmetic
or model. Several fixes landed *after* the deployed run, so their numbers are local/inferred only (section 6).

## 1. The problem

Relay v2 (BODIES + LEAN + MB10) was faster than base but wrote ~5.9 Cloudflare rows per keystroke vs base ~3.1/edit
(measured, v2 C4). The Free plan caps 100k rows written/day; index entries, deletes and each `setAlarm()` count as
rows. The v2 cost model put relay lean at 53–73% of Free on a "typical day" (30 min of actual typing ≈ 1,800 words)
and strict mode over the cap. Causes:

1. **One commit per keystroke.** v2 restored "durable before broadcast", so every frame was its own transaction.
   The 10 ms micro-batch never caught two human keystrokes (~200 ms apart): mb10 5.54 vs mb0 5.55 rows/edit.
2. **~6 rows per commit**: journal row + index, body head, candidate receipt + index, plus checkpoint later
   deleting each journal row and index entry again, plus catalog/alarm.

Neither is inherent to relaying; both are design choices.

## 2. Triage of the five reviews

| Group | Ideas | Verdict |
|---|---|---|
| A. Cause | Commit per keystroke; 10 ms window useless; rows per commit; pay-twice deletes (review 2) | All agreed; adopted. Reviews 4/5 claimed "no fix without RAM buffering = data loss": half right — buffering is safe because the origin keeps edits until receipt and CRDT merge is idempotent |
| B1 | Share now, save in groups, receipt after save | **Done** |
| B2 | One tail row per note, cap 64 KB | **Done** |
| B3 | One receipt row per device (watermark) | **Done** |
| B4 | Fold indexes into primary key; head update per commit | **Done** |
| B5 | Client batches sends every 250 ms (review 3) | I recommended rejecting (adds latency); user asked for it; built, measured (1.53 rows/edit, +280 ms), then **removed entirely** |
| B extras | Save timing (300 ms idle / 1.5 s max / 64 KB); `setTimeout` not `setAlarm`; wake re-sync; client resend after 5 s | **Done** |
| B budget | Lengthen save window as daily budget runs low | **Dropped** (user: don't overengineer for Free) |
| C. Model realism | Typical day generous (1, 2) vs realistic (4, 5); plugins autosaving; account-wide limit; multi-device | Plugins measured; account-wide limit noted, not acted on |
| D. Imports | Bulk endpoint, snapshot imports, pack small notes, R2, budget-aware importer | **Out of scope here** — another agent owns the batch-import API |
| E. Fallbacks | Paid-plan note in docs; usage meter | Meter / "files written most today" deferred to later |

## 3. Decisions made by the user

- Drop "durable before broadcast" for **"durable before receipt"** (base worked this way before `e1ae3a4`).
- "Saved" confirmation may take 0.3–1.5 s instead of ~77 ms.
- No defensive code for DO death beyond: wake re-sync + client resend.
- Disk-originated changes batched 2 s settle / 5 s max.
- Skip budget-adaptive saving; "files written most" panel later.
- `vaultSync.ts` no-touch rule lifted; nobody else on this branch except the batch-import agent.
- Ship v3 once the revoked-device bug is fixed; keep 300 ms / 1.5 s / 64 KB.
- Remove B5 entirely. Fix R11 and HTTP-save cost without end-to-end re-runs.

Checks that needed no work (client @ `a67aaca`): identical-content saves already send nothing (`diff.ts:71`,
`vaultSync.ts:2880`), blobs skip on hash match, `.obsidian/` and `.trash/` are always excluded (`exclude.ts`).

## 4. What was built (commits on `relay-v2-spike`)

**Server** (behind `YAOS_RELAY_GROUP_COMMIT=1`, needs BODIES + LEAN; v2 path unchanged for comparison):

| Commit | Change |
|---|---|
| `28ed06b` | Group commit (broadcast immediately, buffer, commit on idle/max/bytes via `setTimeout`, receipts after commit), one tail row per body, one receipt row per device, schema trims, wake re-sync (step1 to every open socket), test route `debug/relay-crash` |
| `2141714` | Catalog alarm armed at most once per window (`YAOS_RELAY_GC_CATALOG_DELAY_MS`, 30 s); revoked frame no longer double-counted |
| `3cff026` | Group-commit test suite + `docs/relay3-group-commit.md` |
| `fd52578` | Cumulative-safe acks: socket fenced at a refused frame; acks held after wake until step2 durable; HTTP candidate/currentness flush the body buffer first |
| `d3b4db8` | **R11 fix**: authority writes (revoke/fence) first flush all buffered frames; authority cache invalidated at once; frames from a device revoked at flush are committed (they were already broadcast), socket closed 4403 |
| `14e5250` | HTTP candidate saves go through the group-commit store: 14 → 3 rows (no-op 1, replay 0) |
| `4a34f56` | **Commit-rate cap** `YAOS_RELAY_GC_MIN_INTERVAL_MS` = 1000 (idle commit also needs ≥ 1 s since last commit); **R12 raw rate gate**: bucket charged on raw message size as the first step, hard size cap, close 1013 on first overdraft, later messages dropped in O(1) |

**Client** (`src/`):

| Commit | Change |
|---|---|
| `21bc79d`, `de54b56` | Disk-originated markdown batching 350 ms / 2 s → 2 s / 5 s; typing unaffected |
| `7d70ea9` | Socket-ack receipts: cumulative confirmation, resend unconfirmed after 5 s (backoff to 60 s, ±20%), resend on reconnect, HTTP fallback after 15 s; settle without HTTP POST |
| `1a34693` | 7 VaultSync end-to-end-in-process receipt tests; status bar says "saving latest local state…" while waiting |
| `3aa7c44` | B5 removed from client, harness, deploy spec and cost model |

**Harness / docs**: `21ff4a3`, `d067cd6`, `8730d32`, `e3a1b85` (v3 deploy spec, CRASH/FENCE/HTTPSAVE/autosave
scenarios, `costmodel3.py`); RFC `129c4eb`, `5f91664`, `ba57c63`.

## 5. Deployed measurements (≈21:30–22:25 UTC, ~55 min)

Taken at `e3a1b85`-era code: **before** R11 fix, HTTP-save change, B5 removal, commit-rate cap and rate gate.
Latency phases ran concurrently (`--lane-a-parallel`).

| Metric | base | relay v2 | v3 | Label |
|---|---|---|---|---|
| Rows/keystroke, steady 5 keys/s (MB type5) | 5.58 | 5.63 | **0.29** (real client; 0.42 with candidateId) | measured |
| Typical day, % of Free | 30–52% | 51–53% | **3%** | inferred |
| Heavy day, % of Free | – | ~330% | 18% (assumed 5 keys/s; see 6) | inferred |
| Propagation p50/p99 (L2) | 299/696 ms | 63.0/396 | **47.7/76.3** | measured |
| L4 p99 (fast typing) | – | 2,305 ms | 231 | measured |
| Edit → "saved" p50/p99, real client | 479 ms (p50) | – | 353/1,177 ms; 0 HTTP POSTs | measured |
| Autosave 1/s × 8 h, open note | ~470% | – | 65% (2.15 rows/save) | measured per save, inferred per day |
| Autosave 1/s × 8 h, closed note (HTTP) | – | – | 82% (13.82 rows/POST) | same |
| Canvas identical re-save | – | – | 0 rows | client code |
| DO requests vs base | 1× | 1.15× | 1.15× typical, 1.34× heavy, ≤ 11% of Free | inferred |

Correctness on v3 (measured): crash with buffered edits 10/10, 0 of 51 frames lost (incl. origin offline);
convergence 9/9, CW 121/121, reset races 20/20; B1, B6, B8, X1, X4, C5, C2-stress, HTTPSAVE pass; cumulative-ack
fence 5/5. **Failed:** B4 revoke convergence (R11 — fixed since, section 6); B7 flood 1/3 (R12 — one CF
`1013 Service overloaded`, one post-redeploy 1006, one pass; fixed locally since).

## 6. After-run fixes (local tests only, not deployed)

- **R11**: local repro of 10 buffered frames + revoke now converges; revoke racing broadcast converges; post-fence
  frames never broadcast or stored.
- **HTTP save**: 14 → 3 rows/POST (≈ 4.0 incl. batched catalog event) → closed-note autosave day ≈ 24% of Free,
  down from 82% (inferred by scaling the measured run).
- **Commit-rate cap** — the measured 0.29 was a best case; gaps > 300 ms committed per keystroke:

  | Typing | rows/key before → after | receipt p50 / max after |
  |---|---|---|
  | 1 key/s | 3.00 → 3.00 | 300 / 300 ms |
  | 2 keys/s | 3.00 → 1.55 | 800 / 800 ms |
  | 3 keys/s | 3.00 → 1.03 | 633 / 967 ms |
  | 5 keys/s | 0.38 → 0.38 | 900 / 1,500 ms |
  | 8 keys/s | 0.25 → 0.25 | 875 / 1,500 ms |
  | bursty 0.1–2 s gaps | 2.61 → 2.23 | 300 / 1,362 ms |

  Bound: ≤ 1 commit/s per active note ≈ ≤ 3 rows per second of activity. RFC heavy day (2 keys/s, 8 h):
  115k–173k → ≈ 89k rows (inferred) — fits, narrowly. A 2 s min interval would give ≈ 45–50k at 2–3 s receipts.
- **Rate gate (R12)**: root cause was the limiter running after parse, SHA-256, authority check and a SQL read, and
  counting only update bytes, so the DO fell behind and saw the overdraft only after the backlog. Local: 5 MiB/s
  flood closed after 375 ms; 740 later messages dropped without parse/validate; bystander unaffected.
- Local suite: 187/187 suites, all three typechecks clean (at `ba57c63`).

## 7. Invariants changed

- "Durable before broadcast" → **"durable before receipt"**. A crash can lose buffered frames that peers already
  applied; the origin was never acked so it resends, and wake re-sync pulls frames back from connected peers.
- Receipts are **cumulative** per socket; a refused frame fences the socket so no later ack covers it.
- Frames already broadcast are committed even if the device is revoked before flush; nothing after the fence is
  broadcast or stored.

## 8. Open items

1. **Deployed re-check** (~20 min) of everything in section 6: C4/MB rows at several typing rhythms, B4 revoke,
   B7 flood (serial), HTTPSAVE. Nothing after `e3a1b85` has run on Cloudflare.
2. Heavy-day margin ≈ 89% with a 1 s min interval; decide whether to raise it to 2 s.
3. Rate gate: ~1.8 MB of flood still fully processed before cutoff; CF can still shed a saturated DO; budget is
   per socket and resets on reconnect; verify a large reconnect resend (merged into one message) never exceeds the
   burst/size cap and gets refused forever.
4. R10: DO requests 1.15× base (bar 1.1×) still needs sign-off.
5. Not re-run on v3: C1 CPU, X1 at scale, R2 starvation, stored-state growth.
6. HTTP fallback replay still writes a 4-row idempotency receipt path in rare cases (after 15 s without receipt).
7. Imports (batch-import API) belong to the other agent; "files written most today" panel deferred.

## 9. Files

- This report: `experiments/results/relay3/REPORT.md` (copy in repo: `docs/relay3-report.md`)
- Deployed tables: `experiments/results/relay3/RESULTS.md`
- Server design, row accounting, every fix: `experiments/results/relay3/SERVER-NOTES.md`
- Client changes, timing audit, Canvas/open-note findings: `experiments/results/relay3/CLIENT-NOTES.md`
- RFC: `yaos-relay2/docs/rfc-relay-bodies.md` (copy `experiments/results/relay3/RFC-relay-bodies.md`)
- Group-commit design: `yaos-relay2/docs/relay3-group-commit.md`
- v2 baseline: `experiments/results/relay2/REPORT.md`, `RESULTS.md`
