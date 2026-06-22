# Version and Release Management

YAOS ships two runtimes from one GitHub release:

- the Obsidian plugin, versioned by the root `package.json` and `manifest.json`
- the Cloudflare Worker server, versioned by `server/package.json` and `server/src/version.ts`

The GitHub release tag is always the plugin version. Server artifacts ride inside
that same release as `yaos-server.zip` plus `update-manifest.json`.

## Version Fields

| Field | Owner | Meaning |
|---|---|---|
| `package.json` `version` | Plugin release tag | Drives `npm version` and the GitHub release tag. |
| `manifest.json` `version` | Obsidian plugin | Must match root `package.json`. |
| `versions.json` | Obsidian plugin registry | Maps plugin version to `minAppVersion`. |
| `server/package.json` `version` | Server artifact | The version deployed by the server updater. |
| `server/src/version.ts` `SERVER_VERSION` | Server runtime | Must match `server/package.json`. |
| `src/sync/schema.ts` `SCHEMA_VERSION` | CRDT document format | The newest schema the plugin can write/read. |
| `server/src/version.ts` `SERVER_MIN/MAX_SCHEMA_VERSION` | Server admission | The client schema range this server accepts. |

`build-server-release.mjs` validates these relationships before release assets
are created.

## Release Model

There is one public GitHub release stream, keyed by plugin version tags such as
`1.6.2`.

That release contains:

- plugin assets: `main.js`, `telemetry.js`, `manifest.json`, `styles.css`, `yaos.zip`
- server assets: `yaos-server.zip`, `update-manifest.json`

Because GitHub's `/releases/latest/download/update-manifest.json` points at the
latest tag, a server-only release still needs a plugin patch version bump as a
carrier. The plugin code may be unchanged, but the release tag must advance so
deployed servers can discover the new server artifact.

Do not move or re-upload an old tag for normal releases. Create a new patch tag.

## What To Bump

### Plugin-only change

Examples: UI changes, local sync runtime fixes, Obsidian integration fixes.

- Bump root plugin version.
- Do not bump server version.
- Run `npm version patch --no-git-tag-version` or the matching `minor`/`major` command.
- This updates `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.

### Server-only change

Examples: Worker route fix, updater script fix, Durable Object persistence fix.

- Bump `server/package.json`.
- Bump `SERVER_VERSION` in `server/src/version.ts` to the same value.
- Also bump the root plugin version as the GitHub release carrier.
- Mention in release notes that the plugin release carries a server update.

### Plugin and server change

- Bump root plugin version.
- Bump server version if any shipped server files changed.
- Keep compatibility fields current:
  - `SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN`
  - `SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER`
  - `SERVER_RECOMMENDED_PLUGIN_VERSION`

### Schema change

Schema changes are higher risk because they affect room admission and rolling
updates.

- Bump `SCHEMA_VERSION` in `src/sync/schema.ts`.
- Bump `SERVER_MAX_SCHEMA_VERSION` to the new schema.
- Keep `SERVER_MIN_SCHEMA_VERSION` at the oldest schema the server can still
  safely admit during the rollout.
- Bump server version.
- Bump root plugin version.
- Mark `SERVER_MIGRATION_REQUIRED = true` only when automatic rolling update is
  not safe and manual migration steps are required.

For a compatible rolling upgrade, ranges should overlap. For example, while
rolling from schema v2 to v3:

```ts
export const SERVER_MIN_SCHEMA_VERSION = 2;
export const SERVER_MAX_SCHEMA_VERSION = 3;
```

The server-level range admits compatible clients. The room-level schema guard
still rejects an old client after a specific room has been marked with a newer
schema.

## Release Procedure

1. Land changes through a PR.
2. Decide which versions to bump using the table above.
3. For plugin version registration, run:

```bash
npm version patch --no-git-tag-version
```

Use `minor` or `major` when the user-facing impact warrants it. The
`--no-git-tag-version` flag keeps the version bump as normal PR content; the
release tag is created after the PR lands.

4. For server version bumps, edit both:

```text
server/package.json
server/src/version.ts
```

5. Verify:

```bash
npm run guard:schema-version
npm run build:server-release
npm run test:server-update-local
```

6. Open and merge a PR.
7. After merge, check out the merge commit on `main` and push a tag matching
   `manifest.json`:

```bash
git tag 1.6.2
git push origin 1.6.2
```

The release workflow verifies that the tag equals `manifest.json` version,
builds both runtimes, runs CI, and uploads plugin and server assets.

## Server Update Discovery

The plugin fetches:

```text
https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json
```

The manifest advertises:

- latest plugin version
- latest server version
- migration requirement
- compatibility versions
- server schema range

The server updater reads `yaos-server-manifest.json` from `yaos-server.zip`.
It aborts before applying files when:

- `migrationRequired` is true and `YAOS_ALLOW_MIGRATION_UPDATE=true` is not set
- the current server schema range does not overlap the artifact schema range
- required artifact metadata is malformed

## Pre-Release Checklist

- Root `package.json` version equals `manifest.json` version.
- `versions.json` contains the plugin version.
- `server/package.json` version equals `SERVER_VERSION`.
- `SCHEMA_VERSION` is covered by `SERVER_MIN/MAX_SCHEMA_VERSION`.
- Server-only releases still have a new plugin carrier version.
- `update-manifest.json` and `yaos-server-manifest.json` include the expected
  server and schema versions.
