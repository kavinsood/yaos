# Timer audit (phase 1)

Branch `client-remake` @ `84c4a909`, 2026-10-19. Every timer, delay and time rule in `src/core/limits.ts`,
`src/engine/runtime/options.ts`, the engine, the host and `server/src`, traced to what it protects. Line numbers are
at that commit. **Verified** = re-read in the code during the audit; UNCONFIRMED = inferred, not checked on a device or
in a test.

Classes:

- **durability**: user data that is only in memory while the timer is pending; a crash or OS kill loses it.
- **latency**: the data is safe, but other devices (or the user) see it later.
- **cost**: batching or holding back to save writes, network or battery.
- **housekeeping**: compaction, checkpoints, GC; waiting makes storage or bootstrap bigger, not data less safe.

## Where an edit is durable

```
keystroke ─16 ms─▶ worker FrameBuilder ─100 ms idle / 300 ms max─▶ repo.tEdit (IDB outbox) ─▶ sender ─▶ relay
   main memory        worker memory        (×4 over daily budget)      committed            group commit
                                                                                            300 ms / 1.5 s
Obsidian save (≈2 s, Obsidian's own debounce) ─▶ vault file on disk
outbox mirror (1 s) / synced mirror (2 s) ─▶ side files (backups for IndexedDB loss only)
```

- Until the open frame closes, an edit is in memory only. Its one durable copy is the vault file, once Obsidian has
  saved it. DESIGN §d.4 accepts this window ("Durability window"); after a kill the disk merge at bind/reconcile
  recovers whatever reached the file.
- The frame is committed to IndexedDB **before** it is sent: `closeFrame` → `repo.tEdit` → `addOutbox`
  (`docRuntime.ts:148-149`, `repo.ts:353`). Every network timer below waits on data that is already committed.
- On `hidden` / `pagehide` / `freeze` the host flushes editor buffers and the vault-event batch, posts `lifecycle`,
  and calls `saveViews`. The worker closes every open frame and flushes the outbox mirror, then the synced mirror
  (`hostRuntime.ts:206-212`, `vaultRuntime.ts:572-578`, `engine.ts:380-385`). None of it is awaited.

### The three timers checked first

| Timer | Verdict |
|---|---|
| `MAIN_UPDATE_COALESCE_MS` 16 ms (`binding.ts:461`) | A fixed delay, not a debounce: armed only while no timer is pending, so continuous typing cannot starve it. An Obsidian save flushes it first (`binding.ts:480`), and so does a lifecycle event. Holds about 16 ms of ChangeSet in main-thread memory. **Fine.** Verified. |
| `OPEN_FRAME_IDLE_MS` 100 / `OPEN_FRAME_MAX_MS` 300 (`frameBuilder.ts:40`, armed `docRuntime.ts:119`) | A debounce with a hard cap (`min(lastPush + idle, openedAt + max)`), also closed at 256 updates or 64 KiB. This is the real durability window: about 316 ms of edits in worker memory, 1.2 s once over the daily frame budget. **Fine**, apart from the write-gate case (F2). Verified. |
| `OUTBOX_MIRROR_DEBOUNCE_MS` 1 s (`mirrorIo.ts:86`) | **A backup copy.** The outbox lives in IndexedDB; the A/B side files exist only to recover after IndexedDB loss (`mirrorIo.ts:1-10`, DESIGN §e.4). It is a fixed delay from the first change, not a debounce. **Fine.** Verified. |

## Findings, ranked

