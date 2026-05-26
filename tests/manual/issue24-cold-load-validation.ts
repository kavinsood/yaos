/**
 * Issue #24 Cold-Load Validation (manual, hits real deployment)
 *
 * DO NOT run as part of automated regression tests.
 * This script connects to a real Cloudflare Worker / Durable Object deployment.
 *
 * Two-phase test that validates durable persistence survives a Worker redeploy:
 *
 * Phase 1 (seed): Write N files to a staging vault, verify persistence healthy, exit.
 * Phase 2 (validate): After a Worker redeploy (cold-load boundary), verify
 *   documentSummary.activePathCount=N, then connect Device B alone.
 *
 * Required env vars:
 *   PHASE            - "seed" or "validate"
 *   YAOS_TEST_HOST   - Deployed server URL
 *   YAOS_TEST_TOKEN  - Bearer token for the server
 *   YAOS_TEST_VAULT_ID - Must be the same for both phases
 *
 * Optional env vars:
 *   YAOS_TEST_FILE_COUNT - Number of files (default: 700)
 *
 * Usage:
 *   # Phase 1: seed
 *   PHASE=seed YAOS_TEST_HOST=https://staging.workers.dev \
 *     YAOS_TEST_TOKEN=token YAOS_TEST_VAULT_ID=cold-test \
 *     node --import jiti/register tests/manual/issue24-cold-load-validation.ts
 *
 *   # Redeploy the staging Worker (kills all DOs, forces cold load)
 *   cd server && npx wrangler deploy ...
 *
 *   # Phase 2: validate
 *   PHASE=validate YAOS_TEST_HOST=https://staging.workers.dev \
 *     YAOS_TEST_TOKEN=token YAOS_TEST_VAULT_ID=cold-test \
 *     node --import jiti/register tests/manual/issue24-cold-load-validation.ts
 *
 * Validated: 700-file cold-load across real Cloudflare staging redeploy boundary.
 */

import * as Y from "yjs";
// @ts-ignore
import YSyncProvider from "y-partyserver/provider";
// @ts-ignore
import WebSocket from "ws";

const HOST = process.env.YAOS_TEST_HOST;
const TOKEN = process.env.YAOS_TEST_TOKEN;
const VAULT_ID = process.env.YAOS_TEST_VAULT_ID;
if (!HOST || !TOKEN || !VAULT_ID) {
	console.error("Required: YAOS_TEST_HOST, YAOS_TEST_TOKEN, and YAOS_TEST_VAULT_ID env vars.");
	process.exit(1);
}
const FILE_COUNT = parseInt(process.env.YAOS_TEST_FILE_COUNT || "700", 10);
const PHASE = process.env.PHASE || "seed";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
	if (cond) { console.log(`  PASS  ${msg}`); passed++; }
	else { console.log(`  FAIL  ${msg}`); failed++; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function connectDevice(label: string): Promise<{
	doc: Y.Doc;
	pathToId: Y.Map<string>;
	idToText: Y.Map<Y.Text>;
	sys: Y.Map<unknown>;
	provider: any;
	createFile: (path: string, content: string) => string;
	readFile: (path: string) => string | null;
	getPathCount: () => number;
	disconnect: () => void;
}> {
	return new Promise((resolve, reject) => {
		const doc = new Y.Doc();
		const pathToId = doc.getMap<string>("pathToId");
		const idToText = doc.getMap<Y.Text>("idToText");
		const meta = doc.getMap<unknown>("meta");
		const sys = doc.getMap<unknown>("sys");

		const provider = new YSyncProvider(HOST, VAULT_ID, doc, {
			prefix: `/vault/sync/${encodeURIComponent(VAULT_ID)}`,
			params: { token: TOKEN, schemaVersion: "8" },
			WebSocketPolyfill: (globalThis as any).WebSocket ?? WebSocket,
			connect: true,
			maxBackoffTime: 2000,
		});

		const timeout = setTimeout(() => reject(new Error(`${label}: sync timeout`)), 30_000);
		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolve({
				doc, pathToId, idToText, sys, provider,
				createFile(path: string, content: string) {
					const fileId = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
					doc.transact(() => {
						pathToId.set(path, fileId);
						const ytext = new Y.Text();
						ytext.insert(0, content);
						idToText.set(fileId, ytext);
						meta.set(fileId, { path, deleted: false, mtime: Date.now() });
					}, "disk-sync");
					return fileId;
				},
				readFile(path: string) {
					const id = pathToId.get(path);
					if (!id) return null;
					return idToText.get(id)?.toString() ?? null;
				},
				getPathCount() { return pathToId.size; },
				disconnect() { provider.destroy(); doc.destroy(); },
			});
		});
	});
}

