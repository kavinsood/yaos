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