**Fixed since the audit:** F1, F2, F3 and F4 (see the Fix column); `SYNCED_MIRROR_DEBOUNCE_MS` (30 s, dead) and
`OUTBOX_SOFT_BYTES` (never enforced) were removed from `limits.ts`, and DESIGN.md now matches the code on the points
below.

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | High, **fixed** (one miss re-pings at once; 2 misses in a row are fatal, `PING_MISSES_FATAL`) | **A missed engine ping stops sync until the user restarts it.** The host pings every 10 s; no pong within 15 s → `onCarrierFailure` → fatal → `phase: "failed"`, with no automatic restart. Two ways to set it off: a worker task longer than 15 s (big import, slow crypto on a cheap phone), or resume after a freeze, if the overdue timeout fires before the queued pong arrives. | `transport.ts:26-27`, `engineHost.ts:277-301`, `pluginController.ts:209-213` | Fatal path verified; both triggers UNCONFIRMED |
| F2 | Medium, **fixed** (held updates merged every `FRAME_MAX_UPDATES`; the file stays the durable copy) | **Edits pile up with no time or size cap while the e2ee write gate is shut.** `closeFrame` returns early when `gate() !== null`, and that includes the "frame full, close now" path. So the open frame can grow without bound in worker memory until the keyring opens. The vault file is the only durable copy for the whole period, and a kill loses whatever the file doesn't hold. | `docRuntime.ts:126-134`, `engine.ts:289` | Verified. Disk recovery for this case UNCONFIRMED |
| F3 | Medium, **fixed** (`REMOTE_CHECKPOINT_HARD_ROWS` / `_BYTES`: past 4× the hot threshold no idle gate) | **Hot checkpoint never fires on a stream that never idles for 30 s.** Each row resets `idleFor` and clears `condSince`, so neither the duty device nor the fallback ever writes. DESIGN §d.9 means the idle gate to be there, but its bound ("a doc idle for 30 s carries fewer than 256 rows") assumes a pause comes. A plugin that rewrites a note every 10 s, or two devices taking turns, grows that stream's relay tail without limit, and with it the bootstrap cost for new devices. Folds already avoid this: their hot rule has no idle gate. | `checkpoints.ts:133-138,148-166`, DESIGN §d.9 | Verified |
| F4 | Medium, **fixed** (a retry without a session re-arms without counting) | **A causal hole freezes the doc after about 3 min offline.** `causalRetry` counts the attempt and then calls `runRead`, which does nothing without a session. Three empty "attempts" 60 s apart → `freeze("causal-hole")` without any read having happened. | `docRuntime.ts:287-303`, `sessionLoop.ts:311-316` | Verified. How the freeze recovers UNCONFIRMED |
| F5 | Medium, **resolved by the sim** (see "F5: the budget B" below: one commit after the event is enough; the seed-141 `saveViews` bug it found is fixed; a device probe is optional calibration) | **The background flush is started but not awaited.** Frame close goes through sealing (`buildBodyFrames`) before `tEdit`, so the IndexedDB transaction starts several async hops after the `pagehide` handler returns. DESIGN §i.4 says the flush is "started synchronously (IDB transactions start in the event turn)", which is not true with a worker engine. Whether it finishes before iOS/Android suspends or kills the app is unknown. | `hostRuntime.ts:206-212`, `docRuntime.ts:148-149` | Code verified; device behaviour UNCONFIRMED |
| F6 | Low-Med, **fixed** (`visible` / `resume` with a session open send one probe ping; no pong in `RESUME_PROBE_TIMEOUT_MS` (5 s) closes it as dead and reconnects at once, `sessionLoop.wake`) | **Possible stall of about 15 s after an iOS resume on a dead socket.** If the app is suspended inside the 30 s hidden window, the socket dies silently. On resume, `wake` → `connectNow` → `connectOnce` returns at once because `c.session` is still set. Recovery waits for the liveness idle check plus a 15 s ping timeout. Sending one probe ping from `wake()` when a session exists would fix it. | `sessionLoop.ts:85-87,577-582`, `wsRelay.ts:405,423` | Code verified; stall UNCONFIRMED on device |
| F7 | Low-Med, **fixed** (`online` or a relay session after none makes every blob / ref / touch retry due now, attempt counts kept; one wake per 5 s) | **Blob and ref backoffs ignore `online`.** The 2 s → 10 min backoff (blob queue, `refRetry`, touch re-PUT) keeps its due time when the network comes back, so an attachment can look stuck for up to 10 min after reconnecting. | `blobQueue.ts:100-101,352,369`, `docRuntime.ts:237`, `touch.ts:94-95` | Not re-verified |
| F8 | Low-Med, **mostly fixed** (see Idle cost below) | **Idle wakeups never stop.** The 1 s maintenance tick runs for the engine's whole life, backgrounded or not. Each tick calls `scheduleStatus`, so a status message goes to the main thread every second with no dedupe. Desktop also does a full reconcile every 5 min, and relay liveness pings every 60 s wake the hibernated DO (no `setWebSocketAutoResponse`). On phones, OS suspension hides this; on laptops it is a constant battery cost. | `maintenance.ts:37-43,77`, `context.ts:570-576`, `socketLiveness.ts:5-6` | Tick and status verified |
| F9 | Low, **fixed** (gives up after 26 h, about 31 attempts; journal kept, marked failed, shown to the operator, resumable) | **The server's restore alarm retries forever.** 30 s doubling to 1 h, no limit on attempts: a restore that never completes costs about 24 alarm wakes and RPCs a day indefinitely, with no give-up and no operator signal. | `server/src/config/restore.ts:18,25,130-168` | Not re-verified |
| F10 | Low, **fixed** (`STREAM_HOLD_MAX_MS` 5 s from admission: a frame held behind an index build then commits with the index built inline; env idle/max/lead/min-interval clamped to 5 s; held frames re-arm at the idle window, not the 20 ms lead edge, which had fired ~50/s for a whole build) | **Relay hold times have no cap while an index build runs.** Group commit is capped at 1.5 s, but frames held behind a dedupe-index build re-arm both timers. The env vars also allow an idle wait of up to 60 s with frames only in DO memory. | `server/src/streams/relay.ts:86-123,739-816` | Not re-verified |
| F11 | Low, **fixed** (engine start: 5 s doubling to 5 min, reset by `online` / `visible` / `resume`; settings text: saved at most `TEXT_MAX_WAIT_MS` (3 s) after the first unsaved keystroke and at once on `hidden` / `pagehide`, `draftDebounce.ts`; relay flap: the reconnect backoff resets only after a session stayed up `SESSION_STABLE_MS` (60 s)) | Engine start retries every 5 s forever with no backoff (`protocolEngine.ts:330`). The settings text debounce (600 ms) resets on each keystroke with no cap and is not flushed when the app goes to the background (`settingsTab.ts:392`). A flapping relay gets a fresh 0-1 s retry each time it reaches live (`sessionLoop.ts:168,181`). | as listed | Not re-verified |

