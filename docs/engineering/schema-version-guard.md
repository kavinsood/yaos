# Schema Version Guard

## What the guard does

`scripts/guard-schema-version.mjs` runs 7 checks to prevent the P1 regression
where `src/sync/schema.ts` was deleted and `SCHEMA_VERSION` was re-inlined as a
literal `2` directly in `vaultSync.ts`:

| # | Check | Failure condition |
|---|-------|-------------------|
| 1 | `src/sync/schema.ts` exists | File deleted by a future refactor |
| 2 | `src/sync/vaultSync.ts` imports from `"./schema"` | Import removed or path changed |
| 3 | `vaultSync.ts` does NOT contain `export const SCHEMA_VERSION = N` | Constant re-inlined as a literal |
| 4 | `SCHEMA_VERSION` value in `schema.ts` equals `EXPECTED_SCHEMA_VERSION` | Version bumped in source but guard not updated, or vice versa |
| 5 | `server/src/version.ts` `SERVER_MAX_SCHEMA_VERSION` equals expected | Server and plugin disagree |
| 6 | `server/src/version.ts` `SERVER_MIN_SCHEMA_VERSION` is less than or equal to expected | Server rejects supported plugin schema |
| 7 | (implicit) Server `min <= max` | Min/max drift on server side |

The guard exits non-zero if any check fails and prints `FAIL: <reason>` for
each violation.

---

## When to update the guard

Update the guard when:

- The schema version is bumped (e.g. v3 → v4).
- `src/sync/schema.ts` is moved or renamed.
- `vaultSync.ts` is renamed or its import path changes.
- `server/src/version.ts` constants are renamed.

Do NOT change `EXPECTED_SCHEMA_VERSION` in the guard before the corresponding
source files are updated — the guard will fail immediately and correctly.

---

## Step-by-step update procedure (v3 → v4 example)

Perform the following changes. Order matters: update source files first, then
the guard constant, then verify.

### 1. `src/sync/schema.ts`

Find:
```
export const SCHEMA_VERSION = 3;
```
Set to:
```
export const SCHEMA_VERSION = 4;
```

### 2. `server/src/version.ts`

Find:
```
SERVER_MIN_SCHEMA_VERSION = 3
SERVER_MAX_SCHEMA_VERSION = 3
```
Set both to:
```
SERVER_MIN_SCHEMA_VERSION = 4
SERVER_MAX_SCHEMA_VERSION = 4
```

Note: if the server is designed to accept a range of plugin versions during a
transition window, set `SERVER_MIN_SCHEMA_VERSION` to the oldest still-supported
version and `SERVER_MAX_SCHEMA_VERSION` to the new version. The guard allows
this range as long as max equals the plugin schema and min is less than or
equal to it.

### 3. `scripts/guard-schema-version.mjs`

Find:
```
const EXPECTED_SCHEMA_VERSION = 3;
```
Set to:
```
const EXPECTED_SCHEMA_VERSION = 4;
```

This is the only line in the guard file that needs to change for a normal
version bump.

### Files summary

| File | Pattern to find | New value |
|------|----------------|-----------|
| `src/sync/schema.ts` | `export const SCHEMA_VERSION = 3` | `= 4` |
| `server/src/version.ts` | `SERVER_MIN_SCHEMA_VERSION = 3` | `= 4` |
| `server/src/version.ts` | `SERVER_MAX_SCHEMA_VERSION = 3` | `= 4` |
| `scripts/guard-schema-version.mjs` | `EXPECTED_SCHEMA_VERSION = 3` | `= 4` |

---

## How to verify

After making the changes above, run:

```
npm run guard:schema-version
```

Expected output — all lines should be `PASS:`:

```
PASS: src/sync/schema.ts exists
PASS: src/sync/schema.ts: SCHEMA_VERSION = 4
PASS: src/sync/vaultSync.ts imports from "./schema"
PASS: src/sync/vaultSync.ts has no inlined SCHEMA_VERSION literal
PASS: server/src/version.ts: SERVER_MIN_SCHEMA_VERSION = 4
PASS: server/src/version.ts: SERVER_MAX_SCHEMA_VERSION = 4
PASS: server supports schema range v4..v4
PASS: server and plugin schema versions agree on max: v4

PASS: schema version guard — all checks passed.
```

The guard is also wired into the full regression suite:

```
npm run test:regressions
```

This runs the guard as one of 84 checks (at the time of writing). The suite
fails if any guard check fails.

---

## How to test that the guard catches a regression

The guard was validated during development by simulating the P1 regression:
inline `SCHEMA_VERSION = 2` directly in `vaultSync.ts` and confirm the guard
fails. Do not leave this in source; use a scratch branch or a temporary edit.

Manual regression simulation:

1. In `src/sync/vaultSync.ts`, temporarily add:
   ```typescript
   export const SCHEMA_VERSION = 2; // simulated regression
   ```
2. Run `npm run guard:schema-version`.
3. Confirm output contains:
   ```
   FAIL: src/sync/vaultSync.ts contains an inlined 'export const SCHEMA_VERSION = N'
   FAIL: 1 schema-version guard violation(s).
   ```
4. Revert the temporary change.

Alternatively, temporarily set `EXPECTED_SCHEMA_VERSION` in the guard to the
wrong value and confirm checks 4, 5, and 6 all fail.

The simulated-regression approach is used in `npm run test:regressions` to
confirm the guard itself is not a no-op.
