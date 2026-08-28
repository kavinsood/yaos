# `@yaos/cli`

Node 24+ headless YAOS client for a local Markdown vault. It synchronizes `.md` files only. Attachments, `.obsidian`, interactive recovery, and browser storage emulation are intentionally unavailable.

## Enroll

Each vault path enrolls as an independent device. Keep credentials out of argv:

```sh
YAOS_HOST=https://sync.example.com \
YAOS_PAIRING_CODE='one-time-code' \
yaos enroll /srv/notes
```

Enrollment creates a replay-safe pending request before contacting the server. A failed or lost response can be retried with the same host and pairing code. Device credentials and the server's `originImport` authority are stored under the state directory with restricted permissions.

## Run

```sh
yaos daemon /srv/notes
```

Readiness is one stdout line:

```text
YAOS_DAEMON_READY <vaultId>
```

All diagnostics go to stderr. `SIGINT` and `SIGTERM` stop input, drain filesystem ingestion and durable publication work, persist state, then exit.

## State

By default, YAOS derives a separate state directory for each real vault path:

```text
${XDG_STATE_HOME:-~/.local/state}/yaos/headless/<vault-name>-<real-path-hash>/
  daemon.lock
  enrollment.json
  client.sqlite
```

Set `YAOS_STATE_DIR` to use an explicit leaf directory instead:

```sh
YAOS_STATE_DIR=/var/lib/yaos/team-notes yaos enroll /srv/notes
YAOS_STATE_DIR=/var/lib/yaos/team-notes yaos daemon /srv/notes
```

The override is resolved to an absolute path, wins over `XDG_STATE_HOME`, and is not given another `yaos/headless/...` suffix. It must be non-empty, and the same leaf must be supplied to enrollment and the daemon. Enrollment state is bound to the vault's real path, so reusing a leaf for another vault is rejected.

The leaf directory is mode `0700`; enrollment and database files are mode `0600`. No YAOS state is written inside the vault.

## Exit codes

- `0`: enrollment completed, or daemon shut down cleanly
- `1`: usage, configuration, enrollment, or retryable runtime failure
- `2`: revoked credentials, incompatible provisioning, or vault generation mismatch
- `17`: another live process holds the vault state lock

The daemon prints exactly one readiness line only after provisioning, bootstrap/import, provider synchronization, and the first authoritative reconciliation succeed.
