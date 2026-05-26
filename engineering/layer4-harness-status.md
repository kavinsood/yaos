# Layer 4 Harness Status

## What this is

An internal diagnostic tool for investigating YAOS sync correctness. Not part of
public CI. Not required for every release. Use it when there is a concrete scary
behavior to answer.

## What is proven

| Run | Devices | Result | What it proves |
|-----|---------|--------|----------------|
| s11a desktop | 2x desktop CDP | PASS | Passive device lags through intermediate hashes and converges without stale resurrection |
| s11b desktop | 2x desktop CDP | PASS | Disable/re-enable conflict policy: disk wins main file, CRDT goes to local artifact |
| s12a local two-vault | 2x desktop CDP | PASS (pipeline smoke) | Bundle export pipeline works end-to-end |
| s12a Linux+Android | Linux + real Android | PASS | Android can participate in witness workflow; mobile bundle export works |
| s12a three-device | Linux + Android + iPad | PASS (weak) | Three devices agree on pre-existing hash; no actual edit was made during this run |
| s12b Linux+Android | Linux + real Android | PARTIAL | Android settles after foregrounding; background unavailable event not captured in segments |
| s12c desktop | 2x desktop CDP | PASS | Conflict policy: disk wins, CRDT goes to local-only artifact on B |
| s13 desktop | 2x desktop CDP | PASS | Open-editor remote edit converges without duplication; transient disk lag classified as diagnostic |
| s13 Linux+Android | Linux + real Android | PASS | Android open-editor remote edit converges; editorHash==crdtHash==diskHash; zero transient lag |
| s12a-with-edit desktop | 2x desktop CDP | PASS | Real edit propagates without duplication; BASELINEx1, EDIT_FROM_Ax1 |

## What is not proven

- True mobile background behavior (s12b is partial — background unavailable event not in segments)
- Three-device quorum after an actual edit (s12a three-device used pre-existing hash)
- Real-device s12c conflict artifact
- Soak/stress behavior

## When to use which scenario

| Scenario | Use when |
|----------|----------|
| s11a | Suspecting stale hash resurrection after passive device lag |
| s11b | Suspecting conflict artifact policy regression |
| s12a-with-edit | Suspecting basic two-device edit convergence failure |
| s13 | Suspecting open-editor remote edit duplication or stale echo |
| s12c | Suspecting conflict artifact locality regression |
| s12b | Suspecting mobile background/foreground lifecycle affecting witness |

## What is intentionally not being built now

- Phase 4 relay (live `__YPS:` witness echo to server)
- Awareness-channel relay of witness events
- Product UI for "other device witnessed" status
- More soak/stress scenarios
- Three-device automated CDP (CDP cannot drive iOS/Android)

## QA test ownership

Tests that import from `qa/obsidian-harness/` are part of the QA harness and will
move to the QA harness repo when it is created:

- `witness-quorum-eventually.ts` — tests `witnessQuorumEventually` primitive
- `witness-analyzer-purity.ts` — tests analyzer rule side-effect isolation
- `witness-checkpoint-offline.ts` — tests checkpoint → offline analyzer path
- `witness-offline-analyzer-integrity.ts` — tests bundle integrity check

These are currently gitignored in the plugin repo. Coverage gap acknowledged; will
be addressed when QA harness repo is created.

Tests that do NOT import from `qa/` remain in the plugin repo and run in CI:

- `witness-schema.ts`, `witness-hash-normalization.ts`, `witness-checkpoint-isolation.ts`
- `witness-checkpoint-rotation.ts`, `witness-readonly-spy.ts`, `witness-mobile-background.ts`
- `witness-bundle-export.ts`, `witness-identity-command.ts`, `witness-persistence-isolation.ts`
- `witness-scenario-step.ts`

## Known limitations

1. **Background unavailable events not in segments**: When Android is backgrounded, the
   `unavailable` divergence fires in the tracker but `_appendCheckpoint` cannot complete
   (async `getPathId` suspended). Events are in the in-memory buffer but not exportable
   in bundles.

2. **Checkpoint segments lost after plugin reload**: In-memory segments are cleared on
   plugin reload. Bundle export must happen before reload.

3. **Filesystem persistence always fail-closed on desktop**: `.obsidian` is inside the
   vault root. Bundle export uses clipboard/modal only.

4. **transient_open_editor_disk_lag classification**: Uses
   `editorSampleKind=healthy_sampled` as proxy for `editorHash===crdtHash` (diverged events
   do not carry editorHash). Final convergence must separately prove resolution.
