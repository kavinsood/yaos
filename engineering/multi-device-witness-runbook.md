# Multi-Device Witness Runbook

Layer 4 Phase 2 — Manual multi-device validation for iPad + Android + Linux.

## Overview

This runbook describes how to run the Phase 2 witness scenarios manually across three devices when CDP automation is not available (mobile devices). The desktop QA controller is the sole aggregator — it reads each device's in-memory witness segment buffer through that device's QA debug API.

**Important:** Phase 2 uses in-memory witness segment buffers, not filesystem checkpoint folders. Segments live in the tracker's memory while the trace is active. Export them before stopping the trace or reloading the app.

## Prerequisites

- YAOS plugin installed on all three devices (iPad, Android, Linux)
- All devices connected to the same YAOS server
- A shared `qaTraceSecret` agreed upon before starting (e.g., a random UUID)
- Linux device has CDP access for automation; mobile devices use the QA debug API when available

## Starting a Shared Flight Trace

### On each device (iPad, Android, Linux):

1. Open Obsidian → Settings → YAOS → Advanced → Debug
2. Enable **QA Debug Mode**
3. Set the same `qaTraceSecret` on all devices
4. Open the Obsidian DevTools console (or use the QA debug API)
5. Start a flight trace in `qa-safe` mode:

```javascript
await window.__YAOS_DEBUG__.startFlightTrace("qa-safe");
```

6. Verify the trace is active and record each device's identity:

```javascript
const info = window.__YAOS_DEBUG__.getActiveTraceInfo();
console.log("traceId:", info.traceId);
console.log("deviceId:", info.deviceId);
console.log("hasQaTraceSecret:", info.hasQaTraceSecret);
```

7. Record each device's `deviceId` — these are the stable local UUIDs used for all cross-device assertions. **Never use `deviceName`** — it is display-only.

## Scenario s11a: Passive Stale Echo Witness

**Goal:** Prove that passive Device B receives no stale echoes while active Device A edits in slow bursts.

### Setup Phase

1. Open the same Markdown note on both Device A (Linux) and Device B (iPad or Android).
2. Establish pre-burst convergence — both devices should have the same content.
3. Record the initial content hash:

```javascript
const content = await app.vault.read(app.vault.getFileByPath("Notes/test.md"));
const initialHash = await window.__YAOS_DEBUG__.computeWitnessStateHash(content);
console.log("Initial hash:", initialHash);
```

4. Wait for both devices to emit `device.witness.settled` for the note with `stateHash === initialHash`.

### Run Phase (60-second burst window)

1. On Device A: delete a sentinel word and type new content in slow bursts over 60 seconds.
2. On Device B: do NOT edit — remain passive.
3. Monitor Device B's witness buffer for forbidden divergences:

```javascript
const buf = window.__YAOS_DEBUG__.getWitnessBuffer() ?? [];
const forbidden = buf.filter(e =>
  e.kind === "diverged" &&
  (e.data.reason === "stale_hash_after_newer_witness" ||
   e.data.reason === "recovery_emitted_old_hash")
);
console.log("Forbidden divergences on B:", forbidden.length);
```

4. Monitor Device A's witness buffer for editor stability:

```javascript
const buf = window.__YAOS_DEBUG__.getWitnessBuffer() ?? [];
const editorIssues = buf.filter(e =>
  e.kind === "diverged" &&
  (e.data.reason === "editor_crdt_mismatch" || e.data.reason === "editor_unhealthy")
);
console.log("Editor issues on A:", editorIssues.length);
```

### Assert Phase

1. After the burst window, record the final content hash on Device A:

```javascript
const finalContent = await app.vault.read(app.vault.getFileByPath("Notes/test.md"));
const finalHash = await window.__YAOS_DEBUG__.computeWitnessStateHash(finalContent);
```

2. Wait for both devices to emit `device.witness.settled` with `stateHash === finalHash`.

**Acceptance criteria:**
- Device B: no `stale_hash_after_newer_witness` or `recovery_emitted_old_hash` during burst
- Device A: no `editor_crdt_mismatch` or `editor_unhealthy` during burst
- Post-burst: both devices agree on `finalHash`

## Scenario s11b: Disable/Re-enable Witness

**Goal:** Prove that Device B's local edit is preserved as a conflict artifact when YAOS is disabled and re-enabled with concurrent remote edits.

### Setup Phase

1. Open the same Markdown note on Device A (Linux) and Device B (iPad or Android).
2. Establish pre-disable baseline convergence.
3. Record the baseline hash:

```javascript
const content = await app.vault.read(app.vault.getFileByPath("Notes/test.md"));
const baselineHash = await window.__YAOS_DEBUG__.computeWitnessStateHash(content);
```

### Run Phase

