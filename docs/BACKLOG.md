# Current backlog

Only evidenced unresolved work belongs here. Completed plans, implementation
reports, and historical run results belong in the external document archive.
The product and validation buckets are intentionally separate: missing field
evidence must not be presented as a missing mechanism.

Current compatibility pins are document schema 8, durable storage format 4,
socket protocol 5, recovery format 3, settings format 2, and control-plane
identity format 3.

## Open product work

### ATTACH-01 — mobile Canvas rollback and Excalidraw save freeze

**Risk:** Reporter-shaped mobile Canvas rollback/oscillation and sporadic
Excalidraw save freezes remain unresolved. A desktop two-device Canvas/Base run
closed the hibernated-root-broadcast defect but did not reproduce either
remaining symptom.

**Next action:** Reproduce each affected host shape and trace watcher admission,
attachment revision, transfer, publication, local hash, conflict choice, and
suspend/restart ordering. Fix the demonstrated cause; do not change merge
semantics speculatively.

**Closure:** Each symptom has a focused reproduction, root cause, regression,
and equivalent real-device confirmation.

### PATH-01 — canonical path identity is not enforced everywhere

**Risk:** `src/paths/pathCollision.ts` explicitly provides detection only and
states that admission enforcement is future work. Root/catalog keys, initial
import, disk indexes, reconciliation, and attachment paths still reach path
normalization through different boundaries.

**Next action:** Define one display-path versus identity-key invariant and apply
it at import, create, rename, bootstrap, disk indexing, reconciliation, and
attachment admission. Decide case sensitivity separately.

**Closure:** NFC/NFD- or separator-equivalent paths cannot create distinct
shared identities, collision handling is deterministic, and no competing
normalization path remains.

### RENAME-01 — pre-debounce rename intent is volatile

**Risk:** `VaultSync` still holds `renameBatch` and `renameTimer` in memory,
clears the batch before the durable structural submission, and reconstructs no
pre-debounce intent after process loss. Rename itself works; the open issue is
restart ownership during that short window.

**Next action:** Persist or reconstruct the exact batch before arming debounce,
bind every entry to source, target, body, generation, and supersession proofs,
route retry through the shared work scheduler, then remove the old timer.

**Closure:** Restart, response loss, target collision, source reuse, teardown,
and cancellation leave one retry owner and no lost rename intent.

### REPAIR-01 — no bounded periodic missed-work repair planner

**Risk:** Current reconciliation reacts to known watcher, feed, startup,
foreground, and durable-work events. There is no bounded planner that discovers
an inconsistency for which every triggering event was missed.

**Next action:** First define an authoritative scan scope, cursor, work limit,
repair-unit identity, currentness proof, and typed outcome. Only then schedule
those concrete units through the existing overdue-work owner.

**Closure:** A missed inconsistency is discovered and repaired with bounded
CPU/I/O, restart continuation, explicit blockers, and no second retry loop.

## Validation and QA only

These are release-confidence gaps, not established missing implementations.
Detailed run reports remain outside `docs/`.

### QA-COLLAB — real multi-person journey

Run invitation acceptance on another person's device, per-device presence,
member removal with unpublished-work preservation, ownership transfer and
reconnect, owner recovery, and security-audit UX. Downloaded plaintext cannot
be remotely erased and is not a closure criterion.

### QA-ATTACH — reporter-shaped admission confirmation

The revisioned Markdown admission scheduler now provides settling, a hard
deadline, stable candidate identities, rename/drop fencing, scheduler-owned
retry, and startup lifecycle replay. Confirm the original iOS Web Clipper burst
shape on a real device; this is validation of the delivered mechanism unless a
new failure is observed.

### QA-CANVAS — semantic Canvas release matrix

Explicit per-file promotion is implemented. Default semantic creation and
vault-wide promotion remain gated on desktop/mobile host combinations,
suspend/restart, two-device offline convergence, large-canvas interaction
latency, deployed hibernation/reconnect, and rollback rehearsal.

### QA-RECOVERY — real Obsidian replacement

Exercise changed Markdown, a missing path, a deleted identity, Canvas, and an
attachment through the real desktop adapter, including backup creation, disk
recheck, durable receipts, materialization, and second-pass convergence. Repeat
the supported subset on mobile.

### QA-SETTINGS — complete host matrix

Use two freshly enrolled Obsidian folders with the same configuration key.
Cover LWW create/update/delete, invalid-JSON quarantine, crash-resumable queues,
explicit install consent, plugin/theme intents and tombstones, exact plugin-data
version holding, a named clash, and mobile foreground/background behavior while
note sync remains online.

### QA-PRIVACY — explicit credential-carrier matrix

Existing exports and crash fixtures redact paths and representative device
tokens. Add exact safe-export fixtures for every current carrier and surface:
pairing/setup links, device bearers, Access tokens, socket tickets, operator
sessions, recovery/purge capabilities, URL/query/header forms, fatal frames,
and server error traces.

### QA-RUNTIME — resource and socket calibration

The 48 MiB client estimate is explicitly heuristic, not heap measurement.
Collect representative desktop, mobile, CLI, Worker, and Node traces for
resident/scratch high-water behavior, fragmentation, protected saturation,
admission latency, and safe eviction. Separately measure liveness false
timeouts, black-hole detection, proxy behavior, wake frequency, battery/network
cost, and Worker/Node socket cost before changing defaults.

### QA-DEPLOY — deployed fault and cutover evidence

Against disposable infrastructure, exercise prolonged Durable Object eviction,
alarm delay/retry, R2 outage and consistency, pin expiry, interrupted GC,
generation purge retry, rollback boundaries, and long-running operator jobs.
Also rehearse the documented fresh schema-8 reinstall with several people and
devices, semantic import, settings assignment, mirror verification, and old
ticket rejection.

### QA-SCALE — integrated benchmark and soak rerun

Repeat only the production-scale bootstrap, memory, recovery, R2-cost, purge,
and long-duration cases affected by the current identity, generation, Canvas,
compaction, and collaboration boundaries. Report platform, data shape, limits,
duration, and failure criteria; keep benchmark and soak claims distinct.