**The senior engineer's "unbounded debounce" check:** only three timers reset on input. The open frame has a cap.
The blob transfer idle window deliberately has none while bytes still move. `BOUND_SAVED_DEBOUNCE_MS` (50 ms) and
the settings text field have no cap, and neither holds sync data. Everything else called a "debounce" is a fixed
delay from the first change, so continuous input cannot starve it.

## F5: the budget B (sim answer)

`node scripts/sim-suspend.mjs` (fault `suspendKill`, opt-in via `SUSPEND_FAULTS` / `SimConfig.suspend`): one forced
`hidden` / `pagehide` / `freeze` right after a typing step, then the app dies after B storage commits on that device
(0 = at the event, before any posted message runs) and restarts from its crash copy. Two variants: the host's
`saveViews` reached the disk before death ("landed") or did not ("lost"). The loss figures count text that was only in
memory at the event (editor, binding buffer or open frame); 2 devices, 60 steps, production frame windows.

| B (commits after the event) | save landed: tokens lost | save lost: tokens lost |
|---|---|---|
| 0 | 1 / 43, seed 141: a real bug, below (0 after the fix) | 42 / 43 (98 %) |
| 1, 2, 3, 5, never | 0 | 0 |

(200 seeds per cell. A rerun with 150 seeds on the tree with F1-F4 fixed gives the same result.)

