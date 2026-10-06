# Client e2e (real relay)

- `onboard.ts`: `onboardVault(baseUrl, { devices, label })` creates a fresh vault with N enrolled devices. It claims an unclaimed server, or uses operator login with the key in `LOG_DIR/client-e2e-context-<host>.json` (mode 0600). `pairDevice(vault, name)` adds one more device. Device tokens are secrets: pass them only to adapters, and log through `redact()`.
- `smoke.ts`: the WP-C RelayPort adapter (`wsRelay.ts` / `relayHttp.ts`) against a live relay with two devices. It writes `LOG_DIR/client-e2e-wpc-smoke-<label>-<stamp>.json` and exits 1 on failure.
- `engines.ts` (+ `engineKit.ts`): three headless `LogEngine`s on the production adapters (wsRelay, idbStorage on fake-indexeddb, suite-0 crypto) syncing through the relay. It covers create and edit, keystroke-to-peer latency, concurrent edits, rename and delete, offline edits with reconnect, a large update via x: chunks, relay checkpoints, fresh-device catch-up, restart from IndexedDB, IndexedDB loss followed by mirror recovery, and, with `--relay-restart` (local only), a relay process restart. It writes `LOG_DIR/client-e2e-wpc-engines-<label>-<stamp>.json`.
- `snapshots.ts`: snapshot backup (DESIGN §j.4) with two full clients. It needs a relay with attachment storage (`start-local.sh --r2`). Device a uploads a 2-part snapshot, a fresh device b lists, verifies and restores it (its files match, and the restore syncs back), then a byte of a second snapshot's part is flipped at rest in the local R2 store (`--state-dir`, the relay's persist dir) and b must refuse it with `content_corrupt`. It writes `LOG_DIR/client-e2e-snapshots-<label>-<stamp>.json`.
- `snapshotMemory.ts`: peak memory of the streaming snapshot export and verification on a generated vault (no relay).
- `tsconfig.json`: `npx tsc -p e2e/client/tsconfig.json` typechecks these scripts. They are not part of `typecheck:client`.

LOG_DIR defaults to `/Users/kavin/personal/obsidiansync/experiments/logs`. Override it with `YAOS_E2E_LOG_DIR`.

```sh
URL=$(zsh scripts/relay-dev/start-local.sh --fresh | tail -1)
node --import jiti/register e2e/client/smoke.ts --host "$URL" --label local
node --import jiti/register e2e/client/engines.ts --host "$URL" --label local --relay-restart
zsh scripts/relay-dev/stop-local.sh   # always

URL=$(zsh scripts/relay-dev/start-local.sh --fresh --r2 --port 8796 | tail -1)
node --import jiti/register e2e/client/snapshots.ts --host "$URL" --label local
zsh scripts/relay-dev/stop-local.sh --port 8796
```
