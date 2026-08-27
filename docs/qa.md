# QA status and runbook

QA is diagnostic infrastructure, not a substitute for targeted evidence. Use the narrowest scenario that answers the observed risk.

Generated bundles, reports, and device artifacts belong under ignored `qa-runs/`. Do not commit placeholder pass evidence.

## Automated gates

`npm run test:regressions` discovers suites under `tests/client`, `tests/server`, and `tests/contracts`, plus the root harness/discovery self-tests. `tests/suites.json` records the one suite owned by a separate release-artifact driver. Discovery guards reject unaccounted inert suites and stale exemptions.

`npm run test:ci` then starts a real local Wrangler Worker through the separately accountable `tests/live/run-live.ts` driver and runs every file in that driver's accountability list. The live setup claims the server with an operator recovery key, gives each simulated client a distinct one-use pairing code, and carries only that enrollment's `{host, deviceToken, vaultId, deviceId}` credentials.

The live suites cover:

- claim, enrollment, capabilities, and exact schema admission;
- provider connection and two sequential sync clients;
- snapshot routes;
- hardening paths;
- short-lived device-ticket reconnect after expiry;
- mandatory `ticket` plus `schemaVersion` WebSocket admission;
- rejection of missing WebSocket credentials.

Wrong-vault and revoked credential rejection are covered by the regression/server suites, not by the live Wrangler scenarios. The live suites prove only the local Worker/runtime paths they execute; they are not real mobile, sleep/wake hardware, production Cloudflare routing, or original-reporter validation.

The Obsidian controllers under `qa/controllers/` use raw CDP against the actual QA-enabled product bundle and separately built harness. The product remains a passive black box: only the harness mounts QA APIs, and the controller fails if the runtime or expected globals are absent.

## Current multi-device evidence

| Scenario | Devices | Result | Proven |
|---|---|---|---|
| s11a | 2 desktop | PASS | Passive lag converges without stale resurrection |
| s11b | 2 desktop | PASS | Re-enable conflict policy preserves both states |
| s12a local | 2 desktop | PASS | Bundle/export/analyzer pipeline |
| s12a | Linux + Android | PASS | Android participates in witness flow |
| s12a passive | Linux + Android + iPad | WEAK PASS | Three devices agree on pre-existing state; no edit during run |
| s12a with edit | 2 desktop | PASS | A real edit propagates once without duplication |
| s12b | Linux + Android | PARTIAL | Foreground convergence; background-unavailable segment not captured |
| s12c | 2 desktop | PASS | Disk wins original path; CRDT is preserved in a synchronized Markdown artifact |
| s13 | 2 desktop | PASS | Open-editor remote edit converges without duplication |
| s13 | Linux + Android | PASS | Real Android editor/disk/CRDT final hashes agree |

Still missing:

- strict Linux+iPad+Android active-edit evidence (`QA-01`);
- real-device conflict-artifact evidence (`QA-02`);
- true mobile-background proof;
- real iPad proof for the missing-baseline and bound-file cases;
- real Node-filesystem watcher proof;
- original-reporter confirmation.

## Prepare a fixture vault

Only prepare a brand-new path:

```sh
npm run build:qa-product
npm run build:harness
npm run qa:prepare --fixture 001-basic-markdown --dest /absolute/path/to/new-qa-vault --preset minimal
```

The destination must not exist. Preparation never recursively deletes or merges into a path. Checked-in and generated fixtures are deterministic inputs; generated run bundles and reports still belong under ignored `qa-runs/`.

An unenrolled prepared folder must join through the same server URL plus one-use pairing code as the product. Controlled direct credentials are complete only as `{host, deviceToken, vaultId, deviceId}` plus a device name; partial identities are rejected. For a multi-device run, mint and consume a distinct pairing code for every device. Devices share the resulting `vaultId`, never a copied `deviceToken` or `deviceId`.

The checked-in blank workspace is byte-tested but still lacks live Obsidian acceptance (`QA-07`). Manual controllers attached to arbitrary existing vaults are outside these preparation guarantees.