- **B = 1 commit is enough.** In the never-killed control, the first commit after the event is the edit commit
  (`tEdit`) in 32 of 33 runs with text only in memory. On hardware, B therefore means "time for the worker to receive
  the posted message, seal the frame and land one IndexedDB transaction". The device probe only has to show that
  this window exists after `hidden`.
- **If Obsidian's save lands, B = 0 is fine** (the disk merge on the next start recovers the text), apart from seed 141.
- **Seed 141 (real bug, fixed):** `BindingManager.saveViews` (`src/host/binding.ts:266`) saves every view of a
  doc in order. A keystroke reaches other views of the same file only after Obsidian's 10 ms
  `onInternalDataChange` delay. So view 2's save writes the token to disk, then view 3's older text overwrites it. If
  the app dies before the engine gets the edit, the text is gone. Replay: `runSim({ seed: 141, devices: 2,
  faults: null, steps: 60, tuning: { frameStretch: 1 }, suspend: { budget: 0, save: "landed" } })`. Fixed: `saveViews`
  saves one view per doc, the one with the newest local edit (`viewsToSave`). The fault's "landed" variant now
  replays that same choice; it used to save every dirty view itself, which copied the bug into the harness. After the
  fix, `landed B=0` loses nothing over 200 seeds.
- **The iPhone measurement doesn't change what we do.** With seed 141 fixed, the only loss left is B = 0 with
  Obsidian's save not landing: the process is frozen as the event handler returns, before any of our async work or
  Obsidian's write runs. No async fix reaches that case. A main-thread IndexedDB write issued inside the handler
  would depend on the same unknown platform behaviour (does a transaction started before the freeze commit?). So the
  device probe is optional calibration, not a blocker.
- The sweep also fixed a harness bug. `src/sim/inspect.ts` opened its crash-inspection engine without a
  `vaultEpoch`, so it only ever saw side records. Text in committed outbox or tail rows always counted as not
  durable, which made the crash exemption in the token check too generous for every crash fault.

## Idle cost (bloat)

`src/sim/idleCost.test.ts` (`src/sim/idleCost.ts`): a desktop and a phone on production timers sync a note, settle,
then sit for a virtual hour with nothing changing (visible, then the phone hidden). Counts are for both devices
together.

| Per idle hour | Before | After |
|---|---|---|
| Timers fired (wakeups) | 23,868 | 876 |
| Maintenance ticks | 7,200 | 240 |
| Status posts to main | 7,218 | 18 |
| IndexedDB commits / relay appends / mirror writes | 0 / 0 / 0 | 0 / 0 / 0 |
| Vault listings (full reconcile) | 18 | 4 |

What changed:

- **Adaptive maintenance tick** (`maintenance.ts`): 1 s while work is pending; idle, the interval doubles up to
  `MAINTENANCE_IDLE_MAX_MS` (30 s); activity (`ctx.onActivity`) snaps it back.
- **Only changed status reaches main** (`HostLink.post` drops a snapshot equal to the last one sent). The status
  bar re-renders on hover so "last synced N min ago" stays current.
- **Engine start retry backoff** (`protocolEngine.ts`): 5 s doubling to `START_RETRY_MAX_MS` (5 min), retried at
  once on `online` / `visible` / `resume`. A device that cannot start went from 3,600 tries an hour to about 20.
- **Relay keepalive** (relay-wire §4.2): when `VAULT_READY.liveness.keepalive` is set, the idle probe is the fixed
  text `VAULT_KEEPALIVE`. The runtime answers it (`setWebSocketAutoResponse`, `server/src/vault/vault.ts`), so it
  does not wake a hibernated vault DO. Every 10th idle probe stays a `VAULT_PING`, because its pong carries the head
  (the idle gap check). DO wakes from an idle socket go from about 60 an hour per device to about 6. The sim's
  relay has no liveness pings, so this is covered by `wsRelay.test.ts` and `tests/server/streams-relay.ts`, not by
  the idle counter.
