# Deployed Drawing DO spike

This disposable experiment exercises the proposed native Excalidraw room model
on actual Cloudflare Durable Objects. It is deliberately isolated from YAOS
production code and data.

It covers native complete-element winner selection, equal-version nonces,
transactional batches, operation receipts, monotonic replay, retained deletion
records, a cross-DO authority reservation ordered against revocation,
hibernatable WebSocket presence, identity overwrite, and a 10,000-element load.

Run with a disposable deployment:

```sh
npx wrangler deploy --config spikes/excalidraw/deployed/wrangler.jsonc
node spikes/excalidraw/deployed/run-experiment.mjs https://<deployment>
npx wrangler delete --config spikes/excalidraw/deployed/wrangler.jsonc
```
