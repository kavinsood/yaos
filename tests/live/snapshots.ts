/**
 * Live contract checks for snapshot and blob HTTP endpoints.
 *
 * Exercises authentication, snapshot creation/listing/download, and blob
 * upload/existence/download against the Worker started by run-live.ts.
 * Product-side diff and restore behavior is covered through the real exports
 * in tests/client/snapshot-diff-restore.ts.
 *
 * Usage: node tests/run-typescript.mjs tests/live/snapshots.ts
 */

import * as Y from "yjs";
import { gunzipSync } from "fflate";
import { readField as field } from "../mocks/readField.ts";
import { deviceBearerHeaders, requireLiveIdentity } from "./liveIdentity.ts";

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------

const identity = requireLiveIdentity();
const HOST = identity.host;
const TEST_VAULT_ID = identity.vaultId;

function baseUrl(): string {
	return `${HOST}/vault/${encodeURIComponent(TEST_VAULT_ID)}`;
}

// -------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg}`);
		failed++;
	}
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	if (actual === expected) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		failed++;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}


// -------------------------------------------------------------------
// Live server endpoints
// -------------------------------------------------------------------

/** The parsed body, or `null` when the response was not JSON. */
type JsonBody = { status: number; data: unknown };

async function serverPost(
	endpoint: string,
	body?: Record<string, unknown>,
): Promise<JsonBody> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "POST",
		headers: deviceBearerHeaders(identity, {
			"Content-Type": "application/json",
		}),
		body: body ? JSON.stringify(body) : "{}",
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function serverPutBytes(
	endpoint: string,
	body: Uint8Array,
	contentType: string,
): Promise<JsonBody> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "PUT",
		headers: deviceBearerHeaders(identity, {
			"Content-Type": contentType,
		}),
		body,
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function serverGet(endpoint: string): Promise<JsonBody> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "GET",
		headers: deviceBearerHeaders(identity),
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function serverGetCapabilities(): Promise<JsonBody> {
	const url = `${HOST.replace(/\/$/, "")}/api/capabilities`;
	const res = await fetch(url, {
		method: "GET",
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function serverGetBytes(
	endpoint: string,
): Promise<{ status: number; bytes: Uint8Array }> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "GET",
		headers: deviceBearerHeaders(identity),
	});
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { status: res.status, bytes };
}

