# Migrate from `kavinsood/yaos` to your own fork

Use this when you want **both** the Obsidian plugin and the Cloudflare Worker to follow **your** repo (example: `pixmuffin/yaos`) instead of upstream `kavinsood/yaos`.

It covers:

1. Why migration is not “change one URL”
2. Server (Worker) cutover
3. Client (Obsidian plugin) cutover
4. How to **revert** either side without losing vault Durable Object state

> Spec accuracy: YAOS “Deploy to Cloudflare” creates a **detached deploy repo** for your Worker. Day‑2 updates pull `yaos-server.zip` from a **GitHub Releases** source (default `kavinsood/yaos`). The plugin’s Marketplace build is separate from that server artifact.

---

## Mental model (three different “YAOS”s)

| Piece | What it is | Default today | What you change when forking |
|---|---|---|---|
| **A. Upstream source** | Monorepo with plugin + `server/` | `kavinsood/yaos` | Your fork, e.g. `pixmuffin/yaos` |
| **B. Detached deploy repo** | Repo Cloudflare created when you clicked Deploy; holds the live Worker source | *Your* GitHub repo (often named like `yaos`) | Point its updater at **your fork’s releases**; do **not** replace this Worker casually |
| **C. Obsidian plugin** | `main.js` / Community Plugin or BRAT | Marketplace → upstream releases | Install from **your fork’s releases** (or BRAT) |

Preserving sync data means keeping **the same Cloudflare Worker identity** (same Durable Objects, same claim token / vault id). Changing **B** by re-clicking Deploy is the risky path.

---

## Prerequisites

- Fork exists: `https://github.com/<you>/yaos` (example: `pixmuffin/yaos`)
- You can push tags / create GitHub Releases on that fork
- Your live Worker already claimed; you know:
  - Worker URL (`https://….workers.dev` or custom domain)
  - Sync token
  - Vault id
  - Detached **deployment repo URL** (YAOS settings → Advanced)

Optional but recommended: export a **Recovery Kit** from YAOS settings before any cutover.

---

## Part 1 — Prepare your fork (source of truth)

### 1. Sync and ship a release from your fork

On your machine:

```bash
git clone https://github.com/<you>/yaos.git
cd yaos
git remote add upstream https://github.com/kavinsood/yaos.git   # if missing
git fetch upstream
git checkout main
git merge upstream/main   # or rebase; resolve conflicts carefully

# Ensure your feature branch (e.g. DO attachments) is on main if you need it
# git merge feat/do-attachment-sync

npm ci
npm ci --prefix server
npm run test:regressions          # at least blob suites + server tests
npm run build
npm run build:server-release
```

Ship a GitHub **Release** whose assets include at least:

- `yaos-server.zip` + `update-manifest.json` (server updater)
- `yaos.zip` (or `main.js` + `manifest.json` + `styles.css` [+ `telemetry.js`]) for the plugin

Easiest: push a version tag matching `manifest.json` / `package.json` so `.github/workflows/release.yml` builds assets (same as upstream). Example:

```bash
# bump versions in package.json + manifest.json first if needed
git tag 1.6.2
git push origin 1.6.2
```

Wait for the Release workflow on **your fork** to finish. Confirm assets on:

`https://github.com/<you>/yaos/releases/latest`

### 2. Keep reusable updater available on your fork

Your detached deploy repo’s `.github/workflows/yaos-ops.yml` currently looks like:

```yaml
jobs:
  run:
    uses: kavinsood/yaos/.github/workflows/yaos-ops-reusable.yml@main
    with:
      release_repo: kavinsood/yaos   # default
```

You have two options:

| Option | Pros | Cons |
|---|---|---|
| **A. Keep calling upstream reusable**, only change `release_repo` to `<you>/yaos` | Smaller change | Still depends on upstream `yaos-ops-reusable.yml` staying compatible |
| **B. Point `uses:` at your fork** | Fully self-hosted | You must keep that workflow file working |

Recommended for a real migration: **B**.

In the **detached deploy repo** (not necessarily the monorepo), edit `.github/workflows/yaos-ops.yml`:

```yaml
jobs:
  run:
    uses: <you>/yaos/.github/workflows/yaos-ops-reusable.yml@main
    with:
      action: ${{ github.event.inputs.action }}
      version: ${{ github.event.inputs.version }}
      release_repo: <you>/yaos
```

Commit on the deploy repo’s default branch.

---

## Part 2 — Server migration (Worker stays, artifact source changes)

Goal: **same Worker URL and DO state**, new server bits from **your** releases.

### Steps

1. In Obsidian → **Settings → YAOS → Advanced**:
   - **Deployment repo URL** = your Cloudflare-linked GitHub repo  
   - Note **Server version** before update
2. Confirm updater workflow exists (**Initialize updater** if missing).
3. Open **Open update action** (or GitHub → Actions → **YAOS Server Ops**).
4. Run workflow with:
   - `action` = `update`
   - `release_repo` = `<you>/yaos` (if the input is still exposed)
   - `version` = empty (latest) **or** a specific tag you just published
5. Wait for Cloudflare to redeploy the Worker from the new commit on the detach repo.
6. Verify:

```bash
curl -sS "https://YOUR_WORKER/api/capabilities" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '{serverVersion,attachments,attachmentBackend,snapshots}'
```

For the DO-attachments build you should see something like:

```json
{
  "serverVersion": "0.4.0",
  "attachments": true,
  "attachmentBackend": "do",
  "snapshots": false
}
```

(`attachmentBackend` is `"r2"` if `YAOS_BUCKET` is bound.)

