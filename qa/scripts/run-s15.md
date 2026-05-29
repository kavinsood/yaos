# S15 — Schema v3 Metadata Sync QA Runbook

This runbook is written for autonomous execution by an AI agent.
Follow every step exactly. No human decision points after the pre-flight checklist.

---

## What this scenario proves

1. **Create** — file created on A appears on B's disk with matching content hash
2. **Rename** — active nested metadata path change drives disk rename on B
3. **Delete** — nested `deletedAt` set on A drives disk delete on B
4. **Revive** — nested `deletedAt` cleared on A drives disk write on B
5. **mtime-only** — mtime bump without content change does NOT rewrite B's disk file
6. **Schema version** — both devices have `sys.schemaVersion === 3` after connecting

---

## Pre-flight checklist

Before running, verify all of these:

```bash
# 1. Build the plugin
cd /path/to/do-sync/worktree   # wherever fix/nested-ymaps-metadata is checked out
npm run build                   # must succeed cleanly

# 2. Plugin is installed in both vaults
# The built main.js must be at:
#   <vault-a>/.obsidian/plugins/yaos/main.js
#   <vault-b>/.obsidian/plugins/yaos/main.js
# Copy it if needed:
cp main.js <vault-a>/.obsidian/plugins/yaos/main.js
cp main.js <vault-b>/.obsidian/plugins/yaos/main.js

# 3. QA Debug Mode must be enabled in plugin settings on both vaults
# Open Obsidian > Settings > YAOS > enable "QA Debug Mode"
# (window.__YAOS_DEBUG__ will not exist without this)

# 4. QA-scratch folder must exist in both vaults (or be auto-created)
mkdir -p <vault-a>/QA-scratch
mkdir -p <vault-b>/QA-scratch
```

---

## Launch Obsidian

Open two separate Obsidian instances with remote debugging ports:

```bash
# Device A (port 9222)
/path/to/Obsidian --remote-debugging-port=9222 &

# Device B (port 9223)
/path/to/Obsidian --remote-debugging-port=9223 &
```

On Linux:
```bash
/usr/bin/obsidian --remote-debugging-port=9222 &
/usr/bin/obsidian --remote-debugging-port=9223 &
```

On macOS:
```bash
/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222 &
/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9223 &
```

Wait ~10 seconds for both to load, then verify connectivity:

```bash
curl -s http://localhost:9222/json | head -5
curl -s http://localhost:9223/json | head -5
```

Both should return JSON. If they return nothing, Obsidian isn't ready.

---

## Verify QA readiness

```bash
# Check that __YAOS_DEBUG__ is available on both devices
curl -s http://localhost:9222/json/list | python3 -c "
import json, sys
pages = json.load(sys.stdin)
print('Port 9222 pages:', [p.get('title','?') for p in pages[:3]])
"

curl -s http://localhost:9223/json/list | python3 -c "
import json, sys
pages = json.load(sys.stdin)
print('Port 9223 pages:', [p.get('title','?') for p in pages[:3]])
"
```

---

## Run the scenario

From the worktree root:

```bash
bun run qa:two-device \
  --scenario s15-schema-v3-metadata-sync \
  --port-a 9222 \
  --port-b 9223 \
  --trace qa-safe \
  --out-dir qa-runs/s15 \
  --driver raw-cdp
```

The scenario takes approximately 3–5 minutes to complete.

---

## Expected output (PASS)

```
s15: cleanup done
─── Phase 1: Create ───
Phase 1 create: hash match ✓ (abc123...)
─── Phase 2: Rename ───
Phase 2 rename dst: hash match ✓ (def456...)
Phase 2 rename: old path gone on B ✓
─── Phase 3: Delete ───
Phase 3 delete: file gone on B ✓
─── Phase 4: Revive ───
Phase 4: file deleted on both, now reviving...
Phase 4 revive: hash match ✓ (ghi789...)
─── Phase 5: mtime-only ───
Phase 5: B disk hash before mtime bump: jkl012...
Phase 5: B disk hash after mtime bump: jkl012...
Phase 5: B disk hash unchanged after mtime-only save ✓
─── Phase 6: Schema version ───
Phase 6: schemaVersion A=3 B=3
Phase 6: both devices at schema v3 ✓

✓ s15 PASS — all schema v3 metadata sync phases verified
```

Exit code 0 = PASS.

---

## If the scenario fails

Check the artifacts in `qa-runs/s15/`:
```
qa-runs/s15/
├── device-a/
│   ├── result.json      ← { passed, errors }
│   ├── trace.ndjson     ← flight trace
│   └── manifest-*.json  ← plugin version
└── device-b/
    ├── result.json
    ├── trace.ndjson
    └── manifest-*.json
```

Common failures and remediation:

| Failure | Likely cause | Fix |
|---------|-------------|-----|
| `Phase 1 create: null hash` | File didn't sync to B | Check server connectivity, verify both vaults point to same server |
| `Phase 2 rename: old path still exists on B` | DiskMirror observer not firing for nested path-changed | Check that the built plugin includes the new diskMirror.ts code |
| `Phase 3 delete: file still exists on B` | DiskMirror observer missing `deleted` semantic change | Check observer wiring in diskMirror.ts |
| `Phase 5 mtime: B disk hash changed` | Spurious rewrite from mtime-only change | The O(N) scan / path-changed suppression is broken |
| `Phase 6: Device A schemaVersion is 2` | markSchemaV3 not called, or not running v3 plugin | Verify built plugin version; check main.ts lifecycle |
| `waitForQaReady timeout` | QA Debug Mode not enabled | Enable it in plugin settings on both vaults |

---

## Full CI run (run before declaring mergeable)

```bash
# From the worktree root
npm ci
npm run build
npm run test:regressions
npm --prefix server run typecheck
```

All must exit 0.

---

## Reporting results

After running, report:
1. Exit code (0 = PASS, 1 = FAIL)
2. Phase-by-phase output
3. Any errors from `qa-runs/s15/device-a/result.json` and `device-b/result.json`
4. Plugin version from `manifest-pre.json` (to confirm correct build was used)