- **Restore alarm cap** (`server/src/config/restore.ts`, F9).
- **Idle-aware worker ping** (`engineHost.ts`): was about 80 % of the 2,748 left after the changes above. Each pong
  on a quiet link doubles the gap from `PING_INTERVAL_MS` (10 s) to `PING_IDLE_MAX_MS` (60 s); any request to the
  worker resets it; engine traffic within the interval counts as a pong. Hang detection while idle goes from
  ~25 s to at most ~90 s (60 s gap + 2 × 15 s timeouts); while the user is active it is unchanged.
- **Idle-aware full reconcile** (`hostRuntime.ts` scan, `passScheduler.ts` periodic pass): a scan whose listing
  (path, size, mtime) is unchanged, or a full pass with nothing actionable, doubles the interval up to
  `FULL_RECONCILE_IDLE_MAX_MS` (60 min). A vault event or a docs request resets it; `visible` / `resume` scan at
  once as before.

What's left of the 876: one maintenance tick plus its status refresh every 30 s per device, and the worker ping
every 60 s per device, each a few timers. Cutting further means stopping the tick entirely when idle, which trades a
simple invariant (every deferred job is re-checked within 30 s) for event-driven wakeups everywhere. Not worth it.

## Docs and code that disagreed (DESIGN.md corrected)

- DESIGN §d.4 says the frame timers stretch "up to 10×"; the code uses ×4 (`context.ts:561`, DESIGN.md:910).
- `SYNCED_MIRROR_DEBOUNCE_MS` exists twice: 30 s in `limits.ts:159` (unused) and 2 s in `syncedMirror.ts:29` (used).
- DESIGN §i.4's "started synchronously" claim (F5).
- The names `OUTBOX_MIRROR_DEBOUNCE_MS`, `SYNCED_MIRROR_DEBOUNCE_MS` and `SUBSCRIBE_DEBOUNCE_MS` describe fixed delays, not debounces.

## Inventory

### Editor → disk → IndexedDB → relay

| Timer | Value | Armed at | Waiting while pending | Durable already? | Class | Resets / cap |
|---|---|---|---|---|---|---|
| `MAIN_UPDATE_COALESCE_MS` | 16 ms | `binding.ts:461` | ChangeSet, main memory | file, if Obsidian saved | durability (tiny) | no |
| Open frame | 100 / 300 ms, ×4 over budget | `docRuntime.ts:119` | Yjs updates, worker memory | file only | durability | idle resets, 300 ms cap, 256 upd / 64 KiB |
| Sender `schedule(0)`, token bucket 192 KiB/s, 50 ms high-water poll | — | `sender.ts:351,484-489` | outbox rows | IDB | latency / cost | no |
| Backpressure hold / slowdown | 5 s / 10 min | `sender.ts:310,401` | outbox rows | IDB | cost | max() |
| `DURABILITY_RETRY_MS` | 1 s | `sender.ts:422` | outbox row | IDB | housekeeping | no |
| `NS_CORK_MAX_MS` | 2 s | `sender.ts:335` | ns frames | IDB | latency | fixed max |
| Outbox mirror | 1 s | `mirrorIo.ts:86` | side-file copy lags IDB | IDB | backup | no |
| Synced mirror | 2 s | `syncedMirror.ts:109` | side-file copy lags IDB | IDB | backup | no |
| `BOUND_SAVED_DEBOUNCE_MS` | 50 ms (1 s after error) | `boundDisk.ts:97` | save check only | file | housekeeping | **resets, no cap** (harmless) |
| `VAULT_EVENT_BATCH_MS` | 50 ms or 256 events | `runtimeSupport.ts:105` | vault events, main memory | file | latency | no |
| `HIDDEN_CLOSE_MS` (phone/constrained) | 30 s | `vaultRuntime.ts:586` | nothing (flush already started) | — | cost | no |
| `ECHO_TTL_MS` / `RACY_WINDOW_MS` | 10 s / 2 s | `echo.ts:31`, `scan.ts:51` | time comparisons, not timers | — | correctness | — |

