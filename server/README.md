# YAOS server

Cloudflare Worker server for the YAOS Obsidian plugin. It relays Yjs CRDT updates through a Durable Object and stores attachments plus snapshots in R2.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos)

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

Use the **Deploy to Cloudflare** button above for the default setup.

The repo-root `../wrangler.toml` defines:

- the Worker entrypoint (`server/src/index.ts`)
- the `VaultSyncServer` Durable Object binding
- the `ServerConfig` Durable Object binding

The default deploy is text-only:

- no `SYNC_TOKEN` secret is required up front
- no R2 binding is required up front
- the first browser visit shows the claim page

That claim page generates a token in the browser and returns an `obsidian://yaos?...` setup link you can use to configure the plugin.

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
4. Redeploy.

The same Worker will then begin reporting attachments and snapshots as available.

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

The canonical infrastructure config lives at the repo root in `wrangler.toml`, and the Deploy to Cloudflare button should point at the repo root.
