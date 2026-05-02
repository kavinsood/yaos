# YAOS CLI

Headless YAOS client for mirroring a Markdown vault directory to the YAOS CRDT room.

## Commands

```bash
yaos-cli daemon --host <url> --token <token> --vault-id <id> --dir <path>
yaos-cli sync   --host <url> --token <token> --vault-id <id> --dir <path>
yaos-cli status --host <url> --token <token> --vault-id <id>
```

- `daemon` performs startup reconciliation, starts the filesystem watcher, and stays running.
- `sync` performs one reconciliation pass and exits.
- `status` connects to YAOS and prints current connection/cache state as JSON.

## State persistence

`sync` and `daemon` persist local Yjs state in the mirrored vault directory:

- `.yaos-state.bin` — operational Yjs update cache used on the next startup for delta sync.
- `.yaos-state.json` — human-readable metadata about the last persisted state.

If `.yaos-state.bin` is missing, `yaos-cli sync` warns because it must fetch room state before it can delta-sync.
If provider sync times out, the CLI continues in conservative mode rather than pretending it has current room state.
Future runs reuse the cache after a synced state is persisted.
If the file is corrupt, the CLI fails loudly instead of silently pretending the cache loaded; delete the file only when you intentionally want a full resync.

## Runtime support constraints

Supported:

- Linux on a local filesystem.
- One YAOS headless process per vault directory.

Unsupported:

- NFS, SMB, FUSE, cloud-drive mounts, or other non-local filesystems.
- Running two `yaos-cli daemon` processes against the same vault directory.
- Running `yaos-cli daemon` against a directory that an Obsidian YAOS plugin instance is also writing through a shared drive.
- Attachment/blob sync. The CLI is markdown-only for now.
- `.obsidian` settings/plugin sync.

These constraints are correctness boundaries, not performance suggestions. Multiple writers against the same filesystem path can generate colliding file IDs and orphan CRDT state.

## systemd restart behavior

If the server reports `update_required`, the CLI exits with status `2`. For systemd services, prevent restart loops with:

```ini
Restart=always
RestartPreventExitStatus=2
```

## Configuration precedence

1. CLI flags
2. Environment variables
3. `~/.config/yaos/cli.json` (or `$XDG_CONFIG_HOME/yaos/cli.json`)

## Environment variables

- `YAOS_HOST`
- `YAOS_TOKEN`
- `YAOS_VAULT_ID`
- `YAOS_DIR`
- `YAOS_DEVICE_NAME`
- `YAOS_DEBUG`
- `YAOS_EXCLUDE_PATTERNS`
- `YAOS_MAX_FILE_SIZE_KB`
- `YAOS_EXTERNAL_EDIT_POLICY`
- `YAOS_FRONTMATTER_GUARD`
- `YAOS_CONFIG_DIR`

## Config file example

```json
{
  "host": "https://sync.example.com",
  "token": "...",
  "vaultId": "vault-123",
  "dir": "/srv/vault",
  "deviceName": "n100-headless",
  "debug": false,
  "excludePatterns": "templates/,scratch/",
  "maxFileSizeKB": 2048,
  "externalEditPolicy": "always",
  "frontmatterGuardEnabled": true,
  "configDir": ".obsidian"
}
```

Use file mode `0600` if you store the token in this file.