### Network, sync and keyring

| Timer | Value | Armed at | Class | Notes |
|---|---|---|---|---|
| Relay reconnect | 1 s → 5 min, full jitter | `sessionLoop.ts:123`, `relayPolicy.ts:41` | latency | reset on live; `online`/`visible`/`resume` connect at once |
| `SUPERSEDED_RETRY_MS` | 60 s | `relayPolicy.ts:49` | latency | `wake` bypasses it |
| Unclaimed / daily limit | 1 h / `retryAfterMs` | `relayPolicy.ts:18-20` | cost | every visibility flip retries (ticket + socket) |
| Connect deadline | 15 s | `wsRelay.ts:598,631` | latency | |
| Liveness idle → ping timeout | 60 s → 15 s | `wsRelay.ts:405,423` | housekeeping | F6, F8 |
| `BLOB_TRANSFER_IDLE_MS` | 60 s without progress | `httpBlob.ts:162` | latency | resets per byte, deliberately no cap |
| `bounded()` HTTP deadline | 15 s + bytes / 64 KiB/s | `deadline.ts:93` | latency | |
| `SUBSCRIBE_DEBOUNCE_MS` | 250 ms | `subscriptions.ts:76` | cost | a throttle |
| `PROVISIONAL_ADOPT_MS` | 60 s from wall-clock `receivedAtMs` | `context.ts:379` | consistency | survives restart |
| Causal re-read | 60 s × 3, then freeze | `docRuntime.ts:275,302` | consistency | F4 |
| Ref retry / blob queue / touch | 2 s → 10 min; 1 s → 60 s | `docRuntime.ts:237`, `passScheduler.ts:157`, `touch.ts:209` | latency | no jitter; F7 |
| `passScheduler` debounce / retry | 30 ms / 1 s → 60 s | `passScheduler.ts:82,149` | latency | |
| `KEY_STORE_WAIT_MS` | 5 s | `secretStore.ts:188` | latency | one-shot at startup |
| keyring `k` daily-limit retry / meta write | `retryAfterMs` or 60 s / 30 s | `keyringRuntime.ts:288,49` | latency | |
| Engine start retry | 5 s flat, forever | `protocolEngine.ts:330` | housekeeping | F11 |

### Housekeeping

| Rule | Value | Where | Bounded? | Notes |
|---|---|---|---|---|
| Maintenance tick | 1 s, forever | `maintenance.ts:37-43` | — | F8 |
| Status | 250 ms after request (requested every tick) | `context.ts:570` | — | F8 |
| Local compaction | 200 rows / 256 KiB; background waits for 2000 rows | `limits.ts:108-109,135`, `maintenance.ts:100-119` | rows yes; **bytes not while backgrounded** | ≤4 per tick on resume |
| Hot remote checkpoint | ≥256 rows or ≥1 MiB, then 30 s idle | `checkpoints.ts:148-166` | **no** | F3 |
| Settle checkpoint | 2 min idle; 1000 puts per device per day | `checkpoints.ts:113-120` | yes (tail <256) | daily cap kept in memory, resets on restart |
| Checkpoint fallback | 10 min + [0, 10 min) jitter | `checkpoints.ts:34,141-145` | inherits F3 | |
| Fold checkpoint | 1000 rows / 1 MiB (no idle gate), settle 2 min | `checkpoints.ts:315-323` | yes | |
| Checkpoint backoffs | 60 s / 10 min / 1 h | `maintenance.ts:19`, `checkpoints.ts:36,252` | yes | `tooLarge` waits for a 25% shrink |
| Skip-defer read | desktop 5 s / 30 s; tablet, phone 150 s / 10 min; constrained 150 s / 15 min | `limits.ts:272-277` | yes (`maxDeferMs`) | |
| Gap feed / read backoff | 5 s / 5 s | `maintenance.ts:81-98` | yes | |
| Recent-unbound keep | 8 docs / 10 min | `subscriptions.ts:96-101` | yes | |
| Full reconcile | 5 / 10 / 10 / 15 min, idle doubling to 60 min | `passScheduler.ts` `armPeriodic`, `hostRuntime.ts` `scheduleReconcile` | — | fixed: idle backoff |
| Daily snapshot | 24 h, piggybacks on full pass | `snapshotJob.ts:118-126` | yes | |
| Blob GC grace | 7 d; GC only as a user command | `options.ts:105`, `engine.ts:370` | **no automatic sweep** | unreferenced blobs stay on the relay until clean-up |