## Real-device witness procedure

### Preconditions

All devices must use:

- the same plugin version;
- the same server and server-generated `vaultId`;
- their own enrolled `deviceToken` and `deviceId`;
- `qaDebugMode: true`;
- the same `qaTraceSecret`;
- an explicit shared `scenarioRunId` and scenario ID.

Use `deviceId`, never display name, as identity. Never copy one device's bearer into another fixture, and do not compare per-device sequence numbers. Use wall-clock timestamps for display only; same-device durations use monotonic time.

### Start

On each device:

1. **YAOS QA: Show device identity for QA**.
2. Confirm plugin version and `qaTraceSecretHash` prefix match.
3. Confirm required mobile devices report `foreground`.
4. **YAOS QA: Set scenario run ID**.
5. Start the QA flight trace in `qa-safe` mode.

Advance manual steps with **YAOS QA: Advance scenario step**. Step indices must increase and are shared script markers, not device-local event sequence numbers.

### Export and analyze

On every device, run **YAOS QA: Export witness bundle** while the trace is active. Copy the safe NDJSON outside the vault. The export omits raw paths, content, host, device credentials, and unreviewed fields.

```sh
bun run qa:analyze-bundles -- <device-a.ndjson> <device-b.ndjson> <device-c.ndjson> --out qa-runs/<run>/report.json
```

The analyzer fails closed on mismatched secret hashes, run IDs, scenario IDs, or bundle schema. A pass requires positive convergence evidence in addition to absence of stale-hash, recovery-old-hash, and editor-stability failures.

## QA-01: strict three-device active edit

Devices: Linux producer, real foreground iPad, real foreground Android.

1. Open `QA-scratch/s12a-active-edit-witness.md` on all devices with a non-empty baseline of at least 32 bytes.
2. Step 1 `baseline-quorum`: force a fresh witness on all devices.
3. Edit through Obsidian's Markdown editor on Linux only; add at least eight bytes.
4. Step 2 `edit-applied-on-a`: force the Linux witness. Its distinct local-edit hash is the target.
5. Step 3 `settled-on-b`: after visible arrival, force iPad witness.
6. Step 4 `settled-on-c`: after visible arrival, force Android witness.
7. Step 5 `ready-to-export`: export all bundles while tracing remains active.

A pass requires exactly one desktop, one iOS, and one Android bundle; foreground mobile events; one distinct Linux step-2 local-edit hash; iPad and Android settling that exact hash at steps 3 and 4; and analyzer `summary.ok: true`.

Do not substitute CDP, simulator, shell write, adapter write, or `app.vault.modify` for the real editor action.

## QA-02: real-device conflict artifact

Devices: Linux, iPad, Android.

1. Establish `S12C-BASELINE` on all devices.
2. Disable YAOS on iPad.
3. Edit remotely on Linux/Android and allow those devices to sync.
4. Edit the same note locally on iPad while YAOS remains disabled.
5. Re-enable YAOS on iPad and wait for reconciliation.
6. Verify the iPad original path contains the local version and a conflict artifact preserves remote content.
7. Verify the Markdown conflict artifact synchronizes to Linux and Android with the same preserved content.
8. Export and analyze all three bundles.

A pass requires all devices to settle the original-path survivor hash, all devices to receive the Markdown artifact containing the preserved remote side, and no stale-hash or old-recovery-hash finding.

The existing desktop result does not close this real-device requirement.

## Evidence rules

- Preserve raw failing evidence. Do not weaken a hard failing regression to obtain green output. `SYNC-01` already fails closed in two-device QA; the remaining work is the product fix in [BACKLOG](BACKLOG.md#sync-01-offline-local-delete-is-resurrected-on-re-enable).
- Adapter writes do not prove OS watcher behavior.
- Passive quorum does not prove edit propagation.
- Unit/model tests do not prove real mobile lifecycle ordering.
- Do not infer reporter confirmation from internal harness evidence.