1. **Disable YAOS on Device B**: Settings → YAOS → toggle off (or unload plugin).
2. **On Device B** (while disabled): edit the note directly on disk (e.g., via Files app or a text editor).
3. **On Device A** (while B is disabled): edit the note through YAOS normally.
4. **Re-enable YAOS on Device B**: Settings → YAOS → toggle on.

### Assert Phase

1. Wait for Device B to re-sync.
2. Check that a conflict artifact was created on Device B:

```javascript
const paths = window.__YAOS_DEBUG__.getDiskMarkdownPaths();
const artifacts = paths.filter(p => p.includes("YAOS conflict"));
console.log("Conflict artifacts:", artifacts);
```

3. Compute expected hashes from actual file content:

```javascript
// On Device A — compute witness hash from actual file content
const contentA = await app.vault.read(app.vault.getFileByPath("Notes/test.md"));
const hashA = await window.__YAOS_DEBUG__.computeWitnessStateHash(contentA);

// On Device B — compute witness hash from actual file content
const contentB = await app.vault.read(app.vault.getFileByPath("Notes/test.md"));
const hashB = await window.__YAOS_DEBUG__.computeWitnessStateHash(contentB);

console.log("Hashes equal:", hashA === hashB);
```

**Acceptance criteria:**
- Conflict artifact exists on Device B
- Both devices agree on original path's surviving hash
- Both devices agree on conflict artifact's hash
- No `recovery_emitted_old_hash` or `stale_hash_after_newer_witness` during re-sync
- No silent overwrite of Device B's local edit

## Exporting Witness Segments

Phase 2 uses in-memory witness segment buffers. Export them **before stopping the trace** or reloading the app.

### On each device, export the witness segments:

```javascript
// Get the active traceId
const info = window.__YAOS_DEBUG__.getActiveTraceInfo();
const traceId = info?.traceId;

// Export in-memory witness segments as NDJSON
const ndjson = window.__YAOS_DEBUG__.exportWitnessSegments(traceId);
if (ndjson) {
  console.log("Witness segments:", ndjson);
  // Copy to clipboard or save via your preferred method
}
```

For desktop devices with CDP access, the controller can also read segments directly:

```javascript
const result = await window.__YAOS_DEBUG__.readWitnessCheckpoint(traceId);
console.log("Segments:", result.segments.length, "Status:", result.status);
```

### Assembling for offline analysis:

Collect the NDJSON output from each device and save as:
```
analysis/
  device-linux.ndjson
  device-ipad.ndjson
  device-android.ndjson
```

## Offline Analysis

Feed the assembled NDJSON files into the analyzer:

```bash
# From the project root
bun run qa:analyze --trace-dir analysis/
```

### Applicable analyzer rules:

| Rule | What it checks | Testable manually? |
|------|---------------|-------------------|
| `quorum-incomplete` | All required devices settled for a pathId | Yes — via exported segments |
| `cross-device-hash-mismatch` | All devices agree on stateHash for each pathId | Yes — via exported segments |
| `editor-flicker-during-burst` | No settled→diverged→settled within 5s on any device | Yes — via exported segments |
| `recovery-stale-precise` | Precision-path recovery_emitted_old_hash detections | Yes — via exported segments |

### Assertions testable manually (offline):

- Cross-device hash equality via `crossDeviceHashesEqual` consumed by the analyzer
- `quorum-incomplete` finding (all devices settled for declared pathId)
- `cross-device-hash-mismatch` finding
- `editor-flicker-during-burst` finding

### Assertions requiring automated CDP (desktop-only in Phase 2):

- Real-time `witnessQuorum` with timeout (requires CDP to poll device buffers)
- Real-time `noStaleHashAfterNewerWitness` during burst window
- Real-time `noRecoveryEmittedOldHash` during burst window
- Real-time `editorStableDuring` during burst window

These require the two-device CDP driver (`qa/controllers/two-device.ts`) and are only available for desktop Obsidian. Mobile devices use the manual segment export workflow described above.

## Stopping the Trace

**Export witness segments before stopping** — they are in-memory and will be lost when the tracker is disposed.

```javascript
// Export first
const ndjson = window.__YAOS_DEBUG__.exportWitnessSegments(traceId);
// Then stop
await window.__YAOS_DEBUG__.stopFlightTrace();
```

## Notes

- `deviceId` is a stable local UUID — it does NOT change between trace sessions on the same device.
- `deviceName` is display-only and is NEVER used as a cross-device key.
- Per-device `seq` values are local-only — never compare seq values across devices.
- Wall-clock timestamps in events are display-only — the analyzer uses `monotonicMs` for duration checks.
- Witness segments are in-memory only. They do not persist across app reloads or plugin restarts.
- Cross-device quorum requires a non-empty `qaTraceSecret` set on all devices.
