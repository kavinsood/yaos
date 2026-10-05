# Client e2e (real relay)

- `onboard.ts`: `onboardVault(baseUrl, { devices, label })` creates a fresh vault with N enrolled devices. It claims an unclaimed server, or uses operator login with the key in `LOG_DIR/client-e2e-context-<host>.json` (mode 0600). `pairDevice(vault, name)` adds one more device. Device tokens are secrets: pass them only to adapters, and log through `redact()`.
- `smoke.ts`: the WP-C RelayPort adapter (`wsRelay.ts` / `relayHttp.ts`) against a live relay with two devices. It writes `LOG_DIR/client-e2e-wpc-smoke-<label>-<stamp>.json` and exits 1 on failure.

LOG_DIR defaults to `/Users/kavin/personal/obsidiansync/experiments/logs`. Override it with `YAOS_E2E_LOG_DIR`.

```sh
URL=$(zsh scripts/relay-dev/start-local.sh --fresh | tail -1)
node --import jiti/register e2e/client/smoke.ts --host "$URL" --label local
zsh scripts/relay-dev/stop-local.sh   # always
```
