# YAOS server

Cloudflare Worker server for the YAOS Obsidian plugin. It relays Yjs CRDT updates through a Durable Object and stores attachments plus snapshots in R2.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

## Architecture

- One vault maps to one Durable Object-backed sync room.
- Yjs sync runs through `y-partyserver`.
- Durable Object storage persists the live CRDT snapshot.
- Attachments are uploaded through the Worker and stored in R2.
- Snapshots are gzipped CRDT archives stored in R2.
- Auth uses the claimed setup token by default, with `SYNC_TOKEN` as an optional hard override.

## Local development

```bash
cd server
npm install
npm run dev -- --var SYNC_TOKEN:dev-sync-token
```

The local Worker will be served by Wrangler. Use its printed local URL as the plugin's **Server host**.

Passing `SYNC_TOKEN` locally is optional. If you omit it, the server starts unclaimed and you can claim it in a browser.

## Deploy to Cloudflare

Use the **Deploy to Cloudflare** button above for the default setup. It targets the `server/` subdirectory so Cloudflare treats this folder as the project root.
This repo intentionally keeps `.env.example` free of assignments so the deploy flow does not prompt for `SYNC_TOKEN` by default.

The local `wrangler.toml` in this directory defines:

- the Worker entrypoint (`server/src/index.ts`)
- the `VaultSyncServer` Durable Object binding
- the `ServerConfig` Durable Object binding

The default deploy is text-only:

- no `SYNC_TOKEN` secret is required up front
- no R2 binding is required up front
- the first browser visit shows the claim page

That claim page generates a token in the browser and returns an `obsidian://yaos?...` setup link you can use to configure the plugin.

### How updates work after deploy

The Deploy to Cloudflare button creates a new repository in your own Git account and connects this Worker to that new repo.

That means future pushes to your generated repo will redeploy automatically, but future pushes to the original `kavinsood/yaos` template repo will not update your existing Worker on their own.

To pick up new YAOS changes later:

1. Add your generated repo URL in the plugin settings (`Deployment repo URL`).
2. Use **Initialize updater** once (GitHub) if workflows are missing.
3. Use **Open update action** from plugin settings and run the update workflow.
4. Cloudflare redeploys automatically after the workflow push.

### Manual CLI deploy

```bash
cd server
npm install
npm run deploy
```

### Optional post-deploy R2 setup

If you want attachments and snapshots later:

1. Create an R2 bucket in the Cloudflare dashboard.
2. Open your Worker in **Workers & Pages**.
3. Add an R2 binding named `YAOS_BUCKET`.

The same Worker will then begin reporting attachments and snapshots as available.

If the Cloudflare dashboard UI is transiently failing when attaching the bucket, use this fallback in your generated deploy repo:

1. Edit `wrangler.toml`.
2. Add this block (replace bucket name):

```toml
[[r2_buckets]]
binding = "YAOS_BUCKET"
bucket_name = "your-bucket-name"
```

3. Commit and push. Cloudflare redeploys from that commit.

After deploy, refresh your Worker URL. YAOS should report attachments/snapshots as available.

## Transient Cloudflare deployment issues

Cloudflare can occasionally show temporary dashboard/build instability. Common examples:

- build queue delays, then the deploy eventually succeeds
- temporary dashboard failure when adding an R2 binding

Recommended workflow:

1. Retry once after a short wait.
2. If it still fails, use repo-backed fallback paths (like `wrangler.toml` binding edits) and push a new commit.
3. Capture the failed deployment commit SHA from Cloudflare (**Workers & Pages** → deployment → **Commit**) when opening an issue.

The commit SHA lets us verify the exact server snapshot Cloudflare built, which is critical for debugging intermittent failures.

## Endpoints

### WebSocket sync

- `wss://<host>/vault/sync/<vaultId>?token=<setup-token>`

### Blob APIs

- `POST /vault/<vaultId>/blobs/exists`
- `PUT /vault/<vaultId>/blobs/<sha256>`
- `GET /vault/<vaultId>/blobs/<sha256>`

### Snapshot APIs

- `POST /vault/<vaultId>/snapshots/maybe`
- `POST /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots/<snapshotId>`

### Debug

- `GET /vault/<vaultId>/debug/recent`

All HTTP endpoints require `Authorization: Bearer <setup-token>` once the server has been claimed.

If you set `SYNC_TOKEN`, that environment value becomes the required token instead.

## Operational safeguards

- Blob uploads are capped at 10 MB by default.
- Blob existence checks use bounded concurrency.
- Snapshot creation is daily-idempotent through the `/snapshots/maybe` route.
- Snapshot archives are stored compressed to keep R2 usage modest.

## Deploy button note

The canonical infrastructure config lives in this `server/` directory, and the Deploy to Cloudflare button should target the `server/` subdirectory path in GitHub.
