# Operator guide: Durable Object attachment sync

This guide is for **you deploying YAOS to your own Cloudflare account**. It covers how to get zero-config attachment sync, how to verify it works, and what to do when you hit free-plan limits.

**What changed:** Attachments no longer require R2. A dedicated Durable Object (`VaultBlobStore`) stores content-addressed blobs (~1 GB per vault on the Workers free plan). R2 is optional for snapshots and larger storage.

---

## Which path am I on?

| Situation | Do this |
|---|---|
| **New YAOS install** (never deployed) | [A. Fresh deploy](#a-fresh-deploy) |
| **Existing YAOS Worker** (already syncing notes) | [B. Update an existing server](#b-update-an-existing-server) |
| **Local smoke test** before touching production | [C. Local verification](#c-local-verification) |
| **Need snapshots / >1 GB attachments** | [D. Optional R2](#d-optional-r2) |

---

## A. Fresh deploy

1. Open the YAOS repo and click **Deploy to Cloudflare** (button on the main README / `server/README.md`).
2. Cloudflare creates a Worker and a **detached deploy repo** under your Git account.
3. Open the Worker URL in a browser → **Claim** → copy the setup token / QR / deep link.
4. In Obsidian: install YAOS → complete setup (host + token + vault id).
5. Confirm in **Settings → YAOS** that **Sync attachments** is available (no “add R2 first” callout).

You should **not** need to create an R2 bucket for attachments.

### What the deploy must include

Your deploy repo’s `wrangler.toml` must contain:

```toml
[[durable_objects.bindings]]
name = "YAOS_BLOBS"
class_name = "VaultBlobStore"

[[migrations]]
tag = "v2-blob-store"
new_sqlite_classes = ["VaultBlobStore"]
```

(plus the existing `YAOS_SYNC` / `YAOS_CONFIG` bindings). Server **0.4.0+** ships this by default.

---

## B. Update an existing server

Do **not** re-click “Deploy to Cloudflare” for a live vault — that can create a new Worker identity and orphan your existing Durable Object state.

Instead use YAOS’s updater:

1. In Obsidian → **Settings → YAOS → Advanced**, set **Deployment repo URL** to the GitHub/GitLab repo Cloudflare created for your Worker.
2. If you have never done so: **Initialize updater** and commit the workflow file.
3. When a release with DO attachments is available (server **≥ 0.4.0**): **Open update action** → run workflow with `update`.
4. Wait for Cloudflare to redeploy.
5. In Obsidian, force a capability refresh (reconnect, or use the refresh control in YAOS settings if present).

### Confirm the migration applied

In Cloudflare → **Workers & Pages** → your YAOS Worker → **Settings → Bindings**:

- You should see three Durable Object bindings: `YAOS_SYNC`, `YAOS_CONFIG`, **`YAOS_BLOBS`**.
- Deploy logs / migration history should include tag **`v2-blob-store`**.

If `YAOS_BLOBS` is missing, the Worker is still on a pre-0.4.0 build — re-run the update workflow and check the commit SHA Cloudflare actually deployed.

---

## C. Local verification

### Automated tests (this repo)

From the YAOS checkout:

```bash
# Attachment / DO-related suites
npm run test:regressions -- --only blob

# Full suite (recommended before opening a PR)
npm run test:regressions
```

Expected: all blob suites pass (chunk helpers, SQL store, SQLITE_FULL, DO route backend, GC, plugin 507 handling, settings status formatting).

### Local Wrangler server

```bash
cd server
npm install
npm run dev -- --var SYNC_TOKEN:dev-sync-token
```

Use the printed `http://127.0.0.1:...` URL as the plugin **Server host** (or test with `curl` below). Claiming is optional when `SYNC_TOKEN` is set.

### Capabilities check

```bash
curl -sS "https://YOUR_WORKER_HOST/api/capabilities" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq .
```

For a claimed DO-backed deploy (no R2), you want roughly:

```json
{
  "claimed": true,
  "attachments": true,
  "attachmentBackend": "do",
  "snapshots": false,
  "maxBlobUploadBytes": 10485760,
  "serverVersion": "0.4.0"
}
```

| Field | Meaning |
|---|---|
| `attachments: true` | Plugin may sync blobs |
| `attachmentBackend: "do"` | Built-in Durable Object storage |
| `attachmentBackend: "r2"` | R2 bound (`YAOS_BUCKET`) — preferred when present |
| `snapshots: false` | Expected until R2 is configured |

### Upload / download smoke (no Obsidian)

```bash
HOST="https://YOUR_WORKER_HOST"
TOKEN="YOUR_TOKEN"
VAULT="YOUR_VAULT_ID"
FILE="/path/to/small.png"

# SHA-256 of the file (hex)
HASH=$(shasum -a 256 "$FILE" | awk '{print $1}')

# Upload
curl -sS -o /dev/null -w "%{http_code}\n" -X PUT \
  "$HOST/vault/$VAULT/blobs/$HASH" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @"$FILE"
# expect: 204

# Exists
curl -sS -X POST "$HOST/vault/$VAULT/blobs/exists" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"hashes\":[\"$HASH\"]}"
# expect: {"present":["<hash>"]}

# Status (DO usage)
curl -sS "$HOST/vault/$VAULT/blobs/status" \
  -H "Authorization: Bearer $TOKEN"
# expect: {"usedBytes":...,"blobCount":...}

# Download
curl -sS -o /tmp/yaos-blob-out "$HOST/vault/$VAULT/blobs/$HASH" \
  -H "Authorization: Bearer $TOKEN"
shasum -a 256 /tmp/yaos-blob-out   # must match HASH
```

### Obsidian two-device smoke

1. Two devices/vaults pointed at the same Worker + vault id (or one desktop + one mobile).
2. Enable **Sync attachments** on both.
3. Drop a PNG &lt; 10 MB into the vault on device A.
4. Within a short time, device B should download the same path/hash.
5. Open **Settings → YAOS**: with `attachmentBackend: "do"`, storage usage should show something like `N / 1024 MB used · M attachment(s)`.

---

## D. Optional R2

Add R2 when you want:

- daily / on-demand **snapshots**, or
- **more than ~1 GB** of attachments per vault.

1. Create an R2 bucket in Cloudflare.
2. Bind it to the Worker as **`YAOS_BUCKET`** (dashboard or `wrangler.toml` — see `server/README.md`).
3. Redeploy / refresh capabilities.

After that:

- `attachmentBackend` becomes `"r2"`
- `snapshots` becomes `true`
- Existing R2 attachment data continues to work; DO blob objects are simply unused

There is **no automatic migration** of blobs between DO and R2 in v1. Prefer picking a backend for a vault and sticking to it, or re-upload from a full local vault if you switch.

---

## Failure modes you’ll see

| Symptom | Likely cause | What to do |
|---|---|---|
| Capabilities `attachments: false` | Unclaimed server, or old server (&lt; 0.4.0) without `YAOS_BLOBS` | Claim / update server |
| Plugin still asks for R2 for attachments | Old plugin or stale capabilities cache | Update plugin; reconnect |
| Upload notice “storage full” / HTTP **507** | Free-plan DO limit (~1 GB/vault or 5 GB/account) | Delete unused attachments, wait for GC, or enable R2 |
| Upload **413** | File &gt; `maxBlobUploadBytes` (10 MB) | Raise only if you also change the server cap |
| Snapshots unavailable | Expected without R2 | Optional R2 setup |
| Hash mismatch errors | Corrupt transfer / wrong body | Retry; check Client ↔ Worker TLS |

Garbage collection: unreferenced blobs are removed after a **~1 hour grace** (covers the upload → CRDT two-phase commit). Sweep runs throttled (about hourly) when status is fetched / on connect paths.

---

## Free-plan budget (why limits exist)

| Limit | Approximate |
|---|---|
| Storage per blob DO | **1 GB** |
| Storage per Cloudflare account (free DO SQLite) | **5 GB** |
| Max row/blob chunk | **2 MB** (YAOS uses 1 MiB chunks) |
| Max single attachment upload | **10 MB** |
| Daily DO requests | Shared with live sync WebSocket traffic |

Cost intent: stay on the **Workers free plan** with no R2 required. Exceeding DO storage fails closed with **507**, not a surprise bill.

---

## Security note (unchanged)

Attachment bytes are integrity-checked with **SHA-256** (client hash + server re-verify). Transport should be **HTTPS**. Content is **not** end-to-end encrypted; your Worker (and Cloudflare at rest) can see plaintext. Same trust model as R2-backed YAOS.

---

## Related docs

- Design: `docs/superpowers/specs/2026-06-29-durable-object-attachment-sync-design.md`
- Plan: `docs/superpowers/plans/2026-06-29-durable-object-attachment-sync.md`
- Server ops: `server/README.md`
- Attachment engineering history (R2 path): `engineering/attachment-sync.md`