async function testEndpoints(): Promise<void> {
	console.log("\n═══════════════════════════════════════════════");
	console.log("LIVE SNAPSHOT AND BLOB ENDPOINTS");
	console.log(`  Host: ${HOST}`);
	console.log(`  Vault: ${TEST_VAULT_ID}`);
	console.log("═══════════════════════════════════════════════\n");


	const capabilities = await serverGetCapabilities();
	assertEqual(capabilities.status, 200, "capabilities returns 200");
	if (field(capabilities.data, "claimed") === false) {
		console.log("  SKIPPED: server is unclaimed");
		return;
	}

	// --- Test: Auth rejection ---
	console.log("--- Test: Auth rejection ---");
	{
		const badUrl = `${baseUrl()}/snapshots`;
		const res = await fetch(badUrl, {
			method: "GET",
			headers: { Authorization: "Bearer wrong-device-bearer" },
		});
		assertEqual(res.status, 401, "Wrong device bearer returns 401");

		const noBearerUrl = `${baseUrl()}/snapshots`;
		const res2 = await fetch(noBearerUrl, { method: "GET" });
		assertEqual(res2.status, 401, "Missing device bearer returns 401");
	}
	if (!field(capabilities.data, "snapshots") || !field(capabilities.data, "attachments")) {
		console.log("  SKIPPED: R2 binding is not configured for this server");
		return;
	}


	// --- Test: /snapshots ---
	console.log("\n--- Test: POST /snapshots ---");
	let snapshotId: string | undefined;
	{
		const { status, data } = await serverPost("snapshots", { device: "cli-test" });
		assertEqual(status, 200, "snapshots returns 200");
		assertEqual(field(data, "status"), "created", "status is 'created'");
		assert(typeof field(data, "snapshotId") === "string", `snapshotId returned: ${field(data, "snapshotId")}`);
		assert(field(data, "index") !== undefined, "index object returned");
		if (field(data, "index") !== undefined) {
			assertEqual(field(data, "index", "vaultId"), TEST_VAULT_ID, `vaultId matches (${TEST_VAULT_ID})`);
			assert(typeof field(data, "index", "crdtSizeBytes") === "number", `crdtSizeBytes: ${field(data, "index", "crdtSizeBytes")}`);
			assert(typeof field(data, "index", "crdtRawSizeBytes") === "number", `crdtRawSizeBytes: ${field(data, "index", "crdtRawSizeBytes")}`);
			assert(Array.isArray(field(data, "index", "referencedBlobHashes")), "referencedBlobHashes is array");
		}
		const createdId = field(data, "snapshotId");
		snapshotId = typeof createdId === "string" ? createdId : undefined;
	}

	// --- Test: /snapshots/maybe (should noop since we just took one) ---
	console.log("\n--- Test: POST /snapshots/maybe (should noop) ---");
	{
		const { status, data } = await serverPost("snapshots/maybe", { device: "cli-test" });
		assertEqual(status, 200, "snapshots/maybe returns 200");
		assertEqual(field(data, "status"), "noop", "status is 'noop' (already taken today)");
		assert(typeof field(data, "reason") === "string", `reason: ${field(data, "reason")}`);
	}

	// --- Test: /snapshots ---
	console.log("\n--- Test: GET /snapshots ---");
	{
		const { status, data } = await serverGet("snapshots");
		assertEqual(status, 200, "snapshots returns 200");
		const snapshots = field(data, "snapshots");
		assert(Array.isArray(snapshots), "snapshots is an array");
		const list: readonly unknown[] = Array.isArray(snapshots) ? snapshots : [];
		assert(list.length >= 1, `at least 1 snapshot (got ${list.length})`);

		if (list.length > 0) {
			const latest = list[0];
			assertEqual(field(latest, "snapshotId"), snapshotId, "latest snapshot matches what we just created");
			assertEqual(field(latest, "vaultId"), TEST_VAULT_ID, "vaultId matches");
		}
	}

	// --- Test: Download actual snapshot payload ---
	console.log("\n--- Test: Download snapshot payload from Worker ---");
	if (snapshotId) {
		const { status, bytes } = await serverGetBytes(`snapshots/${snapshotId}`);
		assertEqual(status, 200, "snapshot payload GET returns 200");
		assert(bytes.byteLength > 0, `downloaded ${bytes.byteLength} bytes`);

		try {
			const raw = gunzipSync(bytes);
			assert(raw.byteLength > 0, `decompressed to ${raw.byteLength} bytes`);

			const doc = new Y.Doc();
			Y.applyUpdate(doc, raw);
			assert(true, "Y.applyUpdate succeeded (valid CRDT data)");

			const sys = doc.getMap("sys");
			// Empty room may not have initialized flag, that's OK
			console.log(`  (Doc state: pathToId=${doc.getMap("pathToId").size}, sys.initialized=${sys.get("initialized")})`);
			doc.destroy();
		} catch (err) {
			assert(false, `gunzip + Y.applyUpdate failed: ${err}`);
		}
	} else {
		console.log("  SKIPPED: no snapshotId from previous test");
	}

	// --- Test: Blob endpoints ---
	console.log("\n--- Test: Blob PUT → exists → GET ---");
	{
		const testData = new TextEncoder().encode("Hello from CLI test " + Date.now());
		const blobHash = await sha256Hex(testData);

		// 1. Direct PUT through the Worker
		const putResult = await serverPutBytes(`blobs/${blobHash}`, testData, "text/plain");
		assertEqual(putResult.status, 204, "blob PUT returns 204");

		// 2. Check exists
		const existsResult = await serverPost("blobs/exists", {
			hashes: [blobHash, "0".repeat(64)],
		});
		assertEqual(existsResult.status, 200, "blobs/exists returns 200");
		const present = field(existsResult.data, "present");
		assert(
			Array.isArray(present) && present.includes(blobHash),
			"uploaded blob found in exists check",
		);
		assert(
			!(Array.isArray(present) && present.includes("0".repeat(64))),
			"non-existent blob not found (correct)",
		);

		// 3. Direct GET through the Worker
		const downloadRes = await serverGetBytes(`blobs/${blobHash}`);
		assertEqual(downloadRes.status, 200, "blob GET returns 200");
		assertEqual(downloadRes.bytes.byteLength, testData.byteLength, "downloaded size matches");

		const downloadedStr = new TextDecoder().decode(downloadRes.bytes);
		const originalStr = new TextDecoder().decode(testData);
		assertEqual(downloadedStr, originalStr, "downloaded content matches uploaded content");
	}

	// --- Test: Bad inputs ---
	console.log("\n--- Test: Input validation ---");
	{
		const r1 = await serverPutBytes("blobs/not-a-hash", new TextEncoder().encode("x"), "text/plain");
		assertEqual(r1.status, 400, "invalid hash rejected (blob PUT)");

		const r2 = await serverGet("blobs/short");
		assertEqual(r2.status, 400, "invalid hash rejected (blob GET)");

		const r3 = await serverGet("snapshots/does-not-exist");
		assertEqual(r3.status, 404, "missing snapshot rejected");
	}
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║     Live Snapshot Endpoint Test Suite         ║");
	console.log("╚═══════════════════════════════════════════════╝");

	await testEndpoints();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