### Host UI and liveness

| Timer | Value | Where | Notes |
|---|---|---|---|
| Engine ping | 10 s interval (idle: doubling to 60 s), 15 s timeout, 2 misses fatal | `engineHost.ts` `schedulePing` | F1, F8 |
| Startup ping / init / request / shutdown | 5 s / 120 s / 60 s / 3 s | `engineHost.ts:28-31` | |
| Status bar render | 250 ms throttle | `statusBar.ts:259` | "last synced" tooltip only refreshes on status change |
| Settings text | 600 ms, resets, no cap | `settingsTab.ts:392` | F11 |
| Pairing countdown | 1 s interval, wall clock | `pairModal.ts:338` | the QR code (it carries the vault key) can stay on screen past expiry while backgrounded |
| Pairing deadlines / retries | ~15 s; [1,2,4,4,4] s | `pairing.ts:206,321` | |
| `waitFor` / `sendRetrying` | 20-60 s / 1 s, 30-60 s deadline | `hostWait.ts:26`, `keyActions.ts:93-103` | real limit about 2× the deadline |

### Server

| Timer | Value | Where | Notes |
|---|---|---|---|
| Group commit | 300 ms idle (≥1 s after previous), 1.5 s max, 20 ms lead, 64 KiB flush | `relay.ts:86-91,739-750` | frames are in DO memory until commit; receipts only after commit. Hard cap 5 s from admission, index builds included (F10, fixed) |
| Restore alarm | 30 s → 1 h, attempts uncapped | `restore.ts:18,25` | F9 |
| Restore flag | 60 s, memory | `vault/host.ts:59` | |
| Daily limit latch | until 00:00 UTC, memory | `dailyLimit.ts:114-136` | |
| Socket liveness descriptor | 60 s / 15 s | `socketLiveness.ts:5-6` | F8 (DO wakes) |
| Ticket / pairing code / session TTL | 5 min / 15 min (rows kept 24 h) / 7 d | `ticket.ts:13`, `pairing.ts:6-8`, `config/host.ts:24` | old rows pruned only on next mint / login |
| Login / enroll / blob-GC limiters | 20 / 20 / 60 per min, memory | `limiter.ts` | reset when the DO is evicted |

## Next

1. Fix F1 (auto-restart the engine after a missed pong, or tolerate one miss after `resume`) and F4 (don't count a
   causal attempt when no read ran). Both are small.
2. Decide F3: add a time-from-first-condition cap or a hard row cap that bypasses the idle gate, like folds have.
3. Cap F2 (frames held while the gate is shut) or confirm the disk merge recovers them, with a sim fault: "key
   missing for N min, then crash".
4. Phase 3 sim faults: crash while the open frame is pending, crash while the gate is shut, resume with a dead
   socket (F6).
5. On a device: confirm F5 and F6 (lifecycle flush completes before suspend; resume stall) with the spike harness.
6. F8 on desktop: stop the maintenance tick, or slow it, while idle and hidden; dedupe status posts.