async function fetchDebug(): Promise<any> {
	const res = await fetch(
		`${HOST}/vault/${encodeURIComponent(VAULT_ID)}/debug/recent`,
		{ headers: { Authorization: `Bearer ${TOKEN}` } },
	);
	return res.json();
}

// ── SEED PHASE ───────────────────────────────────────────────────────────────

if (PHASE === "seed") {
	console.log(`\n=== Issue #24 Cold-Load Validation — SEED ===`);
	console.log(`Vault: ${VAULT_ID}  |  Files: ${FILE_COUNT}\n`);

	const device = await connectDevice("Seeder");
	if (!device.sys.get("initialized")) {
		device.doc.transact(() => {
			device.sys.set("initialized", true);
			device.sys.set("schemaVersion", 8);
		});
	}

	for (let i = 0; i < FILE_COUNT; i++) {
		const path = `test-files/file-${String(i).padStart(3, "0")}.md`;
		device.createFile(path, `# File ${i}\nContent for cold-load validation.\n${"x".repeat(200)}\n`);
	}

	assert(device.getPathCount() === FILE_COUNT, `Seeder has ${FILE_COUNT} paths`);
	console.log("  Waiting for server save...");
	await sleep(3000);
	device.disconnect();

	const debug = await fetchDebug();
	assert(debug.persistence.status === "healthy", `persistence healthy (got ${debug.persistence.status})`);
	assert(debug.documentSummary.activePathCount === FILE_COUNT, `activePathCount === ${FILE_COUNT} (got ${debug.documentSummary.activePathCount})`);
	assert(debug.persistence.pendingPersistence === false, `pendingPersistence false`);

	console.log(`\n  Seed complete. Vault: ${VAULT_ID}`);
	console.log(`  Now redeploy the staging Worker, then run PHASE=validate with the same VAULT_ID.\n`);
	console.log(`${"─".repeat(55)}`);
	console.log(`Seed results: ${passed} passed, ${failed} failed`);
	console.log(`${"─".repeat(55)}\n`);
	process.exit(failed > 0 ? 1 : 0);
}

// ── VALIDATE PHASE ───────────────────────────────────────────────────────────

if (PHASE === "validate") {
	console.log(`\n=== Issue #24 Cold-Load Validation — VALIDATE (post-redeploy) ===`);
	console.log(`Vault: ${VAULT_ID}  |  Expected files: ${FILE_COUNT}\n`);

	console.log("--- Check 1: Debug endpoint (forces cold load from durable storage) ---");
	const debug = await fetchDebug();

	assert(debug.documentLoaded === true, "document loaded from durable storage");
	assert(debug.persistence.status === "healthy", `persistence healthy (got ${debug.persistence.status})`);
	assert(debug.documentSummary.activePathCount === FILE_COUNT, `activePathCount === ${FILE_COUNT} (got ${debug.documentSummary.activePathCount})`);
	assert(debug.documentSummary.activePathsWithText === FILE_COUNT, `activePathsWithText === ${FILE_COUNT} (got ${debug.documentSummary.activePathsWithText})`);
	assert(debug.documentSummary.activePathsMissingFromPathToId === 0, `no paths missing from pathToId`);
	assert(debug.documentSummary.activePathsMissingText === 0, `no paths missing text`);
	assert(debug.documentSummary.pathToIdWithoutActiveMeta === 0, `no orphaned pathToId entries`);

	console.log(`\n  Cold-loaded journal: ${debug.persistence.journalEntryCount} entries, ${debug.persistence.journalBytes} bytes`);

	console.log("\n--- Check 2: Device B connects alone (post cold-load handoff) ---");
	const deviceB = await connectDevice("Device B");
	assert(deviceB.getPathCount() === FILE_COUNT, `Device B has ${FILE_COUNT} paths (got ${deviceB.getPathCount()})`);

	// Spot-check across range
	for (const i of [0, 50, Math.floor(FILE_COUNT / 2), FILE_COUNT - 1]) {
		const path = `test-files/file-${String(i).padStart(3, "0")}.md`;
		const content = deviceB.readFile(path);
		assert(content !== null && content.includes(`File ${i}`), `Device B has file-${String(i).padStart(3, "0")}`);
	}

	deviceB.disconnect();
	console.log("  Device B disconnected\n");

	console.log(`${"─".repeat(55)}`);
	console.log(`Validate results: ${passed} passed, ${failed} failed`);
	console.log(`${"─".repeat(55)}\n`);
	process.exit(failed > 0 ? 1 : 0);
}

console.error(`Unknown PHASE: ${PHASE}. Use PHASE=seed or PHASE=validate.`);
process.exit(1);
