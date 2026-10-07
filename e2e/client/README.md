# Client e2e (real relay)

- `onboard.ts`: `onboardVault(baseUrl, { devices, label })` creates a fresh vault with N enrolled devices. It claims an unclaimed server, or uses operator login with the key in `LOG_DIR/client-e2e-context-<host>.json` (mode 0600). `pairDevice(vault, name)` adds one more device; `revokeDevice(vault, deviceId)` revokes one from the console. Device tokens are secrets: pass them only to adapters, and log through `redact()`.
- `smoke.ts`: the WP-C RelayPort adapter (`wsRelay.ts` / `relayHttp.ts`) against a live relay with two devices. It writes `LOG_DIR/client-e2e-wpc-smoke-<label>-<stamp>.json` and exits 1 on failure.
- `engines.ts` (+ `engineKit.ts`): three headless `LogEngine`s on the production adapters (wsRelay, idbStorage on fake-indexeddb, suite-0 crypto, httpBlob) syncing through the relay. It covers create and edit, keystroke-to-peer latency, concurrent edits, rename and delete, offline edits with reconnect, a large update through the blob store (only a small bodyUpdateRef rides the log), relay checkpoints, fresh-device catch-up, restart from IndexedDB, IndexedDB loss followed by mirror recovery, and, with `--relay-restart` (local only), a relay process restart. It writes `LOG_DIR/client-e2e-wpc-engines-<label>-<stamp>.json`.
- `snapshots.ts`: snapshot backup (DESIGN §j.4) with two full clients. It uses the relay's attachment storage (R2, on by default in `start-local.sh`). Device a uploads a 2-part snapshot, a fresh device b lists, verifies and restores it (its files match, and the restore syncs back), then a byte of a second snapshot's part is flipped at rest in the local R2 store (`--state-dir`, the relay's persist dir) and b must refuse it with `content_corrupt`. It writes `LOG_DIR/client-e2e-snapshots-<label>-<stamp>.json`.
- `e2ee.ts`: suite 1 (end-to-end encrypted) through the real plugin controller (`FullClient.runtimeFor`), so main's pin and key flow runs as in production. It uses the relay's R2 store. a enables encryption (genesis, pin, restart) and seals a note and an attachment; b installs the key by recovery key and c by QR; the relay's state dir holds no plaintext; a console revoke plus a re-key shuts b's gate until it installs K_2; d enrolls after the roll (K_1 via the prevWrap chain) and its blob GC deletes a planted orphan only once its gate is open; a final scan finds no key or recovery key outside SecretStorage (diagnostics bundles, data.json, IndexedDB, logs, the relay's state and log, the results file). It writes `LOG_DIR/client-e2e-e2ee-<label>-<stamp>.json`.
- `snapshotMemory.ts`: peak memory of the streaming snapshot export and verification on a generated vault (no relay).
- `tsconfig.json`: `npx tsc -p e2e/client/tsconfig.json` typechecks these scripts. They are not part of `typecheck:client`.

LOG_DIR defaults to `/Users/kavin/personal/obsidiansync/experiments/logs`. Override it with `YAOS_E2E_LOG_DIR`.

Attachments, updates above `MAX_INLINE_UPDATE_BYTES` and snapshot parts go to the relay's blob store (R2) over HTTP PUT; they never ride the relay's sequence log (DESIGN §j.1). `start-local.sh` binds a local emulated R2 bucket by default, on every start, including the mid-run restarts of `fullClients.ts` and `engines.ts --relay-restart` (`--r2` is accepted and does nothing). `--no-r2` starts a relay without a store, on which clients do not sync attachments (fail closed); no suite here needs it. The deployed e2e worker (`deploy.sh`) needs an R2 bucket binding before these suites can run against it.

```sh
URL=$(zsh scripts/relay-dev/start-local.sh --fresh | tail -1)
node --import jiti/register e2e/client/smoke.ts --host "$URL" --label local
node --import jiti/register e2e/client/engines.ts --host "$URL" --label local --relay-restart
zsh scripts/relay-dev/stop-local.sh   # always

URL=$(zsh scripts/relay-dev/start-local.sh --fresh --port 8796 | tail -1)
node --import jiti/register e2e/client/snapshots.ts --host "$URL" --label local
node --import jiti/register e2e/client/e2ee.ts --host "$URL" --label local
zsh scripts/relay-dev/stop-local.sh --port 8796
```
