# Server Storage Migration: KV → Native DO SQLite

## Summary

This release migrates the server's Durable Object persistence layer from a hand-rolled checkpoint+journal system on top of Cloudflare's KV-style storage API to native DO SQLite tables.

## What changes for users

**Nothing visible.** This is a server-internal storage change. The sync protocol, client plugin, and WebSocket behavior are unchanged. Clients do not need to update.

## What happens on deploy

1. When a vault's Durable Object wakes for the first time after deploy:
   - It attempts to load from SQL tables (new path)
   - If SQL is empty, it checks for existing KV data (old path)
   - If KV data exists, it migrates: loads the full Y.Doc state from KV, writes a clean snapshot to SQL, records a migration marker
   - Future loads use SQL exclusively

2. Migration is automatic and transparent. No user action required.

3. Old KV data is preserved after migration (rollback safety). It is NOT auto-deleted.

## Performance impact

- **Cold start:** Faster. Reading a SQL snapshot is a single `SELECT` query instead of batched KV reads + manifest parsing.
- **Saves:** Faster. Journal append is a single `INSERT` instead of a multi-key transactional write.
- **Compaction:** No longer a failure risk. The old system could fail compaction when the journal grew large (transaction size limits). The new system uses `transactionSync` with bounded operations.

## Known limitations

- Journal entries >1.5MB route to full checkpoint write (by design, not a failure)
- Admin debug routes (`/debug/compact`, `/debug/cleanup-kv`) require `YAOS_ENABLE_ADMIN_ROUTES` env var to be set

## Monitoring

The `/__yaos/debug` endpoint now includes a `storage` section:

```json
{
  "storage": {
    "mode": "sql" | "kv-migrated" | "fresh" | "kv-fallback",
    "migrationStatus": "already_sql" | "migrated" | "not_started" | "failed",
    "migrationAt": "2026-05-28T...",
    "migrationDurationMs": 1234,
    "coldLoadDurationMs": 567,
    "oversizedDeltaCount": 0,
    "migrationMeta": { ... }
  }
}
```

## Rollback plan

If SQL storage shows problems after deploy:

### Option A: Revert deploy (recommended)

1. Deploy the previous server version (before this commit)
2. The old code reads from KV, which still has all the data (we don't delete it)
3. Rooms resume from KV state as if nothing happened

### Option B: KV fallback (automatic)

If SQL tables become corrupt (rare, catastrophic), the server automatically:
1. Detects SQL load failure
2. Falls back to reading from KV (if KV data still exists)
3. Sets `storageMode: "kv-fallback"` 
4. Operates in **non-durable degraded relay mode:**
   - No persistence attempts (saves are skipped)
   - No SV echoes sent (clients are not told the server received their state)
   - CRDT relay still functions (connected peers can sync through server memory)
   - Clients retain local truth via IndexedDB
5. Logs `kv-fallback-activated` trace for operator visibility

In this state, the DO relays sync messages between peers but does not persist or acknowledge durable receipt. Clients retain their data locally. The operator must fix the SQL issue or revert the deploy.

### KV data cleanup

Old KV keys are **not** auto-deleted. To clean them up after confirming SQL is stable:

1. Set `YAOS_ENABLE_ADMIN_ROUTES = "true"` in wrangler.toml
2. Deploy
3. `POST /vault/:id/debug/cleanup-kv` with auth header
4. The endpoint verifies SQL has data before deleting KV keys

Only do this after a successful bake period (72+ hours of normal use with no errors).

## Compatibility

| Component | Compatibility |
|---|---|
| Client plugin | No change needed. Any version works. |
| Server deploy | One-way migration. Deploy is the trigger. |
| Rollback to old server | Safe. KV data preserved. |
| Multiple vault DOs | Each migrates independently on first wake. |