7. Cloudflare → Worker → Bindings: confirm `YAOS_SYNC`, `YAOS_CONFIG`, and for DO attachments also **`YAOS_BLOBS`** (migration `v2-blob-store`).

### What you must **not** do for “migration”

- Do **not** click Deploy to Cloudflare again as an “update”.
- Do **not** change the plugin’s **Server URL** to a brand-new Worker unless you intend to abandon or manually migrate DO data (there is no automatic DO→DO clone tool).

---

## Part 3 — Client migration (Obsidian plugin)

Marketplace installs always track upstream community registration. To run **your** plugin builds:

### Option A — BRAT (recommended for fork tracking)

1. Install community plugin **BRAT**.
2. BRAT → add beta plugin → `https://github.com/<you>/yaos`.
3. Disable / uninstall the Marketplace **YAOS** plugin to avoid two copies fighting.
4. Enable the BRAT YAOS build.
5. Re-enter or confirm **host / token / vault id** (same as before).
6. Capabilties refresh / reconnect.

### Option B — Manual release install

1. Download `yaos.zip` (or individual `main.js`, `manifest.json`, `styles.css`, `telemetry.js`) from your fork’s latest Release.
2. Place under `<vault>/.obsidian/plugins/yaos/` (folder id must match `manifest.json` `id`).
3. Disable Marketplace YAOS if present; enable your copy; restart Obsidian if asked.

### After client cutover checklist

- Status bar connects without Unauthorized.
- Text edit syncs to a second device.
- Attachments: drop a small PNG; confirm peer receives it.
- Settings → Advanced: **Deployment repo URL** still points at your detach repo.
- Plugin update notices (if any) should eventually reflect **your** release channel (BRAT) rather than Marketplace.

Plugin update metadata: YAOS may still probe  
`https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json`  
for *server* update hints unless your build changes that URL. That is independent of BRAT installing plugin JS from your fork. Treat Marketplace “plugin update available” as **upstream packaging**, not authority over your BRAT install.

---

## Part 4 — Revert (server and/or client)

### Revert server only (preferred first step)

Keeps Worker identity; rolls back the last updater commit.

1. GitHub Actions on the **detached deploy repo** → **YAOS Server Ops**.
2. Run with `action` = **`revert`**.
3. Cloudflare redeploys previous tree.
4. Re-check `/api/capabilities` `serverVersion`.

Or pin an older known-good release:

- `action` = `update`
- `release_repo` = `kavinsood/yaos` **or** `<you>/yaos`
- `version` = previous tag (e.g. `1.6.1`)

### Revert server **source** back to upstream releases

1. Edit detach repo `yaos-ops.yml` so `uses:` and default `release_repo` point at `kavinsood/yaos` again.
2. Run Ops `update` with `release_repo=kavinsood/yaos` and a known tag.
3. Confirm capabilities look sane.

### Revert plugin only

| If you used | Revert by |
|---|---|
| **BRAT** | Remove beta plugin / switch BRAT to `kavinsood/yaos`, or uninstall BRAT copy and reinstall Marketplace YAOS |
| **Manual zip** | Replace plugin folder with Marketplace version (or an older `yaos.zip` from upstream releases) |
| **Marketplace** | Use Obsidian’s plugin update / reinstall |

Then reconnect to the **same** Worker URL + token + vault id.

### Nuclear revert (new Worker) — last resort

Only if the Worker is corrupted beyond rollback:

1. Export Recovery Kit / take R2 snapshots if any.
2. Deploy a **new** Worker (new claim token / vault id).
3. Reseed from local disk (authoritative reconcile) knowing peers must reconnect with new credentials.
4. Old DO data is not automatically transplanted.

---

## Rollback decision matrix

| Problem | Revert |
|---|---|
| Bad server build, plugin fine | Server Ops → **`revert`** |
| Bad plugin build, server fine | Reinstall Marketplace / older BRAT release |
| Both bad after fork cutover | Revert server + plugin independently (order above) |
| Accidentally new Deploy / new Worker | Treat as new install; do not expect old DO history |
| Storage full on DO (507) | Not a “fork revert”; free storage / enable R2 (see DO guide) |

---

## Smoke test after migrate **or** after revert

```bash
# 1) Server identity
curl -sS "$HOST/api/capabilities" -H "Authorization: Bearer $TOKEN" | jq .

# 2) Auth + attachment surface
# attachments true once claimed; backend do|r2 depending on YAOS_BUCKET

# 3) Obsidian
# - edit a note on A → see on B
# - add a small attachment on A → see on B (if attachments enabled)
```

Local repo verification of the DO attachment work (from this branch / fork):

```bash
npm run test:regressions -- --only blob
```

---

## Related guides

- [Durable Object attachment sync operator guide](./do-attachment-sync-guide.md) — deploy/verify DO blobs without R2
- [Server README](../server/README.md) — update / R2 binding details
- [Zero-ops update pipeline](../engineering/zero-ops-update-pipeline.md) — why detach repos + `revert` exist

---

## Example: `kavinsood/yaos` → `pixmuffin/yaos`

Concrete shorthand if your fork is `pixmuffin/yaos` and PR #61 is what you want live:

1. Merge / push desired commits to `pixmuffin/yaos` `main`; tag a Release so artifacts exist.
2. Detach deploy repo: `yaos-ops.yml` → `uses: pixmuffin/yaos/.github/workflows/yaos-ops-reusable.yml@main`, `release_repo: pixmuffin/yaos`.
3. Run Ops **update**.
4. Install plugin via BRAT → `pixmuffin/yaos` (disable Marketplace YAOS).
5. Verify capabilities + attachment sync.
6. To undo: Ops **revert** (server) + BRAT/Marketplace back to `kavinsood/yaos` (plugin).
