# RFC: Zero-Ops Update Pipeline for Detached Cloudflare Forks

Status: Implemented  
Owner: YAOS  
Scope: Server update lifecycle for Deploy-to-Cloudflare YAOS servers

## Problem: the Day 2 trap

YAOS uses Cloudflare's Deploy button to optimize for a 60-second setup. That flow works well for onboarding, but creates a lifecycle problem:

1. The deploy flow creates a detached user repository.
2. Cloudflare strips `.github/workflows` during clone.
3. Without workflows, users have no update pipeline in their generated repo.

For a stateful Durable Object + SQLite backend, this is a critical Day 2 issue, not just DX polish.

## Constraints

The update path must preserve consumer-grade UX while protecting user data:

- No terminal requirement.
- No PAT/OAuth token setup in the plugin.
- No server self-mutation via Cloudflare API credentials.
- No dependence on re-clicking Deploy as an update primitive.
- Must preserve existing Worker identity and DO bindings.

## Architecture

### Phase 1: Day 1 install

Users install via Deploy to Cloudflare. We keep this path because onboarding speed matters.

### Phase 2: bootstrap the updater once

Because workflows are stripped during deploy clone, YAOS bootstraps them using a GitHub deep-link:

- Plugin collects the generated repo URL.
- Plugin opens a pre-filled GitHub file creation URL for `.github/workflows/yaos-ops.yml`.
- User clicks **Commit changes** once.

This gives the repo an update entrypoint without terminal or PAT setup.

### Phase 3: centralized execution

`yaos-ops.yml` is intentionally small and dispatch-only. It calls a reusable workflow hosted in the upstream YAOS repo:

- update action: pull release artifact and apply
- revert action: revert last update commit

Keeping logic centralized allows hotfixing updater behavior without asking every user to edit local workflow files.

## Update mechanism

YAOS updates the server by applying a release artifact (`yaos-server.zip`) into the generated deployment repo, committing, and pushing. Cloudflare redeploys from that commit.

This avoids upstream monorepo merge complexity and keeps rollback straightforward.

## Safety valves

### 1) Migration gate (hard stop)

Updater reads `yaos-server-manifest.json`. If `migrationRequired: true`, automatic update aborts with a clear error and manual migration instruction.

### 2) Wrangler drift warning

Updater compares release `wrangler.toml` expectations against local config and warns when required bindings/vars are missing.

### 3) Schema compatibility preflight

Release artifacts include the server schema range they support. The updater
compares that range with the currently deployed server before applying files.
If there is no overlap, the update aborts unless the release is explicitly
marked migration-required or the operator intentionally bypasses the guard.

### 4) Runtime compatibility guard

Server exposes compatibility metadata via `/api/capabilities`. Plugin blocks only incompatible combinations. Legacy/missing version metadata does not hard-block sync.

## Metadata ownership and multi-device safety

Updater metadata (`updateRepoUrl`, `updateRepoBranch`, provider) is persisted server-side and synchronized safely:

- Plugin does not push empty metadata.
- Server update-metadata writes use patch semantics (null does not clear existing metadata).
- New devices hydrate local settings from server capabilities.

This prevents "fresh device wipes updater config" regressions.

## Why not re-click Deploy?

Deploy is an install primitive, not an in-place update primitive. Re-deploy can create a new project path and risks orphaning user state if misused. YAOS update execution therefore happens at the Git layer.

## User-facing behavior summary

- One-time: initialize updater from plugin settings.
- Normal update: click **Open update action**, run workflow with `update`.
- Rollback: run workflow with `revert`.
- Migration-required release: workflow fails safely with explicit guidance.
